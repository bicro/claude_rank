import type { DbClient } from "./db";

// ─── Pricing ────────────────────────────────────────────────────────────────

const PRICING = [
  { match: "opus-4-6",  input: 5,    output: 25,   cache_read: 0.50, cache_write: 6.25 },
  { match: "opus-4-5",  input: 5,    output: 25,   cache_read: 0.50, cache_write: 6.25 },
  { match: "opus-4-1",  input: 15,   output: 75,   cache_read: 1.50, cache_write: 18.75 },
  { match: "opus-4-0",  input: 15,   output: 75,   cache_read: 1.50, cache_write: 18.75 },
  { match: "opus-4",    input: 15,   output: 75,   cache_read: 1.50, cache_write: 18.75 },
  { match: "opus-3",    input: 15,   output: 75,   cache_read: 1.50, cache_write: 18.75 },
  { match: "sonnet",    input: 3,    output: 15,   cache_read: 0.30, cache_write: 3.75 },
  { match: "haiku-4-5", input: 1,    output: 5,    cache_read: 0.10, cache_write: 1.25 },
  { match: "haiku-4",   input: 1,    output: 5,    cache_read: 0.10, cache_write: 1.25 },
  { match: "haiku-3-5", input: 0.80, output: 4,    cache_read: 0.08, cache_write: 1 },
  { match: "haiku-3",   input: 0.25, output: 1.25, cache_read: 0.03, cache_write: 0.30 },
];

const FALLBACK_PRICE = { input: 3, output: 15, cache_read: 0.30, cache_write: 3.75 };

const MIN_PEAK_MINUTES = 2;

export function estimateCost(tokenBreakdown: Record<string, any>): number {
  let cost = 0.0;
  for (const [model, usage] of Object.entries(tokenBreakdown)) {
    if (!usage || typeof usage !== "object") continue;
    const tier = PRICING.find(p => model.includes(p.match)) ?? FALLBACK_PRICE;
    cost += (
      ((usage.input ?? 0) * tier.input
        + (usage.output ?? 0) * tier.output
        + (usage.cache_read ?? 0) * tier.cache_read
        + (usage.cache_creation ?? 0) * tier.cache_write)
      / 1_000_000
    );
  }
  return Math.round(cost * 100) / 100;
}

// ─── Ranking ────────────────────────────────────────────────────────────────

const WEIGHTED_FORMULA = {
  tokens: 0.3,
  messages: 0.2,
  sessions: 0.1,
  tool_calls: 0.25,
  uniqueness: 0.15,
};

export function computeWeightedScore(
  totalTokens: number,
  totalMessages: number,
  totalSessions: number,
  totalToolCalls: number,
  promptUniqueness: number,
): number {
  return (
    (totalTokens / 1_000_000) * WEIGHTED_FORMULA.tokens
    + totalMessages * WEIGHTED_FORMULA.messages
    + totalSessions * WEIGHTED_FORMULA.sessions
    + totalToolCalls * WEIGHTED_FORMULA.tool_calls
    + promptUniqueness * 100 * WEIGHTED_FORMULA.uniqueness
  );
}

const TIER_THRESHOLDS = [
  { tier: "Diamond",  min: 1000 },
  { tier: "Platinum", min: 500 },
  { tier: "Gold",     min: 200 },
  { tier: "Silver",   min: 50 },
  { tier: "Bronze",   min: 0 },
];

const TIER_ORDER = ["Bronze", "Silver", "Gold", "Platinum", "Diamond"];

export function computeTier(weightedScore: number): { tier: string; next_tier: string | null; progress: number } {
  for (let i = 0; i < TIER_THRESHOLDS.length; i++) {
    const t = TIER_THRESHOLDS[i]!;
    if (weightedScore >= t.min) {
      const tierName = t.tier;
      const idx = TIER_ORDER.indexOf(tierName);
      if (idx < TIER_ORDER.length - 1) {
        const nextTier = TIER_ORDER[idx + 1] ?? null;
        const nextMin = TIER_THRESHOLDS[TIER_THRESHOLDS.length - 2 - idx]?.min ?? 0;
        let progress = (weightedScore - t.min) / (nextMin - t.min);
        progress = Math.min(progress, 1.0);
        return { tier: tierName, next_tier: nextTier, progress: Math.round(progress * 100) / 100 };
      } else {
        return { tier: tierName, next_tier: null, progress: 1.0 };
      }
    }
  }
  return { tier: "Bronze", next_tier: "Silver", progress: 0.0 };
}

