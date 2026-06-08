// CORE — the concrete HonorEngine + `createHonorEngine` (§3.4, §4, §5, §6).
//
// `createHonorEngine(deps)` is the ONLY constructor (no module-level singletons).
// It PINS the store's `TxnModel` M onto the returned engine's `honor` method so a
// consumer gets the F8 guarantee (async-deliver-under-sync is a COMPILE error)
// WITHOUT hand-writing `<'sync'>` type args — M is inferred from `deps.store`.
//
// At construction it asserts, in order:
//   1. apiVersion === HONOR_API_VERSION                         (§3.7)
//   2. CLAIM_MARGIN === MAX_REORG_DEPTH + CONFIRMATION_DEPTH + 1 (D1, strict)
//   3. store topology is internally consistent (handleId present, F12 seam)
//
// The six façade ops:
//   register      — R6 write-ahead persist, idempotent on (signerPubkey, quoteId).
//   markObserved  — idempotent R6 observation latch (only while now < expiresAt).
//   canHonor      — PURE READ. Step-0 gate + form discover/score (R1-R7). No locks.
//   honor         — THE EDGE. Re-score on the LIVE tip; prepare() (HTLC phase-A);
//                   then the §5 write-ahead txn that runs the consumer `deliver`
//                   INSIDE the same local ACID txn. Gate commits ONLY if deliver
//                   succeeds; a deliver throw rolls back BOTH gate writes and is
//                   RE-THROWN or surfaced as delivery_failed (F11). Concurrent
//                   honor → GateViolation caught AFTER rollback → already_honored
//                   / outpoint_consumed value (F3/F10). Never special-cases forms.
//   status        — accepted | claim_submitted | honored.
//   sweep         — DELETE both gate tables WHERE retain_until < now.

import { HONOR_API_VERSION, GateViolation, HonorError } from "../spec/index.js";
import type {
  AcceptedQuote,
  DeliverContext,
  EnforceDeliverReturn,
  HonorKey,
  HonorOutcome,
  HonorStatus,
  HonorVerdict,
  ObserveResult,
  Outpoint,
  RegisterOpts,
  RegisterResult,
  TxnModel,
} from "../spec/index.js";
import type { HonorDeps, HonorTxnInput, PrepareResult, SeenRow } from "../ports/index.js";
import { gateStep0, quoteFromSeen, scoreQuote } from "./scorer.js";

/**
 * The engine surface returned by `createHonorEngine`, with `honor` PINNED to the
 * store's txn model M. This is the F8 carry-over: a consumer wired with a sync
 * store gets a `honor` that REJECTS an async deliver at compile time, and never
 * writes `<'sync'>` itself. Assignable to the un-pinned `HonorEngine` for callers
 * that take the standard façade.
 */
export interface TypedHonorEngine<M extends TxnModel> {
  readonly apiVersion: typeof HONOR_API_VERSION;
  register(quote: AcceptedQuote, opts?: RegisterOpts): Promise<RegisterResult>;
  markObserved(key: HonorKey, observedAt: number): Promise<ObserveResult>;
  canHonor(key: HonorKey): Promise<HonorVerdict>;
  honor<R>(
    key: HonorKey,
    deliver: (ctx: DeliverContext<M>) => EnforceDeliverReturn<M, R>,
    opts?: RegisterOpts,
  ): Promise<HonorOutcome>;
  status(key: HonorKey): Promise<HonorStatus | null>;
  sweep(now: number): Promise<{ seenDeleted: number; outpointsDeleted: number }>;
}

class HonorEngineImpl<M extends TxnModel> implements TypedHonorEngine<M> {
  readonly apiVersion = HONOR_API_VERSION;
  /** In-process record of submitted HTLC claims (status surface only). */
  private readonly claimTxIds = new Map<string, string>();

  constructor(private readonly deps: HonorDeps<M>) {}

  private now(opt?: number): number {
    return opt ?? this.deps.clock.now();
  }

  private rowKey(key: HonorKey): string {
    return `${key.signerPubkey}:${key.quoteId}`;
  }

  // -- register (R6 write-ahead) -------------------------------------------

  async register(quote: AcceptedQuote, opts?: RegisterOpts): Promise<RegisterResult> {
    const now = this.now(opts?.now);
    const retainUntil = quote.expiresAt + this.deps.config.maxRecheckWindow;

    // Idempotent on (signerPubkey, quoteId): an existing row reports created:false
    // but the same retainUntil — the write-ahead record is never silently mutated.
    const existing = await this.deps.store.getSeen(quote.signerPubkey, quote.quoteId);
    if (existing !== null) {
      return { created: false, retainUntil: existing.retainUntil };
    }

    // Optional pre-screen: a definitive negative payee-custody test at register
    // time fails fast. Unavailability still THROWS keystore_fault (never false).
    if (opts?.preScreenPayeeCustody === true) {
      const ok = await this.controlsPayeeOrThrow(quote.payeePubkey);
      if (!ok) {
        throw new HonorError(
          "malformed_quote",
          "payee not controlled at register-time pre-screen (R2/M3)",
        );
      }
    }

    await this.deps.store.upsertAccepted(quote, now, retainUntil);
    return { created: true, retainUntil };
  }

