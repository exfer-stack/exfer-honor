// ADAPTER INTEGRATION — SqliteStore end-to-end against the Stage-3 engine + Stage-4
// builtin forms, on a REAL better-sqlite3 database (a temp FILE, not :memory:, so
// the crash-idempotency reopen is a real durable-file reopen).
//
// This is the Stage-5 acceptance test. It drives the REAL `createHonorEngine` + the
// REAL `PlainOutputForm` / `HtlcForm` against a fake ChainSource and the REAL
// SqliteStore, asserting on a real sqlite DB:
//   - plain happy: confirmed exact-amount output → exactly ONE delivery; the goods
//     row + the gate rows are committed in ONE txn on the SAME connection (F12).
//   - F3: one quote, two outpoints → first honors, second declines already_honored;
//     exactly one goods row.
//   - F8: an async deliver under the sync store is rejected by the runtime hot-path
//     guard → the txn rolls back (no honor, no goods, no outpoint).
//   - F10: sweep-vs-honor — a swept (out-of-window) row cannot be late-honored;
//          an observed-before-expiry row inside the window can.
//   - F11: a throwing deliver rolls back BOTH gate writes → delivery_failed,
//          honored_at IS NULL, no outpoint row, no goods row; retry then succeeds.
//   - crash-idempotency: REOPEN the DB file after an honor; the honored SEEN row
//     blocks a re-honor (already_honored) and the goods callback never re-fires.
//   - u64 amount round-trip: an amount > 2^53 survives the TEXT persistence boundary.
//
// Run: npm test
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import Database from "better-sqlite3";
import { createFormRegistry, createHonorEngine } from "../core/index.js";
import { PlainOutputForm } from "../forms/index.js";
import {
  FakeChain,
  FakeClock,
  FakeKeys,
  PAYEE_SCRIPT,
  QID_A,
  SIGNER,
  confirmedCandidate,
  plainQuote,
  testConfig,
} from "../forms/fakes.test-helpers.js";
import { SqliteStore, asSqliteTxn } from "./sqlite-store.js";
import type { DeliverContext, HonorKey } from "../spec/index.js";
import type { Database as Db } from "better-sqlite3";

const KEY: HonorKey = { signerPubkey: SIGNER, quoteId: QID_A };
const GOODS_DDL = `CREATE TABLE IF NOT EXISTS goods_ledger (
  signer_pubkey TEXT NOT NULL, quote_id TEXT NOT NULL,
  tx_id TEXT NOT NULL, output_index INTEGER NOT NULL, delivered_at INTEGER NOT NULL,
  PRIMARY KEY (signer_pubkey, quote_id));`;

let dir: string;
let dbPath: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "exfer-honor-sqlite-"));
  dbPath = join(dir, "honor.db");
  db = new Database(dbPath);
  db.exec(GOODS_DDL); // the consumer's goods table on the SAME connection (F12).
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* already closed by a reopen test */
  }
  rmSync(dir, { recursive: true, force: true });
});

async function wire(database: Db = db) {
  const store = new SqliteStore(database);
  await store.init();
  const chain = new FakeChain();
  const keys = new FakeKeys();
  const clock = new FakeClock(5_000);
  const forms = createFormRegistry([new PlainOutputForm()]);
  const config = testConfig();
  const engine = createHonorEngine({ store, chain, keys, clock, forms, config });
  return { engine, store, chain, keys, clock };
}

/** The consumer's SYNCHRONOUS goods write, on the SAME connection as the gate (F12).
 *  Idempotent on (signer, quote): ON CONFLICT DO NOTHING. */
function deliverGoods(ctx: DeliverContext<"sync">): void {
  const { db: gate } = asSqliteTxn(ctx.db);
  gate
    .prepare(
      `INSERT INTO goods_ledger (signer_pubkey, quote_id, tx_id, output_index, delivered_at)
       VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING`,
    )
    .run(
      ctx.key.signerPubkey,
      ctx.key.quoteId,
      ctx.candidate.txId,
      ctx.candidate.outputIndex,
      ctx.honoredAt,
    );
}

