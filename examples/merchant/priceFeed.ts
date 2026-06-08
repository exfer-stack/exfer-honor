// USD PRICING — "price in USD, settle in EXFER".
//
// The agent is quoted a human-meaningful USD price (e.g. $12.50 for 1000 calls),
// but the ONLY binding amount on the wire is the EXFER amount the spine checks
// against the on-chain settlement. The USD figure is just how the price was
// chosen; the issuer converts it to EXFER at quote time and signs the EXFER
// amount into the quote per EXFER-QUOTE.
//
// A PriceFeed is the pluggable seam that does that conversion. In DEMO mode we
// stub it with a fixed constant. In REAL mode the rate is NOT on-chain — there is
// no on-chain EXFER/USD oracle — so the issuer derives it off-chain:
//
//   EXFER/USD  =  (exfer-swap pool EXFER/BNB reserves)  ×  (BNB/USD feed)
//
// i.e. read the exfer-swap AMM's EXFER/BNB reserve ratio, chain it with an
// external BNB/USD price, and the issuer signs the resulting EXFER amount into the
// quote. The agent only ever verifies/settles the signed EXFER amount; the USD
// line is informational.

/** EXFER is a u64 minor-unit token; 1 EXFER = 1e8 base units (like sats). */
export const EXFER_PER_WHOLE = 100_000_000n;

/**
 * Convert a USD price (in integer minor units, i.e. cents) to a binding EXFER
 * base-unit amount. This is the only seam the issuer plugs a real rate into.
 *
 * @param amountMinorUsd  USD price in cents (e.g. 1250 = $12.50).
 * @returns               EXFER amount in base units (the quote's binding amount).
 */
export type PriceFeed = (amountMinorUsd: number) => bigint;

/** Human label for what a PriceFeed's rate means, for narration. */
export interface PriceQuote {
  readonly usdMinor: number; // cents
  readonly usdPerExfer: number; // e.g. 0.025  ($ per 1 EXFER)
  readonly exferAmount: bigint; // base units — the binding amount
}

/**
 * DEMO price feed: a fixed stub rate of 1 EXFER = $0.025 (so $1 = 40 EXFER).
 *
 * In REAL mode, swap this for a feed that reads the exfer-swap EXFER/BNB pool
 * reserves and chains them with a BNB/USD source (see file header) — the SAME
 * function signature, so `buildQuotePrice` / the merchant never change.
 */
export const DEMO_USD_PER_EXFER = 0.025; // $ per 1 whole EXFER

export const demoPriceFeed: PriceFeed = (amountMinorUsd: number): bigint => {
  // dollars = cents / 100;  wholeExfer = dollars / usdPerExfer;  base = whole * 1e8.
  // Done in integer math to stay deterministic and avoid float base-unit drift.
  // base = cents * 1e8 / (100 * usdPerExfer) ; with usdPerExfer = 0.025 → *1e8/2.5.
  const numer = BigInt(amountMinorUsd) * EXFER_PER_WHOLE;
  // 100 * 0.025 = 2.5 → multiply by 10 and divide by 25 to keep it integral.
  return (numer * 10n) / 25n;
};

/**
 * Build a full price quote from a USD price using the given feed. The merchant
 * calls this at quote time; only `exferAmount` is binding (signed into the quote).
 */
export function buildQuotePrice(
  usdMinor: number,
  feed: PriceFeed = demoPriceFeed,
  usdPerExfer: number = DEMO_USD_PER_EXFER,
): PriceQuote {
  return {
    usdMinor,
    usdPerExfer,
    exferAmount: feed(usdMinor),
  };
}

/** Format a cents amount as "$12.50" for narration. */
export function formatUsd(usdMinor: number): string {
  return `$${(usdMinor / 100).toFixed(2)}`;
}
