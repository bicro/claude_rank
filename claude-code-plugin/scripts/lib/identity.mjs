import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { homedir } from "os";

const CLAUDE_RANK_DIR = join(homedir(), ".ClaudeRank");
const CONFIG_PATH = join(CLAUDE_RANK_DIR, "ranking.json");

const DEFAULT_SYNC_SETTINGS = {
  tokens: true,
  messages: true,
  sessions: true,
  tool_calls: true,
  prompts: false,
  prompt_hashes: true,
  daily_breakdown: true,
  model_names: true,
  hour_activity: true,
  concurrency_activity: true,
};

export function loadOrCreateIdentity() {
  try {
    const data = readFileSync(CONFIG_PATH, "utf-8");
    const config = JSON.parse(data);
    if (config.user_hash) {
      // Ensure sync_settings has defaults
      config.sync_settings = { ...DEFAULT_SYNC_SETTINGS, ...config.sync_settings };
      return config;
    }
  } catch {
    // File doesn't exist or is invalid — create new identity
  }

  mkdirSync(CLAUDE_RANK_DIR, { recursive: true });

  const config = {
    user_hash: randomUUID(),
    sync_secret: randomUUID(),
    username: null,
    team_hash: null,
    team_name: null,
    sync_settings: { ...DEFAULT_SYNC_SETTINGS },
    last_synced: null,
    primary_hash: null,
  };

  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  return config;
}

export function saveIdentity(config) {
  mkdirSync(CLAUDE_RANK_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

/** Returns the hash to use for API lookups (primary_hash if linked, else user_hash) */
export function getLookupHash(config) {
  return config.primary_hash ?? config.user_hash;
}

export { CLAUDE_RANK_DIR, CONFIG_PATH };
