// ADAPTER — IndexerChainSource: the reference `ChainSource` over exfer-indexer
// Stage-1 + node JSON-RPC (§2.2, §4.2).
//
// Reuses the ALREADY-SHIPPED exfer-indexer Stage-1 RPCs (exfer-indexer/src/api/mod.rs):
//   - get_output_datum            → { quote_id: <hex|null>, unhonorable: <bool> }
//   - find_settlements_by_quote_id→ { settlements: [{ tx_id, output_index }] }
//   - htlc_status                 → an HtlcRecord (lock outpoint, params, amount,
//                                    role, state, …) — see exfer::covenants::htlc.
// plus exfer node JSON-RPC for depth / prevouts:
//   - get_block_height            → { height, block_id }  (tip)
//   - get_transaction             → a TxStatus { tx_id, tx_hex, in_mempool,
//                                    block_id?, block_height? }
//
// CRITICAL (CHAINSOURCE WIRING): the real exfer node has NO `get_output` RPC, and
// its `get_transaction` returns the transaction ONLY as raw `tx_hex` (a TxStatus —
// no `inputs`/`outputs` arrays; see exfer/src/rpc.rs handle_get_transaction and
// exfer/src/types/transaction.rs). So per-output value/script (R4 amount/address,
// R5 prevout-script) and a tx's prevouts (R5 SOURCE binding) MUST be parsed out of
// the canonical tx wire bytes, not fetched from an invented RPC. `decodeTxHex`
// below is the deterministic decoder for that wire format. Also: `get_transaction`
// takes `{ hash: <hex> }`, NOT `{ tx_id }` (both exfer-indexer and exfer-walletd
// node clients send `{ "hash": … }`); an unknown `tx_id` field is dropped by serde
// and the call fails to find the tx.
//
// CRITICAL mapping (M2): the indexer returns `unhonorable: bool`, NOT `honorable`.
// `OutputDatum.honorable` is its NEGATION: a datum_hash-only output is
// `unhonorable:true` ⇒ `honorable:false` ⇒ the spine declines `datum_unhonorable`
// with no address+amount fallback. An outpoint with no indexed datum yields
// `{ quote_id: null, unhonorable: false }` ⇒ `honorable:false` (quote_id is null,
// so the spine still declines). The library never trusts a missing quote_id.
//
// The indexer's `find_settlements_by_quote_id` CAN return multiple outpoints (it
// reports facts; the gate enforces 1:1, F3). This adapter surfaces all of them; the
// form's `score` skips non-matching and the gate consumes exactly one (R1).
//
// The two RPC transports (indexer, node) are injected as a single `JsonRpc`
// interface so the adapter is testable against a fake transport and a live node is
// not required for the conformance/integration suite.

import type {
  ChainSource,
  OnChainHtlc,
  OutputDatum,
  RawSettlementCandidate,
} from "../ports/index.js";
import type { Hex, Outpoint, PubKey, QuoteId } from "../spec/index.js";

/** A minimal JSON-RPC caller. `call(method, params)` → the `result` value (the
 *  transport unwraps the JSON-RPC envelope and throws on an error response). */
export interface JsonRpc {
  call<R = unknown>(method: string, params: unknown): Promise<R>;
}

/** The exfer-indexer `get_output_datum` result shape (api/mod.rs). */
interface RawOutputDatum {
  quote_id: string | null;
  unhonorable: boolean;
}

/** The exfer-indexer `find_settlements_by_quote_id` result shape. */
interface RawFindSettlements {
  settlements: Array<{ tx_id: string; output_index: number }>;
}

/** The exfer node `get_block_height` result shape (tip). */
interface RawBlockHeight {
  height: number;
}

/**
 * The exfer node `get_transaction` result shape — a `TxStatus`
 * (exfer-indexer/src/upstream.rs, exfer-walletd/src/upstream/mod.rs). The node
 * returns the transaction as raw `tx_hex` ONLY; there is no `inputs`/`outputs`
 * field, so this adapter parses value/script/prevouts out of `tx_hex` via
 * `decodeTxHex`. `block_height` is `null` while the tx is still in the mempool.
 */
interface RawTxStatus {
  tx_id: string;
  tx_hex: string;
  in_mempool?: boolean;
  block_id?: string | null;
  block_height?: number | null;
}

