use log::{error, info, warn};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use super::browser_cookies;
use super::ranking::RankingEngine;
use tauri::Emitter;

/// Cursor sync throttle: 30 seconds while debugging, increase later
const CURSOR_SYNC_THROTTLE_SECS: u64 = 30;

/// Last Cursor sync timestamp (epoch seconds). Atomic so watcher thread can check without lock.
static LAST_CURSOR_SYNC: AtomicU64 = AtomicU64::new(0);

fn ranking_api_base() -> String {
    std::env::var("RANKING_API_BASE")
        .unwrap_or_else(|_| "https://clauderank.com".to_string())
        .replace("localhost", "127.0.0.1")
}

fn should_cursor_sync() -> bool {
    let last = LAST_CURSOR_SYNC.load(Ordering::Relaxed);
    if last == 0 {
        return true;
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    now - last >= CURSOR_SYNC_THROTTLE_SECS
}

fn mark_cursor_synced() {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    LAST_CURSOR_SYNC.store(now, Ordering::Relaxed);
}

// ── Cursor Config (persisted alongside RankingConfig) ──

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum CursorCookieSource {
    /// Automatically import from installed browsers (Firefox → Chrome).
    #[serde(rename = "auto")]
    Auto,
    /// Use a manually pasted cookie header.
    #[serde(rename = "manual")]
    Manual,
}

impl Default for CursorCookieSource {
    fn default() -> Self {
        Self::Auto
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CursorConfig {
    #[serde(default)]
    pub enabled: bool,
    /// How to acquire the Cursor cookie: auto (browser import) or manual (user pastes).
    #[serde(default)]
    pub cookie_source: CursorCookieSource,
    /// Manual cookie header value (used when cookie_source == Manual).
    #[serde(default)]
    pub cookie: Option<String>,
    /// Cached cookie from last successful browser import (avoids re-reading browser DBs).
    #[serde(default)]
    pub cached_cookie: Option<String>,
    /// Which browser the cached cookie came from.
    #[serde(default)]
    pub cached_cookie_source: Option<String>,
    /// Separate user_hash for the Cursor identity on ClaudeRank.
    /// Generated on first Cursor sync so Cursor and Claude Code are distinct users
    /// that can be combined later.
    #[serde(default)]
    pub cursor_user_hash: Option<String>,
    #[serde(default)]
    pub cursor_sync_secret: Option<String>,
    /// Last successful Cursor sync timestamp.
    #[serde(default)]
    pub last_synced: Option<String>,
    /// Cached Cursor account email (from /api/auth/me).
    #[serde(default)]
    pub account_email: Option<String>,
    /// Cached membership type.
    #[serde(default)]
    pub membership_type: Option<String>,
}

impl Default for CursorConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            cookie_source: CursorCookieSource::Auto,
            cookie: None,
            cached_cookie: None,
            cached_cookie_source: None,
            cursor_user_hash: None,
            cursor_sync_secret: None,
            last_synced: None,
            account_email: None,
            membership_type: None,
        }
    }
}

// ── Cursor API Response Types ──

