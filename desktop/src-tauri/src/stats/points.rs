use super::parser::StatsCache;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PointsState {
    pub total_points: u64,
    pub level: u64,
    pub current_streak: u64,
    pub achievements: Vec<Achievement>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Achievement {
    pub id: String,
    pub name: String,
    pub description: String,
    pub unlocked_at: String,
}

pub struct PointsEngine {
    pub state: PointsState,
}

impl PointsEngine {
    pub fn new() -> Self {
        Self {
            state: PointsState::default(),
        }
    }

    /// Update points state from server sync response values.
    pub fn update_from_server(
        &mut self,
        total_points: u64,
        level: u64,
        current_streak: u64,
        achievements: Vec<Achievement>,
    ) {
        self.state.total_points = total_points;
        self.state.level = level;
        self.state.current_streak = current_streak;
        self.state.achievements = achievements;
    }

    /// Estimate points/level locally from StatsCache using the same formula as the server.
    /// Streak and achievements are NOT re-estimated — they keep their last server values.
    pub fn estimate_from_stats(&mut self, stats: &StatsCache) {
        let messages = stats.total_messages;
        let output_tokens: u64 = stats.model_usage.values().map(|m| m.output_tokens).sum();
        let tool_calls: u64 = stats.daily_activity.iter().map(|d| d.tool_call_count).sum();
        let sessions = stats.total_sessions;
        let active_days = stats.daily_activity.len() as u64;
        let current_streak = self.state.current_streak; // keep last server value

        let points = messages * 2
            + (output_tokens / 1000) * 5
            + tool_calls * 3
            + sessions * 10
            + active_days * 50
            + current_streak * 10;

        self.state.total_points = points;
        self.state.level = (points as f64 / 100.0).sqrt() as u64;
    }

    pub fn points_state(&self) -> &PointsState {
        &self.state
    }
}
