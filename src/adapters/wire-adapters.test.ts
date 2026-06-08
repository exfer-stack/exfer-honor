// ADAPTER UNIT — IndexerChainSource / WalletdVerifier / KeystoreKeyCustody against
// a fake JSON-RPC transport that returns the REAL wire shapes (exfer-indexer
// api/mod.rs, exfer-walletd api/quote.rs). These tests pin the wire→value-type
// mappings the adapters are responsible for, without a live node/indexer/walletd:
//
//   IndexerChainSource:
//     - M2 negation: indexer `unhonorable:true` → OutputDatum.honorable=false.
//     - a missing datum (quote_id:null, unhonorable:false) → honorable=false.
//     - find_settlements_by_quote_id joins each outpoint with the node's
//       `get_transaction` (TxStatus.tx_hex parsed for value/script, block_height
//       for depth); supports MULTIPLE outpoints (gate enforces 1:1, F3).
//     - HTLC state normalisation (real HtlcRecord shape; 'locked_expired' → 'locked').
//     - submitClaim is present ONLY when a submitter was wired.
//   WalletdVerifier:
//     - valid:true → AcceptedQuote with payer_flag derived from payer_pubkey.
//     - valid:false → { accepted:false, reason }.
//     - a -32602 strict-decode throw → terminal HonorError('malformed_quote').
//     - a TRANSIENT node/transport fault (quote_verify also fetches the live
//       genesis) → retryable HonorError('chain_fault'), NOT a terminal decline.
//   KeystoreKeyCustody:
//     - a successful test-sign → controlsPayee true.
//     - a definitive "no such key" → false (terminal negative, R2/M3).
//     - a transient transport fault → thrown keystore_fault (NEVER false).
//
// Run: npm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { HonorError } from "../spec/index.js";
import type { PubKey, QuoteId } from "../spec/index.js";
import { IndexerChainSource, type JsonRpc } from "./indexer-chain.js";
import { WalletdVerifier, type QuoteJson } from "./walletd-verifier.js";
import { KeystoreKeyCustody } from "./keystore-custody.js";

/** A fake JSON-RPC transport: a method→handler map over the real wire shapes. */
class FakeRpc implements JsonRpc {
  constructor(private readonly handlers: Record<string, (params: unknown) => unknown>) {}
  async call<R>(method: string, params: unknown): Promise<R> {
    const h = this.handlers[method];
    if (h === undefined) throw new Error(`unexpected RPC ${method}`);
    return h(params) as R;
  }
}

const QID = "0123456789abcdef0123456789abcdef" as QuoteId;
const PAYEE = "22".repeat(32) as PubKey;

// ---------------------------------------------------------------------------
// IndexerChainSource
// ---------------------------------------------------------------------------

test("IndexerChainSource: M2 — indexer unhonorable:true maps to honorable:false", async () => {
  const indexer = new FakeRpc({
    get_output_datum: () => ({ quote_id: null, unhonorable: true }),
  });
  const node = new FakeRpc({});
  const chain = new IndexerChainSource({ indexer, node });
  const d = await chain.getOutputDatum({ txId: "aa", outputIndex: 0 });
  assert.equal(d.honorable, false);
  assert.equal(d.quoteIdHex, null);
});

test("IndexerChainSource: a missing datum (quote_id:null, unhonorable:false) is honorable:false", async () => {
  const indexer = new FakeRpc({
    get_output_datum: () => ({ quote_id: null, unhonorable: false }),
  });
  const chain = new IndexerChainSource({ indexer, node: new FakeRpc({}) });
  const d = await chain.getOutputDatum({ txId: "aa", outputIndex: 0 });
  assert.equal(d.honorable, false, "no inline quote_id ⇒ not honorable");
});

test("IndexerChainSource: a strict inline quote_id is honorable and surfaced", async () => {
  const indexer = new FakeRpc({
    get_output_datum: () => ({ quote_id: QID, unhonorable: false }),
  });
  const chain = new IndexerChainSource({ indexer, node: new FakeRpc({}) });
  const d = await chain.getOutputDatum({ txId: "aa", outputIndex: 0 });
  assert.equal(d.honorable, true);
  assert.equal(d.quoteIdHex, QID);
});

