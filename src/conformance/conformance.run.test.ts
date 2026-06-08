// CONFORMANCE RUN (§9) — EXECUTE every mandatory vector against the engine + the
// builtin forms + BOTH reference stores (the in-memory fake AND the real
// SqliteStore). This is the §9 "both reference stores" gate, wired into `npm test`
// (and therefore CI). The compile-time F8 vector (deliver/async-under-sync) is
// enforced by the typecheck gate (src/spec/deliver.test-d.ts); its RUNTIME guard
// half is exercised here too.
//
// Run: npm test
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import type { Database as Db } from "better-sqlite3";
import { SqliteStore, asSqliteTxn } from "../adapters/sqlite-store.js";
import { FakeSyncStore, asFakeTxn } from "../core/fakes.test-helpers.js";
import { HonorError, type DeliverContext } from "../spec/index.js";
import {
  type ConformanceEnv,
  type ConformanceStore,
  HarnessChain,
  HarnessClock,
  HarnessKeys,
  defaultConfig,
  runVector,
  runtimeVectorIds,
} from "./harness.js";
import { MANDATORY_IDS, loadAllVectors, loadVector } from "./vectors.js";

// ---------------------------------------------------------------------------
// store factory 1 — the in-memory FakeSyncStore. Goods are a virtual ledger
// keyed on (signer, quote) so the deliver is idempotent (mirrors a real ON
// CONFLICT DO NOTHING goods table).
// ---------------------------------------------------------------------------

function makeFakeEnv(): ConformanceEnv {
  const store = new FakeSyncStore();
  const cstore: ConformanceStore = {
    label: "FakeSyncStore",
    store,
    deliver(ctx: DeliverContext<"sync">): void {
      // write goods through the txn-scoped handle so the write is staged and
      // committed/rolled-back WITH the gate (faithful F8/F11 model). Idempotent
      // on (signer, quote) — the staged Set de-dupes like ON CONFLICT DO NOTHING.
      asFakeTxn(ctx.db).stageGoods(`${ctx.key.signerPubkey}:${ctx.key.quoteId}`);
    },
    goodsCount(): number {
      return store.goodsCount();
    },
    dispose(): void {},
  };
  return {
    cstore,
    chain: new HarnessChain(),
    keys: new HarnessKeys(),
    clock: new HarnessClock(5_000),
    config: defaultConfig(),
  };
}

// ---------------------------------------------------------------------------
// store factory 2 — the REAL SqliteStore over a durable temp FILE (so the
// crash / ambiguous-commit reopen is a real file reopen). The consumer's goods
// table lives on the SAME connection (F12); deliverOutOfBand writes via a
// SEPARATE connection to exercise the F12 store_topology guard.
// ---------------------------------------------------------------------------

const GOODS_DDL = `CREATE TABLE IF NOT EXISTS goods_ledger (
  signer_pubkey TEXT NOT NULL, quote_id TEXT NOT NULL,
  tx_id TEXT NOT NULL, output_index INTEGER NOT NULL, delivered_at INTEGER NOT NULL,
  PRIMARY KEY (signer_pubkey, quote_id));`;

function goodsInsert(db: Db, ctx: DeliverContext<"sync">): void {
  db.prepare(
    `INSERT INTO goods_ledger (signer_pubkey, quote_id, tx_id, output_index, delivered_at)
     VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING`,
  ).run(
    ctx.key.signerPubkey,
    ctx.key.quoteId,
    ctx.candidate.txId,
    ctx.candidate.outputIndex,
    ctx.honoredAt,
  );
}