function goodsCount(database: Db = db): number {
  const r = database.prepare("SELECT COUNT(*) AS c FROM goods_ledger").get() as {
    c: number;
  };
  return r.c;
}

// ---------------------------------------------------------------------------
// plain happy path — exactly one delivery, all rows committed together
// ---------------------------------------------------------------------------

test("plain/happy: confirmed exact-amount output honors exactly once, goods committed atomically", async () => {
  const { engine, chain } = await wire();
  chain.candidates = [confirmedCandidate()];

  await engine.register(plainQuote());
  await engine.markObserved(KEY, 5_000);

  let delivered = 0;
  const out = await engine.honor(KEY, (ctx) => {
    delivered += 1;
    deliverGoods(ctx);
  });

  assert.equal(out.status, "honored");
  assert.equal(delivered, 1);
  assert.equal(goodsCount(), 1, "exactly one goods row");

  // the gate rows landed on the real DB.
  const seen = db
    .prepare("SELECT honored_at FROM quote_seen WHERE signer_pubkey=? AND quote_id=?")
    .get(SIGNER, QID_A) as { honored_at: number | null };
  assert.notEqual(seen.honored_at, null);
  const consumed = db.prepare("SELECT state FROM quote_consumed_outpoint").get() as {
    state: string;
  };
  assert.equal(consumed.state, "honored");

  const status = await engine.status(KEY);
  assert.equal(status?.state, "honored");
});

// ---------------------------------------------------------------------------
// F3 — one quote, two outpoints → first honors, second already_honored
// ---------------------------------------------------------------------------

test("F3: same quote_id in two outputs → first honors, second declines already_honored (one goods row)", async () => {
  const { engine, chain } = await wire();
  chain.candidates = [
    confirmedCandidate({ outpoint: { txId: "aa00", outputIndex: 0 } }),
    confirmedCandidate({ outpoint: { txId: "bb11", outputIndex: 1 } }),
  ];

  await engine.register(plainQuote());

  const first = await engine.honor(KEY, deliverGoods);
  assert.equal(first.status, "honored");

  // second honor of the SAME quote: SEEN already honored → already_honored.
  const second = await engine.honor(KEY, deliverGoods);
  assert.equal(second.status, "not_ready");
  assert.equal(
    second.status === "not_ready" && second.verdict.decision === "decline"
      ? second.verdict.reason
      : "?",
    "already_honored",
  );
  assert.equal(goodsCount(), 1, "exactly one goods row across two honor attempts");
});

// ---------------------------------------------------------------------------
// F8 — async deliver under the sync store is rejected; the txn rolls back
// ---------------------------------------------------------------------------

test("F8: an async deliver under the sync store rolls back (no honor, no goods)", async () => {
  const { engine, chain } = await wire();
  chain.candidates = [confirmedCandidate()];
  await engine.register(plainQuote());

  // The compile-time DeliverFn<'sync'> rule forbids this; we bypass it with a cast
  // to PROVE the runtime hot-path guard (§3.5 layer 2) also rolls the gate back.
  const asyncDeliver = (async (ctx: DeliverContext<"sync">) => {
    deliverGoods(ctx);
  }) as unknown as (ctx: DeliverContext<"sync">) => void;

  // F8 is a CONTRACT VIOLATION, not a policy outcome: the guard throws inside the
  // txn → better-sqlite3 rolls back → the throw surfaces UNCAUGHT from honor()
  // (it is not a tracked deliver throw nor a GateViolation, §3.5/§3.6). The
  // load-bearing assertion is that NOTHING is committed.
  await assert.rejects(() => engine.honor(KEY, asyncDeliver), /F8 runtime guard/);

  const seen = db
    .prepare("SELECT honored_at FROM quote_seen WHERE signer_pubkey=? AND quote_id=?")
    .get(SIGNER, QID_A) as { honored_at: number | null };
  assert.equal(seen.honored_at, null, "SEEN not honored after F8 rollback");
  assert.equal(
    (
      db.prepare("SELECT COUNT(*) AS c FROM quote_consumed_outpoint").get() as {
        c: number;
      }
    ).c,
    0,
    "no outpoint row after F8 rollback",
  );
  assert.equal(goodsCount(), 0, "no goods row after F8 rollback");
});