function computePercentile(rank: number, total: number): number {
  if (total <= 1) return 0.0;
  return Math.round(((rank - 1) / (total - 1)) * 100 * 10) / 10;
}

function rankEntry(rank: number, total: number): { rank: number; percentile: number; total_users: number } {
  return { rank, percentile: computePercentile(rank, total), total_users: total };
}

const CATEGORY_COLUMNS: Record<string, string> = {
  tokens: "total_tokens",
  messages: "(total_messages + total_sessions)",
  tools: "total_tool_calls",
  uniqueness: "prompt_uniqueness_score",
  weighted: "weighted_score",
};

async function getUserRank(db: DbClient, userHash: string, category: string): Promise<number | null> {
  const col = CATEGORY_COLUMNS[category];
  if (!col) return null;

  const userRow = await db.query(`SELECT ${col} as value FROM user_metrics WHERE user_hash = ?`).get(userHash) as any;
  if (!userRow) return null;

  const val = userRow.value;
  if (val == null) return null;

  // Only count primary (non-linked) users for rankings
  const countRow = await db.query(
    `SELECT COUNT(*) as cnt FROM user_metrics um JOIN users u ON u.user_hash = um.user_hash WHERE u.linked_to IS NULL AND ${col} > ?`
  ).get(val) as any;
  return (countRow?.cnt ?? 0) + 1;
}

export async function getUserRanksWithPercentiles(db: DbClient, userHash: string): Promise<Record<string, any>> {
  const totalRow = await db.query(
    "SELECT COUNT(*) as cnt FROM user_metrics um JOIN users u ON u.user_hash = um.user_hash WHERE u.linked_to IS NULL"
  ).get() as any;
  const total = totalRow?.cnt ?? 0;

  const result: Record<string, any> = {};
  for (const cat of Object.keys(CATEGORY_COLUMNS)) {
    const rank = await getUserRank(db, userHash, cat);
    if (rank !== null) {
      result[cat] = rankEntry(rank, total);
    } else {
      result[cat] = null;
    }
  }
  return result;
}

