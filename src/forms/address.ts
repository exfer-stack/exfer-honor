// FORMS — the R4 payee/payer address binding: domain_hash(EXFER-ADDR, pubkey).
//
// §6.1 step 4 requires `candidate.scriptHex === domain_hash(EXFER-ADDR,
// payeePubkey)` — a domain-tagged commitment to the payee key, with NO datum_hash
// address+amount fallback (R4/M2). The CONCRETE hash is a chain/wallet detail
// (walletd's domain-tagged hashing), so the library does NOT bake a specific
// digest in: the binding is computed through an INJECTABLE `AddressDeriver` carried
// on `HonorConfig.addressDeriver`. A consumer wires the deriver its chain actually
// uses (e.g. the real EXFER-ADDR domain hash); swapping chains does not touch the
// form (§4.2 reuse-of-services spirit).
//
// When no deriver is injected, a deterministic reference derivation is used so the
// forms are testable end-to-end with the in-memory fakes. It is a STRUCTURAL
// placeholder (domain-tag-prefixed, pubkey-committed, bare-lowercase hex) — NOT a
// security-reviewed digest — and is documented as such; production consumers MUST
// inject the real deriver.

import type { Hex, PubKey } from "../spec/index.js";

/** The EXFER-ADDR domain tag (ASCII), hex-encoded, prefixed to the commitment. */
export const EXFER_ADDR_DOMAIN_TAG = "exfer-addr";

/**
 * Derives the expected output script (bare lowercase hex) committing to a pubkey
 * under the EXFER-ADDR domain. INJECTED via `HonorConfig.addressDeriver`; the
 * library never assumes a specific on-chain script format.
 */
export type AddressDeriver = (pubkey: PubKey) => Hex;

const HEX_RE = /^[0-9a-f]*$/;

/**
 * Reference (placeholder) EXFER-ADDR derivation: a domain-tag-prefixed,
 * pubkey-committed bare-lowercase hex string. Deterministic and total over any
 * bare-hex pubkey. NOT a cryptographic digest — a production consumer MUST inject
 * the real `AddressDeriver`. Kept pure (no node `crypto` import) so `/forms`
 * stays free of runtime deps per the §2.3 layering rule.
 */
export function referenceAddressDeriver(pubkey: PubKey): Hex {
  const tagHex = asciiToHex(EXFER_ADDR_DOMAIN_TAG);
  const key = HEX_RE.test(pubkey) ? pubkey : asciiToHex(pubkey);
  // A small, deterministic mixing fold so the result is not a trivial
  // concatenation a caller could forge by substring — still a placeholder.
  const folded = fold(`${tagHex}:${key}`);
  return `${tagHex}${folded}`;
}

/**
 * Compute the expected address script for a pubkey under the EXFER-ADDR domain,
 * using the injected deriver if present, else the reference derivation.
 */
export function domainHashAddr(pubkey: PubKey, deriver?: AddressDeriver): Hex {
  return (deriver ?? referenceAddressDeriver)(pubkey);
}

function asciiToHex(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i += 1) {
    out += s.charCodeAt(i).toString(16).padStart(2, "0");
  }
  return out;
}

/** Deterministic 64-hex fold (FNV-1a-ish over two 32-bit lanes). Placeholder. */
function fold(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ ((c << 5) | (c >>> 3)), 0x85ebca6b) >>> 0;
  }
  const lane = (h: number) => (h >>> 0).toString(16).padStart(8, "0");
  // 16 hex of structural commitment, repeated to a stable 64-hex script body.
  const core = `${lane(h1)}${lane(h2)}`;
  return `${core}${core}${core}${core}`.slice(0, 56);
}
