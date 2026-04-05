// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod stats;
mod tray_render;
mod updater;

use serde::Serialize;
use serde_json::json;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder};
use tauri::{command, AppHandle, Emitter, Listener, Manager};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_updater::UpdaterExt;
use log::{error, info, warn};
use serde::Deserialize;

// macOS-specific imports
#[cfg(target_os = "macos")]
use objc2::rc::Retained;
#[cfg(target_os = "macos")]
use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior};

// Windows-specific imports
#[cfg(target_os = "windows")]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(target_os = "windows")]
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
#[cfg(target_os = "windows")]
use windows::Win32::UI::WindowsAndMessaging::{
    SetWindowPos, SetForegroundWindow, ShowWindow,
    HWND_TOPMOST, WINDOWPOS, SW_RESTORE,
    SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
    WM_ENTERSIZEMOVE, WM_EXITSIZEMOVE, WM_SIZING, WM_WINDOWPOSCHANGING,
    WM_NCACTIVATE, WM_NCPAINT, WM_NCCALCSIZE, WM_NCDESTROY,
};
#[cfg(target_os = "windows")]
use windows::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};

/// Tracks whether the user is in a move/resize operation (between WM_ENTERSIZEMOVE and WM_EXITSIZEMOVE).
#[cfg(target_os = "windows")]
static IN_SIZE_MOVE: AtomicBool = AtomicBool::new(false);
/// Tracks whether the current move/resize is a border-drag resize (WM_SIZING received).
#[cfg(target_os = "windows")]
static IS_USER_SIZING: AtomicBool = AtomicBool::new(false);

// ============ Leaderboard types ============

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct LeaderboardEntry {
    pub username: String,
    pub points: u64,
    pub games_played: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct RankingLeaderboardResponse {
    entries: Vec<RankingLeaderboardEntry>,
    total_count: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct RankingLeaderboardEntry {
    rank: u64,
    user_hash: String,
    username: Option<String>,
    value: f64,
}

fn ranking_api_base() -> String {
    std::env::var("RANKING_API_BASE")
        .unwrap_or_else(|_| "https://clauderank.com".to_string())
}

fn widget_base() -> String {
    std::env::var("WIDGET_BASE")
        .unwrap_or_else(|_| "https://clauderank.com".to_string())
}

#[command]
fn get_widget_base() -> String {
    widget_base()
}

#[command]
async fn get_leaderboard() -> Result<Vec<LeaderboardEntry>, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let url = format!("{}/api/leaderboard/weighted?scope=individual&limit=50", ranking_api_base());
    info!("[get_leaderboard] Fetching from ranking API: {}", url);

    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| {
            warn!("[get_leaderboard] Request error: {}", e);
            format!("Failed to fetch leaderboard: {}", e)
        })?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        warn!("[get_leaderboard] Non-success status {} body {}", status, text);
        return Err(format!("Failed to fetch leaderboard: {} - {}", status, text));
    }

    let data: RankingLeaderboardResponse = response
        .json()
        .await
        .map_err(|e| {
            warn!("[get_leaderboard] Failed to parse response: {}", e);
            format!("Failed to parse leaderboard response: {}", e)
        })?;

    let entries: Vec<LeaderboardEntry> = data.entries.iter().map(|e| LeaderboardEntry {
        username: e.username.clone().unwrap_or_else(|| format!("User #{}", e.rank)),
        points: e.value as u64,
        games_played: 0,
    }).collect();

    info!("[get_leaderboard] Retrieved {} entries from ranking API", entries.len());
    Ok(entries)
}

// ============ Tauri Commands ============

#[command]
fn log_from_frontend(level: String, message: String) {
    match level.as_str() {
        "error" => error!("[Frontend] {}", message),
        "warn" => warn!("[Frontend] {}", message),
        _ => info!("[Frontend] {}", message),
    }
}

#[tauri::command]
fn quit_app() {
    std::process::exit(0);
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    open::that(&url).map_err(|e| format!("Failed to open URL: {}", e))
}

#[tauri::command]
fn get_autostart_enabled(app: AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    let autostart_manager = app.autolaunch();
    autostart_manager
        .is_enabled()
        .map_err(|e| format!("Failed to check autostart status: {}", e))
}

#[tauri::command]
fn set_autostart_enabled(app: AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let autostart_manager = app.autolaunch();
    if enabled {
        autostart_manager
            .enable()
            .map_err(|e| format!("Failed to enable autostart: {}", e))
    } else {
        autostart_manager
            .disable()
            .map_err(|e| format!("Failed to disable autostart: {}", e))
    }
}

