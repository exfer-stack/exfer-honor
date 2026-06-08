# exfer-honor

**`@exfer/honor`** — a standalone, reusable, extensible TypeScript **standard
library** that turns a post-ACCEPT EXFER-QUOTE credential plus on-chain
settlement facts into a **safe, idempotent, atomically-gated "honor goods now"**
decision — without owning the consumer's goods system, DB, or chain access.

> This is the **frozen standard**: the public interface, the error model, the
> wire datum codec, the gate transaction contract, and the conformance vectors
> are the law. The engine, the stores, and the forms are implementations *of* it.

`exfer-swap` is consumer #1, with zero special-casing.

## Status — Stage 2 (the standard is frozen; the engine is not)

This repository currently ships **Stage 2** of the
[design](../EXFER_HONOR_DESIGN.md) (§12):

- **`/spec`** — `HONOR_API_VERSION`, `SETTLEMENT_DATUM_VERSION`, the canonical
  value types, the closed verdict/outcome enums, the branded hex types, the
  error model, and the **strict 16-byte datum codec** (the one pure piece).
- **`/ports`** — the five injectable port interfaces (`Store<M>`,
  `ChainSource`, `KeyCustody`, `Clock`, `Logger`) plus the `SettlementForm`
  strategy and the `HonorEngine` façade interface. **Interfaces only** — these
  are the extensibility seams.
- The **F8 type-safe delivery contract**: `DeliverFn<M>` is parameterized on
  `TxnModel = 'sync' | 'async'` so a `Store<'sync'>` accepts **only**
  `(ctx) => void` (no `Promise` union). The type system, not a runtime hope,
  forbids escaping the synchronous transaction.
- **`docs/`** — the written RFC-2119 spec skeleton and the conformance-vector
  corpus structure (the scenario list any implementation must pass).

The engine (`/core`), the builtin forms (`/forms`), the reference adapters
(`/adapters`), and the conformance harness land in later stages.

## Layering (the single-dependency rule, §2.3)

```
@exfer/honor
  /spec    — THE STANDARD: version constants, value types, datum codec, errors.
  /ports   — pure interface declarations (the injection contract). Zero impl.
  /core    — createHonorEngine(deps) → HonorEngine.   (Stage 3+)
  /forms   — PlainOutputForm, HtlcForm.               (Stage 4)
  /adapters— SqliteStore, PostgresStore, IndexerChainSource, …  (Stage 5)
  /conformance — in-memory fakes + the vector corpus. (Stage 6)
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
npm test             # node:test via tsx — datum codec + vector structure
npm run lint         # biome
npm run format-check # biome
```

## License

MIT — see [LICENSE](./LICENSE).
