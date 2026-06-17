#!/usr/bin/env bash
# Exfer agent-to-agent settlement — the SAME closed loop as ../devnet-loop, but
# on the LIVE mainnet against real public nodes + indexer, settling a small
# amount of REAL EXFER. Nothing is faked: real quote, real on-chain payment,
# real indexer reverse-lookup, real §5 atomic honor gate.
#
#   quote   Agent A (payee / seller) issues a signed EXFER-QUOTE via walletd.
#   settle  Agent B (payer / buyer)  verifies it, then pays on-chain with the
#           quote_id bound as the output datum (a small REAL EXFER transfer).
#   honor   Agent A's honor gate (the REAL exfer-honor engine) finds the
#           settlement via the indexer, waits the confirmation depth, and
#           delivers the goods atomically inside the §5 gate transaction.
#
# Two fresh loopback walletd instances are stood up (A = payee, B = payer); the
# demo NEVER touches your existing wallets. Agent B starts empty — the script
# prints B's address and WAITS for you to send it a little EXFER, then runs the
# rest automatically. State lives under $DEMO so a re-run reuses the same agents
# (and any leftover B balance) instead of asking you to fund again.
#
# Binaries (override via env):
#   WALLETD_BIN  exfer-walletd release build (default: sibling repo target/)
# Mainnet endpoints (override via env) — default to the Seoul public reference:
#   NODE_RPC     mainnet node JSON-RPC      (default http://64.176.231.198:9334)
#   INDEXER_RPC  mainnet indexer JSON-RPC   (default http://64.176.231.198:9335)
# Tunables:
#   SETTLE_EXFERS  amount to settle, in exfers (1 EXFER = 1e8). Default 5_000_000
#                  (0.05 EXFER). Must be ≤ B's funded balance minus fee.
#   FEE_RATE       transfer fee rate (default 1)
#   CONFIRM_SECS   how long to wait for the honor depth gate (default 600s)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SIBLINGS="$(cd "$SCRIPT_DIR/../../.." && pwd)"
WALLETD="${WALLETD_BIN:-$SIBLINGS/exfer-walletd/target/release/exfer-walletd}"
DRIVER_DIR="$SCRIPT_DIR/../devnet-loop"   # reuse the generic honor watcher + its deps
[ -x "$WALLETD" ] || { echo "FATAL: missing walletd binary $WALLETD (set WALLETD_BIN)" >&2; exit 1; }
[ -f "$DRIVER_DIR/driver.ts" ] || { echo "FATAL: missing $DRIVER_DIR/driver.ts" >&2; exit 1; }

NODE_RPC="${NODE_RPC:-http://64.176.231.198:9334}"
INDEXER_RPC="${INDEXER_RPC:-http://64.176.231.198:9335}"
SETTLE_EXFERS="${SETTLE_EXFERS:-5000000}"   # 0.05 EXFER
FEE_RATE="${FEE_RATE:-1}"
CONFIRM_SECS="${CONFIRM_SECS:-600}"

DEMO="${DEMO_DIR:-/tmp/exfer-mainnet-loop}"
WALLETD_A=http://127.0.0.1:27449   # Agent A — payee / seller
WALLETD_B=http://127.0.0.1:27450   # Agent B — payer / buyer
PASS_A="${PASS_A:-mainnet-demo-pass-a}"
PASS_B="${PASS_B:-mainnet-demo-pass-b}"

PIDS=()
cleanup() { for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done; wait 2>/dev/null || true; }
trap cleanup EXIT
log() { printf '\n=== %s ===\n' "$*"; }

