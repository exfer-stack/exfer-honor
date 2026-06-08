// PORT — Store<M>: gate persistence (the F3/R6 atomicity core) (§4.1).
//
// Pure interface declarations. Zero impl, zero runtime deps. This is the
// injection contract: the gate's DDL is FIXED by the standard (quote_seen,
// quote_consumed_outpoint with a `state` column — §5.5); only the SQL dialect
// varies per adapter. MUST NOT be weakened.

import type {
  AcceptedQuote,
  DeliverContext,
  Outpoint,
  PubKey,
  QuoteId,
  SettlementCandidate,
  TxnModel,
} from "../spec/index.js";

/** The persisted SEEN row (the R6 write-ahead record). */
export interface SeenRow {
  signerPubkey: PubKey;
  quoteId: QuoteId;
  payeePubkey: PubKey;
  payerPubkey: PubKey | null;
  exferAmount: bigint;
  acceptedAt: number;
  expiresAt: number;
  observedBeforeExpiry: boolean;
  honoredAt: number | null;
  retainUntil: number;
}

/**
 * Phase discriminator for form-aware gating (F13).
 *  - 'single'  = plain output: insert+lock+deliver in one txn (§5.2).
 *  - 'promote' = HTLC Phase B: promote the claim_pending row written at Phase A
 *                (§5.5) — UPDATE not INSERT, so no PK collision.
 */
export type GateMode = "single" | "promote";

export interface HonorTxnInput<M extends TxnModel> {
  signerPubkey: PubKey;
  quoteId: QuoteId;
  candidate: SettlementCandidate;
  outpoint: Outpoint;
  now: number;
  retainUntil: number;
  mode: GateMode;
  /**
   * Built by the Store from candidate/now and handed to the consumer DeliverFn
   * INSIDE the txn, AFTER the gate writes. MUST be idempotent on
   * (signerPubkey, quoteId). Throwing rolls the WHOLE txn back (F11).
   */
  deliver: (ctx: DeliverContext<M>) => M extends "sync" ? void : Promise<void>;
}

export interface Store<M extends TxnModel> {
  /** 'sync' (better-sqlite3) | 'async' (postgres). */
  readonly txnModel: M;
  /**
   * F12: the live DB connection/handle the gate writes on. The consumer's goods
   * tables MUST live on THIS SAME connection (sync) or be reached only via
   * DeliverContext.db (async).
   */
  readonly handleId: symbol;

  /** CREATE TABLE IF NOT EXISTS (idempotent DDL). */
  init(): Promise<void>;
  upsertAccepted(
    a: AcceptedQuote,
    acceptedAt: number,
    retainUntil: number,
  ): Promise<void>;
  getSeen(s: PubKey, q: QuoteId): Promise<SeenRow | null>;
  listHonorable(s: PubKey, now: number): Promise<SeenRow[]>;
  markObservedBeforeExpiry(s: PubKey, q: QuoteId, now: number): Promise<void>;
  isOutpointConsumed(o: Outpoint): Promise<boolean>;
  /**
   * HTLC Phase A: provisionally reserve the claim outpoint (state='claim_pending').
   * Idempotent (re-reserve = no-op). Defeats the legacy zero-gate path (M4)
   * without locking SEEN or delivering (F13).
   */
  reserveClaimOutpoint(
    s: PubKey,
    q: QuoteId,
    o: Outpoint,
    claimTxId: string,
    now: number,
  ): Promise<void>;
  /**
   * THE invariant. ONE local ACID txn — see §5.2 / §5.5. Resolves on COMMIT;
   * any throw rolls back the WHOLE txn (no gate write, no delivery).
   */
  runHonorTxn(input: HonorTxnInput<M>): Promise<void>;
  sweep(now: number): Promise<{ seenDeleted: number; outpointsDeleted: number }>;
}