test("IndexerChainSource: findSettlementsByQuoteId parses node tx_hex; supports multiple (F3 facts)", async () => {
  // Real wire: the node has no `get_output`; `get_transaction` returns a TxStatus
  // whose `tx_hex` is the canonical tx (exfer/src/types/transaction.rs). Per-output
  // value/script are parsed out of those bytes; depth comes from `block_height`.
  //
  // tx "aa": 0 inputs, 1 output #0 = { value: 100, script: "dead" }.
  const TX_AA =
    "0000" + // input_count = 0
    "0100" + // output_count = 1
    "6400000000000000" + // value = 100 (u64 LE)
    "0200dead" + // script varbytes: len 2 + "dead"
    "00" + // has_datum = 0
    "00"; // has_datum_hash = 0
  // tx "bb": 0 inputs, 2 outputs; output #1 = { value: 200, script: "beef" }.
  const TX_BB =
    "0000" + // input_count = 0
    "0200" + // output_count = 2
    // output #0 (filler): value 1, empty script, no datum/hash
    "0100000000000000" +
    "0000" +
    "00" +
    "00" +
    // output #1: value 200, script "beef"
    "c800000000000000" +
    "0200beef" +
    "00" +
    "00";
  const indexer = new FakeRpc({
    find_settlements_by_quote_id: () => ({
      settlements: [
        { tx_id: "aa", output_index: 0 },
        { tx_id: "bb", output_index: 1 },
      ],
    }),
  });
  const node = new FakeRpc({
    get_transaction: (p) => {
      const { hash } = p as { hash: string };
      return hash === "aa"
        ? { tx_id: "aa", tx_hex: TX_AA, in_mempool: false, block_height: 90 }
        : { tx_id: "bb", tx_hex: TX_BB, in_mempool: true, block_height: null };
    },
  });
  const chain = new IndexerChainSource({ indexer, node });
  const cands = await chain.findSettlementsByQuoteId(QID);
  assert.equal(cands.length, 2);
  assert.equal(cands[0]?.value, 100n);
  assert.equal(cands[0]?.scriptHex, "dead");
  assert.equal(cands[0]?.blockHeight, 90);
  assert.equal(cands[1]?.value, 200n, "second output's value parsed from tx_hex");
  assert.equal(cands[1]?.scriptHex, "beef");
  assert.equal(cands[1]?.blockHeight, null, "unconfirmed (mempool) tx → null height");
});

test("IndexerChainSource: getTxInputs / getOutputScript parse the node's tx_hex (R5)", async () => {
  // tx "spend": 1 input (prevout (aa…, 3)), 1 output #0 script "cafe".
  //   header:  input_count=1 (0100) | output_count=1 (0100)
  //   input:   prev_tx_id=PREV | output_index=3 (03000000)
  //   output:  value=16 (1000000000000000) | script "cafe" (0200cafe) | no datum/hash (0000)
  const PREV = "aa".repeat(32);
  const TX_SPEND = `01000100${PREV}0300000010000000000000000200cafe0000`;
  const node = new FakeRpc({
    get_transaction: (p) => {
      const { hash } = p as { hash: string };
      assert.equal(
        hash,
        "spend",
        "get_transaction is called with { hash }, not { tx_id }",
      );
      return { tx_id: "spend", tx_hex: TX_SPEND, in_mempool: false, block_height: 7 };
    },
  });
  const chain = new IndexerChainSource({ indexer: new FakeRpc({}), node });
  const inputs = await chain.getTxInputs("spend");
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0]?.prevout.txId, PREV);
  assert.equal(inputs[0]?.prevout.outputIndex, 3);
  const script = await chain.getOutputScript({ txId: "spend", outputIndex: 0 });
  assert.equal(script, "cafe");
});

test("IndexerChainSource: htlc_status binds the real HtlcRecord shape; miss → null", async () => {
  // Real wire: htlc_status returns a serialized exfer::covenants::htlc::HtlcRecord
  // — params nested ({ sender, receiver, hash_lock, timeout_height }), value =
  // `amount`, snake_case `state`. 'reclaimed' (timeout arm) → 'reclaimed'.
  const indexer = new FakeRpc({
    htlc_status: (p) => {
      const { lock_tx_id } = p as { lock_tx_id: string };
      if (lock_tx_id === "missing") {
        throw new Error("no indexed HTLC at (missing, 0)");
      }
      return {
        lock_tx_id,
        output_index: 0,
        params: {
          sender: "33".repeat(32),
          receiver: PAYEE,
          hash_lock: "abcd",
          timeout_height: 10_000,
        },
        amount: "100000000",
        lock_block_height: 90,
        state: "reclaimed",
        role: "receiver",
        last_indexed_height: 120,
      };
    },
  });
  const chain = new IndexerChainSource({ indexer, node: new FakeRpc({}) });
  const htlc = await chain.getHtlc({ txId: "lock0", outputIndex: 0 });
  assert.equal(htlc?.state, "reclaimed");
  assert.equal(htlc?.value, 100_000_000n, "value bound from HtlcRecord.amount");
  assert.equal(htlc?.receiverPubkey, PAYEE, "receiver from params");
  assert.equal(htlc?.senderPubkey, "33".repeat(32), "sender from params");
  assert.equal(htlc?.timeoutHeight, 10_000);
  const miss = await chain.getHtlc({ txId: "missing", outputIndex: 0 });
  assert.equal(miss, null, "an un-indexed lock maps to null, not a throw");
});

