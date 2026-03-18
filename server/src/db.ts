import pg from "pg";

const { Pool, types } = pg;

// Prevent pg from auto-parsing TEXT columns that look like dates/timestamps
// into JavaScript Date objects. Our app stores ISO strings as TEXT and expects
// them back as strings (e.g. "2026-03-16T04:00:00").
// OIDs: 1082 = date, 1114 = timestamp, 1184 = timestamptz
types.setTypeParser(1082, (val: string) => val);
types.setTypeParser(1114, (val: string) => val);
types.setTypeParser(1184, (val: string) => val);

// pg returns BIGINT (OID 20) as strings because JS Number can't represent all
// 64-bit ints. Our values fit well within Number.MAX_SAFE_INTEGER (~9 quadrillion),
// so parse them as numbers to avoid string concatenation bugs (e.g. "123" + 5 = "1235").
types.setTypeParser(20, (val: string) => Number(val));

// SUM() of BIGINT columns returns NUMERIC (OID 1700), which pg also returns as
// strings. Parse as Number to avoid the same string concatenation bugs in aggregate queries.
types.setTypeParser(1700, (val: string) => Number(val));

let _pool: pg.Pool | null = null;

export interface DbClient {
  query(sql: string): {
    get(...params: any[]): Promise<any>;
    all(...params: any[]): Promise<any[]>;
    run(...params: any[]): Promise<void>;
  };
}

/** Convert `?` placeholders to `$1, $2, ...` for PostgreSQL */
function convertPlaceholders(sql: string): string {
  let idx = 0;
  return sql.replace(/\?/g, () => `$${++idx}`);
}

export function getPool(): pg.Pool {
  if (!_pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL environment variable is required");
    }
    const isExternal = connectionString.includes(".oregon-postgres.render.com");
    _pool = new Pool({
      connectionString,
      max: 10,
      ssl: isExternal ? { rejectUnauthorized: false } : undefined,
    });
  }
  return _pool;
}

export function getDb(): DbClient {
  const pool = getPool();
  return {
    query(sql: string) {
      const pgSql = convertPlaceholders(sql);
      return {
        async get(...params: any[]): Promise<any> {
          const { rows } = await pool.query(pgSql, params);
          return rows[0] ?? null;
        },
        async all(...params: any[]): Promise<any[]> {
          const { rows } = await pool.query(pgSql, params);
          return rows;
        },
        async run(...params: any[]): Promise<void> {
          await pool.query(pgSql, params);
        },
      };
    },
  };
}

