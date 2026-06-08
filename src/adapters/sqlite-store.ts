// ADAPTER — SqliteStore: the reference `Store<'sync'>` over better-sqlite3 (§4.1,
// §4.6, §5.2, §5.5, §5.7/§5.8).
//
// This is the DEFAULT / RECOMMENDED gate (D2). It implements the §5 write-ahead
// honor transaction as ONE synchronous better-sqlite3 `db.transaction(fn)`:
//
//   BEGIN
//     1. UPDATE quote_seen SET honored_at=:now
//          WHERE signer_pubkey=:s AND quote_id=:q
//            AND honored_at IS NULL AND :now < retain_until   -- §5.8 in-txn R6 re-validation
//        ASSERT changes()==1                                  -- F3 single-honor / F10 swept-or-expired
//     2a. mode='single':  INSERT … state='honored'           -- §5.2, PK collision → R1
//     2b. mode='promote': UPDATE … state 'claim_pending'→'honored'  -- §5.5/F13, no PK collision
//        ASSERT changes()==1
//     3. deliver(DeliverContext{ db:<this same connection> }) -- §5.7 same-connection F12
//   COMMIT  -- all three, or none.
//
// Atomicity facts that make F3 mechanical (§5.4):
//  - better-sqlite3's `db.transaction(fn)` is SYNCHRONOUS: it runs `fn` between
//    BEGIN and COMMIT with NO intervening event-loop turn. The consumer `deliver`
//    runs INSIDE `fn`, so its goods write lands on the SAME connection in the SAME
//    txn. There is NO commit-before-deliver window (all "dies after commit / skip"
//    prose is deleted for the sync model — it cannot happen).
//  - A throw anywhere in `fn` (a GateViolation OR the consumer's `deliver` throw,
//    F11) makes better-sqlite3 ROLL BACK and re-throw. We do NOT wrap `deliver` in
//    an inner try/catch (F11): the throw must propagate uncaught so the gate writes
//    are discarded with the goods write.
//  - F8 runtime hot-path guard: a `deliver` that returns a thenable would commit
//    before its awaited goods write. We detect a returned `.then` INSIDE the txn
//    body and throw, forcing rollback (belt-and-suspenders with the compile-time
//    `DeliverFn<'sync'>` no-Promise rule).
//
// F12 (same-connection): the goods tables MUST live on the SAME better-sqlite3
// `Database` this store was constructed with. `DeliverContext.db` carries this
// store's `handleId` AND the live `Database` handle; a consumer that writes goods
// through a SEPARATE `Database` voids F3 (its autocommit is not rolled back). We
// expose `handleId` + the raw handle so the consumer can assert identity, and
// `assertGoodsHandle()` lets a paranoid consumer verify at deliver time.

import type { Database, Statement } from "better-sqlite3";
import {
  GateViolation,
  type AcceptedQuote,
  type DeliverContext,
  type GateDbTxn,
  type Outpoint,
  type PubKey,
  type QuoteId,
} from "../spec/index.js";
import type { HonorTxnInput, SeenRow, Store } from "../ports/index.js";
import { DDL_SQLITE } from "./ddl.js";

/**
 * The concrete, txn-scoped DB handle the SqliteStore hands the consumer's
 * `deliver` as `DeliverContext.db` (§5.7). It carries the live better-sqlite3
 * `Database` (the SAME connection the gate writes ran on, so goods writes land in
 * the same synchronous txn) plus this store's `handleId` for the F12 identity
 * assertion.
 */
export interface SqliteGateTxn {
  /** The live better-sqlite3 connection — gate writes ran on THIS handle. */
  readonly db: Database;
  /** Identity of the single gate connection (F12). */
  readonly handleId: symbol;
}

/** Narrow a `DeliverContext<'sync'>.db` (opaque `GateDbTxn`) back to the concrete
 *  SqliteGateTxn the SqliteStore minted. The ONLY sanctioned un-brander. */
export function asSqliteTxn(db: GateDbTxn<"sync">): SqliteGateTxn {
  return db as unknown as SqliteGateTxn;
}

export class SqliteStore implements Store<"sync"> {
  readonly txnModel = "sync" as const;
  readonly handleId: symbol;

  private readonly db: Database;
  private initialised = false;

