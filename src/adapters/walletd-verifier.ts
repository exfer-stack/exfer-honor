// ADAPTER — WalletdVerifier: the ACCEPT-bridge over walletd `quote_verify` (§2.2,
// §3.4 register).
//
// ACCEPT is walletd's job (`quote_verify`, Scope::Read, PURE, key-free — SHIPPED in
// Wave 1–2). This bridge calls it to parse/validate a credential, and on
// `valid:true` produces the frozen `AcceptedQuote` the engine's `register` persists
// (R6 write-ahead). It does NOT re-implement ACCEPT — it reuses the shipped service.
//
// Wire shapes bound here (exfer-walletd/src/api/quote.rs):
//   quote_verify(params={ quote: QuoteJson }) →
//     { valid: bool, reason?: string, signer_address, payee_address, genesis_block_id }
//   QuoteJson = { version, quote_id(32hex), currency, amount_minor,
//                 rate_exfers_per_unit, exfer_amount(u64), payee_pubkey(64hex),
//                 payer_pubkey?(64hex), issued_at, expires_at, memo,
//                 signer_pubkey(64hex), signature(128hex) }
//
// Mapping notes:
//   - `payer_flag` is derived PURELY from `payer_pubkey` presence (quote.rs
//     `quote_from_json`): payer_pubkey omitted/absent ⇒ `payerPubkey: null` (R5 gate).
//   - `exfer_amount` is the ONLY binding amount (R4); it arrives as a JSON number
//     (u64) and is widened to `bigint` here at the wire boundary so the binding path
//     is bigint end-to-end (§0).
//   - the SETTLEMENT FORM is NOT carried in the quote credential (the quote spec has
//     no form field). The accepting consumer decides plain vs htlc out of band; the
//     bridge takes it as an argument (default 'plain').
//   - a `valid:false` verdict is NOT a malformed-quote exception — it is an accept
//     REJECTION; the bridge returns `{ accepted:false, reason }`. A malformed JSON
//     object (bad hex / wrong-length) surfaces as a thrown transport error (-32602),
//     which this bridge re-wraps as a `malformed_quote` HonorError.
//
// Transient-vs-terminal rule (§3.6). `quote_verify` is NOT purely a decode of the
// credential: it ALSO calls the node for the live genesis (quote.rs `quote_verify`
// → `state.node.get_block_height().await?`, ~L546). So a throw can be EITHER a
// terminal "this credential is malformed" answer (strict-decode -32602 / BadParams /
// BadHex, BEFORE any node call) OR a TRANSIENT node/transport fault (node down,
// connection refused, timeout, HTTP-5xx, an `UpstreamUnexpected`). Wrapping ALL
// throws as a terminal `malformed_quote` would permanently DECLINE a perfectly valid
// quote on a node/network blip. So:
//   - a DEFINITIVE strict-decode fault (≈ -32602 BadParams / BadHex on the credential)
//     ⇒ terminal `HonorError('malformed_quote')`.
//   - ANY OTHER throw (transport down, node 5xx, connection error, timeout,
//     `UpstreamUnexpected`) ⇒ RETRYABLE `HonorError('chain_fault')` — the genesis is
//     node-derived, so an infra fault here is a chain/node fault, NOT a verdict on the
//     credential. It MUST NOT degrade to a terminal decline.

import {
  HonorError,
  type AcceptedQuote,
  type PubKey,
  type QuoteId,
} from "../spec/index.js";
import type { SettlementFormId } from "../spec/index.js";
import type { JsonRpc } from "./indexer-chain.js";

/** The canonical quote JSON object walletd issues/verifies (quote.rs QuoteJson). */
export interface QuoteJson {
  version: number;
  quote_id: string;
  currency: string;
  amount_minor: number;
  rate_exfers_per_unit: number;
  exfer_amount: number;
  payee_pubkey: string;
  payer_pubkey?: string | null;
  issued_at: number;
  expires_at: number;
  memo: string;
  signer_pubkey: string;
  signature: string;
}

interface QuoteVerifyResult {
  valid: boolean;
  reason?: string;
  signer_address: string;
  payee_address: string;
  genesis_block_id: string;
}

export type AcceptOutcome =
  | { readonly accepted: true; readonly quote: AcceptedQuote }
  | { readonly accepted: false; readonly reason: string };

export class WalletdVerifier {
  private readonly walletd: JsonRpc;

  /**
   * @param walletd a JSON-RPC transport to exfer-walletd (the same `JsonRpc`
   *   contract the IndexerChainSource uses). The bridge calls `quote_verify`.
   */
  constructor(walletd: JsonRpc) {
    this.walletd = walletd;
  }

