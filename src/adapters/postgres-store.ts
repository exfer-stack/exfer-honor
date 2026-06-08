// ADAPTER — PostgresStore: the reference `Store<'async'>` over node-postgres (§4.1,
// §4.6, §5.4, §5.7).
//
// For shared multi-instance single-identity gating (R6, §7, D2) a consumer swaps
// the SqliteStore for this PostgresStore pointed at a SHARED Postgres. The façade,
// forms, scorer, and value types are unchanged — only the `Store` adapter and the
// `M` type param differ (§4.6).
//
// The §5.4 async model: the gate write AND the consumer's goods write MUST run in
// the SAME Postgres transaction on the SAME client. `runHonorTxn`:
//
//   client = pool.connect()           -- a dedicated, txn-bound client
//   BEGIN ISOLATION LEVEL SERIALIZABLE -- §5.8 sweep-vs-honor contention at the gate
//     1. UPDATE quote_seen … WHERE honored_at IS NULL AND now < retain_until  (F3/F10)
//        rowCount == 1 else GateViolation
//     2a. INSERT consumed (single)  / 2b. UPDATE claim_pending→honored (promote, F13)
//     3. deliver(ctx) — ctx.db is the SAME txn-bound client; `deliver` awaits ONLY
//        on it (§5.7). A throw propagates uncaught (F11) → we ROLLBACK.
//   COMMIT  -- only after deliver resolves (no commit-before-deliver gap, §5.4)
//
// There is NO cross-statement gap: the consumer never writes goods on a separate
// pool client (that autocommits and is not rolled back, voiding F3 — §5.7). The
// txn-bound client is handed in as `DeliverContext.db`; out-of-band `pool.query`
// is UNDEFINED BEHAVIOR that voids F3 and is documented as such.
//
// Residual F9 case (§5.4): Postgres can report an ambiguous COMMIT on connection
// loss. `deliver` MUST be idempotent on (signerPubkey, quoteId); the engine's
// defined re-invoke for a honored-but-unproven row is the safety net (D6).

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
import { DDL_POSTGRES } from "./ddl.js";

/**
 * The minimal node-postgres surface PostgresStore binds to, declared structurally
 * so the adapter compiles without a value import of `pg` (keeping `pg` a peer/
 * runtime dep the consumer supplies). A `pg.Pool` and `pg.PoolClient` satisfy it.
 */
export interface PgQueryable {
  query<R = unknown>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

export interface PgClient extends PgQueryable {
  release(err?: boolean): void;
}

export interface PgPool extends PgQueryable {
  connect(): Promise<PgClient>;
}

/**
 * The txn-bound handle the PostgresStore hands `deliver` as `DeliverContext.db`
 * (§5.7). `query` is the SAME client the gate writes ran on, inside the SAME open
 * transaction — the consumer's goods writes therefore land in that transaction and
 * are rolled back with the gate on any throw. `handleId` is for the F12 identity
 * assertion.
 */
export interface PostgresGateTxn {
  readonly query: PgQueryable["query"];
  readonly handleId: symbol;
}

/** Narrow a `DeliverContext<'async'>.db` (opaque) to the concrete PostgresGateTxn. */
export function asPostgresTxn(db: GateDbTxn<"async">): PostgresGateTxn {
  return db as unknown as PostgresGateTxn;
}

export class PostgresStore implements Store<"async"> {
  readonly txnModel = "async" as const;
  readonly handleId: symbol;

  private readonly pool: PgPool;

  /**
   * @param pool a node-postgres `Pool` (or pool-shaped object). Point it at a
   *   SHARED Postgres so every instance under one `signerPubkey` shares the gate
   *   (R6 "shared per accepting identity", §7) — no daemon. `runHonorTxn` checks
   *   out a dedicated client per honor so the gate + goods writes share one txn.
   */
  constructor(pool: PgPool) {
    this.pool = pool;
    this.handleId = Symbol("postgres-store-handle");
  }

  async init(): Promise<void> {
    // Idempotent DDL (§4.1). Runs on a pooled connection (autocommit is fine for
    // CREATE TABLE IF NOT EXISTS).
    await this.pool.query(DDL_POSTGRES);
  }

