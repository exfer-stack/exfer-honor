// THE STANDARD — error model (§3.6).
//
// Two-tier, mirroring the quote-spec's "malformed → -32602 at decode, policy
// failure → valid:false" split:
//  - Policy outcomes are VALUES, not exceptions. `honor()` returns
//    not_ready{verdict} / delivery_failed; it MUST NOT throw for any R1–R7 result.
//  - HonorError is thrown ONLY for (a) infra faults (DB/chain/keystore/indexer),
//    (b) contract violations (malformed AcceptedQuote, non-hex quoteId,
//    apiVersion mismatch, async-deliver-under-sync-store), (c) startup invariant
//    guards.

export type HonorErrorCode =
  /** strict-decode of an AcceptedQuote / datum failed (≈ -32602). */
  | "malformed_quote"
  | "api_version_mismatch"
  /** F8 async-deliver-under-sync; F12 out-of-band handle detected. */
  | "contract_violation"
  /** UPDATE … WHERE honored_at IS NULL changed != 1 (F3). */
  | "seen_lock_violation"
  /** CONSUMED-OUTPOINT PK collision in a non-HTLC-promote context (R1). */
  | "outpoint_collision"
  /** startup: CLAIM_MARGIN invariant (D1). */
  | "claim_margin_assertion"
  /** F12: gate handle and goods handle are not the same connection. */
  | "store_topology"
  | "db_fault"
  | "chain_fault"
  | "keystore_fault"
  | "indexer_fault";

/**
 * Thrown ONLY for infra faults, contract violations, and startup invariant
 * guards (§3.6). Policy results (R1–R7) are returned as HonorOutcome VALUES,
 * never thrown.
 */
export class HonorError extends Error {
  readonly code: HonorErrorCode;
  override readonly cause?: unknown;

  constructor(code: HonorErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "HonorError";
    this.code = code;
    this.cause = cause;
    // Preserve the prototype chain across the TS/ES5 target boundary.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Raised inside the gate txn when a write-ahead invariant is violated. A
 * concurrent honor of the same quote raises this; `honor()` catches it AFTER
 * the txn has rolled back and converts it to the benign value
 * not_ready{decline:'already_honored'|'outpoint_consumed'} (§3.6 dual-typing
 * rule). It surfaces as a thrown HonorError only on the advanced direct-Store
 * path.
 */
export class GateViolation extends Error {
  readonly kind: "seen-already-honored" | "outpoint-consumed";

  constructor(kind: "seen-already-honored" | "outpoint-consumed", message: string) {
    super(message);
    this.name = "GateViolation";
    this.kind = kind;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
