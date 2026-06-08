// SCENARIO DRIVER (demo only) — scripts realistic chain facts the REAL engine
// then scores. It NEVER rigs the engine or the gate: it only makes settlements
// "appear" (push a candidate the indexer fake returns) and "confirm to depth"
// (advance the fake tip/clock). Every honor/decline verdict in the demo comes
// from the real PlainOutputForm binding spine + the real §5 SqliteStore gate.

import {
  asQuoteId,
  type AcceptedQuote,
  type PubKey,
  type QuoteId,
} from "exfer-honor";
import {
  PAYEE,
  PAYEE_SCRIPT,
  SIGNER,
  defaultConfig,
} from "exfer-honor/conformance";
import type { DemoPorts } from "./service.js";

/** The locked safe defaults the demo runs under (CONFIRMATION_DEPTH = 6). */
export const CONFIG = defaultConfig();

/** A fresh 32-hex quote_id from a short label (deterministic, distinct per scenario). */
export function quoteId(label: string): QuoteId {
  const base = label.replace(/[^0-9a-f]/g, "");
  const hex = (base + "0".repeat(32)).slice(0, 32);
  const q = asQuoteId(hex);
  if (q === null) throw new Error(`bad demo quote_id seed: ${label}`);
  return q;
}

/**
 * Build an AcceptedQuote the agent has already accepted out of band. In real
 * mode this comes from `service.verifier.accept(credential)` (the agent's
 * exfer-mcp wallet presents a settlement credential); here we mint the frozen
 * value type directly so the demo needs no walletd. `amount` is the binding
 * EXFER base-unit amount the issuer derived from the USD price (see priceFeed.ts).
 */
export function acceptedQuote(opts: {
  quoteId: QuoteId;
  amount: bigint;
  expiresAt: number;
}): AcceptedQuote {
  return {
    quoteId: opts.quoteId,
    signerPubkey: SIGNER as PubKey,
    payeePubkey: PAYEE as PubKey,
    payerPubkey: null,
    exferAmount: opts.amount,
    expiresAt: opts.expiresAt,
    issuedAt: 0,
    form: "plain",
  };
}

/** Set the fake wall clock (seconds). */
export function setClock(demo: DemoPorts, t: number): void {
  demo.clock.t = t;
}

/** Set the fake chain tip height. */
export function setTip(demo: DemoPorts, height: number): void {
  demo.chain.tip = height;
}

/**
 * Make a binding-valid settlement for `quote` APPEAR on-chain at `blockHeight`
 * (null ⇒ still in the mempool, unconfirmed). The candidate pays PAYEE_SCRIPT the
 * exact amount and carries the quote_id datum — exactly what the real spine wants.
 */
export function settlementAppears(
  demo: DemoPorts,
  quote: AcceptedQuote,
  blockHeight: number | null,
): void {
  const outpoint = { txId: `set_${quote.quoteId.slice(0, 8)}`, outputIndex: 0 };
  demo.chain.defaultDatum = { quoteIdHex: quote.quoteId, honorable: true };
  demo.chain.datums.set(`${outpoint.txId}:${outpoint.outputIndex}`, {
    quoteIdHex: quote.quoteId,
    honorable: true,
  });
  demo.chain.candidates = [
    {
      outpoint,
      value: quote.exferAmount,
      scriptHex: PAYEE_SCRIPT,
      blockHeight,
    },
  ];
}

/** Confirmation depth of the current candidate off the live tip (R4 metric). */
export function currentDepth(demo: DemoPorts): number | null {
  const c = demo.chain.candidates[0];
  if (!c || c.blockHeight === null) return null;
  return demo.chain.tip - c.blockHeight + 1;
}

/** Wipe the chain back to "nothing has settled" between scenarios. */
export function resetChain(demo: DemoPorts): void {
  demo.chain.candidates = [];
  demo.chain.datums.clear();
  demo.chain.defaultDatum = { quoteIdHex: null, honorable: true };
}
