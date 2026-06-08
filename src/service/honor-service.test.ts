// SERVICE INTEGRATION — the Stage-E ergonomic façade end-to-end.
//
// `createHonorService` wires a REAL SqliteStore (temp DB) + a fake ChainSource /
// KeyCustody / Verifier; `onPaid` drives a quote all the way to honored with the
// consumer `deliver` running EXACTLY ONCE inside the §5 atomic gate txn. The loop
// timer is driven by node:test FAKE TIMERS (no real sleeps), so the tests are
// deterministic.
//
// Coverage:
//   - onPaid drives a confirmed quote to honored; deliver ran once, inside the txn
//     (goods row + gate rows committed together on the SAME connection, F12); the
//     timer is stopped on the terminal outcome.
//   - a not-yet-confirmed candidate keeps polling, then honors once it confirms.
//   - an expired/declined quote resolves terminally and stops the timer.
//   - the underlying engine + ports stay exposed (advanced use is not hidden).
//
// The F8 compile-time guarantee through the façade is asserted in
// `honor-service.test-d.ts` (an async deliver is a TYPE error).

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { TestContext } from "node:test";
import Database from "better-sqlite3";
import type { Database as Db } from "better-sqlite3";
import { createHonorService } from "./index.js";
import type { HonorService } from "./index.js";
import type { ChainSource, KeyCustody } from "../ports/index.js";
import { WalletdVerifier } from "../adapters/index.js";
import {
  FakeClock,
  PAYEE_SCRIPT,
  QID_A,
  SIGNER,
  confirmedCandidate,
  plainQuote,
} from "../forms/fakes.test-helpers.js";
import type { DeliverContext } from "../spec/index.js";
import { asSqliteTxn } from "../adapters/index.js";
import type { JsonRpc } from "../adapters/index.js";
import type { RawSettlementCandidate } from "../ports/index.js";

const GOODS_DDL = `CREATE TABLE IF NOT EXISTS goods_ledger (
  signer_pubkey TEXT NOT NULL, quote_id TEXT NOT NULL,
  tx_id TEXT NOT NULL, output_index INTEGER NOT NULL, delivered_at INTEGER NOT NULL,
  PRIMARY KEY (signer_pubkey, quote_id));`;

// A fake ChainSource whose candidate list can flip mid-test (unconfirmed → confirmed).
class FakeChainSource implements ChainSource {
  candidates: RawSettlementCandidate[] = [];
  async tipHeight(): Promise<number> {
    return 120;
  }
  async getOutputDatum() {
    return { quoteIdHex: QID_A, honorable: true };
  }
  async findSettlementsByQuoteId(): Promise<RawSettlementCandidate[]> {
    return this.candidates;
  }
  async getTransaction(): Promise<{ blockHeight: number | null } | null> {
    return { blockHeight: 100 };
  }
  async getTxInputs(): Promise<
    Array<{ prevout: { txId: string; outputIndex: number } }>
  > {
    return [];
  }
  async getOutputScript(): Promise<string> {
    return "00";
  }
  async getHtlc(): Promise<null> {
    return null;
  }
}

class FakeKeys implements KeyCustody {
  async controlsPayee(): Promise<boolean> {
    return true;
  }
}

/** A verifier over a fake transport (never actually called by onPaid). */
function fakeVerifier(): WalletdVerifier {
  const rpc: JsonRpc = { call: async <R>() => ({}) as R };
  return new WalletdVerifier(rpc);
}

let dir: string;
let dbPath: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "exfer-honor-service-"));
  dbPath = join(dir, "honor.db");
  db = new Database(dbPath);
  db.exec(GOODS_DDL); // consumer goods table on the SAME connection (F12).
});

afterEach(() => {
  // t.mock.timers (per-test context) auto-resets after each test, so no global
  // timer reset is needed here.
  try {
    db.close();
  } catch {
    /* ignore */
  }
  rmSync(dir, { recursive: true, force: true });
});

/** The consumer's SYNCHRONOUS goods write, on the SAME connection as the gate (F12). */
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

function goodsCount(): number {
  return (db.prepare("SELECT COUNT(*) AS c FROM goods_ledger").get() as { c: number }).c;
}

async function makeService(
  chain: FakeChainSource,
  clock: FakeClock,
): Promise<HonorService<"sync">> {
  return createHonorService({
    walletd: "http://unused",
    indexer: "http://unused",
    node: "http://unused",
    db,
    payee: "22".repeat(32),
    chainSource: chain,
    keyCustody: new FakeKeys(),
    verifier: fakeVerifier(),
    clock,
    pollIntervalMs: 1_000,
  });
}

/** Advance the per-test fake timers by `n` poll intervals, flushing microtasks
 *  between each so an async tick completes before the next interval fires. Uses the
 *  test-context-scoped `t.mock.timers` (auto-reset per test; does NOT clobber the
 *  node:test runner's own real timers, unlike the global `mock.timers`). */
async function pump(
  t: TestContext,
  intervals: number,
  intervalMs = 1_000,
): Promise<void> {
  for (let i = 0; i < intervals; i++) {
    t.mock.timers.tick(intervalMs);
    // flush microtasks so the async tick body runs to completion.
    for (let k = 0; k < 10; k++) {
      await Promise.resolve();
    }
  }
}

// ---------------------------------------------------------------------------
// happy path — onPaid drives to honored, deliver runs once inside the txn
// ---------------------------------------------------------------------------