// ---------------------------------------------------------------------------
// F11 — a throwing deliver rolls back BOTH gate writes; retry then succeeds
// ---------------------------------------------------------------------------

test("F11: deliver throw rolls back the gate (clean) → delivery_failed; retry succeeds", async () => {
  const { engine, chain } = await wire();
  chain.candidates = [confirmedCandidate()];
  await engine.register(plainQuote());

  let attempts = 0;
  const flaky = (ctx: DeliverContext<"sync">): void => {
    attempts += 1;
    if (attempts === 1) {
      deliverGoods(ctx); // write goods…
      throw new Error("goods system down"); // …then throw — must roll BOTH back.
    }
    deliverGoods(ctx);
  };

  const first = await engine.honor(KEY, flaky);
  assert.equal(first.status, "delivery_failed");
  // the gate is provably clean: honored_at IS NULL, no outpoint row, no goods row.
  const seen1 = db
    .prepare("SELECT honored_at FROM quote_seen WHERE signer_pubkey=? AND quote_id=?")
    .get(SIGNER, QID_A) as { honored_at: number | null };
  assert.equal(seen1.honored_at, null);
  assert.equal(
    (
      db.prepare("SELECT COUNT(*) AS c FROM quote_consumed_outpoint").get() as {
        c: number;
      }
    ).c,
    0,
    "no outpoint row after F11 rollback",
  );
  assert.equal(goodsCount(), 0, "goods write rolled back with the gate (F11)");

  // retry next tick → succeeds, exactly one delivery survives.
  const second = await engine.honor(KEY, flaky);
  assert.equal(second.status, "honored");
  assert.equal(goodsCount(), 1);
});

// ---------------------------------------------------------------------------
// F11 — rethrowDeliveryErrors surfaces the original consumer error
// ---------------------------------------------------------------------------

test("F11: rethrowDeliveryErrors re-throws the consumer error (gate still clean)", async () => {
  const { engine, chain } = await wire();
  chain.candidates = [confirmedCandidate()];
  await engine.register(plainQuote());

  await assert.rejects(
    () =>
      engine.honor(
        KEY,
        () => {
          throw new Error("explode");
        },
        { rethrowDeliveryErrors: true },
      ),
    /explode/,
  );
  const seen = db
    .prepare("SELECT honored_at FROM quote_seen WHERE signer_pubkey=? AND quote_id=?")
    .get(SIGNER, QID_A) as { honored_at: number | null };
  assert.equal(seen.honored_at, null, "gate clean after a re-thrown deliver error");
});

// ---------------------------------------------------------------------------
// F10 — sweep-vs-honor: out-of-window late-honor declines; in-window honors
// ---------------------------------------------------------------------------

test("F10/R6: a swept (out-of-window) row cannot be late-honored", async () => {
  const { engine, chain, clock } = await wire();
  chain.candidates = [confirmedCandidate()];

  // register with a short window; observe before expiry.
  await engine.register(plainQuote()); // expiresAt 10_000, retainUntil = +3600
  await engine.markObserved(KEY, 5_000);

  // jump PAST retain_until and sweep — the row is deleted.
  clock.t = 20_000;
  const swept = await engine.sweep(20_000);
  assert.equal(swept.seenDeleted, 1);

  // honor now: the SEEN row is gone → not_ready (no candidate to honor against the
  // missing row); no goods.
  const out = await engine.honor(KEY, deliverGoods);
  assert.equal(out.status, "not_ready");
  assert.equal(goodsCount(), 0);
});

