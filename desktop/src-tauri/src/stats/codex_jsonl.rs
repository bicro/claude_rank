use super::jsonl::compute_active_segments;
use super::parser::{DailyActivity, DailyModelTokens, DaySessionEntry, ModelUsage, StatsCache};
use chrono::{DateTime, Duration, Local, NaiveDateTime, TimeZone, Timelike, Utc};
use log::{debug, info, warn};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap};
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::time::SystemTime;

const IDLE_THRESHOLD_SECS: i64 = 300;
/// Bumped 1→2 in the Phase-1 expansion: per-model tokens, tool names, prompt
/// hashes, concurrency, day_sessions. Caches written by version 1 are missing
/// these fields, so we discard and reparse.
const CACHE_VERSION: u32 = 2;
const UNKNOWN_MODEL_NAME: &str = "unknown-codex";

#[derive(Serialize, Deserialize, Default)]
struct PersistedCodexCache {
    cache_version: Option<u32>,
    stats: StatsCache,
    file_metadata: HashMap<String, FileMetadata>,
}

#[derive(Serialize, Deserialize, Clone)]
struct FileMetadata {
    mtime_secs: u64,
    size: u64,
}

#[derive(Deserialize)]
struct CodexLine {
    #[serde(rename = "type")]
    line_type: String,
    timestamp: Option<String>,
    payload: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize, Default, Clone, Copy)]
struct TokenUsage {
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    cached_input_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
    #[serde(default)]
    reasoning_output_tokens: u64,
}

/// Per-session metadata read from `session_meta` events. Cached so future phases
/// can surface per-project/per-branch breakdowns without rewalking JSONL — not
/// sent in the sync payload yet.
#[derive(Debug, Clone, Default)]
#[allow(dead_code)]
struct CodexSessionMeta {
    cwd: Option<String>,
    git_branch: Option<String>,
    cli_version: Option<String>,
    model_provider: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct CodexSessionStats {
    #[allow(dead_code)]
    session_id: String,
    user_message_count: u64,
    function_call_count: u64,
    all_timestamps: Vec<DateTime<Utc>>,
    user_timestamps: Vec<DateTime<Utc>>,
    /// Per-model summed token deltas. Each `token_count` event is attributed to
    /// the most recent `turn_context.model` seen in the stream — Codex emits
    /// `turn_context` before the turn it describes, so this is monotonic.
    /// Falls back to "unknown-codex" if a token_count fires with no prior
    /// turn_context (rare; happens on malformed session prefixes).
    tokens_by_model: HashMap<String, TokenUsage>,
    /// Per-tool-name function call counts.
    tool_name_counts: HashMap<String, u64>,
    /// SHA256 hex of the first user_message text in this session (Claude parity
    /// — uniqueness scoring on session-starting prompts).
    first_prompt_hash: Option<String>,
    #[allow(dead_code)]
    meta: Option<CodexSessionMeta>,
    total_duration_secs: u64,
    active_duration_secs: u64,
    total_idle_secs: u64,
}

pub struct CodexJsonlTracker {
    file_states: HashMap<PathBuf, (SystemTime, u64)>,
    session_cache: HashMap<PathBuf, CodexSessionStats>,
    cached_stats: StatsCache,
    pub needs_full_sync: bool,
}

fn codex_cache_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".ClaudeRank").join("codex-stats-cache.json"))
}

pub fn codex_sessions_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".codex").join("sessions"))
}

impl CodexJsonlTracker {
    pub fn new() -> Self {
        Self {
            file_states: HashMap::new(),
            session_cache: HashMap::new(),
            cached_stats: StatsCache::default(),
            needs_full_sync: false,
        }
    }

    pub fn load_cache(&mut self) -> Option<StatsCache> {
        let path = codex_cache_path()?;
        let data = std::fs::read_to_string(&path).ok()?;
        let persisted: PersistedCodexCache = serde_json::from_str(&data).ok()?;

        if persisted.cache_version != Some(CACHE_VERSION) {
            info!(
                "[codex-jsonl] cache version mismatch (found {:?}, expected {}), discarding",
                persisted.cache_version, CACHE_VERSION
            );
            self.needs_full_sync = true;
            return None;
        }

        for (path_str, meta) in persisted.file_metadata {
            let path = PathBuf::from(path_str);
            let mtime = SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(meta.mtime_secs);
            self.file_states.insert(path, (mtime, meta.size));
        }

        self.cached_stats = persisted.stats.clone();
        info!(
            "[codex-jsonl] loaded cache: {} file states, {} sessions",
            self.file_states.len(),
            persisted.stats.total_sessions
        );
        Some(persisted.stats)
    }

