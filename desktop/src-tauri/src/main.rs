// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod stats;

use serde::Serialize;
use serde_json::json;
use std::sync::{Arc, Mutex};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder};
use tauri::{command, AppHandle, Emitter, Manager};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use log::{error, info, warn};
use serde::Deserialize;

// macOS-specific imports
#[cfg(target_os = "macos")]
use objc2::rc::Retained;
#[cfg(target_os = "macos")]
use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior};

// Windows-specific imports
#[cfg(target_os = "windows")]
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM, RECT};
#[cfg(target_os = "windows")]
use windows::Win32::UI::WindowsAndMessaging::{
    SetWindowPos, SystemParametersInfoW, HWND_TOPMOST, SPI_GETWORKAREA,
    SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
    WM_NCACTIVATE, WM_NCPAINT, WM_NCCALCSIZE, WM_NCDESTROY,
};
#[cfg(target_os = "windows")]
use windows::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};

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
        .unwrap_or_else(|_| "https://claude-rank.onrender.com".to_string())
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

#[derive(Default)]
pub struct AppState {
    pub overlay_visible: Mutex<bool>,
    pub toggle_menu_item: Mutex<Option<MenuItem<tauri::Wry>>>,
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
fn get_windows_taskbar_height() -> i32 {
    use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CYSCREEN};

    unsafe {
        let mut work_area = RECT::default();
        if SystemParametersInfoW(
            SPI_GETWORKAREA,
            0,
            Some(&mut work_area as *mut _ as *mut _),
            Default::default(),
        ).is_ok() {
            let screen_height = GetSystemMetrics(SM_CYSCREEN);
            return screen_height - work_area.bottom;
        }
    }
    0
}

#[cfg(not(target_os = "windows"))]
fn get_windows_taskbar_height() -> i32 {
    0
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

fn ensure_overlay_window(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
    if let Some(window) = app.get_webview_window("overlay") {
        return Ok(window);
    }

    let width = 380.0;
    let height = 620.0;

    tauri::WebviewWindowBuilder::new(
        app,
        "overlay",
        tauri::WebviewUrl::App("overlay.html".into()),
    )
    .title("ClaudeRank")
    .visible(false)
    .transparent(true)
    .decorations(false)
    .shadow(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .inner_size(width, height)
    .resizable(true)
    .build()
    .map_err(|e| format!("Failed to create overlay window: {}", e))
}

fn get_overlay_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    app.get_webview_window("overlay")
}

async fn do_show_overlay(
    app: AppHandle,
    state: &tauri::State<'_, AppState>,
) -> Result<(), String> {
    let window = ensure_overlay_window(&app)?;
    configure_overlay(&window)?;

    if let Ok(Some(monitor)) = window.current_monitor() {
        let screen_size = monitor.size();
        let screen_pos = monitor.position();
        if let Ok(window_size) = window.outer_size() {
            let taskbar_offset = get_windows_taskbar_height();
            let x = screen_pos.x + (screen_size.width as i32) - (window_size.width as i32);
            let y = screen_pos.y + (screen_size.height as i32) - (window_size.height as i32) - taskbar_offset;
            let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition { x, y }));
        }
    }

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
    if let Some(window) = app.get_webview_window("overlay") {
        window.hide().map_err(|e| e.to_string())?;
    }

    *state.overlay_visible.lock().unwrap() = false;

    if let Some(menu_item) = state.toggle_menu_item.lock().unwrap().as_ref() {
        let _ = menu_item.set_text("Show Widget");
    }

    let _ = app.emit("overlay-visibility-changed", json!({ "visible": false }));
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
        if let Some(window) = app.get_webview_window("overlay") {
            let _ = window.hide();
            *state.overlay_visible.lock().unwrap() = false;
            let _ = app.emit("overlay-visibility-changed", json!({ "visible": false }));

            if let Some(menu_item) = state.toggle_menu_item.lock().unwrap().as_ref() {
                let _ = menu_item.set_text("Show Widget");
            }
        }
    } else if let Ok(window) = ensure_overlay_window(app) {
        let _ = configure_overlay(&window);

        if let Ok(Some(monitor)) = window.current_monitor() {
            let screen_size = monitor.size();
            let screen_pos = monitor.position();
            if let Ok(window_size) = window.outer_size() {
                let taskbar_offset = get_windows_taskbar_height();
                let x = screen_pos.x + (screen_size.width as i32) - (window_size.width as i32);
                let y = screen_pos.y + (screen_size.height as i32) - (window_size.height as i32) - taskbar_offset;
                let _ = window
                    .set_position(tauri::Position::Physical(tauri::PhysicalPosition { x, y }));
            }
        }

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
    let window = ensure_overlay_window(app)?;
    configure_overlay(&window)?;

    if let Ok(Some(monitor)) = window.current_monitor() {
        let screen_size = monitor.size();
        let screen_pos = monitor.position();
        if let Ok(window_size) = window.outer_size() {
            let taskbar_offset = get_windows_taskbar_height();
            let x = screen_pos.x + (screen_size.width as i32) - (window_size.width as i32);
            let y = screen_pos.y + (screen_size.height as i32) - (window_size.height as i32) - taskbar_offset;
            let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition { x, y }));
        }
    }

    let _ = window.show();
    let _ = window.set_focus();

    let state = app.state::<AppState>();
    *state.overlay_visible.lock().unwrap() = true;

    let _ = app.emit("overlay-visibility-changed", json!({ "visible": true }));
    Ok(())
}

