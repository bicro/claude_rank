//! Reads Cursor session cookies from browser cookie stores on disk.
//!
//! Supports:
//! - Firefox: plain SQLite (no encryption)
//! - Chrome/Chromium: SQLite + AES-128-CBC decryption via macOS Keychain
//! - Safari: binary cookie format (macOS only, no Keychain needed)
//!
//! Looks for cookie names: WorkosCursorSessionToken,
//! __Secure-next-auth.session-token, next-auth.session-token
//! on domains: cursor.com, cursor.sh

use log::{info, warn};
use std::path::PathBuf;

/// Cookie names that indicate a valid Cursor session.
const SESSION_COOKIE_NAMES: &[&str] = &[
    "WorkosCursorSessionToken",
    "__Secure-next-auth.session-token",
    "next-auth.session-token",
];

/// Domains to match (suffix match, so ".cursor.com" matches "www.cursor.com").
const CURSOR_DOMAINS: &[&str] = &["cursor.com", "cursor.sh"];

/// A single cookie extracted from a browser.
#[derive(Debug, Clone)]
struct RawCookie {
    name: String,
    value: String,
    domain: String,
}

/// Result of attempting browser cookie import.
#[derive(Debug)]
pub struct CookieImportResult {
    /// The assembled Cookie header string.
    pub cookie_header: String,
    /// Which browser the cookies came from.
    pub source: String,
}

/// Result of reading Cursor auth directly from the Cursor IDE's state database.
#[derive(Debug)]
pub struct CursorAuthResult {
    pub access_token: String,
    pub email: Option<String>,
    pub membership_type: Option<String>,
}

/// Try to read Cursor auth token directly from the Cursor IDE's local state database.
/// This is the primary method — Cursor stores JWTs in a SQLite DB, not browser cookies.
pub fn import_cursor_auth() -> Option<CursorAuthResult> {
    info!("[browser-cookies] Attempting to read Cursor auth from IDE state...");

    let state_db = cursor_state_db_path()?;
    if !state_db.exists() {
        info!("[browser-cookies] Cursor IDE state DB not found at {:?}", state_db);
        return None;
    }

    match read_cursor_state_db(&state_db) {
        Some(result) => {
            info!(
                "[browser-cookies] Got Cursor auth: email={:?}, membership={:?}",
                result.email, result.membership_type
            );
            Some(result)
        }
        None => {
            info!("[browser-cookies] No auth tokens found in Cursor state DB");
            None
        }
    }
}

fn cursor_state_db_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| {
        #[cfg(target_os = "macos")]
        {
            h.join("Library/Application Support/Cursor/User/globalStorage/state.vscdb")
        }
        #[cfg(target_os = "linux")]
        {
            h.join(".config/Cursor/User/globalStorage/state.vscdb")
        }
        #[cfg(target_os = "windows")]
        {
            h.join("AppData/Roaming/Cursor/User/globalStorage/state.vscdb")
        }
    })
}

fn read_cursor_state_db(db_path: &PathBuf) -> Option<CursorAuthResult> {
    // Copy to temp to avoid lock issues (Cursor IDE may hold the lock)
    let temp_path = std::env::temp_dir().join("clauderank_cursor_state.vscdb");
    std::fs::copy(db_path, &temp_path).ok()?;

    let conn = rusqlite::Connection::open_with_flags(
        &temp_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .ok()?;

    let get_value = |key: &str| -> Option<String> {
        conn.query_row(
            "SELECT value FROM ItemTable WHERE key = ?1",
            [key],
            |row| row.get(0),
        )
        .ok()
    };

    let access_token = get_value("cursorAuth/accessToken")?;
    if access_token.is_empty() {
        let _ = std::fs::remove_file(&temp_path);
        return None;
    }

    let email = get_value("cursorAuth/cachedEmail");
    let membership_type = get_value("cursorAuth/stripeMembershipType");

    let _ = std::fs::remove_file(&temp_path);

    Some(CursorAuthResult {
        access_token,
        email,
        membership_type,
    })
}

/// Try to import Cursor session cookies from installed browsers.
/// Returns the first successful result, trying in order: Firefox, Chrome.
pub fn import_cursor_cookies() -> Option<CookieImportResult> {
    info!("[browser-cookies] Attempting to import Cursor session cookies from browsers...");

    // Firefox first (no Keychain prompt, most reliable)
    match try_firefox() {
        Some(result) => return Some(result),
        None => info!("[browser-cookies] No Cursor cookies found in Firefox"),
    }

    // Chrome (may trigger Keychain prompt on macOS)
    #[cfg(target_os = "macos")]
    match try_chrome() {
        Some(result) => return Some(result),
        None => info!("[browser-cookies] No Cursor cookies found in Chrome"),
    }

    warn!("[browser-cookies] No Cursor session cookies found in any browser");
    None
}

// ── Firefox ──────────────────────────────────────────────────────────────────

fn try_firefox() -> Option<CookieImportResult> {
    let profiles_dir = firefox_profiles_dir()?;
    if !profiles_dir.exists() {
        return None;
    }

    // Find profile directories matching *.default*
    let pattern = profiles_dir.join("*.default*").to_string_lossy().to_string();
    let mut cookies = Vec::new();

    for entry in glob::glob(&pattern).ok()?.flatten() {
        let db_path = entry.join("cookies.sqlite");
        if !db_path.exists() {
            continue;
        }
        info!("[browser-cookies] Found Firefox cookies at {:?}", db_path);
        match read_firefox_cookies(&db_path) {
            Ok(mut c) => cookies.append(&mut c),
            Err(e) => {
                warn!("[browser-cookies] Failed to read Firefox cookies: {}", e);
                continue;
            }
        }
    }

    build_cookie_header(cookies, "Firefox")
}

fn firefox_profiles_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| {
        #[cfg(target_os = "macos")]
        {
            h.join("Library/Application Support/Firefox/Profiles")
        }
        #[cfg(target_os = "linux")]
        {
            h.join(".mozilla/firefox")
        }
        #[cfg(target_os = "windows")]
        {
            h.join("AppData/Roaming/Mozilla/Firefox/Profiles")
        }
    })
}

