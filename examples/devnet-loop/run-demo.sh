#!/usr/bin/env bash
# exfer agent-to-agent closed-loop demo on an isolated local devnet.
#
#   mine    Agent B (payer) earns its balance: the devnet node mines to B's pubkey.
#   quote   Agent A (payee) issues a signed EXFER-QUOTE via walletd quote_issue.
#   settle  Agent B verifies the quote, then settles on-chain with the quote_id
#           bound as the output datum (walletd transfer).
#   honor   Agent A's honor gate (this library, the REAL engine) finds the
#           settlement via the indexer, waits confirmation depth, and delivers
#           atomically inside the §5 gate transaction.
#
# Binaries (override via env):
#   EXFER_BIN    exfer node built with `EXFER_TESTNET_OVERRIDE=1 cargo build
#                --release --features testnet,allow-testnet-release`
#                (the `devnet` subcommand needs trivial difficulty)
#   WALLETD_BIN  exfer-walletd >= the --expect-genesis change (binds the
#                process signature domain to the devnet genesis)
#   INDEXER_BIN  exfer-indexer release build
#
# Everything runs on loopback; the devnet stands up no P2P listener.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXFER="${EXFER_BIN:-$HOME/exfer/target/release/exfer}"
WALLETD="${WALLETD_BIN:-$HOME/crypto-due-dil/exfer-walletd/target/release/exfer-walletd}"
INDEXER="${INDEXER_BIN:-$HOME/crypto-due-dil/exfer-indexer/target/release/exfer-indexer}"
for bin in "$EXFER" "$WALLETD" "$INDEXER"; do
  [ -x "$bin" ] || { echo "FATAL: missing binary $bin (see header for env overrides)" >&2; exit 1; }
done

DEMO="${DEMO_DIR:-/tmp/exfer-loop-demo}"
NODE_RPC=http://127.0.0.1:19334
INDEXER_RPC=http://127.0.0.1:19335
WALLETD_A=http://127.0.0.1:17449   # Agent A — payee / merchant
WALLETD_B=http://127.0.0.1:17450   # Agent B — payer / buyer

