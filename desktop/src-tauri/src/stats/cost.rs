use super::parser::StatsCache;

/// Sum today's tokens using hourly granularity.
/// Iterates each of the 24 local hours, maps to the corresponding UTC
/// date:hour key in `hour_tokens`, and sums only those exact hours.
pub fn today_tokens(stats: &StatsCache) -> u64 {
    use chrono::{Local, NaiveTime, Timelike, Duration};

    let now = Local::now();
    let local_date = now.date_naive();
    let offset_secs = now.offset().local_minus_utc() as i64;

    let mut total = 0u64;
    for h in 0..24 {
        let local_hour = local_date.and_time(NaiveTime::from_hms_opt(h, 0, 0).unwrap());
        let utc_time = local_hour - Duration::seconds(offset_secs);
        let key = format!("{}:{}", utc_time.format("%Y-%m-%d"), utc_time.hour());
        total += stats.hour_tokens.get(&key).copied().unwrap_or(0);
    }
    total
}

/// Format a token count for tray display (e.g. "1.2M", "42K").
pub fn format_tokens(tokens: u64) -> String {
    if tokens == 0 {
        "0".to_string()
    } else if tokens < 1_000 {
        format!("{}", tokens)
    } else if tokens < 10_000 {
        format!("{:.1}K", tokens as f64 / 1_000.0)
    } else if tokens < 1_000_000 {
        format!("{}K", tokens / 1_000)
    } else if tokens < 10_000_000 {
        format!("{:.1}M", tokens as f64 / 1_000_000.0)
    } else {
        format!("{}M", tokens / 1_000_000)
    }
}
