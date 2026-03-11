use super::parser::*;
use chrono::{DateTime, Timelike, Utc};
use log::{debug, info, warn};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::time::SystemTime;

/// Idle threshold: gaps longer than 5 minutes between messages are considered idle time
const IDLE_THRESHOLD_SECS: i64 = 300;

// ── Cache persistence structs ──

#[derive(Serialize, Deserialize, Default)]
struct PersistedCache {
    stats: StatsCache,
    file_metadata: HashMap<String, FileMetadata>,
}

#[derive(Serialize, Deserialize, Clone)]
struct FileMetadata {
    mtime_secs: u64,
    size: u64,
}

// ── Deserialization structs ──

#[derive(Deserialize)]
struct JsonlLine {
    #[serde(rename = "type")]
    line_type: String,
    timestamp: Option<String>,
    #[serde(rename = "requestId")]
    request_id: Option<String>,
    message: Option<JsonlMessage>,
    cwd: Option<String>,
    #[serde(rename = "gitBranch")]
    git_branch: Option<String>,
}

#[derive(Deserialize)]
struct JsonlMessage {
    model: Option<String>,
    content: Option<serde_json::Value>,
    usage: Option<JsonlTokenUsage>,
}

#[derive(Deserialize, Clone)]
struct JsonlTokenUsage {
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
    #[serde(default)]
    cache_read_input_tokens: u64,
    #[serde(default)]
    cache_creation_input_tokens: u64,
}

// ── Parsed assistant entry (one per JSONL line of type "assistant") ──

#[derive(Clone)]
struct AssistantEntry {
    timestamp: Option<DateTime<Utc>>,
    request_id: Option<String>,
    model: String,
    tool_use_count: u64,
    usage: Option<JsonlTokenUsage>,
}

// ── Per-file parsed stats ──

#[derive(Debug, Clone, Default)]
struct SessionStats {
    is_main: bool,
    session_id: String,
    user_timestamps: Vec<DateTime<Utc>>,
    user_message_count: u64,
    assistant_entries: Vec<AssistantEntry>,
    /// All timestamps for duration calculation
    all_timestamps: Vec<DateTime<Utc>>,
    // Session metadata (from first user line)
    first_prompt: Option<String>,
    git_branch: Option<String>,
    project_path: Option<String>,
    first_timestamp: Option<String>,
    last_timestamp: Option<String>,
    // Idle time tracking
    total_duration_secs: u64,
    active_duration_secs: u64,
    total_idle_secs: u64,
    idle_segment_count: u32,
}

// Need Debug for AssistantEntry since SessionStats derives Debug
impl std::fmt::Debug for AssistantEntry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AssistantEntry")
            .field("model", &self.model)
            .field("tool_use_count", &self.tool_use_count)
            .finish()
    }
}

// ── Tracker with incremental parsing ──

pub struct JsonlTracker {
    file_states: HashMap<PathBuf, (SystemTime, u64)>,
    session_cache: HashMap<PathBuf, SessionStats>,
    cached_stats: StatsCache,
}

fn vaibfu_cache_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".vaibfu").join("stats-cache.json"))
}

impl JsonlTracker {
    pub fn new() -> Self {
        Self {
            file_states: HashMap::new(),
            session_cache: HashMap::new(),
            cached_stats: StatsCache::default(),
        }
    }

    /// Load cached stats from disk. Returns the cached StatsCache if available.
    /// Also pre-populates file_states with cached metadata to skip unchanged files.
    pub fn load_cache(&mut self) -> Option<StatsCache> {
        let path = vaibfu_cache_path()?;
        let data = std::fs::read_to_string(&path).ok()?;
        let persisted: PersistedCache = serde_json::from_str(&data).ok()?;

        // Pre-populate file_states from cached metadata
        for (path_str, meta) in persisted.file_metadata {
            let path = PathBuf::from(path_str);
            let mtime = SystemTime::UNIX_EPOCH
                + std::time::Duration::from_secs(meta.mtime_secs);
            self.file_states.insert(path, (mtime, meta.size));
        }

        self.cached_stats = persisted.stats.clone();
        info!(
            "[jsonl] loaded cache: {} file states, {} sessions",
            self.file_states.len(),
            persisted.stats.total_sessions
        );
        Some(persisted.stats)
    }

