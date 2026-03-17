import { getDb, getPool } from "./db";
import {
  computeWeightedScore,
  computeTier,
  getUserRanksWithPercentiles,
  getDailyRanksForUser,
  getWeeklyRanksForUser,
  evaluateMilestoneBadges,
  evaluateRankingBadges,
  evaluateTeamBadges,
  estimateCost,
  getHotUsers,
} from "./services";

// ─── Helpers ────────────────────────────────────────────────────────────────

function json(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function error(message: string, status: number): Response {
  return json({ detail: message }, status);
}

async function parseBody(request: Request): Promise<any> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/** Extract YYYY-MM-DD from an ISO string or Date */
function toDateStr(d: Date | string): string {
  const s = typeof d === "string" ? d : d.toISOString();
  return s.split("T")[0] ?? s.slice(0, 10);
}

const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,20}$/;

/** Split a timestamp string like "2026-03-16T04:00:00" or "2026-03-16 04:00:00" into [date, time] */
function splitTimestamp(ts: string): [string, string] {
  const sep = ts.includes("T") ? "T" : " ";
  const parts = ts.split(sep);
  return [parts[0]!, parts[1] ?? "00:00:00"];
}

/** Fetch fresh profile data from an OAuth provider using the stored access token. */
async function fetchProviderProfile(
  provider: string,
  accessToken: string
): Promise<{ name?: string; avatar?: string; socialUsername?: string } | null> {
  try {
    if (provider === "twitter") {
      const res = await fetch("https://api.twitter.com/2/users/me?user.fields=profile_image_url,username", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) return null;
      const { data } = await res.json() as any;
      return {
        name: data?.name,
        avatar: data?.profile_image_url?.replace("_normal", ""),
        socialUsername: data?.username,
      };
    }
    if (provider === "github") {
      const res = await fetch("https://api.github.com/user", {
        headers: { Authorization: `Bearer ${accessToken}`, "User-Agent": "ClaudeRank" },
      });
      if (!res.ok) return null;
      const data = await res.json() as any;
      return {
        name: data?.name || data?.login,
        avatar: data?.avatar_url,
        socialUsername: data?.login,
      };
    }
    if (provider === "linkedin") {
      const res = await fetch("https://api.linkedin.com/v2/userinfo", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) return null;
      const data = await res.json() as any;
      return {
        name: data?.name,
        avatar: data?.picture,
      };
    }
  } catch (e) {
    console.error(`Provider profile fetch failed (${provider}):`, e);
  }
  return null;
}

// Simple banned words list for profanity filtering
const BANNED_WORDS = [
  "fuck", "shit", "ass", "bitch", "damn", "cunt", "dick", "cock",
  "pussy", "nigger", "nigga", "faggot", "fag", "retard",
];

function containsProfanity(text: string): boolean {
  const lower = text.toLowerCase();
  return BANNED_WORDS.some(word => lower.includes(word));
}

// ─── Route Matching ─────────────────────────────────────────────────────────

export async function handleApiRequest(url: URL, request: Request): Promise<Response | null> {
  const path = url.pathname;
  const method = request.method;

  // GET /api — root
  if (path === "/api" && method === "GET") {
    return json({ service: "ClaudeRank API", version: "1.0.0" });
  }

  // ─── Users Routes ───────────────────────────────────────────────────────

  // POST /api/users — register
  if (path === "/api/users" && method === "POST") {
    return handleRegisterUser(request);
  }

  // PUT /api/users/:user_hash/username
  const usernameMatch = path.match(/^\/api\/users\/([^/]+)\/username$/);
  if (usernameMatch && method === "PUT") {
    return handleSetUsername(usernameMatch[1]!, request);
  }

  // POST /api/users/:user_hash/connect — link social auth to user
  const connectMatch = path.match(/^\/api\/users\/([^/]+)\/connect$/);
  if (connectMatch && method === "POST") {
    return handleConnectAuth(connectMatch[1]!, request);
  }

  // GET /api/users/by-username/:username
  const byUsernameMatch = path.match(/^\/api\/users\/by-username\/([^/]+)$/);
  if (byUsernameMatch && method === "GET") {
    return handleGetUserByUsername(byUsernameMatch[1]!);
  }

  // POST /api/users/:user_hash/clear-cache
  const clearCacheMatch = path.match(/^\/api\/users\/([^/]+)\/clear-cache$/);
  if (clearCacheMatch && method === "POST") {
    return handleClearCache(clearCacheMatch[1]!);
  }

  // GET /api/users/:user_hash/history
  const historyMatch = path.match(/^\/api\/users\/([^/]+)\/history$/);
  if (historyMatch && method === "GET") {
    return handleGetUserHistory(historyMatch[1]!, url);
  }

  // GET /api/users/:user_hash/badges
  const userBadgesMatch = path.match(/^\/api\/users\/([^/]+)\/badges$/);
  if (userBadgesMatch && method === "GET") {
    return handleGetUserBadges(userBadgesMatch[1]!);
  }

  // GET /api/users/:user_hash/heatmap/hourly
  const hourlyHeatmapMatch = path.match(/^\/api\/users\/([^/]+)\/heatmap\/hourly$/);
  if (hourlyHeatmapMatch && method === "GET") {
    return handleGetHourlyHeatmap(hourlyHeatmapMatch[1]!, url);
  }

  // GET /api/users/:user_hash/heatmap
  const heatmapMatch = path.match(/^\/api\/users\/([^/]+)\/heatmap$/);
  if (heatmapMatch && method === "GET") {
    return handleGetHeatmap(heatmapMatch[1]!, url);
  }

  // GET /api/users/:user_hash/daily-ranks
  const dailyRanksMatch = path.match(/^\/api\/users\/([^/]+)\/daily-ranks$/);
  if (dailyRanksMatch && method === "GET") {
    return handleGetDailyRanks(dailyRanksMatch[1]!, url);
  }

  // GET /api/users/:user_hash/concurrency
  const concurrencyMatch = path.match(/^\/api\/users\/([^/]+)\/concurrency$/);
  if (concurrencyMatch && method === "GET") {
    return handleGetConcurrency(concurrencyMatch[1]!, url);
  }

  // GET /api/users/:user_hash — profile (must come after more specific routes)
  const userProfileMatch = path.match(/^\/api\/users\/([^/]+)$/);
  if (userProfileMatch && method === "GET") {
    return handleGetUserProfile(userProfileMatch[1]!);
  }

  // ─── Teams Routes ──────────────────────────────────────────────────────

  // POST /api/teams/leave
  if (path === "/api/teams/leave" && method === "POST") {
    return handleLeaveTeam(request);
  }

  // POST /api/teams
  if (path === "/api/teams" && method === "POST") {
    return handleCreateTeam(request);
  }

  // POST /api/teams/:team_hash/join
  const joinMatch = path.match(/^\/api\/teams\/([^/]+)\/join$/);
  if (joinMatch && method === "POST") {
    return handleJoinTeam(joinMatch[1]!, request);
  }

  // GET /api/teams/:team_hash/history
  const teamHistMatch = path.match(/^\/api\/teams\/([^/]+)\/history$/);
  if (teamHistMatch && method === "GET") {
    return handleGetTeamHistory(teamHistMatch[1]!, url);
  }

  // GET /api/teams/:team_hash
  const teamMatch = path.match(/^\/api\/teams\/([^/]+)$/);
  if (teamMatch && method === "GET") {
    return handleGetTeam(teamMatch[1]!);
  }

  // ─── Sync Route ─────────────────────────────────────────────────────────

  if (path === "/api/sync" && method === "POST") {
    return handleSync(request);
  }

  // ─── Leaderboard Route ─────────────────────────────────────────────────

  const leaderboardMatch = path.match(/^\/api\/leaderboard\/([^/]+)$/);
  if (leaderboardMatch && method === "GET") {
    return handleGetLeaderboard(leaderboardMatch[1]!, url);
  }

  // ─── Badges Route ──────────────────────────────────────────────────────

  if (path === "/api/badges" && method === "GET") {
    return handleGetAllBadges();
  }

  // ─── Hot Route ──────────────────────────────────────────────────────────

  if (path === "/api/hot" && method === "GET") {
    return handleGetHot(url);
  }

  return null;
}