  // Prepared statements, lazily compiled in init(). Kept as fields so the hot
  // honor path does not re-prepare SQL each tick.
  private stmts!: {
    upsertAccepted: Statement;
    getSeen: Statement;
    listHonorable: Statement;
    markObserved: Statement;
    isOutpointConsumed: Statement;
    reserveClaim: Statement;
    lockSeen: Statement;
    insertConsumed: Statement;
    promoteConsumed: Statement;
    sweepSeen: Statement;
    sweepOutpoints: Statement;
  };

  /**
   * @param db a better-sqlite3 `Database`. R6 "shared SQLite" means ONE shared
   *   file opened as ONE connection per process — pass that single connection so
   *   the consumer's goods tables and the gate tables share it (F12). The store
   *   does NOT open the DB itself; the consumer injects its existing handle.
   */
  constructor(db: Database) {
    this.db = db;
    this.handleId = Symbol("sqlite-store-handle");
  }

  /** Expose the live connection so a consumer can wire its goods tables onto the
   *  SAME `Database` (the only F3-safe sync topology, §5.7). */
  get connection(): Database {
    return this.db;
  }

  async init(): Promise<void> {
    if (this.initialised) return;
    this.db.exec(DDL_SQLITE);
    this.stmts = {
      upsertAccepted: this.db.prepare(
        `INSERT INTO quote_seen
           (signer_pubkey, quote_id, payee_pubkey, payer_pubkey, exfer_amount,
            form, accepted_at, expires_at, observed_before_expiry, honored_at,
            honored_tx_id, honored_output_index, retain_until)
         VALUES
           (@signerPubkey, @quoteId, @payeePubkey, @payerPubkey, @exferAmount,
            @form, @acceptedAt, @expiresAt, 0, NULL, NULL, NULL, @retainUntil)
         ON CONFLICT(signer_pubkey, quote_id) DO NOTHING`,
      ),
      getSeen: this.db.prepare(
        "SELECT * FROM quote_seen WHERE signer_pubkey=? AND quote_id=?",
      ),
      listHonorable: this.db.prepare(
        `SELECT * FROM quote_seen
           WHERE signer_pubkey=? AND honored_at IS NULL AND ? < retain_until`,
      ),
      markObserved: this.db.prepare(
        `UPDATE quote_seen SET observed_before_expiry=1
           WHERE signer_pubkey=? AND quote_id=? AND ? < expires_at`,
      ),
      isOutpointConsumed: this.db.prepare(
        `SELECT 1 FROM quote_consumed_outpoint
           WHERE tx_id=? AND output_index=? AND state='honored'`,
      ),
      reserveClaim: this.db.prepare(
        `INSERT INTO quote_consumed_outpoint
           (tx_id, output_index, signer_pubkey, quote_id, state, honored_at,
            claim_tx_id, retain_until)
         VALUES (@txId, @outputIndex, @signerPubkey, @quoteId, 'claim_pending',
                 NULL, @claimTxId, @retainUntil)
         ON CONFLICT(tx_id, output_index) DO NOTHING`,
      ),
      lockSeen: this.db.prepare(
        // §5.8/§5.9 in-txn R6 re-validation at the single commit-time @now:
        //   honored_at IS NULL  AND  @now < retain_until  (retention window)
        //   AND (@now < expires_at OR observed_before_expiry=1)  (late-honor rule)
        // First-observed-at-or-after-expiry ⇒ this UPDATE matches 0 rows ⇒ the
        // follow-up disambiguation raises 'expired-window' → expired_unobserved.
        `UPDATE quote_seen SET honored_at=@now,
            honored_tx_id=@txId, honored_output_index=@outputIndex
           WHERE signer_pubkey=@signerPubkey AND quote_id=@quoteId
             AND honored_at IS NULL AND @now < retain_until
             AND (@now < expires_at OR observed_before_expiry=1)`,
      ),
      insertConsumed: this.db.prepare(
        `INSERT INTO quote_consumed_outpoint
           (tx_id, output_index, signer_pubkey, quote_id, state, honored_at,
            claim_tx_id, retain_until)
         VALUES (@txId, @outputIndex, @signerPubkey, @quoteId, 'honored', @now,
                 NULL, @retainUntil)`,
      ),
      promoteConsumed: this.db.prepare(
        `UPDATE quote_consumed_outpoint SET state='honored', honored_at=@now,
            retain_until=@retainUntil
           WHERE tx_id=@txId AND output_index=@outputIndex AND state='claim_pending'`,
      ),
      sweepSeen: this.db.prepare("DELETE FROM quote_seen WHERE retain_until < ?"),
      sweepOutpoints: this.db.prepare(
        "DELETE FROM quote_consumed_outpoint WHERE retain_until < ?",
      ),
    };
    this.initialised = true;
  }