    /// Save current stats and file metadata to disk cache.
    fn save_cache(&self) {
        let Some(path) = vaibfu_cache_path() else {
            return;
        };

        // Ensure directory exists
        if let Some(parent) = path.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                warn!("[jsonl] failed to create cache dir: {}", e);
                return;
            }
        }

        // Build file metadata map
        let mut file_metadata = HashMap::new();
        for (file_path, (mtime, size)) in &self.file_states {
            let mtime_secs = mtime
                .duration_since(SystemTime::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            file_metadata.insert(
                file_path.to_string_lossy().to_string(),
                FileMetadata {
                    mtime_secs,
                    size: *size,
                },
            );
        }

        let persisted = PersistedCache {
            stats: self.cached_stats.clone(),
            file_metadata,
        };

        match serde_json::to_string(&persisted) {
            Ok(json) => {
                if let Err(e) = std::fs::write(&path, json) {
                    warn!("[jsonl] failed to write cache: {}", e);
                } else {
                    debug!("[jsonl] saved cache with {} files", self.file_states.len());
                }
            }
            Err(e) => {
                warn!("[jsonl] failed to serialize cache: {}", e);
            }
        }
    }

    /// Return recent sessions derived from parsed JSONL data.
    pub fn recent_sessions(&self, limit: usize) -> Vec<SessionEntry> {
        let mut sessions: Vec<SessionEntry> = self
            .session_cache
            .values()
            .filter(|s| s.is_main)
            .map(|s| {
                let message_count = {
                    let mut request_ids = std::collections::HashSet::new();
                    for entry in &s.assistant_entries {
                        if let Some(ref rid) = entry.request_id {
                            request_ids.insert(rid.clone());
                        }
                    }
                    s.user_message_count + request_ids.len() as u64
                };
                SessionEntry {
                    session_id: s.session_id.clone(),
                    full_path: String::new(),
                    first_prompt: s.first_prompt.clone(),
                    summary: None,
                    message_count,
                    created: s.first_timestamp.clone(),
                    modified: s.last_timestamp.clone(),
                    git_branch: s.git_branch.clone(),
                    project_path: s.project_path.clone(),
                    duration_secs: s.total_duration_secs,
                    active_secs: s.active_duration_secs,
                    idle_secs: s.total_idle_secs,
                }
            })
            .collect();

        sessions.sort_by(|a, b| {
            let ma = a.modified.as_deref().unwrap_or("");
            let mb = b.modified.as_deref().unwrap_or("");
            mb.cmp(ma)
        });
        sessions.truncate(limit);
        sessions
    }

    /// Check all JSONL files, re-parse changed ones, re-aggregate if needed.
    pub fn refresh(&mut self) -> StatsCache {
        let files = find_all_jsonl_files();
        let mut changed = false;
        let mut skipped = 0;
        let mut parsed = 0;

        // Remove cached entries for deleted files
        let current_paths: HashSet<_> = files.iter().map(|(p, _)| p.clone()).collect();
        let before = self.session_cache.len();
        self.file_states.retain(|k, _| current_paths.contains(k));
        self.session_cache.retain(|k, _| current_paths.contains(k));
        if self.session_cache.len() != before {
            changed = true;
        }

        for (path, is_subagent) in &files {
            let meta = match std::fs::metadata(path) {
                Ok(m) => m,
                Err(_) => continue,
            };
            let mtime = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
            let size = meta.len();

            // Compare seconds only (cache stores seconds, not nanos)
            let mtime_secs = mtime
                .duration_since(SystemTime::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);

            if let Some(&(old_mtime, old_size)) = self.file_states.get(path) {
                let old_mtime_secs = old_mtime
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                if mtime_secs == old_mtime_secs && size == old_size && self.session_cache.contains_key(path) {
                    skipped += 1;
                    continue;
                }
            }

            debug!("[jsonl] parsing {}", path.display());
            let stats = parse_jsonl_file(path, !is_subagent);
            self.file_states.insert(path.clone(), (mtime, size));
            self.session_cache.insert(path.clone(), stats);
            changed = true;
            parsed += 1;
        }

        info!("[jsonl] refresh: {} files skipped, {} parsed", skipped, parsed);

        if changed {
            let all_stats: Vec<&SessionStats> = self.session_cache.values().collect();
            self.cached_stats = aggregate_stats(&all_stats);
            self.save_cache();
        }

        self.cached_stats.clone()
    }
}

