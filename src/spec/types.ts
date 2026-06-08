// THE STANDARD — canonical value types (one frozen shape) (§3.2, §3.3, §3.4, §3.5).
//
// Conventions (§0):
//  - All hex is bare lowercase `^[0-9a-f]*$` (no `0x`).
//  - All binding amounts are `bigint` (u64) end-to-end — never `number`, never
//    decimal-string — until the persistence boundary.
//  - The wire datum is `SETTLEMENT_DATUM = bare 16-byte quote_id` (F1),
//    strict-decoded with zero trailing bytes.
//
// Branded hex types: the brands are erased at runtime (a `QuoteId` is a plain
// string) but the type system forbids passing an unvalidated `Hex` where a
// `QuoteId` is required. The datum codec / decoders are the only sanctioned
// minters of branded values.

import type { HONOR_API_VERSION } from "./version.js";

declare const __brand: unique symbol;
/** Nominal branding helper. The brand lives only in the type system. */
type Brand<T, B> = T & { readonly [__brand]: B };

// ---------------------------------------------------------------------------
// §3.2 — branded hex types
// ---------------------------------------------------------------------------

/** Bare lowercase hex, `^[0-9a-f]*$`. The unbranded base. */
export type Hex = string;

/** EXACTLY 32 hex chars (16 bytes), strict-decoded (F1). */
export type QuoteId = Brand<Hex, "QuoteId">;

/** 64 hex (32 bytes). */
export type PubKey = Brand<Hex, "PubKey">;

/** Accepting-identity partition key (R6). A PubKey by another name. */
export type SignerPubKey = PubKey;

// ---------------------------------------------------------------------------
// §4.3 — the CLOSED settlement-form union (at the API edge)
// ---------------------------------------------------------------------------

/**
 * The closed string-literal union of settlement forms. New forms widen this
 * union as an ADDITIVE minor (no HONOR_API_VERSION bump). A fully-open `string`
 * is deliberately rejected because it breaks every consumer's exhaustiveness.
 */
export type SettlementFormId = "plain" | "htlc";

// ---------------------------------------------------------------------------
// §3.2 — accepted quote + settlement candidate
// ---------------------------------------------------------------------------

export interface AcceptedQuote {
  readonly quoteId: QuoteId;
  readonly signerPubkey: SignerPubKey;
  readonly payeePubkey: PubKey;
  /** null IFF payer_flag == 0 (R5 gate). */
  readonly payerPubkey: PubKey | null;
  /** The ONLY binding amount, exact (R4). */
  readonly exferAmount: bigint;
  /** unix s, wall-clock observation deadline (R6). */
  readonly expiresAt: number;
  readonly issuedAt: number;
  /** Which strategy owns this quote. */
  readonly form: SettlementFormId;
}

export interface Outpoint {
  readonly txId: Hex;
  readonly outputIndex: number;
}

export interface SettlementCandidate {
  readonly form: SettlementFormId;
  /** strict-decoded, single, full-equality (F1/M2). */
  readonly quoteId: QuoteId;
  readonly txId: Hex;
  /** → Outpoint consumed at honor. */
  readonly outputIndex: number;
  /** MUST == exferAmount EXACTLY (R4) — never `>=`. */
  readonly value: bigint;
  /** for the R4 address-binding check. */
  readonly scriptHex: Hex;
  /** null => unconfirmed. */
  readonly blockHeight: number | null;
  /** false => datum_hash-only / malformed (M2) => decline. */
  readonly honorable: boolean;
}

// ---------------------------------------------------------------------------
// §3.3 — the verdict / outcome model (closed enums)
// ---------------------------------------------------------------------------

/** `wait` ⇒ retry next tick. Closed on purpose: a new form MUST map onto these. */
export type WaitReason =
  | "no_candidate"
  | "insufficient_depth"
  | "htlc_claim_pending"
  | "reorg_withheld";

/** `decline` ⇒ terminal-ish (stop retrying; row retained for audit). Closed. */
export type DeclineReason =
  | "expired_unobserved"
  | "amount_mismatch"
  | "datum_unhonorable"
  | "address_mismatch"
  | "payee_not_controlled"
  | "payer_binding_failed"
  | "already_honored"
  | "outpoint_consumed";

export type HonorVerdict =
  | {
      readonly decision: "honor";
      readonly candidate: SettlementCandidate;
      readonly form: SettlementFormId;
    }
  | { readonly decision: "wait"; readonly reason: WaitReason; readonly detail?: string }
  | {
      readonly decision: "decline";
      readonly reason: DeclineReason;
      readonly detail?: string;
    };

export type HonorOutcome =
  | { readonly status: "honored"; readonly outpoint: Outpoint }
  | { readonly status: "not_ready"; readonly verdict: HonorVerdict }
  /** F11: gate rolled back, retry me. */
  | { readonly status: "delivery_failed"; readonly retryable: true };

// ---------------------------------------------------------------------------
// §3.4 — façade lifecycle value types
// ---------------------------------------------------------------------------

export interface HonorKey {
  readonly signerPubkey: SignerPubKey;
  readonly quoteId: QuoteId;
}

