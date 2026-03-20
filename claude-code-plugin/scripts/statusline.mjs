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
  console.log(parts.join(` ${DIM}│${RESET} `));
}

main();