rpc() { # rpc <url> <token-or-"-"> <method> <params-json>
  local url=$1 token=$2 method=$3 params=${4:-null} auth=()
  [ "$token" != "-" ] && auth=(-H "Authorization: Bearer $token")
  curl -sS --max-time 30 "$url" -H 'content-type: application/json' "${auth[@]}" \
    -d "{\"jsonrpc\":\"2.0\",\"method\":\"$method\",\"params\":$params,\"id\":1}"
}
wait_http() { # wait_http <url> <name> <secs>
  local url=$1 name=$2 secs=${3:-30}
  for _ in $(seq 1 $((secs * 2))); do
    if curl -sS --max-time 2 "$url" -H 'content-type: application/json' \
        -d '{"jsonrpc":"2.0","method":"ping","params":null,"id":1}' >/dev/null 2>&1; then return 0; fi
    sleep 0.5
  done
  echo "FATAL: $name did not come up at $url" >&2; exit 1
}

# -------------------------------------------------------- 0. confirm mainnet up
log "0/6 mainnet reachable? ($NODE_RPC + indexer)"
GENESIS=$(rpc "$NODE_RPC" - get_block_height | jq -r .result.genesis_block_id)
HEIGHT0=$(rpc "$NODE_RPC" - get_block_height | jq -r .result.height)
[ -n "$GENESIS" ] && [ "$GENESIS" != "null" ] || { echo "FATAL: no genesis from $NODE_RPC" >&2; exit 1; }
echo "genesis: $GENESIS   tip height: $HEIGHT0"

# ------------------------------------------------------------- 1. walletd A + B
log "1/6 stand up walletd A (payee) + B (payer), pinned to mainnet genesis"
mkdir -p "$DEMO"/{walletd-a,walletd-b,log,out}
# Seed a keystore on first run only (idempotent re-runs reuse the same agents).
for who in a b; do
  pass_var="PASS_${who^^}"; ddir="$DEMO/walletd-$who"
  if [ ! -f "$ddir/wallets/seed.enc" ]; then
    WALLETD_KEYSTORE_PASSPHRASE="${!pass_var}" WALLETD_DATADIR="$ddir" "$WALLETD" init-seeded \
      >"$DEMO/log/init-$who.log" 2>&1 || { echo "FATAL: init-seeded $who failed (see $DEMO/log/init-$who.log)" >&2; exit 1; }
  fi
done
WALLETD_KEYSTORE_PASSPHRASE="$PASS_A" "$WALLETD" --datadir "$DEMO/walletd-a" --bind 127.0.0.1:27449 \
  --node-rpc "$NODE_RPC" --indexer-rpc "$INDEXER_RPC" --expect-genesis "$GENESIS" \
  >"$DEMO/log/walletd-a.log" 2>&1 & PIDS+=($!)
WALLETD_KEYSTORE_PASSPHRASE="$PASS_B" "$WALLETD" --datadir "$DEMO/walletd-b" --bind 127.0.0.1:27450 \
  --node-rpc "$NODE_RPC" --indexer-rpc "$INDEXER_RPC" --expect-genesis "$GENESIS" \
  >"$DEMO/log/walletd-b.log" 2>&1 & PIDS+=($!)
wait_http "$WALLETD_A" "walletd A" 30
wait_http "$WALLETD_B" "walletd B" 30
TOKEN_A=$(cat "$DEMO/walletd-a/token-spend")
TOKEN_B=$(cat "$DEMO/walletd-b/token-spend")

# ----------------------------------------------------------- 2. agent identities
# Agent A (payee) needs address + PUBKEY (quote + honor derive the watched
# address from it). Only the generate_* methods return a pubkey — list_addresses
# omits it — so we generate A's payee identity once and persist it for re-runs.
# Agent B (payer) only needs its address as the transfer `from`, so we reuse its
# seeded address (list_addresses[0]) — that's the one we fund on-chain, and it
# survives re-runs without re-funding.
log "2/6 agent identities (reused across runs)"
A_ID="$DEMO/out/agent-a.json"
if [ ! -s "$A_ID" ]; then
  rpc "$WALLETD_A" "$TOKEN_A" generate_standard_address '{"label":"payee"}' | jq -e '.result' >"$A_ID" \
    || { echo "FATAL: could not generate Agent A address" >&2; exit 1; }
