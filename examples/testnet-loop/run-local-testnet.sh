#!/usr/bin/env bash
# Local end-to-end test of the testnet settlement loop + faucet against a REAL
# persistent-testnet node (real Argon2id PoW at the 2^252 target — not devnet).
#
# Stands up the full stack on loopback:
#   node      one testnet seed, mining to its own "treasury" wallet
#   walletd-A payee/seller   walletd-B payer/buyer   walletd-F faucet wallet
#   indexer   settlement reverse index
#   faucet    examples/testnet-faucet  (funded from the treasury)
#   loop      examples/testnet-loop    (mine is the node's job; this drives
#             quote -> settle -> honor forever)
#
# Then it watches the loop close at least MIN_HONORS settlements and prints a
# transcript. This is the same wiring the deploy/ kit lays down as systemd
# units, exercised locally first.
#
# Binaries (override via env): a TESTNET build of the node is required
#   (EXFER_TESTNET_OVERRIDE=1 cargo build --release --features testnet,allow-testnet-release).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Sibling repos resolve relative to this script; override any with *_BIN env.
SIBLINGS="$(cd "$SCRIPT_DIR/../../.." && pwd)"
EXFER="${EXFER_BIN:-/tmp/exfer-testnet-bin}"
WALLETD="${WALLETD_BIN:-$SIBLINGS/exfer-walletd/target/release/exfer-walletd}"
INDEXER="${INDEXER_BIN:-$SIBLINGS/exfer-indexer/target/release/exfer-indexer}"
for bin in "$EXFER" "$WALLETD" "$INDEXER"; do
  [ -x "$bin" ] || { echo "FATAL: missing binary $bin" >&2; exit 1; }
done

TESTNET_GENESIS=c35d676e284b06ee5ae089b8a9dceb6341ace7e6f4e43e859c2eeb6f4a5ad806
DEMO="${DEMO_DIR:-/tmp/exfer-testnet-loop}"
NODE_RPC=http://127.0.0.1:19534
INDEXER_RPC=http://127.0.0.1:19535
WALLETD_A=http://127.0.0.1:17451
WALLETD_B=http://127.0.0.1:17452
WALLETD_F=http://127.0.0.1:17453
FAUCET_URL=http://127.0.0.1:9810
LOOP_HTTP=http://127.0.0.1:9811
MIN_HONORS="${MIN_HONORS:-3}"