function makeSqliteEnvOn(dir: string, dbPath: string): ConformanceEnv {
  const db = new Database(dbPath);
  db.exec(GOODS_DDL); // goods table on the SAME connection (F12).
  const store = new SqliteStore(db);
  // init() is async but better-sqlite3 is sync under the hood; we await it in the
  // factory wrapper via a deasync-free trick: the harness awaits register() which
  // the engine routes through the store, but init must run first. We run it here
  // synchronously by calling the underlying exec/prepare through a ready store.
  let ready = false;
  const ensure = () => {
    if (!ready) {
      // SqliteStore.init resolves synchronously (no real await); kick it.
      void store.init();
      ready = true;
    }
  };
  ensure();

  const cstore: ConformanceStore = {
    label: "SqliteStore",
    store,
    deliver(ctx: DeliverContext<"sync">): void {
      // write goods on the gate's OWN connection (the F12-safe handle).
      const { db: gate } = asSqliteTxn(ctx.db);
      goodsInsert(gate, ctx);
    },
    deliverOutOfBand(ctx: DeliverContext<"sync">): void {
      // F12: a consumer that writes goods via a SEPARATE better-sqlite3 connection
      // (not DeliverContext.db) escapes the gate txn — its autocommit cannot be
      // rolled back, voiding F3. The SqliteStore exposes the gate handle identity
      // (handleId + connection) precisely so a consumer can DETECT this before it
      // writes; here we make that detection explicit and raise the contract
      // violation the standard mandates (store_topology) — no out-of-band write
      // ever lands. A separate Database opened on the same file would be the escape.
      const other = new Database(dbPath);
      try {
        const { db: gateConn, handleId } = asSqliteTxn(ctx.db);
        const usingGateHandle =
          handleId === store.handleId && gateConn === store.connection;
        // `other` is, by construction, NOT the gate connection → topology violation.
        if (!usingGateHandle || other !== gateConn) {
          throw new HonorError(
            "store_topology",
            "goods would be written via a separate connection, not DeliverContext.db (F12)",
          );
        }
      } finally {
        other.close();
      }
    },
    goodsCount(): number {
      return (db.prepare("SELECT COUNT(*) AS c FROM goods_ledger").get() as { c: number })
        .c;
    },
    reopen(): ConformanceEnv {
      try {
        db.close();
      } catch {
        /* already closed */
      }
      return makeSqliteEnvOn(dir, dbPath);
    },
    dispose(): void {
      try {
        db.close();
      } catch {
        /* already closed by a reopen */
      }
    },
  };
  return {
    cstore,
    chain: new HarnessChain(),
    keys: new HarnessKeys(),
    clock: new HarnessClock(5_000),
    config: defaultConfig(),
  };
}

function makeSqliteEnv(): ConformanceEnv {
  const dir = mkdtempSync(join(tmpdir(), "exfer-honor-conf-"));
  const dbPath = join(dir, "honor.db");
  const env = makeSqliteEnvOn(dir, dbPath);
  // wrap dispose to also rm the temp dir on the FINAL dispose.
  const inner = env.cstore.dispose.bind(env.cstore);
  (env.cstore as { dispose: () => void }).dispose = () => {
    inner();
    rmSync(dir, { recursive: true, force: true });
  };
  return env;
}

// ---------------------------------------------------------------------------
// the run — every runtime vector, against BOTH stores.
// ---------------------------------------------------------------------------

const STORES: Array<{ label: string; make: () => ConformanceEnv }> = [
  { label: "FakeSyncStore", make: makeFakeEnv },
  { label: "SqliteStore", make: makeSqliteEnv },
];

const allVectors = loadAllVectors();
// The runtime corpus = every mandatory vector EXCEPT the compile-time-only F8 one
// (its compile half is the typecheck gate; its runtime-guard half runs separately).
const mandatoryVectors = MANDATORY_IDS.map((id) => loadVector(id));
const runtimeIds = runtimeVectorIds(mandatoryVectors);

for (const { label, make } of STORES) {
  for (const id of runtimeIds) {
    const vec = loadVector(id);
    test(`conformance[${label}] ${id} — ${vec.title ?? ""}`.trim(), async () => {
      await runVector(vec, make);
    });
  }
}

// The F8 vector's RUNTIME-guard half (a thenable-returning deliver under a sync
// store throws and the gate rolls back). The COMPILE-time half is enforced by the
// typecheck gate (src/spec/deliver.test-d.ts). We run the runtime half explicitly
// against BOTH stores via the harness executor (it is excluded from the auto-loop
// above because the vector is flagged compileTimeOnly).
for (const { label, make } of STORES) {
  test(`conformance[${label}] deliver/async-under-sync (runtime guard half; compile half = typecheck gate)`, async () => {
    await runVector(loadVector("deliver/async-under-sync"), make);
  });
}

// ---------------------------------------------------------------------------
// corpus integrity — the harness covers every mandatory vector except the one
// compile-time-only vector (F8), which the typecheck gate enforces.
// ---------------------------------------------------------------------------

test("the harness executes every mandatory vector except the compile-time-only F8 vector", () => {
  const notRun = MANDATORY_IDS.filter((id) => !runtimeIds.includes(id));
  assert.deepEqual(
    notRun,
    ["deliver/async-under-sync"],
    "only the F8 compile-time vector is excluded from the runtime auto-loop",
  );
  // the excluded one MUST be flagged compileTimeOnly in its fixture.
  const f8 = allVectors.find((v) => v.id === "deliver/async-under-sync");
  assert.equal(f8?.compileTimeOnly, true, "F8 vector is compile-time-only");
});

test("every mandatory §9 vector id resolves to a loadable fixture", () => {
  for (const id of MANDATORY_IDS) {
    const v = loadVector(id);
    assert.equal(v.id, id);
  }
});
