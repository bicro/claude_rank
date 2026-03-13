use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

// ── stats-cache.json ──

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StatsCache {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub last_computed_date: String,
    #[serde(default)]
    pub daily_activity: Vec<DailyActivity>,
    #[serde(default)]
    pub daily_model_tokens: Vec<DailyModelTokens>,
    #[serde(default)]
    pub model_usage: HashMap<String, ModelUsage>,
    #[serde(default)]
    pub total_sessions: u64,
    #[serde(default)]
    pub total_messages: u64,
    #[serde(default)]
    pub longest_session: Option<LongestSession>,
    #[serde(default)]
    pub first_session_date: Option<String>,
    #[serde(default)]
    pub hour_counts: HashMap<String, u64>,
    #[serde(default)]
    pub hour_tokens: HashMap<String, u64>,
    #[serde(default)]
    pub total_speculation_time_saved_ms: u64,
    /// Concurrency histogram: Key is "YYYY-MM-DD:HH", Value is {session_count: minutes_with_that_count}
    #[serde(default)]
    pub concurrency_histogram: HashMap<String, HashMap<u32, u32>>,
    /// Total session time across all sessions (seconds)
    #[serde(default)]
    pub total_session_time_secs: u64,
    /// Total active time (excluding idle gaps) across all sessions (seconds)
    #[serde(default)]
    pub total_active_time_secs: u64,
    /// Total idle time across all sessions (seconds)
    #[serde(default)]
    pub total_idle_time_secs: u64,
    /// Per-session per-hour metrics: Key is "YYYY-MM-DD:HH", Value is vec of per-session metrics
    #[serde(default)]
    pub session_hour_metrics: HashMap<String, Vec<SessionHourMetric>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionHourMetric {
    pub messages: u64,
    pub tokens: u64,
    pub minutes: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DailyActivity {
    pub date: String,
    #[serde(default)]
    pub message_count: u64,
    #[serde(default)]
    pub session_count: u64,
    #[serde(default)]
    pub tool_call_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DailyModelTokens {
    pub date: String,
    #[serde(default)]
    pub tokens_by_model: HashMap<String, u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsage {
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
    #[serde(default)]
    pub cache_read_input_tokens: u64,
    #[serde(default)]
    pub cache_creation_input_tokens: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LongestSession {
    pub session_id: String,
    #[serde(default)]
    pub duration: u64,
    #[serde(default)]
    pub message_count: u64,
}

// ── sessions-index.json ──

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionsIndex {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub entries: Vec<SessionEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEntry {
    pub session_id: String,
    #[serde(default)]
    pub full_path: String,
    #[serde(default)]
    pub first_prompt: Option<String>,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub message_count: u64,
    #[serde(default)]
    pub created: Option<String>,
    #[serde(default)]
    pub modified: Option<String>,
    #[serde(default)]
    pub git_branch: Option<String>,
    #[serde(default)]
    pub project_path: Option<String>,
    /// Total duration of this session in seconds
    #[serde(default)]
    pub duration_secs: u64,
    /// Active time (excluding idle gaps) in seconds
    #[serde(default)]
    pub active_secs: u64,
    /// Idle time in seconds
    #[serde(default)]
    pub idle_secs: u64,
}

// ── Helpers ──

#[allow(dead_code)]
pub fn stats_cache_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude").join("stats-cache.json"))
}

pub fn claude_projects_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude").join("projects"))
}

#[allow(dead_code)]
pub fn parse_stats_cache() -> Option<StatsCache> {
    let path = stats_cache_path()?;
    let data = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str(&data).ok()
}

#[allow(dead_code)]
pub fn parse_sessions_index(path: &std::path::Path) -> Option<SessionsIndex> {
    let data = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&data).ok()
}

#[allow(dead_code)]
pub fn find_all_sessions_indices() -> Vec<PathBuf> {
    let Some(projects_dir) = claude_projects_dir() else {
        return vec![];
    };
    let mut results = vec![];
    if let Ok(entries) = std::fs::read_dir(&projects_dir) {
        for entry in entries.flatten() {
            let idx = entry.path().join("sessions-index.json");
            if idx.exists() {
                results.push(idx);
            }
        }
    }
    results
}
