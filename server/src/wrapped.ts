import { getPool, type DbClient } from "./db";
import { getLinkedHashes } from "./aggregate";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export interface WrappedSummary {
  user: { username: string | null; display_name: string | null; avatar_url: string | null; user_hash: string };
  month: { year: number; month: number; label: string; days_in_month: number; ym: string };
  totals: {
    messages: number;
    tokens: number;
    tool_calls: number;
    estimated_spend: number;
    active_days: number;
    sessions: number;
  };
  busiest_day: { date: string; tokens: number; messages: number } | null;
  power_hour: { hour: number; dow: number; messages: number } | null;
  heatmap_24x7: number[][];
  concurrency_flex: { date: string; peak_concurrency: number; minutes_at_peak: number } | null;
  rank: { position: number; total_users: number; percentile: number } | null;
  delta_vs_prev_month: { messages_pct: number | null; tokens_pct: number | null; spend_pct: number | null } | null;
  plan: { monthly_plan_usd: number; utilization_pct: number } | null;
  favourite_model: {
    model_name: string;
    tokens: number;
    share_pct: number;
    top_models: { model_name: string; tokens: number; share_pct: number }[];
  } | null;
  team_comparison: {
    team_hash: string;
    team_name: string;
    total_members: number;
    self_rank: number;
    members: Array<{
      user_hash: string;
      username: string | null;
      display_name: string | null;
      avatar_url: string | null;
      tokens: number;
      rank: number;
      is_self: boolean;
    }>;
  } | null;
}

const TEAM_DISPLAY_CAP = 10;