export async function getDailyRanksForUser(db: DbClient, userHash: string, targetDate: string): Promise<Record<string, any>> {
  const ranks: Record<string, any> = {};

  // daily_tokens rank
  const tokenRows = await db.query(
    "SELECT user_hash, daily_tokens FROM metrics_history WHERE snapshot_date = ? AND daily_tokens > 0"
  ).all(targetDate) as any[];

  let userTokens: number | null = null;
  for (const row of tokenRows) {
    if (row.user_hash === userHash) {
      userTokens = row.daily_tokens;
      break;
    }
  }

  if (userTokens !== null && userTokens > 0) {
    const total = tokenRows.length;
    const higher = tokenRows.filter(r => r.daily_tokens > userTokens!).length;
    const entry = rankEntry(higher + 1, total);
    ranks.daily_tokens = entry;
    ranks.daily_spend = entry;
  } else {
    ranks.daily_tokens = null;
    ranks.daily_spend = null;
  }

  // concurrency metrics
  const dayStart = `${targetDate}T00:00:00`;
  const dayEnd = `${targetDate}T23:59:59`;

  const concRows = await db.query(
    "SELECT user_hash, histogram FROM concurrency_histogram WHERE snapshot_hour >= ? AND snapshot_hour <= ?"
  ).all(dayStart, dayEnd) as any[];

  const userStats: Record<string, { peak: number; active_mins: number; concurrent_mins: number }> = {};
  for (const row of concRows) {
    let histogram: Record<string, number> = {};
    try {
      histogram = row.histogram ? JSON.parse(row.histogram) : {};
    } catch {
      continue;
    }
    const uh = row.user_hash;
    if (!userStats[uh]) {
      userStats[uh] = { peak: 0, active_mins: 0, concurrent_mins: 0 };
    }
    for (const [sessionsStr, minutes] of Object.entries(histogram)) {
      const sessionCount = parseInt(sessionsStr, 10);
      const mins = minutes as number;
      if (sessionCount > userStats[uh].peak && (sessionCount <= 1 || mins >= MIN_PEAK_MINUTES)) {
        userStats[uh].peak = sessionCount;
      }
      if (sessionCount >= 1) {
        userStats[uh].active_mins += mins;
      }
      if (sessionCount > 1) {
        userStats[uh].concurrent_mins += mins;
      }
    }
  }

  const myStats = userStats[userHash];
  const activeUsers = Object.values(userStats).filter(s => s.peak > 0);
  const totalConc = activeUsers.length;

  if (myStats && myStats.peak > 0) {
    const higher = activeUsers.filter(s => s.peak > myStats.peak).length;
    ranks.peak_concurrency = rankEntry(higher + 1, totalConc);
  } else {
    ranks.peak_concurrency = null;
  }

  if (myStats && myStats.active_mins > 0) {
    const activeList = Object.values(userStats).filter(s => s.active_mins > 0);
    const higher = activeList.filter(s => s.active_mins > myStats.active_mins).length;
    ranks.active_mins = rankEntry(higher + 1, activeList.length);
  } else {
    ranks.active_mins = null;
  }

  if (myStats && myStats.concurrent_mins > 0) {
    const concList = Object.values(userStats).filter(s => s.concurrent_mins > 0);
    const higher = concList.filter(s => s.concurrent_mins > myStats.concurrent_mins).length;
    ranks.concurrent_mins = rankEntry(higher + 1, concList.length);
  } else {
    ranks.concurrent_mins = null;
  }

  // hourly_streak rank
  const streakRows = await db.query(
    "SELECT user_hash, peak_hourly_streak FROM metrics_history WHERE snapshot_date = ? AND peak_hourly_streak > 0"
  ).all(targetDate) as any[];

  let userStreak: number | null = null;
  for (const row of streakRows) {
    if (row.user_hash === userHash) {
      userStreak = row.peak_hourly_streak;
      break;
    }
  }

  if (userStreak !== null && userStreak > 0) {
    const total = streakRows.length;
    const higher = streakRows.filter(r => r.peak_hourly_streak > userStreak!).length;
    ranks.hourly_streak = rankEntry(higher + 1, total);
  } else {
    ranks.hourly_streak = null;
  }

  // daily_overall rank (weighted score from daily metrics)
  const dailyRows = await db.query(
    "SELECT user_hash, daily_tokens, daily_messages, daily_tool_calls FROM metrics_history WHERE snapshot_date = ? AND (daily_tokens > 0 OR daily_messages > 0 OR daily_tool_calls > 0)"
  ).all(targetDate) as any[];

  const scored = dailyRows.map(r => ({
    user_hash: r.user_hash,
    score: (r.daily_tokens / 1_000_000) * 0.40 + r.daily_messages * 0.27 + r.daily_tool_calls * 0.33,
  }));

  const myScore = scored.find(s => s.user_hash === userHash);
  if (myScore && myScore.score > 0) {
    const higher = scored.filter(s => s.score > myScore.score).length;
    ranks.daily_overall = rankEntry(higher + 1, scored.length);
  } else {
    ranks.daily_overall = null;
  }

  return ranks;
}