#[command]
async fn open_logs_folder(app: tauri::AppHandle) -> Result<(), String> {
    let log_dir = app.path().app_log_dir()
        .map_err(|e| format!("Failed to get log directory: {}", e))?;

    std::fs::create_dir_all(&log_dir)
        .map_err(|e| format!("Failed to create log directory: {}", e))?;

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&log_dir)
            .spawn()
            .map_err(|e| format!("Failed to open log directory: {}", e))?;
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&log_dir)
            .spawn()
            .map_err(|e| format!("Failed to open log directory: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&log_dir)
            .spawn()
            .map_err(|e| format!("Failed to open log directory: {}", e))?;
    }

    Ok(())
}

#[command]
fn notify_drag_start(state: tauri::State<'_, AppState>) {
    *state.last_drag_start.lock().unwrap() = std::time::Instant::now();
}

#[command]
fn is_debug_mode() -> bool {
    cfg!(debug_assertions)
}

#[command]
async fn open_overlay_devtools(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = get_overlay_window(&app) {
        window.open_devtools();
        Ok(())
    } else {
        Err("Overlay window not found".to_string())
    }
}

// ============ App State ============

pub struct AppState {
    pub overlay_visible: Mutex<bool>,
    pub overlay_pinned: Mutex<bool>,
    pub last_programmatic_position: Mutex<std::time::Instant>,
    pub last_drag_start: Mutex<std::time::Instant>,
    pub toggle_menu_item: Mutex<Option<MenuItem<tauri::Wry>>>,
    pub update_menu_item: Mutex<Option<MenuItem<tauri::Wry>>>,
    pub tray_icon: Mutex<Option<TrayIcon<tauri::Wry>>>,
    pub tray_icon_base: Mutex<image::RgbaImage>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            overlay_visible: Mutex::new(false),
            overlay_pinned: Mutex::new(false),
            last_programmatic_position: Mutex::new(std::time::Instant::now()),
            last_drag_start: Mutex::new(std::time::Instant::now() - std::time::Duration::from_secs(60)),
            toggle_menu_item: Mutex::new(None),
            update_menu_item: Mutex::new(None),
            tray_icon: Mutex::new(None),
            tray_icon_base: Mutex::new(image::RgbaImage::new(1, 1)),
        }
    }
}

// ============ Window Prefs Persistence ============

#[derive(Debug, Clone, Serialize, Deserialize)]
struct MonitorPosition {
    x: f64,
    y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WindowPrefs {
    width: u32,
    height: u32,
    /// Per-monitor saved positions, keyed by monitor_key()
    #[serde(default)]
    positions: HashMap<String, MonitorPosition>,
    /// App version that wrote these prefs (cleared on upgrade/reinstall)
    #[serde(default)]
    app_version: String,
}

/// Stable key for a monitor: name if available, otherwise origin coordinates.
fn monitor_key(monitor: &tauri::Monitor) -> String {
    if let Some(name) = monitor.name() {
        if !name.is_empty() {
            return name.to_string();
        }
    }
    let p = monitor.position();
    format!("{}x{}", p.x, p.y)
}

/// Find which monitor contains the given physical point.
fn find_monitor_at(monitors: &[tauri::Monitor], px: f64, py: f64) -> Option<&tauri::Monitor> {
    monitors.iter().find(|m| {
        let mp = m.position();
        let ms = m.size();
        let mx = mp.x as f64;
        let my = mp.y as f64;
        let mw = ms.width as f64;
        let mh = ms.height as f64;
        px >= mx && px < mx + mw && py >= my && py < my + mh
    })
}

fn window_prefs_path() -> PathBuf {
    let dir = dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".ClaudeRank");
    std::fs::create_dir_all(&dir).ok();
    dir.join("window_prefs.json")
}

fn load_window_prefs() -> Option<WindowPrefs> {
    let path = window_prefs_path();
    let data = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str(&data).ok()
}

fn save_window_prefs(prefs: &WindowPrefs) {
    let path = window_prefs_path();
    if let Ok(json) = serde_json::to_string_pretty(prefs) {
        if let Err(e) = std::fs::write(&path, json) {
            error!("[window_prefs] Failed to save: {}", e);
        }
    }
}

// ============ Overlay Window ============

#[cfg(target_os = "macos")]
fn configure_overlay(window: &tauri::WebviewWindow) -> Result<(), String> {
    window
        .with_webview(|webview| unsafe {
            let ns_window_ptr = webview.ns_window();
            let ns_window: Retained<NSWindow> =
                Retained::retain(ns_window_ptr as *mut NSWindow).unwrap();

            let behavior = NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::FullScreenAuxiliary;
            ns_window.setCollectionBehavior(behavior);
            ns_window.setLevel(1000);
        })
        .map_err(|e| format!("Failed to configure overlay: {}", e))?;
    Ok(())
}

#[cfg(target_os = "windows")]
const OVERLAY_SUBCLASS_ID: usize = 1;