/** Format a 0-padded YYYY-MM string. month is 1-indexed. */
export function formatYm(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

/** Returns [startDate, endDateExclusive] as YYYY-MM-DD strings for a calendar month. */
function monthRange(year: number, month: number): { start: string; endExcl: string; daysInMonth: number } {
  const startDate = new Date(Date.UTC(year, month - 1, 1));
  const endDate = new Date(Date.UTC(year, month, 1));
  const daysInMonth = Math.round((endDate.getTime() - startDate.getTime()) / 86400000);
  return {
    start: startDate.toISOString().split("T")[0]!,
    endExcl: endDate.toISOString().split("T")[0]!,
    daysInMonth,
  };
}

function pct(curr: number, prev: number): number | null {
  if (prev === 0) return curr > 0 ? 100 : null;
  return Math.round(((curr - prev) / prev) * 1000) / 10;
}

/** Sum daily metrics across linked devices for a single date range. */
async function sumMonthTotals(hashes: string[], start: string, endExcl: string) {
  const pool = getPool();
  const placeholders = hashes.map((_, i) => `$${i + 1}`).join(", ");
  const { rows } = await pool.query(
    `SELECT
       COALESCE(SUM(daily_messages), 0) AS messages,
       COALESCE(SUM(daily_tokens), 0) AS tokens,
       COALESCE(SUM(daily_tool_calls), 0) AS tool_calls,
       COALESCE(SUM(daily_spend), 0) AS spend,
       COUNT(DISTINCT CASE WHEN daily_tokens > 0 OR daily_messages > 0 THEN snapshot_date END) AS active_days
     FROM metrics_history
     WHERE user_hash IN (${placeholders})
       AND snapshot_date >= $${hashes.length + 1}
       AND snapshot_date < $${hashes.length + 2}`,
    [...hashes, start, endExcl],
  );
  const r = rows[0] ?? {};
  return {
    messages: Number(r.messages ?? 0),
    tokens: Number(r.tokens ?? 0),
    tool_calls: Number(r.tool_calls ?? 0),
    spend: Number(r.spend ?? 0),
    active_days: Number(r.active_days ?? 0),
  };
}

/** Find the day with the highest daily_tokens in the range (across linked devices). */
async function findBusiestDay(hashes: string[], start: string, endExcl: string) {
  const pool = getPool();
  const placeholders = hashes.map((_, i) => `$${i + 1}`).join(", ");
  const { rows } = await pool.query(
    `SELECT snapshot_date,
            SUM(daily_tokens) AS tokens,
            SUM(daily_messages) AS messages
     FROM metrics_history
     WHERE user_hash IN (${placeholders})
       AND snapshot_date >= $${hashes.length + 1}
       AND snapshot_date < $${hashes.length + 2}
     GROUP BY snapshot_date
     ORDER BY tokens DESC
     LIMIT 1`,
    [...hashes, start, endExcl],
  );
  if (rows.length === 0 || Number(rows[0].tokens) === 0) return null;
  return {
    date: rows[0].snapshot_date as string,
    tokens: Number(rows[0].tokens),
    messages: Number(rows[0].messages ?? 0),
  };
}

/** Find the peak concurrency moment in the month range. */
async function findConcurrencyFlex(hashes: string[], start: string, endExcl: string) {
  const pool = getPool();
  const placeholders = hashes.map((_, i) => `$${i + 1}`).join(", ");
  // Pick a single concrete (device, date) row — peak and minutes must come
  // from the SAME row. Aggregating with MAX(peak) and MAX(mins) independently
  // would mix the peak from one linked device with the minutes from another,
  // fabricating a "5 agents for 60m" event that never happened.
  const { rows } = await pool.query(
    `SELECT snapshot_date,
            peak_concurrency AS peak,
            peak_concurrency_mins AS mins
     FROM metrics_history
     WHERE user_hash IN (${placeholders})
       AND snapshot_date >= $${hashes.length + 1}
       AND snapshot_date < $${hashes.length + 2}
       AND peak_concurrency > 1
     ORDER BY peak DESC, mins DESC
     LIMIT 1`,
    [...hashes, start, endExcl],
  );
  if (rows.length === 0) return null;
  return {
    date: rows[0].snapshot_date as string,
    peak_concurrency: Number(rows[0].peak),
    minutes_at_peak: Number(rows[0].mins ?? 0),
  };
}

/** Build a 7×24 UTC heatmap of messages from metrics_hourly. */
async function buildHeatmap(hashes: string[], start: string, endExcl: string): Promise<number[][]> {
  const pool = getPool();
  const placeholders = hashes.map((_, i) => `$${i + 1}`).join(", ");
  const { rows } = await pool.query(
    `SELECT snapshot_hour, SUM(total_messages) AS messages
     FROM metrics_hourly
     WHERE user_hash IN (${placeholders})
       AND snapshot_hour >= $${hashes.length + 1}
       AND snapshot_hour < $${hashes.length + 2}
     GROUP BY snapshot_hour`,
    [...hashes, start, endExcl + "T00:00:00"],
  );

  const grid: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const row of rows) {
    const sh = row.snapshot_hour as string;
    if (!sh || sh.length < 13) continue;
    const datePart = sh.slice(0, 10);
    const hourPart = parseInt(sh.slice(11, 13), 10);
    if (isNaN(hourPart)) continue;
    const d = new Date(`${datePart}T00:00:00Z`);
    if (isNaN(d.getTime())) continue;
    const dow = d.getUTCDay(); // 0=Sunday
    const msgs = Number(row.messages ?? 0);
    grid[dow]![hourPart]! += msgs;
  }
  return grid;
}

function findPowerHour(grid: number[][]): { hour: number; dow: number; messages: number } | null {
  let best = { hour: -1, dow: -1, messages: 0 };
  for (let dow = 0; dow < 7; dow++) {
    for (let hour = 0; hour < 24; hour++) {
      const v = grid[dow]![hour]!;
      if (v > best.messages) best = { hour, dow, messages: v };
    }
  }
  return best.messages > 0 ? best : null;
}