// ─── Users Handlers ─────────────────────────────────────────────────────────

async function handleRegisterUser(request: Request): Promise<Response> {
  const body = await parseBody(request);
  if (!body?.user_hash) return error("user_hash is required", 400);

  const db = getDb();
  const existing = await db.query("SELECT user_hash, username FROM users WHERE user_hash = ?").get(body.user_hash) as any;
  if (existing) {
    return json({ status: "exists", user_hash: existing.user_hash, username: existing.username });
  }

  const now = new Date().toISOString();
  await db.query("INSERT INTO users (user_hash, created_at, updated_at) VALUES (?, ?, ?)").run(body.user_hash, now, now);
  return json({ status: "created", user_hash: body.user_hash });
}

async function handleSetUsername(userHash: string, request: Request): Promise<Response> {
  const body = await parseBody(request);
  if (!body?.username) return error("username is required", 400);

  const db = getDb();
  const user = await db.query("SELECT * FROM users WHERE user_hash = ?").get(userHash) as any;
  if (!user) return error("User not found", 404);

  const username = body.username.trim();
  if (!USERNAME_PATTERN.test(username)) {
    return error("Username must be 3-20 characters, alphanumeric and underscores only", 400);
  }

  if (containsProfanity(username)) {
    return error("Username contains inappropriate language", 400);
  }

  // Check uniqueness case-insensitive
  const existing = await db.query(
    "SELECT user_hash FROM users WHERE LOWER(username) = LOWER(?) AND user_hash != ?"
  ).get(username, userHash) as any;
  if (existing) {
    return error("Username already taken", 409);
  }

  const now = new Date().toISOString();
  await db.query("UPDATE users SET username = ?, updated_at = ? WHERE user_hash = ?").run(username, now, userHash);
  return json({ status: "ok", username });
}

async function handleGetUserByUsername(username: string): Promise<Response> {
  const db = getDb();
  const user = await db.query("SELECT user_hash, username FROM users WHERE LOWER(username) = LOWER(?)").get(username) as any;
  if (!user) return error("User not found", 404);
  return json({ user_hash: user.user_hash, username: user.username });
}

async function handleClearCache(userHash: string): Promise<Response> {
  const db = getDb();
  await db.query("DELETE FROM user_metrics WHERE user_hash = ?").run(userHash);
  await db.query("DELETE FROM metrics_history WHERE user_hash = ?").run(userHash);
  await db.query("DELETE FROM metrics_hourly WHERE user_hash = ?").run(userHash);
  await db.query("DELETE FROM user_badges WHERE user_hash = ?").run(userHash);
  await db.query("DELETE FROM concurrency_histogram WHERE user_hash = ?").run(userHash);
  await db.query("DELETE FROM daily_sessions WHERE user_hash = ?").run(userHash);
  return json({ status: "cleared" });
}

async function handleConnectAuth(userHash: string, request: Request): Promise<Response> {
  const body = await parseBody(request);
  if (!body) return error("Invalid request body", 400);

  const db = getDb();

  // Ensure user exists
  let user = await db.query("SELECT * FROM users WHERE user_hash = ?").get(userHash) as any;
  if (!user) {
    const now = new Date().toISOString();
    await db.query("INSERT INTO users (user_hash, created_at, updated_at) VALUES (?, ?, ?)").run(userHash, now, now);
    user = await db.query("SELECT * FROM users WHERE user_hash = ?").get(userHash) as any;
  }

  const now = new Date().toISOString();
  const provider = body.provider || null;
  let displayName = body.name || null;
  let avatarUrl = body.image || null;
  const authId = body.auth_id || null;

  // Disconnect (logout) — clear social fields
  if (!provider) {
    await db.query(
      `UPDATE users SET display_name = NULL, avatar_url = NULL, auth_provider = NULL, auth_id = NULL, social_url = NULL, updated_at = ? WHERE user_hash = ?`
    ).run(now, userHash);
    return json({ status: "disconnected" });
  }

  // Fetch fresh profile data from the provider via Better Auth's stored access token.
  // This ensures correct avatar + social username even when accounts are linked.
  let socialUrl: string | null = null;
  try {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT "accessToken" FROM account WHERE "userId" = $1 AND "providerId" = $2 ORDER BY "updatedAt" DESC LIMIT 1`,
      [authId, provider]
    );
    const account = rows[0] as any;

    if (account?.accessToken) {
      const fresh = await fetchProviderProfile(provider, account.accessToken);
      if (fresh) {
        if (fresh.avatar) avatarUrl = fresh.avatar;
        if (fresh.name) displayName = fresh.name;
        if (fresh.socialUsername) {
          if (provider === "twitter") socialUrl = `https://x.com/${fresh.socialUsername}`;
          else if (provider === "github") socialUrl = `https://github.com/${fresh.socialUsername}`;
          else if (provider === "linkedin") socialUrl = `https://linkedin.com/in/${fresh.socialUsername}`;
        }
      }
    }
  } catch (e) {
    console.error("Failed to fetch provider profile:", e);
  }

  // Set username from social name if user doesn't have one
  let username = user.username;
  if (!username && displayName) {
    let candidate = displayName.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "").slice(0, 20);
    if (candidate.length < 3) candidate = candidate + "_user";
    const taken = await db.query("SELECT 1 FROM users WHERE LOWER(username) = LOWER(?) AND user_hash != ?").get(candidate, userHash);
    if (!taken && USERNAME_PATTERN.test(candidate)) {
      username = candidate;
    }
  }

  await db.query(
    `UPDATE users SET display_name = ?, avatar_url = ?, auth_provider = ?, auth_id = ?,
     social_url = ?, username = COALESCE(?, username), updated_at = ? WHERE user_hash = ?`
  ).run(displayName, avatarUrl, provider, authId, socialUrl, username, now, userHash);

  return json({
    status: "connected",
    display_name: displayName,
    avatar_url: avatarUrl,
    auth_provider: provider,
    social_url: socialUrl,
    username,
  });
}

