import { Database } from "bun:sqlite";

let _db: Database | null = null;

export function getDb(): Database {
  if (!_db) {
    _db = new Database("./clauderank.db", { create: true });
    _db.exec("PRAGMA journal_mode = WAL");
    _db.exec("PRAGMA foreign_keys = ON");
    initDb(_db);
  }
  return _db;
}

export function initDb(db?: Database): void {
  const d = db ?? getDb();

  d.exec(`
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
      created_at TEXT,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS user_metrics (
      user_hash TEXT PRIMARY KEY REFERENCES users(user_hash),
      total_tokens INTEGER DEFAULT 0,
      total_messages INTEGER DEFAULT 0,
      total_sessions INTEGER DEFAULT 0,
      total_tool_calls INTEGER DEFAULT 0,
      prompt_uniqueness_score REAL DEFAULT 0,
      weighted_score REAL DEFAULT 0,
      current_streak INTEGER DEFAULT 0,
      total_points INTEGER DEFAULT 0,
      level INTEGER DEFAULT 0,
      estimated_spend REAL DEFAULT 0,
      last_synced TEXT,
      total_session_time_secs INTEGER DEFAULT 0,
      total_active_time_secs INTEGER DEFAULT 0,
      total_idle_time_secs INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS metrics_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_hash TEXT,
      snapshot_date TEXT,
      total_tokens INTEGER DEFAULT 0,
      total_messages INTEGER DEFAULT 0,
      total_sessions INTEGER DEFAULT 0,
      total_tool_calls INTEGER DEFAULT 0,
      prompt_uniqueness_score REAL DEFAULT 0,
      weighted_score REAL DEFAULT 0,
      daily_messages INTEGER DEFAULT 0,
      daily_tool_calls INTEGER DEFAULT 0,
      daily_tokens INTEGER DEFAULT 0,
      UNIQUE(user_hash, snapshot_date)
    );

    CREATE TABLE IF NOT EXISTS metrics_hourly (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_hash TEXT,
      snapshot_hour TEXT,
      total_tokens INTEGER DEFAULT 0,
      total_messages INTEGER DEFAULT 0,
      total_sessions INTEGER DEFAULT 0,
      total_tool_calls INTEGER DEFAULT 0,
      prompt_uniqueness_score REAL DEFAULT 0,
      weighted_score REAL DEFAULT 0,
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
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_hash TEXT,
      snapshot_hour TEXT,
      histogram TEXT,
      UNIQUE(user_hash, snapshot_hour)
    );

    CREATE TABLE IF NOT EXISTS daily_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_hash TEXT,
      snapshot_date TEXT,
      sessions TEXT,
      UNIQUE(user_hash, snapshot_date)
    );

    CREATE INDEX IF NOT EXISTS idx_metrics_history_user_hash ON metrics_history(user_hash);
    CREATE INDEX IF NOT EXISTS idx_metrics_hourly_user_hash ON metrics_hourly(user_hash);
    CREATE INDEX IF NOT EXISTS idx_concurrency_histogram_user_hash ON concurrency_histogram(user_hash);
    CREATE INDEX IF NOT EXISTS idx_daily_sessions_user_hash ON daily_sessions(user_hash);
  `);
}
