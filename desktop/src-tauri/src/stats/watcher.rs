use super::cost;
use super::metrics::MetricsEngine;
use super::points::PointsEngine;
use super::ranking::RankingEngine;
use log::{error, info};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

pub struct FileWatcher;

impl FileWatcher {
    pub fn start(
        app: AppHandle,
        metrics: Arc<Mutex<MetricsEngine>>,
        points: Arc<Mutex<PointsEngine>>,
        ranking: Arc<Mutex<RankingEngine>>,
    ) {
        // Emit cached stats immediately (before background refresh)
        // MetricsEngine::new() already loaded the cache, so emit it now for instant UI
        if let Ok(m) = metrics.lock() {
            if m.data.stats.total_sessions > 0 {
                info!("[stats-watcher] emitting cached stats immediately");
                let _ = app.emit("metrics-updated", &m.data);

                // Show token burn in tray immediately from cache
                let tokens = cost::today_tokens(&m.data.stats);
                let label = cost::format_tokens(tokens);
                Self::update_tray_icon(&app, &label);
            }
        }

        // Spawn initial load in background (non-blocking)
        let app_init = app.clone();
        let m_init = Arc::clone(&metrics);
        let p_init = Arc::clone(&points);
        let r_init = Arc::clone(&ranking);
        std::thread::spawn(move || {
            info!("[stats-watcher] background initial refresh starting");
            Self::refresh(&app_init, &m_init, &p_init, &r_init);
            info!("[stats-watcher] background initial refresh done");
        });

        info!("[stats-watcher] started");

        // Spawn polling thread — refresh every 30s unconditionally
        // (JsonlTracker handles change detection internally)
        let app_clone = app.clone();
        let m = Arc::clone(&metrics);
        let p = Arc::clone(&points);
        let r = Arc::clone(&ranking);
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_secs(30));
            Self::refresh(&app_clone, &m, &p, &r);
        });

        // Notify watcher for immediate updates on .jsonl changes
        let app_notify = app.clone();
        let m2 = Arc::clone(&metrics);
        let p2 = Arc::clone(&points);
        let r2 = Arc::clone(&ranking);
        std::thread::spawn(move || {
            if let Err(e) = Self::run_notify_watcher(app_notify, m2, p2, r2) {
                error!("[stats-watcher] notify watcher failed: {}", e);
            }
        });
    }

    fn run_notify_watcher(
        app: AppHandle,
        metrics: Arc<Mutex<MetricsEngine>>,
        points: Arc<Mutex<PointsEngine>>,
        ranking: Arc<Mutex<RankingEngine>>,
    ) -> Result<(), Box<dyn std::error::Error>> {
        use notify::{RecursiveMode, Watcher};
        use std::sync::mpsc;

        let (tx, rx) = mpsc::channel();
        let mut watcher = notify::recommended_watcher(move |res: Result<notify::Event, _>| {
            if let Ok(event) = res {
                let dominated = event.paths.iter().any(|p| {
                    let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
                    name.ends_with(".jsonl") || name == "sessions-index.json"
                });
                if dominated {
                    let _ = tx.send(());
                }
            }
        })?;

        if let Some(claude_dir) = dirs::home_dir().map(|h| h.join(".claude")) {
            if claude_dir.exists() {
                watcher.watch(&claude_dir, RecursiveMode::Recursive)?;
            }
        }

        // Debounce: wait for events, refresh at most every 2s
        loop {
            let _ = rx.recv();
            std::thread::sleep(Duration::from_secs(2));
            while rx.try_recv().is_ok() {}
            Self::refresh(&app, &metrics, &points, &ranking);
        }
    }

    fn update_tray_icon(app: &AppHandle, label: &str) {
        let state = app.state::<crate::AppState>();
        let base_icon = state.tray_icon_base.lock().unwrap();
        // Only render if we have a valid base icon (not the 1x1 placeholder)
        if base_icon.width() > 1 {
            let rendered = crate::tray_render::render_tray_image(&base_icon, label);
            let guard = state.tray_icon.lock().unwrap();
            if let Some(tray) = guard.as_ref() {
                let _ = tray.set_icon(Some(rendered));
            }
        }
    }

    fn refresh(
        app: &AppHandle,
        metrics: &Arc<Mutex<MetricsEngine>>,
        points: &Arc<Mutex<PointsEngine>>,
        ranking: &Arc<Mutex<RankingEngine>>,
    ) {
        // Refresh metrics (tracker computes stats from JSONL)
        let stats = if let Ok(mut m) = metrics.lock() {
            m.refresh();
            let _ = app.emit("metrics-updated", &m.data);

            // Update tray icon with today's token burn
            let tokens = cost::today_tokens(&m.data.stats);
            let label = cost::format_tokens(tokens);
            Self::update_tray_icon(app, &label);

            Some(m.data.stats.clone())
        } else {
            None
        };

        // Estimate points locally from stats for fast feedback between server syncs.
        // Server values overwrite this estimate on each sync.
        if let Some(ref stats) = stats {
            if let Ok(mut p) = points.lock() {
                p.estimate_from_stats(stats);
                let _ = app.emit("points-updated", p.points_state());
            }
        } else if let Ok(p) = points.lock() {
            let _ = app.emit("points-updated", p.points_state());
        }

        // Trigger ranking sync (throttled internally)
        if let Some(ref stats) = stats {
            info!("[stats-watcher] calling try_sync (sessions={}, messages={})", stats.total_sessions, stats.total_messages);
            super::ranking::try_sync(ranking, stats, points, app);
        }
    }
}
