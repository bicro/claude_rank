use super::parser::StatsCache;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

fn state_path() -> PathBuf {
    let dir = dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".vaibfu");
    let _ = std::fs::create_dir_all(&dir);
    dir.join("state.json")
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PointsState {
    pub total_points: u64,
    pub level: u64,
    pub current_streak: u64,
    pub last_active_date: Option<String>,
    pub achievements: Vec<Achievement>,
    // Watermarks to avoid double-counting
    pub counted_messages: u64,
    pub counted_sessions: u64,
    pub counted_tool_calls: u64,
    pub counted_output_tokens: u64,
    pub counted_days: u64,
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
        let state = Self::load_state();
        Self { state }
    }

    fn load_state() -> PointsState {
        let path = state_path();
        if let Ok(data) = std::fs::read_to_string(&path) {
            serde_json::from_str(&data).unwrap_or_default()
        } else {
            PointsState::default()
        }
    }

    fn save_state(&self) {
        let path = state_path();
        if let Ok(json) = serde_json::to_string_pretty(&self.state) {
            let _ = std::fs::write(path, json);
        }
    }

    /// Update points from stats cache. Returns newly unlocked achievements.
    pub fn update_from_stats(&mut self, stats: &StatsCache) -> Vec<Achievement> {
        let s = &mut self.state;

        // Count new deltas
        let new_messages = stats.total_messages.saturating_sub(s.counted_messages);
        let new_sessions = stats.total_sessions.saturating_sub(s.counted_sessions);

        let total_tool_calls: u64 = stats.daily_activity.iter().map(|d| d.tool_call_count).sum();
        let new_tool_calls = total_tool_calls.saturating_sub(s.counted_tool_calls);

        let total_output: u64 = stats.model_usage.values().map(|m| m.output_tokens).sum();
        let new_output = total_output.saturating_sub(s.counted_output_tokens);

        let total_days = stats.daily_activity.len() as u64;
        let new_days = total_days.saturating_sub(s.counted_days);

        // Award points
        let mut earned: u64 = 0;
        earned += new_messages * 2; // 2 per message
        earned += (new_output / 1000) * 5; // 5 per 1K output tokens
        earned += new_tool_calls * 3; // 3 per tool call
        earned += new_sessions * 10; // 10 per session
        earned += new_days * 50; // 50 per active day

        // Streak calculation
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        let yesterday = (chrono::Local::now() - chrono::Duration::days(1))
            .format("%Y-%m-%d")
            .to_string();

        // Check if there's activity today
        let has_today = stats.daily_activity.iter().any(|d| d.date == today);
        if has_today {
            match &s.last_active_date {
                Some(last) if last == &yesterday => {
                    s.current_streak += 1;
                }
                Some(last) if last == &today => {
                    // Same day, no change
                }
                _ => {
                    s.current_streak = 1;
                }
            }
            // Streak bonus
            earned += s.current_streak * 10;
            s.last_active_date = Some(today);
        }

        s.total_points += earned;

        // Update watermarks
        s.counted_messages = stats.total_messages;
        s.counted_sessions = stats.total_sessions;
        s.counted_tool_calls = total_tool_calls;
        s.counted_output_tokens = total_output;
        s.counted_days = total_days;

        // Level = floor(sqrt(total_points / 100))
        s.level = ((s.total_points as f64 / 100.0).sqrt()) as u64;

        // Check achievements
        let new_achievements = self.check_achievements(stats);

        self.save_state();
        new_achievements
    }

    fn check_achievements(&mut self, stats: &StatsCache) -> Vec<Achievement> {
        let mut new = vec![];
        let s = &mut self.state;

        let defs: Vec<(&str, &str, &str, bool)> = vec![
            (
                "first_steps",
                "First Steps",
                "Send your first message",
                stats.total_messages >= 1,
            ),
            (
                "thousand_club",
                "Thousand Club",
                "Send 1,000 messages",
                stats.total_messages >= 1000,
            ),
            (
                "token_millionaire",
                "Token Millionaire",
                "Generate 1M output tokens",
                stats
                    .model_usage
                    .values()
                    .map(|m| m.output_tokens)
                    .sum::<u64>()
                    >= 1_000_000,
            ),
            (
                "night_owl",
                "Night Owl",
                "Code between midnight and 4am",
                stats.hour_counts.iter().any(|(k, &v)| {
                    v > 0
                        && k.rsplit(':')
                            .next()
                            .and_then(|h| h.parse::<u32>().ok())
                            .map(|h| h <= 3)
                            .unwrap_or(false)
                }),
            ),
            (
                "marathon_coder",
                "Marathon Coder",
                "Have a session with 100+ messages",
                stats
                    .longest_session
                    .as_ref()
                    .map(|l| l.message_count >= 100)
                    .unwrap_or(false),
            ),
            (
                "tool_master",
                "Tool Master",
                "Make 1,000 tool calls",
                stats
                    .daily_activity
                    .iter()
                    .map(|d| d.tool_call_count)
                    .sum::<u64>()
                    >= 1000,
            ),
            (
                "streak_lord",
                "Streak Lord",
                "Maintain a 7-day streak",
                s.current_streak >= 7,
            ),
            (
                "centurion",
                "Centurion",
                "Complete 100 sessions",
                stats.total_sessions >= 100,
            ),
        ];

        let now = chrono::Local::now().to_rfc3339();
        for (id, name, desc, condition) in defs {
            if condition && !s.achievements.iter().any(|a| a.id == id) {
                let a = Achievement {
                    id: id.to_string(),
                    name: name.to_string(),
                    description: desc.to_string(),
                    unlocked_at: now.clone(),
                };
                s.achievements.push(a.clone());
                new.push(a);
            }
        }

        new
    }

    pub fn points_state(&self) -> &PointsState {
        &self.state
    }
}