export interface RegisterOpts {
  readonly now?: number;
  readonly preScreenPayeeCustody?: boolean;
  /** §5.6: re-throw the consumer's delivery error instead of returning
   *  `delivery_failed`. Default false. */
  readonly rethrowDeliveryErrors?: boolean;
}

export interface RegisterResult {
  readonly created: boolean;
  readonly retainUntil: number;
}

export interface ObserveResult {
  readonly observedBeforeExpiry: boolean;
  readonly withinWindow: boolean;
}

export type HonorStatus =
  | { readonly state: "accepted" }
  /** HTLC phase-A (R3). */
  | { readonly state: "claim_submitted"; readonly claimTxId: Hex }
  | {
      readonly state: "honored";
      readonly honoredAt: number;
      readonly outpoint: Outpoint;
    };

// ---------------------------------------------------------------------------
// §3.5 — the delivery contract: sync/async made type-safe (closes F8)
// ---------------------------------------------------------------------------

/** Discriminates a synchronous (better-sqlite3) store from an async (postgres) one. */
export type TxnModel = "sync" | "async";

/**
 * Opaque, transaction-scoped DB handle (§5.7, F12). The SAME txn the gate writes
 * ran on; goods writes MUST go through this handle. Its shape is intentionally
 * unspecified at the standard level — adapters supply the concrete type.
 */
export type GateDbTxn<M extends TxnModel> = Brand<unknown, ["GateDbTxn", M]>;

export interface DeliverContext<M extends TxnModel> {
  readonly key: HonorKey;
  readonly candidate: SettlementCandidate;
  /** THE SAME txn-scoped handle the gate writes ran on (F3, F12). */
  readonly db: GateDbTxn<M>;
  readonly honoredAt: number;
}

/**
 * The reusability hinge AND the F3 boundary. Parameterized by the store's
 * TxnModel: the documented frozen shape is `(ctx) => void` for a sync store and
 * `(ctx) => Promise<void>` for an async one (§3.5).
 *
 * NOTE on enforcement: a bare `(ctx) => void` annotation is NOT enough to forbid
 * an async deliver — TypeScript's "a value-returning function is assignable
 * where void is expected" rule lets `async (ctx) => {}` slip through. The F8
 * guarantee is therefore enforced at the CALL SITE (`HonorEngine.honor`, below)
 * via return-type inference + `RejectAsyncDeliver`, which DOES bite. This type
 * remains the canonical shape used by `DeliverContext` and the ports.
 */
export type DeliverFn<M extends TxnModel> = M extends "sync"
  ? (ctx: DeliverContext<"sync">) => void
  : M extends "async"
    ? (ctx: DeliverContext<"async">) => Promise<void>
    : never;

/**
 * F8 enforcement helper. Constrains a sync deliver's INFERRED return type so a
 * `Promise` return collapses to `never` (an unconstructable parameter ⇒ compile
 * error), while a `void`/`undefined` return is accepted. For an async store the
 * return MUST be a Promise. Because `R` is inferred from the deliver's ACTUAL
 * body, TypeScript's void-permissiveness is bypassed and `async (ctx) => {}`
 * under a `'sync'` store is a genuine TYPE ERROR — the F8 escape cannot be typed.
 */
export type EnforceDeliverReturn<M extends TxnModel, R> = M extends "sync"
  ? R extends Promise<unknown>
    ? never // async deliver under a sync store — REJECTED at compile time (F8)
    : R
  : R extends Promise<unknown>
    ? R
    : never; // sync deliver under an async store — REJECTED at compile time

// ---------------------------------------------------------------------------
// §3.4 — the façade interface (interface ONLY at Stage 2; no impl)
// ---------------------------------------------------------------------------

export interface HonorEngine {
  readonly apiVersion: typeof HONOR_API_VERSION;

  /** ACCEPT-bridge persist (R6 write-ahead). Idempotent on (signerPubkey, quoteId). */
  register(quote: AcceptedQuote, opts?: RegisterOpts): Promise<RegisterResult>;

  /**
   * Idempotent R6 observation latch. Sets observed_before_expiry=1 the FIRST
   * time a candidate is seen while now < expires_at. No honor, no lock. Safe to
   * call every tick.
   */
  markObserved(key: HonorKey, observedAt: number): Promise<ObserveResult>;

  /** PURE READ. Scores all candidates against R1–R7 with NO locking / side-effects. */
  canHonor(key: HonorKey): Promise<HonorVerdict>;

  /**
   * THE EDGE. Re-scores on the live tip; if decision==='honor', runs the §5
   * write-ahead txn (SEEN hard-lock + CONSUMED promote) and INSIDE the SAME
   * local ACID txn invokes `deliver`. NEVER delivers without both gate writes
   * committing first; NEVER commits the gate if deliver throws. Returns policy
   * outcomes as values; throws HonorError only on infra/contract faults.
   */
  honor<M extends TxnModel, R>(
    key: HonorKey,
    deliver: (ctx: DeliverContext<M>) => EnforceDeliverReturn<M, R>,
  ): Promise<HonorOutcome>;

  status(key: HonorKey): Promise<HonorStatus | null>;
  sweep(now: number): Promise<{ seenDeleted: number; outpointsDeleted: number }>;
}