test("IndexerChainSource: HtlcState 'locked_expired' normalises to 'locked' (still a live lock)", async () => {
  const indexer = new FakeRpc({
    htlc_status: () => ({
      lock_tx_id: "lk",
      output_index: 0,
      params: {
        sender: "33".repeat(32),
        receiver: PAYEE,
        hash_lock: "abcd",
        timeout_height: 10_000,
      },
      amount: 5,
      lock_block_height: 90,
      state: "locked_expired",
      role: "receiver",
      last_indexed_height: 120,
    }),
  });
  const chain = new IndexerChainSource({ indexer, node: new FakeRpc({}) });
  const htlc = await chain.getHtlc({ txId: "lk", outputIndex: 0 });
  assert.equal(htlc?.state, "locked", "locked_expired is still in the UTXO set ⇒ locked");
});

test("IndexerChainSource: submitClaim is present only when a submitter is wired", async () => {
  const a = new IndexerChainSource({ indexer: new FakeRpc({}), node: new FakeRpc({}) });
  assert.equal(a.submitClaim, undefined);
  const b = new IndexerChainSource({
    indexer: new FakeRpc({}),
    node: new FakeRpc({}),
    claimSubmit: async () => "claimtx",
  });
  assert.equal(typeof b.submitClaim, "function");
  assert.equal(await b.submitClaim?.({} as never, "pre"), "claimtx");
});

// ---------------------------------------------------------------------------
// WalletdVerifier
// ---------------------------------------------------------------------------

function quoteJson(over: Partial<QuoteJson> = {}): QuoteJson {
  return {
    version: 1,
    quote_id: QID,
    currency: "USD",
    amount_minor: 1250,
    rate_exfers_per_unit: 4_000_000_000,
    exfer_amount: 50_000_000_000,
    payee_pubkey: PAYEE,
    issued_at: 1_000,
    expires_at: 1_300,
    memo: "",
    signer_pubkey: "11".repeat(32),
    signature: "00".repeat(64),
    ...over,
  };
}

test("WalletdVerifier: valid:true maps to AcceptedQuote; payer_flag null when payer absent", async () => {
  const walletd = new FakeRpc({
    quote_verify: () => ({
      valid: true,
      signer_address: "sa",
      payee_address: "pa",
      genesis_block_id: "gen",
    }),
  });
  const v = new WalletdVerifier(walletd);
  const out = await v.accept(quoteJson());
  assert.equal(out.accepted, true);
  if (out.accepted) {
    assert.equal(out.quote.quoteId, QID);
    assert.equal(
      out.quote.payerPubkey,
      null,
      "payer absent → payerPubkey null (R5 gate)",
    );
    assert.equal(out.quote.exferAmount, 50_000_000_000n, "u64 widened to bigint");
    assert.equal(out.quote.form, "plain", "default form");
  }
});

test("WalletdVerifier: a present payer_pubkey is carried through", async () => {
  const walletd = new FakeRpc({
    quote_verify: () => ({
      valid: true,
      signer_address: "sa",
      payee_address: "pa",
      genesis_block_id: "gen",
    }),
  });
  const v = new WalletdVerifier(walletd);
  const out = await v.accept(quoteJson({ payer_pubkey: "44".repeat(32) }), "htlc");
  assert.equal(out.accepted && out.quote.payerPubkey, "44".repeat(32));
  assert.equal(out.accepted && out.quote.form, "htlc");
});

test("WalletdVerifier: valid:false returns accepted:false with the reason (no throw)", async () => {
  const walletd = new FakeRpc({
    quote_verify: () => ({
      valid: false,
      reason: "quote has expired",
      signer_address: "sa",
      payee_address: "pa",
      genesis_block_id: "gen",
    }),
  });
  const out = await new WalletdVerifier(walletd).accept(quoteJson());
  assert.equal(out.accepted, false);
  assert.equal(out.accepted === false && out.reason, "quote has expired");
});