async function handleGetUserProfile(userHash: string): Promise<Response> {
  const db = getDb();
  const user = await db.query("SELECT * FROM users WHERE user_hash = ?").get(userHash) as any;
  if (!user) return error("User not found", 404);

  const metrics = await db.query("SELECT * FROM user_metrics WHERE user_hash = ?").get(userHash) as any;
  const ranks = await getUserRanksWithPercentiles(db, userHash);

  const weighted = metrics?.weighted_score ?? 0;
  const tier = computeTier(weighted);

  // Get badges
  const badges = await db.query(
    `SELECT b.id, b.name, b.icon, b.category, ub.unlocked_at
     FROM user_badges ub JOIN badges b ON ub.badge_id = b.id
     WHERE ub.user_hash = ?`
  ).all(userHash) as any[];

  // Get concurrency stats for today
  const today = new Date().toISOString().split("T")[0]!;
  const todayStart = `${today}T00:00:00`;
  const todayEnd = `${today}T23:59:59`;

  const concurrencyRows = await db.query(
    `SELECT histogram FROM concurrency_histogram
     WHERE user_hash = ? AND snapshot_hour >= ? AND snapshot_hour <= ?`
  ).all(userHash, todayStart, todayEnd) as any[];

  let maxConcurrent = 0;
  let concurrentMins = 0;
  for (const row of concurrencyRows) {
    try {
      const histogram = row.histogram ? JSON.parse(row.histogram) : {};
      for (const [sessionsStr, minutes] of Object.entries(histogram)) {
        const sessionCount = parseInt(sessionsStr, 10);
        const mins = minutes as number;
        if (sessionCount > maxConcurrent) maxConcurrent = sessionCount;
        if (sessionCount > 1) concurrentMins += mins;
      }
    } catch {
      continue;
    }
  }

  return json({
    user_hash: user.user_hash,
    username: user.username,
    display_name: user.display_name ?? null,
    avatar_url: user.avatar_url ?? null,
    auth_provider: user.auth_provider ?? null,
    social_url: user.social_url ?? null,
    team_hash: user.team_hash,
    created_at: user.created_at,
    metrics: {
      total_tokens: metrics?.total_tokens ?? 0,
      total_messages: metrics?.total_messages ?? 0,
      total_sessions: metrics?.total_sessions ?? 0,
      total_tool_calls: metrics?.total_tool_calls ?? 0,
      prompt_uniqueness_score: metrics?.prompt_uniqueness_score ?? 0,
      weighted_score: weighted,
      current_streak: metrics?.current_streak ?? 0,
      total_points: metrics?.total_points ?? 0,
      level: metrics?.level ?? 0,
      last_synced: metrics?.last_synced ?? null,
      max_concurrent: maxConcurrent,
      concurrent_mins: concurrentMins,
      estimated_spend: metrics?.estimated_spend ?? 0,
    },
    ranks,
    tier,
    badges: badges.map(b => ({
      id: b.id,
      name: b.name,
      icon: b.icon,
      category: b.category,
      unlocked_at: b.unlocked_at,
    })),
  });
}

async function handleGetUserHistory(userHash: string, url: URL): Promise<Response> {
  const days = parseInt(url.searchParams.get("days") ?? "30", 10);
  const db = getDb();

  const rows = await db.query(
    `SELECT * FROM metrics_history
     WHERE user_hash = ?
     ORDER BY snapshot_date DESC
     LIMIT ?`
  ).all(userHash, days) as any[];

  return json(rows.map(r => ({
    date: r.snapshot_date,
    tokens: r.total_tokens,
    daily_tokens: r.daily_tokens ?? 0,
    messages: r.total_messages,
    sessions: r.total_sessions,
    tool_calls: r.total_tool_calls,
    uniqueness: r.prompt_uniqueness_score,
    weighted: r.weighted_score,
  })));
}

async function handleGetUserBadges(userHash: string): Promise<Response> {
  const db = getDb();
  const rows = await db.query(
    `SELECT b.id, b.name, b.description, b.icon, b.category, ub.unlocked_at
     FROM user_badges ub JOIN badges b ON ub.badge_id = b.id
     WHERE ub.user_hash = ?`
  ).all(userHash) as any[];

  return json(rows.map(b => ({
    id: b.id,
    name: b.name,
    description: b.description,
    icon: b.icon,
    category: b.category,
    unlocked_at: b.unlocked_at,
  })));
}

