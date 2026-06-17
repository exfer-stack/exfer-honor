#!/usr/bin/env bash
# Honor-only replay: the settlement (tx 91358987…, quote_id 669dbbb1…) is ALREADY
# on mainnet. After the Seoul indexer finishes backfilling its datum index, this
# brings Agent A's walletd back up and runs the REAL honor gate over the SAVED
# quote — it finds the on-chain settlement via the indexer, confirms depth, and
# delivers. No new payment. Idempotent: re-runnable.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SIBLINGS="$(cd "$SCRIPT_DIR/../../.." && pwd)"
WALLETD="${WALLETD_BIN:-$SIBLINGS/exfer-walletd/target/release/exfer-walletd}"
DRIVER_DIR="$SCRIPT_DIR/../devnet-loop"
DEMO="${DEMO_DIR:-/tmp/exfer-mainnet-loop}"
NODE_RPC="${NODE_RPC:-http://64.176.231.198:9334}"
INDEXER_RPC="${INDEXER_RPC:-http://64.176.231.198:9335}"
WALLETD_A=http://127.0.0.1:27449
PASS_A="${PASS_A:-mainnet-demo-pass-a}"
SETTLE_HEIGHT="${SETTLE_HEIGHT:-826052}"   # block the settlement landed in
QUOTE_ID="$(jq -r .quote_id "$DEMO/out/quote.json")"

PIDS=(); cleanup(){ for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; wait 2>/dev/null||true; }
trap cleanup EXIT
log(){ printf '\n=== %s ===\n' "$*"; }
jrpc(){ curl -sS --max-time 15 "$1" -H 'content-type: application/json' -d "$2"; }

# 1. wait for the indexer datum backfill to reach the settlement, then confirm
#    the reverse-lookup actually returns it.
log "1/3 wait for Seoul indexer datum backfill to cover height $SETTLE_HEIGHT"
# The indexer is under load during the from-genesis rescan and intermittently
# drops connections (curl 52/28). Tolerate every transient failure — only the
# steady signal (reverse-lookup HIT, or full_scan_complete) ends the wait.
set +e
for _ in $(seq 1 7200); do
  ST=$(jrpc "$INDEXER_RPC" '{"jsonrpc":"2.0","method":"get_indexer_status","params":null,"id":1}' 2>/dev/null)
  H=$(echo "$ST" | jq -r '.result.last_indexed_height // 0' 2>/dev/null); H=${H:-0}
  DONE=$(echo "$ST" | jq -r '.result.full_scan_complete // false' 2>/dev/null); DONE=${DONE:-false}
  FOUND=$(jrpc "$INDEXER_RPC" "{\"jsonrpc\":\"2.0\",\"method\":\"find_settlements_by_quote_id\",\"params\":{\"quote_id\":\"$QUOTE_ID\"},\"id\":1}" 2>/dev/null \
    | jq -r '.result.settlements | length' 2>/dev/null); FOUND=${FOUND:-0}
  printf '\r  indexed height=%s full_scan=%s settlements_found=%s   ' "$H" "$DONE" "$FOUND"
  if [ "${FOUND:-0}" -ge 1 ] 2>/dev/null; then
    SETTLE_TX=$(jrpc "$INDEXER_RPC" "{\"jsonrpc\":\"2.0\",\"method\":\"find_settlements_by_quote_id\",\"params\":{\"quote_id\":\"$QUOTE_ID\"},\"id\":1}" 2>/dev/null \
      | jq -r '.result.settlements[0].tx_id // "unknown"')
    echo; echo "  reverse-lookup HIT for quote $QUOTE_ID → settlement $SETTLE_TX"; break
  fi
  if [ "$DONE" = "true" ] && [ "${FOUND:-0}" -eq 0 ] 2>/dev/null; then echo; echo "FATAL: full scan complete but quote not indexed" >&2; exit 1; fi
  sleep 5
done
set -e

# 2. bring Agent A's walletd back up (mainnet node + the updated Seoul indexer)
log "2/3 start Agent A walletd (mainnet, updated indexer)"
GENESIS=$(jrpc "$NODE_RPC" '{"jsonrpc":"2.0","method":"get_block_height","params":null,"id":1}' | jq -r .result.genesis_block_id)
WALLETD_KEYSTORE_PASSPHRASE="$PASS_A" "$WALLETD" --datadir "$DEMO/walletd-a" --bind 127.0.0.1:27449 \
  --node-rpc "$NODE_RPC" --indexer-rpc "$INDEXER_RPC" --expect-genesis "$GENESIS" \
  >"$DEMO/log/walletd-a-replay.log" 2>&1 & PIDS+=($!)
for _ in $(seq 1 60); do
  jrpc "$WALLETD_A" '{"jsonrpc":"2.0","method":"ping","params":null,"id":1}' >/dev/null 2>&1 && break; sleep 0.5
done
TOKEN_A=$(cat "$DEMO/walletd-a/token-spend")

# 3. run the REAL honor gate over the saved quote
log "3/3 HONOR — gate observes the on-chain settlement and delivers"
rm -f "$DEMO/out/gate-replay.db"
set +e
( cd "$DRIVER_DIR"
  EXFER_WALLETD_URL="$WALLETD_A" EXFER_INDEXER_URL="$INDEXER_RPC" EXFER_NODE_URL="$NODE_RPC" \
  WALLETD_TOKEN="$TOKEN_A" QUOTE_JSON_PATH="$DEMO/out/quote.json" \
  GATE_DB_PATH="$DEMO/out/gate-replay.db" POLL_MS=2000 npx tsx driver.ts )
HX=$?
set -e

echo; echo "──────────────── mainnet honor replay ────────────────"
echo "quote_id:      $QUOTE_ID"
echo "settlement tx: ${SETTLE_TX:-<from indexer reverse-lookup>}"
echo "deliveries row:"; sqlite3 "$DEMO/out/gate-replay.db" 'select quote_id, delivered_at, note from deliveries' 2>/dev/null | sed 's/^/  /' || true
echo "──────────────────────────────────────────────────────"
[ "$HX" -eq 0 ] && echo "HONOR CLOSED ON MAINNET ✅" || { echo "HONOR replay exit $HX" >&2; exit "$HX"; }
