#!/usr/bin/env node
import { readFileSync, writeFileSync, statSync } from "fs";
import { join } from "path";
import { loadOrCreateIdentity, getLookupHash, CLAUDE_RANK_DIR } from "./lib/identity.mjs";
import { fetchUserProfile } from "./lib/api.mjs";
import { fmtTokens, estimateCost } from "./lib/format.mjs";
import { loadStats } from "./lib/log-parser.mjs";

const PROFILE_CACHE = join(CLAUDE_RANK_DIR, "profile-cache.json");
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const STATS_CACHE_PATH = join(CLAUDE_RANK_DIR, "stats-cache.json");
const STALE_THRESHOLD_MS = 90 * 1000; // 90 seconds

// ── ANSI helpers ──
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const ORANGE = "\x1b[38;5;208m";
const CYAN = "\x1b[36m";

function loadCachedProfile() {
  try {
    const raw = readFileSync(PROFILE_CACHE, "utf-8");
    const cached = JSON.parse(raw);
    if (Date.now() - (cached._ts || 0) < CACHE_TTL_MS) {
      return cached;
    }
  } catch {}
  return null;
}

function saveCachedProfile(profile) {
  try {
    writeFileSync(PROFILE_CACHE, JSON.stringify({ ...profile, _ts: Date.now() }));
  } catch {}
}

/**
 * Load stats from cache if fresh, otherwise fall back to parsing JSONL directly.
 */
function loadStatsData() {
  // Try stats-cache.json (written by Stop hook after every turn)
  try {
    const st = statSync(STATS_CACHE_PATH);
    const ageMs = Date.now() - st.mtimeMs;

    if (ageMs < STALE_THRESHOLD_MS) {
      const raw = readFileSync(STATS_CACHE_PATH, "utf-8");
      const cache = JSON.parse(raw);
      return cache.stats || cache;
    }
  } catch {
    // No cache or can't stat — fall through
  }

  // Fallback: parse JSONL directly (also writes fresh cache)
  try {
    return loadStats();
  } catch {
    return null;
  }
}

/** Compute today's tokens from hour_tokens in stats */
function todayTokens(stats) {
  const hourTokens = stats?.hourTokens || {};
  const now = new Date();
  const localYear = now.getFullYear();
  const localMonth = now.getMonth();
  const localDate = now.getDate();

  let total = 0;
  for (let h = 0; h < 24; h++) {
    const localHour = new Date(localYear, localMonth, localDate, h, 0, 0);
    const utcDate = localHour.toISOString().slice(0, 10);
    const utcHour = localHour.getUTCHours();
    const key = `${utcDate}:${utcHour}`;
    total += hourTokens[key] || 0;
  }
  return total;
}