test("R6: in-window late-honor (observed before expiry) honors; the §5.8 guard runs at commit-time now", async () => {
  const { engine, chain, clock } = await wire();
  chain.candidates = [confirmedCandidate()];

  await engine.register(plainQuote()); // expiresAt 10_000, retainUntil 13_600
  await engine.markObserved(KEY, 5_000); // observed_before_expiry = 1

  // now is AFTER expiry but BEFORE retain_until → late-honor permitted.
  clock.t = 12_000;
  const out = await engine.honor(KEY, deliverGoods);
  assert.equal(out.status, "honored");
  assert.equal(goodsCount(), 1);

  // the SEEN lock recorded the commit-time now, not the scoring-time now.
  const seen = db
    .prepare("SELECT honored_at FROM quote_seen WHERE signer_pubkey=? AND quote_id=?")
    .get(SIGNER, QID_A) as { honored_at: number };
  assert.equal(seen.honored_at, 12_000);
});

// ---------------------------------------------------------------------------
// crash-idempotency — REOPEN the DB file; honored row blocks re-honor
// ---------------------------------------------------------------------------

test("crash-idempotency: reopen the DB file → honored SEEN row blocks re-honor; deliver never re-fires", async () => {
  // honor once on the first connection.
  {
    const { engine, chain } = await wire();
    chain.candidates = [confirmedCandidate()];
    await engine.register(plainQuote());
    const out = await engine.honor(KEY, deliverGoods);
    assert.equal(out.status, "honored");
    assert.equal(goodsCount(), 1);
  }
  // simulate a process crash + restart: close and REOPEN the same file.
  db.close();
  const reopened = new Database(dbPath);
  db = reopened; // so afterEach closes it
  reopened.exec(GOODS_DDL);

  const { engine: engine2, chain: chain2 } = await wire(reopened);
  chain2.candidates = [confirmedCandidate()];

  // the persisted SEEN row is already honored → re-honor declines, deliver never
  // re-fires, goods stays at exactly one.
  let reDelivered = 0;
  const out2 = await engine2.honor(KEY, (ctx) => {
    reDelivered += 1;
    deliverGoods(ctx);
  });
  assert.equal(out2.status, "not_ready");
  assert.equal(
    out2.status === "not_ready" && out2.verdict.decision === "decline"
      ? out2.verdict.reason
      : "?",
    "already_honored",
  );
  assert.equal(reDelivered, 0, "deliver never re-fired after reopen");
  assert.equal(goodsCount(reopened), 1, "still exactly one goods row across the restart");

  const status = await engine2.status(KEY);
  assert.equal(status?.state, "honored");
});

// ---------------------------------------------------------------------------
// u64 amount round-trip across the TEXT persistence boundary (§0)
// ---------------------------------------------------------------------------

test("u64 amount > 2^53 survives the TEXT persistence boundary (bigint end-to-end)", async () => {
  const big = 18_000_000_000_000_000_000n; // > Number.MAX_SAFE_INTEGER, valid u64
  const { engine, chain } = await wire();
  chain.candidates = [confirmedCandidate({ value: big })];

  await engine.register(plainQuote({ exferAmount: big }));
  const stored = await wireStoreReadAmount(db);
  assert.equal(stored, big, "exfer_amount persisted+parsed as the exact bigint");

  const out = await engine.honor(KEY, deliverGoods);
  assert.equal(out.status, "honored", "exact-amount match holds for a large u64");
  assert.equal(goodsCount(), 1);
});

/** Read the persisted exfer_amount back through the store's bigint mapping. */
async function wireStoreReadAmount(database: Db): Promise<bigint> {
  const store = new SqliteStore(database);
  await store.init();
  const row = await store.getSeen(SIGNER, QID_A);
  assert.ok(row, "seen row present");
  return row.exferAmount;
}

// ensure PAYEE_SCRIPT (the reference deriver output) is the scriptHex the candidate
// carries — the spine's R4 address bind must pass for the happy path above.
test("sanity: confirmedCandidate scriptHex == reference payee address", () => {
  assert.equal(confirmedCandidate().scriptHex, PAYEE_SCRIPT);
});