PIDS=()
cleanup() {
  for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  # npx/tsx fork a worker that outlives the captured subshell PID; the worker's
  # cmdline carries the absolute tsx path under each example, so reap by that.
  pkill -f "examples/testnet-loop/node_modules/tsx" 2>/dev/null || true
  pkill -f "examples/testnet-faucet/node_modules/tsx" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT
log() { printf '\n=== %s ===\n' "$*"; }

rpc() { # rpc <url> <token-or-"-"> <method> <params-json>
  local url=$1 token=$2 method=$3 params=${4:-null} auth=()
  [ "$token" != "-" ] && auth=(-H "Authorization: Bearer $token")
  curl -sS --max-time 30 "$url" -H 'content-type: application/json' "${auth[@]}" \
    -d "{\"jsonrpc\":\"2.0\",\"method\":\"$method\",\"params\":$params,\"id\":1}"
}
wait_rpc() { # wait_rpc <url> <name> <secs>
  local url=$1 name=$2 secs=${3:-30}
  for _ in $(seq 1 $((secs * 2))); do
    rpc "$url" - get_block_height 2>/dev/null | grep -q '"result"' && return 0
    curl -sS --max-time 2 "$url" -H 'content-type: application/json' \
      -d '{"jsonrpc":"2.0","method":"ping","params":null,"id":1}' >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  echo "FATAL: $name not up at $url" >&2; exit 1
}

rm -rf "$DEMO"
mkdir -p "$DEMO"/{node,indexer,wa,wb,wf,log,out}

# ------------------------------------------------------------- 1. testnet node
log "1/7 testnet node up — mining to treasury (real 2^252 PoW; ~60s zero-peer bootstrap)"
"$EXFER" mine --bind 127.0.0.1:19533 --datadir "$DEMO/node" --rpc-bind 127.0.0.1:19534 \
  --wallet "$DEMO/node/treasury.key" --create-wallet --no-encrypt --peers 127.0.0.1:19999 \
  >"$DEMO/log/node.log" 2>&1 &
PIDS+=($!)
wait_rpc "$NODE_RPC" "testnet node" 30
GENESIS=$(rpc "$NODE_RPC" - get_block_height | jq -r .result.genesis_block_id)
[ "$GENESIS" = "$TESTNET_GENESIS" ] || { echo "FATAL: genesis $GENESIS != testnet $TESTNET_GENESIS" >&2; exit 1; }
echo "genesis OK: $GENESIS"
# Note: the node logs to stdout, so isolate the JSON block before jq.
TREASURY_ADDR=$("$EXFER" wallet info --wallet "$DEMO/node/treasury.key" --json </dev/null 2>/dev/null | sed -n '/^{/,/^}/p' | jq -r .address)
echo "treasury: $TREASURY_ADDR"

echo "waiting for matured treasury balance (Live + >=11 blocks at maturity 10)…"
for _ in $(seq 1 180); do
  H=$(rpc "$NODE_RPC" - get_block_height | jq -r '.result.height // 0')
  BAL=$(rpc "$NODE_RPC" - get_balance "{\"address\":\"$TREASURY_ADDR\"}" | jq -r '.result.balance // 0')
  [ "${BAL:-0}" -gt 300000000 ] 2>/dev/null && break
  sleep 2
done
echo "treasury balance: $BAL exfers (height $H)"
[ "${BAL:-0}" -gt 300000000 ] 2>/dev/null || { echo "FATAL: treasury never funded" >&2; tail -20 "$DEMO/log/node.log"; exit 1; }

# ------------------------------------------------------------- 2. walletds
log "2/7 walletd A (payee) + B (payer) + F (faucet) + indexer"
start_walletd() { # start_walletd <dir> <bind> <pass>
  WALLETD_KEYSTORE_PASSPHRASE="$3" "$WALLETD" --datadir "$1" --bind "$2" \
    --node-rpc "$NODE_RPC" --indexer-rpc "$INDEXER_RPC" --expect-genesis "$GENESIS" \
    >"$DEMO/log/$(basename "$1").log" 2>&1 &
  PIDS+=($!)
}
start_walletd "$DEMO/wa" 127.0.0.1:17451 pass-a
start_walletd "$DEMO/wb" 127.0.0.1:17452 pass-b
start_walletd "$DEMO/wf" 127.0.0.1:17453 pass-f
"$INDEXER" --node-rpc "$NODE_RPC" --datadir "$DEMO/indexer" --bind 127.0.0.1:19535 --poll-secs 1 \
  >"$DEMO/log/indexer.log" 2>&1 &
PIDS+=($!)
wait_rpc "$WALLETD_A" "walletd A" 30
wait_rpc "$WALLETD_B" "walletd B" 30
wait_rpc "$WALLETD_F" "walletd F" 30
TOKEN_A=$(cat "$DEMO/wa/token-spend"); TOKEN_B=$(cat "$DEMO/wb/token-spend"); TOKEN_F=$(cat "$DEMO/wf/token-spend")

# ------------------------------------------------------------- 3. fund faucet
log "3/7 fund the faucet wallet from the treasury"
FAUCET_ADDR=$(rpc "$WALLETD_F" "$TOKEN_F" generate_standard_address '{}' | jq -r .result.address)
echo "faucet address: $FAUCET_ADDR"
SEND=$("$EXFER" wallet send --wallet "$DEMO/node/treasury.key" --to "$FAUCET_ADDR" \
  --amount "2 EXFER" --fee 100000 --rpc "$NODE_RPC" --json </dev/null 2>/dev/null | sed -n '/^{/,/^}/p')
echo "treasury->faucet: $(echo "$SEND" | jq -rc '{tx_id}' 2>/dev/null || echo "send-submitted")"
echo "waiting for faucet balance to confirm…"
for _ in $(seq 1 60); do
  FB=$(rpc "$WALLETD_F" "$TOKEN_F" get_balance "{\"address\":\"$FAUCET_ADDR\"}" | jq -r '.result.balance // 0')
  [ "${FB:-0}" -gt 0 ] 2>/dev/null && break
  sleep 2
done
echo "faucet balance: $FB exfers"
[ "${FB:-0}" -gt 0 ] 2>/dev/null || { echo "FATAL: faucet never funded" >&2; exit 1; }

# ------------------------------------------------------------- 4. faucet service
log "4/7 faucet service"
( cd "$SCRIPT_DIR/../testnet-faucet" &&
  FAUCET_WALLETD_URL="$WALLETD_F" FAUCET_WALLETD_TOKEN="$TOKEN_F" \
  FAUCET_FROM_ADDRESS="$FAUCET_ADDR" FAUCET_AMOUNT=100000 \
  FAUCET_HTTP_PORT=9810 FAUCET_DB="$DEMO/out/faucet.db" \
  FAUCET_ADDR_COOLDOWN_SECS=0 FAUCET_IP_COOLDOWN_SECS=0 \
  npx tsx faucet.ts ) >"$DEMO/log/faucet.log" 2>&1 &
PIDS+=($!)
for _ in $(seq 1 30); do curl -sS --max-time 2 "$FAUCET_URL/healthz" >/dev/null 2>&1 && break; sleep 0.5; done
echo "faucet health: $(curl -sS "$FAUCET_URL/healthz" | jq -c '{healthy,balance}')"

# ------------------------------------------------------------- 5. loop daemon
log "5/7 settlement loop daemon"
( cd "$SCRIPT_DIR" &&
  EXFER_NODE_URL="$NODE_RPC" EXFER_INDEXER_URL="$INDEXER_RPC" \
  WALLETD_A_URL="$WALLETD_A" WALLETD_A_TOKEN="$TOKEN_A" \
  WALLETD_B_URL="$WALLETD_B" WALLETD_B_TOKEN="$TOKEN_B" \
  FAUCET_URL="$FAUCET_URL" \
  LOOP_STATE_DB="$DEMO/out/loop.db" LOOP_INTERVAL_MS=3000 LOOP_HTTP_PORT=9811 \
  AMOUNT=1000 CONFIRMATION_DEPTH=6 POLL_MS=2000 \
  npx tsx loop.ts ) >"$DEMO/log/loop.log" 2>&1 &
PIDS+=($!)
for _ in $(seq 1 30); do curl -sS --max-time 2 "$LOOP_HTTP/healthz" >/dev/null 2>&1 && break; sleep 0.5; done

# ------------------------------------------------------------- 6. watch
log "6/7 watching the loop close $MIN_HONORS settlements"
HONORED=0
for _ in $(seq 1 150); do
  M=$(curl -sS --max-time 3 "$LOOP_HTTP/healthz" 2>/dev/null)
  HONORED=$(echo "$M" | jq -r '.honored // 0')
  FAILED=$(echo "$M" | jq -r '.failed // 0')
  HEIGHT=$(echo "$M" | jq -r '.height // 0')
  printf 'honored=%s failed=%s height=%s\n' "$HONORED" "$FAILED" "$HEIGHT"
  [ "${HONORED:-0}" -ge "$MIN_HONORS" ] 2>/dev/null && break
  sleep 4
done

# ------------------------------------------------------------- 7. transcript
log "7/7 transcript"
echo "loop /metrics:"; curl -sS "$LOOP_HTTP/metrics" | sed 's/^/  /'
echo "faucet /metrics:"; curl -sS "$FAUCET_URL/metrics" | sed 's/^/  /'
echo "loop log tail:"; tail -15 "$DEMO/log/loop.log" | sed 's/^/  /'
if [ "${HONORED:-0}" -ge "$MIN_HONORS" ]; then
  echo; echo "LOCAL TESTNET LOOP OK: closed $HONORED settlements on real PoW"
else
  echo; echo "LOCAL TESTNET LOOP FAILED: only $HONORED honored (need $MIN_HONORS)" >&2
  echo "--- node.log tail ---"; tail -15 "$DEMO/log/node.log"
  exit 1
fi