  /**
   * ACCEPT-check a quote credential via walletd `quote_verify`, then (on accept)
   * map it to the frozen `AcceptedQuote`. `form` selects the strategy the consumer
   * will honor under (default 'plain'); it is NOT part of the signed credential.
   *
   * A `valid:false` verdict ⇒ `{ accepted:false, reason }`. A malformed credential
   * (transport -32602 / strict-decode fault) ⇒ thrown terminal
   * `HonorError('malformed_quote')`. A TRANSIENT node/transport fault (the genesis
   * `get_block_height` call is part of `quote_verify`) ⇒ thrown RETRYABLE
   * `HonorError('chain_fault')` — never a permanent decline of a valid quote (§3.6).
   */
  async accept(
    quote: QuoteJson,
    form: SettlementFormId = "plain",
  ): Promise<AcceptOutcome> {
    let res: QuoteVerifyResult;
    try {
      res = await this.walletd.call<QuoteVerifyResult>("quote_verify", { quote });
    } catch (e) {
      // `quote_verify` strict-decodes the credential AND calls the node for the live
      // genesis (quote.rs get_block_height, ~L546). Disambiguate the throw (§3.6):
      if (isStrictDecodeFault(e)) {
        // DEFINITIVE -32602 / BadParams / BadHex: the JSON object did not strict-
        // decode (bad hex, wrong-length key). That is a TERMINAL malformed credential.
        throw new HonorError(
          "malformed_quote",
          "quote_verify rejected the credential at strict decode (≈ -32602)",
          e,
        );
      }
      // ANY OTHER throw is a TRANSIENT node/transport/infra fault (node down,
      // connection refused, timeout, 5xx, UpstreamUnexpected). The genesis is
      // node-derived, so this is a retryable chain/node fault — NOT a verdict on the
      // credential. It MUST NOT permanently decline a valid quote on a blip.
      throw new HonorError(
        "chain_fault",
        "quote_verify unavailable (transient node/transport fault during genesis fetch)",
        e,
      );
    }
    if (!res.valid) {
      return { accepted: false, reason: res.reason ?? "quote_verify: not valid" };
    }
    return { accepted: true, quote: toAcceptedQuote(quote, form) };
  }
}

/**
 * A DEFINITIVE "this credential did not strict-decode" signal (§3.6). `quote_verify`
 * raises a -32602 BadParams / BadHex BEFORE it touches the node, ONLY when the JSON
 * object is malformed (bad hex, wrong-length key, bad params). We treat ONLY those
 * explicit decode messages / the -32602 code as a TERMINAL malformed_quote; EVERY
 * other throw (transport down, node 5xx, `UpstreamUnexpected`, connection error,
 * timeout) is a transient infra fault and surfaces as a retryable `chain_fault`.
 */
function isStrictDecodeFault(e: unknown): boolean {
  // JSON-RPC -32602 (Invalid params) is the canonical strict-decode code.
  const code = (e as { code?: unknown }).code;
  if (code === -32602) return true;
  const msg = (e as { message?: unknown }).message;
  if (typeof msg !== "string") return false;
  const m = msg.toLowerCase();
  // walletd surfaces strict-decode failures as BadParams / BadHex messages; these
  // are credential-level decode errors, raised before the node get_block_height call.
  return (
    m.includes("-32602") ||
    m.includes("bad hex") ||
    m.includes("badhex") ||
    m.includes("bad params") ||
    m.includes("badparams") ||
    m.includes("invalid params") ||
    m.includes("strict decode") ||
    m.includes("wrong length") ||
    m.includes("expected") // e.g. "signature: expected N bytes, got M"
  );
}

/**
 * Map a verified `QuoteJson` to the frozen `AcceptedQuote` (§3.2). Widens the u64
 * `exfer_amount` to `bigint` at the wire boundary (§0); derives `payerPubkey: null`
 * IFF `payer_pubkey` is absent (R5 gate). Exposed for consumers that have already
 * accepted out of band and only need the value-type mapping.
 */
export function toAcceptedQuote(
  q: QuoteJson,
  form: SettlementFormId = "plain",
): AcceptedQuote {
  const payer = q.payer_pubkey;
  return {
    quoteId: q.quote_id as QuoteId,
    signerPubkey: q.signer_pubkey as PubKey,
    payeePubkey: q.payee_pubkey as PubKey,
    payerPubkey: payer === undefined || payer === null ? null : (payer as PubKey),
    exferAmount: BigInt(q.exfer_amount),
    expiresAt: q.expires_at,
    issuedAt: q.issued_at,
    form,
  };
}
