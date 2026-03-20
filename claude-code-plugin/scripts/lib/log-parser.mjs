import { readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import { homedir } from "os";
import { CLAUDE_RANK_DIR } from "./identity.mjs";

const CLAUDE_DIR = join(homedir(), ".claude", "projects");
const STATS_CACHE_PATH = join(CLAUDE_RANK_DIR, "stats-cache.json");

/**
 * Always parse JSONL logs and write fresh stats-cache.json.
 * Returns the computed stats object.
 */
export function loadStats() {
  const stats = parseAllLogs();

  // Always write fresh cache
  try {
    writeFileSync(STATS_CACHE_PATH, JSON.stringify(stats, null, 2));
  } catch {
    // Non-critical
  }

  return stats;
}

function parseAllLogs() {
  const stats = {
    version: 5,
    lastComputedDate: new Date().toISOString().slice(0, 10),
    dailyActivity: [],
    dailyModelTokens: [],
    modelUsage: {},
    totalSessions: 0,
    totalMessages: 0,
    longestSession: null,
    firstSessionDate: null,
    hourCounts: {},
    hourTokens: {},
    totalSessionTimeSecs: 0,
    totalActiveTimeSecs: 0,
    totalIdleTimeSecs: 0,
    daySessions: {},
    concurrencyHistogram: {},
    promptHashes: [],
    toolNames: new Set(),
  };

  const dailyMap = {};    // date -> { messageCount, sessionCount, toolCallCount }
  const dailyTokens = {}; // date -> { model -> totalTokens }

  let jsonlFiles;
  try {
    jsonlFiles = findJsonlFiles(CLAUDE_DIR);
  } catch {
    return finalizeStats(stats, dailyMap, dailyTokens);
  }

  for (const filePath of jsonlFiles) {
    try {
      parseJsonlFile(filePath, stats, dailyMap, dailyTokens);
    } catch {
      // Skip malformed files
    }
  }

  return finalizeStats(stats, dailyMap, dailyTokens);
}

function finalizeStats(stats, dailyMap, dailyTokens) {
  // Convert daily maps to arrays
  stats.dailyActivity = Object.entries(dailyMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, d]) => ({ date, ...d }));

  stats.dailyModelTokens = Object.entries(dailyTokens)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, tokensByModel]) => ({ date, tokensByModel }));

  // Set first session date
  if (stats.dailyActivity.length > 0) {
    stats.firstSessionDate = stats.dailyActivity[0].date;
  }

  // Compute streak from daily activity dates
  stats.currentStreak = computeStreak(stats.dailyActivity.map(d => d.date));

  // Compute points and level
  const { points, level } = computePointsAndLevel(stats);
  stats.totalPoints = points;
  stats.level = level;

  // Convert toolNames Set to sorted array
  stats.toolNames = [...stats.toolNames].sort();

  return stats;
}

/**
 * Compute consecutive-day streak ending at today (or yesterday).
 */
function computeStreak(dates) {
  if (dates.length === 0) return 0;

  const dateSet = new Set(dates);
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);

  // Start from today or yesterday
  let current = new Date(today);
  let currentStr = todayStr;

  if (!dateSet.has(currentStr)) {
    // Check yesterday
    current.setDate(current.getDate() - 1);
    currentStr = current.toISOString().slice(0, 10);
    if (!dateSet.has(currentStr)) return 0;
  }

  let streak = 0;
  while (dateSet.has(currentStr)) {
    streak++;
    current.setDate(current.getDate() - 1);
    currentStr = current.toISOString().slice(0, 10);
  }

  return streak;
}

/**
 * Compute points and level using weighted scoring (matches server formula).
 * Points = weighted_score / 1000, Level = floor(log2(points + 1))
 */
function computePointsAndLevel(stats) {
  let totalTokens = 0;
  for (const usage of Object.values(stats.modelUsage || {})) {
    totalTokens += (usage.inputTokens || 0) + (usage.outputTokens || 0) +
                   (usage.cacheReadInputTokens || 0) + (usage.cacheCreationInputTokens || 0);
  }

  const totalMessages = stats.totalMessages || 0;
  const totalSessions = stats.totalSessions || 0;
  const totalToolCalls = (stats.dailyActivity || []).reduce((s, d) => s + (d.toolCallCount || 0), 0);
  const totalActiveTimeSecs = stats.totalActiveTimeSecs || 0;

  // Weighted score (matches server weights)
  const weightedScore =
    totalTokens * 1.0 +
    totalMessages * 100 +
    totalSessions * 500 +
    totalToolCalls * 50 +
    totalActiveTimeSecs * 2;

  const points = Math.floor(weightedScore / 1000);
  const level = points > 0 ? Math.floor(Math.log2(points + 1)) : 0;

  return { points, level };
}

