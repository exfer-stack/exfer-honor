#!/usr/bin/env bash
# provision.sh — stand up the exfer public testnet: two seed nodes plus the
# autonomous economy (indexer + walletds + faucet + settlement loop) on the
# primary seed. Provider-agnostic: it builds locally and configures hosts over
# SSH, so it works with any VPS you can ssh into as root.
#
# SEQUENCING GUARD: the testnet genesis is baked into the node binary by
# PR #42. Standing up a PUBLIC testnet before #42 merges risks the genesis id
# changing under review, which would strand a running network. So the
# host-touching commands (`create`, `setup`, `up`) refuse to run until you
# assert the genesis is final with TESTNET_GENESIS_FINAL=1. `build` and `plan`
# are always safe and never touch any host.
#
# Usage:
#   ./provision.sh build           # build node testnet binary + npm ci the TS services (local)
#   ./provision.sh plan            # print the provisioning plan, touch nothing (default)
#   ./provision.sh create          # create the 2 instances (via $CREATE_HOOK, if set)  [gated]
#   ./provision.sh setup <ip> primary | secondary   # configure a host over ssh          [gated]
#   ./provision.sh dns             # print DNS + TESTNET_FALLBACK_SEEDS to bake into the node
#   ./provision.sh status <ip>...  # query seeds' RPC height/genesis
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HONOR_REPO="${EXFER_HONOR_REPO:-$(cd "$SCRIPT_DIR/../../.." && pwd)}"
NODE_REPO="${EXFER_NODE_REPO:-$HONOR_REPO/../exfer-testnet}"
WALLETD_REPO="${EXFER_WALLETD_REPO:-$HONOR_REPO/../exfer-walletd}"
INDEXER_REPO="${EXFER_INDEXER_REPO:-$HONOR_REPO/../exfer-indexer}"
SSH_KEY="${EXFER_SSH_KEY:-$HOME/.ssh/id_ed25519}"

# Instance sizing is guidance, not provider config: a 2 vCPU / 4 GB VPS sustains
# the 2^252 PoW at the 10s target. Instance creation is delegated to $CREATE_HOOK
# (your provider's CLI), kept out of this repo so no operational details leak.
DOMAIN="${TESTNET_DNS:-testnet-seed.exfer.org}"
LABEL_PRIMARY="exfer-testnet-seed-1"
LABEL_SECONDARY="exfer-testnet-seed-2"

STAGE="${EXFER_STAGE_DIR:-/tmp/exfer-testnet-artifacts}"
TESTNET_GENESIS=c35d676e284b06ee5ae089b8a9dceb6341ace7e6f4e43e859c2eeb6f4a5ad806
SSH_OPTS=(-i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15)

log() { printf '\n=== %s ===\n' "$*"; }
die() { echo "FATAL: $*" >&2; exit 1; }

gate() {
  [ "${TESTNET_GENESIS_FINAL:-0}" = "1" ] || die \
    "refusing to provision: testnet genesis not asserted final (PR #42 not merged). \
Re-run with TESTNET_GENESIS_FINAL=1 once the genesis is locked."
}

# ------------------------------------------------------------------ build
cmd_build() {
  log "build: node testnet release binary"
  ( cd "$NODE_REPO" && EXFER_TESTNET_OVERRIDE=1 cargo build --release \
      --features "testnet,allow-testnet-release" )
  log "build: walletd + indexer release binaries"
  ( cd "$WALLETD_REPO" && cargo build --release )
  ( cd "$INDEXER_REPO" && cargo build --release )

  log "build: stage artifacts -> $STAGE"
  rm -rf "$STAGE"; mkdir -p "$STAGE/bin"
  cp "$NODE_REPO/target/release/exfer" "$STAGE/bin/exfer-testnet"
  cp "$WALLETD_REPO/target/release/exfer-walletd" "$STAGE/bin/exfer-walletd"
  cp "$INDEXER_REPO/target/release/exfer-indexer" "$STAGE/bin/exfer-indexer"
  log "build: install TS service deps (faucet + loop)"
  ( cd "$HONOR_REPO/examples/testnet-faucet" && { npm ci --no-audit --no-fund 2>/dev/null || npm install --no-audit --no-fund; } )
  ( cd "$HONOR_REPO/examples/testnet-loop" && { npm ci --no-audit --no-fund 2>/dev/null || npm install --no-audit --no-fund; } )
  echo "artifacts staged at $STAGE (genesis pinned: $TESTNET_GENESIS)"
}