#[cfg(target_os = "windows")]
unsafe extern "system" fn overlay_subclass_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _uidsubclass: usize,
    _dwrefdata: usize,
) -> LRESULT {
    match msg {
        x if x == WM_ENTERSIZEMOVE => {
            IN_SIZE_MOVE.store(true, Ordering::SeqCst);
            IS_USER_SIZING.store(false, Ordering::SeqCst);
            DefSubclassProc(hwnd, msg, wparam, lparam)
        }
        x if x == WM_EXITSIZEMOVE => {
            IN_SIZE_MOVE.store(false, Ordering::SeqCst);
            IS_USER_SIZING.store(false, Ordering::SeqCst);
            DefSubclassProc(hwnd, msg, wparam, lparam)
        }
        x if x == WM_SIZING => {
            // WM_SIZING is only sent during border-drag resize, not during move/snap
            IS_USER_SIZING.store(true, Ordering::SeqCst);
            DefSubclassProc(hwnd, msg, wparam, lparam)
        }
        x if x == WM_WINDOWPOSCHANGING => {
            // Block snap-triggered resizes: if we're in a move operation (not a
            // border-drag resize), prevent Windows from changing the window size.
            if IN_SIZE_MOVE.load(Ordering::SeqCst) && !IS_USER_SIZING.load(Ordering::SeqCst) {
                let wp = &mut *(lparam.0 as *mut WINDOWPOS);
                if !wp.flags.contains(SWP_NOSIZE) {
                    wp.flags |= SWP_NOSIZE;
                }
            }
            DefSubclassProc(hwnd, msg, wparam, lparam)
        }
        x if x == WM_NCACTIVATE => LRESULT(1),
        x if x == WM_NCPAINT => LRESULT(0),
        x if x == WM_NCCALCSIZE => {
            if wparam.0 != 0 {
                return LRESULT(0);
            }
            DefSubclassProc(hwnd, msg, wparam, lparam)
        }
        x if x == WM_NCDESTROY => {
            let _ = RemoveWindowSubclass(hwnd, Some(overlay_subclass_proc), OVERLAY_SUBCLASS_ID);
            DefSubclassProc(hwnd, msg, wparam, lparam)
        }
        _ => DefSubclassProc(hwnd, msg, wparam, lparam),
    }
}