/**
 * The exfer-indexer `htlc_status` result shape — a serialized
 * `exfer::covenants::htlc::HtlcRecord` (exfer/src/covenants/htlc.rs). The HTLC
 * parameters are NESTED under `params` ({ sender, receiver, hash_lock,
 * timeout_height }); the value field is `amount`; `state`/`role` are
 * snake_case enums. (Earlier this adapter bound flat top-level
 * receiver_pubkey/sender_pubkey/value fields that the real record does not have.)
 */
interface RawHtlcParams {
  sender: string;
  receiver: string;
  hash_lock: string;
  timeout_height: number;
}
interface RawHtlcRecord {
  lock_tx_id: string;
  output_index: number;
  params: RawHtlcParams;
  amount: number | string;
  lock_block_height: number | null;
  // 'locked' | 'locked_expired' | 'claimed' | 'reclaimed' | 'unknown'
  state: string;
}

/** One decoded transaction output (value + script). */
interface DecodedOutput {
  value: bigint;
  scriptHex: Hex;
}

/** A decoded transaction body: outputs (R4/R5 value+script) and inputs (R5 prevouts). */
interface DecodedTx {
  inputs: Array<{ prevTxId: Hex; prevOutputIndex: number }>;
  outputs: DecodedOutput[];
}

export interface IndexerChainSourceOpts {
  /** transport to the exfer-indexer JSON-RPC (Stage-1 RPCs). */
  readonly indexer: JsonRpc;
  /** transport to the exfer node JSON-RPC (depth / prevouts). */
  readonly node: JsonRpc;
  /** optional: submit an HTLC claim. Bound to a signing transport (e.g. walletd)
   *  when the consumer wires HTLC honoring; absent for plain-only deployments. */
  readonly claimSubmit?: (htlc: OnChainHtlc, preimage: Hex) => Promise<Hex>;
}

export class IndexerChainSource implements ChainSource {
  private readonly indexer: JsonRpc;
  private readonly node: JsonRpc;
  private readonly claimSubmit?: (htlc: OnChainHtlc, preimage: Hex) => Promise<Hex>;

  constructor(opts: IndexerChainSourceOpts) {
    this.indexer = opts.indexer;
    this.node = opts.node;
    this.claimSubmit = opts.claimSubmit;
    // submitClaim is present on the instance ONLY when a submitter was wired, so a
    // form's `chain.submitClaim === undefined` check (htlc.ts) is honest.
    if (this.claimSubmit !== undefined) {
      this.submitClaim = async (htlc: OnChainHtlc, preimage: Hex): Promise<Hex> => {
        // biome-ignore lint/style/noNonNullAssertion: guarded by the enclosing if.
        return this.claimSubmit!(htlc, preimage);
      };
    }
  }

  async tipHeight(): Promise<number> {
    const r = await this.node.call<RawBlockHeight>("get_block_height", {});
    return r.height;
  }

  /**
   * STRICT single-quote_id datum read (R7/F1/M2). Maps the indexer's `unhonorable`
   * flag to `honorable` by NEGATION (M2): a datum_hash-only output declines, never
   * falls back to address+amount.
   */
  async getOutputDatum(o: Outpoint): Promise<OutputDatum> {
    const r = await this.indexer.call<RawOutputDatum>("get_output_datum", {
      tx_id: o.txId,
      output_index: o.outputIndex,
    });
    return {
      quoteIdHex: (r.quote_id as QuoteId | null) ?? null,
      // honorable iff NOT flagged unhonorable AND a strict inline quote_id exists.
      honorable: r.unhonorable === false && r.quote_id !== null,
    };
  }

  /**
   * Indexer Stage-1 reverse index. Joins each returned outpoint with the node's
   * value/script/height so the scorer has the full RawSettlementCandidate (R4
   * amount + address, depth). The indexer may return MULTIPLE outpoints; the gate
   * enforces 1:1 (F3).
   */
  async findSettlementsByQuoteId(q: QuoteId): Promise<RawSettlementCandidate[]> {
    const r = await this.indexer.call<RawFindSettlements>(
      "find_settlements_by_quote_id",
      { quote_id: q },
    );
    const out: RawSettlementCandidate[] = [];
    for (const s of r.settlements) {
      const outpoint: Outpoint = { txId: s.tx_id, outputIndex: s.output_index };
      // The node exposes no `get_output`; fetch the tx and read the output from
      // its canonical `tx_hex`. `block_height` (depth) comes from the TxStatus.
      const tx = await this.node.call<RawTxStatus | null>("get_transaction", {
        hash: s.tx_id,
      });
      if (tx === null) {
        throw new Error(`get_transaction returned null for settlement tx ${s.tx_id}`);
      }
      const decoded = decodeTxHex(tx.tx_hex);
      const op = decoded.outputs[s.output_index];
      if (op === undefined) {
        throw new Error(
          `settlement tx ${s.tx_id} has no output at index ${s.output_index}`,
        );
      }
      out.push({
        outpoint,
        value: op.value,
        scriptHex: op.scriptHex,
        blockHeight: tx.block_height ?? null,
      });
    }
    return out;
  }

