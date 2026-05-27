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
      total_idle_time_secs BIGINT DEFAULT 0,
      current_hourly_streak INTEGER DEFAULT 0
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
      peak_concurrency INTEGER DEFAULT 0,
      total_agent_mins INTEGER DEFAULT 0,
      concurrent_mins INTEGER DEFAULT 0,
      peak_concurrency_mins INTEGER DEFAULT 0,
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

    CREATE TABLE IF NOT EXISTS metrics_model_daily (
      id SERIAL PRIMARY KEY,
      user_hash TEXT NOT NULL,
      snapshot_date TEXT NOT NULL,
      model_name TEXT NOT NULL,
      tokens BIGINT NOT NULL DEFAULT 0,
      UNIQUE(user_hash, snapshot_date, model_name)
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
      total_idle_time_secs BIGINT DEFAULT 0,
      current_hourly_streak INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS merge_log (
      id SERIAL PRIMARY KEY,
      primary_hash TEXT NOT NULL,
      secondary_hash TEXT NOT NULL,
      auth_id TEXT NOT NULL,
      linked_at TEXT NOT NULL
    );

    -- Codex POC: parallel device/user totals tables. Mirror device_metrics and
    -- user_metrics column-for-column (minus the users FK) so future code that
    -- generalizes "provider" can lift these into a single table without a
    -- column-level migration. Kept fully separate from production rankings.
    CREATE TABLE IF NOT EXISTS codex_device_metrics (
      device_hash TEXT PRIMARY KEY,
      total_tokens BIGINT DEFAULT 0,
      total_messages BIGINT DEFAULT 0,
      total_sessions BIGINT DEFAULT 0,
      total_tool_calls BIGINT DEFAULT 0,
      total_output_tokens BIGINT DEFAULT 0,
      estimated_spend DOUBLE PRECISION DEFAULT 0,
      weighted_score DOUBLE PRECISION DEFAULT 0,
      last_synced TEXT,
      total_session_time_secs BIGINT DEFAULT 0,
      total_active_time_secs BIGINT DEFAULT 0,
      total_idle_time_secs BIGINT DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS codex_user_metrics (
      user_hash TEXT PRIMARY KEY,
      total_tokens BIGINT DEFAULT 0,
      total_messages BIGINT DEFAULT 0,
      total_sessions BIGINT DEFAULT 0,
      total_tool_calls BIGINT DEFAULT 0,
      total_output_tokens BIGINT DEFAULT 0,
      estimated_spend DOUBLE PRECISION DEFAULT 0,
      weighted_score DOUBLE PRECISION DEFAULT 0,
      last_synced TEXT,
      total_session_time_secs BIGINT DEFAULT 0,
      total_active_time_secs BIGINT DEFAULT 0,
      total_idle_time_secs BIGINT DEFAULT 0
    );

    -- Codex parity tables: mirror metrics_history / metrics_hourly /
    -- concurrency_histogram / daily_sessions / user_badges so the existing
    -- aggregation helpers can be reused with a tablePrefix parameter.
    CREATE TABLE IF NOT EXISTS codex_metrics_history (
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
      peak_concurrency INTEGER DEFAULT 0,
      total_agent_mins INTEGER DEFAULT 0,
      concurrent_mins INTEGER DEFAULT 0,
      peak_concurrency_mins INTEGER DEFAULT 0,
      daily_spend DOUBLE PRECISION DEFAULT 0,
      peak_hourly_streak INTEGER DEFAULT 0,
      UNIQUE(user_hash, snapshot_date)
    );

    CREATE TABLE IF NOT EXISTS codex_metrics_hourly (
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

    CREATE TABLE IF NOT EXISTS codex_concurrency_histogram (
      id SERIAL PRIMARY KEY,
      user_hash TEXT,
      snapshot_hour TEXT,
      histogram TEXT,
      UNIQUE(user_hash, snapshot_hour)
    );

    CREATE TABLE IF NOT EXISTS codex_daily_sessions (
      id SERIAL PRIMARY KEY,
      user_hash TEXT,
      snapshot_date TEXT,
      sessions TEXT,
      UNIQUE(user_hash, snapshot_date)
    );

    CREATE TABLE IF NOT EXISTS codex_user_badges (
      user_hash TEXT,
      badge_id TEXT,
      unlocked_at TEXT,
      PRIMARY KEY(user_hash, badge_id)
    );

    CREATE TABLE IF NOT EXISTS wrapped_views (
      user_hash TEXT NOT NULL,
      year_month TEXT NOT NULL,
      viewed_at TEXT NOT NULL,
      PRIMARY KEY(user_hash, year_month)
    );

    CREATE INDEX IF NOT EXISTS idx_metrics_history_user_hash ON metrics_history(user_hash);
    CREATE INDEX IF NOT EXISTS idx_metrics_hourly_user_hash ON metrics_hourly(user_hash);
    CREATE INDEX IF NOT EXISTS idx_concurrency_histogram_user_hash ON concurrency_histogram(user_hash);
    CREATE INDEX IF NOT EXISTS idx_daily_sessions_user_hash ON daily_sessions(user_hash);
    CREATE INDEX IF NOT EXISTS idx_metrics_model_daily_user_date ON metrics_model_daily(user_hash, snapshot_date);
    CREATE INDEX IF NOT EXISTS idx_codex_metrics_history_user_hash ON codex_metrics_history(user_hash);
    CREATE INDEX IF NOT EXISTS idx_codex_metrics_hourly_user_hash ON codex_metrics_hourly(user_hash);
    CREATE INDEX IF NOT EXISTS idx_codex_concurrency_histogram_user_hash ON codex_concurrency_histogram(user_hash);
    CREATE INDEX IF NOT EXISTS idx_codex_daily_sessions_user_hash ON codex_daily_sessions(user_hash);
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

  // Subscription plan (auto-detected from ~/.claude.json oauthAccount on the client) for the
  // "plan value" stat: current-month spend ÷ what the user pays Anthropic per month.
  try {
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_plan TEXT`);
  } catch { /* already exists */ }
  try {
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS monthly_plan_usd DOUBLE PRECISION`);
  } catch { /* already exists */ }
  try {
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_synced_at TEXT`);
  } catch { /* already exists */ }

  // Add concurrency aggregate columns to metrics_history
  try {
    await pool.query(`ALTER TABLE metrics_history ADD COLUMN IF NOT EXISTS peak_concurrency INTEGER DEFAULT 0`);
  } catch { /* already exists */ }
  try {
    await pool.query(`ALTER TABLE metrics_history ADD COLUMN IF NOT EXISTS total_agent_mins INTEGER DEFAULT 0`);
  } catch { /* already exists */ }
  try {
    await pool.query(`ALTER TABLE metrics_history ADD COLUMN IF NOT EXISTS concurrent_mins INTEGER DEFAULT 0`);
  } catch { /* already exists */ }
  try {
    await pool.query(`ALTER TABLE metrics_history ADD COLUMN IF NOT EXISTS peak_concurrency_mins INTEGER DEFAULT 0`);
  } catch { /* already exists */ }

  // Add total_output_tokens column for achievement tracking
  try {
    await pool.query(`ALTER TABLE device_metrics ADD COLUMN IF NOT EXISTS total_output_tokens BIGINT DEFAULT 0`);
  } catch { /* already exists */ }
  try {
    await pool.query(`ALTER TABLE user_metrics ADD COLUMN IF NOT EXISTS total_output_tokens BIGINT DEFAULT 0`);
  } catch { /* already exists */ }

  // Add current_hourly_streak column
  try {
    await pool.query(`ALTER TABLE user_metrics ADD COLUMN IF NOT EXISTS current_hourly_streak INTEGER DEFAULT 0`);
  } catch { /* already exists */ }
  try {
    await pool.query(`ALTER TABLE device_metrics ADD COLUMN IF NOT EXISTS current_hourly_streak INTEGER DEFAULT 0`);
  } catch { /* already exists */ }

  // Add daily_spend and peak_hourly_streak to metrics_history for rewards tracking
  try {
    await pool.query(`ALTER TABLE metrics_history ADD COLUMN IF NOT EXISTS daily_spend DOUBLE PRECISION DEFAULT 0`);
  } catch { /* already exists */ }
  try {
    await pool.query(`ALTER TABLE metrics_history ADD COLUMN IF NOT EXISTS peak_hourly_streak INTEGER DEFAULT 0`);
  } catch { /* already exists */ }

  // Backfill daily_spend from existing daily_tokens and estimated_spend
  try {
    await pool.query(`
      UPDATE metrics_history mh SET daily_spend = (
        CASE WHEN um.total_tokens > 0
          THEN um.estimated_spend * mh.daily_tokens / um.total_tokens
          ELSE 0 END
      )
      FROM user_metrics um
      WHERE um.user_hash = mh.user_hash
        AND mh.daily_spend = 0
        AND mh.daily_tokens > 0
    `);
  } catch { /* backfill already ran or no data */ }

  // One-time backfill: reconstruct historical peak_hourly_streak from metrics_hourly.
  // Before this migration, peak_hourly_streak only captured streaks that were active
  // *at sync time*. Users who completed long streaks (e.g. 46h) before the column
  // existed have 0 stored, so the lifetime leaderboard's MAX(peak_hourly_streak)
  // misses them. Replay metrics_hourly per primary-user (unioning all linked
  // devices) to find each consecutive-UTC-hour run, then write the run length to
  // every date the run touched. Idempotent via GREATEST so it's safe to re-run.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS migrations_log (
      key TEXT PRIMARY KEY,
      ran_at TEXT NOT NULL
    )
  `);
  const { rows: bfRows } = await pool.query(
    `SELECT 1 FROM migrations_log WHERE key = 'backfill_peak_hourly_streak_v1'`
  );
  if (bfRows.length === 0) {
    try {
      await pool.query(`
        WITH primary_to_devices AS (
          SELECT COALESCE(linked_to, user_hash) AS primary_hash, user_hash AS device_hash FROM users
        ),
        distinct_hours_per_primary AS (
          SELECT DISTINCT p2d.primary_hash, mh.snapshot_hour::timestamp AS hour_ts
          FROM metrics_hourly mh
          JOIN primary_to_devices p2d ON p2d.device_hash = mh.user_hash
          WHERE mh.total_messages > 0 OR mh.total_tokens > 0
        ),
        ranked AS (
          SELECT primary_hash, hour_ts,
            hour_ts - (INTERVAL '1 hour' * ROW_NUMBER() OVER (PARTITION BY primary_hash ORDER BY hour_ts)) AS run_group
          FROM distinct_hours_per_primary
        ),
        run_extents AS (
          SELECT primary_hash, run_group, COUNT(*) AS run_len, MIN(hour_ts) AS run_start, MAX(hour_ts) AS run_end
          FROM ranked GROUP BY primary_hash, run_group
        ),
        run_date_expansion AS (
          SELECT primary_hash, run_len,
            TO_CHAR(d, 'YYYY-MM-DD') AS run_date
          FROM run_extents r,
          LATERAL generate_series(DATE_TRUNC('day', r.run_start), DATE_TRUNC('day', r.run_end), '1 day') AS d
        ),
        peak_per_user_date AS (
          SELECT primary_hash, run_date, MAX(run_len)::int AS peak_streak
          FROM run_date_expansion GROUP BY primary_hash, run_date
        )
        INSERT INTO metrics_history (user_hash, snapshot_date, peak_hourly_streak)
        SELECT primary_hash, run_date, peak_streak FROM peak_per_user_date WHERE peak_streak > 0
        ON CONFLICT (user_hash, snapshot_date) DO UPDATE SET
          peak_hourly_streak = GREATEST(COALESCE(metrics_history.peak_hourly_streak, 0), EXCLUDED.peak_hourly_streak)
      `);
      await pool.query(
        `INSERT INTO migrations_log (key, ran_at) VALUES ('backfill_peak_hourly_streak_v1', $1)
         ON CONFLICT (key) DO NOTHING`,
        [new Date().toISOString()],
      );
    } catch (e) {
      console.error("[db] peak_hourly_streak backfill failed", e);
    }
  }

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

  // ── Codex parity migrations ──
  // Add gamification/uniqueness columns the POC didn't define so Phase-3
  // aggregation can persist them. NULL-safe defaults match the Claude tables.
  const codexColumns: Array<[string, string]> = [
    ["prompt_uniqueness_score", "DOUBLE PRECISION DEFAULT 0"],
    ["current_streak", "INTEGER DEFAULT 0"],
    ["total_points", "BIGINT DEFAULT 0"],
    ["level", "INTEGER DEFAULT 0"],
    ["current_hourly_streak", "INTEGER DEFAULT 0"],
  ];
  for (const table of ["codex_device_metrics", "codex_user_metrics"]) {
    for (const [col, type] of codexColumns) {
      try {
        await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col} ${type}`);
      } catch { /* already exists */ }
    }
  }

  // One-shot: the POC stored every Codex token under model_name = 'codex'.
  // Phase-1 collects real model names (gpt-5.2-codex etc.), so the legacy
  // rows would double-count after the first post-upgrade sync. Idempotent
  // via migrations_log.
  const { rows: codexCleanupRows } = await pool.query(
    `SELECT 1 FROM migrations_log WHERE key = 'codex_drop_legacy_model_name_v1'`
  );
  if (codexCleanupRows.length === 0) {
    try {
      await pool.query(`DELETE FROM metrics_model_daily WHERE model_name = 'codex'`);
      await pool.query(
        `INSERT INTO migrations_log (key, ran_at) VALUES ('codex_drop_legacy_model_name_v1', $1)
         ON CONFLICT (key) DO NOTHING`,
        [new Date().toISOString()],
      );
    } catch (e) {
      console.error("[db] codex legacy model_name cleanup failed", e);
    }
  }
}