/** Estimate today's cost from today's model token usage */
function todayCost(stats) {
  const dailyModelTokens = stats?.dailyModelTokens || [];
  const modelUsage = stats?.modelUsage || {};

  const now = new Date();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

  const todayEntry = dailyModelTokens.find(d => d.date === todayStr);
  if (!todayEntry) return "$0";

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

// ── Emoji timeline ──
const DOT_NONE = "⚪";
const DOT_LOW  = "🟡";
const DOT_MED  = "🟠";
const DOT_HIGH = "🔴";

/** Intensity based on active minutes per hour, matching website logic */
function intensityDot(minutes) {
  if (minutes <= 0) return DOT_NONE;
  const intensity = Math.min(minutes / 60, 1);
  if (intensity > 0.66) return DOT_HIGH;
  if (intensity > 0.33) return DOT_MED;
  return DOT_LOW;
}

/** Get UTC dates that overlap the local day */
function utcDatesForLocalDay(now) {
  const y = now.getFullYear(), mo = now.getMonth(), d = now.getDate();
  const startUTC = new Date(y, mo, d, 0, 0, 0).toISOString().slice(0, 10);
  const endUTC = new Date(y, mo, d, 23, 59, 59).toISOString().slice(0, 10);
  const dates = [startUTC];
  if (endUTC !== startUTC) dates.push(endUTC);
  return dates;
}

/**
 * Build per-ring, per-local-hour active-minutes from daySessions.
 * Each session span contributes its duration in minutes to the hours it covers.
 */
function buildLocalHourSlots(daySessions) {
  const now = new Date();
  const utcDates = utcDatesForLocalDay(now);

  const entries = [];
  for (const utcDate of utcDates) {
    const dayEntries = daySessions[utcDate];
    if (!dayEntries) continue;
    for (const e of dayEntries) {
      entries.push({ ...e, utcDate });
    }
  }

  if (entries.length === 0) return null;

  const y = now.getFullYear(), mo = now.getMonth(), d = now.getDate();
  const localDayStart = new Date(y, mo, d, 0, 0, 0).getTime();
  const localDayEnd = new Date(y, mo, d, 23, 59, 59, 999).getTime();

  let maxRing = 0;
  const slots = {}; // ring -> hour -> active minutes

  for (const e of entries) {
    const [uy, um, ud] = e.utcDate.split("-").map(Number);

    const startMs = Date.UTC(uy, um - 1, ud, 0, e.start);
    const endMs = Date.UTC(uy, um - 1, ud, 0, e.end);

    const clampStart = Math.max(startMs, localDayStart);
    const clampEnd = Math.min(endMs, localDayEnd);
    if (clampStart > clampEnd) continue;

    const ring = e.ring ?? 0;
    if (ring > maxRing) maxRing = ring;
    if (!slots[ring]) slots[ring] = new Array(24).fill(0);

    // Distribute active minutes across local hours
    const startHour = new Date(clampStart).getHours();
    const endHour = new Date(clampEnd).getHours();

    for (let h = startHour; h <= endHour; h++) {
      const hourStart = new Date(y, mo, d, h, 0, 0).getTime();
      const hourEnd = new Date(y, mo, d, h, 59, 59, 999).getTime();
      const overlapStart = Math.max(clampStart, hourStart);
      const overlapEnd = Math.min(clampEnd, hourEnd);
      const mins = Math.max((overlapEnd - overlapStart) / 60000, 1);
      slots[ring][h] += mins;
    }
  }

  return { slots, maxRing };
}

/** Format hour as "12 am", "3 pm", etc. */
function fmtHour(h) {
  if (h === 0) return "12 am";
  if (h === 12) return "12 pm";
  return h < 12 ? `${h} am` : `${h - 12} pm`;
}

/** Render emoji timeline rows */
function renderTimeline(daySessions) {
  const result = buildLocalHourSlots(daySessions);
  if (!result) return null;

  const { slots, maxRing } = result;
  const now = new Date();
  const currentHour = now.getHours();

  const lines = [];
  for (let r = maxRing; r >= 0; r--) {
    const hourData = slots[r] || new Array(24).fill(0);
    const dots = [];
    for (let h = 0; h < 24; h++) {
      dots.push(intensityDot(hourData[h]));
    }
    // Insert current time marker after the current hour's dot
    dots.splice(currentHour + 1, 0, `${DIM}│${RESET}`);

    const label = `A${r + 1}`;
    lines.push(`  ${DIM}${label}${RESET}  ${dots.join("")}`);
  }

  // Current time label positioned under the marker
  // Prefix "  A1  " = 6 chars. Emojis are typically 2 columns wide.
  // Marker is after dot[currentHour], so col = 6 + (currentHour + 1) * 2
  const timeLabel = fmtHour(currentHour);
  const markerCol = 6 + (currentHour + 1) * 2;
  // Center the label under the marker
  const labelStart = Math.max(0, markerCol - Math.floor(timeLabel.length / 2));
  lines.push(`${DIM}${" ".repeat(labelStart)}${timeLabel}${RESET}`);

  return lines;
}

async function main() {
  const config = loadOrCreateIdentity();
  const hash = getLookupHash(config);

  let profile = loadCachedProfile();
  if (!profile) {
    try {
      profile = await fetchUserProfile(hash);
      saveCachedProfile(profile);
    } catch {
      console.log("Claude Rank");
      return;
    }
  }

  const m = profile.metrics || profile;
  const rank = profile.ranks?.weighted?.rank;
  const streak = m.current_streak ?? 0;

  const stats = loadStatsData();
  const tokens = todayTokens(stats);
  const cost = todayCost(stats);
  const tokenStr = tokens > 0 ? fmtTokens(tokens) : "0";

  const parts = [];
  parts.push(`${DIM}──${RESET} ${BOLD}${ORANGE}Claude Rank${RESET} ${DIM}──${RESET}`);
  if (rank) parts.push(`${CYAN}#${rank} Globally${RESET}`);
  if (streak > 0) parts.push(`🔥${streak}d`);
  parts.push(`${ORANGE}⚡ ${tokenStr}${RESET} tokens today`);
  parts.push(`~${cost}`);

  const output = [parts.join(` ${DIM}│${RESET} `)];

  // Add timeline if we have daySessions data
  const daySessions = stats?.daySessions;
  if (daySessions && Object.keys(daySessions).length > 0) {
    const timeline = renderTimeline(daySessions);
    if (timeline) {
      output.push(" "); // slight gap — space char so terminal doesn't collapse the line
      output.push(...timeline);
    }
  }

  console.log(output.join("\n"));
}

main();