  async getTransaction(txId: Hex): Promise<{ blockHeight: number | null } | null> {
    const r = await this.node.call<RawTxStatus | null>("get_transaction", {
      hash: txId,
    });
    if (r === null) return null;
    return { blockHeight: r.block_height ?? null };
  }

  /** R5 SOURCE binding: the prevouts feeding a settlement tx, parsed from `tx_hex`. */
  async getTxInputs(txId: Hex): Promise<Array<{ prevout: Outpoint }>> {
    const r = await this.node.call<RawTxStatus | null>("get_transaction", {
      hash: txId,
    });
    if (r === null) return [];
    const decoded = decodeTxHex(r.tx_hex);
    return decoded.inputs.map((i) => ({
      prevout: { txId: i.prevTxId, outputIndex: i.prevOutputIndex },
    }));
  }

  /** R5 prevout-script lookup — read the named output's script from its tx_hex. */
  async getOutputScript(o: Outpoint): Promise<Hex> {
    const tx = await this.node.call<RawTxStatus | null>("get_transaction", {
      hash: o.txId,
    });
    if (tx === null) {
      throw new Error(`get_transaction returned null for prevout tx ${o.txId}`);
    }
    const op = decodeTxHex(tx.tx_hex).outputs[o.outputIndex];
    if (op === undefined) {
      throw new Error(`prevout tx ${o.txId} has no output at index ${o.outputIndex}`);
    }
    return op.scriptHex;
  }

  /** HTLC form (R3): the on-chain HTLC at a lock outpoint, via indexer htlc_status.
   *  Binds the real `HtlcRecord` shape (params nested, value = `amount`). */
  async getHtlc(lock: Outpoint): Promise<OnChainHtlc | null> {
    let r: RawHtlcRecord | null;
    try {
      r = await this.indexer.call<RawHtlcRecord | null>("htlc_status", {
        lock_tx_id: lock.txId,
        output_index: lock.outputIndex,
      });
    } catch (e) {
      // htlc_status returns a BadParams error for an un-indexed lock; treat a
      // "no indexed HTLC" miss as null rather than a chain fault.
      if (isNoSuchHtlc(e)) return null;
      throw e;
    }
    if (r === null) return null;
    return {
      lock: { txId: r.lock_tx_id, outputIndex: r.output_index },
      receiverPubkey: r.params.receiver as PubKey,
      senderPubkey: r.params.sender as PubKey,
      hashLock: r.params.hash_lock,
      timeoutHeight: r.params.timeout_height,
      value: toBigInt(r.amount),
      lockBlockHeight: r.lock_block_height ?? null,
      state: normaliseHtlcState(r.state),
    };
  }

  /** Present ONLY when a claim submitter was wired (see constructor). */
  submitClaim?: (htlc: OnChainHtlc, preimage: Hex) => Promise<Hex>;
}

function toBigInt(v: number | string): bigint {
  return typeof v === "bigint" ? v : BigInt(v);
}

/** Map the indexer's `HtlcState` (snake_case, exfer::covenants::htlc::HtlcState:
 *  locked | locked_expired | claimed | reclaimed | unknown) to the closed
 *  `OnChainHtlc.state` union. The claim arm ⇒ 'claimed'; the timeout arm ⇒
 *  'reclaimed'. Everything else — 'locked', 'locked_expired' (still in the UTXO
 *  set, just past timeout), 'unknown' (follower catching up) — is a live lock,
 *  so it maps to 'locked'. */
function normaliseHtlcState(s: string): OnChainHtlc["state"] {
  const v = s.toLowerCase();
  if (v === "claimed") return "claimed";
  if (v === "reclaimed") return "reclaimed";
  return "locked";
}

// ---------------------------------------------------------------------------
// Transaction wire decoder (exfer/src/types/transaction.rs).
//
// The node returns transactions as raw `tx_hex`; the honor path needs per-output
// value/script (R4 amount/address, R5 prevout-script) and a tx's prevouts (R5
// SOURCE binding). The canonical wire layout (little-endian throughout):
//
//   header:  input_count: u16 | output_count: u16
//   input × input_count:   prev_tx_id: [u8;32] | output_index: u32   (36 bytes)
//   output × output_count: value: u64
//                          script:   varbytes (u16 len + bytes)
//                          has_datum:      u8 (0|1); if 1: varbytes
//                          has_datum_hash: u8 (0|1); if 1: [u8;32]
//   witnesses follow — not needed here, so decoding stops after the outputs.
// ---------------------------------------------------------------------------