  async upsertAccepted(
    a: AcceptedQuote,
    acceptedAt: number,
    retainUntil: number,
  ): Promise<void> {
    this.stmts.upsertAccepted.run({
      signerPubkey: a.signerPubkey,
      quoteId: a.quoteId,
      payeePubkey: a.payeePubkey,
      payerPubkey: a.payerPubkey,
      exferAmount: amountToText(a.exferAmount),
      form: a.form,
      acceptedAt,
      expiresAt: a.expiresAt,
      retainUntil,
    });
  }

  async getSeen(s: PubKey, q: QuoteId): Promise<SeenRow | null> {
    const row = this.stmts.getSeen.get(s, q) as SeenRowSql | undefined;
    return row ? rowFromSql(row) : null;
  }

  async listHonorable(s: PubKey, now: number): Promise<SeenRow[]> {
    const rows = this.stmts.listHonorable.all(s, now) as SeenRowSql[];
    return rows.map(rowFromSql);
  }

  async markObservedBeforeExpiry(s: PubKey, q: QuoteId, now: number): Promise<void> {
    this.stmts.markObserved.run(s, q, now);
  }

  async isOutpointConsumed(o: Outpoint): Promise<boolean> {
    return this.stmts.isOutpointConsumed.get(o.txId, o.outputIndex) !== undefined;
  }

  async reserveClaimOutpoint(
    s: PubKey,
    q: QuoteId,
    o: Outpoint,
    claimTxId: string,
    _now: number,
  ): Promise<void> {
    // Idempotent (ON CONFLICT DO NOTHING): a re-reserve of the same outpoint is a
    // no-op (F13). Reserves the lock against the legacy zero-gate path (M4)
    // WITHOUT locking SEEN or delivering.
    this.stmts.reserveClaim.run({
      txId: o.txId,
      outputIndex: o.outputIndex,
      signerPubkey: s,
      quoteId: q,
      claimTxId,
      retainUntil: Number.MAX_SAFE_INTEGER,
    });
  }

  /**
   * THE invariant (§5.2 / §5.5). ONE synchronous better-sqlite3 transaction. The
   * §5.8 R6 late-honor window is re-validated INSIDE the txn against the freshly
   * locked row, at the single commit-time `now` (`input.now`).
   */
  async runHonorTxn(input: HonorTxnInput<"sync">): Promise<void> {
    const txn = this.db.transaction((arg: HonorTxnInput<"sync">) => {
      // Step 1 — SEEN hard-lock folding the R6 window (§5.8, F3/F10). changes()==0
      // is disambiguated by a follow-up read: row gone/out-of-window → expired;
      // honored_at already set → already_honored.
      const locked = this.stmts.lockSeen.run({
        signerPubkey: arg.signerPubkey,
        quoteId: arg.quoteId,
        now: arg.now,
        txId: arg.outpoint.txId,
        outputIndex: arg.outpoint.outputIndex,
      });
      if (locked.changes !== 1) {
        const existing = this.stmts.getSeen.get(arg.signerPubkey, arg.quoteId) as
          | SeenRowSql
          | undefined;
        if (existing && existing.honored_at !== null) {
          throw new GateViolation(
            "seen-already-honored",
            "SEEN row already honored (concurrent honor / re-honor)",
          );
        }
        // gone (swept mid-honor), now >= retain_until (out-of-window), or a
        // late-honor (now >= expires_at) without observed_before_expiry (§5.9) →
        // expired_unobserved. Distinct from already_honored above.
        throw new GateViolation(
          "expired-window",
          "SEEN row not lockable (swept / out-of-window / late-honor unobserved, §5.9)",
        );
      }

      // Step 2 — CONSUMED insert ('single') or promote ('promote').
      if (arg.mode === "single") {
        try {
          this.stmts.insertConsumed.run({
            txId: arg.outpoint.txId,
            outputIndex: arg.outpoint.outputIndex,
            signerPubkey: arg.signerPubkey,
            quoteId: arg.quoteId,
            now: arg.now,
            retainUntil: arg.retainUntil,
          });
        } catch (e) {
          // PK collision on (tx_id, output_index) → outpoint already consumed (R1).
          if (isUniqueViolation(e)) {
            throw new GateViolation(
              "outpoint-consumed",
              "PK collision inserting consumed outpoint (R1)",
            );
          }
          throw e;
        }
      } else {
        // 'promote': claim_pending → honored. No INSERT, so no PK collision (F13).
        const promoted = this.stmts.promoteConsumed.run({
          txId: arg.outpoint.txId,
          outputIndex: arg.outpoint.outputIndex,
          now: arg.now,
          retainUntil: arg.retainUntil,
        });
        if (promoted.changes !== 1) {
          throw new GateViolation(
            "outpoint-consumed",
            "promote target not in claim_pending (F13)",
          );
        }
      }

      // Step 3 — deliver INSIDE the txn, on the SAME connection (§5.7 F12). A throw
      // propagates UNCAUGHT (F11) → better-sqlite3 rolls back the whole txn.
      const ctx: DeliverContext<"sync"> = {
        key: { signerPubkey: arg.signerPubkey, quoteId: arg.quoteId },
        candidate: arg.candidate,
        db: this.gateTxnHandle(),
        honoredAt: arg.now,
      };
      const ret = arg.deliver(ctx) as unknown;
      // F8 runtime hot-path guard: a sync deliver that returned a thenable would
      // commit-before-goods. Throw so the txn rolls back rather than commits.
      if (
        ret !== undefined &&
        ret !== null &&
        typeof (ret as { then?: unknown }).then === "function"
      ) {
        throw new Error(
          "async deliver under a sync (better-sqlite3) store: returned a Promise (F8 runtime guard)",
        );
      }
      // falling off the end with no throw → better-sqlite3 COMMITs (gate + goods).
    });

    // `db.transaction(fn)` runs `fn` synchronously between BEGIN/COMMIT and
    // re-throws on rollback. We surface that throw to the engine unchanged so its
    // F11 / GateViolation handling (§5.6, §3.6) applies.
    txn(input);
  }

