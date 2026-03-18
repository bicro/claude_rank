#!/usr/bin/env node
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { loadOrCreateIdentity, getLookupHash, CLAUDE_RANK_DIR } from "./lib/identity.mjs";
import { fetchUserProfile } from "./lib/api.mjs";
import { fmtTokens, fmtNum, getTier, tierEmoji, estimateCost } from "./lib/format.mjs";

const PROFILE_CACHE = join(CLAUDE_RANK_DIR, "profile-cache.json");
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const STATS_CACHE_PATH = join(CLAUDE_RANK_DIR, "stats-cache.json");

// ── ANSI helpers ──
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const ORANGE = "\x1b[38;5;208m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
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

/** Compute today's tokens from hour_tokens in stats cache (matches desktop Rust logic) */
function todayTokens() {
  try {
    const raw = readFileSync(STATS_CACHE_PATH, "utf-8");
    const stats = JSON.parse(raw);
    const hourTokens = stats.hourTokens || {};

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
  } catch {
    return 0;
  }
}

/** Estimate today's cost from today's model token usage */
function todayCost() {
  try {
    const raw = readFileSync(STATS_CACHE_PATH, "utf-8");
    const stats = JSON.parse(raw);
    const dailyModelTokens = stats.dailyModelTokens || [];
    const modelUsage = stats.modelUsage || {};

    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

    // Find today's entry
    const todayEntry = dailyModelTokens.find(d => d.date === todayStr);
    if (!todayEntry) return "$0";

    // Build a rough model usage for today only
    // We don't have per-day breakdown by token type, so estimate from total ratios
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
  } catch {
    return "$0";
  }
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
  const level = m.level ?? 0;
  const tier = getTier(level);
  const emoji = tierEmoji(level);
  const rank = profile.ranks?.weighted?.rank;
  const streak = m.current_streak ?? 0;
  const points = fmtNum(m.total_points ?? 0);

  const tokens = todayTokens();
  const cost = todayCost();

  // Line 1: Identity — level, tier, rank, streak, points
  const parts = [];
  parts.push(`${emoji} ${BOLD}Lv.${level}${RESET} ${tier}`);
  if (rank) parts.push(`${CYAN}#${rank}${RESET}`);
  if (streak > 0) parts.push(`🔥${streak}d`);
  parts.push(`${DIM}${points} pts${RESET}`);
  console.log(parts.join("  "));

  // Line 2: Today's usage — tokens burned, est. cost
  const tokenStr = tokens > 0 ? fmtTokens(tokens) : "0";
  console.log(`${ORANGE}${tokenStr}${RESET} tokens today  ${DIM}${cost} est.${RESET}`);
}

main();
