/** Format a large number with commas */
export function fmtNum(n) {
  if (n == null) return "0";
  return Number(n).toLocaleString("en-US");
}

/** Format tokens to a human-readable string (e.g., 1.2M, 45.3K) */
export function fmtTokens(n) {
  if (n == null || n === 0) return "0";
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + "B";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

/** Format seconds to human-readable duration */
export function fmtDuration(secs) {
  if (!secs) return "0m";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Get tier name from level */
export function getTier(level) {
  if (level >= 50) return "Mythic";
  if (level >= 40) return "Legendary";
  if (level >= 30) return "Master";
  if (level >= 20) return "Expert";
  if (level >= 15) return "Advanced";
  if (level >= 10) return "Intermediate";
  if (level >= 5) return "Beginner";
  return "Novice";
}

/** Get tier emoji */
export function tierEmoji(level) {
  if (level >= 50) return "🏆";
  if (level >= 40) return "⭐";
  if (level >= 30) return "🔮";
  if (level >= 20) return "💎";
  if (level >= 15) return "🔥";
  if (level >= 10) return "📊";
  if (level >= 5) return "📈";
  return "🌱";
}

/** Format a rank with ordinal suffix */
export function fmtRank(rank) {
  if (rank == null) return "—";
  const s = ["th", "st", "nd", "rd"];
  const v = rank % 100;
  return `#${rank}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

/** Format a percentile */
export function fmtPercentile(pct) {
  if (pct == null) return "";
  return `top ${pct.toFixed(1)}%`;
}

/** Estimate cost from tokens (rough: $3/MTok input, $15/MTok output avg) */
export function estimateCost(modelUsage) {
  let cost = 0;
  for (const [model, usage] of Object.entries(modelUsage || {})) {
    const isOpus = model.includes("opus");
    const isSonnet = model.includes("sonnet");
    const isHaiku = model.includes("haiku");

    // Approximate pricing per million tokens
    let inputRate, outputRate;
    if (isOpus) { inputRate = 15; outputRate = 75; }
    else if (isSonnet) { inputRate = 3; outputRate = 15; }
    else if (isHaiku) { inputRate = 0.8; outputRate = 4; }
    else { inputRate = 3; outputRate = 15; }

    const inp = (usage.inputTokens ?? usage.input_tokens ?? 0) +
                (usage.cacheReadInputTokens ?? usage.cache_read_input_tokens ?? usage.cache_read ?? 0) * 0.1 +
                (usage.cacheCreationInputTokens ?? usage.cache_creation_input_tokens ?? usage.cache_creation ?? 0) * 1.25;
    const out = usage.outputTokens ?? usage.output_tokens ?? usage.output ?? 0;

    cost += (inp / 1_000_000) * inputRate + (out / 1_000_000) * outputRate;
  }
  return `$${cost.toFixed(2)}`;
}