#[cfg(target_os = "windows")]
fn configure_overlay(window: &tauri::WebviewWindow) -> Result<(), String> {
    let hwnd = window
        .hwnd()
        .map_err(|e| format!("Failed to get HWND: {}", e))?;

    unsafe {
        SetWindowPos(
            HWND(hwnd.0),
            HWND_TOPMOST,
            0, 0, 0, 0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        )
        .map_err(|e| format!("SetWindowPos failed: {}", e))?;

        let result = SetWindowSubclass(
            HWND(hwnd.0),
            Some(overlay_subclass_proc),
            OVERLAY_SUBCLASS_ID,
            0,
        );

        if !result.as_bool() {
            warn!("Failed to install window subclass for overlay");
        } else {
            info!("Successfully installed overlay window subclass");
        }
    }

    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn configure_overlay(_window: &tauri::WebviewWindow) -> Result<(), String> {
    Ok(())
}

/// Convert a `dpi::Position` to logical (f64) coordinates.
fn position_to_logical(pos: &tauri::Position, scale: f64) -> (f64, f64) {
    match pos {
        tauri::Position::Logical(l) => (l.x, l.y),
        tauri::Position::Physical(p) => (p.x as f64 / scale, p.y as f64 / scale),
    }
}

/// Convert a `dpi::Size` to logical (f64) dimensions.
fn size_to_logical(s: &tauri::Size, scale: f64) -> (f64, f64) {
    match s {
        tauri::Size::Logical(l) => (l.width, l.height),
        tauri::Size::Physical(p) => (p.width as f64 / scale, p.height as f64 / scale),
    }
}

/// Position the overlay window anchored below the tray icon (macOS popover style).
///
/// All math is done in **logical** coordinates to avoid Retina scaling bugs.
///
/// Priority:
/// 1. Saved per-monitor position from user drag (if target monitor has one)
/// 2. Below tray icon (queried from stored TrayIcon handle)
/// 3. Bottom-right fallback
fn position_overlay_window(window: &tauri::WebviewWindow, app: &AppHandle) {
    let state = app.state::<AppState>();
    *state.last_programmatic_position.lock().unwrap() = std::time::Instant::now();

    // Get scale factor for coordinate conversions
    let scale = window
        .scale_factor()
        .unwrap_or(1.0);

    // Restore saved size (logical pixels) or apply defaults
    let prefs = load_window_prefs();
    let (restore_w, restore_h) = if let Some(ref prefs) = prefs {
        (prefs.width as f64, prefs.height as f64)
    } else {
        (380.0, 480.0)
    };
    let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize {
        width: restore_w,
        height: restore_h,
    }));

    // Determine which monitor the tray icon is on (used for saved-position lookup & anchoring)
    let tray_rect = state
        .tray_icon
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|t| t.rect().ok().flatten());

    // If pinned (user dragged), restore saved position; otherwise skip to tray-icon positioning
    let pinned = *state.overlay_pinned.lock().unwrap();
    if pinned {
      if let Some(ref prefs) = prefs {
        if !prefs.positions.is_empty() {
            if let Ok(monitors) = window.available_monitors() {
                // Target monitor = monitor containing the tray icon, or primary
                let target_mon = tray_rect
                    .as_ref()
                    .and_then(|rect| {
                        let (tx, ty) = position_to_logical(&rect.position, scale);
                        monitors.iter().find(|m| {
                            let mp = m.position();
                            let ms = m.size();
                            let mx = mp.x as f64 / scale;
                            let my = mp.y as f64 / scale;
                            let mw = ms.width as f64 / scale;
                            let mh = ms.height as f64 / scale;
                            tx >= mx && tx < mx + mw && ty >= my && ty < my + mh
                        })
                    })
                    .or_else(|| monitors.first());

                if let Some(mon) = target_mon {
                    let key = monitor_key(mon);
                    if let Some(saved) = prefs.positions.get(&key) {
                        // Verify the saved position still lands on a real monitor
                        if find_monitor_at(&monitors, saved.x, saved.y).is_some() {
                            let _ = window.set_position(tauri::Position::Physical(
                                tauri::PhysicalPosition { x: saved.x as i32, y: saved.y as i32 },
                            ));
                            info!("[position] Restored saved position for monitor '{}' ({:.0}, {:.0})", key, saved.x, saved.y);
                            return;
                        }
                    }
                }
            }
        }
      }
    }

    // Try to position below tray icon
    if let Some(rect) = tray_rect {
        let (tray_x, tray_y) = position_to_logical(&rect.position, scale);
        let (tray_w, tray_h) = size_to_logical(&rect.size, scale);

        if let Ok(window_phys) = window.outer_size() {
            let ww = window_phys.width as f64 / scale;
            let wh = window_phys.height as f64 / scale;

            // Center horizontally under the tray icon, place directly below it
            let mut x = tray_x + (tray_w / 2.0) - (ww / 2.0);
            #[allow(unused_assignments)]
            let mut y = tray_y + tray_h;

            // On non-macOS, tray is at bottom — place window above the icon
            #[cfg(not(target_os = "macos"))]
            {
                y = tray_y - wh;
            }

            // Clamp to screen bounds using the monitor the tray is on
            if let Ok(monitors) = window.available_monitors() {
                // Find the monitor that contains the tray icon
                let tray_monitor = monitors.iter().find(|m| {
                    let mp = m.position();
                    let ms = m.size();
                    let mx = mp.x as f64 / scale;
                    let my = mp.y as f64 / scale;
                    let mw = ms.width as f64 / scale;
                    let mh = ms.height as f64 / scale;
                    tray_x >= mx && tray_x < mx + mw && tray_y >= my && tray_y < my + mh
                });

                if let Some(monitor) = tray_monitor {
                    let sp = monitor.position();
                    let ss = monitor.size();
                    let sx = sp.x as f64 / scale;
                    let sy = sp.y as f64 / scale;
                    let sw = ss.width as f64 / scale;
                    let sh = ss.height as f64 / scale;
                    x = x.max(sx).min(sx + sw - ww);
                    y = y.max(sy).min(sy + sh - wh);

                    let _ = window.set_position(tauri::Position::Logical(tauri::LogicalPosition {
                        x,
                        y,
                    }));
                    info!("[position] Anchored below tray icon ({:.0}, {:.0}) scale={}", x, y, scale);
                    return;
                }
            }
        }
    }

    // Fallback: bottom-right of screen
    if let Ok(Some(monitor)) = window.current_monitor() {
        let ss = monitor.size();
        let sp = monitor.position();
        if let Ok(window_phys) = window.outer_size() {
            let sx = sp.x as f64 / scale;
            let sy = sp.y as f64 / scale;
            let sw = ss.width as f64 / scale;
            let sh = ss.height as f64 / scale;
            let ww = window_phys.width as f64 / scale;
            let wh = window_phys.height as f64 / scale;
            let x = sx + sw - ww;
            let y = sy + sh - wh;
            let _ = window.set_position(tauri::Position::Logical(tauri::LogicalPosition { x, y }));
            info!("[position] Bottom-right fallback ({:.0}, {:.0})", x, y);
        }
    }
}

