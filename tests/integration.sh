#!/usr/bin/env bash
set -euo pipefail

BRIDGE_URL="${BRIDGE_URL:-http://127.0.0.1:9000/v1}"
MODEL="${MODEL:-gemini-2.5-flash}"
PASS=0
FAIL=0

ok()   { PASS=$((PASS+1)); echo "  ✅ $1"; }
fail() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }

# --- TEXT ONLY ---
echo "--- Text-only request ---"
RESP=$(curl -s -X POST "$BRIDGE_URL/chat/completions" \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Say 'pong'\"}],\"stream\":false}")
CONTENT=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['choices'][0]['message']['content'])" 2>/dev/null || echo "PARSE_ERR")
[[ "$CONTENT" != "PARSE_ERR" ]] && ok "Text response received" || fail "Text response: $RESP"

# --- SINGLE TOOL CALL ---
echo "--- Single tool call ---"
RESP=$(curl -s -X POST "$BRIDGE_URL/chat/completions" \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"What is the date? Use get_current_date.\"}],\"tools\":[{\"type\":\"function\",\"function\":{\"name\":\"get_current_date\",\"description\":\"Gets date\",\"parameters\":{\"type\":\"object\",\"properties\":{},\"required\":[]}}}],\"stream\":false}")
FINISH=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['choices'][0]['finish_reason'])" 2>/dev/null || echo "PARSE_ERR")
TC_ID=$(echo "$RESP" | python3 -c "
import sys,json
d=json.load(sys.stdin)
tc=d['choices'][0]['message']['tool_calls'][0]
print(tc['id'])" 2>/dev/null || echo "PARSE_ERR")

[[ "$FINISH" == "tool_calls" ]] && ok "Finish reason: tool_calls" || fail "Expected tool_calls, got $FINISH"
[[ "$TC_ID" == call.*.*.* ]] && ok "ID has dot format: ${TC_ID:0:30}..." || fail "ID format: $TC_ID"

# --- TOOL RESULT ROUND-TRIP ---
echo "--- Tool result round-trip ---"
RESP2=$(curl -s -X POST "$BRIDGE_URL/chat/completions" \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"What is the date? Use get_current_date.\"},{\"role\":\"assistant\",\"tool_calls\":[{\"id\":\"$TC_ID\",\"type\":\"function\",\"function\":{\"name\":\"get_current_date\",\"arguments\":\"{}\"}}]},{\"role\":\"tool\",\"tool_call_id\":\"$TC_ID\",\"content\":\"{\\\"date\\\":\\\"2026-05-09\\\"}\"}],\"tools\":[{\"type\":\"function\",\"function\":{\"name\":\"get_current_date\",\"description\":\"Gets date\",\"parameters\":{\"type\":\"object\",\"properties\":{},\"required\":[]}}}],\"stream\":false}")
HAS_ERR=$(echo "$RESP2" | python3 -c "import sys,json; d=json.load(sys.stdin); print('YES' if 'error' in d else 'NO')" 2>/dev/null || echo "PARSE_ERR")
[[ "$HAS_ERR" == "NO" ]] && ok "Tool result round-trip OK" || fail "Tool result error: $(echo "$RESP2" | head -c 200)"

# --- MULTI TOOL CALL (2 tools in one turn) ---
echo "--- Multi tool call ---"
RESP3=$(curl -s -X POST "$BRIDGE_URL/chat/completions" \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Call get_current_date AND get_current_time.\"}],\"tools\":[{\"type\":\"function\",\"function\":{\"name\":\"get_current_date\",\"description\":\"Gets date\",\"parameters\":{\"type\":\"object\",\"properties\":{},\"required\":[]}}},{\"type\":\"function\",\"function\":{\"name\":\"get_current_time\",\"description\":\"Gets time\",\"parameters\":{\"type\":\"object\",\"properties\":{},\"required\":[]}}}],\"stream\":false}")
TC_COUNT=$(echo "$RESP3" | python3 -c "
import sys,json
d=json.load(sys.stdin)
tcs=d['choices'][0]['message']['tool_calls']
print(len(tcs))" 2>/dev/null || echo "0")
ID1=$(echo "$RESP3" | python3 -c "
import sys,json; d=json.load(sys.stdin)
print(d['choices'][0]['message']['tool_calls'][0]['id'])" 2>/dev/null || echo "")
ID2=$(echo "$RESP3" | python3 -c "
import sys,json; d=json.load(sys.stdin)
print(d['choices'][0]['message']['tool_calls'][1]['id'])" 2>/dev/null || echo "")

[[ "$TC_COUNT" -ge 2 ]] && ok "Got $TC_COUNT tool calls" || fail "Expected >=2 tool calls, got $TC_COUNT"
[[ "$ID1" == call.*.*.* && "$ID2" == call.*.*.* ]] && ok "Both IDs have dot format" || fail "ID format issue: $ID1 / $ID2"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[[ "$FAIL" -gt 0 ]] && exit 1 || exit 0
