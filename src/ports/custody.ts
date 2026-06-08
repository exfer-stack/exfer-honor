// PORTS — KeyCustody, Clock, Logger (§4.4).

import type { Hex, PubKey, QuoteId } from "../spec/index.js";

export interface KeyCustody {
  /**
   * Definitive payee-control test (R2/M3). true ⇒ acceptor controls payeePubkey.
   * Unavailability MUST throw (→ keystore_fault, retryable) — it MUST NOT return
   * false. `decline:'payee_not_controlled'` is reserved for a definitive
   * negative test-sign, so an honorable quote can never be permanently stranded
   * by a flaky keystore (§3.6 transient-vs-terminal rule).
   */
  controlsPayee(payeePubkey: PubKey): Promise<boolean>;
  /** payee-originated HTLC preimage (R3). */
  htlcPreimageFor?(quoteId: QuoteId, payeePubkey: PubKey): Promise<Hex | null>;
}

/** unix seconds; injectable for determinism / conformance vectors. */
export interface Clock {
  now(): number;
}

export interface Logger {
  debug(...a: unknown[]): void;
  warn(...a: unknown[]): void;
  error(...a: unknown[]): void;
}
