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

/** Pricing per million tokens (matches server pricing table) */
const PRICING = [
  { match: "opus-4-6",  input: 5,    output: 25,   cacheRead: 0.50, cacheWrite: 6.25 },
  { match: "opus-4-5",  input: 5,    output: 25,   cacheRead: 0.50, cacheWrite: 6.25 },
  { match: "opus-4",    input: 15,   output: 75,   cacheRead: 1.50, cacheWrite: 18.75 },
  { match: "opus-3",    input: 15,   output: 75,   cacheRead: 1.50, cacheWrite: 18.75 },
  { match: "sonnet",    input: 3,    output: 15,   cacheRead: 0.30, cacheWrite: 3.75 },
  { match: "haiku-4",   input: 1,    output: 5,    cacheRead: 0.10, cacheWrite: 1.25 },
  { match: "haiku-3-5", input: 0.80, output: 4,    cacheRead: 0.08, cacheWrite: 1 },
  { match: "haiku-3",   input: 0.25, output: 1.25, cacheRead: 0.03, cacheWrite: 0.30 },
];
const FALLBACK_PRICE = { input: 3, output: 15, cacheRead: 0.30, cacheWrite: 3.75 };

function getPrice(model) {
  const m = model.toLowerCase();
  return PRICING.find(p => m.includes(p.match)) || FALLBACK_PRICE;
}

/** Estimate cost from tokens */
export function estimateCost(modelUsage) {
  let cost = 0;
  for (const [model, usage] of Object.entries(modelUsage || {})) {
    const p = getPrice(model);

    const inp = usage.inputTokens ?? usage.input_tokens ?? 0;
    const out = usage.outputTokens ?? usage.output_tokens ?? 0;
    const cacheRead = usage.cacheReadInputTokens ?? usage.cache_read_input_tokens ?? usage.cache_read ?? 0;
    const cacheWrite = usage.cacheCreationInputTokens ?? usage.cache_creation_input_tokens ?? usage.cache_creation ?? 0;

    cost += (inp / 1e6) * p.input + (out / 1e6) * p.output +
            (cacheRead / 1e6) * p.cacheRead + (cacheWrite / 1e6) * p.cacheWrite;
  }
  return `$${cost.toFixed(2)}`;
}