export async function getWeeklyRanksForUser(db: DbClient, userHash: string, weekEndDate: string): Promise<Record<string, any>> {
  const ranks: Record<string, any> = {};

  // compute week start (6 days before)
  const endDate = new Date(weekEndDate + "T00:00:00Z");
  const startDate = new Date(endDate);
  startDate.setUTCDate(startDate.getUTCDate() - 6);
  const weekStart = startDate.toISOString().split("T")[0]!;

  // avg_spend: rank by total tokens over 7 days
  const tokenSums = await db.query(
    `SELECT user_hash, SUM(daily_tokens) as total FROM metrics_history
     WHERE snapshot_date >= ? AND snapshot_date <= ? AND daily_tokens > 0
     GROUP BY user_hash`
  ).all(weekStart, weekEndDate) as any[];

  let userTotal: number | null = null;
  for (const row of tokenSums) {
    if (row.user_hash === userHash) {
      userTotal = row.total;
      break;
    }
  }

  if (userTotal !== null && userTotal > 0) {
    const total = tokenSums.length;
    const higher = tokenSums.filter(r => r.total > userTotal!).length;
    ranks.avg_spend = rankEntry(higher + 1, total);
  } else {
    ranks.avg_spend = null;
  }

  // peak_avg: average of daily peak concurrency
  const dayStartDt = `${weekStart}T00:00:00`;
  const dayEndDt = `${weekEndDate}T23:59:59`;

  const concRows = await db.query(
    "SELECT user_hash, snapshot_hour, histogram FROM concurrency_histogram WHERE snapshot_hour >= ? AND snapshot_hour <= ?"
  ).all(dayStartDt, dayEndDt) as any[];

  const userDayPeaks: Record<string, Record<string, number>> = {};
  for (const row of concRows) {
    let histogram: Record<string, number> = {};
    try {
      histogram = row.histogram ? JSON.parse(row.histogram) : {};
    } catch {
      continue;
    }
    const uh = row.user_hash;
    const sep = row.snapshot_hour.includes("T") ? "T" : " ";
    const d = row.snapshot_hour.split(sep)[0]!;
    if (!userDayPeaks[uh]) userDayPeaks[uh] = {};
    for (const [sessionsStr, minutes] of Object.entries(histogram)) {
      const sc = parseInt(sessionsStr, 10);
      const mins = minutes as number;
      if (sc > (userDayPeaks[uh][d] ?? 0) && (sc <= 1 || mins >= MIN_PEAK_MINUTES)) {
        userDayPeaks[uh][d] = sc;
      }
    }
  }

  const userPeakAvgs: Record<string, number> = {};
  for (const [uh, dayMap] of Object.entries(userDayPeaks)) {
    const vals = Object.values(dayMap);
    if (vals.length > 0) {
      userPeakAvgs[uh] = vals.reduce((a, b) => a + b, 0) / vals.length;
    }
  }

  const myAvg = userPeakAvgs[userHash];
  if (myAvg !== undefined && myAvg > 0) {
    const activeAvgs = Object.values(userPeakAvgs).filter(v => v > 0);
    const total = activeAvgs.length;
    const higher = activeAvgs.filter(v => v > myAvg).length;
    ranks.peak_avg = rankEntry(higher + 1, total);
  } else {
    ranks.peak_avg = null;
  }

  return ranks;
}

// ─── Badge Engine ───────────────────────────────────────────────────────────

const MILESTONE_BADGES = [
  { id: "first_steps",      name: "First Steps",      description: "Send your first message",   icon: "🚀", field: "total_messages",   threshold: 1 },
  { id: "thousand_club",    name: "Thousand Club",     description: "Send 1,000 messages",       icon: "💬", field: "total_messages",   threshold: 1000 },
  { id: "token_millionaire", name: "Token Millionaire", description: "Use 1M total tokens",       icon: "🪙", field: "total_tokens",    threshold: 1_000_000 },
  { id: "token_billionaire", name: "Token Billionaire", description: "Use 1B total tokens",       icon: "💎", field: "total_tokens",    threshold: 1_000_000_000 },
  { id: "tool_master",      name: "Tool Master",       description: "Make 1,000 tool calls",     icon: "🔧", field: "total_tool_calls", threshold: 1000 },
  { id: "tool_surgeon",     name: "Tool Surgeon",      description: "Make 10,000 tool calls",    icon: "⚔️", field: "total_tool_calls", threshold: 10000 },
  { id: "centurion",        name: "Centurion",         description: "Complete 100 sessions",     icon: "🏛️", field: "total_sessions",   threshold: 100 },
];

const RANKING_BADGES_CONFIG = [
  { id: "top_100",      name: "Top 100",      description: "Rank in top 100 in any category", icon: "📊", top_n: 100 },
  { id: "top_10",       name: "Top 10",       description: "Rank in top 10 in any category",  icon: "🏅", top_n: 10 },
  { id: "number_1",     name: "#1",           description: "Hold #1 rank in any category",    icon: "👑", top_n: 1 },
  { id: "token_whale",  name: "Token Whale",  description: "Top 10 in token burning",         icon: "🐋", top_n: 10, category: "tokens" },
  { id: "chatterbox",   name: "Chatterbox",   description: "Top 10 in messages + sessions",   icon: "🗣️", top_n: 10, category: "messages" },
  { id: "toolsmith",    name: "Toolsmith",     description: "Top 10 in tool calls",            icon: "🛠️", top_n: 10, category: "tools" },
];

const TEAM_BADGES_CONFIG = [
  { id: "team_player", name: "Team Player", description: "Join a team", icon: "🤝" },
];

