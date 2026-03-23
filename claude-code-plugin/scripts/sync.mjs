#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadOrCreateIdentity, saveIdentity, getLookupHash, CLAUDE_RANK_DIR } from "./lib/identity.mjs";
import { loadStats } from "./lib/log-parser.mjs";
import { postSync, fetchUserProfile } from "./lib/api.mjs";

const PROFILE_CACHE = join(CLAUDE_RANK_DIR, "profile-cache.json");

/** Floor all numeric values in a flat object */
function floorValues(obj) {
  const result = {};
  for (const [k, v] of Object.entries(obj)) {
    result[k] = typeof v === "number" ? Math.floor(v) : v;
  }
  return result;
}

/**
 * Build the sync payload from stats and config, then POST to the API.
 * Returns the API response on success, null on failure.
 */
export async function buildAndSync(config, stats) {
  // Compute totals from stats
  let totalTokens = 0;
  const tokenBreakdown = {};
  for (const [model, usage] of Object.entries(stats.modelUsage || {})) {
    const inp = usage.inputTokens || 0;
    const out = usage.outputTokens || 0;
    const cacheRead = usage.cacheReadInputTokens || 0;
    const cacheCreate = usage.cacheCreationInputTokens || 0;
    totalTokens += inp + out + cacheRead + cacheCreate;
    tokenBreakdown[model] = {
      input: Math.floor(inp),
      output: Math.floor(out),
      cache_read: Math.floor(cacheRead),
      cache_creation: Math.floor(cacheCreate),
    };
  }

  const totalToolCalls = (stats.dailyActivity || []).reduce((s, d) => s + (d.toolCallCount || 0), 0);

  // Build daily activity with tokenCount
  const dailyTokenTotals = {};
  for (const dmt of stats.dailyModelTokens || []) {
    dailyTokenTotals[dmt.date] = Object.values(dmt.tokensByModel || {}).reduce((s, v) => s + v, 0);
  }
  const dailyActivity = (stats.dailyActivity || []).map(da => ({
    date: da.date,
    messageCount: Math.floor(da.messageCount || 0),
    sessionCount: Math.floor(da.sessionCount || 0),
    toolCallCount: Math.floor(da.toolCallCount || 0),
    tokenCount: Math.floor(dailyTokenTotals[da.date] || 0),
  }));

  const payload = {
    user_hash: config.user_hash,
    sync_secret: config.sync_secret || "",
    sync_settings: config.sync_settings,
    totals: {
      total_tokens: Math.floor(totalTokens),
      total_messages: Math.floor(stats.totalMessages || 0),
      total_sessions: Math.floor(stats.totalSessions || 0),
      total_tool_calls: Math.floor(totalToolCalls),
      current_streak: stats.currentStreak || 0,
      total_points: stats.totalPoints || 0,
      level: stats.level || 0,
      total_session_time_secs: Math.floor(stats.totalSessionTimeSecs || 0),
      total_active_time_secs: Math.floor(stats.totalActiveTimeSecs || 0),
      total_idle_time_secs: Math.floor(stats.totalIdleTimeSecs || 0),
    },
    token_breakdown: tokenBreakdown,
    daily_activity: dailyActivity,
    hour_counts: floorValues(stats.hourCounts || {}),
    hour_tokens: floorValues(stats.hourTokens || {}),
    concurrency_histogram: stats.concurrencyHistogram || {},
    day_sessions: stats.daySessions || {},
    prompt_hashes: stats.promptHashes || null,
    prompts: null,
    tool_names: stats.toolNames || null,
  };

  const response = await postSync(payload);

  if (response) {
    config.last_synced = new Date().toISOString();
    if (response.primary_hash) config.primary_hash = response.primary_hash;
    saveIdentity(config);

    // Refresh profile cache for statusline
    try {
      const hash = getLookupHash(config);
      const profile = await fetchUserProfile(hash);
      writeFileSync(PROFILE_CACHE, JSON.stringify({ ...profile, _ts: Date.now() }));
    } catch {}
  }

  return response;
}

async function main() {
  const config = loadOrCreateIdentity();
  const stats = loadStats();

  try {
    const response = await buildAndSync(config, stats);

    if (response) {
      // Output result for hook consumers
      console.log(JSON.stringify({
        status: "synced",
        level: response.level,
        points: response.total_points,
        streak: response.current_streak,
        new_badges: response.new_badges || [],
        new_achievements: response.new_achievements || [],
      }));
    }
  } catch {
    // Silent failure for hook usage
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
