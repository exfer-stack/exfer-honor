// PORT — ChainSource: settlement / datum / depth facts (§4.2).
//
// Swappable. Today's reference impl = exfer-indexer Stage-1 (get_output_datum +
// find_settlements_by_quote_id, ALREADY SHIPPED) + node JSON-RPC. Swapping it (a
// different chain's explorer) does NOT touch forms or core.

import type { Hex, Outpoint, PubKey, QuoteId } from "../spec/index.js";

export interface RawSettlementCandidate {
  outpoint: Outpoint;
  value: bigint;
  scriptHex: Hex;
  blockHeight: number | null;
}

/** datum_hash-only ⇒ honorable:false (M2). quoteIdHex strict-single (R7/F1). */
export interface OutputDatum {
  quoteIdHex: QuoteId | null;
  honorable: boolean;
}

export interface OnChainHtlc {
  lock: Outpoint;
  receiverPubkey: PubKey;
  senderPubkey: PubKey;
  hashLock: Hex;
  timeoutHeight: number;
  value: bigint;
  lockBlockHeight: number | null;
  state: "locked" | "claimed" | "reclaimed";
}

export interface ChainSource {
  tipHeight(): Promise<number>;
  /** STRICT single-quote_id (R7/F1/M2). */
  getOutputDatum(o: Outpoint): Promise<OutputDatum>;
  /** indexer Stage-1 reverse index (single-id guarantee). */
  findSettlementsByQuoteId(q: QuoteId): Promise<RawSettlementCandidate[]>;
  getTransaction(txId: Hex): Promise<{ blockHeight: number | null } | null>;
  /** R5 SOURCE binding: prevouts feeding a settlement tx. */
  getTxInputs(txId: Hex): Promise<Array<{ prevout: Outpoint }>>;
  /** R5 prevout-script lookup. */
  getOutputScript(o: Outpoint): Promise<Hex>;
  /** HTLC form (R3). */
  getHtlc(lock: Outpoint): Promise<OnChainHtlc | null>;
  /** HTLC phase-A; returns claimTxId. Optional — forms that need it require it. */
  submitClaim?(htlc: OnChainHtlc, preimage: Hex): Promise<Hex>;
}