const ALL_BADGES = [
  ...MILESTONE_BADGES.map(b => ({ ...b, category: "milestone" })),
  ...RANKING_BADGES_CONFIG.map(b => ({ ...b, category: "ranking" })),
  ...TEAM_BADGES_CONFIG.map(b => ({ ...b, category: "team" })),
];

export async function seedBadges(db: DbClient): Promise<void> {
  for (const b of ALL_BADGES) {
    await db.query(
      "INSERT INTO badges (id, name, description, category, icon) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING"
    ).run(b.id, b.name, b.description, b.category, b.icon ?? null);
  }
}

async function awardBadge(db: DbClient, userHash: string, badgeId: string): Promise<string | null> {
  const existing = await db.query(
    "SELECT 1 FROM user_badges WHERE user_hash = ? AND badge_id = ?"
  ).get(userHash, badgeId);
  if (existing) return null;

  await db.query(
    `INSERT INTO user_badges (user_hash, badge_id, unlocked_at) VALUES (?, ?, ?)
     ON CONFLICT (user_hash, badge_id) DO NOTHING`
  ).run(userHash, badgeId, new Date().toISOString());
  return badgeId;
}

export async function evaluateMilestoneBadges(db: DbClient, userHash: string, metrics: any): Promise<string[]> {
  const newlyAwarded: string[] = [];
  for (const badgeDef of MILESTONE_BADGES) {
    const value = metrics?.[badgeDef.field] ?? 0;
    if (value >= badgeDef.threshold) {
      const result = await awardBadge(db, userHash, badgeDef.id);
      if (result) newlyAwarded.push(result);
    }
  }
  return newlyAwarded;
}

export async function evaluateRankingBadges(db: DbClient, userHash: string): Promise<string[]> {
  const newlyAwarded: string[] = [];
  const categoryCols: Record<string, string> = {
    tokens: "total_tokens",
    messages: "(total_messages + total_sessions)",
    tools: "total_tool_calls",
    uniqueness: "prompt_uniqueness_score",
    weighted: "weighted_score",
  };

  for (const badgeDef of RANKING_BADGES_CONFIG) {
    const topN = badgeDef.top_n;
    const cats = (badgeDef as any).category
      ? [(badgeDef as any).category as string]
      : Object.keys(categoryCols);

    for (const cat of cats) {
      const col = categoryCols[cat];
      const rows = await db.query(
        `SELECT um.user_hash FROM user_metrics um JOIN users u ON u.user_hash = um.user_hash WHERE u.linked_to IS NULL ORDER BY ${col} DESC LIMIT ?`
      ).all(topN) as any[];
      const topHashes = rows.map(r => r.user_hash);
      if (topHashes.includes(userHash)) {
        const awarded = await awardBadge(db, userHash, badgeDef.id);
        if (awarded) newlyAwarded.push(awarded);
        break;
      }
    }
  }
  return newlyAwarded;
}

export async function evaluateTeamBadges(db: DbClient, userHash: string): Promise<string[]> {
  const newlyAwarded: string[] = [];
  const user = await db.query("SELECT team_hash FROM users WHERE user_hash = ?").get(userHash) as any;
  if (user && user.team_hash) {
    const awarded = await awardBadge(db, userHash, "team_player");
    if (awarded) newlyAwarded.push(awarded);
  }
  return newlyAwarded;
}

// ─── Points & Levels (Server-Side) ──────────────────────────────────────────

export function computePoints(metrics: {
  total_messages: number;
  total_output_tokens: number;
  total_tool_calls: number;
  total_sessions: number;
  active_days: number;
  current_streak: number;
}): { total_points: number; level: number } {
  const total_points =
    metrics.total_messages * 2 +
    Math.floor(metrics.total_output_tokens / 1000) * 5 +
    metrics.total_tool_calls * 3 +
    metrics.total_sessions * 10 +
    metrics.active_days * 50 +
    metrics.current_streak * 10;
  const level = Math.floor(Math.sqrt(total_points / 100));
  return { total_points, level };
}