export async function initDb(): Promise<void> {
  const pool = getPool();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS teams (
      team_hash TEXT PRIMARY KEY,
      team_name TEXT NOT NULL,
      created_by TEXT,
      created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS users (
      user_hash TEXT PRIMARY KEY,
      username TEXT UNIQUE,
      team_hash TEXT REFERENCES teams(team_hash),
      avatar_url TEXT,
      display_name TEXT,
      auth_provider TEXT,
      auth_id TEXT,
      social_url TEXT,
      sync_secret TEXT,
      linked_to TEXT REFERENCES users(user_hash),
      created_at TEXT,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS user_metrics (
      user_hash TEXT PRIMARY KEY REFERENCES users(user_hash),
      total_tokens BIGINT DEFAULT 0,
      total_messages BIGINT DEFAULT 0,
      total_sessions BIGINT DEFAULT 0,
      total_tool_calls BIGINT DEFAULT 0,
      prompt_uniqueness_score DOUBLE PRECISION DEFAULT 0,
      weighted_score DOUBLE PRECISION DEFAULT 0,
      current_streak INTEGER DEFAULT 0,
      total_points BIGINT DEFAULT 0,
      level INTEGER DEFAULT 0,
      estimated_spend DOUBLE PRECISION DEFAULT 0,
      last_synced TEXT,
      total_session_time_secs BIGINT DEFAULT 0,
      total_active_time_secs BIGINT DEFAULT 0,
      total_idle_time_secs BIGINT DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS metrics_history (
      id SERIAL PRIMARY KEY,
      user_hash TEXT,
      snapshot_date TEXT,
      total_tokens BIGINT DEFAULT 0,
      total_messages BIGINT DEFAULT 0,
      total_sessions BIGINT DEFAULT 0,
      total_tool_calls BIGINT DEFAULT 0,
      prompt_uniqueness_score DOUBLE PRECISION DEFAULT 0,
      weighted_score DOUBLE PRECISION DEFAULT 0,
      daily_messages BIGINT DEFAULT 0,
      daily_tool_calls BIGINT DEFAULT 0,
      daily_tokens BIGINT DEFAULT 0,
      UNIQUE(user_hash, snapshot_date)
    );

    CREATE TABLE IF NOT EXISTS metrics_hourly (
      id SERIAL PRIMARY KEY,
      user_hash TEXT,
      snapshot_hour TEXT,
      total_tokens BIGINT,
      total_messages BIGINT,
      total_sessions BIGINT,
      total_tool_calls BIGINT,
      prompt_uniqueness_score DOUBLE PRECISION,
      weighted_score DOUBLE PRECISION,
      UNIQUE(user_hash, snapshot_hour)
    );

    CREATE TABLE IF NOT EXISTS badges (
      id TEXT PRIMARY KEY,
      name TEXT,
      description TEXT,
      category TEXT,
      icon TEXT
    );

    CREATE TABLE IF NOT EXISTS user_badges (
      user_hash TEXT,
      badge_id TEXT,
      unlocked_at TEXT,
      PRIMARY KEY(user_hash, badge_id)
    );

    CREATE TABLE IF NOT EXISTS concurrency_histogram (
      id SERIAL PRIMARY KEY,
      user_hash TEXT,
      snapshot_hour TEXT,
      histogram TEXT,
      UNIQUE(user_hash, snapshot_hour)
    );

    CREATE TABLE IF NOT EXISTS daily_sessions (
      id SERIAL PRIMARY KEY,
      user_hash TEXT,
      snapshot_date TEXT,
      sessions TEXT,
      UNIQUE(user_hash, snapshot_date)
    );

    CREATE TABLE IF NOT EXISTS device_metrics (
      device_hash TEXT PRIMARY KEY,
      total_tokens BIGINT DEFAULT 0,
      total_messages BIGINT DEFAULT 0,
      total_sessions BIGINT DEFAULT 0,
      total_tool_calls BIGINT DEFAULT 0,
      prompt_uniqueness_score DOUBLE PRECISION DEFAULT 0,
      weighted_score DOUBLE PRECISION DEFAULT 0,
      current_streak INTEGER DEFAULT 0,
      total_points BIGINT DEFAULT 0,
      level INTEGER DEFAULT 0,
      estimated_spend DOUBLE PRECISION DEFAULT 0,
      last_synced TEXT,
      total_session_time_secs BIGINT DEFAULT 0,
      total_active_time_secs BIGINT DEFAULT 0,
      total_idle_time_secs BIGINT DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS merge_log (
      id SERIAL PRIMARY KEY,
      primary_hash TEXT NOT NULL,
      secondary_hash TEXT NOT NULL,
      auth_id TEXT NOT NULL,
      linked_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_metrics_history_user_hash ON metrics_history(user_hash);
    CREATE INDEX IF NOT EXISTS idx_metrics_hourly_user_hash ON metrics_hourly(user_hash);
    CREATE INDEX IF NOT EXISTS idx_concurrency_histogram_user_hash ON concurrency_histogram(user_hash);
    CREATE INDEX IF NOT EXISTS idx_daily_sessions_user_hash ON daily_sessions(user_hash);
  `);

  // Migrations
  try {
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS sync_secret TEXT`);
  } catch { /* already exists */ }
  try {
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS linked_to TEXT REFERENCES users(user_hash)`);
  } catch { /* already exists */ }
  try {
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_linked_to ON users(linked_to)`);
  } catch { /* already exists */ }

  // Add total_output_tokens column for achievement tracking
  try {
    await pool.query(`ALTER TABLE device_metrics ADD COLUMN IF NOT EXISTS total_output_tokens BIGINT DEFAULT 0`);
  } catch { /* already exists */ }
  try {
    await pool.query(`ALTER TABLE user_metrics ADD COLUMN IF NOT EXISTS total_output_tokens BIGINT DEFAULT 0`);
  } catch { /* already exists */ }

  // Backfill device_metrics from user_metrics for existing solo users
  await pool.query(`
    INSERT INTO device_metrics (device_hash, total_tokens, total_messages, total_sessions, total_tool_calls,
      prompt_uniqueness_score, weighted_score, current_streak, total_points, level, estimated_spend,
      last_synced, total_session_time_secs, total_active_time_secs, total_idle_time_secs)
    SELECT user_hash, total_tokens, total_messages, total_sessions, total_tool_calls,
      prompt_uniqueness_score, weighted_score, current_streak, total_points, level, estimated_spend,
      last_synced, total_session_time_secs, total_active_time_secs, total_idle_time_secs
    FROM user_metrics
    WHERE user_hash NOT IN (SELECT device_hash FROM device_metrics)
  `);
}