fn ensure_overlay_window(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
    if let Some(window) = app.get_webview_window("overlay") {
        return Ok(window);
    }

    let width = 380.0;
    let height = 480.0;

    let window = tauri::WebviewWindowBuilder::new(
        app,
        "overlay",
        tauri::WebviewUrl::App("overlay.html".into()),
    )
    .initialization_script_for_all_frames(r#"
        document.addEventListener('DOMContentLoaded', function() {
            var panel = document.querySelector('.panel');
            if (!panel || window.parent === window) return;

            // Inject <style> with !important — robust against any remote CSS
            var s = document.createElement('style');
            s.textContent =
                'html, body { height: auto !important; min-height: 0 !important; overflow: hidden !important; }' +
                '.panel { min-height: 0 !important; height: auto !important; box-shadow: none !important; padding-bottom: 12px !important; }' +
                '.copy-feedback { position: absolute !important; }';
            document.head.appendChild(s);

            function notifyHeight() {
                window.parent.postMessage({type: 'resize', height: panel.offsetHeight}, '*');
            }
            new ResizeObserver(function() { notifyHeight(); }).observe(panel);
            setTimeout(notifyHeight, 100);
            setTimeout(notifyHeight, 500);
        });
    "#)
    .title("ClaudeRank")
    .visible(false)
    .transparent(true)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .inner_size(width, height)
    .resizable(true)
    .build()
    .map_err(|e| format!("Failed to create overlay window: {}", e))?;

    // Persist window size and per-monitor position on resize/move
    let app_for_events = app.clone();
    window.on_window_event(move |event| {
        match event {
            tauri::WindowEvent::Resized(size) => {
                if size.width > 0 && size.height > 0 {
                    let scale = app_for_events.get_webview_window("overlay")
                        .and_then(|w| w.scale_factor().ok())
                        .unwrap_or(1.0);
                    let logical_w = (size.width as f64 / scale).round() as u32;
                    let logical_h = (size.height as f64 / scale).round() as u32;
                    let mut prefs = load_window_prefs().unwrap_or(WindowPrefs {
                        width: logical_w,
                        height: logical_h,
                        positions: HashMap::new(),
                        app_version: String::new(),
                    });
                    prefs.width = logical_w;
                    prefs.height = logical_h;
                    prefs.app_version = app_for_events.config().version.clone().unwrap_or_default();
                    save_window_prefs(&prefs);
                }
            }
            tauri::WindowEvent::Moved(pos) => {
                if let Some(win) = app_for_events.get_webview_window("overlay") {
                    if let Ok(monitors) = win.available_monitors() {
                        if let Some(mon) = find_monitor_at(&monitors, pos.x as f64, pos.y as f64) {
                            let key = monitor_key(mon);
                            let mut prefs = load_window_prefs().unwrap_or(WindowPrefs {
                                width: 380,
                                height: 480,
                                positions: HashMap::new(),
                                app_version: String::new(),
                            });
                            prefs.positions.insert(key, MonitorPosition {
                                x: pos.x as f64,
                                y: pos.y as f64,
                            });
                            prefs.app_version = app_for_events.config().version.clone().unwrap_or_default();
                            save_window_prefs(&prefs);
                        }
                    }
                }
                // Detect user drag: if the move happened well after the last programmatic position call
                let state = app_for_events.state::<AppState>();
                let elapsed = state.last_programmatic_position.lock().unwrap().elapsed();
                if elapsed > std::time::Duration::from_millis(500) {
                    *state.overlay_pinned.lock().unwrap() = true;
                }
            }
            tauri::WindowEvent::Focused(false) => {
                let state = app_for_events.state::<AppState>();
                let pinned = *state.overlay_pinned.lock().unwrap();
                // Don't auto-hide if the user is dragging (Windows loses focus during drag)
                let drag_elapsed = state.last_drag_start.lock().unwrap().elapsed();
                let is_dragging = drag_elapsed < std::time::Duration::from_secs(2);
                if !pinned && !is_dragging && *state.overlay_visible.lock().unwrap() {
                    *state.overlay_visible.lock().unwrap() = false;
                    let _ = app_for_events.emit("overlay-visibility-changed", serde_json::json!({ "visible": false }));
                    if let Some(menu_item) = state.toggle_menu_item.lock().unwrap().as_ref() {
                        let _ = menu_item.set_text("Show Widget");
                    }
                    // Safety: force-hide after 300ms
                    let app_clone = app_for_events.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(300));
                        if let Some(window) = app_clone.get_webview_window("overlay") {
                            let _ = window.hide();
                        }
                    });
                }
            }
            _ => {}
        }
    });

    Ok(window)
}

fn get_overlay_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    app.get_webview_window("overlay")
}

async fn do_show_overlay(
    app: AppHandle,
    state: &tauri::State<'_, AppState>,
) -> Result<(), String> {
    *state.overlay_pinned.lock().unwrap() = false;
    let window = ensure_overlay_window(&app)?;
    configure_overlay(&window)?;
    position_overlay_window(&window, &app);

    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;

    *state.overlay_visible.lock().unwrap() = true;

    if let Some(menu_item) = state.toggle_menu_item.lock().unwrap().as_ref() {
        let _ = menu_item.set_text("Hide Widget");
    }

    let _ = app.emit("overlay-visibility-changed", json!({ "visible": true }));
    Ok(())
}

