// ADAPTER UNIT — PostgresStore against a FAKE pg pool/client that records the SQL
// command sequence. A live Postgres is not available in CI, so this fake models the
// node-postgres contract precisely enough to prove the §5.4 async-model invariants:
//
//   - runHonorTxn checks out ONE client and wraps everything in ONE transaction:
//       BEGIN ISOLATION LEVEL SERIALIZABLE → gate writes → deliver → COMMIT.
//   - the consumer `deliver` writes goods through `ctx.db` (the SAME txn-bound
//     client) — the goods INSERT lands BETWEEN the gate writes and COMMIT, on the
//     SAME client (F12 / §5.7), never on the pool.
//   - a SEEN-lock miss (rowCount 0) → GateViolation + ROLLBACK, no COMMIT (F3).
//   - a deliver throw propagates uncaught → ROLLBACK, no COMMIT (F11, §5.6).
//   - 'promote' mode UPDATEs claim_pending→honored (no INSERT collision, F13).
//
// Run: npm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { GateViolation } from "../spec/index.js";
import type {
  DeliverContext,
  Outpoint,
  PubKey,
  QuoteId,
  SettlementCandidate,
} from "../spec/index.js";
import {
  PostgresStore,
  asPostgresTxn,
  type PgClient,
  type PgPool,
} from "./postgres-store.js";
import type { HonorTxnInput } from "../ports/index.js";

const SIGNER = "11".repeat(32) as PubKey;
const QID = "0123456789abcdef0123456789abcdef" as QuoteId;
const OUTPOINT: Outpoint = { txId: "aa", outputIndex: 0 };

interface QueryLog {
  text: string;
  values?: unknown[];
}

/** A fake pg client whose UPDATE/INSERT rowCount is programmable per-test, and that
 *  records every SQL command in order (shared with the pool for the assertions). */
class FakeClient implements PgClient {
  released = false;
  constructor(
    private readonly log: QueryLog[],
    private readonly rowCounts: { lock: number; consumed: number },
    private readonly seenHonored: boolean,
  ) {}
  async query<R = unknown>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }> {
    this.log.push({ text: text.trim().split(/\s+/).slice(0, 3).join(" "), values });
    const t = text.trim();
    if (t.startsWith("UPDATE quote_seen")) {
      return { rows: [], rowCount: this.rowCounts.lock };
    }
    if (t.startsWith("SELECT honored_at")) {
      return {
        rows: [{ honored_at: this.seenHonored ? 1 : null }] as R[],
        rowCount: 1,
      };
    }
    if (t.startsWith("INSERT INTO quote_consumed_outpoint")) {
      return { rows: [], rowCount: this.rowCounts.consumed };
    }
    if (t.startsWith("UPDATE quote_consumed_outpoint")) {
      return { rows: [], rowCount: this.rowCounts.consumed };
    }
    return { rows: [], rowCount: 0 };
  }
  release(): void {
    this.released = true;
  }
}

class FakePool implements PgPool {
  log: QueryLog[] = [];
  client: FakeClient;
  constructor(
    rowCounts: { lock: number; consumed: number } = { lock: 1, consumed: 1 },
    seenHonored = false,
  ) {
    this.client = new FakeClient(this.log, rowCounts, seenHonored);
  }
  async query<R = unknown>(): Promise<{ rows: R[]; rowCount: number | null }> {
    return { rows: [], rowCount: 0 };
  }
  async connect(): Promise<PgClient> {
    return this.client;
  }
}

const CANDIDATE: SettlementCandidate = {
  form: "plain",
  quoteId: QID,
  txId: OUTPOINT.txId,
  outputIndex: OUTPOINT.outputIndex,
  value: 100n,
  scriptHex: "dead",
  blockHeight: 90,
  honorable: true,
};

function input(over: Partial<HonorTxnInput<"async">> = {}): HonorTxnInput<"async"> {
  return {
    signerPubkey: SIGNER,
    quoteId: QID,
    candidate: CANDIDATE,
    outpoint: OUTPOINT,
    now: 5_000,
    retainUntil: 9_999,
    mode: "single",
    deliver: async () => {},
    ...over,
  };
}

