# exfer-honor

**`@exfer/honor`** — a standalone, reusable, extensible TypeScript **standard
library** that turns a post-ACCEPT EXFER-QUOTE credential plus on-chain
settlement facts into a **safe, idempotent, atomically-gated "honor goods now"**
decision — without owning the consumer's goods system, DB, or chain access.

> This is the **frozen standard**: the public interface, the error model, the
> wire datum codec, the gate transaction contract, and the conformance vectors
> are the law. The engine, the stores, and the forms are implementations *of* it.

`exfer-swap` is consumer #1, with zero special-casing.

## Quickstart — ~10 lines (the ergonomic façade)

The Stage-E **`createHonorService`** façade collapses the common-case integration:
it wires the SQLite gate, the indexer/node chain source, the walletd verifier +
key-custody, and the plain/htlc forms, then drives the **observe → honor** loop on
a timer. `onPaid(quote, deliver)` runs your **synchronous** `deliver` inside the
same atomic gate transaction (F3/F8/F11 preserved end-to-end) and resolves when the
quote is honored, declined, or expired.

```ts
import Database from "better-sqlite3";
import { createHonorService } from "exfer-honor";

const db = new Database("./app.db");          // your handle; goods tables live here
const service = await createHonorService({
  walletd: "http://localhost:9100",            // ACCEPT bridge + R2/M3 custody
  indexer: "http://localhost:9200",            // Stage-1 settlement reverse index
  node:    "http://localhost:9300",            // tip / depth / prevouts
  db,                                          // SqliteStore.init() adds only honor's tables
  payee:   myPayeePubkey,
});

// `acceptedQuote` from service.verifier.accept(...) or your own ACCEPT bridge.
const { done } = service.onPaid(acceptedQuote, (ctx) => writeGoods(ctx)); // sync!
const outcome = await done; // { status: 'honored' | 'declined' | 'cancelled' }
```

`deliver` MUST be synchronous under the SQLite (sync) store — an `async` deliver is
a **compile error** through the façade (the F8 guarantee). The underlying
`service.engine` and `service.ports` (store / chain / keys / clock / verifier) stay
fully exposed for advanced use — the façade does not hide them.

## What it does (and does not)

`exfer-honor` is the **"safe to deliver?" gatekeeper + anti-replay ledger** that
sits between an accepted quote and your goods delivery. It watches the chain for a
settlement matching a `quote_id`, waits for confirmation depth (and, for HTLC, for
*your own* claim to confirm), then — in **one local atomic transaction** — locks
two anti-replay gates and runs your `deliver`, so a quote/payment can never deliver
twice. It reuses **walletd** (verify + key-custody), **exfer-indexer** (find the
settlement) and the **node** (depth); it does **not** hold your keys, your money,
or your goods.

## Status — complete and conformance-green

The full library is implemented and green on `main` (typecheck · test ·
conformance · lint · format); see the [design](../EXFER_HONOR_DESIGN.md):

- **`/spec`** — the frozen standard: version constants, canonical value types,
  closed verdict/outcome enums, branded hex types, the error model, and the
  strict 16-byte datum codec.
- **`/ports`** — the five injectable ports (`Store<M>`, `ChainSource`,
  `KeyCustody`, `Clock`, `Logger`) + the `SettlementForm` strategy + the
  `HonorEngine` façade. The extensibility seams.
- **`/core`** — `createHonorEngine(deps)`: the R1–R7 scorer and the §5
  write-ahead honor transaction (atomic gate-then-deliver; F3/F8/F10/F11 closed;
  `CLAIM_MARGIN` derived + startup-asserted).
- **`/forms`** — `PlainOutputForm` and `HtlcForm` (two-phase,
  own-claim-confirmed, reorg-revocable). A new form plugs in without touching core.
- **`/adapters`** — `SqliteStore` (sync), `PostgresStore` (async),
  `IndexerChainSource`, `WalletdVerifier`, `KeystoreKeyCustody`.
- **`/service`** — the `createHonorService` + `onPaid` ergonomic façade (above).
- **`/conformance`** — the 21-vector corpus runs against **both** reference
  stores (in-memory fake + real `SqliteStore`) in CI.

The load-bearing guards (F8, F3, F10, F11, HTLC own-claim-confirmed, M2) are
verified **non-vacuous by mutation testing**.

> Caveat: if you `cancel()` an `onPaid` at the exact moment a tick's honor is
> committing, `done` may resolve `{status:'cancelled'}` even though the goods were
> durably delivered (the gate is committed). This is a reporting edge only — no
> double-honor, atomicity intact; a later `onPaid` for the same quote sees
> `already_honored`.

## Advanced — swap the store, add a form

The façade is optional sugar. For a Postgres-backed shared gate (R6 multi-instance),
a custom chain source, or a new settlement form, wire the ports directly:
`createHonorEngine({ store, chainSource, verifier, keyCustody, forms })`. A new
`SettlementForm` is a self-contained strategy — see `src/forms/examples/`.

## Layering (the single-dependency rule, §2.3)

```
@exfer/honor
  /spec    — THE STANDARD: version constants, value types, datum codec, errors.
  /ports   — pure interface declarations (the injection contract). Zero impl.
  /core    — createHonorEngine(deps) → HonorEngine.
  /forms   — PlainOutputForm, HtlcForm.
  /adapters— SqliteStore, PostgresStore, IndexerChainSource, WalletdVerifier, …
  /service — createHonorService + onPaid (the ergonomic façade).
  /conformance — in-memory fakes + the 21-vector corpus.
```

`/core` depends ONLY on `/ports` + the `SettlementForm` contract + `/spec`. It
never imports a concrete chain, DB, indexer, or keystore.

## The F8 guarantee

```ts
import type { DeliverFn } from "exfer-honor";

// A sync (better-sqlite3) store: deliver MUST be synchronous.
const ok: DeliverFn<"sync"> = (ctx) => {
  /* write goods on ctx.db, inside the gate txn */
};

// An async deliver under a sync store is a COMPILE ERROR — not a runtime hope:
// const bad: DeliverFn<"sync"> = async (ctx) => { await ship(ctx); };  // ✗ ts error
```

## Develop

```sh
npm install
npm run typecheck    # strict; includes the F8 compile-time type test
npm test             # node:test via tsx — full suite (engine, forms, adapters, façade)
npm run conformance  # the 21 vectors × both reference stores (fake + SqliteStore)
npm run lint         # biome
npm run format-check # biome
```

## License

MIT — see [LICENSE](./LICENSE).
