use super::jsonl::JsonlTracker;
use super::parser::*;
use serde::Serialize;

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DashboardData {
    pub stats: StatsCache,
    pub recent_sessions: Vec<SessionEntry>,
}

pub struct MetricsEngine {
    pub data: DashboardData,
    tracker: JsonlTracker,
}

impl MetricsEngine {
    pub fn new() -> Self {
        Self {
            data: DashboardData::default(),
            tracker: JsonlTracker::new(),
        }
    }

    pub fn refresh(&mut self) {
        self.data.stats = self.tracker.refresh();
        self.data.recent_sessions = self.tracker.recent_sessions(50);
    }

    pub fn dashboard_data(&self) -> &DashboardData {
        &self.data
    }
}