async function handleGetHourlyHeatmap(userHash: string, url: URL): Promise<Response> {
  const hours = Math.min(720, Math.max(1, parseInt(url.searchParams.get("hours") ?? "24", 10)));
  const db = getDb();

  const now = new Date();
  const startHour = new Date(now);
  startHour.setUTCHours(startHour.getUTCHours() - hours);
  startHour.setUTCMinutes(0, 0, 0);

  const startHourStr = startHour.toISOString().replace(/\.\d{3}Z$/, "");

  const snapshots = await db.query(
    `SELECT * FROM metrics_hourly
     WHERE user_hash = ? AND snapshot_hour >= ?
     ORDER BY snapshot_hour ASC`
  ).all(userHash, startHourStr) as any[];

  const snapMap: Record<string, any> = {};
  for (const s of snapshots) {
    snapMap[s.snapshot_hour] = s;
  }

  const heatmap: any[] = [];
  const current = new Date(startHour);
  while (current <= now) {
    // Try multiple key formats to match stored data
    const isoKey = current.toISOString().replace(/\.\d{3}Z$/, "");
    // Also try format without seconds
    const y = current.getUTCFullYear();
    const mo = String(current.getUTCMonth() + 1).padStart(2, "0");
    const d = String(current.getUTCDate()).padStart(2, "0");
    const h = String(current.getUTCHours()).padStart(2, "0");
    const altKey = `${y}-${mo}-${d}T${h}:00:00`;

    const snap = snapMap[isoKey] ?? snapMap[altKey];
    const messages = snap?.total_messages ?? 0;

    heatmap.push({
      hour: isoKey,
      tokens: 0,
      messages,
      tool_calls: 0,
      activity: messages,
    });
    current.setUTCHours(current.getUTCHours() + 1);
  }

  // Compute intensity levels
  const activities = heatmap.filter(d => d.activity > 0).map(d => d.activity).sort((a, b) => a - b);
  if (activities.length > 0) {
    const q1 = activities.length > 3 ? activities[Math.floor(activities.length / 4)] : activities[0];
    const q2 = activities.length > 1 ? activities[Math.floor(activities.length / 2)] : activities[0];
    const q3 = activities.length > 3 ? activities[Math.floor(activities.length * 3 / 4)] : activities[activities.length - 1];
    for (const d of heatmap) {
      const a = d.activity;
      if (a === 0) d.intensity = 0;
      else if (a <= q1) d.intensity = 1;
      else if (a <= q2) d.intensity = 2;
      else if (a <= q3) d.intensity = 3;
      else d.intensity = 4;
    }
  } else {
    for (const d of heatmap) d.intensity = 0;
  }

  return json(heatmap);
}

async function handleGetHeatmap(userHash: string, url: URL): Promise<Response> {
  const days = Math.min(730, Math.max(1, parseInt(url.searchParams.get("days") ?? "365", 10)));
  const db = getDb();

  const today = new Date();
  const endDate = today.toISOString().split("T")[0]!;
  const startDateObj = new Date(today);
  startDateObj.setUTCDate(startDateObj.getUTCDate() - days);
  const startDate = startDateObj.toISOString().split("T")[0]!;

  const snapshots = await db.query(
    `SELECT * FROM metrics_history
     WHERE user_hash = ? AND snapshot_date >= ?
     ORDER BY snapshot_date ASC`
  ).all(userHash, startDate) as any[];

  const snapMap: Record<string, any> = {};
  for (const s of snapshots) {
    snapMap[s.snapshot_date] = s;
  }

  const heatmap: any[] = [];
  let prev: any = null;
  const current = new Date(startDateObj);
  const endDateObj = new Date(endDate + "T00:00:00Z");

  while (current <= endDateObj) {
    const dateStr = current.toISOString().split("T")[0]!;
    const snap = snapMap[dateStr];

    let tokens = 0, messages = 0, toolCalls = 0, activity = 0;

    if (snap && (snap.daily_messages ?? 0) > 0) {
      messages = snap.daily_messages;
      toolCalls = snap.daily_tool_calls ?? 0;
      tokens = snap.daily_tokens ?? 0;
      if (tokens === 0 && prev) {
        tokens = Math.max(0, snap.total_tokens - prev.total_tokens);
      }
      activity = messages;
    } else if (snap && prev) {
      tokens = Math.max(0, snap.total_tokens - prev.total_tokens);
      messages = Math.max(0, snap.total_messages - prev.total_messages);
      toolCalls = Math.max(0, snap.total_tool_calls - prev.total_tool_calls);
      activity = tokens + messages * 1000 + toolCalls * 500;
    }

    heatmap.push({ date: dateStr, tokens, messages, tool_calls: toolCalls, activity });
    if (snap) prev = snap;
    current.setUTCDate(current.getUTCDate() + 1);
  }

  // Compute intensity levels
  const activities = heatmap.filter(d => d.activity > 0).map(d => d.activity).sort((a, b) => a - b);
  if (activities.length > 0) {
    const q1 = activities.length > 3 ? activities[Math.floor(activities.length / 4)] : activities[0];
    const q2 = activities.length > 1 ? activities[Math.floor(activities.length / 2)] : activities[0];
    const q3 = activities.length > 3 ? activities[Math.floor(activities.length * 3 / 4)] : activities[activities.length - 1];
    for (const d of heatmap) {
      const a = d.activity;
      if (a === 0) d.intensity = 0;
      else if (a <= q1) d.intensity = 1;
      else if (a <= q2) d.intensity = 2;
      else if (a <= q3) d.intensity = 3;
      else d.intensity = 4;
    }
  } else {
    for (const d of heatmap) d.intensity = 0;
  }

  return json(heatmap);
}

async function handleGetDailyRanks(userHash: string, url: URL): Promise<Response> {
  const queryDate = url.searchParams.get("date");
  const period = url.searchParams.get("period") ?? "day";

  let target: string;
  if (queryDate) {
    // Validate date format
    if (!/^\d{4}-\d{2}-\d{2}$/.test(queryDate)) {
      return error("Invalid date format, use YYYY-MM-DD", 400);
    }
    target = queryDate;
  } else {
    target = new Date().toISOString().split("T")[0]!;
  }

  const db = getDb();

  let ranks: Record<string, any>;
  if (period === "week") {
    ranks = await getWeeklyRanksForUser(db, userHash, target);
  } else {
    ranks = await getDailyRanksForUser(db, userHash, target);
  }

  return json({ date: target, period, ranks });
}