/** Strict little-endian cursor over the decoded tx bytes. Throws on EOF. */
class ByteReader {
  private pos = 0;
  constructor(private readonly bytes: Uint8Array) {}

  private need(n: number): void {
    if (this.pos + n > this.bytes.length) {
      throw new Error(
        `tx_hex truncated: need ${n} bytes at offset ${this.pos}, have ${
          this.bytes.length - this.pos
        }`,
      );
    }
  }

  u8(): number {
    this.need(1);
    return this.bytes[this.pos++] as number;
  }

  u16le(): number {
    this.need(2);
    const v =
      (this.bytes[this.pos] as number) | ((this.bytes[this.pos + 1] as number) << 8);
    this.pos += 2;
    return v;
  }

  u32le(): number {
    this.need(4);
    const b = this.bytes;
    const v =
      ((b[this.pos] as number) |
        ((b[this.pos + 1] as number) << 8) |
        ((b[this.pos + 2] as number) << 16) |
        ((b[this.pos + 3] as number) << 24)) >>>
      0;
    this.pos += 4;
    return v;
  }

  u64le(): bigint {
    this.need(8);
    const b = this.bytes;
    let v = 0n;
    for (let i = 7; i >= 0; i--) {
      v = (v << 8n) | BigInt(b[this.pos + i] as number);
    }
    this.pos += 8;
    return v;
  }

  /** Read `n` raw bytes as bare-lowercase hex. */
  hex(n: number): Hex {
    this.need(n);
    let s = "";
    for (let i = 0; i < n; i++) {
      s += (this.bytes[this.pos + i] as number).toString(16).padStart(2, "0");
    }
    this.pos += n;
    return s as Hex;
  }

  /** Skip a u16-length-prefixed varbytes field. */
  skipVarBytes(): void {
    const len = this.u16le();
    this.need(len);
    this.pos += len;
  }

  /** Read a u16-length-prefixed varbytes field as bare-lowercase hex. */
  varBytesHex(): Hex {
    const len = this.u16le();
    return this.hex(len);
  }
}

/** Decode bare-lowercase tx hex into inputs (prevouts) and outputs (value+script).
 *  Mirrors `Transaction::deserialize` (exfer/src/types/transaction.rs), reading
 *  only the header/body — witnesses are not needed for the honor path. */
export function decodeTxHex(txHex: string): DecodedTx {
  const reader = new ByteReader(hexToBytes(txHex));
  const inputCount = reader.u16le();
  const outputCount = reader.u16le();

  const inputs: DecodedTx["inputs"] = [];
  for (let i = 0; i < inputCount; i++) {
    const prevTxId = reader.hex(32);
    const prevOutputIndex = reader.u32le();
    inputs.push({ prevTxId, prevOutputIndex });
  }

  const outputs: DecodedOutput[] = [];
  for (let i = 0; i < outputCount; i++) {
    const value = reader.u64le();
    const scriptHex = reader.varBytesHex();
    const hasDatum = reader.u8();
    if (hasDatum === 1) reader.skipVarBytes();
    else if (hasDatum !== 0) {
      throw new Error(`non-canonical has_datum flag: ${hasDatum}`);
    }
    const hasDatumHash = reader.u8();
    if (hasDatumHash === 1) reader.hex(32);
    else if (hasDatumHash !== 0) {
      throw new Error(`non-canonical has_datum_hash flag: ${hasDatumHash}`);
    }
    outputs.push({ value, scriptHex });
  }

  return { inputs, outputs };
}

/** Decode bare-lowercase hex (no `0x`) into bytes. Strict on shape. */
function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error(`tx_hex has odd length: ${hex.length}`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) {
      throw new Error(`tx_hex is not bare hex at byte ${i}`);
    }
    out[i] = byte;
  }
  return out;
}

/** The indexer's htlc_status returns a BadParams ("no indexed HTLC at …") for an
 *  unknown lock. Detect that so a miss maps to null, not a thrown chain fault. */
function isNoSuchHtlc(e: unknown): boolean {
  const msg = (e as { message?: unknown }).message;
  return typeof msg === "string" && msg.includes("no indexed HTLC");
}
