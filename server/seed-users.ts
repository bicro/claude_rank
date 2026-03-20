/**
 * Seed script: creates 112 fake users across all tiers with realistic activity data.
 *
 * Usage:
 *   bun run server/seed-users.ts          # seed users (server must be running on localhost:3001)
 *   bun run server/seed-users.ts --clean  # delete all seed users from Postgres
 *
 * All fake user hashes use prefix "seed-" for easy cleanup:
 *   DELETE FROM user_metrics WHERE user_hash LIKE 'seed-%';
 *   DELETE FROM users WHERE user_hash LIKE 'seed-%';
 */

import pg from "pg";
import * as fs from "fs";
import * as path from "path";

// ─── Config ──────────────────────────────────────────────────────────────────

const API = "http://localhost:3001";
const SEED_PREFIX = "seed-";

// Load DATABASE_URL from .env.local
function loadEnv(): string {
  const envPath = path.resolve(import.meta.dir, "../.env.local");
  const content = fs.readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const eqIdx = trimmed.indexOf("=");
    const key = trimmed.substring(0, eqIdx);
    const val = trimmed.substring(eqIdx + 1);
    if (key === "DATABASE_URL") return val;
  }
  throw new Error("DATABASE_URL not found in .env.local");
}

const DATABASE_URL = loadEnv();
const isExternal = DATABASE_URL.includes(".oregon-postgres.render.com");
const PG_SSL = isExternal ? { rejectUnauthorized: false } : undefined;

// ─── Usernames ───────────────────────────────────────────────────────────────

const USERNAMES: [string, "M" | "F" | null][] = [
  // Diamond tier (5)
  ["sarah_chen", "F"], ["james_rodriguez", "M"], ["emily_nakamura", "F"], ["david_okonkwo", "M"], ["coderunner", null],
  // Platinum tier (12)
  ["michael_thompson", "M"], ["priya", "F"], ["lucas_ferreira", "M"], ["maria_gonzalez", "F"], ["kevin_liu", "M"],
  ["rachel_kim", "F"], ["omar_hassan", "M"], ["nightowl", null], ["daniel_wright", "M"], ["yuki_tanaka", "F"],
  ["devzero", null], ["ava_reyes", "F"],
  // Gold tier (22)
  ["alex42", null], ["nina_patel", "F"], ["chris_andersson", "M"], ["fatima_ali", "F"], ["rustfan", null],
  ["mei_wang", "F"], ["carlos_silva", "M"], ["hannah_becker", "F"], ["antonio_rossi", "M"], ["jessica_lee", "F"],
  ["kenji", "M"], ["aisha_mohammed", "F"], ["peter_novak", "M"], ["laura_martinez", "F"], ["tom_wilson", "M"],
  ["elena_volkov", "F"], ["bytewise", null], ["ananya_gupta", "F"], ["jason_park", "M"], ["claire_dubois", "F"],
  ["andrew_penn", "M"], ["sophie_kang", "F"],
  // Silver tier (33)
  ["sam_brown", "M"], ["rina_watanabe", "F"], ["jack_miller", "M"], ["alice", "F"], ["connor_o_brien", "M"],
  ["yara_santos", "F"], ["ethan_clark", "M"], ["zara_khan", "F"], ["sam99", null], ["mia_chang", "F"],
  ["oliver_scott", "M"], ["nadia_bergman", "F"], ["adam_white", "M"], ["dina_popov", "F"], ["max_fisher", "M"],
  ["amara_diallo", "F"], ["marco", "M"], ["hana_ito", "F"], ["ian_campbell", "M"], ["eva_horvat", "F"],
  ["tyler_reed", "M"], ["sana_malik", "F"], ["codex77", null], ["lena_schmidt", "F"], ["ross_walker", "M"],
  ["maya_reddy", "F"], ["shellguru", null], ["vera_sokolova", "F"], ["grant_young", "M"], ["iris_nakamura", "F"],
  ["owen_garcia", "M"], ["jade_moreau", "F"], ["dan_keller", "M"],
  // Bronze tier (40)
  ["amy_foster", "F"], ["ravi_nair", "M"], ["kate_hughes", "F"], ["diego_morales", "M"], ["pixelpunk", null],
  ["sean_kelly", "M"], ["tara_joshi", "F"], ["will_baker", "M"], ["nora_eriksson", "F"], ["leo_ricci", "M"],
  ["dana_cho", "F"], ["alan_price", "M"], ["mina_farah", "F"], ["brett_stewart", "M"], ["lisa_van_der_berg", "F"],
  ["arjun_rao", "M"], ["chloe_martin", "F"], ["stackflow", null], ["sonia_costa", "F"], ["kyle_nelson", "M"],
  ["phoebe_grant", "F"], ["raj_mehta", "M"], ["emma_larsson", "F"], ["frank_russo", "M"], ["lila_osman", "F"],
  ["marcus_reid", "M"], ["tina_wu", "F"], ["gavin_hayes", "M"], ["noor_abbasi", "F"], ["tokenizer", null],
  ["victor_cruz", "M"], ["amber_fox", "F"], ["simon_lam", "M"], ["beth_morgan", "F"], ["tariq_rahman", "M"],
  ["loopdev", null], ["vivian_tran", "F"], ["paul_magnusson", "M"], ["layla_bishop", "F"], ["henry_zhao", "M"],
];