/** Find the user's favourite model + top 3 by total tokens in the month range. */
async function findFavouriteModel(hashes: string[], start: string, endExcl: string) {
  const pool = getPool();
  const placeholders = hashes.map((_, i) => `$${i + 1}`).join(", ");
  const { rows } = await pool.query(
    `SELECT model_name, SUM(tokens)::bigint AS tokens
     FROM metrics_model_daily
     WHERE user_hash IN (${placeholders})
       AND snapshot_date >= $${hashes.length + 1}
       AND snapshot_date < $${hashes.length + 2}
     GROUP BY model_name
     ORDER BY tokens DESC
     LIMIT 5`,
    [...hashes, start, endExcl],
  );
  if (rows.length === 0) return null;
  const totals = rows.map((r: any) => ({ model_name: String(r.model_name), tokens: Number(r.tokens ?? 0) }));
  const grandTotal = totals.reduce((s, r) => s + r.tokens, 0);
  if (grandTotal <= 0) return null;
  const withShare = totals.map(r => ({
    ...r,
    share_pct: Math.round((r.tokens / grandTotal) * 1000) / 10,
  }));
  return {
    model_name: withShare[0]!.model_name,
    tokens: withShare[0]!.tokens,
    share_pct: withShare[0]!.share_pct,
    top_models: withShare.slice(0, 3),
  };
}

/**
 * Rank the requester's team members by monthly token burn.
 * Returns null if the user is solo, the team has fewer than 2 members,
 * or no member burned any tokens this month.
 *
 * Aggregates linked devices into their primary owner in a single query,
 * mirroring the pattern in getMonthlyTokenRank — N round-trips would be
 * slow for teams of 10+.
 */
async function findTeamComparison(
  userHash: string,
  start: string,
  endExcl: string,
): Promise<WrappedSummary["team_comparison"]> {
  const pool = getPool();

  // Resolve to primary user and read team_hash from the primary record
  // (linked secondary devices don't carry team_hash; it lives on the primary).
  const primaryRow = await pool.query(
    `SELECT u_primary.user_hash AS primary_hash, u_primary.team_hash
     FROM users u_self
     JOIN users u_primary
       ON u_primary.user_hash = COALESCE(u_self.linked_to, u_self.user_hash)
     WHERE u_self.user_hash = $1`,
    [userHash],
  );
  const selfHash: string = primaryRow.rows[0]?.primary_hash ?? userHash;
  const teamHash: string | null = primaryRow.rows[0]?.team_hash ?? null;
  if (!teamHash) return null;

  // Pull all primary team members + team name in one shot.
  const membersRows = await pool.query(
    `SELECT u.user_hash, u.username, u.display_name, u.avatar_url, t.team_name
     FROM users u
     JOIN teams t ON t.team_hash = u.team_hash
     WHERE u.team_hash = $1 AND u.linked_to IS NULL`,
    [teamHash],
  );
  if (membersRows.rows.length < 2) return null;
  const teamName = String(membersRows.rows[0].team_name);
  const memberHashes: string[] = membersRows.rows.map((r: any) => String(r.user_hash));

  // Sum month tokens per primary member (collapsing linked devices) in one query.
  const ph = memberHashes.map((_, i) => `$${i + 1}`).join(", ");
  const tokensRows = await pool.query(
    `SELECT COALESCE(u.linked_to, u.user_hash) AS primary_hash,
            SUM(mh.daily_tokens) AS tokens
     FROM metrics_history mh
     JOIN users u ON u.user_hash = mh.user_hash
     WHERE COALESCE(u.linked_to, u.user_hash) IN (${ph})
       AND mh.snapshot_date >= $${memberHashes.length + 1}
       AND mh.snapshot_date < $${memberHashes.length + 2}
     GROUP BY COALESCE(u.linked_to, u.user_hash)`,
    [...memberHashes, start, endExcl],
  );
  const tokensByPrimary = new Map<string, number>();
  for (const r of tokensRows.rows) {
    tokensByPrimary.set(String(r.primary_hash), Number(r.tokens ?? 0));
  }

  const ranked = membersRows.rows
    .map((r: any) => ({
      user_hash: String(r.user_hash),
      username: r.username ?? null,
      display_name: r.display_name ?? null,
      avatar_url: r.avatar_url ?? null,
      tokens: tokensByPrimary.get(String(r.user_hash)) ?? 0,
    }))
    .sort((a, b) => b.tokens - a.tokens)
    .map((m, i) => ({
      ...m,
      rank: i + 1,
      is_self: m.user_hash === selfHash,
    }));

  if (ranked.every((m) => m.tokens === 0)) return null;
  const self = ranked.find((m) => m.is_self);
  if (!self) return null;

  // Show top N; always include self even if they fall outside the cap.
  let displayMembers = ranked.slice(0, TEAM_DISPLAY_CAP);
  if (!displayMembers.some((m) => m.is_self)) {
    displayMembers = [...displayMembers, self];
  }

  return {
    team_hash: teamHash,
    team_name: teamName,
    total_members: ranked.length,
    self_rank: self.rank,
    members: displayMembers,
  };
}

