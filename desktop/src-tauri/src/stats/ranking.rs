use chrono::Utc;
use log::{error, info, warn};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::Emitter;

use super::metrics::MetricsEngine;
use super::parser::{DaySessionEntry, StatsCache};
use super::points::{PointsEngine, PointsState};

fn ranking_api_base() -> String {
    // Replace "localhost" with "127.0.0.1" to avoid IPv6 resolution issues on macOS
    // (Bun.serve binds to 0.0.0.0 / IPv4 only; macOS may resolve localhost to ::1)
    std::env::var("RANKING_API_BASE")
        .unwrap_or_else(|_| "https://clauderank.com".to_string())
        .replace("localhost", "127.0.0.1")
}
const SYNC_THROTTLE_SECS: u64 = 300; // 5 minutes

// ── Identity & Settings ──

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RankingConfig {
    pub user_hash: String,
    #[serde(default)]
    pub sync_secret: Option<String>,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub team_hash: Option<String>,
    #[serde(default)]
    pub team_name: Option<String>,
    #[serde(default = "default_sync_settings")]
    pub sync_settings: SyncSettings,
    #[serde(default)]
    pub last_synced: Option<String>,
    /// When this device is linked to a multi-device account, this is the primary user_hash
    /// used for profile/leaderboard links. The device keeps its own user_hash for syncing.
    #[serde(default)]
    pub primary_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncSettings {
    #[serde(default = "default_true")]
    pub tokens: bool,
    #[serde(default = "default_true")]
    pub messages: bool,
    #[serde(default = "default_true")]
    pub sessions: bool,
    #[serde(default = "default_true")]
    pub tool_calls: bool,
    #[serde(default)]
    pub prompts: bool, // OFF by default
    #[serde(default = "default_true")]
    pub prompt_hashes: bool,
    #[serde(default = "default_true")]
    pub daily_breakdown: bool,
    #[serde(default = "default_true")]
    pub model_names: bool,
    #[serde(default = "default_true")]
    pub hour_activity: bool,
    #[serde(default = "default_true")]
    pub concurrency_activity: bool,
}

fn default_true() -> bool {
    true
}

fn default_sync_settings() -> SyncSettings {
    SyncSettings {
        tokens: true,
        messages: true,
        sessions: true,
        tool_calls: true,
        prompts: false,
        prompt_hashes: true,
        daily_breakdown: true,
        model_names: true,
        hour_activity: true,
        concurrency_activity: true,
    }
}

// ── Sync Payload ──

#[derive(Debug, Serialize)]
pub(crate) struct SyncPayload {
    user_hash: String,
    sync_secret: String,
    sync_settings: SyncSettings,
    totals: SyncTotals,
    #[serde(skip_serializing_if = "Option::is_none")]
    token_breakdown: Option<HashMap<String, TokenBreakdown>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    daily_activity: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    hour_counts: Option<HashMap<String, u64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    hour_tokens: Option<HashMap<String, u64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    concurrency_histogram: Option<HashMap<String, HashMap<u32, u32>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    day_sessions: Option<HashMap<String, Vec<DaySessionEntry>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    prompt_hashes: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    prompts: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_names: Option<Vec<String>>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    full_reparse: bool,
}

#[derive(Debug, Serialize)]
struct SyncTotals {
    total_tokens: u64,
    total_messages: u64,
    total_sessions: u64,
    total_tool_calls: u64,
    current_streak: u64,
    total_points: u64,
    level: u64,
    total_session_time_secs: u64,
    total_active_time_secs: u64,
    total_idle_time_secs: u64,
}

#[derive(Debug, Serialize)]
struct TokenBreakdown {
    input: u64,
    output: u64,
    cache_read: u64,
    cache_creation: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct SyncAchievement {
    id: String,
    name: String,
    description: String,
    unlocked_at: String,
}

#[derive(Debug, Deserialize)]
struct SyncResponse {
    #[allow(dead_code)]
    status: String,
    #[serde(default)]
    weighted_score: f64,
    #[serde(default)]
    #[allow(dead_code)]
    prompt_uniqueness_score: f64,
    #[serde(default)]
    new_badges: Vec<String>,
    /// Set when this device is linked to a primary account (multi-device).
    /// The device keeps syncing with its own user_hash but uses primary_hash for profile links.
    #[serde(default)]
    primary_hash: Option<String>,
    // Server-computed points data
    #[serde(default)]
    total_points: u64,
    #[serde(default)]
    level: u64,
    #[serde(default)]
    current_streak: u64,
    #[serde(default)]
    achievements: Vec<SyncAchievement>,
    #[serde(default)]
    new_achievements: Vec<SyncAchievement>,
}

// ── Ranking Engine ──

pub struct RankingEngine {
    config: RankingConfig,
    last_sync_time: Option<Instant>,
    is_syncing: bool,
}

impl RankingEngine {
    pub fn new() -> Self {
        let config = load_or_create_config();
        Self {
            config,
            last_sync_time: None,
            is_syncing: false,
        }
    }

    pub fn config(&self) -> &RankingConfig {
        &self.config
    }

    pub fn update_config(&mut self, config: RankingConfig) {
        self.config = config.clone();
        save_config(&config);
    }

    pub fn should_sync(&self) -> bool {
        match self.last_sync_time {
            None => true,
            Some(t) => t.elapsed().as_secs() >= SYNC_THROTTLE_SECS,
        }
    }

    pub fn reset_sync_timer(&mut self) {
        self.last_sync_time = None;
    }

    pub fn mark_synced(&mut self) {
        self.last_sync_time = Some(Instant::now());
        self.config.last_synced = Some(Utc::now().to_rfc3339());
        save_config(&self.config);
    }

    /// Ensure config has a sync_secret (backfill for pre-existing installs).
    pub fn ensure_sync_secret(&mut self) {
        if self.config.sync_secret.is_none() {
            self.config.sync_secret = Some(uuid::Uuid::new_v4().to_string());
            save_config(&self.config);
            info!("[ranking] Generated sync_secret for existing identity");
        }
    }

    pub fn build_sync_payload(&self, stats: &StatsCache, points_state: &PointsState, full_reparse: bool) -> SyncPayload {
        let settings = &self.config.sync_settings;

        // Compute totals
        let total_tokens: u64 = stats
            .model_usage
            .values()
            .map(|m| {
                m.input_tokens + m.output_tokens + m.cache_read_input_tokens + m.cache_creation_input_tokens
            })
            .sum();
        let total_tool_calls: u64 = stats.daily_activity.iter().map(|d| d.tool_call_count).sum();

        let totals = SyncTotals {
            total_tokens,
            total_messages: stats.total_messages,
            total_sessions: stats.total_sessions,
            total_tool_calls,
            current_streak: points_state.current_streak,
            total_points: points_state.total_points,
            level: points_state.level,
            total_session_time_secs: stats.total_session_time_secs,
            total_active_time_secs: stats.total_active_time_secs,
            total_idle_time_secs: stats.total_idle_time_secs,
        };

        // Token breakdown per model
        let token_breakdown = if settings.tokens {
            Some(
                stats
                    .model_usage
                    .iter()
                    .map(|(model, usage)| {
                        (
                            model.clone(),
                            TokenBreakdown {
                                input: usage.input_tokens,
                                output: usage.output_tokens,
                                cache_read: usage.cache_read_input_tokens,
                                cache_creation: usage.cache_creation_input_tokens,
                            },
                        )
                    })
                    .collect(),
            )
        } else {
            None
        };

        // Daily activity — enrich with tokenCount from daily_model_tokens
        let daily_activity = if settings.daily_breakdown {
            // Build a date→total_tokens lookup from daily_model_tokens
            let daily_token_totals: HashMap<&str, u64> = stats
                .daily_model_tokens
                .iter()
                .map(|dmt| {
                    let total: u64 = dmt.tokens_by_model.values().sum();
                    (dmt.date.as_str(), total)
                })
                .collect();

            let enriched: Vec<serde_json::Value> = stats
                .daily_activity
                .iter()
                .map(|da| {
                    let token_count = daily_token_totals.get(da.date.as_str()).copied().unwrap_or(0);
                    serde_json::json!({
                        "date": da.date,
                        "messageCount": da.message_count,
                        "sessionCount": da.session_count,
                        "toolCallCount": da.tool_call_count,
                        "tokenCount": token_count,
                    })
                })
                .collect();
            serde_json::to_value(&enriched).ok()
        } else {
            None
        };

        // Hour counts
        let hour_counts = if settings.hour_activity {
            Some(stats.hour_counts.clone())
        } else {
            None
        };

        // Hourly token totals
        let hour_tokens = if settings.hour_activity {
            Some(stats.hour_tokens.clone())
        } else {
            None
        };

        // Concurrency histogram
        let concurrency_histogram = if settings.concurrency_activity {
            Some(stats.concurrency_histogram.clone())
        } else {
            None
        };

        // Day sessions (session-based burn clock)
        let day_sessions = if settings.concurrency_activity {
            Some(stats.day_sessions.clone())
        } else {
            None
        };

        SyncPayload {
            user_hash: self.config.user_hash.clone(),
            sync_secret: self.config.sync_secret.clone().unwrap_or_default(),
            sync_settings: settings.clone(),
            totals,
            token_breakdown,
            daily_activity,
            hour_counts,
            hour_tokens,
            concurrency_histogram,
            day_sessions,
            prompt_hashes: None, // Populated from sessions if enabled
            prompts: None,       // Populated from sessions if enabled
            tool_names: None,    // Could be populated from stats
            full_reparse,
        }
    }
}

// ── File I/O ──

fn ranking_config_path() -> PathBuf {
    let dir = dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".ClaudeRank");
    std::fs::create_dir_all(&dir).ok();
    dir.join("ranking.json")
}

fn load_or_create_config() -> RankingConfig {
    let path = ranking_config_path();
    if let Ok(data) = std::fs::read_to_string(&path) {
        if let Ok(config) = serde_json::from_str::<RankingConfig>(&data) {
            return config;
        }
    }

    // Generate new identity
    let config = RankingConfig {
        user_hash: uuid::Uuid::new_v4().to_string(),
        sync_secret: Some(uuid::Uuid::new_v4().to_string()),
        username: None,
        team_hash: None,
        team_name: None,
        sync_settings: default_sync_settings(),
        last_synced: None,
        primary_hash: None,
    };
    save_config(&config);
    info!("[ranking] Created new identity: {}", config.user_hash);
    config
}

fn save_config(config: &RankingConfig) {
    let path = ranking_config_path();
    if let Ok(json) = serde_json::to_string_pretty(config) {
        if let Err(e) = std::fs::write(&path, json) {
            error!("[ranking] Failed to save config: {}", e);
        }
    }
}

// ── Tauri Commands ──

#[tauri::command]
pub fn get_ranking_identity(
    ranking: tauri::State<'_, Arc<Mutex<RankingEngine>>>,
) -> Result<RankingConfig, String> {
    let r = ranking.lock().map_err(|e| e.to_string())?;
    Ok(r.config().clone())
}

#[tauri::command]
pub fn get_sync_settings(
    ranking: tauri::State<'_, Arc<Mutex<RankingEngine>>>,
) -> Result<SyncSettings, String> {
    let r = ranking.lock().map_err(|e| e.to_string())?;
    Ok(r.config().sync_settings.clone())
}

#[tauri::command]
pub fn update_sync_settings(
    settings: SyncSettings,
    ranking: tauri::State<'_, Arc<Mutex<RankingEngine>>>,
) -> Result<(), String> {
    let mut r = ranking.lock().map_err(|e| e.to_string())?;
    let mut config = r.config().clone();
    config.sync_settings = settings;
    r.update_config(config);
    Ok(())
}

#[tauri::command]
pub async fn set_username(
    user_hash: String,
    username: String,
    ranking: tauri::State<'_, Arc<Mutex<RankingEngine>>>,
) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let url = format!("{}/api/users/{}/username", ranking_api_base(), user_hash);
    let resp = client
        .put(&url)
        .json(&serde_json::json!({ "username": username }))
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    if !resp.status().is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Server error: {}", text));
    }
    let result: serde_json::Value = resp.json().await.map_err(|e| format!("Parse error: {}", e))?;

    // Persist username locally
    let mut r = ranking.lock().map_err(|e| e.to_string())?;
    let mut config = r.config().clone();
    config.username = Some(username);
    r.update_config(config);

    Ok(result)
}

