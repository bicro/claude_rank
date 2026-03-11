use super::parser::{ModelUsage, StatsCache};

/// Per-million-token pricing for Claude models.
struct ModelPricing {
    input: f64,
    output: f64,
    cache_read: f64,
    cache_write: f64,
}

/// Look up pricing by model name. Falls back to Sonnet pricing for unknown models.
fn pricing_for_model(model: &str) -> ModelPricing {
    // Normalize: lowercase, strip date suffix for matching
    let m = model.to_lowercase();

    if m.contains("opus") {
        ModelPricing {
            input: 15.0,
            output: 75.0,
            cache_read: 1.5,
            cache_write: 18.75,
        }
    } else if m.contains("haiku") {
        ModelPricing {
            input: 0.80,
            output: 4.0,
            cache_read: 0.08,
            cache_write: 1.0,
        }
    } else {
        // Sonnet (default for unknown models)
        ModelPricing {
            input: 3.0,
            output: 15.0,
            cache_read: 0.30,
            cache_write: 3.75,
        }
    }
}

fn cost_for_usage(model: &str, usage: &ModelUsage) -> f64 {
    let p = pricing_for_model(model);
    let mtok = 1_000_000.0;

    (usage.input_tokens as f64 / mtok) * p.input
        + (usage.output_tokens as f64 / mtok) * p.output
        + (usage.cache_read_input_tokens as f64 / mtok) * p.cache_read
        + (usage.cache_creation_input_tokens as f64 / mtok) * p.cache_write
}

/// Compute total cost across all models from a StatsCache.
pub fn total_cost(stats: &StatsCache) -> f64 {
    stats
        .model_usage
        .iter()
        .map(|(model, usage)| cost_for_usage(model, usage))
        .sum()
}

/// Format cost for display in the menu bar (e.g. " $4.20").
/// Leading space adds padding between the tray icon and the text on macOS.
pub fn format_cost(cost: f64) -> String {
    if cost < 0.01 {
        " $0.00".to_string()
    } else if cost < 10.0 {
        format!(" ${:.2}", cost)
    } else if cost < 100.0 {
        format!(" ${:.1}", cost)
    } else {
        format!(" ${:.0}", cost)
    }
}