async fn do_hide_overlay(
    app: AppHandle,
    state: &tauri::State<'_, AppState>,
) -> Result<(), String> {
    *state.overlay_pinned.lock().unwrap() = false;
    *state.overlay_visible.lock().unwrap() = false;

    if let Some(menu_item) = state.toggle_menu_item.lock().unwrap().as_ref() {
        let _ = menu_item.set_text("Show Widget");
    }

    let _ = app.emit("overlay-visibility-changed", json!({ "visible": false }));

    // Safety: force-hide after 300ms if frontend didn't call complete_hide
    let app_clone = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(300));
        if let Some(window) = app_clone.get_webview_window("overlay") {
            let _ = window.hide();
        }
    });
    Ok(())
}

#[command]
async fn complete_hide(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("overlay") {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[command]
async fn show_overlay(app: AppHandle, state: tauri::State<'_, AppState>) -> Result<(), String> {
    do_show_overlay(app, &state).await
}

#[command]
async fn hide_overlay(app: AppHandle, state: tauri::State<'_, AppState>) -> Result<(), String> {
    do_hide_overlay(app, &state).await
}

#[command]
async fn toggle_overlay(app: AppHandle, state: tauri::State<'_, AppState>) -> Result<bool, String> {
    let is_visible = *state.overlay_visible.lock().unwrap();

    if is_visible {
        hide_overlay(app, state).await?;
        Ok(false)
    } else {
        show_overlay(app, state).await?;
        Ok(true)
    }
}

fn toggle_overlay_sync(app: &AppHandle) {
    let state = app.state::<AppState>();
    let is_visible = *state.overlay_visible.lock().unwrap();

    if is_visible {
        *state.overlay_pinned.lock().unwrap() = false;
        *state.overlay_visible.lock().unwrap() = false;
        let _ = app.emit("overlay-visibility-changed", json!({ "visible": false }));

        if let Some(menu_item) = state.toggle_menu_item.lock().unwrap().as_ref() {
            let _ = menu_item.set_text("Show Widget");
        }

        // Safety: force-hide after 300ms
        let app_clone = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(300));
            if let Some(window) = app_clone.get_webview_window("overlay") {
                let _ = window.hide();
            }
        });
    } else if let Ok(window) = ensure_overlay_window(app) {
        *state.overlay_pinned.lock().unwrap() = false;
        let _ = configure_overlay(&window);
        position_overlay_window(&window, app);

        let _ = window.show();
        let _ = window.set_focus();
        *state.overlay_visible.lock().unwrap() = true;
        let _ = app.emit("overlay-visibility-changed", json!({ "visible": true }));

        if let Some(menu_item) = state.toggle_menu_item.lock().unwrap().as_ref() {
            let _ = menu_item.set_text("Hide Widget");
        }
    }
}

fn show_overlay_sync(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    *state.overlay_pinned.lock().unwrap() = false;

    let window = ensure_overlay_window(app)?;
    configure_overlay(&window)?;
    position_overlay_window(&window, app);

    let _ = window.show();
    let _ = window.set_focus();

    // On Windows, Tauri's set_focus() may not be enough to bring a background
    // app to the foreground (e.g. when activated via deep link from browser).
    // Use Win32 APIs directly to force the window forward.
    #[cfg(target_os = "windows")]
    {
        if let Ok(hwnd) = window.hwnd() {
            unsafe {
                let _ = ShowWindow(HWND(hwnd.0), SW_RESTORE);
                let _ = SetForegroundWindow(HWND(hwnd.0));
            }
        }
    }

    *state.overlay_visible.lock().unwrap() = true;

    let _ = app.emit("overlay-visibility-changed", json!({ "visible": true }));
    Ok(())
}

#[command]
async fn get_overlay_visible(state: tauri::State<'_, AppState>) -> Result<bool, String> {
    Ok(*state.overlay_visible.lock().unwrap())
}

#[command]
fn reload_overlay(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("overlay") {
        window.eval("location.reload()")
            .map_err(|e| format!("Failed to reload overlay: {}", e))
    } else {
        Ok(())
    }
}

#[command]
fn copy_image_to_clipboard(image_base64: String) -> Result<(), String> {
    use arboard::{Clipboard, ImageData};
    use base64::Engine;

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&image_base64)
        .map_err(|e| format!("Base64 decode error: {}", e))?;
    let img = image::load_from_memory_with_format(&bytes, image::ImageFormat::Png)
        .map_err(|e| format!("PNG decode error: {}", e))?;
    let rgba = img.to_rgba8();
    let (w, h) = (rgba.width() as usize, rgba.height() as usize);
    let mut clipboard = Clipboard::new().map_err(|e| format!("Clipboard error: {}", e))?;
    clipboard
        .set_image(ImageData {
            width: w,
            height: h,
            bytes: rgba.into_raw().into(),
        })
        .map_err(|e| format!("Clipboard write error: {}", e))?;
    Ok(())
}