fi
PAYEE_ADDR=$(jq -r .address "$A_ID")
PAYEE_PUBKEY=$(jq -r .pubkey "$A_ID")
PAYER_ADDR=$(rpc "$WALLETD_B" "$TOKEN_B" list_addresses '{}' | jq -r '.result.addresses[0].address // empty')
[ -n "$PAYEE_ADDR" ] && [ -n "$PAYEE_PUBKEY" ] && [ -n "$PAYER_ADDR" ] \
  || { echo "FATAL: identity setup incomplete (A=$PAYEE_ADDR pk=${PAYEE_PUBKEY:0:8} B=$PAYER_ADDR)" >&2; exit 1; }
echo "Agent A (payee / seller): $PAYEE_ADDR"
echo "Agent B (payer / buyer):  $PAYER_ADDR"

# ------------------------------------------------------------- 3. fund Agent B
log "3/6 FUND — Agent B (buyer) needs a little REAL EXFER"
NEED=$((SETTLE_EXFERS + 1000000))   # settle amount + headroom for fee
B_BAL=$(rpc "$WALLETD_B" "$TOKEN_B" get_balance "{\"address\":\"$PAYER_ADDR\"}" | jq -r '.result.balance // 0')
if [ "${B_BAL:-0}" -lt "$NEED" ] 2>/dev/null; then
  cat <<EOF

  ┌────────────────────────────────────────────────────────────────────┐
  │  Send a little EXFER to Agent B to let the demo settle on mainnet.   │
  │                                                                      │
  │    address:  $PAYER_ADDR
  │    suggest:  >= $(awk "BEGIN{printf \"%.4f\", $NEED/100000000}") EXFER  (settle $(awk "BEGIN{printf \"%.4f\", $SETTLE_EXFERS/100000000}") + fee headroom)
  │                                                                      │
  │  From your mobile/desktop wallet, Send → paste the address above.    │
  │  The script polls every 5s and continues the moment it sees funds.   │
  └────────────────────────────────────────────────────────────────────┘
EOF
  printf 'waiting for Agent B to be funded'
  for _ in $(seq 1 720); do   # up to 1h
    B_BAL=$(rpc "$WALLETD_B" "$TOKEN_B" get_balance "{\"address\":\"$PAYER_ADDR\"}" | jq -r '.result.balance // 0')
    [ "${B_BAL:-0}" -ge "$NEED" ] 2>/dev/null && { echo; break; }
    printf '.'; sleep 5
  done
fi
[ "${B_BAL:-0}" -ge "$NEED" ] 2>/dev/null || { echo "FATAL: Agent B still underfunded ($B_BAL < $NEED)" >&2; exit 1; }
echo "Agent B funded: $B_BAL exfers ($(awk "BEGIN{printf \"%.4f\", $B_BAL/100000000}") EXFER)"

# --------------------------------------------------------------- 4. quote (A)
log "4/6 QUOTE — Agent A issues a signed EXFER-QUOTE for $SETTLE_EXFERS exfers"
QUOTE_RES=$(rpc "$WALLETD_A" "$TOKEN_A" quote_issue "{
  \"address\": \"$PAYEE_ADDR\", \"payee_pubkey\": \"$PAYEE_PUBKEY\",
  \"currency\": \"USD\", \"amount_minor\": 100, \"rate_exfers_per_unit\": 1,
  \"exfer_amount\": $SETTLE_EXFERS, \"ttl_secs\": 1800,
  \"memo\": \"mainnet agent-to-agent demo: pay-per-call API access\"
}")
echo "$QUOTE_RES" | jq .result.quote >"$DEMO/out/quote.json"
QUOTE_ID=$(jq -r .quote_id "$DEMO/out/quote.json")
[ -n "$QUOTE_ID" ] && [ "$QUOTE_ID" != "null" ] || { echo "FATAL: quote_issue failed: $QUOTE_RES" >&2; exit 1; }
echo "quote_id: $QUOTE_ID"