/** Count sessions in daily_sessions JSON arrays for the month range. */
async function countSessions(hashes: string[], start: string, endExcl: string): Promise<number> {
  const pool = getPool();
  const placeholders = hashes.map((_, i) => `$${i + 1}`).join(", ");
  const { rows } = await pool.query(
    `SELECT sessions FROM daily_sessions
     WHERE user_hash IN (${placeholders})
       AND snapshot_date >= $${hashes.length + 1}
       AND snapshot_date < $${hashes.length + 2}`,
    [...hashes, start, endExcl],
  );
  let count = 0;
  for (const r of rows) {
    try {
      const arr = r.sessions ? JSON.parse(r.sessions) : [];
      if (Array.isArray(arr)) count += arr.length;
    } catch { /* skip malformed */ }
  }
  return count;
}

/**
 * Compute the user's rank by total monthly tokens vs all other primary users.
 * Group by primary user (collapsing linked-device rows).
 */
export async function getMonthlyTokenRank(
  userHash: string,
  year: number,
  month: number,
): Promise<{ position: number; total_users: number; percentile: number } | null> {
  const pool = getPool();
  const { start, endExcl } = monthRange(year, month);

  const { rows } = await pool.query(
    `SELECT COALESCE(u.linked_to, u.user_hash) AS primary_hash,
            SUM(mh.daily_tokens) AS tokens
     FROM metrics_history mh
     JOIN users u ON u.user_hash = mh.user_hash
     WHERE mh.snapshot_date >= $1 AND mh.snapshot_date < $2 AND mh.daily_tokens > 0
     GROUP BY COALESCE(u.linked_to, u.user_hash)
     HAVING SUM(mh.daily_tokens) > 0`,
    [start, endExcl],
  );

  // Resolve target user's primary hash
  const primaryRow = await pool.query(
    `SELECT COALESCE(linked_to, user_hash) AS primary_hash FROM users WHERE user_hash = $1`,
    [userHash],
  );
  const primaryHash = primaryRow.rows[0]?.primary_hash ?? userHash;

  let myTokens = 0;
  for (const r of rows) {
    if (r.primary_hash === primaryHash) {
      myTokens = Number(r.tokens);
      break;
    }
  }
  if (myTokens <= 0) return null;

  const total = rows.length;
  const higher = rows.filter((r: any) => Number(r.tokens) > myTokens).length;
  const position = higher + 1;
  const percentile = total <= 1 ? 0 : Math.round(((position - 1) / (total - 1)) * 1000) / 10;
  return { position, total_users: total, percentile };
}