    fn save_cache(&self) {
        let Some(path) = codex_cache_path() else {
            return;
        };
        if let Some(parent) = path.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                warn!("[codex-jsonl] failed to create cache dir: {}", e);
                return;
            }
        }

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

        let persisted = PersistedCodexCache {
            cache_version: Some(CACHE_VERSION),
            stats: self.cached_stats.clone(),
            file_metadata,
        };

        match serde_json::to_string(&persisted) {
            Ok(json) => {
                if let Err(e) = std::fs::write(&path, json) {
                    warn!("[codex-jsonl] failed to write cache: {}", e);
                } else {
                    debug!(
                        "[codex-jsonl] saved cache with {} files",
                        self.file_states.len()
                    );
                }
            }
            Err(e) => warn!("[codex-jsonl] failed to serialize cache: {}", e),
        }
    }

    pub fn refresh(&mut self) -> StatsCache {
        let files = find_codex_jsonl_files();
        let mut changed = false;
        let mut skipped = 0;
        let mut parsed = 0;

        let current: std::collections::HashSet<_> = files.iter().cloned().collect();
        let before = self.session_cache.len();
        self.file_states.retain(|k, _| current.contains(k));
        self.session_cache.retain(|k, _| current.contains(k));
        if self.session_cache.len() != before {
            changed = true;
        }

        for path in &files {
            let meta = match std::fs::metadata(path) {
                Ok(m) => m,
                Err(_) => continue,
            };
            let mtime = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
            let size = meta.len();
            let mtime_secs = mtime
                .duration_since(SystemTime::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);

            if let Some(&(old_mtime, old_size)) = self.file_states.get(path) {
                let old_mtime_secs = old_mtime
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                if mtime_secs == old_mtime_secs
                    && size == old_size
                    && self.session_cache.contains_key(path)
                {
                    skipped += 1;
                    continue;
                }
            }

            debug!("[codex-jsonl] parsing {}", path.display());
            let stats = parse_codex_file(path);
            self.file_states.insert(path.clone(), (mtime, size));
            self.session_cache.insert(path.clone(), stats);
            changed = true;
            parsed += 1;
        }

        info!(
            "[codex-jsonl] refresh: {} files skipped, {} parsed",
            skipped, parsed
        );

        if changed {
            let all: Vec<&CodexSessionStats> = self.session_cache.values().collect();
            self.cached_stats = aggregate_codex(&all);
            self.save_cache();
        }

        self.cached_stats.clone()
    }

    #[allow(dead_code)]
    pub fn force_reparse(&mut self) -> StatsCache {
        info!("[codex-jsonl] force_reparse: clearing all caches");
        self.file_states.clear();
        self.session_cache.clear();
        self.needs_full_sync = true;
        if let Some(path) = codex_cache_path() {
            let _ = std::fs::remove_file(&path);
        }
        self.refresh()
    }
}

fn find_codex_jsonl_files() -> Vec<PathBuf> {
    let Some(root) = codex_sessions_dir() else {
        return vec![];
    };
    if !root.exists() {
        return vec![];
    }

    let mut results = Vec::new();
    walk_jsonl(&root, &mut results);
    results
}

fn walk_jsonl(dir: &PathBuf, out: &mut Vec<PathBuf>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk_jsonl(&path, out);
        } else if path.is_file() && path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            out.push(path);
        }
    }
}

