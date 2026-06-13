# testnet-loop — continuous autonomous settlement loop

The [`devnet-loop`](../devnet-loop) example proves the agent-to-agent loop
closes once on an isolated devnet. This is the same loop turned into a
**long-lived daemon** that runs forever against the **real persistent testnet**
(real Argon2id PoW at the 2^252 target — the seed node mines, this daemon does
not):

```
quote   Agent A (payee/seller) issues a signed EXFER-QUOTE      (walletd quote_issue)
honor   Agent A's gate registers it write-ahead and watches     (exfer-honor engine)
settle  Agent B (payer/buyer) verifies + pays, datum=quote_id   (walletd transfer)
deliver A's gate waits the depth, then delivers atomically       (§5 gate txn)
```

Coins circulate A↔B: when the buyer runs low it is refilled from the seller's
accumulated balance, and only when both are dry does it fall back to the faucet,
so the loop is self-sustaining and does not hammer the faucet.

Unlike the one-shot demo it is operational: it **persists identities and an
iteration ledger** in SQLite (a restart resumes the same A/B agents and
balances), **survives per-iteration errors** without crashing, exposes
**`/healthz` + `/metrics`** for systemd/monitoring, and **shuts down cleanly**
on SIGTERM/SIGINT.

## Run it locally (real testnet, one command)

`run-local-testnet.sh` stands up the whole stack on loopback against a real
testnet node and watches the loop close `MIN_HONORS` settlements:

```bash
# needs a TESTNET build of the node binary:
#   (cd ../../../exfer-testnet && EXFER_TESTNET_OVERRIDE=1 cargo build --release \
#      --features testnet,allow-testnet-release && cp target/release/exfer /tmp/exfer-testnet-bin)
npm install
MIN_HONORS=3 ./run-local-testnet.sh
```

Proven run: 3/3 settlements honored on real PoW, honor latency ~8–13s at
confirmation depth 6 (~2.5s blocks), 0 failures.

## Configuration (env)

| var | default | meaning |
|-----|---------|---------|
| `EXFER_NODE_URL` | — | testnet node JSON-RPC (tip/depth) |
| `EXFER_INDEXER_URL` | — | exfer-indexer (settlement reverse lookup) |
| `WALLETD_A_URL` / `WALLETD_A_TOKEN` | — | payee/seller walletd + spend token |
| `WALLETD_B_URL` / `WALLETD_B_TOKEN` | — | payer/buyer walletd + spend token |
| `FAUCET_URL` | (none) | optional faucet for bootstrap/last-resort buyer funding |
| `LOOP_STATE_DB` | `./testnet-loop.db` | identities + ledger + honor gate |
| `LOOP_INTERVAL_MS` | `15000` | pause between completed iterations |
| `LOOP_HTTP_PORT` | `9799` | `/healthz` + `/metrics` bind |
| `AMOUNT` | `1000` | exfers per settlement |
| `REFILL_MULTIPLE` | `20` | when buyer low, refill `REFILL_MULTIPLE × AMOUNT` |
| `CONFIRMATION_DEPTH` | `6` | honor depth gate |
| `POLL_MS` | `2000` | honor observe→honor tick |

## Endpoints

- `GET /healthz` → `{healthy, iterations, honored, failed, height, payerBalance, …}`
- `GET /metrics` → Prometheus text (`exfer_loop_honored_total`, `…_last_honor_latency_ms`, …)

## Deploy

See [`deploy/`](./deploy) for the provider-agnostic provisioning kit (systemd
units + `provision.sh`) that lays this stack down on two public seed nodes.
