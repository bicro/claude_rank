use super::metrics::{DashboardData, MetricsEngine};
use super::points::{PointsEngine, PointsState};
use super::parser::SessionEntry;
use std::sync::{Arc, Mutex};
use tauri::command;

#[command]
pub fn get_dashboard_data(
    metrics: tauri::State<'_, Arc<Mutex<MetricsEngine>>>,
) -> Result<DashboardData, String> {
    let m = metrics.lock().map_err(|e| e.to_string())?;
    Ok(m.dashboard_data().clone())
}

#[command]
pub fn get_points(
    points: tauri::State<'_, Arc<Mutex<PointsEngine>>>,
) -> Result<PointsState, String> {
    let p = points.lock().map_err(|e| e.to_string())?;
    Ok(p.points_state().clone())
}

#[command]
pub fn get_recent_sessions(
    metrics: tauri::State<'_, Arc<Mutex<MetricsEngine>>>,
) -> Result<Vec<SessionEntry>, String> {
    let m = metrics.lock().map_err(|e| e.to_string())?;
    Ok(m.dashboard_data().recent_sessions.clone())
}