export async function computeStreak(db: DbClient, hashes: string[]): Promise<number> {
  const placeholders = hashes.map(() => "?").join(", ");
  const rows = await db.query(
    `SELECT DISTINCT snapshot_date FROM metrics_history
     WHERE user_hash IN (${placeholders}) AND (daily_messages > 0 OR daily_tool_calls > 0 OR daily_tokens > 0)
     ORDER BY snapshot_date DESC`
  ).all(...hashes) as any[];

  if (rows.length === 0) return 0;

  const today = new Date();
  const todayStr = today.toISOString().split("T")[0]!;
  const yesterday = new Date(today);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const yesterdayStr = yesterday.toISOString().split("T")[0]!;

  // Streak must start from today or yesterday
  const firstDate = rows[0].snapshot_date;
  if (firstDate !== todayStr && firstDate !== yesterdayStr) return 0;

  let streak = 1;
  for (let i = 1; i < rows.length; i++) {
    const prev = new Date(rows[i - 1].snapshot_date + "T00:00:00Z");
    const curr = new Date(rows[i].snapshot_date + "T00:00:00Z");
    const diffDays = (prev.getTime() - curr.getTime()) / (1000 * 60 * 60 * 24);
    if (diffDays === 1) {
      streak++;
    } else {
      break;
    }
  }
  return streak;
}

export async function computeHourlyStreak(db: DbClient, hashes: string[]): Promise<number> {
  const placeholders = hashes.map(() => "?").join(", ");
  const rows = await db.query(
    `SELECT DISTINCT snapshot_hour FROM metrics_hourly
     WHERE user_hash IN (${placeholders}) AND (total_messages > 0 OR total_tokens > 0)
     ORDER BY snapshot_hour DESC`
  ).all(...hashes) as any[];

  if (rows.length === 0) return 0;

  const now = new Date();
  const currentHour = new Date(now);
  currentHour.setUTCMinutes(0, 0, 0);
  const previousHour = new Date(currentHour.getTime() - 3600000);

  // Streak must start from current hour or previous hour
  const firstHour = new Date(rows[0].snapshot_hour);
  if (firstHour.getTime() < previousHour.getTime()) return 0;

  let streak = 1;
  for (let i = 1; i < rows.length; i++) {
    const prev = new Date(rows[i - 1].snapshot_hour);
    const curr = new Date(rows[i].snapshot_hour);
    const diffMs = prev.getTime() - curr.getTime();
    if (diffMs === 3600000) {
      streak++;
    } else {
      break;
    }
  }
  return streak;
}

// Achievement definitions evaluated server-side
const ACHIEVEMENT_DEFS = [
  { id: "first_steps",      name: "First Steps",      description: "Send your first message",       condition: (m: any) => (m.total_messages ?? 0) >= 1 },
  { id: "thousand_club",    name: "Thousand Club",     description: "Send 1,000 messages",           condition: (m: any) => (m.total_messages ?? 0) >= 1000 },
  { id: "token_millionaire", name: "Token Millionaire", description: "Generate 1M output tokens",    condition: (m: any) => (m.total_output_tokens ?? 0) >= 1_000_000 },
  { id: "tool_master",      name: "Tool Master",       description: "Make 1,000 tool calls",         condition: (m: any) => (m.total_tool_calls ?? 0) >= 1000 },
  { id: "centurion",        name: "Centurion",         description: "Complete 100 sessions",         condition: (m: any) => (m.total_sessions ?? 0) >= 100 },
  { id: "streak_lord",      name: "Streak Lord",       description: "Maintain a 7-day streak",       condition: (m: any, streak: number) => streak >= 7 },
];

export interface SyncAchievement {
  id: string;
  name: string;
  description: string;
  unlocked_at: string;
}