#[tauri::command]
pub async fn create_team(
    user_hash: String,
    team_name: String,
    ranking: tauri::State<'_, Arc<Mutex<RankingEngine>>>,
) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let url = format!("{}/api/teams", ranking_api_base());
    let resp = client
        .post(&url)
        .json(&serde_json::json!({ "user_hash": user_hash, "team_name": team_name }))
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    if !resp.status().is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Server error: {}", text));
    }
    let data: serde_json::Value = resp.json().await.map_err(|e| format!("Parse error: {}", e))?;

    // Update local config
    if let (Some(hash), Some(name)) = (data.get("team_hash").and_then(|v| v.as_str()), data.get("team_name").and_then(|v| v.as_str())) {
        let mut r = ranking.lock().map_err(|e| e.to_string())?;
        let mut config = r.config().clone();
        config.team_hash = Some(hash.to_string());
        config.team_name = Some(name.to_string());
        r.update_config(config);
    }

    Ok(data)
}

#[tauri::command]
pub async fn join_team(
    user_hash: String,
    team_hash: String,
    ranking: tauri::State<'_, Arc<Mutex<RankingEngine>>>,
) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let url = format!("{}/api/teams/{}/join", ranking_api_base(), team_hash);
    let resp = client
        .post(&url)
        .json(&serde_json::json!({ "user_hash": user_hash }))
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    if !resp.status().is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Server error: {}", text));
    }
    let data: serde_json::Value = resp.json().await.map_err(|e| format!("Parse error: {}", e))?;

    if let Some(name) = data.get("team_name").and_then(|v| v.as_str()) {
        let mut r = ranking.lock().map_err(|e| e.to_string())?;
        let mut config = r.config().clone();
        config.team_hash = Some(team_hash);
        config.team_name = Some(name.to_string());
        r.update_config(config);
    }

    Ok(data)
}

