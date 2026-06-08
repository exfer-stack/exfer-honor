// FORMS — the shared §6.1 scoring spine, reused by every builtin form.
//
// §6.1 steps 2-6 are FORM-AGNOSTIC binding checks that both PlainOutputForm and
// HtlcForm run before their form-specific depth / preimage gate (step 7). Factor
// them here so a new form reuses the closed-hole machinery (F1/M2/R4/R5) instead
// of re-deriving it (the §4.5 add-a-form ergonomics):
//
//   step 2  STRICT-DECODE datum  — honorable flag (M2) + 16-byte single-id,
//           zero trailing, full-equality (F1/R7).
//   step 3  AMOUNT               — candidate.value === exferAmount, EXACT == (R4/D4).
//   step 4  ADDRESS              — candidate.scriptHex === domain_hash(EXFER-ADDR,
//           payeePubkey); NO datum_hash address+amount fallback (R4/M2).
//   step 5  PAYEE CUSTODY        — keys.controlsPayee; throw ⇒ keystore_fault
//           (retryable, NOT decline); false ⇒ payee_not_controlled (R2/M3).
//   step 6  PAYER BINDING (R5)   — null ⇒ N/A; CONSENT (default) ⇒ pass; SOURCE
//           (opt-in) ⇒ a payer-keyed prevout must fund, else payer_binding_failed.
//           Covenant/script-only-funded payers ALWAYS reject.
//
// The spine emits ONLY closed WaitReason/DeclineReason members (§3.3) so every
// consumer's switch stays exhaustive. It performs NO locking and NO delivery — it
// is pure-read scoring (the engine's gate txn owns the side-effects).

import {
  type DeclineReason,
  HonorError,
  type HonorVerdict,
  type SettlementCandidate,
  type SettlementFormId,
  decodeSettlementDatum,
} from "../spec/index.js";
import type { RawSettlementCandidate, ScoringCtx } from "../ports/index.js";
import { domainHashAddr } from "./address.js";

/**
 * Outcome of the shared spine for a SINGLE raw candidate. Either a terminal
 * verdict (the candidate is unhonorable for a closed reason), a `skip` (this
 * candidate carries a DIFFERENT quote_id — full-equality mismatch — try the
 * next), or a validated `SettlementCandidate` the form may carry into its step-7
 * depth / preimage gate. A retryable keystore fault is NOT a verdict here: it is
 * re-thrown so the engine maps it to `keystore_fault` (§3.6).
 */
export type SpineResult =
  | { readonly kind: "verdict"; readonly verdict: HonorVerdict }
  | { readonly kind: "skip" }
  | { readonly kind: "ok"; readonly candidate: SettlementCandidate };

function decline(reason: DeclineReason, detail?: string): SpineResult {
  return { kind: "verdict", verdict: { decision: "decline", reason, detail } };
}

/**
 * Run §6.1 steps 2-6 against one raw candidate. `formId` is stamped onto the
 * resulting `SettlementCandidate` so the engine's gate txn / status surface knows
 * which form owns the consumed outpoint. `keys.controlsPayee` throwing is
 * propagated UNCAUGHT (the engine maps it to a retryable `keystore_fault`) — it
 * MUST NOT degrade to `payee_not_controlled` (§3.6 transient-vs-terminal rule).
 */