// ============ Env ============

fn load_dotenv() {
    // Walk up from cwd to find .env.local/.env (cwd is desktop/src-tauri/)
    let mut dirs: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(mut dir) = std::env::current_dir() {
        loop {
            dirs.push(dir.clone());
            match dir.parent() {
                Some(p) => dir = p.to_path_buf(),
                None => break,
            }
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            dirs.push(parent.to_path_buf());
        }
    }
    // Prefer .env.local over .env; first match wins
    let filenames = [".env.local", ".env"];
    for dir in &dirs {
        for name in &filenames {
            let path = dir.join(name);
            if path.exists() {
                eprintln!("[load_dotenv] loading {}", path.display());
                if let Ok(content) = std::fs::read_to_string(&path) {
                    for line in content.lines() {
                        let line = line.trim();
                        if line.is_empty() || line.starts_with('#') {
                            continue;
                        }
                        if let Some((key, value)) = line.split_once('=') {
                            std::env::set_var(key.trim(), value.trim());
                        }
                    }
                }
                return;
            }
        }
    }
}

// ============ Main ============

fn main() {
    // Load .env file if present (for local dev)
    load_dotenv();

    let builder = tauri::Builder::default();

    let stats_metrics = Arc::new(Mutex::new(stats::metrics::MetricsEngine::new()));
    let stats_points = Arc::new(Mutex::new(stats::points::PointsEngine::new()));
    let stats_ranking = Arc::new(Mutex::new(stats::ranking::RankingEngine::new()));
    let stats_metrics_setup = Arc::clone(&stats_metrics);
    let stats_points_setup = Arc::clone(&stats_points);
    let stats_ranking_setup = Arc::clone(&stats_ranking);

    builder
        .manage(AppState::default())
        .manage(Arc::clone(&stats_metrics))
        .manage(Arc::clone(&stats_points))
        .manage(Arc::clone(&stats_ranking))
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            info!("=== ClaudeRank Widget Starting ===");

            // Create tray menu
            let version = app.config().version.clone().unwrap_or_default();
            let version_item = MenuItem::with_id(
                app,
                "version",
                format!("ClaudeRank v{}", version),
                false,
                None::<&str>,
            )?;
            let toggle_item =
                MenuItem::with_id(app, "toggle", "Show Widget", true, None::<&str>)?;
            let reset_item =
                MenuItem::with_id(app, "reset_window", "Reset Window", true, None::<&str>)?;
            let update_item =
                MenuItem::with_id(app, "check_update", "Check for Updates", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

            let state = app.state::<AppState>();
            *state.toggle_menu_item.lock().unwrap() = Some(toggle_item.clone());
            *state.update_menu_item.lock().unwrap() = Some(update_item.clone());

            let menu = Menu::with_items(app, &[&version_item, &toggle_item, &reset_item, &update_item, &quit_item])?;

            let tray_png = image::load_from_memory(include_bytes!("../icons/tray-icon.png"))
                .expect("failed to decode tray icon PNG");
            let tray_rgba = tray_png.to_rgba8();

            // Store base icon for later re-rendering with updated cost text
            *state.tray_icon_base.lock().unwrap() = tray_rgba.clone();

            // Render initial tray image: icon-only on Windows, icon + cost on macOS
            #[cfg(target_os = "windows")]
            let initial_icon = tray_render::render_tray_icon_only(&tray_rgba);
            #[cfg(not(target_os = "windows"))]
            let initial_icon = tray_render::render_tray_image(&tray_rgba, "0");

            let tray = TrayIconBuilder::new()
                .icon(initial_icon)
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |_app, event| {
                    match event.id.as_ref() {
                        "toggle" => {
                            toggle_overlay_sync(_app);
                        }
                        "reset_window" => {
                            // Delete saved prefs and reset window to default size/position
                            let _ = std::fs::remove_file(window_prefs_path());
                            let state = _app.state::<AppState>();
                            *state.overlay_pinned.lock().unwrap() = false;
                            if let Some(window) = _app.get_webview_window("overlay") {
                                let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize {
                                    width: 380.0,
                                    height: 480.0,
                                }));
                                position_overlay_window(&window, _app);
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        "check_update" => {
                            let handle = _app.clone();
                            tauri::async_runtime::spawn(async move {
                                let updater = match handle.updater() {
                                    Ok(u) => u,
                                    Err(e) => { warn!("[updater] Init failed: {}", e); return; }
                                };
                                match updater.check().await {
                                    Ok(Some(update)) => {
                                        info!("[updater] Installing v{}...", update.version);
                                        if let Err(e) = update.download_and_install(|_, _| {}, || {}).await {
                                            warn!("[updater] Install failed: {}", e);
                                        } else {
                                            handle.restart();
                                        }
                                    }
                                    Ok(None) => info!("[updater] Already up to date"),
                                    Err(e) => warn!("[updater] Check failed: {}", e),
                                }
                            });
                        }
                        "quit" => {
                            quit_app();
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        toggle_overlay_sync(tray.app_handle());
                    }
                })
                .build(app)?;

            // Store tray icon handle so we can query its rect() for positioning
            *state.tray_icon.lock().unwrap() = Some(tray);

            // Clear stale window prefs on version change (reinstall/upgrade)
            let current_version = app.config().version.clone().unwrap_or_default();
            if let Some(prefs) = load_window_prefs() {
                if prefs.app_version != current_version {
                    let _ = std::fs::remove_file(window_prefs_path());
                }
            }

            // Pre-create the overlay window (hidden) so it's ready on first click.
            // Without this, the first tray-icon click creates the webview on-demand
            // and the window geometry isn't settled yet, causing it to appear offscreen.
            let _ = ensure_overlay_window(app.handle());

            // Always show the overlay on launch so users know the app is running.
            {
                let handle = app.handle().clone();
                // Delay so the window/webview is fully ready (longer on Windows for WebView2 init).
                let delay_ms = if cfg!(target_os = "windows") { 1500 } else { 500 };
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(delay_ms));
                    let _ = show_overlay_sync(&handle);
                });
            }

            // Enable autostart on first launch only (respect user choice after that)
            {
                use tauri_plugin_autostart::ManagerExt;
                let marker = app.path().app_data_dir().unwrap().join(".autostart-initialized");
                if !marker.exists() {
                    let autostart = app.autolaunch();
                    let _ = autostart.enable();
                    info!("[setup] autostart enabled by default (first launch)");
                    let _ = std::fs::create_dir_all(marker.parent().unwrap());
                    let _ = std::fs::write(&marker, "1");
                }
            }

            // Start stats file watcher
            stats::watcher::FileWatcher::start(
                app.handle().clone(),
                Arc::clone(&stats_metrics_setup),
                Arc::clone(&stats_points_setup),
                Arc::clone(&stats_ranking_setup),
            );

            // Start periodic update checker
            updater::start_periodic_check(app.handle().clone());

            // Handle deep-link URLs (Tauri v2 plugin API)
            let handle = app.handle().clone();
            app.listen("deep-link://new-url", move |event| {
                if let Ok(urls) = serde_json::from_str::<Vec<String>>(event.payload()) {
                    for url_str in urls {
                        if url_str.starts_with("clauderank") {
                            info!("[deep-link] received: {}", url_str);
                            let _ = show_overlay_sync(&handle);
                            break;
                        }
                    }
                }
            });

            Ok(())
        })
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // On Windows, deep-link clicks launch a new process with the URL as an arg.
            // The single-instance plugin intercepts this and forwards it here instead.
            info!("[single-instance] activated with args: {:?}", args);

            // Show the overlay regardless of whether a deep-link URL is present —
            // a second launch attempt should always surface the running app.
            match show_overlay_sync(app) {
                Ok(_) => info!("[single-instance] overlay shown successfully"),
                Err(e) => error!("[single-instance] failed to show overlay: {}", e),
            }

            for arg in &args {
                if arg.starts_with("clauderank://") {
                    info!("[single-instance] deep-link URL: {}", arg);
                    let _ = app.emit("deep-link-received", json!({ "url": arg }));
                    break;
                }
            }
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .plugin(
            tauri_plugin_log::Builder::new()
                .target(tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("clauderank.log".into()),
                    },
                ))
                .level(log::LevelFilter::Info)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            show_overlay,
            hide_overlay,
            toggle_overlay,
            complete_hide,
            get_overlay_visible,
            reload_overlay,
            copy_image_to_clipboard,
            log_from_frontend,
            quit_app,
            open_url,
            get_autostart_enabled,
            set_autostart_enabled,
            is_debug_mode,
            notify_drag_start,
            open_overlay_devtools,
            open_logs_folder,
            get_leaderboard,
            stats::commands::get_dashboard_data,
            stats::commands::get_points,
            stats::commands::get_recent_sessions,
            stats::ranking::get_ranking_identity,
            stats::ranking::get_sync_settings,
            stats::ranking::update_sync_settings,
            stats::ranking::set_username,
            stats::ranking::create_team,
            stats::ranking::join_team,
            stats::ranking::leave_team,
            stats::ranking::get_my_ranking,
            stats::ranking::open_ranking_website,
            stats::ranking::force_sync,
            updater::check_update,
            updater::install_update,
            get_widget_base,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, _event| {});
}