#[derive(Debug, Deserialize)]
struct CursorUserInfo {
    email: Option<String>,
    name: Option<String>,
    sub: Option<String>,
    picture: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CursorUsageSummary {
    #[serde(rename = "billingCycleStart")]
    billing_cycle_start: Option<String>,
    #[serde(rename = "billingCycleEnd")]
    billing_cycle_end: Option<String>,
    #[serde(rename = "membershipType")]
    membership_type: Option<String>,
    #[serde(rename = "individualUsage")]
    individual_usage: Option<CursorIndividualUsage>,
}

#[derive(Debug, Deserialize)]
struct CursorIndividualUsage {
    plan: Option<CursorPlanUsage>,
    #[serde(rename = "onDemand")]
    on_demand: Option<CursorOnDemandUsage>,
}

#[derive(Debug, Deserialize)]
struct CursorPlanUsage {
    used: Option<f64>,
    limit: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct CursorOnDemandUsage {
    used: Option<f64>,
    limit: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct CursorUsageResponse {
    #[serde(rename = "gpt-4")]
    gpt4: Option<CursorModelUsage>,
}

#[derive(Debug, Deserialize)]
struct CursorModelUsage {
    #[serde(rename = "numRequests")]
    num_requests: Option<u64>,
    #[serde(rename = "numRequestsTotal")]
    num_requests_total: Option<u64>,
    #[serde(rename = "numTokens")]
    num_tokens: Option<u64>,
}

// ── Sync Payload (sent to /api/sync/cursor) ──

#[derive(Debug, Serialize)]
struct CursorSyncPayload {
    user_hash: String,
    sync_secret: String,
    cursor_user: CursorUserPayload,
    usage_summary: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    usage_legacy: Option<CursorLegacyPayload>,
}

#[derive(Debug, Serialize)]
struct CursorUserPayload {
    #[serde(skip_serializing_if = "Option::is_none")]
    email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sub: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    picture: Option<String>,
}

#[derive(Debug, Serialize)]
struct CursorLegacyPayload {
    #[serde(rename = "numRequests")]
    #[serde(skip_serializing_if = "Option::is_none")]
    num_requests: Option<u64>,
    #[serde(rename = "numRequestsTotal")]
    #[serde(skip_serializing_if = "Option::is_none")]
    num_requests_total: Option<u64>,
    #[serde(rename = "numTokens")]
    #[serde(skip_serializing_if = "Option::is_none")]
    num_tokens: Option<u64>,
}

// ── Identity ──

fn ensure_cursor_identity(cursor: &mut CursorConfig) {
    if cursor.cursor_user_hash.is_none() {
        cursor.cursor_user_hash = Some(uuid::Uuid::new_v4().to_string());
        cursor.cursor_sync_secret = Some(uuid::Uuid::new_v4().to_string());
        info!("[cursor] Generated new Cursor identity");
    }
}

// ── Cookie Resolution ──

/// Resolved auth for Cursor API calls.
enum CursorAuth {
    /// Bearer token from Cursor IDE's state DB.
    BearerToken(String),
    /// Cookie header from browser or manual input.
    Cookie(String),
}

/// Resolve Cursor auth using the best available method.
/// Priority: Cursor IDE token > browser cookies > cached cookie > manual cookie.
fn resolve_auth(engine: &RankingEngine) -> Option<CursorAuth> {
    let cursor = &engine.config().cursor;

    // 1. Try reading JWT directly from Cursor IDE (works if Cursor is installed & logged in)
    if let Some(auth) = browser_cookies::import_cursor_auth() {
        info!(
            "[cursor] Got auth token from Cursor IDE (email={:?})",
            auth.email
        );
        return Some(CursorAuth::BearerToken(auth.access_token));
    }

    // 2. For manual mode, use the user-provided cookie
    if cursor.cookie_source == CursorCookieSource::Manual {
        return cursor.cookie.as_ref().filter(|c| !c.is_empty()).cloned().map(CursorAuth::Cookie);
    }

    // 3. Try browser cookie import
    if let Some(result) = browser_cookies::import_cursor_cookies() {
        info!(
            "[cursor] Auto-imported cookie from {} ({} bytes)",
            result.source,
            result.cookie_header.len()
        );
        return Some(CursorAuth::Cookie(result.cookie_header));
    }

    // 4. Fall back to cached cookie
    if let Some(ref cached) = cursor.cached_cookie {
        if !cached.is_empty() {
            info!("[cursor] Using cached cookie from previous import");
            return Some(CursorAuth::Cookie(cached.clone()));
        }
    }

    // 5. Fall back to manual cookie
    cursor.cookie.as_ref().filter(|c| !c.is_empty()).cloned().map(CursorAuth::Cookie)
}

// ── Cursor Fetch & Sync ──

/// Fetch Cursor usage data from cursor.com APIs using the stored cookie,
/// then sync it to ClaudeRank's /api/sync/cursor endpoint.
pub fn try_cursor_sync(
    ranking: &Arc<Mutex<RankingEngine>>,
    app: &tauri::AppHandle,
) {
    if !should_cursor_sync() {
        return;
    }

    let (auth, user_hash, sync_secret) = {
        let mut engine = match ranking.lock() {
            Ok(e) => e,
            Err(_) => return,
        };
        let cursor = &engine.config().cursor;
        if !cursor.enabled {
            return;
        }

        // Resolve auth (IDE token, browser cookies, or manual)
        let auth = match resolve_auth(&engine) {
            Some(a) => a,
            None => {
                warn!("[cursor] Cursor enabled but no auth available — is Cursor IDE installed and logged in?");
                return;
            }
        };

        let user_hash = cursor.cursor_user_hash.clone().unwrap_or_default();
        let sync_secret = cursor.cursor_sync_secret.clone().unwrap_or_default();
        if user_hash.is_empty() || sync_secret.is_empty() {
            warn!("[cursor] Missing cursor_user_hash or cursor_sync_secret");
            return;
        }

        // Cache cookie if we got one from browser import
        if let CursorAuth::Cookie(ref c) = auth {
            if cursor.cookie_source == CursorCookieSource::Auto {
                let mut config = engine.config().clone();
                config.cursor.cached_cookie = Some(c.clone());
                engine.update_config(config);
            }
        }

        (auth, user_hash, sync_secret)
    };

    let ranking_clone = Arc::clone(ranking);
    let app_handle = app.clone();

    tauri::async_runtime::spawn(async move {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());

        // Build auth header based on resolved auth type
        let auth_header = match &auth {
            CursorAuth::BearerToken(token) => ("Authorization".to_string(), format!("Bearer {}", token)),
            CursorAuth::Cookie(cookie) => ("Cookie".to_string(), cookie.clone()),
        };

        // 1. Fetch user info from /api/auth/me
        let user_info = match fetch_cursor_user(&client, &auth_header).await {
            Ok(info) => {
                info!("[cursor] Got user info: email={:?}", info.email);
                info
            }
            Err(e) => {
                warn!("[cursor] Failed to fetch user info: {}", e);
                // Cookie might be expired/invalid
                return;
            }
        };

        // 2. Fetch usage summary from /api/usage-summary
        let usage_summary = match fetch_cursor_usage_summary(&client, &auth_header).await {
            Ok(summary) => {
                info!(
                    "[cursor] Got usage summary: membership={:?}",
                    summary.membership_type
                );
                summary
            }
            Err(e) => {
                warn!("[cursor] Failed to fetch usage summary: {}", e);
                return;
            }
        };

        // 3. Fetch legacy usage from /api/usage?user=ID (optional)
        let legacy_usage = if let Some(ref sub) = user_info.sub {
            match fetch_cursor_legacy_usage(&client, &auth_header, sub).await {
                Ok(resp) => resp.gpt4,
                Err(e) => {
                    info!("[cursor] Legacy usage not available: {}", e);
                    None
                }
            }
        } else {
            None
        };

        // 4. Build and send sync payload to ClaudeRank
        let summary_json = serde_json::json!({
            "billingCycleStart": usage_summary.billing_cycle_start,
            "billingCycleEnd": usage_summary.billing_cycle_end,
            "membershipType": usage_summary.membership_type,
            "individualUsage": {
                "plan": usage_summary.individual_usage.as_ref().and_then(|u| {
                    u.plan.as_ref().map(|p| serde_json::json!({
                        "used": p.used,
                        "limit": p.limit,
                    }))
                }),
                "onDemand": usage_summary.individual_usage.as_ref().and_then(|u| {
                    u.on_demand.as_ref().map(|od| serde_json::json!({
                        "used": od.used,
                        "limit": od.limit,
                    }))
                }),
            },
        });

        let payload = CursorSyncPayload {
            user_hash: user_hash.clone(),
            sync_secret,
            cursor_user: CursorUserPayload {
                email: user_info.email.clone(),
                name: user_info.name.clone(),
                sub: user_info.sub.clone(),
                picture: user_info.picture.clone(),
            },
            usage_summary: summary_json,
            usage_legacy: legacy_usage.map(|l| CursorLegacyPayload {
                num_requests: l.num_requests,
                num_requests_total: l.num_requests_total,
                num_tokens: l.num_tokens,
            }),
        };

        let payload_json = match serde_json::to_string(&payload) {
            Ok(j) => j,
            Err(e) => {
                error!("[cursor] Failed to serialize sync payload: {}", e);
                return;
            }
        };

        let url = format!("{}/api/sync/cursor", ranking_api_base());
        info!(
            "[cursor] Sending sync to {} ({} bytes)",
            url,
            payload_json.len()
        );

        match client
            .post(&url)
            .header("Content-Type", "application/json")
            .body(payload_json)
            .send()
            .await
        {
            Ok(resp) => {
                if resp.status().is_success() {
                    if let Ok(data) = resp.json::<serde_json::Value>().await {
                        info!(
                            "[cursor] Sync OK: weighted={}, spend={}",
                            data.get("weighted_score")
                                .and_then(|v| v.as_f64())
                                .unwrap_or(0.0),
                            data.get("estimated_spend")
                                .and_then(|v| v.as_f64())
                                .unwrap_or(0.0),
                        );

                        mark_cursor_synced();

                        // Update local config with fetched account info
                        if let Ok(mut engine) = ranking_clone.lock() {
                            let mut config = engine.config().clone();
                            config.cursor.last_synced =
                                Some(chrono::Utc::now().to_rfc3339());
                            config.cursor.account_email = user_info.email;
                            config.cursor.membership_type =
                                usage_summary.membership_type;
                            engine.update_config(config);
                        }
                        let _ = app_handle.emit("cursor-sync-status", "ok");
                    }
                } else {
                    let status = resp.status();
                    let text = resp.text().await.unwrap_or_default();
                    warn!("[cursor] Sync failed: {} - {}", status, text);
                    let _ = app_handle.emit("cursor-sync-status", "error");
                }
            }
            Err(e) => {
                warn!("[cursor] Sync network error: {}", e);
                let _ = app_handle.emit("cursor-sync-status", "error");
            }
        }
    });
}

// ── Cursor API Fetch Helpers ──

/// Auth header as (header_name, header_value) — either ("Authorization", "Bearer ...") or ("Cookie", "...").
type AuthHeader = (String, String);

async fn fetch_cursor_user(
    client: &reqwest::Client,
    auth: &AuthHeader,
) -> Result<CursorUserInfo, String> {
    let resp = client
        .get("https://www.cursor.com/api/auth/me")
        .header(&auth.0, &auth.1)
        .send()
        .await
        .map_err(|e| format!("network: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    resp.json::<CursorUserInfo>()
        .await
        .map_err(|e| format!("parse: {}", e))
}

async fn fetch_cursor_usage_summary(
    client: &reqwest::Client,
    auth: &AuthHeader,
) -> Result<CursorUsageSummary, String> {
    let resp = client
        .get("https://www.cursor.com/api/usage-summary")
        .header(&auth.0, &auth.1)
        .send()
        .await
        .map_err(|e| format!("network: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    resp.json::<CursorUsageSummary>()
        .await
        .map_err(|e| format!("parse: {}", e))
}

async fn fetch_cursor_legacy_usage(
    client: &reqwest::Client,
    auth: &AuthHeader,
    user_id: &str,
) -> Result<CursorUsageResponse, String> {
    let url = format!("https://www.cursor.com/api/usage?user={}", user_id);
    let resp = client
        .get(&url)
        .header(&auth.0, &auth.1)
        .send()
        .await
        .map_err(|e| format!("network: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    resp.json::<CursorUsageResponse>()
        .await
        .map_err(|e| format!("parse: {}", e))
}

// ── Tauri Commands ──

#[derive(Debug, Serialize)]
pub struct CursorStatus {
    pub enabled: bool,
    pub cookie_source: String,
    pub has_cookie: bool,
    pub cookie_from: Option<String>,
    pub account_email: Option<String>,
    pub membership_type: Option<String>,
    pub last_synced: Option<String>,
}

#[tauri::command]
pub fn get_cursor_config(
    ranking: tauri::State<'_, Arc<Mutex<RankingEngine>>>,
) -> Result<CursorStatus, String> {
    let engine = ranking.lock().map_err(|e| e.to_string())?;
    let cursor = &engine.config().cursor;

    // Check if we have any usable auth (IDE token, browser cookie, or manual)
    let has_cookie = browser_cookies::import_cursor_auth().is_some()
        || match cursor.cookie_source {
            CursorCookieSource::Manual => cursor.cookie.as_ref().map_or(false, |c| !c.is_empty()),
            CursorCookieSource::Auto => {
                cursor.cached_cookie.as_ref().map_or(false, |c| !c.is_empty())
                    || browser_cookies::import_cursor_cookies().is_some()
            }
        };

    Ok(CursorStatus {
        enabled: cursor.enabled,
        cookie_source: match cursor.cookie_source {
            CursorCookieSource::Auto => "auto".to_string(),
            CursorCookieSource::Manual => "manual".to_string(),
        },
        has_cookie,
        cookie_from: cursor.cached_cookie_source.clone(),
        account_email: cursor.account_email.clone(),
        membership_type: cursor.membership_type.clone(),
        last_synced: cursor.last_synced.clone(),
    })
}

#[tauri::command]
pub fn set_cursor_cookie(
    cookie: String,
    ranking: tauri::State<'_, Arc<Mutex<RankingEngine>>>,
) -> Result<(), String> {
    let mut engine = ranking.lock().map_err(|e| e.to_string())?;
    let mut config = engine.config().clone();

    // Normalize: extract just the Cookie header value if user pasted a full cURL/header
    let normalized = normalize_cookie_header(&cookie);
    config.cursor.cookie = Some(normalized);
    config.cursor.cookie_source = CursorCookieSource::Manual;
    config.cursor.enabled = true;

    // Generate cursor identity if not already present
    ensure_cursor_identity(&mut config.cursor);

    engine.update_config(config);
    info!("[cursor] Manual cookie set and Cursor sync enabled");
    Ok(())
}

/// Enable Cursor with automatic browser cookie import.
#[tauri::command]
pub fn enable_cursor_auto(
    ranking: tauri::State<'_, Arc<Mutex<RankingEngine>>>,
) -> Result<CursorStatus, String> {
    let mut engine = ranking.lock().map_err(|e| e.to_string())?;
    let mut config = engine.config().clone();

    config.cursor.enabled = true;
    config.cursor.cookie_source = CursorCookieSource::Auto;
    ensure_cursor_identity(&mut config.cursor);

    // Try importing immediately to give feedback
    let import_result = browser_cookies::import_cursor_cookies();
    if let Some(ref result) = import_result {
        config.cursor.cached_cookie = Some(result.cookie_header.clone());
        config.cursor.cached_cookie_source = Some(result.source.clone());
        info!("[cursor] Auto-import found cookies from {}", result.source);
    }

    engine.update_config(config);

    let cursor = &engine.config().cursor;
    Ok(CursorStatus {
        enabled: true,
        cookie_source: "auto".to_string(),
        has_cookie: import_result.is_some(),
        cookie_from: import_result.map(|r| r.source),
        account_email: cursor.account_email.clone(),
        membership_type: cursor.membership_type.clone(),
        last_synced: cursor.last_synced.clone(),
    })
}

#[tauri::command]
pub fn set_cursor_enabled(
    enabled: bool,
    ranking: tauri::State<'_, Arc<Mutex<RankingEngine>>>,
) -> Result<(), String> {
    let mut engine = ranking.lock().map_err(|e| e.to_string())?;
    let mut config = engine.config().clone();
    config.cursor.enabled = enabled;
    engine.update_config(config);
    info!("[cursor] Cursor sync enabled={}", enabled);
    Ok(())
}

#[tauri::command]
pub fn disconnect_cursor(
    ranking: tauri::State<'_, Arc<Mutex<RankingEngine>>>,
) -> Result<(), String> {
    let mut engine = ranking.lock().map_err(|e| e.to_string())?;
    let mut config = engine.config().clone();
    config.cursor = CursorConfig::default();
    engine.update_config(config);
    info!("[cursor] Cursor disconnected");
    Ok(())
}

/// Trigger an immediate Cursor sync (bypasses the normal sync cycle).
#[tauri::command]
pub async fn force_cursor_sync(
    ranking: tauri::State<'_, Arc<Mutex<RankingEngine>>>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    info!("[cursor] Force Cursor sync triggered");
    // Reset throttle so sync runs immediately
    LAST_CURSOR_SYNC.store(0, Ordering::Relaxed);
    try_cursor_sync(&ranking.inner().clone(), &app);
    Ok(())
}

// ── Cookie Normalization ──

/// Extract the Cookie header value from various formats:
/// - Raw cookie string: "key1=val1; key2=val2"
/// - cURL header: `-H 'Cookie: key1=val1; key2=val2'`
/// - Wget: `--header='Cookie: key1=val1; key2=val2'`
fn normalize_cookie_header(input: &str) -> String {
    let trimmed = input.trim();

    // Try to extract from -H 'Cookie: ...' or -H "Cookie: ..."
    if let Some(pos) = trimmed.to_lowercase().find("cookie:") {
        let after = &trimmed[pos + 7..];
        let value = after.trim();
        // Strip trailing quote if present
        let value = value.trim_end_matches('\'').trim_end_matches('"');
        return value.to_string();
    }

    // Already a raw cookie string
    trimmed.to_string()
}
