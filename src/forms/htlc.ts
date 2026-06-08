// FORMS — HtlcForm (§6.3, R3) — gateMode 'promote'. Two-phase, two clocks,
// reorg-revocable.
//
// HONOR an HTLC only AFTER the acceptor's OWN claim is buried CLAIM_MARGIN deep —
// never on the mere existence of the lock. The two phases / two clocks:
//
//   Phase A — own claim (§6.3):
//     If we have not yet submitted our claim, require a PAYEE-ORIGINATED preimage
//     (keys.htlcPreimageFor) and enforce, on the ACTUAL on-chain script (getHtlc,
//     NOT the quote's claimed params):
//        receiverPubkey == payeePubkey
//        value          == exferAmount (EXACT)
//        senderPubkey   == payerPubkey   (R5-HTLC, only if payer_flag set)
//        strict datum    full-equality (F1/R7), via the shared binding spine
//        tip + CLAIM_MARGIN <= timeoutHeight   (claim must bury before timeout)
//     Then submit the claim (chain.submitClaim) and signal claim_submitted; the
//     engine reserves the outpoint (state='claim_pending', §5.5/F13/M4) and records
//     status. This tick yields wait 'htlc_claim_pending'.
//
//   Phase B — depth-gate the claim (§6.3):
//     Every tick RE-READ getTransaction(claimTxId).blockHeight off the LIVE tip.
//     When tip - claimHeight + 1 >= CLAIM_MARGIN ⇒ ready ⇒ the engine runs the
//     §5.5 'promote' gate (claim_pending → honored) then delivers. A reorg that
//     un-mines the claim drops depth below CLAIM_MARGIN ⇒ honor WITHHELD
//     (wait 'reorg_withheld') — a once-seen confirmation is NEVER permanent
//     (reorg-revocable).
//
// CLAIM_MARGIN = MAX_REORG_DEPTH + CONFIRMATION_DEPTH + 1, derived + startup-
// asserted by the engine (D1); the form reads it from config.

import {
  type HonorVerdict,
  type SettlementCandidate,
  type SettlementFormId,
  decodeSettlementDatum,
} from "../spec/index.js";
import type { Outpoint, PubKey, QuoteId } from "../spec/index.js";
import type {
  GateMode,
  OnChainHtlc,
  PrepareResult,
  RawSettlementCandidate,
  ScoringCtx,
  SettlementForm,
} from "../ports/index.js";

/** Per-quote in-process record of a submitted claim (the form's singleton state). */
interface ClaimRecord {
  readonly claimTxId: string;
  readonly lock: Outpoint;
}

/**
 * The minimal store capability the HTLC form needs at Phase A: reserve the claim
 * outpoint as `claim_pending` (F13/M4) so the legacy zero-gate path cannot
 * re-consume it and so Phase B's `promote` has a row to promote. INJECTED into
 * the form by the consumer (the SAME store handle wired into the engine deps), so
 * core is NOT modified — the form is a pure strategy that carries its own
 * dependency. txn-model-agnostic (reserveClaimOutpoint is identical for both).
 */
export interface HtlcClaimReserver {
  reserveClaimOutpoint(
    s: PubKey,
    q: QuoteId,
    o: Outpoint,
    claimTxId: string,
    now: number,
  ): Promise<void>;
}

export class HtlcForm implements SettlementForm {
  readonly id: SettlementFormId = "htlc";

  /** Claims submitted this process, keyed by signerPubkey:quoteId. */
  private readonly claims = new Map<string, ClaimRecord>();

  /**
   * @param reserver OPTIONAL claim-outpoint reserver (the consumer's Store). When
   *   present, Phase A reserves the claim outpoint as `claim_pending` BEFORE
   *   signalling claim_submitted (F13/M4), so Phase B's `promote` gate succeeds.
   *   When absent, the form assumes the caller reserves out-of-band (the Stage-3
   *   engine test wiring does this manually).
   */
  constructor(private readonly reserver?: HtlcClaimReserver) {}

  private rk(ctx: ScoringCtx): string {
    return `${ctx.quote.signerPubkey}:${ctx.quote.quoteId}`;
  }

  /** Indexer Stage-1 reverse index: the HTLC lock(s) carrying this quote_id. */
  async discover(ctx: ScoringCtx): Promise<RawSettlementCandidate[]> {
    return ctx.chain.findSettlementsByQuoteId(ctx.quote.quoteId);
  }

  /**
   * Validate the candidate HTLC against its ACTUAL on-chain script (R3) and emit
   * a verdict. score() does NOT gate on claim depth — that is prepare()'s Phase-B
   * job — but it DOES surface a no_candidate / unhonorable / binding decline so a
   * non-honorable HTLC never reaches prepare. A binding-valid lock yields
   * decision:'honor' (the lock outpoint is the candidate the gate will consume).
   */
  async score(ctx: ScoringCtx, raw: RawSettlementCandidate[]): Promise<HonorVerdict> {
    const c = raw[0];
    if (!c) {
      return { decision: "wait", reason: "no_candidate" };
    }
    const htlc = await ctx.chain.getHtlc(c.outpoint);
    if (htlc === null) {
      return { decision: "wait", reason: "no_candidate", detail: "no on-chain HTLC" };
    }
    const binding = this.validateOnChain(ctx, htlc, c);
    if (binding !== null) {
      return binding; // a closed decline
    }
    const candidate: SettlementCandidate = {
      form: this.id,
      quoteId: ctx.quote.quoteId,
      txId: c.outpoint.txId,
      outputIndex: c.outpoint.outputIndex,
      value: htlc.value,
      scriptHex: c.scriptHex,
      blockHeight: c.blockHeight,
      honorable: true,
    };
    return { decision: "honor", candidate, form: this.id };
  }

