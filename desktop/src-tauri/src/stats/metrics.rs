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
        let mut tracker = JsonlTracker::new();
        let mut data = DashboardData::default();

        // Load cached stats immediately for instant UI display
        if let Some(cached_stats) = tracker.load_cache() {
            data.stats = cached_stats;
        }

        Self { data, tracker }
    }

    pub fn refresh(&mut self) {
        self.data.stats = self.tracker.refresh();
        self.data.recent_sessions = self.tracker.recent_sessions(50);
    }

    pub fn force_reparse(&mut self) {
        self.data.stats = self.tracker.force_reparse();
        self.data.recent_sessions = self.tracker.recent_sessions(50);
    }

    pub fn dashboard_data(&self) -> &DashboardData {
        &self.data
    }
}
