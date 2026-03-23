#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { loadOrCreateIdentity, getLookupHash } from "./lib/identity.mjs";
import { loadStats } from "./lib/log-parser.mjs";
import { fetchUserProfile, fetchConcurrency, fetchDailyRanks } from "./lib/api.mjs";
import { fmtTokens, fmtRank, estimateCost, fmtAgentHours } from "./lib/format.mjs";

// ── Block chars for heatmap ──
const BLOCKS = [" ", "░", "▒", "▓", "█"];

function intensityBlock(value, max) {
  if (!max || value <= 0) return BLOCKS[0];
  return BLOCKS[Math.min(Math.ceil((value / max) * 4), 4)];
}

// ── Local stats helpers (same approach as statusline.mjs) ──

function todayTokensFromStats(stats) {
  const hourTokens = stats?.hourTokens || {};
  const now = new Date();
  const y = now.getFullYear(), mo = now.getMonth(), d = now.getDate();
  let total = 0;
  for (let h = 0; h < 24; h++) {
    const t = new Date(y, mo, d, h, 0, 0);
    const key = `${t.toISOString().slice(0, 10)}:${t.getUTCHours()}`;
    total += hourTokens[key] || 0;
  }
  return total;
}

function todayCostFromStats(stats) {
  const dailyModelTokens = stats?.dailyModelTokens || [];
  const modelUsage = stats?.modelUsage || {};
  const now = new Date();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const todayEntry = dailyModelTokens.find(d => d.date === todayStr);
  if (!todayEntry) return "$0.00";
  const todayUsage = {};
  for (const [model, tokens] of Object.entries(todayEntry.tokensByModel || {})) {
    const total = modelUsage[model];
    if (total) {
      const allTok = (total.inputTokens || 0) + (total.outputTokens || 0) +
                     (total.cacheReadInputTokens || 0) + (total.cacheCreationInputTokens || 0);
      if (allTok > 0) {
        const ratio = tokens / allTok;
        todayUsage[model] = {
          inputTokens: (total.inputTokens || 0) * ratio,
          outputTokens: (total.outputTokens || 0) * ratio,
          cacheReadInputTokens: (total.cacheReadInputTokens || 0) * ratio,
          cacheCreationInputTokens: (total.cacheCreationInputTokens || 0) * ratio,
        };
      }
    }
  }
  return estimateCost(todayUsage);
}

// ── Parse the concurrency API response ──

function parseConcurrencyResponse(data, localDateStr) {
  // The API returns: { "YYYY-MM-DD:H": { histogram: {...}, tokens: N }, "sessions": [...] }
  const sessions = Array.isArray(data?.sessions) ? data.sessions : [];

  // Map local hours → UTC keys, then extract histograms
  const now = new Date();
  const y = now.getFullYear(), mo = now.getMonth(), d = now.getDate();
  let maxConcurrent = 0;
  let totalAgentMinutes = 0;
  let concurrentMinutes = 0;

  for (let h = 0; h < 24; h++) {
    const t = new Date(y, mo, d, h, 0, 0);
    const utcDate = t.toISOString().slice(0, 10);
    const utcHour = t.getUTCHours();
    const key = `${utcDate}:${utcHour}`;
    const entry = data?.[key];
    if (!entry || typeof entry !== "object") continue;

    const histogram = entry.histogram || {};
    for (const [countStr, minutes] of Object.entries(histogram)) {
      const count = parseInt(countStr, 10);
      if (isNaN(count) || typeof minutes !== "number") continue;
      if (count > maxConcurrent) maxConcurrent = count;
      totalAgentMinutes += count * minutes;
      if (count > 1) concurrentMinutes += minutes;
    }
  }

  return { sessions, maxConcurrent, totalAgentMinutes, concurrentMinutes };
}

// ── Render the activity timeline ──

/**
 * Convert UTC-based daySessions entries to local-minute entries for today,
 * then render as a block-character timeline.
 */
function renderTimeline(sessions) {
  if (!sessions || sessions.length === 0) return null;

  // Convert UTC minutes to local minutes-since-midnight
  const now = new Date();
  const y = now.getFullYear(), mo = now.getMonth(), d = now.getDate();
  const localDayStart = new Date(y, mo, d, 0, 0, 0).getTime();
  const localDayEnd = new Date(y, mo, d, 23, 59, 59, 999).getTime();

  const localEntries = [];
  for (const e of sessions) {
    const utcDate = e.utcDate;
    if (!utcDate) continue;
    const [uy, um, ud] = utcDate.split("-").map(Number);
    const startMs = Date.UTC(uy, um - 1, ud, 0, e.start);
    const endMs = Date.UTC(uy, um - 1, ud, 0, e.end);

    const clampStart = Math.max(startMs, localDayStart);
    const clampEnd = Math.min(endMs, localDayEnd);
    if (clampStart > clampEnd) continue;

    const localStartMin = Math.floor((clampStart - localDayStart) / 60000);
    const localEndMin = Math.floor((clampEnd - localDayStart) / 60000);

    localEntries.push({
      ring: e.ring ?? 0,
      start: localStartMin,
      end: localEndMin,
      tokens: e.tokens || 0,
    });
  }

  if (localEntries.length === 0) return null;

  const maxRing = Math.max(...localEntries.map(e => e.ring));
  const maxTokens = Math.max(...localEntries.map(e => e.tokens), 1);

  const WIDTH = 48;
  const lines = [];

  for (let ring = maxRing; ring >= 0; ring--) {
    const ringEntries = localEntries.filter(e => e.ring === ring);
    const timeline = new Array(WIDTH).fill(" ");

    for (const entry of ringEntries) {
      const startCol = Math.floor((entry.start / 1440) * WIDTH);
      const endCol = Math.min(Math.floor((entry.end / 1440) * WIDTH), WIDTH - 1);
      const block = intensityBlock(entry.tokens, maxTokens);
      for (let c = startCol; c <= endCol; c++) {
        if (BLOCKS.indexOf(block) > BLOCKS.indexOf(timeline[c])) {
          timeline[c] = block;
        }
      }
    }

    const label = `A${ring + 1}`;
    lines.push(`  ${label.padStart(2)} |${timeline.join("")}|`);
  }

  const axis = "0h".padEnd(12) + "6h".padEnd(12) + "12h".padEnd(12) + "18h".padEnd(12);
  lines.push(`      ${axis}`);

  return lines;
}