  async sweep(now: number): Promise<{ seenDeleted: number; outpointsDeleted: number }> {
    const tx = this.db.transaction((n: number) => {
      const s = this.stmts.sweepSeen.run(n).changes;
      const o = this.stmts.sweepOutpoints.run(n).changes;
      return { seenDeleted: s, outpointsDeleted: o };
    });
    return tx(now);
  }

  /** Mint the txn-scoped handle for `DeliverContext.db` (§5.7). */
  private gateTxnHandle(): GateDbTxn<"sync"> {
    const handle: SqliteGateTxn = { db: this.db, handleId: this.handleId };
    return handle as unknown as GateDbTxn<"sync">;
  }
}

// ---------------------------------------------------------------------------
// SQL row mapping. Amounts cross the persistence boundary as TEXT (§0): a u64
// `bigint` never fits SQLite's signed-64-bit INTEGER, so we serialize to a
// canonical decimal string and parse it back to `bigint`.
// ---------------------------------------------------------------------------

interface SeenRowSql {
  signer_pubkey: string;
  quote_id: string;
  payee_pubkey: string;
  payer_pubkey: string | null;
  exfer_amount: string;
  form: string;
  accepted_at: number;
  expires_at: number;
  observed_before_expiry: number;
  honored_at: number | null;
  honored_tx_id: string | null;
  honored_output_index: number | null;
  retain_until: number;
}

function amountToText(v: bigint): string {
  return v.toString(10);
}

function rowFromSql(r: SeenRowSql): SeenRow {
  const honoredOutpoint: Outpoint | null =
    r.honored_tx_id !== null && r.honored_output_index !== null
      ? { txId: r.honored_tx_id, outputIndex: r.honored_output_index }
      : null;
  return {
    signerPubkey: r.signer_pubkey as PubKey,
    quoteId: r.quote_id as QuoteId,
    payeePubkey: r.payee_pubkey as PubKey,
    payerPubkey: (r.payer_pubkey as PubKey | null) ?? null,
    exferAmount: BigInt(r.exfer_amount),
    form: r.form as SeenRow["form"],
    acceptedAt: r.accepted_at,
    expiresAt: r.expires_at,
    observedBeforeExpiry: r.observed_before_expiry === 1,
    honoredAt: r.honored_at,
    honoredOutpoint,
    retainUntil: r.retain_until,
  };
}

/** better-sqlite3 surfaces a UNIQUE/PK violation as a SqliteError whose `code`
 *  starts with `SQLITE_CONSTRAINT`. */
function isUniqueViolation(e: unknown): boolean {
  const code = (e as { code?: unknown }).code;
  return typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT");
}
