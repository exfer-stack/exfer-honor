# exfer-honor — autonomous-agent ↔ pay-per-call API example

A complete, **zero-infra** reference for integrating `exfer-honor` into a
**pay-per-call API service** that sells metered access to an **autonomous AI
agent**. The agent holds an `exfer-mcp` wallet and settles on its own — no human
in the loop, no credit card, no account signup. It is quoted a price in **USD**,
pays the bound **EXFER** amount, and on honor the API service issues it an
`api_key` carrying a balance of **N prepaid calls (credits)**.

It doubles as an end-to-end validation of the public API and the safety
behaviours (atomic gate + deliver, single-honor, depth-wait, expiry).

The integration code (`merchant.ts`) is **identical in demo mode and in real
mode** — only how the `HonorService` is constructed differs (`service.ts`).

---

## The ~10-line integration

```ts
import { createHonorService } from "exfer-honor";
import { asSqliteTxn } from "exfer-honor/adapters";

const service = await createHonorService({
  walletd: process.env.EXFER_WALLETD_URL!, //  ← or inject ports in tests/demos
  indexer: process.env.EXFER_INDEXER_URL!,
  node:    process.env.EXFER_NODE_URL!,
  db,                                       //  your better-sqlite3 handle
  payee:   myPayeePubkey,
});

// Drive the agent's accepted quote to settlement; issue API credits exactly
// once, atomically with the honor gate.
const { done } = service.onPaid(acceptedQuote, (ctx) => {
  const { db: conn } = asSqliteTxn(ctx.db);          // the gate's OWN txn handle
  conn.prepare(`INSERT INTO api_keys (quote_id, api_key, credits)
                  VALUES (?, ?, ?) ON CONFLICT DO NOTHING`).run(...);
  conn.prepare(`UPDATE orders SET state='fulfilled' WHERE quote_id=?`).run(...);
});                                                   // ↑ runs INSIDE the honor txn

const result = await done; // 'honored' | 'declined' | 'cancelled'
```

`deliver` runs **inside** the engine's write-ahead honor transaction, on the
**same** `better-sqlite3` connection the gate writes to (F12). So the gate record
("this quote is honored, exactly once") and your goods (api_key issued with its
credit balance, order fulfilled) commit atomically or roll back together — there
is no "honored but no credits issued" and no "credits issued twice" window.

---

## USD price, EXFER settlement

The agent is quoted a human-meaningful **USD** price (e.g. **$12.50** for 1000
calls), but the **only binding amount on the wire is the EXFER amount** the spine
checks against the on-chain settlement. The USD figure is just how the price was
chosen; the issuer converts it to EXFER at quote time and signs the EXFER amount
into the quote per EXFER-QUOTE.

`priceFeed.ts` is the pluggable seam (`usdToExfer(amountMinorUsd) -> exfer_amount`)
that does that conversion. The demo prints, e.g.:

```
quote: $12.50 @ 1 EXFER = $0.03  → 50000000 base units EXFER (binding)
```

- **DEMO mode** stubs the rate with a fixed constant (1 EXFER = $0.025).
- **REAL mode**: there is **no on-chain EXFER/USD oracle**. The issuer derives the
  rate **off-chain** by reading the **exfer-swap** AMM's **EXFER/BNB** pool
  reserves and chaining them with an external **BNB/USD** feed:

  ```
  EXFER/USD  =  (exfer-swap pool EXFER/BNB reserves)  ×  (BNB/USD feed)
  ```

  The issuer signs the resulting EXFER amount into the quote. Swap
  `demoPriceFeed` for a feed with that derivation — **same function signature**,
  so the merchant code never changes. `exfer_amount` stays the only binding amount.

---

## Run the demo (zero infra)

```bash
npm run demo            # from this directory (or `npm run demo` at the repo root)
```

No walletd, indexer, or node required. The demo injects the library's **own**
in-memory fakes (`HarnessChain` / `HarnessKeys` / `HarnessClock`, reused verbatim
from `exfer-honor/conformance`) and runs the **real** engine over a **real**
`SqliteStore` on a temp file. A scenario driver scripts realistic chain facts
(settlement appears → confirms to depth, or the quote expires) by advancing the
fake clock + tip — it never rigs the engine. Every honor/decline you see is the
real verdict from the real gate.

It walks four scenarios and **asserts** each outcome (a regression breaks the
demo, exit ≠ 0):

| # | Scenario        | Expected real outcome                                  |
|---|-----------------|--------------------------------------------------------|
| a | Happy path      | agent buys 1000 credits → confirmed to depth → **honored**, api_key + credits issued once |
| b | Replay / double-credit | already-honored quote re-presented → **declined** (`already_honored`), no second api_key, no double-credit |
| c | Waits for depth | shallow payment → engine **waits** (`insufficient_depth`), credits issued only after depth is reached |
| d | Expired         | quote expires before a deep-enough payment → **declined** (`expired_unobserved`), no credits |

---

## Flip to real services

Set the three endpoint env vars and run the **same** integration code unchanged:

```bash
export EXFER_WALLETD_URL=http://localhost:9100
export EXFER_INDEXER_URL=http://localhost:9200
export EXFER_NODE_URL=http://localhost:9300
# optional: export EXFER_WALLETD_TOKEN=...
```

When these are set, `buildService` (in `service.ts`) passes the **URLs** to
`createHonorService` instead of the fakes, so the façade wires the real
`IndexerChainSource` / `WalletdVerifier` / `KeystoreKeyCustody` and a wall-clock
`Clock`. The integration in `merchant.ts` does not change at all. In real mode the
agent presents a settlement credential from its `exfer-mcp` wallet via
`service.verifier.accept(...)`, and you swap `demoPriceFeed` for the off-chain
exfer-swap × BNB/USD feed described above.

> The bundled scenario driver only makes sense against the in-memory fakes, so
> `npm run demo` is a no-op when the real env vars are set — point your own API
> service at `fulfilOnPayment(service, db, quote)` instead.

---

## Files

| File           | Role                                                              |
|----------------|-------------------------------------------------------------------|
| `merchant.ts`  | The integration — **identical** in demo and real mode.            |
| `service.ts`   | The **only** demo-vs-real difference: injected fakes vs URLs.     |
| `priceFeed.ts` | The pluggable USD→EXFER seam (stub in demo, exfer-swap×BNB/USD in real). |
| `scenario.ts`  | Demo-only: builds accepted quotes + scripts realistic chain facts.|
| `demo.ts`      | The narrated CLI runner with the four asserted scenarios.         |

`node_modules/exfer-honor` is a symlink to the repo root so `import "exfer-honor"`
resolves to the local library.

This example is **not** part of the published build (it has its own `tsconfig.json`
and is excluded from the root `tsconfig`/`biome` includes), but the root CI
typechecks it as a separate step (`npm run typecheck:example`) so regressions in
the reference integration are still caught.