function findJsonlFiles(dir) {
  const files = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...findJsonlFiles(fullPath));
      } else if (entry.name.endsWith(".jsonl")) {
        files.push(fullPath);
      }
    }
  } catch {
    // Permission errors, etc.
  }
  return files;
}

function parseJsonlFile(filePath, stats, dailyMap, dailyTokens) {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n").filter(Boolean);

  if (lines.length === 0) return;

  stats.totalSessions++;
  let sessionMessages = 0;
  let sessionToolCalls = 0;
  let timestamps = [];
  let firstUserMsg = null;

  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const type = entry.type;
    const ts = entry.timestamp ? new Date(entry.timestamp) : null;
    const date = ts ? ts.toISOString().slice(0, 10) : null;
    const msg = entry.message;

    if (ts) timestamps.push(ts);

    if (type === "user") {
      stats.totalMessages++;
      sessionMessages++;

      // Track first user message for prompt hash
      if (!firstUserMsg && msg?.content) {
        firstUserMsg = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      }

      if (date) {
        if (!dailyMap[date]) dailyMap[date] = { messageCount: 0, sessionCount: 0, toolCallCount: 0 };
        dailyMap[date].messageCount++;

        // Hour counts
        const hour = ts.getUTCHours();
        const hourKey = `${date}:${hour}`;
        stats.hourCounts[hourKey] = (stats.hourCounts[hourKey] || 0) + 1;
      }
    }

    if (type === "assistant" && msg) {
      // Count tool uses and collect tool names
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "tool_use") {
            sessionToolCalls++;
            if (block.name) {
              stats.toolNames.add(block.name);
            }
            if (date) {
              if (!dailyMap[date]) dailyMap[date] = { messageCount: 0, sessionCount: 0, toolCallCount: 0 };
              dailyMap[date].toolCallCount++;
            }
          }
        }
      }

      // Token usage
      if (msg.usage) {
        const model = msg.model || "unknown";
        if (!stats.modelUsage[model]) {
          stats.modelUsage[model] = {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          };
        }
        const u = stats.modelUsage[model];
        u.inputTokens += msg.usage.input_tokens || 0;
        u.outputTokens += msg.usage.output_tokens || 0;
        u.cacheReadInputTokens += msg.usage.cache_read_input_tokens || 0;
        u.cacheCreationInputTokens += msg.usage.cache_creation_input_tokens || 0;

        // Daily model tokens
        if (date) {
          const totalTok = (msg.usage.input_tokens || 0) + (msg.usage.output_tokens || 0) +
                          (msg.usage.cache_read_input_tokens || 0) + (msg.usage.cache_creation_input_tokens || 0);
          if (!dailyTokens[date]) dailyTokens[date] = {};
          dailyTokens[date][model] = (dailyTokens[date][model] || 0) + totalTok;

          // Hour tokens
          const hour = ts.getUTCHours();
          const hourKey = `${date}:${hour}`;
          stats.hourTokens[hourKey] = (stats.hourTokens[hourKey] || 0) + totalTok;
        }
      }
    }
  }

  // Compute prompt hash for this session
  if (firstUserMsg) {
    const hash = createHash("sha256").update(firstUserMsg).digest("hex");
    stats.promptHashes.push(hash);
  }

  // Mark session in daily activity
  if (timestamps.length > 0) {
    const firstDate = timestamps[0].toISOString().slice(0, 10);
    if (!dailyMap[firstDate]) dailyMap[firstDate] = { messageCount: 0, sessionCount: 0, toolCallCount: 0 };
    dailyMap[firstDate].sessionCount++;

    // Session time
    const start = timestamps[0].getTime();
    const end = timestamps[timestamps.length - 1].getTime();
    const durationSecs = Math.floor((end - start) / 1000);
    stats.totalSessionTimeSecs += durationSecs;

    // Active/idle time (idle = gaps > 5 min)
    let activeTime = 0;
    let idleTime = 0;
    for (let i = 1; i < timestamps.length; i++) {
      const gap = (timestamps[i].getTime() - timestamps[i - 1].getTime()) / 1000;
      if (gap > 300) {
        idleTime += gap;
      } else {
        activeTime += gap;
      }
    }
    stats.totalActiveTimeSecs += activeTime;
    stats.totalIdleTimeSecs += idleTime;
  }
}
