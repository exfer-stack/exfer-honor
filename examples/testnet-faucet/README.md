# testnet-faucet — thin HTTP faucet for the exfer testnet

The exfer node RPC is query + broadcast only (no server-side signing), so the
faucet reuses **walletd** as the signing engine: on request it calls walletd
`transfer` from a funded faucet address. The faucet wallet is funded by the seed
node mining to it (coins mature in the testnet's 10-block maturity).

Testnet coins are valueless, so there is no custodial risk — the rate limiting
exists only to stop one client from draining the wallet: a per-address cooldown,
a per-IP cooldown, and an optional hard daily budget, all in SQLite so they
survive a restart.

## Endpoints

```
POST /faucet  {"address":"<64-hex>"}  -> {"tx_id":"...","amount":N}
GET  /healthz                          -> {"healthy":bool,"balance":N,...}
GET  /metrics                          -> Prometheus text
```

## Configuration (env)

| var | default | meaning |
|-----|---------|---------|
| `FAUCET_WALLETD_URL` | — | walletd holding the funded faucet wallet |
| `FAUCET_WALLETD_TOKEN` | — | walletd spend-scope bearer token |
| `FAUCET_FROM_ADDRESS` | — | funded faucet address (64-hex) to spend from |
| `FAUCET_AMOUNT` | `100000` | exfers per drip |
| `FAUCET_HTTP_PORT` | `9800` | bind port |
| `FAUCET_DB` | `./faucet.db` | rate-limit ledger |
| `FAUCET_ADDR_COOLDOWN_SECS` | `3600` | per-address cooldown |
| `FAUCET_IP_COOLDOWN_SECS` | `60` | per-IP cooldown (honors `X-Forwarded-For`) |
| `FAUCET_DAILY_BUDGET` | `0` (unlimited) | max exfers per rolling 24h |

## Run

```bash
npm install
FAUCET_WALLETD_URL=http://127.0.0.1:17453 \
FAUCET_WALLETD_TOKEN=$(cat /path/walletd-f/token-spend) \
FAUCET_FROM_ADDRESS=<faucet-addr> \
npm run faucet
```

Exercised end-to-end by [`../testnet-loop/run-local-testnet.sh`](../testnet-loop/run-local-testnet.sh).
