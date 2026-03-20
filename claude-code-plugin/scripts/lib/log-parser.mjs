import { readFileSync, writeFileSync, readdirSync } from "fs";
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

const IDLE_THRESHOLD_SECS = 300;

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
  const sessions = [];    // collected session data for concurrency analysis

  let jsonlFiles;
  try {
    jsonlFiles = findJsonlFiles(CLAUDE_DIR);
  } catch {
    return finalizeStats(stats, dailyMap, dailyTokens);
  }

  for (const { path: filePath, isSubagent } of jsonlFiles) {
    try {
      const session = parseJsonlFile(filePath, stats, dailyMap, dailyTokens, isSubagent);
      if (session) sessions.push(session);
    } catch {
      // Skip malformed files
    }
  }

  // Compute concurrency data from collected sessions
  stats.concurrencyHistogram = computeConcurrencyHistogram(sessions);
  stats.daySessions = computeDaySessions(sessions);

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

/**
 * Find all .jsonl files. Returns array of { path, isSubagent }.
 * Files inside a "subagents" directory are marked as subagent sessions.
 */
function findJsonlFiles(dir, insideSubagents = false) {
  const files = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        const isSub = insideSubagents || entry.name === "subagents";
        files.push(...findJsonlFiles(fullPath, isSub));
      } else if (entry.name.endsWith(".jsonl")) {
        files.push({ path: fullPath, isSubagent: insideSubagents });
      }
    }
  } catch {
    // Permission errors, etc.
  }
  return files;
}

function parseJsonlFile(filePath, stats, dailyMap, dailyTokens, isSubagent = false) {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n").filter(Boolean);

  if (lines.length === 0) return null;

  stats.totalSessions++;
  let sessionMessages = 0;
  let sessionToolCalls = 0;
  let timestamps = [];
  let userTimestamps = [];
  let sessionTokens = 0;
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
      if (ts) userTimestamps.push(ts);

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
          sessionTokens += totalTok;
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

  // Return session data for concurrency analysis
  return {
    timestamps,
    userTimestamps,
    isMain: !isSubagent,
    tokens: sessionTokens,
    messages: sessionMessages,
  };
}

/**
 * Split sorted timestamps into active segments at gaps > IDLE_THRESHOLD_SECS.
 * Returns array of [segStart, segEnd] Date pairs.
 */
function computeActiveSegments(timestamps) {
  if (timestamps.length === 0) return [];

  const sorted = [...timestamps].sort((a, b) => a.getTime() - b.getTime());
  const segments = [];
  let segStart = sorted[0];
  let segEnd = sorted[0];

  for (let i = 1; i < sorted.length; i++) {
    const gap = (sorted[i].getTime() - segEnd.getTime()) / 1000;
    if (gap > IDLE_THRESHOLD_SECS) {
      segments.push([segStart, segEnd]);
      segStart = sorted[i];
    }
    segEnd = sorted[i];
  }
  segments.push([segStart, segEnd]);
  return segments;
}

/**
 * Compute concurrency histogram: for each hour with activity, count how many
 * main sessions have an active segment overlapping each minute.
 * Returns { "YYYY-MM-DD:H": { sessionCount: minutes } }
 */
function computeConcurrencyHistogram(sessions) {
  const histogram = {};

  // Only main sessions with >= 2 timestamps
  const mainSegments = sessions
    .filter(s => s.isMain && s.timestamps.length >= 2)
    .map(s => computeActiveSegments(s.timestamps))
    .filter(segs => segs.length > 0);

  if (mainSegments.length === 0) return histogram;

  // Collect all unique hours with activity
  const hoursWithActivity = new Set();
  for (const segments of mainSegments) {
    for (const [segStart, segEnd] of segments) {
      // Walk hour by hour from segStart to segEnd
      const startMs = new Date(segStart);
      startMs.setUTCMinutes(0, 0, 0);
      let current = startMs.getTime();
      const endMs = segEnd.getTime();
      while (current <= endMs) {
        const d = new Date(current);
        const hourKey = `${d.toISOString().slice(0, 10)}:${d.getUTCHours()}`;
        hoursWithActivity.add(hourKey);
        current += 3600000; // 1 hour
      }
    }
  }

  // For each hour, check concurrency per minute
  for (const hourKey of hoursWithActivity) {
    const lastColon = hourKey.lastIndexOf(":");
    const dateStr = hourKey.slice(0, lastColon);
    const hour = parseInt(hourKey.slice(lastColon + 1), 10);

    const hourStartMs = new Date(`${dateStr}T00:00:00Z`).getTime() + hour * 3600000;
    const minuteCounts = {};

    for (let minute = 0; minute < 60; minute++) {
      const minStart = hourStartMs + minute * 60000;
      const minEnd = minStart + 60000;

      let concurrent = 0;
      for (const segments of mainSegments) {
        for (const [segStart, segEnd] of segments) {
          if (segStart.getTime() < minEnd && segEnd.getTime() >= minStart) {
            concurrent++;
            break; // count this session once
          }
        }
      }

      if (concurrent > 0) {
        minuteCounts[concurrent] = (minuteCounts[concurrent] || 0) + 1;
      }
    }

    if (Object.keys(minuteCounts).length > 0) {
      histogram[hourKey] = minuteCounts;
    }
  }

  return histogram;
}

