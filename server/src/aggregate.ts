import { getDb, getPool, type DbClient } from "./db";
import { computeWeightedScore, computePoints, computeStreak } from "./services";

/**
 * Get all device hashes linked to a user (primary + all secondaries).
 * If the given hash is itself a secondary, resolves to the primary first.
 */
export async function getLinkedHashes(db: DbClient, userHash: string): Promise<string[]> {
  const user = await db.query("SELECT linked_to FROM users WHERE user_hash = ?").get(userHash) as any;
  const primary = user?.linked_to || userHash;
  const linked = await db.query(
    "SELECT user_hash FROM users WHERE user_hash = ? OR linked_to = ?"
  ).all(primary, primary) as any[];
  const hashes = linked.map((r: any) => r.user_hash);
  return hashes.length > 0 ? hashes : [userHash];
}

/**
 * Recompute the aggregated user_metrics row for a primary user by
 * summing all linked device_metrics rows.
 *
 * Note: current_streak, total_points, and level are NOT summed from device_metrics.
 * They are computed server-side from aggregated data.
 */
export async function recomputeUserMetrics(primaryHash: string): Promise<void> {
  const db = getDb();

  // Find all device hashes in this group
  const hashes = await getLinkedHashes(db, primaryHash);
  if (hashes.length === 0) return;

  // Build parameterized IN clause
  const placeholders = hashes.map((_, i) => `$${i + 1}`).join(", ");
  const { rows } = await getPool().query(
    `SELECT
      SUM(total_tokens) as total_tokens,
      SUM(total_messages) as total_messages,
      SUM(total_sessions) as total_sessions,
      SUM(total_tool_calls) as total_tool_calls,
      SUM(prompt_uniqueness_score) as prompt_uniqueness_score,
      SUM(estimated_spend) as estimated_spend,
      SUM(total_output_tokens) as total_output_tokens,
      SUM(total_session_time_secs) as total_session_time_secs,
      SUM(total_active_time_secs) as total_active_time_secs,
      SUM(total_idle_time_secs) as total_idle_time_secs,
      MAX(last_synced) as last_synced
    FROM device_metrics
    WHERE device_hash IN (${placeholders})`,
    hashes,
  );

  const agg = rows[0];
  if (!agg) return;

  const weighted = computeWeightedScore(
    agg.total_tokens ?? 0,
    agg.total_messages ?? 0,
    agg.total_sessions ?? 0,
    agg.total_tool_calls ?? 0,
    agg.prompt_uniqueness_score ?? 0,
  );

  // Compute streak from metrics_history (server-side) — include all linked devices
  const streak = await computeStreak(db, hashes);

  // Count active days from metrics_history — include all linked devices
  const hashPlaceholders = hashes.map(() => "?").join(", ");
  const activeDaysRow = await db.query(
    `SELECT COUNT(DISTINCT snapshot_date) as cnt FROM metrics_history
     WHERE user_hash IN (${hashPlaceholders}) AND (daily_messages > 0 OR daily_tool_calls > 0 OR daily_tokens > 0)`
  ).get(...hashes) as any;
  const activeDays = activeDaysRow?.cnt ?? 0;

  // Compute points & level server-side from aggregated raw metrics
  const { total_points, level } = computePoints({
    total_messages: agg.total_messages ?? 0,
    total_output_tokens: agg.total_output_tokens ?? 0,
    total_tool_calls: agg.total_tool_calls ?? 0,
    total_sessions: agg.total_sessions ?? 0,
    active_days: activeDays,
    current_streak: streak,
  });

  const now = new Date().toISOString();

  // Upsert into user_metrics for the primary hash — atomic to avoid race conditions
  await db.query(
    `INSERT INTO user_metrics (
      user_hash, total_tokens, total_messages, total_sessions, total_tool_calls,
      prompt_uniqueness_score, weighted_score, estimated_spend,
      current_streak, total_points, level, total_output_tokens, last_synced,
      total_session_time_secs, total_active_time_secs, total_idle_time_secs
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (user_hash) DO UPDATE SET
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
    primaryHash,
    agg.total_tokens ?? 0, agg.total_messages ?? 0,
    agg.total_sessions ?? 0, agg.total_tool_calls ?? 0,
    agg.prompt_uniqueness_score ?? 0, weighted,
    agg.estimated_spend ?? 0,
    streak, total_points, level, agg.total_output_tokens ?? 0,
    agg.last_synced ?? now,
    agg.total_session_time_secs ?? 0, agg.total_active_time_secs ?? 0,
    agg.total_idle_time_secs ?? 0,
  );
}