function cmds(log: QueryLog[]): string[] {
  return log.map((q) => q.text);
}

test("PostgresStore: single mode wraps gate+deliver in ONE txn (BEGIN→lock→insert→deliver→COMMIT)", async () => {
  const pool = new FakePool();
  const store = new PostgresStore(pool);
  let deliveredOnClient = false;
  await store.runHonorTxn(
    input({
      deliver: async (ctx: DeliverContext<"async">) => {
        // goods write goes through the txn-bound client, BEFORE COMMIT.
        const { query } = asPostgresTxn(ctx.db);
        await query("INSERT INTO goods_ledger DEFAULT VALUES");
        deliveredOnClient = true;
      },
    }),
  );
  assert.equal(deliveredOnClient, true);
  const seq = cmds(pool.log);
  // the goods INSERT must appear AFTER the gate writes and BEFORE COMMIT, all on
  // the same client (§5.4 no gap).
  const beginIx = seq.findIndex((s) => s.startsWith("BEGIN"));
  const lockIx = seq.findIndex((s) => s.startsWith("UPDATE quote_seen"));
  const consumedIx = seq.findIndex((s) =>
    s.startsWith("INSERT INTO quote_consumed_outpoint"),
  );
  const goodsIx = seq.findIndex((s) => s.startsWith("INSERT INTO goods_ledger"));
  const commitIx = seq.findIndex((s) => s.startsWith("COMMIT"));
  assert.ok(beginIx >= 0 && beginIx < lockIx, "BEGIN before the SEEN lock");
  assert.ok(lockIx < consumedIx, "SEEN lock before the consumed insert");
  assert.ok(consumedIx < goodsIx, "gate writes before the goods write");
  assert.ok(goodsIx < commitIx, "goods write before COMMIT (same txn, no gap)");
  assert.equal(pool.client.released, true, "client released after COMMIT");
});

test("PostgresStore: a SEEN-lock miss → GateViolation + ROLLBACK, no COMMIT (F3)", async () => {
  const pool = new FakePool({ lock: 0, consumed: 1 }, true);
  const store = new PostgresStore(pool);
  await assert.rejects(
    () => store.runHonorTxn(input()),
    (e: unknown) => e instanceof GateViolation && e.kind === "seen-already-honored",
  );
  const seq = cmds(pool.log);
  assert.ok(seq.includes("ROLLBACK"), "rolled back");
  assert.ok(!seq.includes("COMMIT"), "never committed");
});

test("PostgresStore: a deliver throw → ROLLBACK, no COMMIT (F11, §5.6)", async () => {
  const pool = new FakePool();
  const store = new PostgresStore(pool);
  await assert.rejects(
    () =>
      store.runHonorTxn(
        input({
          deliver: async () => {
            throw new Error("goods down");
          },
        }),
      ),
    /goods down/,
  );
  const seq = cmds(pool.log);
  assert.ok(seq.includes("ROLLBACK"), "deliver throw rolled the txn back");
  assert.ok(!seq.includes("COMMIT"), "gate not committed on deliver throw");
});

test("PostgresStore: promote mode UPDATEs claim_pending→honored (no INSERT collision, F13)", async () => {
  const pool = new FakePool({ lock: 1, consumed: 1 });
  const store = new PostgresStore(pool);
  await store.runHonorTxn(input({ mode: "promote" }));
  const seq = cmds(pool.log);
  assert.ok(
    seq.some((s) => s.startsWith("UPDATE quote_consumed_outpoint")),
    "promote uses UPDATE, not INSERT",
  );
  assert.ok(
    !seq.some((s) => s.startsWith("INSERT INTO quote_consumed_outpoint")),
    "no INSERT in promote",
  );
  assert.ok(seq.includes("COMMIT"));
});

test("PostgresStore: promote miss (no claim_pending row) → GateViolation outpoint-consumed", async () => {
  const pool = new FakePool({ lock: 1, consumed: 0 });
  const store = new PostgresStore(pool);
  await assert.rejects(
    () => store.runHonorTxn(input({ mode: "promote" })),
    (e: unknown) => e instanceof GateViolation && e.kind === "outpoint-consumed",
  );
  assert.ok(cmds(pool.log).includes("ROLLBACK"));
});
