/**
 * Daily refresh for seed users — generates fresh daily activity so they
 * appear on daily leaderboards every day.
 *
 * Idempotent: uses ON CONFLICT ... DO UPDATE so re-running for the same
 * date just overwrites with new random values.
 */

import { getDb, getPool } from "./db";
import { recomputeUserMetrics } from "./aggregate";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randFloat(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

function randomHour(): number {
  const roll = Math.random();
  if (roll < 0.70) return randInt(9, 17);
  if (roll < 0.90) return randInt(18, 22);
  return randInt(0, 8);
}

// ─── Tier daily activity ranges ──────────────────────────────────────────────

interface DailyRange {
  tokenMin: number;
  tokenMax: number;
  msgMin: number;
  msgMax: number;
  toolMin: number;
  toolMax: number;
  maxConcurrency: number;
}

const DAILY_RANGES: Record<string, DailyRange> = {
  diamond:  { tokenMin: 10_000,  tokenMax: 100_000, msgMin: 20, msgMax: 100, toolMin: 5,  toolMax: 30, maxConcurrency: 3 },
  platinum: { tokenMin: 5_000,   tokenMax: 50_000,  msgMin: 10, msgMax: 60,  toolMin: 3,  toolMax: 20, maxConcurrency: 2 },
  gold:     { tokenMin: 2_000,   tokenMax: 20_000,  msgMin: 5,  msgMax: 30,  toolMin: 2,  toolMax: 15, maxConcurrency: 2 },
  silver:   { tokenMin: 500,     tokenMax: 5_000,   msgMin: 2,  msgMax: 15,  toolMin: 1,  toolMax: 8,  maxConcurrency: 1 },
  bronze:   { tokenMin: 100,     tokenMax: 2_000,   msgMin: 1,  msgMax: 5,   toolMin: 0,  toolMax: 3,  maxConcurrency: 1 },
};

function parseTier(userHash: string): string | null {
  // e.g. "seed-diamond-001" → "diamond"
  const match = userHash.match(/^seed-(\w+)-\d+$/);
  return match ? match[1]! : null;
}

// ─── Main ────────────────────────────────────────────────────────────────────

export async function refreshSeedUsersDaily(): Promise<void> {
  const pool = getPool();
  const db = getDb();
  const today = new Date().toISOString().split("T")[0]!;

  console.log(`[seed-daily] Refreshing seed user activity for ${today}...`);

  // 1. Get all seed user hashes
  const { rows: seedUsers } = await pool.query(
    "SELECT user_hash FROM users WHERE user_hash LIKE 'seed-%' AND linked_to IS NULL"
  );

  if (seedUsers.length === 0) {
    console.log("[seed-daily] No seed users found, skipping.");
    return;
  }

  let activeCount = 0;
  let skippedCount = 0;

  for (const { user_hash: userHash } of seedUsers) {
    const tier = parseTier(userHash);
    if (!tier || !DAILY_RANGES[tier]) {
      continue;
    }

    // ~15% rest day
    if (Math.random() < 0.15) {
      skippedCount++;
      continue;
    }

    const range = DAILY_RANGES[tier]!;
    const dailyTokens = randInt(range.tokenMin, range.tokenMax);
    const dailyMessages = randInt(range.msgMin, range.msgMax);
    const dailyToolCalls = randInt(range.toolMin, range.toolMax);
    const dailyOutputTokens = Math.floor(dailyTokens * randFloat(0.2, 0.4));

    // Concurrency metrics
    const peakConcurrency = randInt(1, range.maxConcurrency);
    const hoursActive = randInt(2, 6);
    const totalAgentMins = hoursActive * randInt(15, 50);
    const concurrentMins = peakConcurrency > 1 ? randInt(5, Math.floor(totalAgentMins * 0.4)) : 0;
    const peakConcurrencyMins = peakConcurrency > 1 ? randInt(1, Math.max(1, concurrentMins)) : 0;
    const peakHourlyStreak = randInt(1, hoursActive);

    // daily_spend: estimate proportional to tokens
    // Use a rough $3/MTok input, $15/MTok output rate
    const dailySpend = (dailyTokens - dailyOutputTokens) * 3 / 1_000_000 + dailyOutputTokens * 15 / 1_000_000;

    // ── metrics_history ──
    await pool.query(
      `INSERT INTO metrics_history (
        user_hash, snapshot_date, daily_messages, daily_tool_calls, daily_tokens,
        peak_concurrency, total_agent_mins, concurrent_mins, peak_concurrency_mins,
        daily_spend, peak_hourly_streak
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (user_hash, snapshot_date) DO UPDATE SET
        daily_messages = EXCLUDED.daily_messages, daily_tool_calls = EXCLUDED.daily_tool_calls,
        daily_tokens = EXCLUDED.daily_tokens, peak_concurrency = EXCLUDED.peak_concurrency,
        total_agent_mins = EXCLUDED.total_agent_mins, concurrent_mins = EXCLUDED.concurrent_mins,
        peak_concurrency_mins = EXCLUDED.peak_concurrency_mins,
        daily_spend = EXCLUDED.daily_spend, peak_hourly_streak = EXCLUDED.peak_hourly_streak`,
      [userHash, today, dailyMessages, dailyToolCalls, dailyTokens,
       peakConcurrency, totalAgentMins, concurrentMins, peakConcurrencyMins,
       dailySpend, peakHourlyStreak],
    );

    // ── metrics_hourly ── (2–6 hours of activity)
    const hourlyRows: [string, string, number, number][] = [];
    let msgLeft = dailyMessages;
    let tokLeft = dailyTokens;

    for (let h = 0; h < hoursActive; h++) {
      const hour = randomHour();
      const snapshotHour = `${today}T${String(hour).padStart(2, "0")}:00:00`;
      const isLast = h === hoursActive - 1;
      const msgs = isLast ? Math.max(1, msgLeft) : Math.max(1, Math.floor(msgLeft / (hoursActive - h) * randFloat(0.5, 1.5)));
      const toks = isLast ? Math.max(1, tokLeft) : Math.max(1, Math.floor(tokLeft / (hoursActive - h) * randFloat(0.5, 1.5)));

      hourlyRows.push([userHash, snapshotHour, Math.min(msgs, Math.max(1, msgLeft)), Math.min(toks, Math.max(1, tokLeft))]);
      msgLeft -= msgs;
      tokLeft -= toks;
      if (msgLeft <= 0 && !isLast) { msgLeft = 0; tokLeft = 0; }
    }

    if (hourlyRows.length > 0) {
      const values = hourlyRows.map((_, i) => `($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4})`).join(", ");
      await pool.query(
        `INSERT INTO metrics_hourly (user_hash, snapshot_hour, total_messages, total_tokens) VALUES ${values}
         ON CONFLICT (user_hash, snapshot_hour) DO UPDATE SET
           total_messages = EXCLUDED.total_messages, total_tokens = EXCLUDED.total_tokens`,
        hourlyRows.flat(),
      );
    }

    // ── concurrency_histogram ──
    const histRows: [string, string, string][] = [];
    for (const [, snapshotHour] of hourlyRows) {
      const histogram: Record<string, number> = {};
      const totalMins = randInt(10, 55);
      let minsLeft = totalMins;
      const singleMins = Math.floor(totalMins * randFloat(0.5, 0.9));
      histogram["1"] = singleMins;
      minsLeft -= singleMins;
      for (let c = 2; c <= range.maxConcurrency && minsLeft > 0; c++) {
        const mins = c === range.maxConcurrency ? minsLeft : randInt(1, Math.max(1, minsLeft));
        histogram[String(c)] = mins;
        minsLeft -= mins;
      }
      histRows.push([userHash, snapshotHour, JSON.stringify(histogram)]);
    }

    if (histRows.length > 0) {
      const values = histRows.map((_, i) => `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`).join(", ");
      await pool.query(
        `INSERT INTO concurrency_histogram (user_hash, snapshot_hour, histogram) VALUES ${values}
         ON CONFLICT (user_hash, snapshot_hour) DO UPDATE SET histogram = EXCLUDED.histogram`,
        histRows.flat(),
      );
    }

    // ── daily_sessions ── (1–4 sessions)
    const numSessions = randInt(1, 4);
    const sessions: { ring: number; start: number; end: number; tokens: number; messages: number }[] = [];
    for (let s = 0; s < numSessions; s++) {
      const startHour = randomHour();
      const startMin = startHour * 60 + randInt(0, 59);
      const duration = randInt(10, 120);
      const endMin = Math.min(startMin + duration, 1439);
      sessions.push({
        ring: s % 3,
        start: startMin,
        end: endMin,
        tokens: Math.floor(dailyTokens / numSessions),
        messages: Math.max(1, Math.floor(dailyMessages / numSessions)),
      });
    }

    await pool.query(
      `INSERT INTO daily_sessions (user_hash, snapshot_date, sessions) VALUES ($1, $2, $3)
       ON CONFLICT (user_hash, snapshot_date) DO UPDATE SET sessions = EXCLUDED.sessions`,
      [userHash, today, JSON.stringify(sessions)],
    );

    // ── device_metrics: increment cumulative totals ──
    await pool.query(
      `UPDATE device_metrics SET
        total_tokens = total_tokens + $1,
        total_messages = total_messages + $2,
        total_tool_calls = total_tool_calls + $3,
        total_output_tokens = total_output_tokens + $4,
        last_synced = $5
       WHERE device_hash = $6`,
      [dailyTokens, dailyMessages, dailyToolCalls, dailyOutputTokens, new Date().toISOString(), userHash],
    );

    // ── recompute user_metrics (weighted_score, streak, points, etc.) ──
    await recomputeUserMetrics(userHash);

    activeCount++;
  }

  console.log(`[seed-daily] Done: ${activeCount} active, ${skippedCount} resting (${seedUsers.length} total seed users)`);
}