export async function runBindingSpine(
  ctx: ScoringCtx,
  raw: RawSettlementCandidate,
  formId: SettlementFormId,
): Promise<SpineResult> {
  const { quote, chain, keys, config } = ctx;

  // step 2 — STRICT datum decode (M2 honorable flag + F1/R7 single-id, no tail).
  const datum = await chain.getOutputDatum(raw.outpoint);
  if (!datum.honorable || datum.quoteIdHex === null) {
    return decline("datum_unhonorable", "datum_hash-only / malformed (M2)");
  }
  // Re-assert strictness on the raw datum hex the indexer surfaced: a 16-byte,
  // zero-trailing, single quote_id. A multi-id / trailing-byte datum is rejected
  // here even if the indexer's own flag were lax (F1 defence-in-depth).
  const decoded = decodeSettlementDatum(datum.quoteIdHex);
  if (!decoded.ok) {
    return decline(
      "datum_unhonorable",
      `strict decode failed: ${decoded.reason} (F1/R7)`,
    );
  }
  // Full-equality bind (F1/R7). A candidate carrying a DIFFERENT quote_id is not a
  // decline of THIS quote — it is simply not ours; skip it.
  if (decoded.quoteId !== quote.quoteId) {
    return { kind: "skip" };
  }

  // step 3 — AMOUNT: EXACT ==, never >= (R4/D4).
  if (raw.value !== quote.exferAmount) {
    return decline(
      "amount_mismatch",
      `value ${raw.value} != exferAmount ${quote.exferAmount} (exact ==)`,
    );
  }

  // step 4 — ADDRESS: scriptHex === domain_hash(EXFER-ADDR, payeePubkey). No
  // datum_hash address+amount fallback (R4/M2).
  const expectedScript = domainHashAddr(quote.payeePubkey, config.addressDeriver);
  if (raw.scriptHex !== expectedScript) {
    return decline("address_mismatch", "scriptHex != domain_hash(EXFER-ADDR, payee)");
  }

  // step 5 — PAYEE CUSTODY (R2/M3). Unavailability is a RETRYABLE keystore_fault
  // (thrown HonorError) — it MUST NOT degrade to `payee_not_controlled`, which is
  // reserved for a DEFINITIVE negative test-sign (§3.6 transient-vs-terminal rule).
  let controls: boolean;
  try {
    controls = await keys.controlsPayee(quote.payeePubkey);
  } catch (e) {
    throw new HonorError("keystore_fault", "payee custody test unavailable (R2/M3)", e);
  }
  if (!controls) {
    return decline("payee_not_controlled", "acceptor does not control payee key (R2/M3)");
  }

  // step 6 — PAYER BINDING (R5), per config. The settlement tx whose inputs we
  // inspect for SOURCE binding is THIS candidate's tx.
  const payerFail = await checkPayerBinding(ctx, raw.outpoint.txId);
  if (payerFail !== null) {
    return decline("payer_binding_failed", payerFail);
  }

  const candidate: SettlementCandidate = {
    form: formId,
    quoteId: quote.quoteId,
    txId: raw.outpoint.txId,
    outputIndex: raw.outpoint.outputIndex,
    value: raw.value,
    scriptHex: raw.scriptHex,
    blockHeight: raw.blockHeight,
    honorable: true,
  };
  return { kind: "ok", candidate };
}

/**
 * R5 payer binding (§6.1 step 6, §5 R5 mechanics). Returns `null` on pass, or a
 * detail string on failure (the caller maps to `payer_binding_failed`).
 *
 *  - payerPubkey == null            → payer_flag 0, N/A, pass.
 *  - CONSENT (default)              → consent recorded at ACCEPT (the registered
 *                                     quote carrying a payerPubkey IS the consent
 *                                     record), pass.
 *  - SOURCE (opt-in, requirePayerFunded) → at least one prevout feeding the
 *                                     settlement tx must be scripted to the payer
 *                                     key; a covenant/script-only-funded payer
 *                                     (no payer-keyed prevout) is ALWAYS rejected.
 */
async function checkPayerBinding(
  ctx: ScoringCtx,
  settlementTxId: string,
): Promise<string | null> {
  const { quote, chain, config } = ctx;
  if (quote.payerPubkey === null) {
    return null; // payer_flag 0 → N/A
  }
  const useSource = config.payerBinding === "source" || config.requirePayerFunded;
  if (!useSource) {
    return null; // CONSENT: payer consent recorded at ACCEPT
  }
  // SOURCE binding: a payer-keyed prevout must fund the settlement.
  const expectedPayerScript = domainHashAddr(quote.payerPubkey, config.addressDeriver);
  const inputs = await chain.getTxInputs(settlementTxId);
  if (inputs.length === 0) {
    return "no prevouts resolvable for SOURCE binding (covenant-only?)";
  }
  for (const { prevout } of inputs) {
    const script = await chain.getOutputScript(prevout);
    if (script === expectedPayerScript) {
      return null; // a payer-keyed prevout funds it → pass
    }
  }
  return "no payer-keyed prevout funds the settlement (covenant-only)";
}