# ------------------------------------------------------- 5. honor watcher (A)
log "5/6 HONOR — Agent A's gate starts watching (register before settle)"
rm -f "$DEMO/out/gate.db"
(
  cd "$DRIVER_DIR"
  EXFER_WALLETD_URL="$WALLETD_A" EXFER_INDEXER_URL="$INDEXER_RPC" EXFER_NODE_URL="$NODE_RPC" \
  WALLETD_TOKEN="$TOKEN_A" QUOTE_JSON_PATH="$DEMO/out/quote.json" \
  GATE_DB_PATH="$DEMO/out/gate.db" POLL_MS=2000 npx tsx driver.ts
) >"$DEMO/log/honor.log" 2>&1 &
HONOR_PID=$!; PIDS+=($HONOR_PID)
sleep 6   # let ACCEPT + R6 write-ahead register before payment lands

# ------------------------------------------------------------- 6. settle (B)
log "6/6 SETTLE — Agent B verifies the quote, then pays on-chain (datum=quote_id)"
VERIFY=$(rpc "$WALLETD_B" "$TOKEN_B" quote_verify "{\"quote\": $(cat "$DEMO/out/quote.json")}")
echo "Agent B quote_verify: $(echo "$VERIFY" | jq -c '.result | {valid, reason}')"
[ "$(echo "$VERIFY" | jq -r .result.valid)" = "true" ] || { echo "FATAL: quote invalid" >&2; exit 1; }
TRANSFER=$(rpc "$WALLETD_B" "$TOKEN_B" transfer "{
  \"from\": \"$PAYER_ADDR\", \"outputs\": [{\"to\": \"$PAYEE_ADDR\", \"amount\": $SETTLE_EXFERS}],
  \"fee_rate\": $FEE_RATE, \"datum\": \"$QUOTE_ID\", \"client_token\": \"settle-$QUOTE_ID\"
}")
SETTLE_TX=$(echo "$TRANSFER" | jq -r .result.tx_id)
[ -n "$SETTLE_TX" ] && [ "$SETTLE_TX" != "null" ] || { echo "FATAL: transfer failed: $TRANSFER" >&2; exit 1; }
echo "settlement tx: $SETTLE_TX (REAL mainnet, datum-bound to quote_id)"

# --------------------------------------------------------------- wait on honor
echo; echo "waiting up to ${CONFIRM_SECS}s for the honor depth gate to fire…"
HONOR_EXIT=0
for _ in $(seq 1 "$CONFIRM_SECS"); do kill -0 "$HONOR_PID" 2>/dev/null || break; sleep 1; done
if kill -0 "$HONOR_PID" 2>/dev/null; then echo "FATAL: honor watcher still running after ${CONFIRM_SECS}s" >&2; exit 1; fi
wait "$HONOR_PID" || HONOR_EXIT=$?

echo; echo "──────────────────────── mainnet transcript ────────────────────────"
echo "genesis:        $GENESIS"
echo "payee (A):      $PAYEE_ADDR"
echo "payer (B):      $PAYER_ADDR"
echo "quote_id:       $QUOTE_ID   amount: $SETTLE_EXFERS exfers"
echo "settlement tx:  $SETTLE_TX"
echo "tip height:     $(rpc "$NODE_RPC" - get_block_height | jq -r .result.height)"
echo "honor log tail:"; tail -12 "$DEMO/log/honor.log" | sed 's/^/  /'
echo "─────────────────────────────────────────────────────────────────────"
[ "$HONOR_EXIT" -eq 0 ] && echo "LOOP CLOSED ON MAINNET: quote → settle → honor ✅" \
  || { echo "LOOP FAILED: honor exit $HONOR_EXIT — see $DEMO/log/honor.log" >&2; exit "$HONOR_EXIT"; }