test("onPaid: confirmed quote → honored; deliver runs exactly once inside the gate txn", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const chain = new FakeChainSource();
  chain.candidates = [confirmedCandidate()];
  const clock = new FakeClock(5_000);
  const service = await makeService(chain, clock);

  let delivered = 0;
  const handle = service.onPaid(plainQuote(), (ctx) => {
    delivered += 1;
    deliverGoods(ctx);
  });

  await pump(t, 2);
  const result = await handle.done;

  assert.equal(result.status, "honored");
  assert.equal(delivered, 1, "deliver ran exactly once");
  assert.equal(goodsCount(), 1, "exactly one goods row (committed inside the txn)");

  // gate rows landed on the real DB, same connection as goods (F12).
  const seen = db
    .prepare("SELECT honored_at FROM quote_seen WHERE signer_pubkey=? AND quote_id=?")
    .get(SIGNER, QID_A) as { honored_at: number | null };
  assert.notEqual(seen.honored_at, null);
  const consumed = db.prepare("SELECT state FROM quote_consumed_outpoint").get() as {
    state: string;
  };
  assert.equal(consumed.state, "honored");

  // the timer is stopped on the terminal outcome: further ticks are no-ops.
  await pump(t, 3);
  assert.equal(delivered, 1, "no further deliveries after terminal honored");
});

// ---------------------------------------------------------------------------
// polling — a not-yet-confirmed candidate keeps polling, then honors
// ---------------------------------------------------------------------------

test("onPaid: an unconfirmed candidate keeps polling, then honors once confirmed", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const chain = new FakeChainSource();
  // start with NO candidate on-chain → the loop must keep waiting (no_candidate).
  chain.candidates = [];
  const clock = new FakeClock(5_000);
  const service = await makeService(chain, clock);

  let delivered = 0;
  const handle = service.onPaid(plainQuote(), (ctx) => {
    delivered += 1;
    deliverGoods(ctx);
  });

  // several ticks with no candidate: still polling, not settled, no delivery.
  await pump(t, 3);
  assert.equal(delivered, 0, "no delivery while unconfirmed");
  assert.equal(goodsCount(), 0);

  // the candidate confirms on-chain → the next tick honors.
  chain.candidates = [confirmedCandidate()];
  await pump(t, 2);

  const result = await handle.done;
  assert.equal(result.status, "honored");
  assert.equal(delivered, 1, "delivered exactly once after confirmation");
  assert.equal(goodsCount(), 1);
});

// ---------------------------------------------------------------------------
// terminal decline — an expired/declined quote resolves terminally, stops timer
// ---------------------------------------------------------------------------

test("onPaid: an amount-mismatch quote declines terminally and stops the timer", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const chain = new FakeChainSource();
  // a confirmed candidate whose value != exferAmount → decline amount_mismatch (R4).
  chain.candidates = [confirmedCandidate({ value: 999n, scriptHex: PAYEE_SCRIPT })];
  const clock = new FakeClock(5_000);
  const service = await makeService(chain, clock);

  let delivered = 0;
  const handle = service.onPaid(plainQuote(), (ctx) => {
    delivered += 1;
    deliverGoods(ctx);
  });

  await pump(t, 2);
  const result = await handle.done;

  assert.equal(result.status, "declined");
  assert.equal(result.status === "declined" ? result.reason : "?", "amount_mismatch");
  assert.equal(delivered, 0, "no delivery on a terminal decline");
  assert.equal(goodsCount(), 0);

  // the timer is stopped: further ticks change nothing.
  await pump(t, 3);
  assert.equal(delivered, 0);
});

test("onPaid: an expired, never-observed quote declines expired_unobserved and stops", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const chain = new FakeChainSource();
  // no candidate ever appears; clock starts PAST the quote's expiresAt (10_000) so
  // it was never observed-before-expiry → the gate declines expired_unobserved.
  chain.candidates = [confirmedCandidate()];
  const clock = new FakeClock(20_000); // > expiresAt 10_000
  const service = await makeService(chain, clock);

  let delivered = 0;
  const handle = service.onPaid(plainQuote(), (ctx) => {
    delivered += 1;
    deliverGoods(ctx);
  });

  await pump(t, 2);
  const result = await handle.done;

  assert.equal(result.status, "declined");
  assert.equal(result.status === "declined" ? result.reason : "?", "expired_unobserved");
  assert.equal(delivered, 0);
});

// ---------------------------------------------------------------------------
// cancel — the handle stops the loop; done resolves cancelled
// ---------------------------------------------------------------------------

test("onPaid: cancel() stops the loop and resolves cancelled", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const chain = new FakeChainSource();
  chain.candidates = []; // never confirms → would poll forever
  const clock = new FakeClock(5_000);
  const service = await makeService(chain, clock);

  let delivered = 0;
  const handle = service.onPaid(plainQuote(), (ctx) => {
    delivered += 1;
    deliverGoods(ctx);
  });

  await pump(t, 2);
  handle.cancel();
  const result = await handle.done;
  assert.equal(result.status, "cancelled");

  // a cancelled loop ticks no more.
  await pump(t, 3);
  assert.equal(delivered, 0);
});

// ---------------------------------------------------------------------------
// advanced surface — engine + ports stay exposed (not hidden)
// ---------------------------------------------------------------------------

test("createHonorService exposes the underlying engine + ports for advanced use", async () => {
  const chain = new FakeChainSource();
  const clock = new FakeClock(5_000);
  const service = await makeService(chain, clock);

  assert.equal(service.engine.apiVersion, 1);
  assert.ok(service.ports.store, "store port exposed");
  assert.equal(service.ports.chain, chain, "chain port exposed");
  assert.ok(service.ports.keys, "keys port exposed");
  assert.equal(service.ports.clock, clock, "clock port exposed");
  assert.ok(service.verifier instanceof WalletdVerifier, "verifier exposed");
  // the engine is the REAL pinned engine: a direct register/honor still works.
  const reg = await service.engine.register(plainQuote());
  assert.equal(reg.created, true);
});