# ------------------------------------------------------------------ plan
cmd_plan() {
  cat <<EOF

exfer public testnet provisioning plan
======================================
Instances         : 2 × small VPS (2 vCPU / 4 GB sustains 2^252 PoW at 10s blocks)
Primary seed      : $LABEL_PRIMARY
                    role: mining node + indexer + walletd-a/b/f + faucet + loop
Secondary seed    : $LABEL_SECONDARY
                    role: relay node, peers with primary
DNS               : $DOMAIN -> round-robin A records to both seed IPs
Ports (per host)  : 9333 p2p, 9334 rpc+sse  | faucet 9810, loop 9811 (primary)
Genesis (pinned)  : $TESTNET_GENESIS
Binaries          : built local (glibc match) -> /usr/local/bin on each host
Units             : $(ls "$SCRIPT_DIR/systemd" | tr '\n' ' ')

Gate              : create/setup require TESTNET_GENESIS_FINAL=1 (currently ${TESTNET_GENESIS_FINAL:-0})

Steps once gated:
  1. ./provision.sh build
  2. TESTNET_GENESIS_FINAL=1 ./provision.sh create        # or create 2 VPS yourself
  3. TESTNET_GENESIS_FINAL=1 ./provision.sh setup <primary-ip> primary
  4. TESTNET_GENESIS_FINAL=1 PRIMARY_IP=<primary-ip> ./provision.sh setup <secondary-ip> secondary
  5. ./provision.sh dns          # publish DNS + bake fallback IPs into the node, rebuild, redeploy
EOF
}

# ------------------------------------------------------------------ create
cmd_create() {
  gate
  if [ -n "${CREATE_HOOK:-}" ]; then
    log "create: delegating to \$CREATE_HOOK"
    CREATE_LABEL_PRIMARY="$LABEL_PRIMARY" CREATE_LABEL_SECONDARY="$LABEL_SECONDARY" \
      bash -c "$CREATE_HOOK"
  else
    cat <<EOF
No \$CREATE_HOOK set. Create two VPS instances (2 vCPU / 4 GB, Ubuntu, your
SSH key authorized for root) with your provider, then:
  TESTNET_GENESIS_FINAL=1 ./provision.sh setup <primary-ip> primary
  TESTNET_GENESIS_FINAL=1 PRIMARY_IP=<primary-ip> ./provision.sh setup <secondary-ip> secondary
Or export CREATE_HOOK='<your provider CLI create commands>' and re-run create.
EOF
  fi
}