fn parse_codex_file(path: &PathBuf) -> CodexSessionStats {
    let session_id = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();

    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return CodexSessionStats::default(),
    };
    let reader = BufReader::new(file);

    let mut stats = CodexSessionStats {
        session_id,
        ..Default::default()
    };

    // Tracked top-to-bottom across the JSONL stream so `token_count` events
    // can be attributed to whichever model the most recent `turn_context`
    // declared.
    let mut current_model: Option<String> = None;

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };
        if line.is_empty() {
            continue;
        }

        let parsed: CodexLine = match serde_json::from_str(&line) {
            Ok(p) => p,
            Err(_) => continue,
        };

        let ts = parsed
            .timestamp
            .as_deref()
            .and_then(|s| s.parse::<DateTime<Utc>>().ok());
        if let Some(t) = ts {
            stats.all_timestamps.push(t);
        }

        let Some(payload) = parsed.payload else {
            continue;
        };
        let payload_type = payload.get("type").and_then(|v| v.as_str()).unwrap_or("");

        match parsed.line_type.as_str() {
            "session_meta" => {
                let cwd = payload.get("cwd").and_then(|v| v.as_str()).map(String::from);
                let git_branch = payload
                    .get("git")
                    .and_then(|g| g.get("branch"))
                    .and_then(|v| v.as_str())
                    .map(String::from);
                let cli_version = payload
                    .get("cli_version")
                    .and_then(|v| v.as_str())
                    .map(String::from);
                let model_provider = payload
                    .get("model_provider")
                    .and_then(|v| v.as_str())
                    .map(String::from);
                if cwd.is_some()
                    || git_branch.is_some()
                    || cli_version.is_some()
                    || model_provider.is_some()
                {
                    stats.meta = Some(CodexSessionMeta {
                        cwd,
                        git_branch,
                        cli_version,
                        model_provider,
                    });
                }
            }
            "turn_context" => {
                if let Some(model) = payload.get("model").and_then(|v| v.as_str()) {
                    if !model.is_empty() {
                        current_model = Some(model.to_string());
                    }
                }
            }
            "event_msg" => match payload_type {
                "user_message" => {
                    stats.user_message_count += 1;
                    if let Some(t) = ts {
                        stats.user_timestamps.push(t);
                    }
                    // Hash only the FIRST user message — Codex sessions are
                    // long-running so subsequent prompts within a session are
                    // not used for uniqueness scoring.
                    if stats.first_prompt_hash.is_none() {
                        if let Some(msg) = payload.get("message").and_then(|v| v.as_str()) {
                            if !msg.is_empty() {
                                let mut hasher = Sha256::new();
                                hasher.update(msg.as_bytes());
                                stats.first_prompt_hash = Some(hex::encode(hasher.finalize()));
                            }
                        }
                    }
                }
                "token_count" => {
                    // payload.info.last_token_usage is the per-event delta.
                    if let Some(last) = payload
                        .get("info")
                        .and_then(|v| v.get("last_token_usage"))
                    {
                        let usage: TokenUsage =
                            serde_json::from_value(last.clone()).unwrap_or_default();
                        let model_key = current_model
                            .clone()
                            .unwrap_or_else(|| UNKNOWN_MODEL_NAME.to_string());
                        let entry = stats
                            .tokens_by_model
                            .entry(model_key)
                            .or_insert_with(TokenUsage::default);
                        entry.input_tokens += usage.input_tokens;
                        entry.cached_input_tokens += usage.cached_input_tokens;
                        entry.output_tokens += usage.output_tokens;
                        entry.reasoning_output_tokens += usage.reasoning_output_tokens;
                    }
                }
                _ => {}
            },
            "response_item" => {
                if payload_type == "function_call" {
                    stats.function_call_count += 1;
                    let name = payload
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let key = if name.is_empty() { "unknown" } else { name };
                    *stats
                        .tool_name_counts
                        .entry(key.to_string())
                        .or_insert(0) += 1;
                }
            }
            _ => {}
        }
    }

    compute_idle_time(&mut stats);
    stats
}

fn compute_idle_time(stats: &mut CodexSessionStats) {
    if stats.all_timestamps.len() < 2 {
        return;
    }
    let mut sorted = stats.all_timestamps.clone();
    sorted.sort();
    let first = sorted.first().unwrap();
    let last = sorted.last().unwrap();
    let total = (*last - *first).num_seconds().max(0) as u64;

    let mut idle: i64 = 0;
    for i in 1..sorted.len() {
        let gap = (sorted[i] - sorted[i - 1]).num_seconds();
        if gap > IDLE_THRESHOLD_SECS {
            idle += gap;
        }
    }
    let idle_secs = idle.max(0) as u64;
    stats.total_duration_secs = total;
    stats.total_idle_secs = idle_secs;
    stats.active_duration_secs = total.saturating_sub(idle_secs);
}

