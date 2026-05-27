use super::parser::{DailyActivity, DailyModelTokens, ModelUsage, StatsCache};
use chrono::{DateTime, Local, Timelike, Utc};
use log::{debug, info, warn};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap};
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::time::SystemTime;

const IDLE_THRESHOLD_SECS: i64 = 300;
const CACHE_VERSION: u32 = 1;
const CODEX_MODEL_NAME: &str = "codex";

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

#[derive(Debug, Clone, Default)]
struct CodexSessionStats {
    #[allow(dead_code)]
    session_id: String,
    user_message_count: u64,
    function_call_count: u64,
    all_timestamps: Vec<DateTime<Utc>>,
    user_timestamps: Vec<DateTime<Utc>>,
    /// Summed deltas across all token_count events in this session.
    /// last_token_usage gives the per-step delta; summing them reproduces the
    /// final total_token_usage in the last event.
    tokens: TokenUsage,
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

        match (parsed.line_type.as_str(), payload_type) {
            ("event_msg", "user_message") => {
                stats.user_message_count += 1;
                if let Some(t) = ts {
                    stats.user_timestamps.push(t);
                }
            }
            ("event_msg", "token_count") => {
                // payload.info.last_token_usage is the per-event delta.
                if let Some(last) = payload
                    .get("info")
                    .and_then(|v| v.get("last_token_usage"))
                {
                    let usage: TokenUsage =
                        serde_json::from_value(last.clone()).unwrap_or_default();
                    stats.tokens.input_tokens += usage.input_tokens;
                    stats.tokens.cached_input_tokens += usage.cached_input_tokens;
                    stats.tokens.output_tokens += usage.output_tokens;
                    stats.tokens.reasoning_output_tokens += usage.reasoning_output_tokens;
                }
            }
            ("response_item", "function_call") => {
                stats.function_call_count += 1;
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
    let mut daily_tokens: HashMap<String, u64> = HashMap::new();
    let mut hour_counts: HashMap<String, u64> = HashMap::new();
    let mut hour_tokens: HashMap<String, u64> = HashMap::new();
    let mut model_usage_map: HashMap<String, ModelUsage> = HashMap::new();

    let mut total_messages: u64 = 0;
    let mut total_sessions: u64 = 0;
    let mut total_tokens: u64 = 0;
    let mut first_date: Option<String> = None;
    let mut total_session_time_secs: u64 = 0;
    let mut total_active_time_secs: u64 = 0;
    let mut total_idle_time_secs: u64 = 0;

    let mut daily_sessions_seen: HashMap<String, std::collections::HashSet<usize>> = HashMap::new();

    for (idx, session) in sessions.iter().enumerate() {
        if session.all_timestamps.is_empty() {
            continue;
        }
        total_sessions += 1;
        total_session_time_secs += session.total_duration_secs;
        total_active_time_secs += session.active_duration_secs;
        total_idle_time_secs += session.total_idle_secs;
        total_messages += session.user_message_count;

        // Fold reasoning into output so total_tokens math stays consistent
        // with how downstream consumers sum input+output+cache.
        let session_output = session.tokens.output_tokens + session.tokens.reasoning_output_tokens;
        let session_total = session.tokens.input_tokens
            + session_output
            + session.tokens.cached_input_tokens;
        total_tokens += session_total;

        let mu = model_usage_map
            .entry(CODEX_MODEL_NAME.to_string())
            .or_insert_with(ModelUsage::default);
        mu.input_tokens += session.tokens.input_tokens;
        mu.output_tokens += session_output;
        mu.cache_read_input_tokens += session.tokens.cached_input_tokens;
        // cache_creation_input_tokens stays 0 — Codex doesn't distinguish cache writes.

        // Pick the session's "date" from its first timestamp (local time, matching Claude parser).
        let session_first = session.all_timestamps.iter().min().copied();
        if let Some(first_ts) = session_first {
            let session_date = first_ts.with_timezone(&Local).format("%Y-%m-%d").to_string();
            daily_sessions_seen
                .entry(session_date.clone())
                .or_default()
                .insert(idx);
            *daily_tokens.entry(session_date.clone()).or_default() += session_total;

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

        // Spread session tokens across the hours it touched, weighted by the
        // number of timestamps in that hour. Cheap heuristic — good enough for
        // the POC, no per-event token attribution.
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
    all_dates.extend(daily_tokens.keys().cloned());

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

    let mut daily_model_tokens: Vec<DailyModelTokens> = daily_tokens
        .into_iter()
        .map(|(date, tokens)| {
            let mut map = HashMap::new();
            map.insert(CODEX_MODEL_NAME.to_string(), tokens);
            DailyModelTokens {
                date,
                tokens_by_model: map,
            }
        })
        .collect();
    daily_model_tokens.sort_by(|a, b| a.date.cmp(&b.date));

    let _ = total_tokens; // total derived downstream from model_usage_map

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
        concurrency_histogram: HashMap::new(),
        total_session_time_secs,
        total_active_time_secs,
        total_idle_time_secs,
        hour_tokens,
        day_sessions: HashMap::new(),
    }
}
