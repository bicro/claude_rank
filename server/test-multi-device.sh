#!/bin/bash
# Test multi-device linking flow.
# Prerequisites: server running on localhost:3001 (cd server && bun run dev)
#
# Usage: bash server/test-multi-device.sh

set -euo pipefail

API="http://localhost:3001"
TS=$(date +%s)
DEVICE_A="test-a-$TS"
DEVICE_B="test-b-$TS"
SECRET_A="sec-a-$TS"
SECRET_B="sec-b-$TS"

pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1 (expected $2, got $3)"; EXIT=1; }
check() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then pass "$label"; else fail "$label" "$expected" "$actual"; fi
}
EXIT=0

echo "=== Multi-Device Linking Test ==="
echo "Device A: $DEVICE_A"
echo "Device B: $DEVICE_B"
echo ""

# ── 1. Sync both devices ──
echo "Step 1: Sync Device A (10000 tokens, 100 msgs)"
curl -s -X POST "$API/api/sync" -H "Content-Type: application/json" -d "{
  \"user_hash\":\"$DEVICE_A\",\"sync_secret\":\"$SECRET_A\",
  \"totals\":{\"total_tokens\":10000,\"total_messages\":100,\"total_sessions\":10,\"total_tool_calls\":50,
    \"current_streak\":3,\"total_points\":500,\"level\":2,
    \"total_session_time_secs\":3600,\"total_active_time_secs\":3000,\"total_idle_time_secs\":600}
}" > /dev/null

echo "Step 2: Sync Device B (5000 tokens, 50 msgs)"
curl -s -X POST "$API/api/sync" -H "Content-Type: application/json" -d "{
  \"user_hash\":\"$DEVICE_B\",\"sync_secret\":\"$SECRET_B\",
  \"totals\":{\"total_tokens\":5000,\"total_messages\":50,\"total_sessions\":5,\"total_tool_calls\":25,
    \"current_streak\":1,\"total_points\":200,\"level\":1,
    \"total_session_time_secs\":1800,\"total_active_time_secs\":1500,\"total_idle_time_secs\":300}
}" > /dev/null

# ── 2. Verify individual profiles ──
echo ""
echo "Step 3: Verify individual profiles"
TOK_A=$(curl -s "$API/api/users/$DEVICE_A" | python3 -c "import sys,json; print(json.load(sys.stdin)['metrics']['total_tokens'])")
TOK_B=$(curl -s "$API/api/users/$DEVICE_B" | python3 -c "import sys,json; print(json.load(sys.stdin)['metrics']['total_tokens'])")
check "Device A tokens = 10000" "10000" "$TOK_A"
check "Device B tokens = 5000" "5000" "$TOK_B"

# ── 3. Link devices (simulates OAuth connect detecting same auth_id) ──
echo ""
echo "Step 4: Link Device B -> Device A"
cd "$(dirname "$0")"
bun run --env-file=../.env.local test-link-devices.ts "$DEVICE_A" "$DEVICE_B" 2>&1 | sed 's/^/  /'
cd ..

# ── 4. Verify aggregated profile ──
echo ""
echo "Step 5: Verify aggregated profile for Device A"
PROF_A=$(curl -s "$API/api/users/$DEVICE_A")
AGG_TOK=$(echo "$PROF_A" | python3 -c "import sys,json; print(json.load(sys.stdin)['metrics']['total_tokens'])")
AGG_MSG=$(echo "$PROF_A" | python3 -c "import sys,json; print(json.load(sys.stdin)['metrics']['total_messages'])")
check "Aggregated tokens = 15000" "15000" "$AGG_TOK"
check "Aggregated messages = 150" "150" "$AGG_MSG"

# ── 5. Verify Device B profile resolves to primary ──
echo ""
echo "Step 6: Verify Device B profile resolves to primary"
PROF_B=$(curl -s "$API/api/users/$DEVICE_B")
RESOLVED=$(echo "$PROF_B" | python3 -c "import sys,json; print(json.load(sys.stdin)['user_hash'])")
RES_TOK=$(echo "$PROF_B" | python3 -c "import sys,json; print(json.load(sys.stdin)['metrics']['total_tokens'])")
check "Profile resolves to Device A" "$DEVICE_A" "$RESOLVED"
check "Resolved tokens = 15000" "15000" "$RES_TOK"

# ── 6. Re-sync Device A, verify aggregate updates ──
echo ""
echo "Step 7: Re-sync Device A (11000 tokens now)"
curl -s -X POST "$API/api/sync" -H "Content-Type: application/json" -d "{
  \"user_hash\":\"$DEVICE_A\",\"sync_secret\":\"$SECRET_A\",
  \"totals\":{\"total_tokens\":11000,\"total_messages\":110,\"total_sessions\":11,\"total_tool_calls\":55,
    \"current_streak\":4,\"total_points\":550,\"level\":2,
    \"total_session_time_secs\":4000,\"total_active_time_secs\":3300,\"total_idle_time_secs\":700}
}" > /dev/null

AGG2=$(curl -s "$API/api/users/$DEVICE_A")
AGG2_TOK=$(echo "$AGG2" | python3 -c "import sys,json; print(json.load(sys.stdin)['metrics']['total_tokens'])")
AGG2_MSG=$(echo "$AGG2" | python3 -c "import sys,json; print(json.load(sys.stdin)['metrics']['total_messages'])")
check "After re-sync tokens = 16000 (11000+5000)" "16000" "$AGG2_TOK"
check "After re-sync messages = 160 (110+50)" "160" "$AGG2_MSG"

# ── 7. Verify Device B sync response includes primary_hash ──
echo ""
echo "Step 8: Sync Device B, check primary_hash in response"
RESP_B=$(curl -s -X POST "$API/api/sync" -H "Content-Type: application/json" -d "{
  \"user_hash\":\"$DEVICE_B\",\"sync_secret\":\"$SECRET_B\",
  \"totals\":{\"total_tokens\":6000,\"total_messages\":60,\"total_sessions\":6,\"total_tool_calls\":30,
    \"current_streak\":2,\"total_points\":250,\"level\":1,
    \"total_session_time_secs\":2000,\"total_active_time_secs\":1700,\"total_idle_time_secs\":300}
}")
PH=$(echo "$RESP_B" | python3 -c "import sys,json; print(json.load(sys.stdin).get('primary_hash','NONE'))")
check "Sync response has primary_hash" "$DEVICE_A" "$PH"

# Final aggregate should be 11000 + 6000 = 17000
AGG3=$(curl -s "$API/api/users/$DEVICE_A")
AGG3_TOK=$(echo "$AGG3" | python3 -c "import sys,json; print(json.load(sys.stdin)['metrics']['total_tokens'])")
check "Final aggregate tokens = 17000 (11000+6000)" "17000" "$AGG3_TOK"

# ── 8. Check leaderboard excludes Device B ──
echo ""
echo "Step 9: Verify leaderboard excludes secondary"
LB=$(curl -s "$API/api/leaderboard/tokens?limit=200")
HAS_B=$(echo "$LB" | python3 -c "
import sys,json
data=json.load(sys.stdin)
hashes=[e['user_hash'] for e in data.get('entries',[])]
print('NOT_FOUND' if '$DEVICE_B' not in hashes else 'FOUND')
")
check "Device B not in leaderboard" "NOT_FOUND" "$HAS_B"

echo ""
if [ "$EXIT" -eq 0 ]; then
  echo "=== ALL TESTS PASSED ==="
else
  echo "=== SOME TESTS FAILED ==="
fi
exit $EXIT
