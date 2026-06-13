#!/usr/bin/env bash
# bootstrap-primary.sh — runs ON the primary seed host, once, after the node +
# indexer + walletd-a/b/f units are up. It funds the faucet wallet from the
# mined treasury, writes the faucet/loop env files, installs their npm deps, and
# enables the faucet + loop units. Idempotent-ish: safe to re-run (it tops the
# faucet up again and rewrites env).
#
# Expects (from provision.sh setup): node rpc on 127.0.0.1:9334, walletds on
# 1745{1,2,3}, indexer on 9335, the testnet binary at /usr/local/bin/exfer-testnet,
# and TESTNET_GENESIS in the environment.
set -euo pipefail

GENESIS="${TESTNET_GENESIS:?TESTNET_GENESIS required}"
NODE_RPC=http://127.0.0.1:9334
INDEXER_RPC=http://127.0.0.1:9335
WALLETD_A=http://127.0.0.1:17451
WALLETD_B=http://127.0.0.1:17452
WALLETD_F=http://127.0.0.1:17453
TREASURY=/var/lib/exfer-testnet/treasury.key
HONOR=/opt/exfer-honor
FAUCET_FUND="${FAUCET_FUND:-50 EXFER}"

rpc() { # rpc <url> <token-or-"-"> <method> <params>
  local url=$1 token=$2 method=$3 params=${4:-null} auth=()
  [ "$token" != "-" ] && auth=(-H "Authorization: Bearer $token")
  curl -sS --max-time 30 "$url" -H 'content-type: application/json' "${auth[@]}" \
    -d "{\"jsonrpc\":\"2.0\",\"method\":\"$method\",\"params\":$params,\"id\":1}"
}
json_only() { sed -n '/^{/,/^}/p'; }  # node logs to stdout; isolate JSON

echo "waiting for matured treasury balance…"
TREASURY_ADDR=$(/usr/local/bin/exfer-testnet wallet info --wallet "$TREASURY" --json </dev/null 2>/dev/null | json_only | jq -r .address)
for _ in $(seq 1 240); do
  BAL=$(rpc "$NODE_RPC" - get_balance "{\"address\":\"$TREASURY_ADDR\"}" | jq -r '.result.balance // 0')
  [ "${BAL:-0}" -gt 5000000000 ] 2>/dev/null && break
  sleep 2
done
echo "treasury $TREASURY_ADDR balance=$BAL"

TOKEN_A=$(cat /var/lib/exfer-testnet/walletd-a/token-spend)
TOKEN_B=$(cat /var/lib/exfer-testnet/walletd-b/token-spend)
TOKEN_F=$(cat /var/lib/exfer-testnet/walletd-f/token-spend)
FAUCET_ADDR=$(rpc "$WALLETD_F" "$TOKEN_F" generate_standard_address '{}' | jq -r .result.address)
echo "faucet address: $FAUCET_ADDR"

echo "funding faucet ($FAUCET_FUND)…"
/usr/local/bin/exfer-testnet wallet send --wallet "$TREASURY" --to "$FAUCET_ADDR" \
  --amount "$FAUCET_FUND" --fee 100000 --rpc "$NODE_RPC" --json </dev/null 2>/dev/null | json_only | jq -rc '{tx_id}' || true
for _ in $(seq 1 60); do
  FB=$(rpc "$WALLETD_F" "$TOKEN_F" get_balance "{\"address\":\"$FAUCET_ADDR\"}" | jq -r '.result.balance // 0')
  [ "${FB:-0}" -gt 0 ] 2>/dev/null && break
  sleep 2
done
echo "faucet balance: $FB"

echo "writing faucet.env + loop.env"
cat >/etc/exfer-testnet/faucet.env <<EOF
FAUCET_WALLETD_URL=$WALLETD_F
FAUCET_WALLETD_TOKEN=$TOKEN_F
FAUCET_FROM_ADDRESS=$FAUCET_ADDR
FAUCET_AMOUNT=100000
FAUCET_HTTP_PORT=9810
FAUCET_DB=/var/lib/exfer-testnet/faucet.db
FAUCET_ADDR_COOLDOWN_SECS=3600
FAUCET_IP_COOLDOWN_SECS=60
FAUCET_DAILY_BUDGET=0
EOF
cat >/etc/exfer-testnet/loop.env <<EOF
EXFER_NODE_URL=$NODE_RPC
EXFER_INDEXER_URL=$INDEXER_RPC
WALLETD_A_URL=$WALLETD_A
WALLETD_A_TOKEN=$TOKEN_A
WALLETD_B_URL=$WALLETD_B
WALLETD_B_TOKEN=$TOKEN_B
FAUCET_URL=http://127.0.0.1:9810
LOOP_STATE_DB=/var/lib/exfer-testnet/loop.db
LOOP_INTERVAL_MS=15000
LOOP_HTTP_PORT=9811
AMOUNT=1000
CONFIRMATION_DEPTH=6
POLL_MS=2000
EOF
chmod 600 /etc/exfer-testnet/faucet.env /etc/exfer-testnet/loop.env
chown exfer:exfer /var/lib/exfer-testnet

echo "installing npm deps for faucet + loop"
( cd "$HONOR/examples/testnet-faucet" && npm ci --no-audit --no-fund 2>/dev/null || npm install --no-audit --no-fund )
( cd "$HONOR/examples/testnet-loop" && npm ci --no-audit --no-fund 2>/dev/null || npm install --no-audit --no-fund )

echo "enabling faucet + loop units"
systemctl daemon-reload
systemctl enable --now exfer-testnet-faucet.service
systemctl enable --now exfer-testnet-loop.service
echo "primary economy bootstrapped."
