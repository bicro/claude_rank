#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

log() {
  echo "[build:mac] $*"
}

fail() {
  echo "[build:mac] ERROR: $*" >&2
  exit 1
}

mask_secret() {
  local value="$1"
  local len=${#value}
  if (( len <= 8 )); then
    echo "********"
  else
    echo "${value:0:4}****${value:len-4:4}"
  fi
}

# Required environment variables for code signing and notarization
# Set these in your environment or .env.local file:
#   APPLE_ID - Your Apple Developer email
#   APPLE_PASSWORD - App-specific password for notarization
#   APPLE_TEAM_ID - Your Apple Developer Team ID
#   APPLE_SIGNING_IDENTITY - Your signing certificate identity
export APPLE_ID="${APPLE_ID:-}"
export APPLE_PASSWORD="${APPLE_PASSWORD:-}"
export APPLE_TEAM_ID="${APPLE_TEAM_ID:-}"
export APPLE_SIGNING_IDENTITY="${APPLE_SIGNING_IDENTITY:-}"

log "Starting macOS build permission checks..."

[[ "$(uname -s)" == "Darwin" ]] || fail "This build script must run on macOS."
command -v security >/dev/null 2>&1 || fail "Missing required tool: security"
command -v xcrun >/dev/null 2>&1 || fail "Missing required tool: xcrun"
command -v bunx >/dev/null 2>&1 || fail "Missing required tool: bunx"

[[ -n "$APPLE_ID" ]] || fail "APPLE_ID is empty."
[[ -n "$APPLE_PASSWORD" ]] || fail "APPLE_PASSWORD is empty."
[[ -n "$APPLE_TEAM_ID" ]] || fail "APPLE_TEAM_ID is empty."
[[ -n "$APPLE_SIGNING_IDENTITY" ]] || fail "APPLE_SIGNING_IDENTITY is empty."

log "Using Apple ID: $APPLE_ID"
log "Using Apple Team ID: $APPLE_TEAM_ID"
log "Using Apple Signing Identity: $APPLE_SIGNING_IDENTITY"

if ! xcrun notarytool --version >/dev/null 2>&1; then
  fail "xcrun notarytool is unavailable. Install/update Xcode command line tools."
fi
log "notarytool available."

IDENTITIES="$(security find-identity -v -p codesigning 2>/dev/null || true)"
if ! grep -Fq "$APPLE_SIGNING_IDENTITY" <<<"$IDENTITIES"; then
  fail "Signing identity not found in keychain: $APPLE_SIGNING_IDENTITY"
fi
log "Signing identity exists in keychain."

TAURI_CONF="$PROJECT_ROOT/src-tauri/tauri.conf.json"
if ! grep -Fq "\"signingIdentity\": \"$APPLE_SIGNING_IDENTITY\"" "$TAURI_CONF"; then
  fail "tauri.conf signingIdentity does not match required identity."
fi
log "tauri.conf signingIdentity matches."

NOTARY_CHECK_LOG="$(mktemp)"
if ! xcrun notarytool history \
  --apple-id "$APPLE_ID" \
  --password "$APPLE_PASSWORD" \
  --team-id "$APPLE_TEAM_ID" >"$NOTARY_CHECK_LOG" 2>&1; then
  sed -n '1,40p' "$NOTARY_CHECK_LOG" >&2
  rm -f "$NOTARY_CHECK_LOG"
  fail "Apple notarization credential/permission check failed."
fi
rm -f "$NOTARY_CHECK_LOG"
log "Apple notarization credential/permission check passed."

log "All permission checks passed. Running Tauri build..."
cd "$PROJECT_ROOT"
exec bunx tauri build --target universal-apple-darwin "$@"
