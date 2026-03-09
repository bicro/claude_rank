use super::metrics::MetricsEngine;
use super::points::PointsEngine;
use super::ranking::RankingEngine;
use log::{error, info};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub struct FileWatcher;

impl FileWatcher {
    pub fn start(
        app: AppHandle,
        metrics: Arc<Mutex<MetricsEngine>>,
        points: Arc<Mutex<PointsEngine>>,
        ranking: Arc<Mutex<RankingEngine>>,
    ) {
        // Initial load
        Self::refresh(&app, &metrics, &points, &ranking);

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

        info!("[stats-watcher] started");
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
            Some(m.data.stats.clone())
        } else {
            None
        };

        // Update points using the same stats
        if let (Ok(mut p), Some(ref stats)) = (points.lock(), &stats) {
            let new_achievements = p.update_from_stats(stats);
            let _ = app.emit("points-updated", p.points_state());
            for a in new_achievements {
                let _ = app.emit("achievement-unlocked", &a);
            }
        }

        // Trigger ranking sync (throttled internally)
        if let Some(ref stats) = stats {
            super::ranking::try_sync(ranking, stats, points, app);
        }
    }
}