async function handleGetConcurrency(userHash: string, url: URL): Promise<Response> {
  const db = getDb();
  const queryDate = url.searchParams.get("date");

  if (queryDate !== null) {
    // Date-based: full 24h histogram for the given UTC date
    if (!/^\d{4}-\d{2}-\d{2}$/.test(queryDate)) {
      return error("Invalid date format, use YYYY-MM-DD", 400);
    }

    // Clamp future dates
    const today = new Date().toISOString().split("T")[0]!;
    const targetDate = queryDate > today ? today : queryDate;

    const dayStart = `${targetDate}T00:00:00`;
    const dayEnd = `${targetDate}T23:59:59`;

    // Fetch concurrency histograms
    const rows = await db.query(
      `SELECT snapshot_hour, histogram FROM concurrency_histogram
       WHERE user_hash = ? AND snapshot_hour >= ? AND snapshot_hour <= ?`
    ).all(userHash, dayStart, dayEnd) as any[];

    const perHour: Record<string, any> = {};
    for (const row of rows) {
      try {
        const histogram = row.histogram ? JSON.parse(row.histogram) : {};
        const snapshotDate = splitTimestamp(row.snapshot_hour)[0];
        const hour = parseInt(splitTimestamp(row.snapshot_hour)[1].split(":")[0]!, 10);
        const hourKey = `${snapshotDate}:${hour}`;
        perHour[hourKey] = { histogram, tokens: 0 };
      } catch {
        continue;
      }
    }

    // Fetch hourly token data
    const tokenRows = await db.query(
      `SELECT snapshot_hour, total_tokens FROM metrics_hourly
       WHERE user_hash = ? AND snapshot_hour >= ? AND snapshot_hour <= ?`
    ).all(userHash, dayStart, dayEnd) as any[];

    for (const row of tokenRows) {
      const snapshotDate = splitTimestamp(row.snapshot_hour)[0];
      const hour = parseInt(splitTimestamp(row.snapshot_hour)[1].split(":")[0]!, 10);
      const hourKey = `${snapshotDate}:${hour}`;
      if (perHour[hourKey]) {
        perHour[hourKey].tokens = row.total_tokens ?? 0;
      } else if (row.total_tokens && row.total_tokens > 0) {
        perHour[hourKey] = { histogram: {}, tokens: row.total_tokens };
      }
    }

    // Fetch day sessions
    const dsRow = await db.query(
      "SELECT sessions FROM daily_sessions WHERE user_hash = ? AND snapshot_date = ?"
    ).get(userHash, targetDate) as any;
    if (dsRow?.sessions) {
      try {
        perHour["sessions"] = JSON.parse(dsRow.sessions);
      } catch {
        // ignore
      }
    }

    return json(perHour);
  }

  // Legacy: last N hours of peak concurrency
  const hours = parseInt(url.searchParams.get("hours") ?? "12", 10);
  const now = new Date();
  const startTime = new Date(now);
  startTime.setUTCHours(startTime.getUTCHours() - hours);
  const startTimeStr = startTime.toISOString().replace(/\.\d{3}Z$/, "");

  const rows = await db.query(
    `SELECT snapshot_hour, histogram FROM concurrency_histogram
     WHERE user_hash = ? AND snapshot_hour >= ?`
  ).all(userHash, startTimeStr) as any[];

  const perHour: Record<string, number> = {};
  for (const row of rows) {
    try {
      const histogram = row.histogram ? JSON.parse(row.histogram) : {};
      let peak = 0;
      for (const [sessionsStr, minutes] of Object.entries(histogram)) {
        const s = parseInt(sessionsStr, 10);
        if (s > peak) peak = s;
      }
      const snapshotDate = splitTimestamp(row.snapshot_hour)[0];
      const hour = parseInt(splitTimestamp(row.snapshot_hour)[1].split(":")[0]!, 10);
      const hourKey = `${snapshotDate}:${hour}`;
      perHour[hourKey] = peak;
    } catch {
      continue;
    }
  }

  return json(perHour);
}

// ─── Teams Handlers ─────────────────────────────────────────────────────────