fn read_firefox_cookies(db_path: &PathBuf) -> Result<Vec<RawCookie>, String> {
    // Firefox may have the database locked. Copy to a temp file to avoid locking issues.
    let temp_path = std::env::temp_dir().join("clauderank_ff_cookies.sqlite");
    std::fs::copy(db_path, &temp_path).map_err(|e| format!("copy: {}", e))?;

    let conn =
        rusqlite::Connection::open_with_flags(&temp_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e| format!("open: {}", e))?;

    let mut stmt = conn
        .prepare("SELECT host, name, value FROM moz_cookies WHERE value != ''")
        .map_err(|e| format!("prepare: {}", e))?;

    let cookies: Vec<RawCookie> = stmt
        .query_map([], |row| {
            Ok(RawCookie {
                domain: row.get::<_, String>(0)?,
                name: row.get::<_, String>(1)?,
                value: row.get::<_, String>(2)?,
            })
        })
        .map_err(|e| format!("query: {}", e))?
        .filter_map(|r| r.ok())
        .filter(|c| is_cursor_domain(&c.domain) && is_session_cookie(&c.name))
        .collect();

    // Clean up temp file
    let _ = std::fs::remove_file(&temp_path);

    Ok(cookies)
}

// ── Chrome (macOS only for now — requires Keychain) ──────────────────────────

#[cfg(target_os = "macos")]
fn try_chrome() -> Option<CookieImportResult> {
    let home = dirs::home_dir()?;
    let chrome_base = home.join("Library/Application Support/Google/Chrome");
    if !chrome_base.exists() {
        return None;
    }

    // Try Default profile, then numbered profiles
    let mut profile_dirs = vec![chrome_base.join("Default")];
    if let Ok(entries) = std::fs::read_dir(&chrome_base) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("Profile ") {
                profile_dirs.push(entry.path());
            }
        }
    }

    // Get Chrome Safe Storage password from Keychain
    let password = match get_chrome_safe_storage_password() {
        Some(p) => p,
        None => {
            info!("[browser-cookies] Chrome Safe Storage password not available");
            return None;
        }
    };

    let key = derive_chrome_key(&password);

    let mut cookies = Vec::new();
    for profile_dir in profile_dirs {
        // Try Network/Cookies first (newer Chrome), then Cookies (older Chrome)
        let db_path = if profile_dir.join("Network/Cookies").exists() {
            profile_dir.join("Network/Cookies")
        } else if profile_dir.join("Cookies").exists() {
            profile_dir.join("Cookies")
        } else {
            continue;
        };

        info!("[browser-cookies] Found Chrome cookies at {:?}", db_path);
        match read_chrome_cookies(&db_path, &key) {
            Ok(mut c) => cookies.append(&mut c),
            Err(e) => {
                warn!("[browser-cookies] Failed to read Chrome cookies: {}", e);
                continue;
            }
        }
    }

    build_cookie_header(cookies, "Chrome")
}

#[cfg(target_os = "macos")]
fn get_chrome_safe_storage_password() -> Option<String> {
    let output = std::process::Command::new("security")
        .args([
            "find-generic-password",
            "-s",
            "Chrome Safe Storage",
            "-w",
        ])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let password = String::from_utf8(output.stdout).ok()?.trim().to_string();
    if password.is_empty() {
        return None;
    }
    Some(password)
}