fn aggregate_codex(sessions: &[&CodexSessionStats]) -> StatsCache {
    let mut daily_messages: HashMap<String, u64> = HashMap::new();
    let mut daily_tool_calls: HashMap<String, u64> = HashMap::new();
    // date → model → tokens, so we can emit one DailyModelTokens entry per date
    // with per-model breakdown.
    let mut daily_tokens_by_model: HashMap<String, HashMap<String, u64>> = HashMap::new();
    let mut hour_counts: HashMap<String, u64> = HashMap::new();
    let mut hour_tokens: HashMap<String, u64> = HashMap::new();
    let mut model_usage_map: HashMap<String, ModelUsage> = HashMap::new();

    let mut total_messages: u64 = 0;
    let mut total_sessions: u64 = 0;
    let mut first_date: Option<String> = None;
    let mut total_session_time_secs: u64 = 0;
    let mut total_active_time_secs: u64 = 0;
    let mut total_idle_time_secs: u64 = 0;

    let mut daily_sessions_seen: HashMap<String, std::collections::HashSet<usize>> = HashMap::new();

    let mut prompt_hashes: Vec<String> = Vec::new();
    let mut tool_names: Vec<String> = Vec::new();

    for (idx, session) in sessions.iter().enumerate() {
        if session.all_timestamps.is_empty() {
            continue;
        }
        total_sessions += 1;
        total_session_time_secs += session.total_duration_secs;
        total_active_time_secs += session.active_duration_secs;
        total_idle_time_secs += session.total_idle_secs;
        total_messages += session.user_message_count;

        if let Some(hash) = &session.first_prompt_hash {
            prompt_hashes.push(hash.clone());
        }

        for (tool, count) in &session.tool_name_counts {
            for _ in 0..*count {
                tool_names.push(tool.clone());
            }
        }

        // Per-model accumulation. Fold reasoning into output_tokens so the
        // downstream server sums (input + output + cache_read + cache_creation)
        // are still correct — server doesn't have a column for reasoning.
        let mut session_total: u64 = 0;
        for (model, usage) in &session.tokens_by_model {
            let session_output = usage.output_tokens + usage.reasoning_output_tokens;
            let model_total = usage.input_tokens + session_output + usage.cached_input_tokens;
            session_total += model_total;

            let mu = model_usage_map
                .entry(model.clone())
                .or_insert_with(ModelUsage::default);
            mu.input_tokens += usage.input_tokens;
            mu.output_tokens += session_output;
            mu.cache_read_input_tokens += usage.cached_input_tokens;
            // cache_creation_input_tokens stays 0 — Codex doesn't distinguish cache writes.
        }

        let session_first = session.all_timestamps.iter().min().copied();
        if let Some(first_ts) = session_first {
            let session_date = first_ts.with_timezone(&Local).format("%Y-%m-%d").to_string();
            daily_sessions_seen
                .entry(session_date.clone())
                .or_default()
                .insert(idx);

            let per_date = daily_tokens_by_model
                .entry(session_date.clone())
                .or_default();
            for (model, usage) in &session.tokens_by_model {
                let session_output = usage.output_tokens + usage.reasoning_output_tokens;
                let model_total =
                    usage.input_tokens + session_output + usage.cached_input_tokens;
                *per_date.entry(model.clone()).or_insert(0) += model_total;
            }

            match &first_date {
                None => first_date = Some(session_date),
                Some(d) if session_date < *d => first_date = Some(session_date),
                _ => {}
            }
        }

        for ts in &session.user_timestamps {
            let date = ts.with_timezone(&Local).format("%Y-%m-%d").to_string();
            *daily_messages.entry(date).or_default() += 1;
            let hour_key = format!("{}:{}", ts.format("%Y-%m-%d"), ts.hour());
            *hour_counts.entry(hour_key).or_default() += 1;
        }

        if session.function_call_count > 0 {
            if let Some(first_ts) = session_first {
                let date = first_ts.with_timezone(&Local).format("%Y-%m-%d").to_string();
                *daily_tool_calls.entry(date).or_default() += session.function_call_count;
            }
        }

        // Spread session tokens across the hours it touched, weighted by event
        // count per hour. Codex doesn't tag tokens with timestamps, so this is
        // the best we can do without per-event attribution.
        let mut hour_event_counts: HashMap<String, u64> = HashMap::new();
        for ts in &session.all_timestamps {
            *hour_event_counts
                .entry(format!("{}:{}", ts.format("%Y-%m-%d"), ts.hour()))
                .or_default() += 1;
        }
        let total_events: u64 = hour_event_counts.values().sum();
        if total_events > 0 {
            for (hour_key, count) in hour_event_counts {
                let share = (session_total as f64) * (count as f64) / (total_events as f64);
                *hour_tokens.entry(hour_key).or_default() += share as u64;
            }
        }
    }

    let mut all_dates = BTreeSet::new();
    all_dates.extend(daily_messages.keys().cloned());
    all_dates.extend(daily_tool_calls.keys().cloned());
    all_dates.extend(daily_tokens_by_model.keys().cloned());

    let daily_activity: Vec<DailyActivity> = all_dates
        .iter()
        .map(|date| DailyActivity {
            date: date.clone(),
            message_count: *daily_messages.get(date).unwrap_or(&0),
            session_count: daily_sessions_seen
                .get(date)
                .map(|s| s.len() as u64)
                .unwrap_or(0),
            tool_call_count: *daily_tool_calls.get(date).unwrap_or(&0),
        })
        .collect();

    let mut daily_model_tokens: Vec<DailyModelTokens> = daily_tokens_by_model
        .into_iter()
        .map(|(date, tokens_by_model)| DailyModelTokens {
            date,
            tokens_by_model,
        })
        .collect();
    daily_model_tokens.sort_by(|a, b| a.date.cmp(&b.date));

    // Concurrency histogram & day_sessions — Codex parity with Claude.
    let concurrency_histogram = compute_codex_concurrency(sessions);
    let day_sessions = compute_codex_day_sessions(sessions);

    StatsCache {
        version: 1,
        last_computed_date: chrono::Utc::now().format("%Y-%m-%d").to_string(),
        daily_activity,
        daily_model_tokens,
        model_usage: model_usage_map,
        total_sessions,
        total_messages,
        longest_session: None,
        first_session_date: first_date,
        hour_counts,
        total_speculation_time_saved_ms: 0,
        concurrency_histogram,
        total_session_time_secs,
        total_active_time_secs,
        total_idle_time_secs,
        hour_tokens,
        day_sessions,
        prompt_hashes,
        tool_names,
    }
}