// ── File discovery ──

fn find_all_jsonl_files() -> Vec<(PathBuf, bool)> {
    let Some(projects_dir) = dirs::home_dir().map(|h| h.join(".claude").join("projects")) else {
        return vec![];
    };

    let mut results = Vec::new();

    let project_entries = match std::fs::read_dir(&projects_dir) {
        Ok(e) => e,
        Err(_) => return results,
    };

    for project_entry in project_entries.flatten() {
        let project_path = project_entry.path();
        if !project_path.is_dir() {
            continue;
        }

        if let Ok(entries) = std::fs::read_dir(&project_path) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_file() && p.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                    results.push((p, false));
                } else if p.is_dir() {
                    let subagents_dir = p.join("subagents");
                    if subagents_dir.is_dir() {
                        if let Ok(agent_files) = std::fs::read_dir(&subagents_dir) {
                            for agent_file in agent_files.flatten() {
                                let ap = agent_file.path();
                                if ap.is_file()
                                    && ap.extension().and_then(|e| e.to_str()) == Some("jsonl")
                                {
                                    results.push((ap, true));
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    results
}

// ── Idle Time Computation ──

/// Compute idle time for a session by finding gaps > IDLE_THRESHOLD_SECS between consecutive messages
fn compute_session_idle_time(stats: &mut SessionStats) {
    if stats.all_timestamps.len() < 2 {
        stats.total_duration_secs = 0;
        stats.active_duration_secs = 0;
        stats.total_idle_secs = 0;
        stats.idle_segment_count = 0;
        return;
    }

    // Sort timestamps
    let mut sorted_timestamps = stats.all_timestamps.clone();
    sorted_timestamps.sort();

    let first_ts = sorted_timestamps.first().unwrap();
    let last_ts = sorted_timestamps.last().unwrap();
    let total_duration = (*last_ts - *first_ts).num_seconds().max(0) as u64;

    let mut total_idle: i64 = 0;
    let mut idle_segments: u32 = 0;

    // Find gaps > IDLE_THRESHOLD_SECS between consecutive messages
    for i in 1..sorted_timestamps.len() {
        let gap = (sorted_timestamps[i] - sorted_timestamps[i - 1]).num_seconds();
        if gap > IDLE_THRESHOLD_SECS {
            total_idle += gap;
            idle_segments += 1;
        }
    }

    let idle_secs = total_idle.max(0) as u64;
    let active_secs = total_duration.saturating_sub(idle_secs);

    stats.total_duration_secs = total_duration;
    stats.total_idle_secs = idle_secs;
    stats.active_duration_secs = active_secs;
    stats.idle_segment_count = idle_segments;
}

// ── Parsing ──

fn parse_jsonl_file(path: &PathBuf, is_main: bool) -> SessionStats {
    let session_id = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();

    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return SessionStats::default(),
    };

    let reader = BufReader::new(file);
    let mut stats = SessionStats {
        is_main,
        session_id,
        ..Default::default()
    };

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };
        if line.is_empty() {
            continue;
        }

        let parsed: JsonlLine = match serde_json::from_str(&line) {
            Ok(p) => p,
            Err(_) => continue,
        };

        let ts = parsed
            .timestamp
            .as_deref()
            .and_then(|s| s.parse::<DateTime<Utc>>().ok());

        // Track min/max timestamps across all lines
        if let Some(ref ts_str) = parsed.timestamp {
            match (&stats.first_timestamp, &stats.last_timestamp) {
                (None, _) => {
                    stats.first_timestamp = Some(ts_str.clone());
                    stats.last_timestamp = Some(ts_str.clone());
                }
                (Some(first), Some(last)) => {
                    if ts_str.as_str() < first.as_str() {
                        stats.first_timestamp = Some(ts_str.clone());
                    }
                    if ts_str.as_str() > last.as_str() {
                        stats.last_timestamp = Some(ts_str.clone());
                    }
                }
                _ => {}
            }
        }

        match parsed.line_type.as_str() {
            "user" => {
                stats.user_message_count += 1;
                if let Some(t) = ts {
                    stats.user_timestamps.push(t);
                    stats.all_timestamps.push(t);
                }
                // Capture metadata from first user line
                if stats.first_prompt.is_none() {
                    if let Some(ref msg) = parsed.message {
                        if let Some(ref content) = msg.content {
                            match content {
                                serde_json::Value::String(s) => {
                                    stats.first_prompt = Some(s.clone());
                                }
                                serde_json::Value::Array(blocks) => {
                                    // Extract text from content blocks
                                    for block in blocks {
                                        if let Some(text) = block.get("text").and_then(|v| v.as_str()) {
                                            stats.first_prompt = Some(text.to_string());
                                            break;
                                        }
                                    }
                                }
                                _ => {}
                            }
                        }
                    }
                    stats.git_branch = parsed.git_branch;
                    stats.project_path = parsed.cwd;
                }
            }
            "assistant" => {
                if let Some(t) = ts {
                    stats.all_timestamps.push(t);
                }

                let mut entry = AssistantEntry {
                    timestamp: ts,
                    request_id: parsed.request_id,
                    model: String::new(),
                    tool_use_count: 0,
                    usage: None,
                };

                if let Some(ref msg) = parsed.message {
                    entry.model = msg.model.clone().unwrap_or_default();
                    entry.usage = msg.usage.clone();

                    if let Some(serde_json::Value::Array(ref blocks)) = msg.content {
                        for block in blocks {
                            if block.get("type").and_then(|v| v.as_str()) == Some("tool_use") {
                                entry.tool_use_count += 1;
                            }
                        }
                    }
                }

                stats.assistant_entries.push(entry);
            }
            _ => {}
        }
    }

    // Compute idle time for this session
    compute_session_idle_time(&mut stats);

    stats
}

// ── Concurrency Histogram ──

fn compute_concurrency_histogram(sessions: &[&SessionStats]) -> HashMap<String, HashMap<u32, u32>> {
    use chrono::{Duration, NaiveDateTime, TimeZone};

    let mut histogram: HashMap<String, HashMap<u32, u32>> = HashMap::new();

    // Only consider main sessions (exclude subagents)
    let main_sessions: Vec<_> = sessions
        .iter()
        .filter(|s| s.is_main)
        .filter_map(|s| {
            let first = s.first_timestamp.as_ref()?;
            let last = s.last_timestamp.as_ref()?;
            let first_dt = first.parse::<DateTime<Utc>>().ok()?;
            let last_dt = last.parse::<DateTime<Utc>>().ok()?;
            Some((first_dt, last_dt))
        })
        .collect();

    if main_sessions.is_empty() {
        return histogram;
    }

    // Find the range of hours we need to process (limit to last 7 days)
    let now = Utc::now();
    let seven_days_ago = now - Duration::days(7);

    // Collect all unique hours with activity
    let mut hours_with_activity: BTreeSet<String> = BTreeSet::new();
    for (first_dt, last_dt) in &main_sessions {
        // Skip sessions entirely before 7 days ago
        if *last_dt < seven_days_ago {
            continue;
        }

        let start = if *first_dt < seven_days_ago {
            seven_days_ago
        } else {
            *first_dt
        };
        let end = *last_dt;

        // Iterate through each hour the session spans
        let mut current = start.with_minute(0).unwrap().with_second(0).unwrap().with_nanosecond(0).unwrap();
        while current <= end {
            let hour_key = format!("{}:{}", current.format("%Y-%m-%d"), current.hour());
            hours_with_activity.insert(hour_key);
            current = current + Duration::hours(1);
        }
    }

    // For each hour, compute concurrency for each minute
    for hour_key in hours_with_activity {
        let parts: Vec<&str> = hour_key.rsplitn(2, ':').collect();
        if parts.len() != 2 {
            continue;
        }
        let hour: u32 = match parts[0].parse() {
            Ok(h) => h,
            Err(_) => continue,
        };
        let date_str = parts[1];

        // Parse hour start time
        let hour_start = match NaiveDateTime::parse_from_str(
            &format!("{} {:02}:00:00", date_str, hour),
            "%Y-%m-%d %H:%M:%S",
        ) {
            Ok(dt) => Utc.from_utc_datetime(&dt),
            Err(_) => continue,
        };

        let mut minute_counts: HashMap<u32, u32> = HashMap::new();

        // For each of the 60 minutes in this hour
        for minute in 0..60u32 {
            let minute_start = hour_start + Duration::minutes(minute as i64);
            let minute_end = minute_start + Duration::minutes(1);

            // Count sessions active during this minute
            let concurrent = main_sessions
                .iter()
                .filter(|(first_dt, last_dt)| {
                    // Session is active if its range overlaps with [minute_start, minute_end)
                    *first_dt < minute_end && *last_dt >= minute_start
                })
                .count() as u32;

            if concurrent > 0 {
                *minute_counts.entry(concurrent).or_insert(0) += 1;
            }
        }

        if !minute_counts.is_empty() {
            histogram.insert(hour_key, minute_counts);
        }
    }

    histogram
}

// ── Aggregation ──

fn aggregate_stats(sessions: &[&SessionStats]) -> StatsCache {
    let mut daily_messages: HashMap<String, u64> = HashMap::new();
    let mut daily_sessions: HashMap<String, HashSet<usize>> = HashMap::new();
    let mut daily_tool_calls: HashMap<String, u64> = HashMap::new();
    let mut daily_tokens: HashMap<String, HashMap<String, u64>> = HashMap::new();
    let mut model_usage_map: HashMap<String, ModelUsage> = HashMap::new();
    let mut hour_counts: HashMap<String, u64> = HashMap::new();

    let mut total_messages: u64 = 0;
    let mut total_sessions: u64 = 0;
    let mut first_date: Option<String> = None;
    let mut longest = LongestSession::default();

    // Idle/active time totals (main sessions only)
    let mut total_session_time_secs: u64 = 0;
    let mut total_active_time_secs: u64 = 0;
    let mut total_idle_time_secs: u64 = 0;

    for (idx, session) in sessions.iter().enumerate() {
        if session.is_main {
            total_sessions += 1;
            // Sum idle/active time for main sessions
            total_session_time_secs += session.total_duration_secs;
            total_active_time_secs += session.active_duration_secs;
            total_idle_time_secs += session.total_idle_secs;
        }

        // ── User messages ──
        for ts in &session.user_timestamps {
            let date = ts.format("%Y-%m-%d").to_string();
            *daily_messages.entry(date.clone()).or_default() += 1;

            if session.is_main {
                daily_sessions.entry(date.clone()).or_default().insert(idx);
            }

            *hour_counts.entry(format!("{}:{}", ts.format("%Y-%m-%d"), ts.hour())).or_default() += 1;

            match &first_date {
                None => first_date = Some(date),
                Some(d) if date < *d => first_date = Some(date),
                _ => {}
            }
        }
        total_messages += session.user_message_count;

        // ── Assistant entries ──
        // Deduplicate by requestId: keep last entry per requestId for usage/model
        let mut request_last: HashMap<String, &AssistantEntry> = HashMap::new();
        let mut no_rid_entries: Vec<&AssistantEntry> = Vec::new();

        for entry in &session.assistant_entries {
            if let Some(ref rid) = entry.request_id {
                request_last.insert(rid.clone(), entry);
            } else {
                no_rid_entries.push(entry);
            }
        }

        // Count unique requestIds as assistant messages
        total_messages += request_last.len() as u64;

        // Count assistant messages per date (from requestId-deduplicated entries)
        for entry in request_last.values() {
            if let Some(ts) = entry.timestamp {
                let date = ts.format("%Y-%m-%d").to_string();
                *daily_messages.entry(date.clone()).or_default() += 1;

                if session.is_main {
                    daily_sessions.entry(date).or_default().insert(idx);
                }
            }
        }

        // ── Tool calls (count all, not deduplicated) ──
        for entry in &session.assistant_entries {
            if entry.tool_use_count > 0 {
                let date = entry
                    .timestamp
                    .map(|ts| ts.format("%Y-%m-%d").to_string())
                    .or_else(|| {
                        session
                            .user_timestamps
                            .first()
                            .map(|ts| ts.format("%Y-%m-%d").to_string())
                    })
                    .unwrap_or_default();
                if !date.is_empty() {
                    *daily_tool_calls.entry(date).or_default() += entry.tool_use_count;
                }
            }
        }

        // ── Token usage (last entry per requestId) ──
        for (_rid, entry) in &request_last {
            if let Some(ref usage) = entry.usage {
                if !entry.model.is_empty() {
                    let mu = model_usage_map
                        .entry(entry.model.clone())
                        .or_insert_with(ModelUsage::default);
                    mu.input_tokens += usage.input_tokens;
                    mu.output_tokens += usage.output_tokens;
                    mu.cache_read_input_tokens += usage.cache_read_input_tokens;
                    mu.cache_creation_input_tokens += usage.cache_creation_input_tokens;

                    // Daily tokens
                    let date = entry
                        .timestamp
                        .map(|ts| ts.format("%Y-%m-%d").to_string())
                        .or_else(|| {
                            session
                                .user_timestamps
                                .first()
                                .map(|ts| ts.format("%Y-%m-%d").to_string())
                        })
                        .unwrap_or_default();
                    if !date.is_empty() {
                        let total = usage.input_tokens
                            + usage.output_tokens
                            + usage.cache_read_input_tokens
                            + usage.cache_creation_input_tokens;
                        *daily_tokens
                            .entry(date)
                            .or_default()
                            .entry(entry.model.clone())
                            .or_default() += total;
                    }
                }
            }
        }

        // ── Longest session (main only) ──
        let session_msg_count =
            session.user_message_count + request_last.len() as u64;
        if session.is_main && session_msg_count > longest.message_count {
            let duration = if session.all_timestamps.len() >= 2 {
                let min = session.all_timestamps.iter().min().unwrap();
                let max = session.all_timestamps.iter().max().unwrap();
                (*max - *min).num_seconds().max(0) as u64
            } else {
                0
            };
            longest = LongestSession {
                session_id: session.session_id.clone(),
                duration,
                message_count: session_msg_count,
            };
        }
    }

    // ── Build daily_activity sorted by date ──
    let mut all_dates = BTreeSet::new();
    all_dates.extend(daily_messages.keys().cloned());
    all_dates.extend(daily_tool_calls.keys().cloned());

    let daily_activity: Vec<DailyActivity> = all_dates
        .iter()
        .map(|date| DailyActivity {
            date: date.clone(),
            message_count: *daily_messages.get(date).unwrap_or(&0),
            session_count: daily_sessions
                .get(date)
                .map(|s| s.len() as u64)
                .unwrap_or(0),
            tool_call_count: *daily_tool_calls.get(date).unwrap_or(&0),
        })
        .collect();

    let mut daily_model_tokens: Vec<DailyModelTokens> = daily_tokens
        .into_iter()
        .map(|(date, tokens_by_model)| DailyModelTokens {
            date,
            tokens_by_model,
        })
        .collect();
    daily_model_tokens.sort_by(|a, b| a.date.cmp(&b.date));

    let longest_opt = if longest.message_count > 0 {
        Some(longest)
    } else {
        None
    };

    // Compute concurrency histogram
    let concurrency_histogram = compute_concurrency_histogram(sessions);

    StatsCache {
        version: 1,
        last_computed_date: chrono::Utc::now().format("%Y-%m-%d").to_string(),
        daily_activity,
        daily_model_tokens,
        model_usage: model_usage_map,
        total_sessions,
        total_messages,
        longest_session: longest_opt,
        first_session_date: first_date,
        hour_counts,
        total_speculation_time_saved_ms: 0,
        concurrency_histogram,
        total_session_time_secs,
        total_active_time_secs,
        total_idle_time_secs,
    }
}