test("WalletdVerifier: a -32602 strict-decode throw → terminal HonorError('malformed_quote')", async () => {
  const walletd = new FakeRpc({
    quote_verify: () => {
      throw new Error("quote_verify params: bad hex");
    },
  });
  await assert.rejects(
    () => new WalletdVerifier(walletd).accept(quoteJson()),
    (e: unknown) => e instanceof HonorError && e.code === "malformed_quote",
  );
});

test("WalletdVerifier: a transient node/transport fault → retryable chain_fault (NOT a terminal malformed_quote)", async () => {
  // quote_verify ALSO fetches the live genesis via the node (quote.rs
  // get_block_height). A node-down / connection error there throws — but the
  // credential is fine. It MUST surface as a RETRYABLE chain_fault, never as a
  // terminal malformed_quote that would permanently decline a valid quote on a blip.
  for (const transient of [
    "connection refused",
    "request timed out",
    "node get_block_height returned no genesis_block_id", // UpstreamUnexpected
    "HTTP 503 Service Unavailable",
    "ECONNRESET",
  ]) {
    const walletd = new FakeRpc({
      quote_verify: () => {
        throw new Error(transient);
      },
    });
    await assert.rejects(
      () => new WalletdVerifier(walletd).accept(quoteJson()),
      (e: unknown) => {
        assert.ok(e instanceof HonorError, `${transient}: expected HonorError`);
        assert.equal(
          (e as HonorError).code,
          "chain_fault",
          `${transient}: must be retryable chain_fault, not a terminal decline`,
        );
        assert.notEqual(
          (e as HonorError).code,
          "malformed_quote",
          `${transient}: a transient fault must NOT wrongly map to malformed_quote`,
        );
        return true;
      },
    );
  }
});

test("WalletdVerifier: a JSON-RPC -32602 code (no message match) → terminal malformed_quote", async () => {
  // The code path, not just message sniffing: a structured -32602 invalid-params
  // error is a definitive strict-decode fault → terminal malformed_quote.
  const walletd = new FakeRpc({
    quote_verify: () => {
      const err = new Error("invalid request") as Error & { code: number };
      err.code = -32602;
      throw err;
    },
  });
  await assert.rejects(
    () => new WalletdVerifier(walletd).accept(quoteJson()),
    (e: unknown) => e instanceof HonorError && e.code === "malformed_quote",
  );
});

// ---------------------------------------------------------------------------
// KeystoreKeyCustody — the transient-vs-terminal rule (§3.6)
// ---------------------------------------------------------------------------

test("KeystoreKeyCustody: a successful test-sign → controlsPayee true (R2/M3)", async () => {
  const walletd = new FakeRpc({ sign_message: () => ({ signature: "deadbeef" }) });
  const keys = new KeystoreKeyCustody({ walletd });
  assert.equal(await keys.controlsPayee(PAYEE), true);
});

test("KeystoreKeyCustody: a definitive 'no such key' → false (terminal negative)", async () => {
  const walletd = new FakeRpc({
    sign_message: () => {
      throw new Error("no such wallet for address");
    },
  });
  const keys = new KeystoreKeyCustody({ walletd });
  assert.equal(await keys.controlsPayee(PAYEE), false);
});

test("KeystoreKeyCustody: a transient fault THROWS keystore_fault (never false)", async () => {
  const walletd = new FakeRpc({
    sign_message: () => {
      throw new Error("connection refused");
    },
  });
  const keys = new KeystoreKeyCustody({ walletd });
  await assert.rejects(
    () => keys.controlsPayee(PAYEE),
    (e: unknown) => e instanceof HonorError && e.code === "keystore_fault",
  );
});

test("KeystoreKeyCustody: htlcPreimageFor present only when a lookup is wired", async () => {
  const walletd = new FakeRpc({ sign_message: () => ({ signature: "ab" }) });
  const a = new KeystoreKeyCustody({ walletd });
  assert.equal(a.htlcPreimageFor, undefined);
  const b = new KeystoreKeyCustody({
    walletd,
    preimageLookup: async () => "pre1mage",
  });
  assert.equal(typeof b.htlcPreimageFor, "function");
  assert.equal(await b.htlcPreimageFor?.(QID, PAYEE), "pre1mage");
});