# ------------------------------------------------------------------ setup
# setup <ip> <primary|secondary>
cmd_setup() {
  gate
  local ip=$1 role=${2:?role required: primary|secondary}
  [ -d "$STAGE/bin" ] || die "no staged artifacts; run ./provision.sh build first"
  local host="root@$ip"

  log "setup($role): base packages + exfer user"
  ssh "${SSH_OPTS[@]}" "$host" 'bash -s' <<'REMOTE'
set -euo pipefail
id exfer >/dev/null 2>&1 || useradd -m -s /bin/bash exfer
mkdir -p /etc/exfer-testnet /var/lib/exfer-testnet /opt/exfer-honor
which node >/dev/null 2>&1 || { curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs; }
chown -R exfer:exfer /var/lib/exfer-testnet
REMOTE

  log "setup($role): copy binaries"
  scp "${SSH_OPTS[@]}" "$STAGE/bin/"* "$host:/usr/local/bin/"
  ssh "${SSH_OPTS[@]}" "$host" 'chmod +x /usr/local/bin/exfer-testnet /usr/local/bin/exfer-walletd /usr/local/bin/exfer-indexer'

  log "setup($role): install systemd units"
  scp "${SSH_OPTS[@]}" "$SCRIPT_DIR/systemd/"*.service "$host:/etc/systemd/system/"

  if [ "$role" = "secondary" ]; then
    cat >"$STAGE/node.env" <<EOF
BIND=0.0.0.0:9333
RPC_BIND=127.0.0.1:9334
DATADIR=/var/lib/exfer-testnet/node
PEERS=${PRIMARY_IP:?set PRIMARY_IP for the secondary}:9333
EOF
    scp "${SSH_OPTS[@]}" "$STAGE/node.env" "$host:/etc/exfer-testnet/node.env"
    ssh "${SSH_OPTS[@]}" "$host" 'systemctl daemon-reload && systemctl enable --now exfer-testnet-node.service'
    echo "secondary seed up at $ip (peering with ${PRIMARY_IP})"
    return
  fi

  # ---- primary: the full economy ----
  log "setup(primary): rsync exfer-honor TS services"
  rsync -az -e "ssh ${SSH_OPTS[*]}" --delete \
    --exclude .git --exclude 'examples/*/node_modules/.cache' \
    "$HONOR_REPO/" "$host:/opt/exfer-honor/"
  ssh "${SSH_OPTS[@]}" "$host" 'chown -R exfer:exfer /opt/exfer-honor'

  log "setup(primary): write env files"
  # The node mines to a treasury wallet; the faucet is funded from it during the
  # one-shot bootstrap below.
  cat >"$STAGE/seed.env" <<EOF
BIND=0.0.0.0:9333
RPC_BIND=127.0.0.1:9334
DATADIR=/var/lib/exfer-testnet/node
WALLET=/var/lib/exfer-testnet/treasury.key
EXTRA_ARGS=--create-wallet --no-encrypt
EOF
  cat >"$STAGE/indexer.env" <<EOF
NODE_RPC=http://127.0.0.1:9334
DATADIR=/var/lib/exfer-testnet/indexer
BIND=127.0.0.1:9335
POLL_SECS=1
EOF
  for inst in a b f; do
    cat >"$STAGE/walletd-$inst.env" <<EOF
DATADIR=/var/lib/exfer-testnet/walletd-$inst
BIND=127.0.0.1:1745$([ "$inst" = a ] && echo 1 || { [ "$inst" = b ] && echo 2 || echo 3; })
NODE_RPC=http://127.0.0.1:9334
INDEXER_RPC=http://127.0.0.1:9335
EXPECT_GENESIS=$TESTNET_GENESIS
WALLETD_KEYSTORE_PASSPHRASE=$(openssl rand -hex 16)
EOF
  done
  scp "${SSH_OPTS[@]}" "$STAGE/seed.env" "$STAGE/indexer.env" "$STAGE"/walletd-*.env \
    "$host:/etc/exfer-testnet/"

  log "setup(primary): start node + indexer + walletds"
  ssh "${SSH_OPTS[@]}" "$host" 'systemctl daemon-reload && \
    systemctl enable --now exfer-testnet-seed.service && \
    systemctl enable --now exfer-indexer.service && \
    systemctl enable --now exfer-walletd@a.service exfer-walletd@b.service exfer-walletd@f.service'

  log "setup(primary): one-shot faucet funding + faucet/loop env + start"
  scp "${SSH_OPTS[@]}" "$SCRIPT_DIR/bootstrap-primary.sh" "$host:/opt/exfer-honor/bootstrap-primary.sh"
  ssh "${SSH_OPTS[@]}" "$host" "TESTNET_GENESIS=$TESTNET_GENESIS bash /opt/exfer-honor/bootstrap-primary.sh"
  echo "primary seed economy up at $ip (faucet :9810, loop :9811 bound to localhost — front with a reverse proxy to expose)"
}

# ------------------------------------------------------------------ dns / status
cmd_dns() {
  cat <<EOF
Publish round-robin A records:
  $DOMAIN.  A  <primary-ip>
  $DOMAIN.  A  <secondary-ip>

Then bake the real IPs into the node and rebuild/redeploy so fresh nodes have a
fallback if DNS is unavailable:
  src/main.rs  TESTNET_FALLBACK_SEEDS = &["<primary-ip>:9333", "<secondary-ip>:9333"];
(currently the placeholder 127.0.0.1:9333). Until then, operators can join with
an explicit --peers <primary-ip>:9333.
EOF
}

cmd_status() {
  local ip
  for ip in "$@"; do
    echo -n "$ip: "
    curl -sS --max-time 5 "http://$ip:9334" -H 'content-type: application/json' \
      -d '{"jsonrpc":"2.0","method":"get_block_height","params":null,"id":1}' \
      | jq -c '.result | {height, genesis_block_id}' 2>/dev/null || echo "unreachable (rpc may be localhost-only)"
  done
}

case "${1:-plan}" in
  build)  cmd_build ;;
  plan)   cmd_plan ;;
  create) cmd_create ;;
  setup)  shift; cmd_setup "$@" ;;
  dns)    cmd_dns ;;
  status) shift; cmd_status "$@" ;;
  *)      die "unknown command '$1' (build|plan|create|setup|dns|status)" ;;
esac