PIDS=()
cleanup() {
  for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup EXIT

log() { printf '\n=== %s ===\n' "$*"; }

rpc() { # rpc <url> <token-or-"-"> <method> <params-json>
  local url=$1 token=$2 method=$3 params=${4:-null}
  local auth=()
  [ "$token" != "-" ] && auth=(-H "Authorization: Bearer $token")
  curl -sS --max-time 30 "$url" -H 'content-type: application/json' "${auth[@]}" \
    -d "{\"jsonrpc\":\"2.0\",\"method\":\"$method\",\"params\":$params,\"id\":1}"
}

wait_http() { # wait_http <url> <name> <secs>
  local url=$1 name=$2 secs=${3:-30}
  for _ in $(seq 1 $((secs * 2))); do
    if curl -sS --max-time 2 "$url" -H 'content-type: application/json' \
        -d '{"jsonrpc":"2.0","method":"ping","params":null,"id":1}' >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  echo "FATAL: $name did not come up at $url" >&2
  exit 1
}

rm -rf "$DEMO"
mkdir -p "$DEMO"/{node,indexer,walletd-a,walletd-b,log,out}

# ---------------------------------------------------------------- 1. devnet up
log "1/8 devnet node up (bootstrap, default miner)"
"$EXFER" devnet --datadir "$DEMO/node" --rpc-bind 127.0.0.1:19334 \
  >"$DEMO/log/node.log" 2>&1 &
PIDS+=($!)
wait_http "$NODE_RPC" "devnet node" 30
GENESIS=$(rpc "$NODE_RPC" - get_block_height | jq -r .result.genesis_block_id)
echo "genesis: $GENESIS"

# ------------------------------------------------------------- 2. walletd A+B
log "2/8 walletd A (payee) + B (payer) up"
WALLETD_KEYSTORE_PASSPHRASE=demo-pass-a "$WALLETD" \
  --datadir "$DEMO/walletd-a" --bind 127.0.0.1:17449 \
  --node-rpc "$NODE_RPC" --indexer-rpc "$INDEXER_RPC" \
  --expect-genesis "$GENESIS" \
  >"$DEMO/log/walletd-a.log" 2>&1 &
PIDS+=($!)
WALLETD_KEYSTORE_PASSPHRASE=demo-pass-b "$WALLETD" \
  --datadir "$DEMO/walletd-b" --bind 127.0.0.1:17450 \
  --node-rpc "$NODE_RPC" --indexer-rpc "$INDEXER_RPC" \
  --expect-genesis "$GENESIS" \
  >"$DEMO/log/walletd-b.log" 2>&1 &
PIDS+=($!)
wait_http "$WALLETD_A" "walletd A" 30
wait_http "$WALLETD_B" "walletd B" 30
TOKEN_A=$(cat "$DEMO/walletd-a/token-spend")
TOKEN_B=$(cat "$DEMO/walletd-b/token-spend")

log "3/8 agent identities"
A_INFO=$(rpc "$WALLETD_A" "$TOKEN_A" generate_standard_address '{}')
B_INFO=$(rpc "$WALLETD_B" "$TOKEN_B" generate_standard_address '{}')
PAYEE_ADDR=$(echo "$A_INFO" | jq -r .result.address)
PAYEE_PUBKEY=$(echo "$A_INFO" | jq -r .result.pubkey)
PAYER_ADDR=$(echo "$B_INFO" | jq -r .result.address)
PAYER_PUBKEY=$(echo "$B_INFO" | jq -r .result.pubkey)
echo "Agent A (payee): addr=$PAYEE_ADDR"
echo "Agent B (payer): addr=$PAYER_ADDR"

# ------------------------------------------------- 3. mine: B earns its balance
log "4/8 MINE — restart devnet mining to Agent B's pubkey"
kill "${PIDS[0]}" 2>/dev/null || true
sleep 1
"$EXFER" devnet --datadir "$DEMO/node" --rpc-bind 127.0.0.1:19334 \
  --miner-pubkey "$PAYER_PUBKEY" \
  >"$DEMO/log/node-mine-to-b.log" 2>&1 &
PIDS[0]=$!
wait_http "$NODE_RPC" "devnet node (mining to B)" 30

echo "waiting for Agent B's mined balance to mature…"
B_BALANCE=0
for _ in $(seq 1 120); do
  B_BALANCE=$(rpc "$WALLETD_B" "$TOKEN_B" get_balance \
    "{\"address\":\"$PAYER_ADDR\"}" | jq -r '.result.balance // 0')
  [ "$B_BALANCE" -gt 0 ] 2>/dev/null && break
  sleep 1
done
if [ "${B_BALANCE:-0}" -le 0 ]; then
  echo "FATAL: Agent B never received mining rewards" >&2
  exit 1
fi
HEIGHT=$(rpc "$NODE_RPC" - get_block_height | jq -r .result.height)
echo "Agent B mined balance: $B_BALANCE (height $HEIGHT)"

# ----------------------------------------------------------------- 4. indexer
log "5/8 indexer up (backfill from genesis)"
"$INDEXER" --node-rpc "$NODE_RPC" --datadir "$DEMO/indexer" \
  --bind 127.0.0.1:19335 --poll-secs 1 \
  >"$DEMO/log/indexer.log" 2>&1 &
PIDS+=($!)
for _ in $(seq 1 60); do
  LAG=$(rpc "$INDEXER_RPC" - get_indexer_status 2>/dev/null \
    | jq -r '.result.lag // empty' || true)
  [ -n "$LAG" ] && [ "$LAG" -le 2 ] 2>/dev/null && break
  sleep 1
done
echo "indexer lag: ${LAG:-unknown}"

# -------------------------------------------------------------- 5. quote (A)
log "6/8 QUOTE — Agent A issues a signed EXFER-QUOTE"
AMOUNT=$((B_BALANCE / 10))
QUOTE_RES=$(rpc "$WALLETD_A" "$TOKEN_A" quote_issue "{
  \"address\": \"$PAYEE_ADDR\",
  \"payee_pubkey\": \"$PAYEE_PUBKEY\",
  \"currency\": \"USD\",
  \"amount_minor\": 100,
  \"rate_exfers_per_unit\": 1,
  \"exfer_amount\": $AMOUNT,
  \"ttl_secs\": 900,
  \"memo\": \"devnet-loop demo: pay-per-call API access\"
}")
echo "$QUOTE_RES" | jq .result.quote >"$DEMO/out/quote.json"
QUOTE_ID=$(jq -r .quote_id "$DEMO/out/quote.json")
echo "quote_id: $QUOTE_ID  amount: $AMOUNT  genesis: $(echo "$QUOTE_RES" | jq -r .result.genesis_block_id)"

# ------------------------------------------------------- 6. honor watcher (A)
log "7/8 HONOR — Agent A's gate starts watching (register before settle)"
(
  cd "$SCRIPT_DIR"
  EXFER_WALLETD_URL="$WALLETD_A" \
  EXFER_INDEXER_URL="$INDEXER_RPC" \
  EXFER_NODE_URL="$NODE_RPC" \
  WALLETD_TOKEN="$TOKEN_A" \
  QUOTE_JSON_PATH="$DEMO/out/quote.json" \
  GATE_DB_PATH="$DEMO/out/gate.db" \
  POLL_MS=1000 \
  npx tsx driver.ts
) >"$DEMO/log/honor.log" 2>&1 &
HONOR_PID=$!
PIDS+=($HONOR_PID)
sleep 5   # let ACCEPT + register (R6 write-ahead) land before the payment

# ------------------------------------------------------------- 7. settle (B)
log "8/8 SETTLE — Agent B verifies the quote, then pays with datum=quote_id"
VERIFY=$(rpc "$WALLETD_B" "$TOKEN_B" quote_verify \
  "{\"quote\": $(cat "$DEMO/out/quote.json")}")
echo "Agent B quote_verify: $(echo "$VERIFY" | jq -c '.result | {valid, reason}')"
[ "$(echo "$VERIFY" | jq -r .result.valid)" = "true" ] || { echo "FATAL: quote invalid" >&2; exit 1; }

TRANSFER=$(rpc "$WALLETD_B" "$TOKEN_B" transfer "{
  \"from\": \"$PAYER_ADDR\",
  \"outputs\": [{\"to\": \"$PAYEE_ADDR\", \"amount\": $AMOUNT}],
  \"fee_rate\": 1,
  \"datum\": \"$QUOTE_ID\",
  \"client_token\": \"settle-$QUOTE_ID\"
}")
SETTLE_TX=$(echo "$TRANSFER" | jq -r .result.tx_id)
if [ -z "$SETTLE_TX" ] || [ "$SETTLE_TX" = "null" ]; then
  echo "FATAL: transfer failed: $TRANSFER" >&2
  exit 1
fi
echo "settlement tx: $SETTLE_TX (datum-bound to quote_id)"

# --------------------------------------------------------------- 8. wait honor
echo
echo "waiting for the honor gate to fire (depth 6)…"
HONOR_EXIT=0
for _ in $(seq 1 180); do
  if ! kill -0 "$HONOR_PID" 2>/dev/null; then break; fi
  sleep 1
done
if kill -0 "$HONOR_PID" 2>/dev/null; then
  echo "FATAL: honor watcher still running after 180s" >&2
  exit 1
fi
wait "$HONOR_PID" || HONOR_EXIT=$?

echo
echo "──────────────────────── transcript ────────────────────────"
echo "genesis:        $GENESIS"
echo "payer (B):      $PAYER_ADDR  mined balance: $B_BALANCE"
echo "payee (A):      $PAYEE_ADDR"
echo "quote_id:       $QUOTE_ID  amount: $AMOUNT"
echo "settlement tx:  $SETTLE_TX"
echo "final height:   $(rpc "$NODE_RPC" - get_block_height | jq -r .result.height)"
echo "honor log tail:"
tail -12 "$DEMO/log/honor.log" | sed 's/^/  /'
echo "─────────────────────────────────────────────────────────────"
if [ "$HONOR_EXIT" -eq 0 ]; then
  echo "LOOP CLOSED: mine → quote → settle → honor ✅"
else
  echo "LOOP FAILED: honor exit $HONOR_EXIT — see $DEMO/log/honor.log" >&2
  exit "$HONOR_EXIT"
fi