  async upsertAccepted(
    a: AcceptedQuote,
    acceptedAt: number,
    retainUntil: number,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO quote_seen
         (signer_pubkey, quote_id, payee_pubkey, payer_pubkey, exfer_amount,
          form, accepted_at, expires_at, observed_before_expiry, honored_at,
          honored_tx_id, honored_output_index, retain_until)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,FALSE,NULL,NULL,NULL,$9)
       ON CONFLICT (signer_pubkey, quote_id) DO NOTHING`,
      [
        a.signerPubkey,
        a.quoteId,
        a.payeePubkey,
        a.payerPubkey,
        a.exferAmount.toString(10),
        a.form,
        acceptedAt,
        a.expiresAt,
        retainUntil,
      ],
    );
  }

  async getSeen(s: PubKey, q: QuoteId): Promise<SeenRow | null> {
    const { rows } = await this.pool.query<SeenRowSql>(
      "SELECT * FROM quote_seen WHERE signer_pubkey=$1 AND quote_id=$2",
      [s, q],
    );
    const r = rows[0];
    return r ? rowFromSql(r) : null;
  }

  async listHonorable(s: PubKey, now: number): Promise<SeenRow[]> {
    const { rows } = await this.pool.query<SeenRowSql>(
      `SELECT * FROM quote_seen
         WHERE signer_pubkey=$1 AND honored_at IS NULL AND $2 < retain_until`,
      [s, now],
    );
    return rows.map(rowFromSql);
  }

  async markObservedBeforeExpiry(s: PubKey, q: QuoteId, now: number): Promise<void> {
    await this.pool.query(
      `UPDATE quote_seen SET observed_before_expiry=TRUE
         WHERE signer_pubkey=$1 AND quote_id=$2 AND $3 < expires_at`,
      [s, q, now],
    );
  }

  async isOutpointConsumed(o: Outpoint): Promise<boolean> {
    const { rows } = await this.pool.query(
      `SELECT 1 FROM quote_consumed_outpoint
         WHERE tx_id=$1 AND output_index=$2 AND state='honored'`,
      [o.txId, o.outputIndex],
    );
    return rows.length > 0;
  }

  async reserveClaimOutpoint(
    s: PubKey,
    q: QuoteId,
    o: Outpoint,
    claimTxId: string,
    _now: number,
  ): Promise<void> {
    // Idempotent (ON CONFLICT DO NOTHING). Reserves the lock as claim_pending
    // against the legacy path (M4) without locking SEEN (F13).
    await this.pool.query(
      `INSERT INTO quote_consumed_outpoint
         (tx_id, output_index, signer_pubkey, quote_id, state, honored_at,
          claim_tx_id, retain_until)
       VALUES ($1,$2,$3,$4,'claim_pending',NULL,$5,$6)
       ON CONFLICT (tx_id, output_index) DO NOTHING`,
      [o.txId, o.outputIndex, s, q, claimTxId, Number.MAX_SAFE_INTEGER],
    );
  }

  /**
   * THE invariant (§5.2 / §5.5) — async model (§5.4). One Postgres transaction on
   * one checked-out client: gate writes + the consumer `deliver` (on the SAME
   * client) + COMMIT. SERIALIZABLE so a concurrent `sweep` contends at the gate
   * (§5.8). A throw (GateViolation or the consumer deliver throw, F11) triggers
   * ROLLBACK and re-throws — we do NOT swallow a deliver throw (§5.6).
   */
  async runHonorTxn(input: HonorTxnInput<"async">): Promise<void> {
    const client = await this.pool.connect();
    let began = false;
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      began = true;

      // Step 1 — SEEN hard-lock folding the R6 window (§5.8/§5.9, F3/F10) at the
      // single commit-time now. The lockable predicate re-validates the late-honor
      // rule: honored_at IS NULL AND now < retain_until AND (now < expires_at OR
      // observed_before_expiry). A first-observed-at-or-after-expiry row matches 0
      // rows → expired_unobserved (§5.9).
      const locked = await client.query(
        `UPDATE quote_seen SET honored_at=$3, honored_tx_id=$4, honored_output_index=$5
           WHERE signer_pubkey=$1 AND quote_id=$2
             AND honored_at IS NULL AND $3 < retain_until
             AND ($3 < expires_at OR observed_before_expiry=TRUE)`,
        [
          input.signerPubkey,
          input.quoteId,
          input.now,
          input.outpoint.txId,
          input.outpoint.outputIndex,
        ],
      );
      if (locked.rowCount !== 1) {
        const { rows } = await client.query<{ honored_at: number | null }>(
          "SELECT honored_at FROM quote_seen WHERE signer_pubkey=$1 AND quote_id=$2",
          [input.signerPubkey, input.quoteId],
        );
        const existing = rows[0];
        if (existing && existing.honored_at !== null) {
          throw new GateViolation(
            "seen-already-honored",
            "SEEN row already honored (concurrent honor / re-honor)",
          );
        }
        // swept mid-honor / out-of-window / late-honor without observation (§5.9).
        throw new GateViolation(
          "expired-window",
          "SEEN row not lockable (swept / out-of-window / late-honor unobserved, §5.9)",
        );
      }

      // Step 2 — CONSUMED insert ('single') or promote ('promote').
      if (input.mode === "single") {
        try {
          await client.query(
            `INSERT INTO quote_consumed_outpoint
               (tx_id, output_index, signer_pubkey, quote_id, state, honored_at,
                claim_tx_id, retain_until)
             VALUES ($1,$2,$3,$4,'honored',$5,NULL,$6)`,
            [
              input.outpoint.txId,
              input.outpoint.outputIndex,
              input.signerPubkey,
              input.quoteId,
              input.now,
              input.retainUntil,
            ],
          );
        } catch (e) {
          if (isUniqueViolation(e)) {
            throw new GateViolation(
              "outpoint-consumed",
              "PK collision inserting consumed outpoint (R1)",
            );
          }
          throw e;
        }
      } else {
        const promoted = await client.query(
          `UPDATE quote_consumed_outpoint SET state='honored', honored_at=$3, retain_until=$4
             WHERE tx_id=$1 AND output_index=$2 AND state='claim_pending'`,
          [input.outpoint.txId, input.outpoint.outputIndex, input.now, input.retainUntil],
        );
        if (promoted.rowCount !== 1) {
          throw new GateViolation(
            "outpoint-consumed",
            "promote target not in claim_pending (F13)",
          );
        }
      }

      // Step 3 — deliver on the SAME txn-bound client (§5.7 F12). `deliver` is
      // async here (TxnModel 'async'); we AWAIT it and only COMMIT after it
      // resolves (§5.4 no gap). A throw propagates uncaught (F11) → ROLLBACK below.
      const ctx: DeliverContext<"async"> = {
        key: { signerPubkey: input.signerPubkey, quoteId: input.quoteId },
        candidate: input.candidate,
        db: this.gateTxnHandle(client),
        honoredAt: input.now,
      };
      await input.deliver(ctx);

      await client.query("COMMIT");
    } catch (e) {
      if (began) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // a rollback failure on a dead connection is itself surfaced via the
          // original throw; release(true) discards the broken client below.
        }
      }
      // release the (possibly broken) client; re-throw so the engine's F11 /
      // GateViolation handling applies (§5.6, §3.6).
      client.release(true);
      throw e;
    }
    client.release();
  }

  async sweep(now: number): Promise<{ seenDeleted: number; outpointsDeleted: number }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const s = await client.query("DELETE FROM quote_seen WHERE retain_until < $1", [
        now,
      ]);
      const o = await client.query(
        "DELETE FROM quote_consumed_outpoint WHERE retain_until < $1",
        [now],
      );
      await client.query("COMMIT");
      return { seenDeleted: s.rowCount ?? 0, outpointsDeleted: o.rowCount ?? 0 };
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  private gateTxnHandle(client: PgClient): GateDbTxn<"async"> {
    const handle: PostgresGateTxn = {
      query: client.query.bind(client),
      handleId: this.handleId,
    };
    return handle as unknown as GateDbTxn<"async">;
  }
}

// ---------------------------------------------------------------------------
// SQL row mapping. node-postgres returns BIGINT columns as decimal STRINGS by
// default, so accepted_at/expires_at/retain_until come back as strings; coerce to
// number. exfer_amount stays a decimal string → bigint (§0).
// ---------------------------------------------------------------------------

interface SeenRowSql {
  signer_pubkey: string;
  quote_id: string;
  payee_pubkey: string;
  payer_pubkey: string | null;
  exfer_amount: string;
  form: string;
  accepted_at: string | number;
  expires_at: string | number;
  observed_before_expiry: boolean;
  honored_at: string | number | null;
  honored_tx_id: string | null;
  honored_output_index: number | null;
  retain_until: string | number;
}

function num(v: string | number): number {
  return typeof v === "number" ? v : Number(v);
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
    acceptedAt: num(r.accepted_at),
    expiresAt: num(r.expires_at),
    observedBeforeExpiry: r.observed_before_expiry === true,
    honoredAt: r.honored_at === null ? null : num(r.honored_at),
    honoredOutpoint,
    retainUntil: num(r.retain_until),
  };
}

/** node-postgres surfaces a unique-violation as an error with SQLSTATE `23505`. */
function isUniqueViolation(e: unknown): boolean {
  return (e as { code?: unknown }).code === "23505";
}
