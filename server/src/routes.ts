import { getDb, getPool } from "./db";
import { auth } from "./auth";
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
  computePoints,
  computeStreak,
  evaluateAchievements,
} from "./services";
import { recomputeUserMetrics, getLinkedHashes } from "./aggregate";

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

/** Get the authenticated Better Auth session from the request cookie. */
async function getAuthSession(request: Request) {
  try {
    return await auth.api.getSession({ headers: request.headers });
  } catch {
    return null;
  }
}

/**
 * Verify the request has a valid session whose user owns the given user_hash.
 * Returns an error Response if unauthorized, or null if authorized.
 */
async function requireOwner(request: Request, userHash: string): Promise<Response | null> {
  const session = await getAuthSession(request);
  if (!session?.user?.id) return error("Unauthorized", 401);

  const db = getDb();
  const user = await db.query(
    "SELECT user_hash FROM users WHERE auth_id = ? AND user_hash = ?"
  ).get(session.user.id, userHash) as any;

  if (!user) return error("Forbidden", 403);
  return null;
}

/**
 * Dual auth: session (web) OR sync_secret (desktop widget).
 * Returns an error Response if unauthorized, or null if authorized.
 */
async function requireOwnerDual(request: Request, userHash: string): Promise<Response | null> {
  const db = getDb();
  const user = await db.query("SELECT user_hash, sync_secret, auth_id FROM users WHERE user_hash = ?").get(userHash) as any;
  if (!user) return error("User not found", 404);

  const session = await getAuthSession(request);
  if (session?.user?.id) {
    const owner = await db.query(
      "SELECT user_hash FROM users WHERE auth_id = ? AND user_hash = ?"
    ).get(session.user.id, userHash) as any;
    if (!owner) return error("Forbidden", 403);
    return null;
  }

  const syncSecret = request.headers.get("x-sync-secret");
  if (syncSecret && user.sync_secret && syncSecret === user.sync_secret) {
    return null;
  }

  return error("Unauthorized", 401);
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
    if (provider === "discord") {
      const res = await fetch("https://discord.com/api/users/@me", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) return null;
      const data = await res.json() as any;
      const avatar = data?.avatar
        ? `https://cdn.discordapp.com/avatars/${data.id}/${data.avatar}.png?size=256`
        : null;
      return {
        name: data?.global_name || data?.username,
        avatar,
        socialUsername: data?.username,
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

  // PUT /api/users/:user_hash/display-name
  const displayNameMatch = path.match(/^\/api\/users\/([^/]+)\/display-name$/);
  if (displayNameMatch && method === "PUT") {
    return handleSetDisplayName(displayNameMatch[1]!, request);
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
    return handleClearCache(clearCacheMatch[1]!, request);
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
    return handleGetUserProfile(userProfileMatch[1]!, request);
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

  // GET /api/teams/:team_hash/burn
  const teamBurnMatch = path.match(/^\/api\/teams\/([^/]+)\/burn$/);
  if (teamBurnMatch && method === "GET") {
    return handleGetTeamBurn(teamBurnMatch[1]!, url);
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

  if (path === "/api/hot/cards" && method === "GET") {
    return handleGetHotCards(url);
  }

  // ─── Admin Routes ─────────────────────────────────────────────────────

  if (path === "/api/admin/truncate-all" && method === "POST") {
    return handleTruncateAll();
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

  const authErr = await requireOwner(request, userHash);
  if (authErr) return authErr;

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

async function handleSetDisplayName(userHash: string, request: Request): Promise<Response> {
  const body = await parseBody(request);
  if (!body?.display_name) return error("display_name is required", 400);

  const db = getDb();
  const user = await db.query("SELECT * FROM users WHERE user_hash = ?").get(userHash) as any;
  if (!user) return error("User not found", 404);

  // Dual auth: session (web) OR sync_secret (desktop widget)
  const session = await getAuthSession(request);
  if (session?.user?.id) {
    const owner = await db.query(
      "SELECT user_hash FROM users WHERE auth_id = ? AND user_hash = ?"
    ).get(session.user.id, userHash) as any;
    if (!owner) return error("Forbidden", 403);
  } else {
    const syncSecret = request.headers.get("x-sync-secret");
    if (!syncSecret || !user.sync_secret || syncSecret !== user.sync_secret) {
      return error("Unauthorized", 401);
    }
  }

  const displayName = body.display_name.trim();
  if (displayName.length < 1 || displayName.length > 50) {
    return error("Display name must be 1-50 characters", 400);
  }

  if (containsProfanity(displayName)) {
    return error("Display name contains inappropriate language", 400);
  }

  const now = new Date().toISOString();

  // Resolve the primary hash so we can update all linked devices
  const target = await db.query("SELECT linked_to FROM users WHERE user_hash = ?").get(userHash) as any;
  const primaryHash = target?.linked_to || userHash;

  // Update the primary and all secondaries in one shot
  await db.query(
    "UPDATE users SET display_name = ?, updated_at = ? WHERE user_hash = ? OR linked_to = ?"
  ).run(displayName, now, primaryHash, primaryHash);

  return json({ status: "ok", display_name: displayName });
}

async function handleGetUserByUsername(username: string): Promise<Response> {
  const db = getDb();
  const user = await db.query("SELECT user_hash, username FROM users WHERE LOWER(username) = LOWER(?)").get(username) as any;
  if (!user) return error("User not found", 404);
  return json({ user_hash: user.user_hash, username: user.username });
}

async function handleClearCache(userHash: string, request: Request): Promise<Response> {
  const authErr = await requireOwnerDual(request, userHash);
  if (authErr) return authErr;

  const db = getDb();
  await db.query("DELETE FROM user_metrics WHERE user_hash = ?").run(userHash);
  await db.query("DELETE FROM device_metrics WHERE device_hash = ?").run(userHash);
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
  const provider = body.provider || null;

  // Disconnect (logout) — clear social fields.
  // Session cookie may be unavailable in third-party iframe contexts (Safari/WebKit ITP),
  // so allow disconnect without auth. If session exists, verify ownership; otherwise
  // proceed since the caller already knows the user_hash.
  if (!provider) {
    const session = await getAuthSession(request);
    if (session?.user?.id) {
      const user = await db.query("SELECT auth_id FROM users WHERE user_hash = ?").get(userHash) as any;
      if (user?.auth_id && user.auth_id !== session.user.id) {
        return error("Forbidden", 403);
      }
    }
    const now = new Date().toISOString();
    await db.query(
      `UPDATE users SET display_name = NULL, avatar_url = NULL, auth_provider = NULL, social_url = NULL, updated_at = ? WHERE user_hash = ?`
    ).run(now, userHash);
    return json({ status: "disconnected" });
  }

  // Require authenticated Better Auth session for connecting
  const session = await getAuthSession(request);
  if (!session?.user?.id) return error("Unauthorized", 401);

  // Ensure user exists
  let user = await db.query("SELECT * FROM users WHERE user_hash = ?").get(userHash) as any;
  if (!user) {
    const now = new Date().toISOString();
    await db.query("INSERT INTO users (user_hash, created_at, updated_at) VALUES (?, ?, ?)").run(userHash, now, now);
    user = await db.query("SELECT * FROM users WHERE user_hash = ?").get(userHash) as any;
  }

  const now = new Date().toISOString();
  let displayName = body.name || null;
  let avatarUrl = body.image || null;
  // Use the session's user ID as auth_id — never trust the client-supplied value
  const authId = session.user.id;

  // If this device was previously linked to a different auth user, disconnect it first
  if (user.auth_id && user.auth_id !== authId) {
    const oldPrimary = user.linked_to || user.user_hash;
    await db.query(
      "UPDATE users SET auth_id = NULL, auth_provider = NULL, linked_to = NULL, display_name = NULL, avatar_url = NULL, social_url = NULL, updated_at = ? WHERE user_hash = ?"
    ).run(now, userHash);
    // Recompute old primary's metrics without this device
    if (user.linked_to) {
      await recomputeUserMetrics(oldPrimary);
    }
    // Re-fetch user after clearing
    user = await db.query("SELECT * FROM users WHERE user_hash = ?").get(userHash) as any;
  }

  // Check if this auth_id is already connected to a different user_hash (multi-device linking)
  const existingPrimary = await db.query(
    "SELECT user_hash, display_name, avatar_url FROM users WHERE auth_id = ? AND user_hash != ? AND linked_to IS NULL"
  ).get(authId, userHash) as any;

  if (existingPrimary) {
    // Same person, different computer — link this device as secondary
    await db.query(
      "UPDATE users SET linked_to = ?, auth_id = ?, auth_provider = ?, updated_at = ? WHERE user_hash = ?"
    ).run(existingPrimary.user_hash, authId, provider, now, userHash);

    // Recompute aggregate with new device included
    await recomputeUserMetrics(existingPrimary.user_hash);

    // Log the link
    await db.query(
      "INSERT INTO merge_log (primary_hash, secondary_hash, auth_id, linked_at) VALUES (?, ?, ?, ?)"
    ).run(existingPrimary.user_hash, userHash, authId, now);

    return json({
      status: "linked",
      primary_hash: existingPrimary.user_hash,
      display_name: existingPrimary.display_name,
      avatar_url: existingPrimary.avatar_url,
    });
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

  // Propagate display_name and avatar_url to all linked devices
  const target = await db.query("SELECT linked_to FROM users WHERE user_hash = ?").get(userHash) as any;
  const primaryHash = target?.linked_to || userHash;
  await db.query(
    "UPDATE users SET display_name = ?, avatar_url = ?, updated_at = ? WHERE (user_hash = ? OR linked_to = ?) AND user_hash != ?"
  ).run(displayName, avatarUrl, now, primaryHash, primaryHash, userHash);

  return json({
    status: "connected",
    display_name: displayName,
    avatar_url: avatarUrl,
    auth_provider: provider,
    social_url: socialUrl,
    username,
  });
}

async function handleGetUserProfile(userHash: string, request: Request): Promise<Response> {
  const db = getDb();
  const user = await db.query("SELECT * FROM users WHERE user_hash = ?").get(userHash) as any;
  if (!user) {
    // User doesn't exist yet (e.g. fresh install before first sync) — return empty profile
    return json({
      user_hash: userHash,
      username: null,
      display_name: null,
      avatar_url: null,
      auth_provider: null,
      social_url: null,
      team_hash: null,
      created_at: null,
      metrics: {
        total_tokens: 0, total_messages: 0, total_sessions: 0,
        total_tool_calls: 0, prompt_uniqueness_score: 0, weighted_score: 0,
        current_streak: 0, total_points: 0, level: 0, last_synced: null,
        max_concurrent: 0, concurrent_mins: 0, estimated_spend: 0,
      },
      ranks: {},
      tier: computeTier(0),
      badges: [],
      is_owner: false,
    });
  }

  // Resolve to primary for profile display
  const primaryHash = user.linked_to || userHash;
  const profileUser = user.linked_to
    ? await db.query("SELECT * FROM users WHERE user_hash = ?").get(primaryHash) as any
    : user;
  if (!profileUser) return error("User not found", 404);

  const metrics = await db.query("SELECT * FROM user_metrics WHERE user_hash = ?").get(primaryHash) as any;
  const ranks = await getUserRanksWithPercentiles(db, primaryHash);

  const weighted = metrics?.weighted_score ?? 0;
  const tier = computeTier(weighted);

  // Get badges for primary
  const badges = await db.query(
    `SELECT b.id, b.name, b.icon, b.category, ub.unlocked_at
     FROM user_badges ub JOIN badges b ON ub.badge_id = b.id
     WHERE ub.user_hash = ?`
  ).all(primaryHash) as any[];

  // Get concurrency stats for today across all linked devices
  const today = new Date().toISOString().split("T")[0]!;
  const todayStart = `${today}T00:00:00`;
  const todayEnd = `${today}T23:59:59`;

  const hashes = await getLinkedHashes(db, primaryHash);
  const pool = getPool();
  const ph = hashes.map((_, i) => `$${i + 1}`).join(", ");
  const { rows: concurrencyRows } = await pool.query(
    `SELECT histogram FROM concurrency_histogram
     WHERE user_hash IN (${ph}) AND snapshot_hour >= $${hashes.length + 1} AND snapshot_hour <= $${hashes.length + 2}`,
    [...hashes, todayStart, todayEnd],
  );

  let maxConcurrent = 0;
  let concurrentMins = 0;
  for (const row of concurrencyRows as any[]) {
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

  // Check if the requester owns this profile (check all linked hashes)
  let isOwner = false;
  try {
    const session = await getAuthSession(request);
    if (session?.user?.id) {
      const ownerCheck = await db.query(
        "SELECT 1 FROM users WHERE auth_id = ? AND (user_hash = ? OR linked_to = ?)"
      ).get(session.user.id, primaryHash, primaryHash) as any;
      if (ownerCheck) isOwner = true;
    }
  } catch {}

  return json({
    user_hash: profileUser.user_hash,
    username: profileUser.username,
    display_name: profileUser.display_name ?? null,
    avatar_url: profileUser.avatar_url ?? null,
    auth_provider: user.auth_provider ?? null,
    social_url: profileUser.social_url ?? null,
    team_hash: profileUser.team_hash,
    created_at: profileUser.created_at,
    is_owner: isOwner,
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

  // Aggregate across all linked devices
  const hashes = await getLinkedHashes(db, userHash);
  const pool = getPool();
  const placeholders = hashes.map((_, i) => `$${i + 1}`).join(", ");
  const { rows } = await pool.query(
    `SELECT snapshot_date,
       SUM(total_tokens) as total_tokens,
       SUM(daily_tokens) as daily_tokens,
       SUM(total_messages) as total_messages,
       SUM(total_sessions) as total_sessions,
       SUM(total_tool_calls) as total_tool_calls,
       SUM(prompt_uniqueness_score) as prompt_uniqueness_score,
       SUM(weighted_score) as weighted_score
     FROM metrics_history
     WHERE user_hash IN (${placeholders})
     GROUP BY snapshot_date
     ORDER BY snapshot_date DESC
     LIMIT $${hashes.length + 1}`,
    [...hashes, days],
  );

  return json(rows.map((r: any) => ({
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

  // Aggregate across all linked devices
  const hashes = await getLinkedHashes(db, userHash);
  const pool = getPool();
  const placeholders = hashes.map((_, i) => `$${i + 1}`).join(", ");
  const { rows: snapshots } = await pool.query(
    `SELECT snapshot_hour, SUM(total_messages) as total_messages, SUM(total_tokens) as total_tokens
     FROM metrics_hourly
     WHERE user_hash IN (${placeholders}) AND snapshot_hour >= $${hashes.length + 1}
     GROUP BY snapshot_hour
     ORDER BY snapshot_hour ASC`,
    [...hashes, startHourStr],
  );

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

  // Aggregate across all linked devices
  const hashes = await getLinkedHashes(db, userHash);

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

    // Fetch concurrency histograms for all linked devices
    const pool = getPool();
    const ph = hashes.map((_, i) => `$${i + 1}`).join(", ");
    const { rows } = await pool.query(
      `SELECT snapshot_hour, histogram FROM concurrency_histogram
       WHERE user_hash IN (${ph}) AND snapshot_hour >= $${hashes.length + 1} AND snapshot_hour <= $${hashes.length + 2}`,
      [...hashes, dayStart, dayEnd],
    );

    // Merge histograms: sum minute counts per session-count key per hour
    const perHour: Record<string, any> = {};
    for (const row of rows as any[]) {
      try {
        const histogram = row.histogram ? JSON.parse(row.histogram) : {};
        const snapshotDate = splitTimestamp(row.snapshot_hour)[0];
        const hour = parseInt(splitTimestamp(row.snapshot_hour)[1].split(":")[0]!, 10);
        const hourKey = `${snapshotDate}:${hour}`;
        if (!perHour[hourKey]) {
          perHour[hourKey] = { histogram: {}, tokens: 0 };
        }
        // Sum histogram entries across devices
        for (const [sessionsStr, minutes] of Object.entries(histogram)) {
          perHour[hourKey].histogram[sessionsStr] = (perHour[hourKey].histogram[sessionsStr] ?? 0) + (minutes as number);
        }
      } catch {
        continue;
      }
    }

    // Fetch hourly token data across all linked devices
    const { rows: tokenRows } = await pool.query(
      `SELECT snapshot_hour, SUM(total_tokens) as total_tokens FROM metrics_hourly
       WHERE user_hash IN (${ph}) AND snapshot_hour >= $${hashes.length + 1} AND snapshot_hour <= $${hashes.length + 2}
       GROUP BY snapshot_hour`,
      [...hashes, dayStart, dayEnd],
    );

    for (const row of tokenRows as any[]) {
      const snapshotDate = splitTimestamp(row.snapshot_hour)[0];
      const hour = parseInt(splitTimestamp(row.snapshot_hour)[1].split(":")[0]!, 10);
      const hourKey = `${snapshotDate}:${hour}`;
      if (perHour[hourKey]) {
        perHour[hourKey].tokens = row.total_tokens ?? 0;
      } else if (row.total_tokens && row.total_tokens > 0) {
        perHour[hourKey] = { histogram: {}, tokens: row.total_tokens };
      }
    }

    // Fetch day sessions across all linked devices (concatenate arrays)
    const { rows: dsRows } = await pool.query(
      `SELECT sessions FROM daily_sessions WHERE user_hash IN (${ph}) AND snapshot_date = $${hashes.length + 1}`,
      [...hashes, targetDate],
    );
    const allSessions: any[] = [];
    for (const dsRow of dsRows as any[]) {
      if (dsRow?.sessions) {
        try {
          const parsed = JSON.parse(dsRow.sessions);
          if (Array.isArray(parsed)) allSessions.push(...parsed);
        } catch { /* ignore */ }
      }
    }
    if (allSessions.length > 0) {
      perHour["sessions"] = allSessions;
    }

    return json(perHour);
  }

  // Legacy: last N hours of peak concurrency
  const hours = parseInt(url.searchParams.get("hours") ?? "12", 10);
  const now = new Date();
  const startTime = new Date(now);
  startTime.setUTCHours(startTime.getUTCHours() - hours);
  const startTimeStr = startTime.toISOString().replace(/\.\d{3}Z$/, "");

  const pool = getPool();
  const ph = hashes.map((_, i) => `$${i + 1}`).join(", ");
  const { rows } = await pool.query(
    `SELECT snapshot_hour, histogram FROM concurrency_histogram
     WHERE user_hash IN (${ph}) AND snapshot_hour >= $${hashes.length + 1}`,
    [...hashes, startTimeStr],
  );

  // Merge histograms across devices, then extract peak per hour
  const hourHistograms: Record<string, Record<string, number>> = {};
  for (const row of rows as any[]) {
    try {
      const histogram = row.histogram ? JSON.parse(row.histogram) : {};
      const snapshotDate = splitTimestamp(row.snapshot_hour)[0];
      const hour = parseInt(splitTimestamp(row.snapshot_hour)[1].split(":")[0]!, 10);
      const hourKey = `${snapshotDate}:${hour}`;
      if (!hourHistograms[hourKey]) hourHistograms[hourKey] = {};
      for (const [sessionsStr, minutes] of Object.entries(histogram)) {
        hourHistograms[hourKey][sessionsStr] = (hourHistograms[hourKey][sessionsStr] ?? 0) + (minutes as number);
      }
    } catch {
      continue;
    }
  }

  const perHour: Record<string, number> = {};
  for (const [hourKey, histogram] of Object.entries(hourHistograms)) {
    let peak = 0;
    for (const sessionsStr of Object.keys(histogram)) {
      const s = parseInt(sessionsStr, 10);
      if (s > peak) peak = s;
    }
    perHour[hourKey] = peak;
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

  const authErr = await requireOwnerDual(request, body.user_hash);
  if (authErr) return authErr;

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

  const authErr = await requireOwnerDual(request, body.user_hash);
  if (authErr) return authErr;

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

  const authErr = await requireOwnerDual(request, body.user_hash);
  if (authErr) return authErr;

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

  const members = await db.query("SELECT user_hash, username, display_name, auth_provider FROM users WHERE team_hash = ?").all(teamHash) as any[];
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
    members: members.map(m => ({ user_hash: m.user_hash, username: m.username, display_name: m.display_name && m.auth_provider ? m.display_name : null })),
    metrics: {
      total_tokens: aggTokens,
      total_messages: aggMessages,
      total_sessions: aggSessions,
      total_tool_calls: aggToolCalls,
    },
  });
}

async function handleGetTeamBurn(teamHash: string, url: URL): Promise<Response> {
  const db = getDb();
  const queryDate = url.searchParams.get("date");

  // Validate date param
  let targetDate: string;
  const today = new Date().toISOString().split("T")[0]!;
  if (queryDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(queryDate)) {
      return error("Invalid date format, use YYYY-MM-DD", 400);
    }
    targetDate = queryDate > today ? today : queryDate;
  } else {
    targetDate = today;
  }

  // Fetch team members
  const members = await db.query(
    "SELECT user_hash, username, display_name, avatar_url, auth_provider FROM users WHERE team_hash = ?"
  ).all(teamHash) as any[];

  if (members.length === 0) {
    return json({ date: targetDate, members: [] });
  }

  // Resolve linked hashes for each member
  const memberHashMap: Record<string, string[]> = {};
  const allHashes: string[] = [];
  const hashToMember: Record<string, string> = {};

  for (const m of members) {
    const linked = await getLinkedHashes(db, m.user_hash);
    memberHashMap[m.user_hash] = linked;
    for (const h of linked) {
      allHashes.push(h);
      hashToMember[h] = m.user_hash;
    }
  }

  const pool = getPool();
  const ph = allHashes.map((_, i) => `$${i + 1}`).join(", ");
  const dayStart = `${targetDate}T00:00:00`;
  const dayEnd = `${targetDate}T23:59:59`;

  // Batch query concurrency histograms
  const { rows: histRows } = await pool.query(
    `SELECT user_hash, snapshot_hour, histogram FROM concurrency_histogram
     WHERE user_hash IN (${ph}) AND snapshot_hour >= $${allHashes.length + 1} AND snapshot_hour <= $${allHashes.length + 2}`,
    [...allHashes, dayStart, dayEnd],
  );

  // Batch query hourly tokens
  const { rows: tokenRows } = await pool.query(
    `SELECT user_hash, snapshot_hour, total_tokens FROM metrics_hourly
     WHERE user_hash IN (${ph}) AND snapshot_hour >= $${allHashes.length + 1} AND snapshot_hour <= $${allHashes.length + 2}`,
    [...allHashes, dayStart, dayEnd],
  );

  // Batch query daily metrics — supports multi-day range via `days` param
  const days = Math.min(Math.max(parseInt(url.searchParams.get("days") ?? "1", 10), 1), 365);
  let dailyRows: any[];
  if (days === 1) {
    const res = await pool.query(
      `SELECT user_hash, daily_tokens FROM metrics_history
       WHERE user_hash IN (${ph}) AND snapshot_date = $${allHashes.length + 1}`,
      [...allHashes, targetDate],
    );
    dailyRows = res.rows;
  } else {
    const rangeStart = new Date(targetDate + "T12:00:00");
    rangeStart.setDate(rangeStart.getDate() - days + 1);
    const startDate = toDateStr(rangeStart);
    const res = await pool.query(
      `SELECT user_hash, SUM(daily_tokens) as daily_tokens FROM metrics_history
       WHERE user_hash IN (${ph}) AND snapshot_date >= $${allHashes.length + 1} AND snapshot_date <= $${allHashes.length + 2}
       GROUP BY user_hash`,
      [...allHashes, startDate, targetDate],
    );
    dailyRows = res.rows;
  }

  // Group results per primary user_hash
  const perMember: Record<string, { concurrency: Record<string, any>; daily_tokens: number; estimated_spend: number }> = {};
  for (const m of members) {
    perMember[m.user_hash] = { concurrency: {}, daily_tokens: 0, estimated_spend: 0 };
  }

  // Process histograms
  for (const row of histRows as any[]) {
    const primary = hashToMember[row.user_hash];
    if (!primary) continue;
    try {
      const histogram = row.histogram ? JSON.parse(row.histogram) : {};
      const snapshotDate = splitTimestamp(row.snapshot_hour)[0];
      const hour = parseInt(splitTimestamp(row.snapshot_hour)[1].split(":")[0]!, 10);
      const hourKey = `${snapshotDate}:${hour}`;
      if (!perMember[primary].concurrency[hourKey]) {
        perMember[primary].concurrency[hourKey] = { histogram: {}, tokens: 0 };
      }
      for (const [sessionsStr, minutes] of Object.entries(histogram)) {
        perMember[primary].concurrency[hourKey].histogram[sessionsStr] =
          (perMember[primary].concurrency[hourKey].histogram[sessionsStr] ?? 0) + (minutes as number);
      }
    } catch { continue; }
  }

  // Process tokens
  for (const row of tokenRows as any[]) {
    const primary = hashToMember[row.user_hash];
    if (!primary) continue;
    const snapshotDate = splitTimestamp(row.snapshot_hour)[0];
    const hour = parseInt(splitTimestamp(row.snapshot_hour)[1].split(":")[0]!, 10);
    const hourKey = `${snapshotDate}:${hour}`;
    if (perMember[primary].concurrency[hourKey]) {
      perMember[primary].concurrency[hourKey].tokens =
        (perMember[primary].concurrency[hourKey].tokens ?? 0) + (row.total_tokens ?? 0);
    } else if (row.total_tokens && row.total_tokens > 0) {
      perMember[primary].concurrency[hourKey] = { histogram: {}, tokens: row.total_tokens };
    }
  }

  // Process daily metrics
  for (const row of dailyRows as any[]) {
    const primary = hashToMember[row.user_hash];
    if (!primary) continue;
    perMember[primary].daily_tokens += row.daily_tokens ?? 0;
  }

  // Fetch total spend from user_metrics to compute daily cost proportionally
  const memberHashes = members.map(m => m.user_hash);
  const mph = memberHashes.map((_, i) => `$${i + 1}`).join(", ");
  const { rows: spendRows } = await pool.query(
    `SELECT user_hash, estimated_spend, total_tokens FROM user_metrics WHERE user_hash IN (${mph})`,
    memberHashes,
  );
  for (const row of spendRows as any[]) {
    const pm = perMember[row.user_hash];
    if (pm && pm.daily_tokens > 0 && row.total_tokens > 0 && row.estimated_spend > 0) {
      pm.estimated_spend = row.estimated_spend * (pm.daily_tokens / row.total_tokens);
    }
  }

  return json({
    date: targetDate,
    members: members.map(m => ({
      user_hash: m.user_hash,
      username: m.username,
      display_name: m.display_name && m.auth_provider ? m.display_name : null,
      avatar_url: m.avatar_url,
      concurrency: perMember[m.user_hash].concurrency,
      daily_tokens: perMember[m.user_hash].daily_tokens,
      estimated_spend: perMember[m.user_hash].estimated_spend,
    })),
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
  if (!req.sync_secret) return error("sync_secret is required", 400);

  console.log(`[sync] Received sync for user=${req.user_hash.substring(0, 8)}… tokens=${req.totals?.total_tokens ?? 0} sessions=${req.totals?.total_sessions ?? 0}`);

  const db = getDb();
  const totals = req.totals ?? {};

  // Ensure user exists and verify sync_secret (trust-on-first-use)
  const existingUser = await db.query("SELECT user_hash, sync_secret FROM users WHERE user_hash = ?").get(req.user_hash) as any;
  if (!existingUser) {
    console.log(`[sync] Auto-creating new user ${req.user_hash.substring(0, 8)}…`);
    const now = new Date().toISOString();
    await db.query("INSERT INTO users (user_hash, sync_secret, created_at, updated_at) VALUES (?, ?, ?, ?)").run(req.user_hash, req.sync_secret, now, now);
  } else if (!existingUser.sync_secret) {
    // Existing user without secret — store it (one-time migration)
    await db.query("UPDATE users SET sync_secret = ? WHERE user_hash = ?").run(req.sync_secret, req.user_hash);
  } else if (existingUser.sync_secret !== req.sync_secret) {
    return error("Forbidden", 403);
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

  // Extract total_output_tokens from token_breakdown
  let totalOutputTokens = 0;
  if (req.token_breakdown && typeof req.token_breakdown === "object") {
    for (const usage of Object.values(req.token_breakdown) as any[]) {
      if (usage && typeof usage === "object") {
        totalOutputTokens += (usage.output ?? 0);
      }
    }
  }

  const now = new Date().toISOString();
  const today = new Date().toISOString().split("T")[0]!;

  // Upsert device_metrics (per-device raw data) — atomic to avoid race conditions
  // Note: current_streak, total_points, level from client are stored for backward compat
  // but the server computes its own values in recomputeUserMetrics.
  await db.query(
    `INSERT INTO device_metrics (
      device_hash, total_tokens, total_messages, total_sessions, total_tool_calls,
      prompt_uniqueness_score, weighted_score, estimated_spend,
      current_streak, total_points, level, total_output_tokens, last_synced,
      total_session_time_secs, total_active_time_secs, total_idle_time_secs
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (device_hash) DO UPDATE SET
      total_tokens = EXCLUDED.total_tokens, total_messages = EXCLUDED.total_messages,
      total_sessions = EXCLUDED.total_sessions, total_tool_calls = EXCLUDED.total_tool_calls,
      prompt_uniqueness_score = EXCLUDED.prompt_uniqueness_score, weighted_score = EXCLUDED.weighted_score,
      estimated_spend = EXCLUDED.estimated_spend, current_streak = EXCLUDED.current_streak,
      total_points = EXCLUDED.total_points, level = EXCLUDED.level,
      total_output_tokens = EXCLUDED.total_output_tokens, last_synced = EXCLUDED.last_synced,
      total_session_time_secs = EXCLUDED.total_session_time_secs,
      total_active_time_secs = EXCLUDED.total_active_time_secs,
      total_idle_time_secs = EXCLUDED.total_idle_time_secs`
  ).run(
    req.user_hash,
    totals.total_tokens ?? 0, totals.total_messages ?? 0,
    totals.total_sessions ?? 0, totals.total_tool_calls ?? 0,
    promptUniqueness, weighted, estimatedSpend,
    totals.current_streak ?? 0, totals.total_points ?? 0, totals.level ?? 0,
    totalOutputTokens, now,
    totals.total_session_time_secs ?? 0, totals.total_active_time_secs ?? 0,
    totals.total_idle_time_secs ?? 0,
  );

  // Recompute aggregated user_metrics (sums across all linked devices)
  const syncUser = await db.query("SELECT linked_to FROM users WHERE user_hash = ?").get(req.user_hash) as any;
  const primaryHash = syncUser?.linked_to || req.user_hash;
  await recomputeUserMetrics(primaryHash);

  // Upsert daily snapshot — atomic to avoid race conditions
  await db.query(
    `INSERT INTO metrics_history (
      user_hash, snapshot_date, total_tokens, total_messages, total_sessions, total_tool_calls,
      prompt_uniqueness_score, weighted_score
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (user_hash, snapshot_date) DO UPDATE SET
      total_tokens = EXCLUDED.total_tokens, total_messages = EXCLUDED.total_messages,
      total_sessions = EXCLUDED.total_sessions, total_tool_calls = EXCLUDED.total_tool_calls,
      prompt_uniqueness_score = EXCLUDED.prompt_uniqueness_score, weighted_score = EXCLUDED.weighted_score`
  ).run(
    req.user_hash, today,
    totals.total_tokens ?? 0, totals.total_messages ?? 0,
    totals.total_sessions ?? 0, totals.total_tool_calls ?? 0,
    promptUniqueness, weighted,
  );

  const pool = getPool();

  // Persist hour_counts — batched
  if (req.hour_counts && typeof req.hour_counts === "object") {
    const rows: [string, string, number][] = [];
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
      } catch { continue; }
      if (h < 0 || h > 23) continue;
      rows.push([req.user_hash, snapshotHour, count]);
    }
    if (rows.length > 0) {
      const values = rows.map((_, i) => `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`).join(", ");
      await pool.query(
        `INSERT INTO metrics_hourly (user_hash, snapshot_hour, total_messages) VALUES ${values}
         ON CONFLICT (user_hash, snapshot_hour) DO UPDATE SET total_messages = EXCLUDED.total_messages`,
        rows.flat(),
      );
    }
  }

  // Persist hour_tokens — batched upsert
  // If full_reparse flag is set, clear stale hourly data first
  if (req.hour_tokens && typeof req.hour_tokens === "object") {
    const rows: [string, string, number][] = [];
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
      } catch { continue; }
      if (h < 0 || h > 23) continue;
      rows.push([req.user_hash, snapshotHour, tokenCount]);
    }
    if (rows.length > 0) {
      if (req.full_reparse) {
        await pool.query(
          `UPDATE metrics_hourly SET total_tokens = 0 WHERE user_hash = $1`,
          [req.user_hash],
        );
      }
      const values = rows.map((_, i) => `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`).join(", ");
      await pool.query(
        `INSERT INTO metrics_hourly (user_hash, snapshot_hour, total_tokens) VALUES ${values}
         ON CONFLICT (user_hash, snapshot_hour) DO UPDATE SET total_tokens = EXCLUDED.total_tokens`,
        rows.flat(),
      );
    }
  }

  // Persist daily_activity — batched
  if (req.daily_activity && Array.isArray(req.daily_activity)) {
    const rows: (string | number)[][] = [];
    for (const entry of req.daily_activity) {
      if (!entry || typeof entry !== "object" || !entry.date) continue;
      const entryDate = entry.date;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(entryDate)) continue;
      const msgCount = entry.messageCount ?? 0;
      const toolCount = entry.toolCallCount ?? 0;
      const tokenCountVal = entry.tokenCount ?? 0;
      if (msgCount <= 0 && toolCount <= 0 && tokenCountVal <= 0) continue;
      rows.push([req.user_hash, entryDate, msgCount, toolCount, tokenCountVal]);
    }
    if (rows.length > 0) {
      const values = rows.map((_, i) => `($${i * 5 + 1}, $${i * 5 + 2}, $${i * 5 + 3}, $${i * 5 + 4}, $${i * 5 + 5})`).join(", ");
      await pool.query(
        `INSERT INTO metrics_history (user_hash, snapshot_date, daily_messages, daily_tool_calls, daily_tokens)
         VALUES ${values}
         ON CONFLICT (user_hash, snapshot_date) DO UPDATE SET
           daily_messages = EXCLUDED.daily_messages, daily_tool_calls = EXCLUDED.daily_tool_calls,
           daily_tokens = EXCLUDED.daily_tokens`,
        rows.flat(),
      );
    }
  }

  // Persist concurrency_histogram — batched
  if (req.concurrency_histogram && typeof req.concurrency_histogram === "object") {
    const rows: [string, string, string][] = [];
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
      } catch { continue; }
      if (h < 0 || h > 23) continue;
      rows.push([req.user_hash, snapshotHour, JSON.stringify(histogram)]);
    }
    if (rows.length > 0) {
      const values = rows.map((_, i) => `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`).join(", ");
      await pool.query(
        `INSERT INTO concurrency_histogram (user_hash, snapshot_hour, histogram) VALUES ${values}
         ON CONFLICT (user_hash, snapshot_hour) DO UPDATE SET histogram = EXCLUDED.histogram`,
        rows.flat(),
      );
    }
  }

  // Persist day_sessions — batched
  if (req.day_sessions && typeof req.day_sessions === "object") {
    const rows: [string, string, string][] = [];
    for (const [dateStr, sessionsList] of Object.entries(req.day_sessions)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) continue;
      if (!sessionsList || !Array.isArray(sessionsList)) continue;
      rows.push([req.user_hash, dateStr, JSON.stringify(sessionsList)]);
    }
    if (rows.length > 0) {
      const values = rows.map((_, i) => `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`).join(", ");
      await pool.query(
        `INSERT INTO daily_sessions (user_hash, snapshot_date, sessions) VALUES ${values}
         ON CONFLICT (user_hash, snapshot_date) DO UPDATE SET sessions = EXCLUDED.sessions`,
        rows.flat(),
      );
    }
  }

  // Compute concurrency aggregates for metrics_history
  // Process all dates that had concurrency_histogram data in this sync
  {
    const concurrencyDates = new Set<string>();
    if (req.concurrency_histogram && typeof req.concurrency_histogram === "object") {
      for (const hourKey of Object.keys(req.concurrency_histogram)) {
        if (!hourKey.includes(":")) continue;
        const lastColon = hourKey.lastIndexOf(":");
        const datePart = hourKey.substring(0, lastColon);
        concurrencyDates.add(datePart);
      }
    }
    // Also include today
    concurrencyDates.add(today);

    const allHashes = await getLinkedHashes(db, primaryHash);

    for (const syncDate of concurrencyDates) {
      const dayStart = `${syncDate}T00:00:00`;
      const dayEnd = `${syncDate}T23:59:59`;

      const ph2 = allHashes.map((_, i) => `$${i + 1}`).join(", ");
      const { rows: histRows } = await pool.query(
        `SELECT histogram FROM concurrency_histogram
         WHERE user_hash IN (${ph2}) AND snapshot_hour >= $${allHashes.length + 1} AND snapshot_hour <= $${allHashes.length + 2}`,
        [...allHashes, dayStart, dayEnd],
      );

      let peakConcurrency = 0;
      let totalAgentMins = 0;
      let concurrentMinsAgg = 0;

      // Merge histograms per hour, then compute aggregates
      const perHourMerged: Record<string, Record<string, number>> = {};
      for (const row of histRows as any[]) {
        try {
          const histogram = row.histogram ? JSON.parse(row.histogram) : {};
          // Use a single merged bucket per hour
          const hourKey = "merged";
          if (!perHourMerged[hourKey]) perHourMerged[hourKey] = {};
          for (const [sessionsStr, minutes] of Object.entries(histogram)) {
            perHourMerged[hourKey][sessionsStr] = (perHourMerged[hourKey][sessionsStr] ?? 0) + (minutes as number);
          }
        } catch { continue; }
      }

      // Compute from merged histograms
      for (const histogram of Object.values(perHourMerged)) {
        for (const [sessionsStr, minutes] of Object.entries(histogram)) {
          const sessionCount = parseInt(sessionsStr, 10);
          if (sessionCount > peakConcurrency) peakConcurrency = sessionCount;
          totalAgentMins += minutes;
          if (sessionCount >= 2) concurrentMinsAgg += minutes;
        }
      }

      // Update metrics_history for primary hash
      await pool.query(
        `UPDATE metrics_history SET peak_concurrency = $1, total_agent_mins = $2, concurrent_mins = $3
         WHERE user_hash = $4 AND snapshot_date = $5`,
        [peakConcurrency, totalAgentMins, concurrentMinsAgg, primaryHash, syncDate],
      );
    }
  }

  // Evaluate badges using aggregated metrics for the primary user
  const badgeHash = primaryHash;
  const metrics = await db.query("SELECT * FROM user_metrics WHERE user_hash = ?").get(badgeHash) as any;
  const newBadges: string[] = [];
  newBadges.push(...await evaluateMilestoneBadges(db, badgeHash, metrics));
  newBadges.push(...await evaluateRankingBadges(db, badgeHash));
  newBadges.push(...await evaluateTeamBadges(db, badgeHash));

  // Server-side achievements evaluation
  const serverStreak = metrics?.current_streak ?? 0;
  const { all: achievements, newly_unlocked: newAchievements } =
    await evaluateAchievements(db, badgeHash, metrics, serverStreak);

  console.log(`[sync] Completed for user=${req.user_hash.substring(0, 8)}… weighted=${(metrics?.weighted_score ?? weighted).toFixed(2)} points=${metrics?.total_points ?? 0} level=${metrics?.level ?? 0} streak=${serverStreak} badges=${newBadges.length} achievements=${newAchievements.length}`);

  return json({
    status: "ok",
    weighted_score: metrics?.weighted_score ?? weighted,
    prompt_uniqueness_score: metrics?.prompt_uniqueness_score ?? promptUniqueness,
    new_badges: newBadges,
    primary_hash: primaryHash !== req.user_hash ? primaryHash : undefined,
    // Server-computed points data
    total_points: metrics?.total_points ?? 0,
    level: metrics?.level ?? 0,
    current_streak: serverStreak,
    achievements,
    new_achievements: newAchievements,
  });
}

// ─── Leaderboard Handler ───────────────────────────────────────────────────

const VALID_CATEGORIES = ["tokens", "concurrent_agents", "agent_hours", "concurrency_time", "consistency", "messages"];

async function handleGetLeaderboard(category: string, url: URL): Promise<Response> {
  if (!VALID_CATEGORIES.includes(category)) {
    return error(`Invalid category. Must be one of: ${VALID_CATEGORIES.join(", ")}`, 400);
  }

  const period = url.searchParams.get("period") ?? "alltime";
  if (period !== "daily" && period !== "alltime") {
    return error("period must be 'daily' or 'alltime'", 400);
  }

  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") ?? "50", 10)));
  const offset = Math.max(0, parseInt(url.searchParams.get("offset") ?? "0", 10));

  const db = getDb();
  const pool = getPool();

  if (period === "daily") {
    const dateParam = url.searchParams.get("date") ?? new Date().toISOString().split("T")[0]!;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
      return error("Invalid date format, use YYYY-MM-DD", 400);
    }

    let rows: any[];
    let countSql: string;
    let countParams: any[];

    if (category === "tokens") {
      rows = await db.query(
        `SELECT u.user_hash, u.username, u.display_name, u.avatar_url,
          mh.daily_tokens as value, um.weighted_score,
          CASE WHEN um.total_tokens > 0
            THEN um.estimated_spend * (CAST(mh.daily_tokens AS FLOAT) / um.total_tokens)
            ELSE 0 END as cost
        FROM metrics_history mh
        JOIN users u ON mh.user_hash = u.user_hash
        JOIN user_metrics um ON u.user_hash = um.user_hash
        WHERE mh.snapshot_date = ? AND u.linked_to IS NULL AND mh.daily_tokens > 0
        ORDER BY mh.daily_tokens DESC, CASE WHEN u.user_hash LIKE 'seed-%' THEN 1 ELSE 0 END
        LIMIT ? OFFSET ?`
      ).all(dateParam, limit, offset) as any[];
      countSql = `SELECT COUNT(*) as cnt FROM metrics_history mh JOIN users u ON mh.user_hash = u.user_hash WHERE mh.snapshot_date = $1 AND u.linked_to IS NULL AND mh.daily_tokens > 0`;
      countParams = [dateParam];
    } else if (category === "concurrent_agents") {
      rows = await db.query(
        `SELECT u.user_hash, u.username, u.display_name, u.avatar_url,
          mh.peak_concurrency as value, um.weighted_score
        FROM metrics_history mh
        JOIN users u ON mh.user_hash = u.user_hash
        JOIN user_metrics um ON u.user_hash = um.user_hash
        WHERE mh.snapshot_date = ? AND u.linked_to IS NULL AND mh.peak_concurrency > 0
        ORDER BY mh.peak_concurrency DESC, CASE WHEN u.user_hash LIKE 'seed-%' THEN 1 ELSE 0 END
        LIMIT ? OFFSET ?`
      ).all(dateParam, limit, offset) as any[];
      countSql = `SELECT COUNT(*) as cnt FROM metrics_history mh JOIN users u ON mh.user_hash = u.user_hash WHERE mh.snapshot_date = $1 AND u.linked_to IS NULL AND mh.peak_concurrency > 0`;
      countParams = [dateParam];
    } else if (category === "agent_hours") {
      rows = await db.query(
        `SELECT u.user_hash, u.username, u.display_name, u.avatar_url,
          mh.total_agent_mins as value, um.weighted_score
        FROM metrics_history mh
        JOIN users u ON mh.user_hash = u.user_hash
        JOIN user_metrics um ON u.user_hash = um.user_hash
        WHERE mh.snapshot_date = ? AND u.linked_to IS NULL AND mh.total_agent_mins > 0
        ORDER BY mh.total_agent_mins DESC, CASE WHEN u.user_hash LIKE 'seed-%' THEN 1 ELSE 0 END
        LIMIT ? OFFSET ?`
      ).all(dateParam, limit, offset) as any[];
      countSql = `SELECT COUNT(*) as cnt FROM metrics_history mh JOIN users u ON mh.user_hash = u.user_hash WHERE mh.snapshot_date = $1 AND u.linked_to IS NULL AND mh.total_agent_mins > 0`;
      countParams = [dateParam];
    } else if (category === "concurrency_time") {
      rows = await db.query(
        `SELECT u.user_hash, u.username, u.display_name, u.avatar_url,
          mh.concurrent_mins as value, um.weighted_score
        FROM metrics_history mh
        JOIN users u ON mh.user_hash = u.user_hash
        JOIN user_metrics um ON u.user_hash = um.user_hash
        WHERE mh.snapshot_date = ? AND u.linked_to IS NULL AND mh.concurrent_mins > 0
        ORDER BY mh.concurrent_mins DESC, CASE WHEN u.user_hash LIKE 'seed-%' THEN 1 ELSE 0 END
        LIMIT ? OFFSET ?`
      ).all(dateParam, limit, offset) as any[];
      countSql = `SELECT COUNT(*) as cnt FROM metrics_history mh JOIN users u ON mh.user_hash = u.user_hash WHERE mh.snapshot_date = $1 AND u.linked_to IS NULL AND mh.concurrent_mins > 0`;
      countParams = [dateParam];
    } else if (category === "messages") {
      rows = await db.query(
        `SELECT u.user_hash, u.username, u.display_name, u.avatar_url,
          mh.daily_messages as value, um.weighted_score
        FROM metrics_history mh
        JOIN users u ON mh.user_hash = u.user_hash
        JOIN user_metrics um ON u.user_hash = um.user_hash
        WHERE mh.snapshot_date = ? AND u.linked_to IS NULL AND mh.daily_messages > 0
        ORDER BY mh.daily_messages DESC, CASE WHEN u.user_hash LIKE 'seed-%' THEN 1 ELSE 0 END
        LIMIT ? OFFSET ?`
      ).all(dateParam, limit, offset) as any[];
      countSql = `SELECT COUNT(*) as cnt FROM metrics_history mh JOIN users u ON mh.user_hash = u.user_hash WHERE mh.snapshot_date = $1 AND u.linked_to IS NULL AND mh.daily_messages > 0`;
      countParams = [dateParam];
    } else {
      // consistency — same for daily and alltime
      rows = await db.query(
        `SELECT u.user_hash, u.username, u.display_name, u.avatar_url,
          um.current_streak as value, um.weighted_score
        FROM users u JOIN user_metrics um ON u.user_hash = um.user_hash
        WHERE u.linked_to IS NULL AND um.current_streak > 0
        ORDER BY um.current_streak DESC, CASE WHEN u.user_hash LIKE 'seed-%' THEN 1 ELSE 0 END
        LIMIT ? OFFSET ?`
      ).all(limit, offset) as any[];
      countSql = `SELECT COUNT(*) as cnt FROM user_metrics um JOIN users u ON u.user_hash = um.user_hash WHERE u.linked_to IS NULL AND um.current_streak > 0`;
      countParams = [];
    }

    const entries = rows.map((row, i) => ({
      rank: offset + i + 1,
      user_hash: row.user_hash,
      username: row.username,
      display_name: row.display_name,
      avatar_url: row.avatar_url ?? null,
      value: Number(row.value),
      cost: row.cost != null ? Number(row.cost) : undefined,
      weighted_score: row.weighted_score,
      tier: computeTier(row.weighted_score).tier,
    }));

    const { rows: countRows } = await pool.query(countSql, countParams);
    const total = (countRows[0] as any)?.cnt ?? 0;

    return json({ category, period: "daily", date: dateParam, entries, total_count: total });
  }

  // All-time period
  let rows: any[];
  let countSql: string;

  if (category === "tokens") {
    rows = await db.query(
      `SELECT u.user_hash, u.username, u.display_name, u.avatar_url,
        um.total_tokens as value, um.weighted_score, um.estimated_spend as cost
      FROM users u JOIN user_metrics um ON u.user_hash = um.user_hash
      WHERE u.linked_to IS NULL
      ORDER BY um.total_tokens DESC, CASE WHEN u.user_hash LIKE 'seed-%' THEN 1 ELSE 0 END
      LIMIT ? OFFSET ?`
    ).all(limit, offset) as any[];
    countSql = `SELECT COUNT(*) as cnt FROM user_metrics um JOIN users u ON u.user_hash = um.user_hash WHERE u.linked_to IS NULL`;
  } else if (category === "concurrent_agents") {
    rows = await db.query(
      `SELECT u.user_hash, u.username, u.display_name, u.avatar_url,
        MAX(mh.peak_concurrency) as value, um.weighted_score
      FROM users u
      JOIN user_metrics um ON u.user_hash = um.user_hash
      JOIN metrics_history mh ON u.user_hash = mh.user_hash
      WHERE u.linked_to IS NULL
      GROUP BY u.user_hash, u.username, u.display_name, u.avatar_url, um.weighted_score
      HAVING MAX(mh.peak_concurrency) > 0
      ORDER BY value DESC, CASE WHEN u.user_hash LIKE 'seed-%' THEN 1 ELSE 0 END
      LIMIT ? OFFSET ?`
    ).all(limit, offset) as any[];
    countSql = `SELECT COUNT(*) as cnt FROM (
      SELECT u.user_hash FROM users u
      JOIN metrics_history mh ON u.user_hash = mh.user_hash
      WHERE u.linked_to IS NULL
      GROUP BY u.user_hash HAVING MAX(mh.peak_concurrency) > 0
    ) sub`;
  } else if (category === "agent_hours") {
    rows = await db.query(
      `SELECT u.user_hash, u.username, u.display_name, u.avatar_url,
        SUM(mh.total_agent_mins) as value, um.weighted_score
      FROM users u
      JOIN user_metrics um ON u.user_hash = um.user_hash
      JOIN metrics_history mh ON u.user_hash = mh.user_hash
      WHERE u.linked_to IS NULL
      GROUP BY u.user_hash, u.username, u.display_name, u.avatar_url, um.weighted_score
      HAVING SUM(mh.total_agent_mins) > 0
      ORDER BY value DESC, CASE WHEN u.user_hash LIKE 'seed-%' THEN 1 ELSE 0 END
      LIMIT ? OFFSET ?`
    ).all(limit, offset) as any[];
    countSql = `SELECT COUNT(*) as cnt FROM (
      SELECT u.user_hash FROM users u
      JOIN metrics_history mh ON u.user_hash = mh.user_hash
      WHERE u.linked_to IS NULL
      GROUP BY u.user_hash HAVING SUM(mh.total_agent_mins) > 0
    ) sub`;
  } else if (category === "concurrency_time") {
    rows = await db.query(
      `SELECT u.user_hash, u.username, u.display_name, u.avatar_url,
        SUM(mh.concurrent_mins) as value, um.weighted_score
      FROM users u
      JOIN user_metrics um ON u.user_hash = um.user_hash
      JOIN metrics_history mh ON u.user_hash = mh.user_hash
      WHERE u.linked_to IS NULL
      GROUP BY u.user_hash, u.username, u.display_name, u.avatar_url, um.weighted_score
      HAVING SUM(mh.concurrent_mins) > 0
      ORDER BY value DESC, CASE WHEN u.user_hash LIKE 'seed-%' THEN 1 ELSE 0 END
      LIMIT ? OFFSET ?`
    ).all(limit, offset) as any[];
    countSql = `SELECT COUNT(*) as cnt FROM (
      SELECT u.user_hash FROM users u
      JOIN metrics_history mh ON u.user_hash = mh.user_hash
      WHERE u.linked_to IS NULL
      GROUP BY u.user_hash HAVING SUM(mh.concurrent_mins) > 0
    ) sub`;
  } else if (category === "messages") {
    rows = await db.query(
      `SELECT u.user_hash, u.username, u.display_name, u.avatar_url,
        um.total_messages as value, um.weighted_score
      FROM users u JOIN user_metrics um ON u.user_hash = um.user_hash
      WHERE u.linked_to IS NULL
      ORDER BY um.total_messages DESC, CASE WHEN u.user_hash LIKE 'seed-%' THEN 1 ELSE 0 END
      LIMIT ? OFFSET ?`
    ).all(limit, offset) as any[];
    countSql = `SELECT COUNT(*) as cnt FROM user_metrics um JOIN users u ON u.user_hash = um.user_hash WHERE u.linked_to IS NULL`;
  } else {
    // consistency
    rows = await db.query(
      `SELECT u.user_hash, u.username, u.display_name, u.avatar_url,
        um.current_streak as value, um.weighted_score
      FROM users u JOIN user_metrics um ON u.user_hash = um.user_hash
      WHERE u.linked_to IS NULL AND um.current_streak > 0
      ORDER BY um.current_streak DESC, CASE WHEN u.user_hash LIKE 'seed-%' THEN 1 ELSE 0 END
      LIMIT ? OFFSET ?`
    ).all(limit, offset) as any[];
    countSql = `SELECT COUNT(*) as cnt FROM user_metrics um JOIN users u ON u.user_hash = um.user_hash WHERE u.linked_to IS NULL AND um.current_streak > 0`;
  }

  const entries = rows.map((row, i) => ({
    rank: offset + i + 1,
    user_hash: row.user_hash,
    username: row.username,
    display_name: row.display_name,
    avatar_url: row.avatar_url ?? null,
    value: Number(row.value),
    cost: row.cost != null ? Number(row.cost) : undefined,
    weighted_score: row.weighted_score,
    tier: computeTier(row.weighted_score).tier,
  }));

  const { rows: countRows } = await pool.query(countSql);
  const total = (countRows[0] as any)?.cnt ?? 0;

  return json({ category, period: "alltime", entries, total_count: total });
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

async function handleTruncateAll(): Promise<Response> {
  const pool = getPool();
  await pool.query(`
    TRUNCATE user_metrics, device_metrics, metrics_history, metrics_hourly,
             user_badges, concurrency_histogram, daily_sessions, merge_log,
             users, teams CASCADE
  `);
  await pool.query(`
    TRUNCATE "session", "account", "verification", "user" CASCADE
  `);
  return json({ status: "truncated" });
}

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

// Hot cards cache: keyed by limit, stores { data, timestamp }
const hotCardsCache = new Map<number, { data: any; timestamp: number }>();
const HOT_CARDS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function handleGetHotCards(url: URL): Promise<Response> {
  const limit = Math.min(10, Math.max(1, parseInt(url.searchParams.get("limit") ?? "3", 10)));

  const cached = hotCardsCache.get(limit);
  if (cached && Date.now() - cached.timestamp < HOT_CARDS_CACHE_TTL) {
    return json(cached.data);
  }

  const db = getDb();
  const users = await getHotUsers(db, limit, 3);

  // Fetch yesterday through tomorrow UTC to cover all local timezones
  const now = new Date();
  const yesterday = new Date(now.getTime() - 86400000).toISOString().split("T")[0]!;
  const tomorrow = new Date(now.getTime() + 86400000).toISOString().split("T")[0]!;
  const dayStart = `${yesterday}T00:00:00`;
  const dayEnd = `${tomorrow}T23:59:59`;
  const pool = getPool();

  const cards: any[] = [];
  for (const u of users) {
    const userHash = u.user_hash;
    const hashes = await getLinkedHashes(db, userHash);
    const ph = hashes.map((_: string, i: number) => `$${i + 1}`).join(", ");

    // Fetch concurrency histograms for today
    const { rows } = await pool.query(
      `SELECT snapshot_hour, histogram FROM concurrency_histogram
       WHERE user_hash IN (${ph}) AND snapshot_hour >= $${hashes.length + 1} AND snapshot_hour <= $${hashes.length + 2}`,
      [...hashes, dayStart, dayEnd],
    );

    const perHour: Record<string, any> = {};
    for (const row of rows as any[]) {
      try {
        const histogram = row.histogram ? JSON.parse(row.histogram) : {};
        const snapshotDate = splitTimestamp(row.snapshot_hour)[0];
        const hour = parseInt(splitTimestamp(row.snapshot_hour)[1].split(":")[0]!, 10);
        const hourKey = `${snapshotDate}:${hour}`;
        if (!perHour[hourKey]) perHour[hourKey] = { histogram: {}, tokens: 0 };
        for (const [sessionsStr, minutes] of Object.entries(histogram)) {
          perHour[hourKey].histogram[sessionsStr] = (perHour[hourKey].histogram[sessionsStr] ?? 0) + (minutes as number);
        }
      } catch { continue; }
    }

    // Fetch hourly token data
    const { rows: tokenRows } = await pool.query(
      `SELECT snapshot_hour, SUM(total_tokens) as total_tokens FROM metrics_hourly
       WHERE user_hash IN (${ph}) AND snapshot_hour >= $${hashes.length + 1} AND snapshot_hour <= $${hashes.length + 2}
       GROUP BY snapshot_hour`,
      [...hashes, dayStart, dayEnd],
    );
    for (const row of tokenRows as any[]) {
      const snapshotDate = splitTimestamp(row.snapshot_hour)[0];
      const hour = parseInt(splitTimestamp(row.snapshot_hour)[1].split(":")[0]!, 10);
      const hourKey = `${snapshotDate}:${hour}`;
      if (perHour[hourKey]) {
        perHour[hourKey].tokens = row.total_tokens ?? 0;
      } else if (row.total_tokens && row.total_tokens > 0) {
        perHour[hourKey] = { histogram: {}, tokens: row.total_tokens };
      }
    }

    // Get user metrics
    const metrics = await db.query("SELECT total_tokens, estimated_spend FROM user_metrics WHERE user_hash = ?").get(userHash) as any;

    cards.push({
      user_hash: userHash,
      username: u.username,
      display_name: u.display_name,
      avatar_url: u.avatar_url || null,
      total_tokens: metrics?.total_tokens ?? 0,
      estimated_spend: metrics?.estimated_spend ?? 0,
      concurrency: perHour,
    });
  }

  const result = { cards };
  hotCardsCache.set(limit, { data: result, timestamp: Date.now() });
  return json(result);
}
