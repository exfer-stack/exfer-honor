# mainnet-loop — two AI agents settle a service, on mainnet, for real EXFER

This is the [devnet-loop](../devnet-loop) demo run for keeps: the **same** closed
loop, but against the **live Exfer mainnet** — real public node, real indexer,
real on-chain payment, real atomic delivery — no per-transaction approval, no
escrow operator, no human releasing the goods. (The buyer's wallet is pre-funded
once; in production an agent can even mine its own starting EXFER.)

```
  Agent A (seller)                         Agent B (buyer)
  ───────────────                          ──────────────
  quote_issue ───────── signed EXFER-QUOTE ──────────▶ quote_verify  ✔
                                                            │
                                          transfer (datum = quote_id)
                                                            ▼
                                                   ┌──────────────┐
                                                   │   MAINNET    │  0.05 EXFER
                                                   └──────┬───────┘
  honor gate                                             │
   ├ indexer reverse-lookup (quote_id → settlement) ◀────┘
   ├ wait confirmation depth
   └ DELIVER goods — atomically, inside the §5 gate transaction ✅
```

The buyer pays only because a signed quote bound the price; the seller delivers
only because the chain proved the payment to depth. Neither trusts the other and
no escrow operator sits in the middle — the quote signature and the on-chain
`datum=quote_id` binding are the whole trust model.

## Proven on mainnet (2026-06-17)

A full loop closed end to end on the live chain (genesis
`d7b6805c8fd793703db88102b5aed2600af510b79e3cb340ca72c1f762d1e051`):

| | |
|---|---|
| quote_id | `3a82e9501eb6a2f53c6de047537f9642` |
| settlement tx | `ac1d0d674af68de75f3762f674859ca0e9842dde88719ffe75d8601943c599d6` |
| amount | 0.05 EXFER (real) |
| honor outcome | `"honored"` — goods delivered inside the atomic gate txn |

The honor gate resolves the settlement through the indexer's
`find_settlements_by_quote_id` (the EXFER-QUOTE datum reverse-lookup, indexer
≥ 0.3.0).

## Run it

Needs sibling release builds of `exfer-walletd` (and the deps in
[`../devnet-loop`](../devnet-loop) for the honor driver). It stands up **two
fresh loopback walletd instances** (A = payee, B = payer) pinned to mainnet
genesis — it never touches your real wallets.

```bash
./run-mainnet.sh
```

The script pauses at step 3 and prints Agent B's address: send it a little EXFER
(default settles 0.05, so ≥ 0.06 covers fee headroom). It polls every 5s and
continues the moment the funds land, then issues the quote, settles on-chain, and
waits for the honor gate to deliver. State lives under `/tmp/exfer-mainnet-loop`,
so a re-run reuses the same agents (and any leftover B balance).

Knobs (env): `NODE_RPC`, `INDEXER_RPC` (default the Seoul public reference),
`SETTLE_EXFERS` (default `5000000` = 0.05 EXFER), `FEE_RATE`, `CONFIRM_SECS`.

### honor-replay.sh

If a settlement is already on-chain (e.g. the watcher crashed mid-run) and its
quote is **still within TTL**, `honor-replay.sh` re-runs only the honor gate
against the saved quote — it finds the settlement and delivers **without a new
payment**. A quote past its TTL is refused (`quote has expired`) by design; in
that case re-run the full `run-mainnet.sh` instead.