/**
 * Compute day sessions with greedy ring assignment.
 * Returns { "YYYY-MM-DD": [{ ring, start, end, tokens, messages }] }
 */
function computeDaySessions(sessions) {
  const daySpans = {}; // date -> [{ start_min, end_min, tokens, messages }]

  for (const session of sessions) {
    if (!session.isMain || session.timestamps.length < 2 || session.messages === 0) {
      continue;
    }

    const segments = computeActiveSegments(session.timestamps);
    if (segments.length === 0) continue;

    // Group segments by UTC date
    const dateSegments = {};
    for (const [segStart, segEnd] of segments) {
      const startDate = segStart.toISOString().slice(0, 10);
      const endDate = segEnd.toISOString().slice(0, 10);

      if (startDate === endDate) {
        const startMin = segStart.getUTCHours() * 60 + segStart.getUTCMinutes();
        const endMin = segEnd.getUTCHours() * 60 + segEnd.getUTCMinutes();
        if (!dateSegments[startDate]) dateSegments[startDate] = [];
        dateSegments[startDate].push([startMin, Math.max(endMin, startMin)]);
      } else {
        // Spans midnight: split
        const startMin = segStart.getUTCHours() * 60 + segStart.getUTCMinutes();
        if (!dateSegments[startDate]) dateSegments[startDate] = [];
        dateSegments[startDate].push([startMin, 1439]);

        const endMin = segEnd.getUTCHours() * 60 + segEnd.getUTCMinutes();
        if (!dateSegments[endDate]) dateSegments[endDate] = [];
        dateSegments[endDate].push([0, endMin]);
      }
    }

    // Compute tokens and messages per date from user timestamps
    const dateMessages = {};
    for (const ts of session.userTimestamps) {
      const date = ts.toISOString().slice(0, 10);
      dateMessages[date] = (dateMessages[date] || 0) + 1;
    }

    // Distribute tokens/messages across segments per date
    for (const [date, segs] of Object.entries(dateSegments)) {
      const segCount = Math.max(segs.length, 1);
      const tokPerSeg = Math.floor(session.tokens / segCount);
      const msgPerSeg = Math.floor((dateMessages[date] || 0) / segCount);

      if (!daySpans[date]) daySpans[date] = [];
      for (const [startMin, endMin] of segs) {
        daySpans[date].push({
          start_min: startMin,
          end_min: Math.max(endMin, startMin),
          tokens: tokPerSeg,
          messages: msgPerSeg,
        });
      }
    }
  }

  // Greedy ring assignment per date
  const result = {};
  for (const [date, spans] of Object.entries(daySpans)) {
    spans.sort((a, b) => a.start_min - b.start_min);

    const ringEnds = []; // ringEnds[i] = end minute of last span on ring i
    const entries = [];

    for (const span of spans) {
      let assignedRing = -1;
      for (let i = 0; i < ringEnds.length; i++) {
        if (span.start_min > ringEnds[i]) {
          assignedRing = i;
          break;
        }
      }

      let ring;
      if (assignedRing >= 0) {
        ring = assignedRing;
        ringEnds[ring] = span.end_min;
      } else {
        ring = ringEnds.length;
        ringEnds.push(span.end_min);
      }

      entries.push({
        ring,
        start: span.start_min,
        end: span.end_min,
        tokens: span.tokens,
        messages: span.messages,
      });
    }

    if (entries.length > 0) {
      result[date] = entries;
    }
  }

  return result;
}
