import { getDb, getPool, type DbClient } from "./db";
import { computeWeightedScore } from "./services";

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
  return linked.map((r: any) => r.user_hash);
}

/**
 * Recompute the aggregated user_metrics row for a primary user by
 * summing all linked device_metrics rows.
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
      SUM(current_streak) as current_streak,
      SUM(total_points) as total_points,
      SUM(level) as level,
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

  const now = new Date().toISOString();

  // Upsert into user_metrics for the primary hash
  const existing = await db.query("SELECT user_hash FROM user_metrics WHERE user_hash = ?").get(primaryHash) as any;
  if (existing) {
    await db.query(
      `UPDATE user_metrics SET
        total_tokens = ?, total_messages = ?, total_sessions = ?, total_tool_calls = ?,
        prompt_uniqueness_score = ?, weighted_score = ?, estimated_spend = ?,
        current_streak = ?, total_points = ?, level = ?, last_synced = ?,
        total_session_time_secs = ?, total_active_time_secs = ?, total_idle_time_secs = ?
       WHERE user_hash = ?`
    ).run(
      agg.total_tokens ?? 0, agg.total_messages ?? 0,
      agg.total_sessions ?? 0, agg.total_tool_calls ?? 0,
      agg.prompt_uniqueness_score ?? 0, weighted,
      agg.estimated_spend ?? 0,
      agg.current_streak ?? 0, agg.total_points ?? 0, agg.level ?? 0,
      agg.last_synced ?? now,
      agg.total_session_time_secs ?? 0, agg.total_active_time_secs ?? 0,
      agg.total_idle_time_secs ?? 0,
      primaryHash,
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
      primaryHash,
      agg.total_tokens ?? 0, agg.total_messages ?? 0,
      agg.total_sessions ?? 0, agg.total_tool_calls ?? 0,
      agg.prompt_uniqueness_score ?? 0, weighted,
      agg.estimated_spend ?? 0,
      agg.current_streak ?? 0, agg.total_points ?? 0, agg.level ?? 0,
      agg.last_synced ?? now,
      agg.total_session_time_secs ?? 0, agg.total_active_time_secs ?? 0,
      agg.total_idle_time_secs ?? 0,
    );
  }
}
