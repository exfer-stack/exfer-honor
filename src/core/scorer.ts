// CORE — the verdict scorer: the shared scoring spine driver (§6.1).
//
// `canHonor` and `honor` both flow through `scoreQuote`, which:
//   step 0 — loads the SeenRow (R6 write-ahead record). If it is missing the quote
//            was never registered; if `honored_at != null` → decline 'already_honored'
//            (§6.1 step 0). The late-honor / expiry window is RE-VALIDATED inside the
//            gate txn at commit time (§5.8, F10), not here — this read is advisory.
//   steps 1-7 — DELEGATED to the form strategy (`forms.get(quote.form)`): discover()
//            then score() map raw candidates → ONE HonorVerdict against R1-R7. The
//            engine never special-cases `plain` vs `htlc` (§4.3).
//
// The scorer is PURE-READ: no locking, no delivery, no side-effects. It reads the
// live tip so a stale confirmation is never treated as permanent.

import type { AcceptedQuote, HonorVerdict } from "../spec/index.js";
import type {
  ChainSource,
  HonorConfig,
  KeyCustody,
  SeenRow,
  SettlementFormRegistry,
} from "../ports/index.js";

export interface ScorerDeps {
  readonly chain: ChainSource;
  readonly keys: KeyCustody;
  readonly forms: SettlementFormRegistry;
  readonly config: HonorConfig;
}

/**
 * Reconstruct the (frozen) AcceptedQuote that `register` persisted, from the
 * SEEN row, so the form scorer has the binding facts (R4/R5/R6) without a second
 * round-trip. `form` is carried on the row (persisted by `upsertAccepted`).
 */
export function quoteFromSeen(row: SeenRow): AcceptedQuote {
  return {
    quoteId: row.quoteId,
    signerPubkey: row.signerPubkey,
    payeePubkey: row.payeePubkey,
    payerPubkey: row.payerPubkey,
    exferAmount: row.exferAmount,
    expiresAt: row.expiresAt,
    issuedAt: row.acceptedAt,
    form: row.form,
  };
}

/**
 * The shared scoring spine. Reads the live tip, delegates candidate discovery +
 * R1-R7 scoring to the quote's form, and returns ONE HonorVerdict. Step 0 (the
 * `already_honored` gate) is handled by the caller against the loaded SeenRow;
 * this driver assumes the row is present and not yet honored.
 */
export async function scoreQuote(
  deps: ScorerDeps,
  quote: AcceptedQuote,
  now: number,
): Promise<HonorVerdict> {
  const form = deps.forms.get(quote.form);
  const tip = await deps.chain.tipHeight();
  const ctx = {
    quote,
    tip,
    now,
    config: deps.config,
    chain: deps.chain,
    keys: deps.keys,
  };
  const raw = await form.discover(ctx);
  return form.score(ctx, raw);
}

/**
 * Step 0 of the spine (§6.1): given a SEEN row, decide whether scoring may even
 * proceed. Returns `null` to proceed, or a terminal verdict to short-circuit.
 *  - row missing  → decline 'expired_unobserved' (never registered / already swept)
 *  - honored_at set → decline 'already_honored'
 */
export function gateStep0(row: SeenRow | null): HonorVerdict | null {
  if (row === null) {
    return { decision: "decline", reason: "expired_unobserved" };
  }
  if (row.honoredAt !== null) {
    return { decision: "decline", reason: "already_honored" };
  }
  return null;
}
