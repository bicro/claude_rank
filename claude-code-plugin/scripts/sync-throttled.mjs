#!/usr/bin/env node
/**
 * Throttled sync script for the Stop hook.
 * - Skips entirely if stats-cache was written <30s ago (avoids work on rapid turns)
 * - Parses JSONL and writes fresh stats-cache.json
 * - Only calls the API sync if 5+ minutes have passed since last sync
 */
import { statSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { loadOrCreateIdentity } from "./lib/identity.mjs";
import { loadStats } from "./lib/log-parser.mjs";
import { buildAndSync } from "./sync.mjs";

const STATS_CACHE_PATH = join(homedir(), ".ClaudeRank", "stats-cache.json");
const CACHE_MIN_AGE_MS = 30 * 1000;  // only re-parse every 30s
const SYNC_INTERVAL_MS = 5 * 60 * 1000; // API sync every 5 min

async function main() {
  // Quick exit: skip if cache was written recently
  try {
    const st = statSync(STATS_CACHE_PATH);
    if (Date.now() - st.mtimeMs < CACHE_MIN_AGE_MS) {
      return; // Cache is fresh enough, skip entirely
    }
  } catch {
    // No cache yet — continue
  }

  // Parse logs and write fresh cache
  const stats = loadStats();

  // Throttle API sync to every 5 minutes
  const config = loadOrCreateIdentity();
  const lastSynced = config.last_synced ? new Date(config.last_synced).getTime() : 0;

  if (Date.now() - lastSynced < SYNC_INTERVAL_MS) {
    return;
  }

  try {
    await buildAndSync(config, stats);
  } catch {
    // Silent
  }
}

main();
