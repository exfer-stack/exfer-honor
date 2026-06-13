# deploy — provision the exfer public testnet

Two seed nodes plus the autonomous economy (indexer + walletds + faucet +
settlement loop) on the primary seed. This is the same wiring that
[`../run-local-testnet.sh`](../run-local-testnet.sh) exercises on loopback,
expressed as systemd units. Provider-agnostic: it builds locally and configures
hosts over SSH, so it works with any VPS you can ssh into as root.

## ⚠ Sequencing gate

The testnet genesis is baked into the node binary by **PR #42**. Provisioning a
public testnet before #42 merges risks the genesis id changing under review,
which would strand a running network. So the host-touching commands refuse to
run until you assert the genesis is final:

```bash
TESTNET_GENESIS_FINAL=1 ./provision.sh create
```

`build`, `plan`, `dns`, and `status` never touch a host and are always safe.

## Topology

| host | role | services |
|------|------|----------|
| seed-1 (primary) | mining node | exfer-testnet-seed, indexer, walletd-a/b/f, faucet, loop |
| seed-2 (secondary) | relay node | exfer-testnet-node (peers with seed-1) |

Ports per host: `9333` p2p, `9334` rpc+sse. Primary also: faucet `9810`, loop
`9811` (bound to localhost — front with a reverse proxy to expose publicly).
Genesis (pinned): `c35d676e284b06ee5ae089b8a9dceb6341ace7e6f4e43e859c2eeb6f4a5ad806`.
A 2 vCPU / 4 GB VPS per host sustains the 2^252 PoW at the 10s target.

## Runbook

```bash
# 0. build locally (glibc matches the target hosts) + stage artifacts
./provision.sh build

# 1. see exactly what will happen, touch nothing
./provision.sh plan

# 2. once #42 is merged, create the instances (or create 2 VPS yourself)
TESTNET_GENESIS_FINAL=1 ./provision.sh create

# 3. configure each host (IPs from your provider)
TESTNET_GENESIS_FINAL=1 ./provision.sh setup <primary-ip>   primary
TESTNET_GENESIS_FINAL=1 PRIMARY_IP=<primary-ip> ./provision.sh setup <secondary-ip> secondary

# 4. publish DNS + bake fallback IPs into the node, then rebuild/redeploy
./provision.sh dns

# 5. sanity
./provision.sh status <primary-ip> <secondary-ip>
```

Instance creation is delegated to an optional `$CREATE_HOOK` (your provider's
CLI), kept out of this repo so no provider/account details are committed. Without
it, create two VPS yourself and run `setup` directly.

`setup primary` copies binaries + rsyncs this repo to `/opt/exfer-honor`, writes
`/etc/exfer-testnet/*.env`, starts node/indexer/walletds, then runs
[`bootstrap-primary.sh`](./bootstrap-primary.sh) on the host (funds the faucet
from the mined treasury, writes the faucet/loop env, enables both units).

## Files

- `provision.sh` — orchestrator (`build|plan|create|setup|dns|status`)
- `bootstrap-primary.sh` — one-shot faucet funding + faucet/loop enable, runs on the primary
- `systemd/` — unit files for every service

The testnet runs on its own hosts, fully separate from any existing mainnet
deployment.