/// Per-minute session-overlap histogram, mirroring Claude's
/// `compute_concurrency_histogram` but driven by Codex sessions (all of which
/// are "main" — no subagent concept). Output shape matches the Claude side so
/// the server can persist it via the same code path.
fn compute_codex_concurrency(
    sessions: &[&CodexSessionStats],
) -> HashMap<String, HashMap<u32, u32>> {
    let mut histogram: HashMap<String, HashMap<u32, u32>> = HashMap::new();

    let session_segments: Vec<Vec<(DateTime<Utc>, DateTime<Utc>)>> = sessions
        .iter()
        .filter(|s| s.all_timestamps.len() >= 2)
        .map(|s| compute_active_segments(&s.all_timestamps))
        .filter(|segs| !segs.is_empty())
        .collect();

    if session_segments.is_empty() {
        return histogram;
    }

    let mut hours_with_activity: BTreeSet<String> = BTreeSet::new();
    for segments in &session_segments {
        for (seg_start, seg_end) in segments {
            let mut current = seg_start
                .with_minute(0)
                .unwrap()
                .with_second(0)
                .unwrap()
                .with_nanosecond(0)
                .unwrap();
            while current <= *seg_end {
                let hour_key = format!("{}:{}", current.format("%Y-%m-%d"), current.hour());
                hours_with_activity.insert(hour_key);
                current = current + Duration::hours(1);
            }
        }
    }

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

        let hour_start = match NaiveDateTime::parse_from_str(
            &format!("{} {:02}:00:00", date_str, hour),
            "%Y-%m-%d %H:%M:%S",
        ) {
            Ok(dt) => Utc.from_utc_datetime(&dt),
            Err(_) => continue,
        };

        let mut minute_counts: HashMap<u32, u32> = HashMap::new();

        for minute in 0..60u32 {
            let minute_start = hour_start + Duration::minutes(minute as i64);
            let minute_end = minute_start + Duration::minutes(1);

            let concurrent = session_segments
                .iter()
                .filter(|segments| {
                    segments.iter().any(|(seg_start, seg_end)| {
                        *seg_start < minute_end && *seg_end >= minute_start
                    })
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

/// Per-day session timeline with greedy ring assignment, mirroring Claude's
/// `compute_day_sessions`. Tokens are split evenly across same-day segments —
/// Codex has no per-event token attribution to do better.
fn compute_codex_day_sessions(
    sessions: &[&CodexSessionStats],
) -> HashMap<String, Vec<DaySessionEntry>> {
    struct RawSpan {
        start_min: u32,
        end_min: u32,
        tokens: u64,
        messages: u64,
    }

    let mut day_spans: HashMap<String, Vec<RawSpan>> = HashMap::new();

    for session in sessions {
        if session.all_timestamps.len() < 2 || session.user_message_count == 0 {
            continue;
        }

        let segments = compute_active_segments(&session.all_timestamps);
        if segments.is_empty() {
            continue;
        }

        let session_total: u64 = session
            .tokens_by_model
            .values()
            .map(|u| {
                u.input_tokens + u.output_tokens + u.reasoning_output_tokens + u.cached_input_tokens
            })
            .sum();

        let mut date_segments: HashMap<String, Vec<(u32, u32)>> = HashMap::new();
        for (seg_start, seg_end) in &segments {
            let start_date = seg_start.format("%Y-%m-%d").to_string();
            let end_date = seg_end.format("%Y-%m-%d").to_string();

            if start_date == end_date {
                let start_min = seg_start.hour() * 60 + seg_start.minute();
                let end_min = seg_end.hour() * 60 + seg_end.minute();
                date_segments
                    .entry(start_date)
                    .or_default()
                    .push((start_min, end_min.max(start_min)));
            } else {
                let start_min = seg_start.hour() * 60 + seg_start.minute();
                date_segments
                    .entry(start_date)
                    .or_default()
                    .push((start_min, 1439));
                let end_min = seg_end.hour() * 60 + seg_end.minute();
                date_segments.entry(end_date).or_default().push((0, end_min));
            }
        }

        // Tokens per date: split session total proportionally to per-date segment count.
        let total_segments: usize = date_segments.values().map(|v| v.len()).sum();
        let mut date_messages: HashMap<String, u64> = HashMap::new();
        for ts in &session.user_timestamps {
            let date = ts.format("%Y-%m-%d").to_string();
            *date_messages.entry(date).or_default() += 1;
        }

        for (date, segs) in &date_segments {
            let seg_count = segs.len().max(1) as u64;
            let tokens_for_date = if total_segments > 0 {
                (session_total as f64 * (segs.len() as f64) / (total_segments as f64)) as u64
            } else {
                0
            };
            let messages_for_date = date_messages.get(date).copied().unwrap_or(0);

            for &(seg_start, seg_end) in segs {
                day_spans.entry(date.clone()).or_default().push(RawSpan {
                    start_min: seg_start,
                    end_min: seg_end.max(seg_start),
                    tokens: tokens_for_date / seg_count,
                    messages: messages_for_date / seg_count,
                });
            }
        }
    }

    let mut result: HashMap<String, Vec<DaySessionEntry>> = HashMap::new();

    for (date, mut spans) in day_spans {
        spans.sort_by_key(|s| s.start_min);

        let mut ring_ends: Vec<u32> = Vec::new();
        let mut entries = Vec::new();
        for span in &spans {
            let mut assigned_ring = None;
            for (i, end) in ring_ends.iter().enumerate() {
                if span.start_min > *end {
                    assigned_ring = Some(i);
                    break;
                }
            }
            let ring = match assigned_ring {
                Some(r) => {
                    ring_ends[r] = span.end_min;
                    r
                }
                None => {
                    ring_ends.push(span.end_min);
                    ring_ends.len() - 1
                }
            };

            entries.push(DaySessionEntry {
                ring: ring as u32,
                start: span.start_min,
                end: span.end_min,
                tokens: span.tokens,
                messages: span.messages,
            });
        }

        if !entries.is_empty() {
            result.insert(date, entries);
        }
    }

    result
}
