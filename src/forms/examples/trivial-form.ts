// FORMS / examples — a TRIVIAL third form proving §4.5 extensibility.
//
// This file adds a brand-new settlement form (`'echo'`) and drives it through the
// UNMODIFIED engine, registry, gate txn, and every other form. It exists to PROVE
// the §4.3 closed-union-strategy claim: a new form is purely additive.
//
// What a real new builtin would do (§4.5 step 1): widen the SettlementFormId union
// in /spec/types.ts — `'plain' | 'htlc' | 'echo'` — as an ADDITIVE minor (no
// HONOR_API_VERSION bump). To keep the PRODUCTION union frozen at `'plain' |
// 'htlc'` while still demonstrating the pattern end-to-end, this example widens
// the id LOCALLY and casts ONLY at the registry boundary (`asFormId`). Everything
// the engine touches — discover/score/prepare/gateMode, the verdict enums, the
// gate modes — is untouched. No engine edit, no core edit, no other-form edit.
//
// The form itself is deliberately trivial: it honors the first candidate whose
// amount binds (reusing the closed-union WaitReason/DeclineReason members, so a
// consumer's exhaustive switch still compiles), with gateMode 'single'.

import type {
  HonorVerdict,
  SettlementCandidate,
  SettlementFormId,
} from "../../spec/index.js";
import type {
  GateMode,
  RawSettlementCandidate,
  ScoringCtx,
  SettlementForm,
} from "../../ports/index.js";

/** The new form's id. A real builtin would add this to the SettlementFormId union. */
export const ECHO_FORM_ID = "echo";

/**
 * Cast a widened form id to the closed union AT THE REGISTRY BOUNDARY ONLY. This
 * is the single seam a pre-union-widening consumer needs; once the union is
 * widened (§4.5 step 1) the cast disappears.
 */
export function asFormId(id: string): SettlementFormId {
  return id as SettlementFormId;
}

/**
 * EchoForm — a trivial form that honors the first candidate whose value EXACTLY
 * equals exferAmount (R4 amount, EXACT ==). It maps every outcome onto the CLOSED
 * WaitReason/DeclineReason members (§4.5 step 2) so no consumer switch breaks:
 *   no candidate            → wait 'no_candidate'
 *   amount mismatch         → decline 'amount_mismatch'
 *   bound, confirmed enough → honor
 * gateMode 'single' (insert + lock + deliver in one txn, §5.2).
 */
export class EchoForm implements SettlementForm {
  // The id is the widened literal, cast to the closed union for the contract.
  readonly id: SettlementFormId = asFormId(ECHO_FORM_ID);

  async discover(ctx: ScoringCtx): Promise<RawSettlementCandidate[]> {
    return ctx.chain.findSettlementsByQuoteId(ctx.quote.quoteId);
  }

  async score(ctx: ScoringCtx, raw: RawSettlementCandidate[]): Promise<HonorVerdict> {
    const c = raw[0];
    if (!c) {
      return { decision: "wait", reason: "no_candidate" };
    }
    if (c.value !== ctx.quote.exferAmount) {
      return { decision: "decline", reason: "amount_mismatch" };
    }
    if (c.blockHeight === null) {
      return { decision: "wait", reason: "insufficient_depth" };
    }
    const candidate: SettlementCandidate = {
      form: this.id,
      quoteId: ctx.quote.quoteId,
      txId: c.outpoint.txId,
      outputIndex: c.outpoint.outputIndex,
      value: c.value,
      scriptHex: c.scriptHex,
      blockHeight: c.blockHeight,
      honorable: true,
    };
    return { decision: "honor", candidate, form: this.id };
  }

  async prepare(): Promise<{ kind: "ready" }> {
    return { kind: "ready" };
  }

  gateMode(): GateMode {
    return "single";
  }
}