#[tauri::command]
pub async fn leave_team(
    user_hash: String,
    ranking: tauri::State<'_, Arc<Mutex<RankingEngine>>>,
) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let url = format!("{}/api/teams/leave", ranking_api_base());
    let resp = client
        .post(&url)
        .json(&serde_json::json!({ "user_hash": user_hash }))
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    if !resp.status().is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Server error: {}", text));
    }
    let data: serde_json::Value = resp.json().await.map_err(|e| format!("Parse error: {}", e))?;

    let mut r = ranking.lock().map_err(|e| e.to_string())?;
    let mut config = r.config().clone();
    config.team_hash = None;
    config.team_name = None;
    r.update_config(config);

    Ok(data)
}

#[tauri::command]
pub async fn get_my_ranking(user_hash: String) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let url = format!("{}/api/users/{}", ranking_api_base(), user_hash);
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    if !resp.status().is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Server error: {}", text));
    }
    resp.json().await.map_err(|e| format!("Parse error: {}", e))
}

#[tauri::command]
pub fn open_ranking_website() -> Result<(), String> {
    let url = std::env::var("RANKING_WEBSITE_URL")
        .unwrap_or_else(|_| ranking_api_base());
    open::that(url).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn force_sync(
    ranking: tauri::State<'_, Arc<Mutex<RankingEngine>>>,
    metrics: tauri::State<'_, Arc<Mutex<MetricsEngine>>>,
    points: tauri::State<'_, Arc<Mutex<PointsEngine>>>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    info!("[ranking] Force sync triggered — full reparse");
    // Force full reparse so we sync fresh JSONL data (not stale cache)
    {
        let mut m = metrics.lock().map_err(|e| e.to_string())?;
        m.force_reparse();
    }
    {
        let mut engine = ranking.lock().map_err(|e| e.to_string())?;
        engine.reset_sync_timer();
    }
    let stats = {
        let m = metrics.lock().map_err(|e| e.to_string())?;
        m.data.stats.clone()
    };
    // force_reparse sets needs_full_sync=true on the tracker,
    // but force_sync bypasses the watcher, so pass it explicitly
    try_sync_inner(&ranking.inner().clone(), &stats, &points.inner().clone(), &app, true);
    Ok(())
}

// ── Sync Function (called from watcher) ──

pub fn try_sync(
    ranking: &Arc<Mutex<RankingEngine>>,
    stats: &StatsCache,
    points: &Arc<Mutex<super::points::PointsEngine>>,
    app: &tauri::AppHandle,
    full_reparse: bool,
) {
    try_sync_inner(ranking, stats, points, app, full_reparse);
}

fn try_sync_inner(
    ranking: &Arc<Mutex<RankingEngine>>,
    stats: &StatsCache,
    points: &Arc<Mutex<super::points::PointsEngine>>,
    app: &tauri::AppHandle,
    full_reparse: bool,
) {
    let points_state = match points.lock() {
        Ok(p) => p.points_state().clone(),
        Err(_) => return,
    };
    let points_clone = Arc::clone(points);

    let payload_json = {
        let mut engine = match ranking.lock() {
            Ok(e) => e,
            Err(_) => return,
        };
        if !engine.should_sync() || engine.is_syncing {
            info!("[ranking] Sync skipped: should_sync={}, is_syncing={}", engine.should_sync(), engine.is_syncing);
            return;
        }
        engine.ensure_sync_secret();
        let payload = engine.build_sync_payload(stats, &points_state, full_reparse);
        let json = match serde_json::to_string(&payload) {
            Ok(j) => j,
            Err(e) => {
                error!("[ranking] Failed to serialize payload: {}", e);
                return;
            }
        };
        engine.is_syncing = true;
        json
    };

    let app_handle = app.clone();
    let ranking_clone = Arc::clone(ranking);

    // Spawn async sync task
    tauri::async_runtime::spawn(async move {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        let url = format!("{}/api/sync", ranking_api_base());
        info!("[ranking] Sending sync POST to {} (payload {} bytes)", url, payload_json.len());

        let mut success = false;
        match client
            .post(&url)
            .header("Content-Type", "application/json")
            .body(payload_json)
            .send()
            .await
        {
            Ok(resp) => {
                if resp.status().is_success() {
                    if let Ok(data) = resp.json::<SyncResponse>().await {
                        info!(
                            "[ranking] Synced OK. weighted={:.2}, points={}, level={}, streak={}, badges={}, achievements={}",
                            data.weighted_score,
                            data.total_points,
                            data.level,
                            data.current_streak,
                            data.new_badges.len(),
                            data.new_achievements.len(),
                        );
                        success = true;

                        // Update PointsEngine with server-computed values
                        if let Ok(mut p) = points_clone.lock() {
                            let achievements: Vec<super::points::Achievement> = data.achievements.iter().map(|a| {
                                super::points::Achievement {
                                    id: a.id.clone(),
                                    name: a.name.clone(),
                                    description: a.description.clone(),
                                    unlocked_at: a.unlocked_at.clone(),
                                }
                            }).collect();
                            p.update_from_server(
                                data.total_points,
                                data.level,
                                data.current_streak,
                                achievements,
                            );
                            let _ = app_handle.emit("points-updated", p.points_state());
                        }

                        // Emit achievement-unlocked for newly unlocked achievements
                        for achievement in &data.new_achievements {
                            let _ = app_handle.emit("achievement-unlocked", &super::points::Achievement {
                                id: achievement.id.clone(),
                                name: achievement.name.clone(),
                                description: achievement.description.clone(),
                                unlocked_at: achievement.unlocked_at.clone(),
                            });
                        }

                        // Emit badge events
                        for badge_id in &data.new_badges {
                            let _ = app_handle.emit("badge-unlocked", badge_id);
                        }
                        // Save primary_hash if this device is linked to a multi-device account
                        if let Some(ref ph) = data.primary_hash {
                            info!("[ranking] Device linked to primary: {}", ph);
                            if let Ok(mut engine) = ranking_clone.lock() {
                                let mut config = engine.config().clone();
                                config.primary_hash = Some(ph.clone());
                                engine.update_config(config);
                            }
                        }
                        // Notify frontend that sync completed so widget can refresh
                        let _ = app_handle.emit("sync-complete", ());
                    }
                } else {
                    let status = resp.status();
                    let text = resp.text().await.unwrap_or_default();
                    warn!("[ranking] Sync failed: {} - {}", status, text);
                }
            }
            Err(e) => {
                warn!("[ranking] Sync network error: {:?}", e);
            }
        }

        // Only throttle on success; on failure, allow retry on next poll
        if let Ok(mut engine) = ranking_clone.lock() {
            engine.is_syncing = false;
            if success {
                engine.mark_synced();
            }
        }
    });
}