function generateTeamHash(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 8; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

async function handleCreateTeam(request: Request): Promise<Response> {
  const body = await parseBody(request);
  if (!body?.user_hash || !body?.team_name) {
    return error("user_hash and team_name are required", 400);
  }

  const db = getDb();
  const user = await db.query("SELECT * FROM users WHERE user_hash = ?").get(body.user_hash) as any;
  if (!user) return error("User not found", 404);
  if (user.team_hash) return error("Already in a team. Leave first.", 400);

  const teamName = body.team_name.trim();
  if (!teamName || teamName.length > 30) {
    return error("Team name must be 1-30 characters", 400);
  }

  const teamHash = generateTeamHash();
  const now = new Date().toISOString();

  await db.query("INSERT INTO teams (team_hash, team_name, created_by, created_at) VALUES (?, ?, ?, ?)").run(
    teamHash, teamName, body.user_hash, now
  );
  await db.query("UPDATE users SET team_hash = ?, updated_at = ? WHERE user_hash = ?").run(
    teamHash, now, body.user_hash
  );

  return json({ team_hash: teamHash, team_name: teamName });
}

async function handleJoinTeam(teamHash: string, request: Request): Promise<Response> {
  const body = await parseBody(request);
  if (!body?.user_hash) return error("user_hash is required", 400);

  const db = getDb();
  const user = await db.query("SELECT * FROM users WHERE user_hash = ?").get(body.user_hash) as any;
  if (!user) return error("User not found", 404);
  if (user.team_hash) return error("Already in a team. Leave first.", 400);

  const team = await db.query("SELECT * FROM teams WHERE team_hash = ?").get(teamHash) as any;
  if (!team) return error("Team not found", 404);

  const now = new Date().toISOString();
  await db.query("UPDATE users SET team_hash = ?, updated_at = ? WHERE user_hash = ?").run(teamHash, now, body.user_hash);

  return json({ status: "joined", team_hash: teamHash, team_name: team.team_name });
}

async function handleLeaveTeam(request: Request): Promise<Response> {
  const body = await parseBody(request);
  if (!body?.user_hash) return error("user_hash is required", 400);

  const db = getDb();
  const user = await db.query("SELECT * FROM users WHERE user_hash = ?").get(body.user_hash) as any;
  if (!user) return error("User not found", 404);
  if (!user.team_hash) return error("Not in a team", 400);

  const now = new Date().toISOString();
  await db.query("UPDATE users SET team_hash = NULL, updated_at = ? WHERE user_hash = ?").run(now, body.user_hash);

  return json({ status: "left" });
}

async function handleGetTeam(teamHash: string): Promise<Response> {
  const db = getDb();
  const team = await db.query("SELECT * FROM teams WHERE team_hash = ?").get(teamHash) as any;
  if (!team) return error("Team not found", 404);

  const members = await db.query("SELECT user_hash, username FROM users WHERE team_hash = ?").all(teamHash) as any[];
  const memberHashes = members.map(m => m.user_hash);

  let aggTokens = 0, aggMessages = 0, aggSessions = 0, aggToolCalls = 0;
  if (memberHashes.length > 0) {
    const placeholders = memberHashes.map((_: any, i: number) => `$${i + 1}`).join(",");
    const pool = getPool();
    const { rows: [agg] } = await pool.query(
      `SELECT COALESCE(SUM(total_tokens), 0) as tokens,
              COALESCE(SUM(total_messages), 0) as messages,
              COALESCE(SUM(total_sessions), 0) as sessions,
              COALESCE(SUM(total_tool_calls), 0) as tool_calls
       FROM user_metrics WHERE user_hash IN (${placeholders})`,
      memberHashes
    );
    aggTokens = agg?.tokens ?? 0;
    aggMessages = agg?.messages ?? 0;
    aggSessions = agg?.sessions ?? 0;
    aggToolCalls = agg?.tool_calls ?? 0;
  }

  return json({
    team_hash: team.team_hash,
    team_name: team.team_name,
    created_by: team.created_by,
    created_at: team.created_at,
    member_count: members.length,
    members: members.map(m => ({ user_hash: m.user_hash, username: m.username })),
    metrics: {
      total_tokens: aggTokens,
      total_messages: aggMessages,
      total_sessions: aggSessions,
      total_tool_calls: aggToolCalls,
    },
  });
}

async function handleGetTeamHistory(teamHash: string, url: URL): Promise<Response> {
  const days = parseInt(url.searchParams.get("days") ?? "30", 10);
  const db = getDb();

  const members = await db.query("SELECT user_hash FROM users WHERE team_hash = ?").all(teamHash) as any[];
  const memberHashes = members.map(m => m.user_hash);
  if (memberHashes.length === 0) return json([]);

  const placeholders = memberHashes.map((_: any, i: number) => `$${i + 1}`).join(",");
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT snapshot_date,
            SUM(total_tokens) as tokens,
            SUM(total_messages) as messages,
            SUM(total_sessions) as sessions,
            SUM(total_tool_calls) as tool_calls
     FROM metrics_history
     WHERE user_hash IN (${placeholders})
     GROUP BY snapshot_date
     ORDER BY snapshot_date DESC
     LIMIT $${memberHashes.length + 1}`,
    [...memberHashes, days]
  );

  return json(rows.map((r: any) => ({
    date: r.snapshot_date,
    tokens: r.tokens ?? 0,
    messages: r.messages ?? 0,
    sessions: r.sessions ?? 0,
    tool_calls: r.tool_calls ?? 0,
  })));
}

// ─── Sync Handler ───────────────────────────────────────────────────────────

async function handleSync(request: Request): Promise<Response> {
  const req = await parseBody(request);
  if (!req?.user_hash) return error("user_hash is required", 400);

  const db = getDb();
  const totals = req.totals ?? {};

  // Ensure user exists
  const existingUser = await db.query("SELECT user_hash FROM users WHERE user_hash = ?").get(req.user_hash) as any;
  if (!existingUser) {
    const now = new Date().toISOString();
    await db.query("INSERT INTO users (user_hash, created_at, updated_at) VALUES (?, ?, ?)").run(req.user_hash, now, now);
  }

  // Compute prompt uniqueness
  let promptUniqueness = 0.0;
  if (req.prompt_hashes && Array.isArray(req.prompt_hashes) && req.prompt_hashes.length > 0) {
    const uniqueCount = new Set(req.prompt_hashes).size;
    const totalCount = req.prompt_hashes.length;
    promptUniqueness = totalCount > 0 ? uniqueCount / totalCount : 0.0;
  }

  const weighted = computeWeightedScore(
    totals.total_tokens ?? 0,
    totals.total_messages ?? 0,
    totals.total_sessions ?? 0,
    totals.total_tool_calls ?? 0,
    promptUniqueness,
  );

  const estimatedSpend = req.token_breakdown ? estimateCost(req.token_breakdown) : 0.0;

  const now = new Date().toISOString();
  const today = new Date().toISOString().split("T")[0]!;

  // Upsert user_metrics
  const existingMetrics = await db.query("SELECT user_hash FROM user_metrics WHERE user_hash = ?").get(req.user_hash) as any;
  if (existingMetrics) {
    await db.query(
      `UPDATE user_metrics SET
        total_tokens = ?, total_messages = ?, total_sessions = ?, total_tool_calls = ?,
        prompt_uniqueness_score = ?, weighted_score = ?, estimated_spend = ?,
        current_streak = ?, total_points = ?, level = ?, last_synced = ?,
        total_session_time_secs = ?, total_active_time_secs = ?, total_idle_time_secs = ?
       WHERE user_hash = ?`
    ).run(
      totals.total_tokens ?? 0, totals.total_messages ?? 0,
      totals.total_sessions ?? 0, totals.total_tool_calls ?? 0,
      promptUniqueness, weighted, estimatedSpend,
      totals.current_streak ?? 0, totals.total_points ?? 0, totals.level ?? 0, now,
      totals.total_session_time_secs ?? 0, totals.total_active_time_secs ?? 0,
      totals.total_idle_time_secs ?? 0,
      req.user_hash,
    );
  } else {
    await db.query(
      `INSERT INTO user_metrics (
        user_hash, total_tokens, total_messages, total_sessions, total_tool_calls,
        prompt_uniqueness_score, weighted_score, estimated_spend,
        current_streak, total_points, level, last_synced,
        total_session_time_secs, total_active_time_secs, total_idle_time_secs
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      req.user_hash,
      totals.total_tokens ?? 0, totals.total_messages ?? 0,
      totals.total_sessions ?? 0, totals.total_tool_calls ?? 0,
      promptUniqueness, weighted, estimatedSpend,
      totals.current_streak ?? 0, totals.total_points ?? 0, totals.level ?? 0, now,
      totals.total_session_time_secs ?? 0, totals.total_active_time_secs ?? 0,
      totals.total_idle_time_secs ?? 0,
    );
  }

  // Upsert daily snapshot
  const existingHist = await db.query(
    "SELECT id FROM metrics_history WHERE user_hash = ? AND snapshot_date = ?"
  ).get(req.user_hash, today) as any;
  if (existingHist) {
    await db.query(
      `UPDATE metrics_history SET
        total_tokens = ?, total_messages = ?, total_sessions = ?, total_tool_calls = ?,
        prompt_uniqueness_score = ?, weighted_score = ?
       WHERE user_hash = ? AND snapshot_date = ?`
    ).run(
      totals.total_tokens ?? 0, totals.total_messages ?? 0,
      totals.total_sessions ?? 0, totals.total_tool_calls ?? 0,
      promptUniqueness, weighted,
      req.user_hash, today,
    );
  } else {
    await db.query(
      `INSERT INTO metrics_history (
        user_hash, snapshot_date, total_tokens, total_messages, total_sessions, total_tool_calls,
        prompt_uniqueness_score, weighted_score
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      req.user_hash, today,
      totals.total_tokens ?? 0, totals.total_messages ?? 0,
      totals.total_sessions ?? 0, totals.total_tool_calls ?? 0,
      promptUniqueness, weighted,
    );
  }

  // Persist hour_counts
  if (req.hour_counts && typeof req.hour_counts === "object") {
    for (const [hourStr, count] of Object.entries(req.hour_counts)) {
      if (typeof count !== "number" || count <= 0) continue;
      let snapshotHour: string;
      let h: number;
      try {
        if (hourStr.includes(":")) {
          const lastColon = hourStr.lastIndexOf(":");
          const datePart = hourStr.substring(0, lastColon);
          h = parseInt(hourStr.substring(lastColon + 1), 10);
          snapshotHour = `${datePart}T${String(h).padStart(2, "0")}:00:00`;
        } else {
          h = parseInt(hourStr, 10);
          const todayDate = now.split("T")[0]!;
          snapshotHour = `${todayDate}T${String(h).padStart(2, "0")}:00:00`;
        }
      } catch {
        continue;
      }
      if (h < 0 || h > 23) continue;

      const existingHourly = await db.query(
        "SELECT id FROM metrics_hourly WHERE user_hash = ? AND snapshot_hour = ?"
      ).get(req.user_hash, snapshotHour) as any;
      if (existingHourly) {
        await db.query("UPDATE metrics_hourly SET total_messages = ? WHERE user_hash = ? AND snapshot_hour = ?").run(
          count, req.user_hash, snapshotHour
        );
      } else {
        await db.query(
          "INSERT INTO metrics_hourly (user_hash, snapshot_hour, total_messages) VALUES (?, ?, ?)"
        ).run(req.user_hash, snapshotHour, count);
      }
    }
  }

  // Persist hour_tokens
  if (req.hour_tokens && typeof req.hour_tokens === "object") {
    for (const [hourStr, tokenCount] of Object.entries(req.hour_tokens)) {
      if (typeof tokenCount !== "number" || tokenCount <= 0) continue;
      if (!hourStr.includes(":")) continue;
      let snapshotHour: string;
      let h: number;
      try {
        const lastColon = hourStr.lastIndexOf(":");
        const datePart = hourStr.substring(0, lastColon);
        h = parseInt(hourStr.substring(lastColon + 1), 10);
        snapshotHour = `${datePart}T${String(h).padStart(2, "0")}:00:00`;
      } catch {
        continue;
      }
      if (h < 0 || h > 23) continue;

      const existing = await db.query(
        "SELECT id FROM metrics_hourly WHERE user_hash = ? AND snapshot_hour = ?"
      ).get(req.user_hash, snapshotHour) as any;
      if (existing) {
        await db.query("UPDATE metrics_hourly SET total_tokens = ? WHERE user_hash = ? AND snapshot_hour = ?").run(
          tokenCount, req.user_hash, snapshotHour
        );
      } else {
        await db.query(
          "INSERT INTO metrics_hourly (user_hash, snapshot_hour, total_tokens) VALUES (?, ?, ?)"
        ).run(req.user_hash, snapshotHour, tokenCount);
      }
    }
  }

  // Persist daily_activity
  if (req.daily_activity && Array.isArray(req.daily_activity)) {
    for (const entry of req.daily_activity) {
      if (!entry || typeof entry !== "object" || !entry.date) continue;
      let entryDate: string;
      try {
        entryDate = entry.date;
        // Validate date format
        if (!/^\d{4}-\d{2}-\d{2}$/.test(entryDate)) continue;
      } catch {
        continue;
      }
      const msgCount = entry.messageCount ?? 0;
      const toolCount = entry.toolCallCount ?? 0;
      const tokenCountVal = entry.tokenCount ?? 0;
      if (msgCount <= 0 && toolCount <= 0 && tokenCountVal <= 0) continue;

      const existingDay = await db.query(
        "SELECT id FROM metrics_history WHERE user_hash = ? AND snapshot_date = ?"
      ).get(req.user_hash, entryDate) as any;
      if (existingDay) {
        await db.query(
          `UPDATE metrics_history SET daily_messages = ?, daily_tool_calls = ?, daily_tokens = ?
           WHERE user_hash = ? AND snapshot_date = ?`
        ).run(msgCount, toolCount, tokenCountVal, req.user_hash, entryDate);
      } else {
        await db.query(
          `INSERT INTO metrics_history (user_hash, snapshot_date, daily_messages, daily_tool_calls, daily_tokens)
           VALUES (?, ?, ?, ?, ?)`
        ).run(req.user_hash, entryDate, msgCount, toolCount, tokenCountVal);
      }
    }
  }

  // Persist concurrency_histogram
  if (req.concurrency_histogram && typeof req.concurrency_histogram === "object") {
    for (const [hourKey, histogram] of Object.entries(req.concurrency_histogram)) {
      if (!hourKey.includes(":")) continue;
      if (!histogram || typeof histogram !== "object") continue;
      let snapshotHour: string;
      let h: number;
      try {
        const lastColon = hourKey.lastIndexOf(":");
        const datePart = hourKey.substring(0, lastColon);
        h = parseInt(hourKey.substring(lastColon + 1), 10);
        snapshotHour = `${datePart}T${String(h).padStart(2, "0")}:00:00`;
      } catch {
        continue;
      }
      if (h < 0 || h > 23) continue;

      const histogramJson = JSON.stringify(histogram);
      const existing = await db.query(
        "SELECT id FROM concurrency_histogram WHERE user_hash = ? AND snapshot_hour = ?"
      ).get(req.user_hash, snapshotHour) as any;
      if (existing) {
        await db.query(
          "UPDATE concurrency_histogram SET histogram = ? WHERE user_hash = ? AND snapshot_hour = ?"
        ).run(histogramJson, req.user_hash, snapshotHour);
      } else {
        await db.query(
          "INSERT INTO concurrency_histogram (user_hash, snapshot_hour, histogram) VALUES (?, ?, ?)"
        ).run(req.user_hash, snapshotHour, histogramJson);
      }
    }
  }

  // Persist day_sessions
  if (req.day_sessions && typeof req.day_sessions === "object") {
    for (const [dateStr, sessionsList] of Object.entries(req.day_sessions)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) continue;
      if (!sessionsList || !Array.isArray(sessionsList)) continue;

      const sessionsJson = JSON.stringify(sessionsList);
      const existing = await db.query(
        "SELECT id FROM daily_sessions WHERE user_hash = ? AND snapshot_date = ?"
      ).get(req.user_hash, dateStr) as any;
      if (existing) {
        await db.query(
          "UPDATE daily_sessions SET sessions = ? WHERE user_hash = ? AND snapshot_date = ?"
        ).run(sessionsJson, req.user_hash, dateStr);
      } else {
        await db.query(
          "INSERT INTO daily_sessions (user_hash, snapshot_date, sessions) VALUES (?, ?, ?)"
        ).run(req.user_hash, dateStr, sessionsJson);
      }
    }
  }

  // Evaluate badges
  const metrics = await db.query("SELECT * FROM user_metrics WHERE user_hash = ?").get(req.user_hash) as any;
  const newBadges: string[] = [];
  newBadges.push(...await evaluateMilestoneBadges(db, req.user_hash, metrics));
  newBadges.push(...await evaluateRankingBadges(db, req.user_hash));
  newBadges.push(...await evaluateTeamBadges(db, req.user_hash));

  return json({
    status: "ok",
    weighted_score: weighted,
    prompt_uniqueness_score: promptUniqueness,
    new_badges: newBadges,
  });
}

// ─── Leaderboard Handler ───────────────────────────────────────────────────

const LEADERBOARD_CATEGORIES: Record<string, string> = {
  tokens: "total_tokens",
  messages: "(total_messages + total_sessions)",
  tools: "total_tool_calls",
  uniqueness: "prompt_uniqueness_score",
  weighted: "weighted_score",
  cost: "estimated_spend",
};

const TEAM_COL_NAMES: Record<string, string> = {
  tokens: "total_tokens",
  messages: "total_messages",
  tools: "total_tool_calls",
  uniqueness: "prompt_uniqueness_score",
  weighted: "weighted_score",
  cost: "estimated_spend",
};

async function handleGetLeaderboard(category: string, url: URL): Promise<Response> {
  if (!LEADERBOARD_CATEGORIES[category]) {
    return error(`Invalid category. Must be one of: ${Object.keys(LEADERBOARD_CATEGORIES).join(", ")}`, 400);
  }

  const scope = url.searchParams.get("scope") ?? "individual";
  if (scope !== "individual" && scope !== "team") {
    return error("scope must be 'individual' or 'team'", 400);
  }

  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") ?? "50", 10)));
  const offset = Math.max(0, parseInt(url.searchParams.get("offset") ?? "0", 10));

  const db = getDb();
  const col = LEADERBOARD_CATEGORIES[category];

  if (scope === "individual") {
    const rows = await db.query(
      `SELECT u.user_hash, u.username, ${col} as value, um.weighted_score
       FROM users u JOIN user_metrics um ON u.user_hash = um.user_hash
       ORDER BY ${col} DESC
       LIMIT ? OFFSET ?`
    ).all(limit, offset) as any[];

    const entries = rows.map((row, i) => ({
      rank: offset + i + 1,
      user_hash: row.user_hash,
      username: row.username,
      value: typeof row.value === "number" && !Number.isInteger(row.value) ? row.value : Number(row.value),
      weighted_score: row.weighted_score,
      tier: computeTier(row.weighted_score).tier,
    }));

    const countRow = await db.query("SELECT COUNT(*) as cnt FROM user_metrics").get() as any;
    const total = countRow?.cnt ?? 0;

    return json({ category, scope: "individual", entries, total_count: total });
  } else {
    // Team scope
    const teamColName = TEAM_COL_NAMES[category];
    const teamCol = category === "messages"
      ? "(um.total_messages + um.total_sessions)"
      : `um.${teamColName}`;

    const rows = await db.query(
      `SELECT u.team_hash, t.team_name, SUM(${teamCol}) as value, COUNT(u.user_hash) as member_count
       FROM users u
       JOIN user_metrics um ON u.user_hash = um.user_hash
       JOIN teams t ON u.team_hash = t.team_hash
       WHERE u.team_hash IS NOT NULL
       GROUP BY u.team_hash, t.team_name
       ORDER BY value DESC
       LIMIT ? OFFSET ?`
    ).all(limit, offset) as any[];

    const entries = rows.map((row, i) => ({
      rank: offset + i + 1,
      team_hash: row.team_hash,
      team_name: row.team_name,
      value: typeof row.value === "number" && !Number.isInteger(row.value) ? row.value : Number(row.value),
      member_count: row.member_count,
    }));

    const countRow = await db.query(
      "SELECT COUNT(DISTINCT team_hash) as cnt FROM users WHERE team_hash IS NOT NULL"
    ).get() as any;
    const total = countRow?.cnt ?? 0;

    return json({ category, scope: "team", entries, total_count: total });
  }
}

// ─── Badges Handler ─────────────────────────────────────────────────────────

async function handleGetAllBadges(): Promise<Response> {
  const db = getDb();
  const rows = await db.query("SELECT * FROM badges ORDER BY category, id").all() as any[];
  return json(rows.map(b => ({
    id: b.id,
    name: b.name,
    description: b.description,
    category: b.category,
    icon: b.icon,
  })));
}

// ─── Hot Handler ────────────────────────────────────────────────────────────

async function handleGetHot(url: URL): Promise<Response> {
  const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get("limit") ?? "20", 10)));
  const days = Math.min(30, Math.max(1, parseInt(url.searchParams.get("days") ?? "3", 10)));

  const db = getDb();
  const users = await getHotUsers(db, limit, days);
  for (const u of users) {
    u.tier = computeTier(u.weighted_score);
  }
  return json({ users });
}
