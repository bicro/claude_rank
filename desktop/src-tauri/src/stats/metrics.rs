use super::codex_jsonl::CodexJsonlTracker;
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
    pub codex_stats: StatsCache,
    tracker: JsonlTracker,
    codex_tracker: CodexJsonlTracker,
}

impl MetricsEngine {
    pub fn new() -> Self {
        let mut tracker = JsonlTracker::new();
        let mut codex_tracker = CodexJsonlTracker::new();
        let mut data = DashboardData::default();
        let mut codex_stats = StatsCache::default();

        // Load cached stats immediately for instant UI display
        if let Some(cached_stats) = tracker.load_cache() {
            data.stats = cached_stats;
        }
        if let Some(cached) = codex_tracker.load_cache() {
            codex_stats = cached;
        }

        Self {
            data,
            codex_stats,
            tracker,
            codex_tracker,
        }
    }

    pub fn refresh(&mut self) {
        self.data.stats = self.tracker.refresh();
        self.data.recent_sessions = self.tracker.recent_sessions(50);
        self.codex_stats = self.codex_tracker.refresh();
    }

    pub fn force_reparse(&mut self) {
        self.data.stats = self.tracker.force_reparse();
        self.data.recent_sessions = self.tracker.recent_sessions(50);
        self.codex_stats = self.codex_tracker.force_reparse();
    }

    pub fn needs_full_sync(&self) -> bool {
        self.tracker.needs_full_sync
    }

    pub fn clear_full_sync_flag(&mut self) {
        self.tracker.needs_full_sync = false;
    }

    pub fn dashboard_data(&self) -> &DashboardData {
        &self.data
    }
}
