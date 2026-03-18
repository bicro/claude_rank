#!/bin/bash
# Clean reset: truncate DB directly via psql and clear local cache.
# No running server required.
# Usage: ./clean-reset.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Load DATABASE_URL from .env.local
if [ -f "$SCRIPT_DIR/.env.local" ]; then
  DATABASE_URL=$(grep '^DATABASE_URL=' "$SCRIPT_DIR/.env.local" | cut -d'=' -f2-)
fi

if [ -z "$DATABASE_URL" ]; then
  echo "ERROR: DATABASE_URL not found in .env.local"
  exit 1
fi

echo "==> Truncating server tables..."
psql "$DATABASE_URL" -c "
  TRUNCATE user_metrics, device_metrics, metrics_history, metrics_hourly,
           user_badges, concurrency_histogram, daily_sessions, merge_log,
           users, teams CASCADE;
  TRUNCATE \"session\", \"account\", \"verification\", \"user\" CASCADE;
"
echo "    Tables truncated."

echo "==> Clearing local cache (~/.ClaudeRank/)..."
rm -f ~/.ClaudeRank/ranking.json \
      ~/.ClaudeRank/state.json \
      ~/.ClaudeRank/stats-cache.json \
      ~/.ClaudeRank/window_prefs.json
echo "    Cache cleared."

echo "==> Done. Restart the server and desktop app for a clean slate."