#[cfg(target_os = "macos")]
fn derive_chrome_key(password: &str) -> Vec<u8> {
    use hmac::Hmac;
    use sha1::Sha1;

    let salt = b"saltysalt";
    let iterations = 1003;
    let mut key = vec![0u8; 16]; // AES-128

    pbkdf2::pbkdf2::<Hmac<Sha1>>(password.as_bytes(), salt, iterations, &mut key)
        .expect("PBKDF2 derivation failed");

    key
}

#[cfg(target_os = "macos")]
fn decrypt_chrome_cookie(encrypted_value: &[u8], key: &[u8]) -> Option<String> {
    use aes::cipher::{BlockDecryptMut, KeyIvInit};
    type Aes128CbcDec = cbc::Decryptor<aes::Aes128>;

    // Chrome encrypted cookies start with "v10" (3 bytes)
    if encrypted_value.len() < 4 || &encrypted_value[..3] != b"v10" {
        return None;
    }

    let payload = &encrypted_value[3..];

    // IV is 16 bytes of 0x20 (space character)
    let iv = [0x20u8; 16];

    // Decrypt AES-128-CBC with PKCS7 padding
    let mut buf = payload.to_vec();
    let decrypted = Aes128CbcDec::new(key.into(), &iv.into())
        .decrypt_padded_mut::<aes::cipher::block_padding::Pkcs7>(&mut buf)
        .ok()?;

    String::from_utf8(decrypted.to_vec()).ok()
}

#[cfg(target_os = "macos")]
fn read_chrome_cookies(db_path: &PathBuf, key: &[u8]) -> Result<Vec<RawCookie>, String> {
    // Copy to avoid lock issues
    let temp_path = std::env::temp_dir().join("clauderank_chrome_cookies.sqlite");
    std::fs::copy(db_path, &temp_path).map_err(|e| format!("copy: {}", e))?;

    let conn =
        rusqlite::Connection::open_with_flags(&temp_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e| format!("open: {}", e))?;

    let mut stmt = conn
        .prepare(
            "SELECT host_key, name, value, encrypted_value FROM cookies",
        )
        .map_err(|e| format!("prepare: {}", e))?;

    let cookies: Vec<RawCookie> = stmt
        .query_map([], |row| {
            let domain: String = row.get(0)?;
            let name: String = row.get(1)?;
            let plain_value: String = row.get(2)?;
            let encrypted_value: Vec<u8> = row.get(3)?;

            Ok((domain, name, plain_value, encrypted_value))
        })
        .map_err(|e| format!("query: {}", e))?
        .filter_map(|r| r.ok())
        .filter(|(domain, name, _, _)| is_cursor_domain(domain) && is_session_cookie(name))
        .filter_map(|(domain, name, plain_value, encrypted_value)| {
            // Use plain value if available, otherwise decrypt
            let value = if !plain_value.is_empty() {
                plain_value
            } else if !encrypted_value.is_empty() {
                decrypt_chrome_cookie(&encrypted_value, key)?
            } else {
                return None;
            };

            if value.is_empty() {
                return None;
            }

            Some(RawCookie {
                domain,
                name,
                value,
            })
        })
        .collect();

    let _ = std::fs::remove_file(&temp_path);

    Ok(cookies)
}

// ── Helpers ──────────────────────────────────────────────────────────────────

fn is_cursor_domain(domain: &str) -> bool {
    let normalized = domain.trim_start_matches('.');
    CURSOR_DOMAINS.iter().any(|d| {
        normalized == *d || normalized.ends_with(&format!(".{}", d))
    })
}

fn is_session_cookie(name: &str) -> bool {
    SESSION_COOKIE_NAMES.iter().any(|n| name == *n)
}

fn build_cookie_header(cookies: Vec<RawCookie>, source: &str) -> Option<CookieImportResult> {
    if cookies.is_empty() {
        return None;
    }

    // Deduplicate by name, keeping the last occurrence
    let mut seen = std::collections::HashMap::new();
    for cookie in &cookies {
        seen.insert(cookie.name.clone(), cookie.value.clone());
    }

    let header = seen
        .iter()
        .map(|(name, value)| format!("{}={}", name, value))
        .collect::<Vec<_>>()
        .join("; ");

    info!(
        "[browser-cookies] Imported {} Cursor cookies from {} (header {} bytes)",
        seen.len(),
        source,
        header.len()
    );

    Some(CookieImportResult {
        cookie_header: header,
        source: source.to_string(),
    })
}
