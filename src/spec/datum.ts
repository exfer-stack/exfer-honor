// THE STANDARD — the strict settlement-datum codec (§6.1, §3.7, F1).
//
// The wire datum is `SETTLEMENT_DATUM = bare 16-byte quote_id` for v1
// (SETTLEMENT_DATUM_VERSION === 1), strict-decoded with ZERO trailing bytes.
//
// Strictness is load-bearing (F1): a multi-id or trailing-byte datum would let
// ONE payment satisfy TWO quotes. `decode` returns a branded QuoteId IFF the
// input is EXACTLY 16 bytes; anything else is rejected.
//
// Version discipline (§3.7, D5): a datum encoded under one version MUST NOT
// decode under another. v1 is the bare 16-byte form. A future struct is gated
// behind a version byte and a paired decoder; `decodeSettlementDatum` accepts a
// `version` parameter so callers state which decoder they expect, and a v2 datum
// fed to the v1 decoder is rejected.

import type { Hex, QuoteId } from "./types.js";
import { SETTLEMENT_DATUM_VERSION } from "./version.js";

/** A quote_id is exactly 16 bytes. */
export const QUOTE_ID_BYTES = 16 as const;
/** ...which is 32 bare-lowercase hex characters. */
export const QUOTE_ID_HEX_LEN = QUOTE_ID_BYTES * 2;

const HEX_RE = /^[0-9a-f]*$/;

/** Outcome of a strict decode. Never throws — callers branch on `ok`. */
export type DecodeResult =
  | { readonly ok: true; readonly quoteId: QuoteId }
  | { readonly ok: false; readonly reason: DecodeFailure };

export type DecodeFailure =
  | "not_hex" // input is not bare-lowercase hex
  | "odd_length" // hex does not describe whole bytes
  | "wrong_length" // not EXACTLY 16 bytes (F1: rejects 0/1/15/17/32/…)
  | "unknown_version"; // version mismatch (§3.7)

function bytesOf(hex: Hex): number {
  return hex.length / 2;
}

/** True iff `hex` is bare-lowercase hex describing whole bytes. */
function isWellFormedHex(hex: Hex): boolean {
  return HEX_RE.test(hex) && hex.length % 2 === 0;
}

/**
 * STRICT decode (F1). Returns a branded QuoteId IFF `datumHex` is bare-lowercase
 * hex of EXACTLY 16 bytes (32 hex chars) under the stated `version`. Any other
 * length — 0, 1, 15, 17, 32 (multi-id), 4096 — is rejected with a reason.
 *
 * @param datumHex the raw settlement datum, bare lowercase hex, no `0x`.
 * @param version  which datum version the caller expects. A datum is valid only
 *                 under its own version (§3.7); default is the current
 *                 SETTLEMENT_DATUM_VERSION.
 */
export function decodeSettlementDatum(
  datumHex: Hex,
  version: number = SETTLEMENT_DATUM_VERSION,
): DecodeResult {
  if (version !== SETTLEMENT_DATUM_VERSION) {
    return { ok: false, reason: "unknown_version" };
  }
  if (!HEX_RE.test(datumHex)) {
    return { ok: false, reason: "not_hex" };
  }
  if (datumHex.length % 2 !== 0) {
    return { ok: false, reason: "odd_length" };
  }
  // v1: bare 16-byte quote_id, zero trailing bytes.
  if (bytesOf(datumHex) !== QUOTE_ID_BYTES) {
    return { ok: false, reason: "wrong_length" };
  }
  return { ok: true, quoteId: datumHex as QuoteId };
}

/**
 * Inverse of `decodeSettlementDatum`. Encodes a 16-byte quote_id into the v1
 * settlement datum (the identity, since v1 is the bare quote_id). Throws if the
 * input is not exactly a 16-byte bare-hex string — encoders MUST NOT emit a
 * malformed datum.
 */
export function encodeSettlementDatum(
  quoteId: QuoteId,
  version: number = SETTLEMENT_DATUM_VERSION,
): Hex {
  if (version !== SETTLEMENT_DATUM_VERSION) {
    throw new RangeError(`unsupported SETTLEMENT_DATUM_VERSION: ${version}`);
  }
  if (!isWellFormedHex(quoteId) || bytesOf(quoteId) !== QUOTE_ID_BYTES) {
    throw new RangeError(
      `quoteId must be exactly ${QUOTE_ID_BYTES} bytes of bare-lowercase hex`,
    );
  }
  return quoteId;
}

/**
 * Convenience strict validator: brands a raw hex string as a QuoteId or returns
 * null. The ONLY sanctioned minter of a QuoteId outside the datum decode path.
 */
export function asQuoteId(hex: Hex): QuoteId | null {
  const r = decodeSettlementDatum(hex);
  return r.ok ? r.quoteId : null;
}