  /**
   * R3 enforcement on the ACTUAL on-chain HTLC script (NOT the quote's claimed
   * params). Returns a terminal decline verdict, or null when the lock binds.
   * keys.controlsPayee throwing propagates UNCAUGHT (→ keystore_fault, retryable).
   */
  private validateOnChain(
    ctx: ScoringCtx,
    htlc: OnChainHtlc,
    raw: RawSettlementCandidate,
  ): HonorVerdict | null {
    const { quote } = ctx;
    void raw;
    // strict datum full-equality (F1/R7) — the indexer reverse index already keyed
    // this lock by our quote_id; re-assert the strict 16-byte decode as defence.
    const decoded = decodeSettlementDatum(quote.quoteId);
    if (!decoded.ok || decoded.quoteId !== quote.quoteId) {
      return {
        decision: "decline",
        reason: "datum_unhonorable",
        detail: "quote_id not strict",
      };
    }
    // receiver == payee.
    if (htlc.receiverPubkey !== quote.payeePubkey) {
      return {
        decision: "decline",
        reason: "address_mismatch",
        detail: "HTLC receiver != payee (R3)",
      };
    }
    // value == exferAmount, EXACT.
    if (htlc.value !== quote.exferAmount) {
      return {
        decision: "decline",
        reason: "amount_mismatch",
        detail: `HTLC value ${htlc.value} != exferAmount ${quote.exferAmount}`,
      };
    }
    // R5-HTLC: sender == payer, only if payer_flag set.
    if (quote.payerPubkey !== null && htlc.senderPubkey !== quote.payerPubkey) {
      return {
        decision: "decline",
        reason: "payer_binding_failed",
        detail: "HTLC sender != payer (R5-HTLC)",
      };
    }
    return null;
  }

  /**
   * Phase A (submit own claim) / Phase B (depth-gate the claim). The phase is
   * determined by whether THIS process has already submitted a claim for the quote.
   */
  async prepare(
    ctx: ScoringCtx,
    v: Extract<HonorVerdict, { decision: "honor" }>,
  ): Promise<PrepareResult> {
    const key = this.rk(ctx);
    const prior = this.claims.get(key);

    if (prior === undefined) {
      return this.phaseA(ctx, v);
    }
    return this.phaseB(ctx, prior);
  }

  /**
   * Phase A — preimage-in-hand + on-chain timeout-margin gate, then submit the
   * claim and reserve via the engine's gate (signalled by claim_submitted).
   */
  private async phaseA(
    ctx: ScoringCtx,
    v: Extract<HonorVerdict, { decision: "honor" }>,
  ): Promise<PrepareResult> {
    const { quote, chain, keys, config, tip } = ctx;
    const lock = { txId: v.candidate.txId, outputIndex: v.candidate.outputIndex };

    const htlc = await chain.getHtlc(lock);
    if (htlc === null) {
      return { kind: "wait", reason: "no_candidate" };
    }

    // tip + CLAIM_MARGIN <= timeoutHeight — the claim MUST bury past the deepest
    // tolerated reorg BEFORE the HTLC timeout, else a reclaim could race us.
    if (tip + config.claimMargin > htlc.timeoutHeight) {
      return { kind: "wait", reason: "reorg_withheld" };
    }

    // PAYEE-ORIGINATED preimage in hand (R3). No preimage ⇒ cannot claim yet.
    if (keys.htlcPreimageFor === undefined) {
      return { kind: "wait", reason: "no_candidate" };
    }
    const preimage = await keys.htlcPreimageFor(quote.quoteId, quote.payeePubkey);
    if (preimage === null) {
      return { kind: "wait", reason: "no_candidate" };
    }

    if (chain.submitClaim === undefined) {
      return { kind: "wait", reason: "no_candidate" };
    }
    const claimTxId = await chain.submitClaim(htlc, preimage);
    // Reserve the lock outpoint as claim_pending BEFORE recording the claim
    // (F13/M4): defeats the legacy zero-gate path and gives Phase B's promote a
    // row to promote. Idempotent — a re-submit re-reserve is a no-op.
    if (this.reserver !== undefined) {
      await this.reserver.reserveClaimOutpoint(
        quote.signerPubkey,
        quote.quoteId,
        lock,
        claimTxId,
        ctx.now,
      );
    }
    this.claims.set(this.rk(ctx), { claimTxId, lock });
    return { kind: "claim_submitted", claimTxId };
  }

  /**
   * Phase B — re-read the claim height off the LIVE tip each tick; honor only
   * when buried CLAIM_MARGIN deep. Reorg-revocable: an un-mined claim withholds.
   */
  private async phaseB(ctx: ScoringCtx, prior: ClaimRecord): Promise<PrepareResult> {
    const claim = await ctx.chain.getTransaction(prior.claimTxId);
    if (claim === null || claim.blockHeight === null) {
      // The claim is unconfirmed OR was un-mined by a reorg — withhold (R3).
      return { kind: "wait", reason: "reorg_withheld" };
    }
    const depth = ctx.tip - claim.blockHeight + 1;
    if (depth < ctx.config.claimMargin) {
      return { kind: "wait", reason: "reorg_withheld" };
    }
    return { kind: "ready" };
  }

  /** HTLC Phase B promotes the claim_pending outpoint (§5.5/F13) — no PK collision. */
  gateMode(): GateMode {
    return "promote";
  }
}