// ─── Tier Definitions ────────────────────────────────────────────────────────

interface TierConfig {
  name: string;
  count: number;
  tokenMin: number;
  tokenMax: number;
  activityDaysMin: number;
  activityDaysMax: number;
  maxConcurrency: number;
  streakMax: number;
}

const TIERS: TierConfig[] = [
  { name: "Diamond",  count: 5,  tokenMin: 200_000,  tokenMax: 2_000_000, activityDaysMin: 10, activityDaysMax: 25, maxConcurrency: 3, streakMax: 5 },
  { name: "Platinum", count: 12, tokenMin: 100_000,  tokenMax: 1_000_000, activityDaysMin: 8,  activityDaysMax: 20, maxConcurrency: 2, streakMax: 4 },
  { name: "Gold",     count: 22, tokenMin: 50_000,   tokenMax: 500_000,   activityDaysMin: 5,  activityDaysMax: 15, maxConcurrency: 2, streakMax: 3 },
  { name: "Silver",   count: 33, tokenMin: 10_000,   tokenMax: 100_000,   activityDaysMin: 3,  activityDaysMax: 10, maxConcurrency: 1, streakMax: 2 },
  { name: "Bronze",   count: 40, tokenMin: 1_000,    tokenMax: 20_000,    activityDaysMin: 1,  activityDaysMax: 5,  maxConcurrency: 1, streakMax: 1 },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randFloat(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

/** Generate a date string N days ago from today */
function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split("T")[0]!;
}

/** Convert snake_case username to Title Case display name, stripping trailing numbers */
function toDisplayName(username: string): string {
  return username
    .replace(/_?\d+$/, "")
    .split("_")
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Mixed avatar styles: 1/2 stock photos, 1/3 DiceBear, 1/6 colored initials */
const AVATAR_STYLES = ['avataaars', 'lorelei', 'notionists', 'open-peeps', 'adventurer', 'big-ears'];

function getAvatarUrl(username: string, gender: "M" | "F" | null, index: number): string | null {
  const bucket = index % 6;
  if (bucket < 3) {
    // 3/6 = 1/2 → stock photo (gender-aligned via randomuser.me)
    const g = gender === "F" ? "women" : "men"; // null defaults to men
    const photoId = index % 100;
    return `https://randomuser.me/api/portraits/${g}/${photoId}.jpg`;
  } else if (bucket < 5) {
    // 2/6 = 1/3 → DiceBear human style
    const style = AVATAR_STYLES[index % AVATAR_STYLES.length];
    return `https://api.dicebear.com/9.x/${style}/svg?seed=${username}`;
  } else {
    // 1/6 → colored initials (null triggers frontend fallback)
    return null;
  }
}

/** Pick random hour with working-hours bias */
function randomHour(): number {
  const roll = Math.random();
  if (roll < 0.70) return randInt(9, 17);       // 9am–5pm
  if (roll < 0.90) return randInt(18, 22);       // evening
  return randInt(0, 8);                          // night owl
}

// ─── Payload Generator ───────────────────────────────────────────────────────

function generatePayload(userHash: string, tier: TierConfig) {
  const totalTokens = randInt(tier.tokenMin, tier.tokenMax);

  // Derive other stats proportionally (kept low so seed users underperform)
  const tokensPerMessage = randInt(3000, 8000);
  const totalMessages = Math.max(1, Math.floor(totalTokens / tokensPerMessage));
  const messagesPerSession = randInt(3, 12);
  const totalSessions = Math.max(1, Math.floor(totalMessages / messagesPerSession));
  const toolCallRatio = randFloat(0.1, 0.4);
  const totalToolCalls = Math.floor(totalMessages * toolCallRatio);
  const currentStreak = randInt(0, tier.streakMax);

  // Session time
  const avgSessionMins = randInt(5, 30);
  const totalSessionTimeSecs = totalSessions * avgSessionMins * 60;
  const activeRatio = randFloat(0.6, 0.85);
  const totalActiveTimeSecs = Math.floor(totalSessionTimeSecs * activeRatio);
  const totalIdleTimeSecs = totalSessionTimeSecs - totalActiveTimeSecs;

  // Token breakdown: ~60% sonnet, ~25% opus, ~15% haiku
  const sonnetPct = randFloat(0.50, 0.70);
  const opusPct = randFloat(0.15, 0.30);
  const haikuPct = 1 - sonnetPct - opusPct;

  const makeModelUsage = (pct: number) => {
    const total = Math.floor(totalTokens * pct);
    const inputRatio = randFloat(0.6, 0.8);
    const input = Math.floor(total * inputRatio);
    const output = total - input;
    const cacheRead = Math.floor(input * randFloat(0.3, 0.6));
    const cacheCreation = Math.floor(input * randFloat(0.05, 0.15));
    return { input, output, cache_read: cacheRead, cache_creation: cacheCreation };
  };

  const tokenBreakdown: Record<string, any> = {
    "claude-sonnet-4-6-20260319": makeModelUsage(sonnetPct),
    "claude-opus-4-6-20260319": makeModelUsage(opusPct),
    "claude-haiku-4-5-20251001": makeModelUsage(haikuPct),
  };

  // Prompt hashes (uniqueness ~0.6–0.95)
  const promptCount = Math.max(10, Math.floor(totalMessages * randFloat(0.8, 1.2)));
  const uniqueRatio = randFloat(0.6, 0.95);
  const uniqueCount = Math.floor(promptCount * uniqueRatio);
  const promptHashes: string[] = [];
  const uniquePool: string[] = [];
  for (let i = 0; i < uniqueCount; i++) {
    uniquePool.push(`ph-${userHash}-${i}-${Math.random().toString(36).substring(2, 8)}`);
  }
  for (let i = 0; i < promptCount; i++) {
    if (i < uniqueCount) {
      promptHashes.push(uniquePool[i]!);
    } else {
      promptHashes.push(uniquePool[randInt(0, uniquePool.length - 1)]!);
    }
  }

  // Daily activity
  const activityDays = randInt(tier.activityDaysMin, tier.activityDaysMax);
  const dailyActivity: { date: string; messageCount: number; toolCallCount: number; tokenCount: number }[] = [];
  let remainingTokens = totalTokens;
  let remainingMessages = totalMessages;
  let remainingToolCalls = totalToolCalls;

  for (let d = 0; d < activityDays; d++) {
    const date = daysAgo(activityDays - 1 - d);

    // Some rest days (~15% chance)
    if (Math.random() < 0.15 && d > 0 && d < activityDays - 1) continue;

    const isLastDay = d === activityDays - 1;
    let dayMessages: number, dayToolCalls: number, dayTokens: number;

    if (isLastDay) {
      dayMessages = Math.max(1, remainingMessages);
      dayToolCalls = Math.max(0, remainingToolCalls);
      dayTokens = Math.max(1, remainingTokens);
    } else {
      const daysLeft = activityDays - d;
      const avgMessages = Math.max(1, Math.floor(remainingMessages / daysLeft));
      dayMessages = Math.max(1, Math.floor(avgMessages * randFloat(0.3, 2.0)));
      dayMessages = Math.min(dayMessages, remainingMessages);

      const avgToolCalls = Math.max(0, Math.floor(remainingToolCalls / daysLeft));
      dayToolCalls = Math.max(0, Math.floor(avgToolCalls * randFloat(0.2, 2.0)));
      dayToolCalls = Math.min(dayToolCalls, remainingToolCalls);

      const avgTokens = Math.max(1, Math.floor(remainingTokens / daysLeft));
      dayTokens = Math.max(1, Math.floor(avgTokens * randFloat(0.3, 2.0)));
      dayTokens = Math.min(dayTokens, remainingTokens);
    }

    remainingMessages -= dayMessages;
    remainingToolCalls -= dayToolCalls;
    remainingTokens -= dayTokens;

    dailyActivity.push({ date, messageCount: dayMessages, toolCallCount: dayToolCalls, tokenCount: dayTokens });
  }

  // Hourly data: hour_counts and hour_tokens keyed like "2026-03-18:14"
  const hourCounts: Record<string, number> = {};
  const hourTokens: Record<string, number> = {};

  for (const day of dailyActivity) {
    // Spread the day's messages across a few hours
    const hoursActive = randInt(2, Math.min(8, day.messageCount));
    let msgLeft = day.messageCount;
    let tokLeft = day.tokenCount;

    for (let h = 0; h < hoursActive; h++) {
      const hour = randomHour();
      const key = `${day.date}:${hour}`;

      const isLast = h === hoursActive - 1;
      const msgs = isLast ? msgLeft : Math.max(1, Math.floor(msgLeft / (hoursActive - h) * randFloat(0.5, 1.5)));
      const toks = isLast ? tokLeft : Math.max(1, Math.floor(tokLeft / (hoursActive - h) * randFloat(0.5, 1.5)));

      hourCounts[key] = (hourCounts[key] ?? 0) + Math.min(msgs, msgLeft);
      hourTokens[key] = (hourTokens[key] ?? 0) + Math.min(toks, tokLeft);

      msgLeft -= msgs;
      tokLeft -= toks;
      if (msgLeft <= 0) break;
    }
  }

  // Concurrency histogram: per-hour histograms keyed like "2026-03-18:14"
  const concurrencyHistogram: Record<string, Record<string, number>> = {};
  for (const key of Object.keys(hourCounts)) {
    const histogram: Record<string, number> = {};
    const totalMins = randInt(10, 55);
    let minsLeft = totalMins;

    // Most time at 1 concurrent session
    const singleMins = Math.floor(totalMins * randFloat(0.5, 0.9));
    histogram["1"] = singleMins;
    minsLeft -= singleMins;

    // Higher tiers get more concurrent sessions
    for (let c = 2; c <= tier.maxConcurrency && minsLeft > 0; c++) {
      const mins = c === tier.maxConcurrency ? minsLeft : randInt(1, Math.max(1, minsLeft));
      histogram[String(c)] = mins;
      minsLeft -= mins;
    }

    concurrencyHistogram[key] = histogram;
  }

  // Day sessions
  const daySessions: Record<string, any[]> = {};
  for (const day of dailyActivity) {
    const numSessions = randInt(1, Math.min(6, Math.ceil(day.messageCount / 5)));
    const sessions: any[] = [];

    for (let s = 0; s < numSessions; s++) {
      const startHour = randomHour();
      const startMin = startHour * 60 + randInt(0, 59);
      const duration = randInt(10, 120); // 10–120 minutes
      const endMin = Math.min(startMin + duration, 1439);
      const sessionTokens = Math.floor(day.tokenCount / numSessions);
      const sessionMessages = Math.max(1, Math.floor(day.messageCount / numSessions));

      sessions.push({
        ring: s % 3, // rotate through rings 0, 1, 2
        start: startMin,
        end: endMin,
        tokens: sessionTokens,
        messages: sessionMessages,
      });
    }

    daySessions[day.date] = sessions;
  }

  return {
    user_hash: userHash,
    sync_secret: `secret-${userHash}`,
    totals: {
      total_tokens: totalTokens,
      total_messages: totalMessages,
      total_sessions: totalSessions,
      total_tool_calls: totalToolCalls,
      current_streak: currentStreak,
      total_session_time_secs: totalSessionTimeSecs,
      total_active_time_secs: totalActiveTimeSecs,
      total_idle_time_secs: totalIdleTimeSecs,
    },
    token_breakdown: tokenBreakdown,
    prompt_hashes: promptHashes,
    daily_activity: dailyActivity,
    hour_counts: hourCounts,
    hour_tokens: hourTokens,
    concurrency_histogram: concurrencyHistogram,
    day_sessions: daySessions,
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function clean() {
  console.log("Connecting to Postgres to clean seed users...");
  const pool = new pg.Pool({ connectionString: DATABASE_URL, ssl: PG_SSL });
  try {
    // Clean all seed-related tables
    const tables = [
      "DELETE FROM concurrency_histogram WHERE user_hash LIKE 'seed-%'",
      "DELETE FROM daily_sessions WHERE user_hash LIKE 'seed-%'",
      "DELETE FROM metrics_hourly WHERE user_hash LIKE 'seed-%'",
      "DELETE FROM metrics_history WHERE user_hash LIKE 'seed-%'",
      "DELETE FROM device_metrics WHERE device_hash LIKE 'seed-%'",
      "DELETE FROM user_metrics WHERE user_hash LIKE 'seed-%'",
      "DELETE FROM users WHERE user_hash LIKE 'seed-%'",
    ];
    for (const sql of tables) {
      const result = await pool.query(sql);
      const tableName = sql.match(/FROM (\w+)/)?.[1] ?? "?";
      console.log(`  ${tableName}: deleted ${result.rowCount} rows`);
    }
    console.log("Done! All seed users removed.");
  } finally {
    await pool.end();
  }
}

async function seed() {
  // Build user list
  const users: { hash: string; username: string; gender: "M" | "F" | null; tier: TierConfig }[] = [];
  let usernameIdx = 0;

  for (const tier of TIERS) {
    for (let i = 0; i < tier.count; i++) {
      const hash = `${SEED_PREFIX}${tier.name.toLowerCase()}-${String(i + 1).padStart(3, "0")}`;
      const entry = USERNAMES[usernameIdx];
      const username = entry?.[0] ?? `dev_${usernameIdx}`;
      const gender = entry?.[1] ?? null;
      users.push({ hash, username, gender, tier });
      usernameIdx++;
    }
  }

  console.log(`Seeding ${users.length} fake users across tiers...`);
  console.log(`  Diamond: ${TIERS[0]!.count}, Platinum: ${TIERS[1]!.count}, Gold: ${TIERS[2]!.count}, Silver: ${TIERS[3]!.count}, Bronze: ${TIERS[4]!.count}`);
  console.log();

  // Sync each user
  let success = 0;
  let failed = 0;

  for (let i = 0; i < users.length; i++) {
    const user = users[i]!;
    const payload = generatePayload(user.hash, user.tier);

    try {
      const resp = await fetch(`${API}/api/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!resp.ok) {
        const text = await resp.text();
        console.error(`  [${i + 1}/${users.length}] FAIL ${user.hash} (${user.tier.name}): ${resp.status} ${text}`);
        failed++;
        continue;
      }

      const result = await resp.json() as any;
      console.log(`  [${i + 1}/${users.length}] OK ${user.hash} (${user.tier.name}) weighted=${result.weighted_score?.toFixed(1) ?? "?"}`);
      success++;
    } catch (err: any) {
      console.error(`  [${i + 1}/${users.length}] ERROR ${user.hash}: ${err.message}`);
      failed++;
    }
  }

  console.log();
  console.log(`Sync complete: ${success} ok, ${failed} failed`);

  // Update usernames directly in Postgres (OAuth not needed)
  console.log();
  console.log("Updating usernames in Postgres...");
  const pool = new pg.Pool({ connectionString: DATABASE_URL, ssl: PG_SSL });

  try {
    let updated = 0;
    for (let i = 0; i < users.length; i++) {
      const user = users[i]!;
      const displayName = toDisplayName(user.username);
      const avatarUrl = getAvatarUrl(user.username, user.gender, i);
      const result = await pool.query(
        "UPDATE users SET username = $1, display_name = $2, avatar_url = $3 WHERE user_hash = $4",
        [user.username, displayName, avatarUrl, user.hash],
      );
      if (result.rowCount && result.rowCount > 0) updated++;
    }
    console.log(`  Updated ${updated}/${users.length} usernames, display names, and avatars`);
  } finally {
    await pool.end();
  }

  console.log();
  console.log("Done! Check the leaderboard at http://localhost:3001/api/leaderboard/tokens");
}

// ─── Entry ───────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
if (args.includes("--clean")) {
  await clean();
} else {
  await seed();
}