export async function getWrappedSummary(
  db: DbClient,
  userHash: string,
  year: number,
  month: number,
): Promise<WrappedSummary | null> {
  if (month < 1 || month > 12) return null;
  const hashes = await getLinkedHashes(db, userHash);
  const { start, endExcl, daysInMonth } = monthRange(year, month);

  // User info — pull from the primary user record
  const userRow = await db.query(
    `SELECT u.user_hash, u.username, u.display_name, u.avatar_url, u.monthly_plan_usd
     FROM users u
     WHERE u.user_hash = COALESCE(
       (SELECT linked_to FROM users WHERE user_hash = ?),
       ?
     )`,
  ).get(userHash, userHash) as any;

  const user = {
    user_hash: userRow?.user_hash ?? userHash,
    username: userRow?.username ?? null,
    display_name: userRow?.display_name ?? null,
    avatar_url: userRow?.avatar_url ?? null,
  };
  const monthlyPlanUsd = userRow?.monthly_plan_usd ?? null;

  // Parallel queries
  const [totals, busiestDay, concurrencyFlex, heatmap, sessions, rank, favouriteModel, teamComparison] = await Promise.all([
    sumMonthTotals(hashes, start, endExcl),
    findBusiestDay(hashes, start, endExcl),
    findConcurrencyFlex(hashes, start, endExcl),
    buildHeatmap(hashes, start, endExcl),
    countSessions(hashes, start, endExcl),
    getMonthlyTokenRank(userHash, year, month),
    findFavouriteModel(hashes, start, endExcl),
    findTeamComparison(userHash, start, endExcl),
  ]);

  // Previous month delta
  const prevDate = new Date(Date.UTC(year, month - 2, 1));
  const prevYear = prevDate.getUTCFullYear();
  const prevMonth = prevDate.getUTCMonth() + 1;
  const prev = monthRange(prevYear, prevMonth);
  const prevTotals = await sumMonthTotals(hashes, prev.start, prev.endExcl);
  const delta = (prevTotals.messages > 0 || prevTotals.tokens > 0)
    ? {
        messages_pct: pct(totals.messages, prevTotals.messages),
        tokens_pct: pct(totals.tokens, prevTotals.tokens),
        spend_pct: pct(totals.spend, prevTotals.spend),
      }
    : null;

  const plan = monthlyPlanUsd && monthlyPlanUsd > 0
    ? {
        monthly_plan_usd: monthlyPlanUsd,
        utilization_pct: Math.round((totals.spend / monthlyPlanUsd) * 1000) / 10,
      }
    : null;

  return {
    user,
    month: {
      year,
      month,
      label: `${MONTH_NAMES[month - 1]} ${year}`,
      days_in_month: daysInMonth,
      ym: formatYm(year, month),
    },
    totals: {
      messages: totals.messages,
      tokens: totals.tokens,
      tool_calls: totals.tool_calls,
      estimated_spend: totals.spend,
      active_days: totals.active_days,
      sessions,
    },
    busiest_day: busiestDay,
    power_hour: findPowerHour(heatmap),
    heatmap_24x7: heatmap,
    concurrency_flex: concurrencyFlex,
    rank,
    delta_vs_prev_month: delta,
    plan,
    favourite_model: favouriteModel,
    team_comparison: teamComparison,
  };
}

/** What's the most recent fully-complete month, and has the user viewed it? */
export async function getWrappedStatus(
  db: DbClient,
  userHash: string,
): Promise<{ latest_month: string | null; viewed: boolean }> {
  // The most recent fully-complete month is "this month - 1" in UTC.
  const now = new Date();
  const prevDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const year = prevDate.getUTCFullYear();
  const month = prevDate.getUTCMonth() + 1;
  const ym = formatYm(year, month);

  // Check if user had any activity that month — no point offering an empty wrapped.
  const hashes = await getLinkedHashes(db, userHash);
  const { start, endExcl } = monthRange(year, month);
  const totals = await sumMonthTotals(hashes, start, endExcl);
  if (totals.messages === 0 && totals.tokens === 0) {
    return { latest_month: null, viewed: false };
  }

  const primaryRow = await db.query(
    `SELECT COALESCE(linked_to, user_hash) AS primary_hash FROM users WHERE user_hash = ?`,
  ).get(userHash) as any;
  const primaryHash = primaryRow?.primary_hash ?? userHash;

  const seen = await db.query(
    `SELECT 1 FROM wrapped_views WHERE user_hash = ? AND year_month = ?`,
  ).get(primaryHash, ym) as any;

  return { latest_month: ym, viewed: !!seen };
}

export async function markWrappedSeen(db: DbClient, userHash: string, ym: string): Promise<void> {
  const primaryRow = await db.query(
    `SELECT COALESCE(linked_to, user_hash) AS primary_hash FROM users WHERE user_hash = ?`,
  ).get(userHash) as any;
  const primaryHash = primaryRow?.primary_hash ?? userHash;

  await db.query(
    `INSERT INTO wrapped_views (user_hash, year_month, viewed_at) VALUES (?, ?, ?)
     ON CONFLICT (user_hash, year_month) DO UPDATE SET viewed_at = EXCLUDED.viewed_at`,
  ).run(primaryHash, ym, new Date().toISOString());
}
