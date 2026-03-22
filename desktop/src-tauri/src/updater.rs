use log::{info, warn};
use serde::Serialize;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;

use crate::AppState;

const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 3600);
const STARTUP_DELAY: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Serialize)]
pub struct UpdateInfo {
    pub current_version: String,
    pub latest_version: String,
}

pub fn start_periodic_check(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(STARTUP_DELAY).await;

        loop {
            info!("[updater] Checking for updates...");

            let updater = match app.updater() {
                Ok(u) => u,
                Err(e) => {
                    warn!("[updater] Init failed: {}", e);
                    tokio::time::sleep(CHECK_INTERVAL).await;
                    continue;
                }
            };

            match updater.check().await {
                Ok(Some(update)) => {
                    let version = update.version.clone();
                    info!("[updater] Update available: {}", version);

                    // Update tray menu item text
                    let state = app.state::<AppState>();
                    if let Some(ref item) = *state.update_menu_item.lock().unwrap() {
                        let _ = item.set_text(format!("Update to v{}", version));
                    }

                    // Emit event for frontend
                    let _ = app.emit(
                        "update-available",
                        UpdateInfo {
                            current_version: update.current_version.clone(),
                            latest_version: version,
                        },
                    );
                }
                Ok(None) => {
                    info!("[updater] App is up to date");
                }
                Err(e) => {
                    warn!("[updater] Check failed: {}", e);
                }
            }

            tokio::time::sleep(CHECK_INTERVAL).await;
        }
    });
}

#[tauri::command]
pub async fn check_update(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    let updater = app.updater().map_err(|e| format!("Updater init failed: {}", e))?;
    match updater.check().await {
        Ok(Some(update)) => Ok(Some(UpdateInfo {
            current_version: update.current_version.clone(),
            latest_version: update.version.clone(),
        })),
        Ok(None) => Ok(None),
        Err(e) => Err(format!("Update check failed: {}", e)),
    }
}

#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    let updater = app.updater().map_err(|e| format!("Updater init failed: {}", e))?;
    let update = updater
        .check()
        .await
        .map_err(|e| format!("Update check failed: {}", e))?;

    match update {
        Some(update) => {
            info!("[updater] Downloading and installing v{}...", update.version);
            update
                .download_and_install(|_, _| {}, || {})
                .await
                .map_err(|e| format!("Install failed: {}", e))?;
            info!("[updater] Update installed, restarting...");
            app.restart();
        }
        None => Err("No update available".to_string()),
    }
}
