// FORMS — PlainOutputForm (§6.2, R4) — gateMode 'single'.
//
// The plain settlement: a single confirmed on-chain output that pays the payee
// address EXACTLY exferAmount, carrying the bare 16-byte quote_id datum. Honor
// when:
//   - discover() finds the settlement via the indexer reverse index (Stage-1);
//   - the shared §6.1 binding spine passes (strict datum F1/M2, exact amount R4,
//     domain_hash payee address R4, payee custody R2/M3, payer binding R5);
//   - the output is CONFIRMED TO DEPTH off the LIVE tip:
//         tip - blockHeight + 1 >= CONFIRMATION_DEPTH
//     (blockHeight == null ⇒ wait 'insufficient_depth'). Read on the live tip so a
//     stale confirmation is never treated as permanent.
//
// prepare() is a no-op {kind:'ready'} — the plain form has no pre-gate side-effect.
// gateMode() is 'single': the engine inserts the consumed outpoint directly as
// 'honored' in ONE txn (§5.2) and runs the consumer deliver inside it.
//
// R5-plain: payer binding default is CONSENT (payer consent recorded at ACCEPT);
// SOURCE is opt-in via config.requirePayerFunded — both handled by the spine.

import type { HonorVerdict, SettlementCandidate } from "../spec/index.js";
import type {
  GateMode,
  RawSettlementCandidate,
  ScoringCtx,
  SettlementForm,
} from "../ports/index.js";
import { runBindingSpine } from "./spine.js";

export class PlainOutputForm implements SettlementForm {
  readonly id = "plain" as const;

  /** Indexer Stage-1 reverse index: the settlements carrying this quote_id. */
  async discover(ctx: ScoringCtx): Promise<RawSettlementCandidate[]> {
    return ctx.chain.findSettlementsByQuoteId(ctx.quote.quoteId);
  }

  /**
   * §6.1 spine → §6.2 depth gate. Maps the FIRST binding-valid candidate to one
   * verdict. A candidate carrying a different quote_id is skipped (full-equality,
   * F1); a binding failure is a terminal decline; a binding-valid but shallow
   * candidate is a `wait 'insufficient_depth'`.
   */
  async score(ctx: ScoringCtx, raw: RawSettlementCandidate[]): Promise<HonorVerdict> {
    if (raw.length === 0) {
      return { decision: "wait", reason: "no_candidate" };
    }

    // The first binding-valid candidate wins; track a non-honor verdict to report
    // if NONE bind (e.g. all amount_mismatch) so the consumer sees a real reason.
    let lastDecline: HonorVerdict | null = null;
    let sawSkippedOnly = true;

    for (const c of raw) {
      const spine = await runBindingSpine(ctx, c, this.id);
      if (spine.kind === "skip") {
        continue;
      }
      sawSkippedOnly = false;
      if (spine.kind === "verdict") {
        lastDecline = spine.verdict;
        continue;
      }
      // step 7 — DEPTH gate (R4), off the LIVE tip.
      const depthVerdict = this.depthGate(ctx, spine.candidate);
      if (depthVerdict.decision === "honor") {
        return depthVerdict;
      }
      // a shallow candidate is a wait; remember it but keep scanning in case a
      // sibling candidate for the same quote is already buried deep enough.
      lastDecline = depthVerdict;
    }

    if (lastDecline !== null) {
      return lastDecline;
    }
    // Every candidate carried a different quote_id (all skipped) → none is ours.
    return {
      decision: "wait",
      reason: "no_candidate",
      detail: sawSkippedOnly ? "no candidate carried this quote_id" : undefined,
    };
  }

  /** R4 confirmed-to-depth, off the live tip. */
  private depthGate(ctx: ScoringCtx, candidate: SettlementCandidate): HonorVerdict {
    if (candidate.blockHeight === null) {
      return { decision: "wait", reason: "insufficient_depth", detail: "unconfirmed" };
    }
    const depth = ctx.tip - candidate.blockHeight + 1;
    if (depth < ctx.config.confirmationDepth) {
      return {
        decision: "wait",
        reason: "insufficient_depth",
        detail: `depth ${depth} < CONFIRMATION_DEPTH ${ctx.config.confirmationDepth}`,
      };
    }
    return { decision: "honor", candidate, form: this.id };
  }

  /** Plain output has no pre-gate side-effect. */
  async prepare(): Promise<{ kind: "ready" }> {
    return { kind: "ready" };
  }

  /** Insert the consumed outpoint directly as 'honored' in one txn (§5.2). */
  gateMode(): GateMode {
    return "single";
  }
}