fn hide_overlay_sync(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("overlay") {
        let _ = window.hide();
    }

    let state = app.state::<AppState>();
    *state.overlay_visible.lock().unwrap() = false;

    if let Some(menu_item) = state.toggle_menu_item.lock().unwrap().as_ref() {
        let _ = menu_item.set_text("Show Widget");
    }

    let _ = app.emit("overlay-visibility-changed", json!({ "visible": false }));
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
            info!("=== ClaudeRank Widget Starting ===");

            // Create tray menu
            let toggle_item =
                MenuItem::with_id(app, "toggle", "Show Widget", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

            let state = app.state::<AppState>();
            *state.toggle_menu_item.lock().unwrap() = Some(toggle_item.clone());

            let menu = Menu::with_items(app, &[&toggle_item, &quit_item])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |_app, event| {
                    match event.id.as_ref() {
                        "toggle" => {
                            toggle_overlay_sync(_app);
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

            // Register global shortcut (Alt+Space on Windows/macOS, Super+Space on Linux)
            #[cfg(target_os = "linux")]
            let shortcut = Shortcut::new(Some(Modifiers::SUPER), Code::Space);
            #[cfg(not(target_os = "linux"))]
            let shortcut = Shortcut::new(Some(Modifiers::ALT), Code::Space);
            if let Err(e) = app.global_shortcut().register(shortcut) {
                error!("[shortcut] failed to register Alt/Super+Space: {}", e);
                return Err(e.into());
            }
            info!("[shortcut] registered Alt/Super+Space successfully");

            // Show overlay on launch
            let _ = show_overlay_sync(app.handle());

            // Start stats file watcher
            stats::watcher::FileWatcher::start(
                app.handle().clone(),
                Arc::clone(&stats_metrics_setup),
                Arc::clone(&stats_points_setup),
                Arc::clone(&stats_ranking_setup),
            );

            Ok(())
        })
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
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    let is_alt_space_shortcut = shortcut.matches(Modifiers::ALT, Code::Space)
                        || shortcut.matches(Modifiers::SUPER, Code::Space);
                    if !is_alt_space_shortcut {
                        return;
                    }

                    if let ShortcutState::Pressed = event.state() {
                        let state = app.state::<AppState>();
                        let is_visible = *state.overlay_visible.lock().unwrap();

                        if !is_visible {
                            let _ = show_overlay_sync(app);
                        } else {
                            hide_overlay_sync(app);
                        }
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            show_overlay,
            hide_overlay,
            toggle_overlay,
            get_overlay_visible,
            reload_overlay,
            copy_image_to_clipboard,
            log_from_frontend,
            quit_app,
            get_autostart_enabled,
            set_autostart_enabled,
            is_debug_mode,
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
            get_widget_base,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, _event| {});
}
