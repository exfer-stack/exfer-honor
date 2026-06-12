# devnet-loop — agent-to-agent closed loop on devnet

`npm install && npm run demo` proves the sovereign loop end to end on an
isolated local chain, with the real stack at every step — no fakes:

| step | actor | what happens |
|---|---|---|
| mine | Agent B (payer) | `exfer devnet --miner-pubkey <B>` mines B's balance (coinbase spendable after 1 block) |
| quote | Agent A (payee) | walletd `quote_issue` signs an EXFER-QUOTE, genesis-bound to the devnet via node PR #33 |
| settle | Agent B | walletd `quote_verify`, then `transfer` with `datum = quote_id` (strict 16-byte binding) |
| honor | Agent A | `@exfer/honor` real engine: ACCEPT (walletd `quote_verify`) → register (R6 write-ahead) → indexer `find_settlements_by_quote_id` → R4 address+amount bind → depth ≥ 6 → §5 atomic gate + deliver |

## First successful run (2026-06-12)

```
genesis:        3db3507a7fce80bbbcafcc9115a71c3742c812770892c568eeec63723ce9def7
payer (B):      0bc7b49dba27bee77e3a9e01f125a50884225cb140e60ccc26e594a1fd772d98  mined balance: 39999919507
payee (A):      4616d02e83568afc753cc0418993fd97c96aaebb5bf09e4cdf0a32a6bb59f4c1
quote_id:       145ac8482c373d73fdd8fb655a4ee18e  amount: 3999991950
settlement tx:  f4578a007d693c71d7e45920b49a611d4100110ac3d698016fc59dd25eddadd0
honor outcome:  honored @ outpoint f4578a00…:0 — deliver ran inside the §5 gate txn
LOOP CLOSED: mine → quote → settle → honor ✅
```

## Prerequisites

Three sibling binaries, paths overridable via `EXFER_BIN` / `WALLETD_BIN` /
`INDEXER_BIN` (defaults in `run-demo.sh`):

- **exfer node** at upstream `main` (≥ PR #33/#34), built with
  `EXFER_TESTNET_OVERRIDE=1 cargo build --release --features testnet,allow-testnet-release`
  (the `devnet` subcommand needs trivial difficulty).
- **exfer-walletd** ≥ the `--expect-genesis` change (binds the process
  signature domain to the operator-named genesis at startup; without it
  transfers sign in the canonical mainnet domain and the devnet node rejects
  them with `SignatureInvalid`).
- **exfer-indexer** v0.3.0 release build.

The payee driver is `driver.ts`: it injects the REAL EXFER-ADDR derivation
into `createHonorService` — the library default is a structural placeholder
that declines every real settlement with `address_mismatch`.

## Gaps this demo surfaced (each was a real fix)

1. **walletd signed in the wrong domain on non-canonical chains** — fixed by
   `--expect-genesis` + `exfer::genesis::bind_signature_domain` at startup
   (verify the node-reported genesis against the operator's expectation, bind
   the verified id, refuse on mismatch). Dep bumped to upstream `acaf9b3`.
2. **honor façade had no way to inject the real address deriver** —
   `createHonorService` now forwards `addressDeriver` into both the forms'
   HonorConfig (R4 binding) and the walletd KeyCustody adapter.
3. **upstream `#[non_exhaustive]` on `HtlcState`/`HtlcRole`** — walletd's
   redb index byte-mapping needed wildcard arms.

Logs land in `/tmp/exfer-loop-demo/log/`, artifacts in `/tmp/exfer-loop-demo/out/`.