  // -- markObserved (R6 latch) ---------------------------------------------

  async markObserved(key: HonorKey, observedAt: number): Promise<ObserveResult> {
    const row = await this.deps.store.getSeen(key.signerPubkey, key.quoteId);
    if (row === null) {
      return { observedBeforeExpiry: false, withinWindow: false };
    }
    const withinWindow = observedAt < row.expiresAt;
    if (withinWindow && !row.observedBeforeExpiry) {
      await this.deps.store.markObservedBeforeExpiry(
        key.signerPubkey,
        key.quoteId,
        observedAt,
      );
    }
    return {
      observedBeforeExpiry: withinWindow || row.observedBeforeExpiry,
      withinWindow,
    };
  }

  // -- canHonor (PURE READ) -------------------------------------------------

  async canHonor(key: HonorKey): Promise<HonorVerdict> {
    const now = this.now();
    const row = await this.deps.store.getSeen(key.signerPubkey, key.quoteId);
    const step0 = gateStep0(row);
    if (step0 !== null) {
      return step0;
    }
    // row is non-null past gateStep0.
    const seen = row as SeenRow;
    const quote = quoteFromSeen(seen);
    return scoreQuote(this.deps, quote, now);
  }

  // -- honor (THE EDGE) -----------------------------------------------------

  async honor<R>(
    key: HonorKey,
    deliver: (ctx: DeliverContext<M>) => EnforceDeliverReturn<M, R>,
    opts?: RegisterOpts,
  ): Promise<HonorOutcome> {
    const now = this.now(opts?.now);

    // Step 0: load SEEN, gate already_honored / missing.
    const row = await this.deps.store.getSeen(key.signerPubkey, key.quoteId);
    const step0 = gateStep0(row);
    if (step0 !== null) {
      return { status: "not_ready", verdict: step0 };
    }
    const seen = row as SeenRow;
    const quote = quoteFromSeen(seen);

    // Re-score on the LIVE tip. A stale confirmation is never treated as final.
    const verdict = await scoreQuote(this.deps, quote, now);
    if (verdict.decision !== "honor") {
      return { status: "not_ready", verdict };
    }

    // Form-specific pre-honor side-effect (HTLC phase-A claim submit). Plain = no-op.
    const form = this.deps.forms.get(quote.form);
    const prep: PrepareResult = form.prepare
      ? await form.prepare(
          {
            quote,
            tip: await this.deps.chain.tipHeight(),
            now,
            config: this.deps.config,
            chain: this.deps.chain,
            keys: this.deps.keys,
          },
          verdict,
        )
      : { kind: "ready" };

    if (prep.kind === "claim_submitted") {
      this.claimTxIds.set(this.rowKey(key), prep.claimTxId);
      return {
        status: "not_ready",
        verdict: { decision: "wait", reason: "htlc_claim_pending" },
      };
    }
    if (prep.kind === "wait") {
      return { status: "not_ready", verdict: { decision: "wait", reason: prep.reason } };
    }

    // The §5 write-ahead gate txn. ONE local ACID txn:
    //   SEEN hard-lock → CONSUMED insert/promote → deliver(ctx) → COMMIT.
    // CRITICAL (F11): the consumer `deliver` throw MUST propagate UNCAUGHT through
    // the txn body so the store rolls back BOTH gate writes. We therefore do NOT
    // wrap the runHonorTxn call in a try/catch that could swallow a deliver throw
    // and let the gate commit. The ONLY catch here is for GateViolation (a
    // concurrent honor of the same quote, raised AFTER the txn already rolled
    // back) and for the consumer-error propagation contract (F11 rethrow/value).
    const outpoint: Outpoint = {
      txId: verdict.candidate.txId,
      outputIndex: verdict.candidate.outputIndex,
    };

    let deliverThrew: unknown = NO_THROW;

    // Bridge the consumer's deliver into the store's txn-shaped callback. The F8
    // guarantee is enforced at the PUBLIC `honor` call site via EnforceDeliverReturn
    // (async-under-sync is unconstructable there); inside, we cast to the store's
    // runtime deliver shape `(ctx) => M extends 'sync' ? void : Promise<void>`. The
    // wrapper RE-THROWS a consumer throw uncaught so the store rolls back (F11) and
    // records it so honor() can map to rethrow / delivery_failed AFTER rollback.
    const bridged = ((ctx: DeliverContext<M>) => {
      try {
        return deliver(ctx) as unknown;
      } catch (e) {
        deliverThrew = e;
        throw e; // propagate uncaught → store rolls back BOTH gate writes (F11)
      }
    }) as HonorTxnInput<M>["deliver"];

    try {
      await this.deps.store.runHonorTxn({
        signerPubkey: key.signerPubkey,
        quoteId: key.quoteId,
        candidate: verdict.candidate,
        outpoint,
        now,
        retainUntil: seen.retainUntil,
        mode: form.gateMode(),
        deliver: bridged,
      });
    } catch (e) {
      // A consumer `deliver` throw surfaced here AFTER rollback. The gate is
      // provably clean (honored_at IS NULL, no outpoint row / still claim_pending).
      if (deliverThrew !== NO_THROW) {
        if (opts?.rethrowDeliveryErrors === true) {
          throw deliverThrew;
        }
        return { status: "delivery_failed", retryable: true };
      }
      // A GateViolation from a concurrent honor of the same quote (F3/F10) or the
      // §5.8 in-txn R6 window re-validation (F10): caught AFTER the txn rolled back,
      // converted to the matching benign decline value. The kinds map 1:1 onto the
      // closed DeclineReason set (§5.9): an honored row → already_honored, a
      // window/observation failure → expired_unobserved, a consumed outpoint →
      // outpoint_consumed.
      if (e instanceof GateViolation) {
        const reason =
          e.kind === "seen-already-honored"
            ? "already_honored"
            : e.kind === "expired-window"
              ? "expired_unobserved"
              : "outpoint_consumed";
        return { status: "not_ready", verdict: { decision: "decline", reason } };
      }
      // Anything else is an infra/contract fault — surface it.
      throw e;
    }

    return { status: "honored", outpoint };
  }