export async function evaluateAchievements(
  db: DbClient,
  userHash: string,
  metrics: any,
  streak: number,
): Promise<{ all: SyncAchievement[]; newly_unlocked: SyncAchievement[] }> {
  const all: SyncAchievement[] = [];
  const newly_unlocked: SyncAchievement[] = [];

  // Check night owl from metrics_hourly
  let isNightOwl = false;
  const nightRows = await db.query(
    `SELECT 1 FROM metrics_hourly WHERE user_hash = ? AND total_messages > 0
     AND (snapshot_hour LIKE '%T00:%' OR snapshot_hour LIKE '%T01:%' OR snapshot_hour LIKE '%T02:%' OR snapshot_hour LIKE '%T03:%')
     LIMIT 1`
  ).get(userHash) as any;
  if (nightRows) isNightOwl = true;

  // Check marathon coder from daily_sessions
  let isMarathon = false;
  const sessionRows = await db.query(
    `SELECT sessions FROM daily_sessions WHERE user_hash = ?`
  ).all(userHash) as any[];
  for (const row of sessionRows) {
    try {
      const sessions = JSON.parse(row.sessions);
      if (Array.isArray(sessions) && sessions.some((s: any) => (s.messages ?? s.message_count ?? 0) >= 100)) {
        isMarathon = true;
        break;
      }
    } catch { /* skip */ }
  }

  const allDefs = [
    ...ACHIEVEMENT_DEFS,
    { id: "night_owl",       name: "Night Owl",       description: "Code between midnight and 4am",   condition: () => isNightOwl },
    { id: "marathon_coder",  name: "Marathon Coder",  description: "Have a session with 100+ messages", condition: () => isMarathon },
  ];

  for (const def of allDefs) {
    if (def.condition(metrics, streak)) {
      // Check if already awarded
      const existing = await db.query(
        "SELECT unlocked_at FROM user_badges WHERE user_hash = ? AND badge_id = ?"
      ).get(userHash, def.id) as any;

      if (existing) {
        all.push({ id: def.id, name: def.name, description: def.description, unlocked_at: existing.unlocked_at });
      } else {
        // Award it — ensure badge exists first
        const badgeExists = await db.query("SELECT 1 FROM badges WHERE id = ?").get(def.id);
        if (!badgeExists) {
          await db.query(
            "INSERT INTO badges (id, name, description, category, icon) VALUES (?, ?, ?, 'achievement', '🏆') ON CONFLICT (id) DO NOTHING"
          ).run(def.id, def.name, def.description);
        }
        const unlockedAt = new Date().toISOString();
        await db.query(
          "INSERT INTO user_badges (user_hash, badge_id, unlocked_at) VALUES (?, ?, ?) ON CONFLICT (user_hash, badge_id) DO NOTHING"
        ).run(userHash, def.id, unlockedAt);
        const achievement = { id: def.id, name: def.name, description: def.description, unlocked_at: unlockedAt };
        all.push(achievement);
        newly_unlocked.push(achievement);
      }
    } else {
      // Check if previously awarded (still include in all)
      const existing = await db.query(
        "SELECT unlocked_at FROM user_badges WHERE user_hash = ? AND badge_id = ?"
      ).get(userHash, def.id) as any;
      if (existing) {
        all.push({ id: def.id, name: def.name, description: def.description, unlocked_at: existing.unlocked_at });
      }
    }
  }

  return { all, newly_unlocked };
}

// ─── Hotness ────────────────────────────────────────────────────────────────

export async function getHotUsers(db: DbClient, limit: number = 20, lookbackDays: number = 3): Promise<any[]> {
  const rows = await db.query(
    `SELECT um.*, u.username, u.display_name, u.auth_provider, u.avatar_url FROM user_metrics um
     JOIN users u ON u.user_hash = um.user_hash
     WHERE um.current_streak > 0 AND u.linked_to IS NULL`
  ).all() as any[];

  if (rows.length === 0) return [];

  const today = new Date();
  const lookbackDate = new Date(today);
  lookbackDate.setUTCDate(lookbackDate.getUTCDate() - lookbackDays);
  const lookbackStr = lookbackDate.toISOString().split("T")[0]!;

  const hotUsers: any[] = [];
  for (const metrics of rows) {
    const history = await db.query(
      `SELECT * FROM metrics_history
       WHERE user_hash = ? AND snapshot_date >= ?
       ORDER BY snapshot_date ASC`
    ).all(metrics.user_hash, lookbackStr) as any[];

    let velocity = 0.0;
    if (history.length >= 2) {
      const tokenDelta = history[history.length - 1].total_tokens - history[0].total_tokens;
      velocity = lookbackDays > 0 ? tokenDelta / lookbackDays : 0;
    }

    const velocityScore = velocity / 100_000;
    const hotness = metrics.current_streak * 10 + velocityScore * 50;

    hotUsers.push({
      user_hash: metrics.user_hash,
      username: metrics.username,
      display_name: metrics.display_name && metrics.auth_provider ? metrics.display_name : null,
      avatar_url: metrics.avatar_url || null,
      current_streak: metrics.current_streak,
      total_points: metrics.total_points,
      level: metrics.level,
      weighted_score: metrics.weighted_score,
      hotness: Math.round(hotness * 100) / 100,
    });
  }

  hotUsers.sort((a, b) => b.hotness - a.hotness);
  return hotUsers.slice(0, limit);
}
