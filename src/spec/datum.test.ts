// Datum codec — the one pure piece of Stage 2. Strictness is load-bearing (F1):
// a multi-id / trailing-byte datum would let ONE payment satisfy TWO quotes.
// Run: npm test
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  QUOTE_ID_BYTES,
  QUOTE_ID_HEX_LEN,
  asQuoteId,
  decodeSettlementDatum,
  encodeSettlementDatum,
} from "./datum.js";
import type { QuoteId } from "./types.js";
import { SETTLEMENT_DATUM_VERSION } from "./version.js";

const HEX16 = "0123456789abcdef0123456789abcdef"; // exactly 16 bytes / 32 hex chars

function hexOfBytes(n: number): string {
  return "a".repeat(n * 2);
}

test("constants pin the 16-byte / 32-hex-char shape", () => {
  assert.equal(QUOTE_ID_BYTES, 16);
  assert.equal(QUOTE_ID_HEX_LEN, 32);
  assert.equal(HEX16.length, QUOTE_ID_HEX_LEN);
});

test("decode accepts EXACTLY 16 bytes → QuoteId", () => {
  const r = decodeSettlementDatum(HEX16);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.quoteId, HEX16);
  }
});

test("decode rejects every non-16-byte length (F1): 0/1/15/17/32/4096", () => {
  for (const bytes of [0, 1, 15, 17, 32, 4096]) {
    const r = decodeSettlementDatum(hexOfBytes(bytes));
    assert.equal(r.ok, false, `${bytes} bytes must be rejected`);
    if (!r.ok) {
      assert.equal(r.reason, "wrong_length", `${bytes} bytes → wrong_length`);
    }
  }
});

test("decode rejects the F1 multi-id attack (two concatenated quote_ids = 32 bytes)", () => {
  const twoIds = HEX16 + HEX16; // 32 bytes
  const r = decodeSettlementDatum(twoIds);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.reason, "wrong_length");
  }
});

test("decode rejects a 16-byte quote_id with trailing bytes (zero-trailing, F1/R7)", () => {
  const r = decodeSettlementDatum(`${HEX16}deadbeef`);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.reason, "wrong_length");
  }
});

test("decode rejects non-hex and uppercase (bare lowercase only)", () => {
  for (const bad of ["zz".repeat(16), "ABCDEF0123456789ABCDEF0123456789", `0x${HEX16}`]) {
    const r = decodeSettlementDatum(bad);
    assert.equal(r.ok, false, `${bad} must be rejected`);
    if (!r.ok) {
      assert.equal(r.reason, "not_hex");
    }
  }
});

test("decode rejects odd-length hex", () => {
  const r = decodeSettlementDatum("abc"); // 3 hex chars
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.reason, "odd_length");
  }
});

test("version-byte discipline: a datum is not decodable under an unknown version (§3.7)", () => {
  const r = decodeSettlementDatum(HEX16, SETTLEMENT_DATUM_VERSION + 1);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.reason, "unknown_version");
  }
  // Default version still decodes the same input.
  assert.equal(decodeSettlementDatum(HEX16).ok, true);
});

test("encode/decode round-trip the v1 bare quote_id", () => {
  const qid = HEX16 as QuoteId;
  const wire = encodeSettlementDatum(qid);
  assert.equal(wire, HEX16);
  const back = decodeSettlementDatum(wire);
  assert.equal(back.ok, true);
  if (back.ok) {
    assert.equal(back.quoteId, qid);
  }
});

test("encode rejects a malformed quote_id (encoders must not emit bad datums)", () => {
  assert.throws(() => encodeSettlementDatum(hexOfBytes(15) as QuoteId));
  assert.throws(() => encodeSettlementDatum(hexOfBytes(17) as QuoteId));
  assert.throws(() => encodeSettlementDatum("zz".repeat(16) as QuoteId));
  assert.throws(() =>
    encodeSettlementDatum(HEX16 as QuoteId, SETTLEMENT_DATUM_VERSION + 1),
  );
});

test("asQuoteId brands a valid 16-byte hex and rejects otherwise", () => {
  assert.equal(asQuoteId(HEX16), HEX16);
  assert.equal(asQuoteId(hexOfBytes(32)), null);
  assert.equal(asQuoteId("nothex"), null);
});