/** Return the UTC YYYY-MM-DD date(s) that cover the given local day */
function utcDatesForLocalDay(localDate) {
  const y = localDate.getFullYear(), mo = localDate.getMonth(), d = localDate.getDate();
  const startUTC = new Date(y, mo, d, 0, 0, 0).toISOString().slice(0, 10);
  const endUTC = new Date(y, mo, d, 23, 59, 59).toISOString().slice(0, 10);
  const dates = [startUTC];
  if (endUTC !== startUTC) dates.push(endUTC);
  return dates;
}

// ── Render function (exported for MCP server) ──

export async function renderProfile() {
  const config = loadOrCreateIdentity();
  const hash = getLookupHash(config);

  // Load local stats for today's tokens/cost
  let stats;
  try { stats = loadStats(); } catch { stats = null; }

  const tokens = todayTokensFromStats(stats);
  const cost = todayCostFromStats(stats);

  // Fetch remote data
  const now = new Date();
  const localDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const utcDates = utcDatesForLocalDay(now);

  const [profile, dailyRanks] = await Promise.all([
    fetchUserProfile(hash),
    fetchDailyRanks(hash, utcDates[0]).catch(() => ({})),
  ]);

  // Fetch concurrency for each UTC date that overlaps the local day, then merge
  const concResults = await Promise.all(
    utcDates.map(d => fetchConcurrency(hash, d).catch(() => ({})))
  );
  let concurrency = Object.assign({}, ...concResults);
  const allSessions = [];
  for (const r of concResults) {
    if (Array.isArray(r?.sessions)) allSessions.push(...r.sessions);
  }
  concurrency.sessions = allSessions;

  const m = profile.metrics || profile;
  const username = config.username || profile.username || "Anonymous";
  const ranks = profile.ranks || {};
  const weightedRank = ranks.weighted;

  // Parse concurrency (API) for histogram stats only
  const cStats = parseConcurrencyResponse(concurrency, null);

  // Use local daySessions for the timeline (always fresh)
  const daySessions = stats?.daySessions || {};
  const now2 = new Date();
  const utcDatesLocal = utcDatesForLocalDay(now2);
  const localSessions = [];
  for (const utcDate of utcDatesLocal) {
    if (daySessions[utcDate]) {
      for (const s of daySessions[utcDate]) {
        localSessions.push({ ...s, utcDate });
      }
    }
  }

  // ── Build output ──
  const out = [];

  // Header
  const rankBit = weightedRank
    ? `  ${fmtRank(weightedRank.rank)} globally · top ${weightedRank.percentile.toFixed(1)}%`
    : "";
  out.push(`## Claude Rank  @${username}${rankBit}`);
  out.push(`Profile: https://www.clauderank.com/profile.html?username=${encodeURIComponent(username)}`);
  out.push("");

  // Today summary
  out.push(`### Today`);
  out.push(`${fmtTokens(tokens)} tokens burned · ~${cost} est. cost`);
  out.push("");

  // Activity timeline (from local stats, not API)
  if (localSessions.length > 0) {
    out.push("### Agent Activity");
    out.push(`\`\`\``);
    const tLines = renderTimeline(localSessions);
    if (tLines) {
      for (const l of tLines) out.push(l);
    }
    out.push(`\`\`\``);
    out.push("");
  }

  // Concurrency stats
  const peak = cStats.maxConcurrent > 0 ? `${cStats.maxConcurrent}x` : "—";
  const agentTime = cStats.totalAgentMinutes > 0 ? fmtAgentHours(cStats.totalAgentMinutes) : "—";
  const overlap = cStats.concurrentMinutes > 0 ? fmtAgentHours(cStats.concurrentMinutes) : "—";
  out.push(`Peak: ${peak} concurrent · ${agentTime} total agent time · ${overlap} overlap`);

  // Daily ranks if available
  const dr = dailyRanks?.ranks || {};
  const drEntries = Object.entries(dr);
  if (drEntries.length > 0) {
    const labels = {
      daily_tokens: "Tokens", daily_spend: "Spend", peak_concurrency: "Concurrency",
      active_mins: "Active Time", concurrent_mins: "Overlap Time",
    };
    const parts = drEntries
      .filter(([, r]) => r != null)
      .map(([key, r]) =>
        `${fmtRank(r.rank)} ${labels[key] || key} (top ${r.percentile.toFixed(1)}%)`
      );
    out.push(`Daily: ${parts.join(" · ")}`);
  }

  return out.join("\n");
}

// ── Main (backward compat for direct node execution) ──

async function main() {
  try {
    console.log(await renderProfile());
  } catch {
    console.log("## Claude Rank Profile\n\nUnable to fetch profile. Make sure you've synced at least once.");
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
