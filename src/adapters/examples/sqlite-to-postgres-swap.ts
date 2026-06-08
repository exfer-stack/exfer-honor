// WORKED EXAMPLE (§4.6) — swap SQLite → Postgres (R6 shared per identity).
//
// This file is the §4.6 recipe as COMPILING code, not prose. It shows the same
// consumer wired two ways; the ONLY differences are the `Store` adapter and the
// `M` type param. The façade, the forms, the scorer, and every value type are
// UNCHANGED, and — critically — the F8 contract flips automatically: under the
// sync store the consumer's `deliver` MUST be synchronous; under the async store
// it MUST be `async` and write goods ONLY via `ctx.db` (§5.7).
//
// It is not a test (no assertions); the typecheck gate IS the assertion — if the
// swap broke the type contract, this file would fail to compile.

import { createHonorEngine } from "../../core/index.js";
import { createFormRegistry } from "../../core/index.js";
import { builtinForms } from "../../forms/index.js";
import type { HonorConfig } from "../../ports/index.js";
import type { DeliverContext } from "../../spec/index.js";
import { SqliteStore, asSqliteTxn } from "../sqlite-store.js";
import { PostgresStore, asPostgresTxn, type PgPool } from "../postgres-store.js";
import type { Database } from "better-sqlite3";
import type { ChainSource, KeyCustody, Clock } from "../../ports/index.js";

// Shared, store-independent wiring (chain / keys / clock / config / forms).
interface CommonDeps {
  readonly chain: ChainSource;
  readonly keys: KeyCustody;
  readonly clock: Clock;
  readonly config: HonorConfig;
}

// ---------------------------------------------------------------------------
// 1. SQLite wiring (the default / recommended path, D2).
//
// The consumer injects its EXISTING better-sqlite3 connection — the SAME one its
// goods tables live on (F12 single-connection topology). `deliver` is SYNCHRONOUS
// (TxnModel 'sync'): a `Promise`-returning deliver is a COMPILE error here.
// ---------------------------------------------------------------------------

export async function wireSqlite(db: Database, common: CommonDeps) {
  const store = new SqliteStore(db);
  await store.init();

  const engine = createHonorEngine({
    store, // M is INFERRED as 'sync' from the store
    chain: common.chain,
    keys: common.keys,
    clock: common.clock,
    forms: createFormRegistry(builtinForms({ htlcReserver: store })),
    config: common.config,
  });

  // The consumer's goods write runs INSIDE the gate txn, on the SAME connection
  // (ctx.db carries this store's handle). SYNCHRONOUS — no await, no Promise.
  const deliverGoods = (ctx: DeliverContext<"sync">): void => {
    const { db: gate } = asSqliteTxn(ctx.db);
    gate
      .prepare(
        `INSERT INTO goods_ledger (signer_pubkey, quote_id, tx_id, output_index, delivered_at)
         VALUES (?,?,?,?,?)
         ON CONFLICT DO NOTHING`,
      )
      .run(
        ctx.key.signerPubkey,
        ctx.key.quoteId,
        ctx.candidate.txId,
        ctx.candidate.outputIndex,
        ctx.honoredAt,
      );
  };

  return { engine, deliverGoods };
}

// ---------------------------------------------------------------------------
// 2. Postgres wiring (shared multi-instance single-identity, R6 / §7).
//
// Re-wire with a PostgresStore over a SHARED pool. The `M` type param flips to
// 'async', and the type system NOW REQUIRES `deliver` to be `async` and to write
// goods ONLY via `ctx.db` (the txn-bound client) — out-of-band `pool.query` voids
// F3 (§5.7). The façade, forms, scorer, config are identical to the SQLite path.
// ---------------------------------------------------------------------------

export async function wirePostgres(pool: PgPool, common: CommonDeps) {
  const store = new PostgresStore(pool);
  await store.init();

  const engine = createHonorEngine({
    store, // M is INFERRED as 'async' from the store
    chain: common.chain,
    keys: common.keys,
    clock: common.clock,
    forms: createFormRegistry(builtinForms({ htlcReserver: store })),
    config: common.config,
  });

  // ASYNC deliver: writes goods through ctx.db — the SAME txn-bound client the gate
  // writes ran on — and awaits it, so the goods land in the same Postgres txn and
  // roll back with the gate on any throw (§5.4 / §5.7). No `pool.query` here.
  const deliverGoods = async (ctx: DeliverContext<"async">): Promise<void> => {
    const { query } = asPostgresTxn(ctx.db);
    await query(
      `INSERT INTO goods_ledger (signer_pubkey, quote_id, tx_id, output_index, delivered_at)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT DO NOTHING`,
      [
        ctx.key.signerPubkey,
        ctx.key.quoteId,
        ctx.candidate.txId,
        ctx.candidate.outputIndex,
        ctx.honoredAt,
      ],
    );
  };

  return { engine, deliverGoods };
}