  // -- status ---------------------------------------------------------------

  async status(key: HonorKey): Promise<HonorStatus | null> {
    const row = await this.deps.store.getSeen(key.signerPubkey, key.quoteId);
    if (row === null) {
      return null;
    }
    if (row.honoredAt !== null) {
      const outpoint: Outpoint = row.honoredOutpoint ?? { txId: "", outputIndex: -1 };
      return { state: "honored", honoredAt: row.honoredAt, outpoint };
    }
    const claimTxId = this.claimTxIds.get(this.rowKey(key));
    if (claimTxId !== undefined) {
      return { state: "claim_submitted", claimTxId };
    }
    return { state: "accepted" };
  }

  // -- sweep ----------------------------------------------------------------

  async sweep(now: number): Promise<{ seenDeleted: number; outpointsDeleted: number }> {
    return this.deps.store.sweep(now);
  }

  // -- helpers --------------------------------------------------------------

  /**
   * Definitive payee-custody test (R2/M3). Unavailability is re-thrown as a
   * retryable keystore_fault — it MUST NOT degrade to `false` (§3.6).
   */
  private async controlsPayeeOrThrow(payeePubkey: AcceptedQuote["payeePubkey"]) {
    try {
      return await this.deps.keys.controlsPayee(payeePubkey);
    } catch (e) {
      throw new HonorError("keystore_fault", "payee custody test unavailable", e);
    }
  }
}

/** Sentinel distinguishing "deliver did not throw" from a thrown `undefined`. */
const NO_THROW = Symbol("no-throw");

/**
 * The ONLY constructor (§4). PINS M from `deps.store` so the returned engine's
 * `honor` accepts only the store-correct deliver shape (F8 carry-over). Asserts
 * apiVersion (§3.7), derives + asserts CLAIM_MARGIN (D1, strict), and asserts the
 * store topology seam (F12).
 */
export function createHonorEngine<M extends TxnModel>(
  deps: HonorDeps<M>,
): TypedHonorEngine<M> {
  // §3.7: apiVersion gate. (The engine IS HONOR_API_VERSION; this guards a future
  // mismatched-deps shape and documents the RFC-2119 assertion at construction.)
  if (HONOR_API_VERSION !== 1) {
    throw new HonorError(
      "api_version_mismatch",
      `engine apiVersion ${HONOR_API_VERSION} != expected 1`,
    );
  }

  // D1: CLAIM_MARGIN is DERIVED and startup-asserted (strict equality), never
  // hardcoded. CLAIM_MARGIN = MAX_REORG_DEPTH + CONFIRMATION_DEPTH + 1 = 19 for the
  // recommended (12, 6) tuning. A config whose claimMargin does not satisfy the
  // strict identity throws at construction — the HTLC claim could otherwise ship
  // goods before the claim is buried past the deepest tolerated reorg (§6.3).
  const { maxReorgDepth, confirmationDepth, claimMargin } = deps.config;
  const derived = maxReorgDepth + confirmationDepth + 1;
  if (claimMargin !== derived) {
    throw new HonorError(
      "claim_margin_assertion",
      `CLAIM_MARGIN must equal MAX_REORG_DEPTH(${maxReorgDepth}) + ` +
        `CONFIRMATION_DEPTH(${confirmationDepth}) + 1 = ${derived}, got ${claimMargin}`,
    );
  }

  // F12: the store must expose a single live handle identity. A store without a
  // handleId cannot guarantee the gate writes and goods writes share a connection.
  if (typeof deps.store.handleId !== "symbol") {
    throw new HonorError(
      "store_topology",
      "store.handleId must be a symbol identifying the single gate connection (F12)",
    );
  }
  if (deps.store.txnModel !== "sync" && deps.store.txnModel !== "async") {
    throw new HonorError(
      "store_topology",
      `store.txnModel must be 'sync' | 'async', got '${String(deps.store.txnModel)}'`,
    );
  }

  return new HonorEngineImpl(deps);
}
