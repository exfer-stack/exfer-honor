// In-memory fakes for the Stage-4 FORM unit tests. Richer than the core engine
// fakes: this ChainSource is keyed per-outpoint (datum) and per-txid
// (getTransaction) so the HTLC two-phase / reorg-revocable behaviour can be driven
// deterministically. The Store fake is re-used from the core test helpers (the
// §5 gate semantics are form-agnostic), so these tests exercise the REAL engine +
// REAL forms against a fake chain — the design's "fake ChainSource for tests".
//
// `.test-helpers.ts` is outside the `src/**/*.test.ts` runner glob.

import {
  asQuoteId,
  type AcceptedQuote,
  type Hex,
  type Outpoint,
  type PubKey,
  type QuoteId,
} from "../spec/index.js";
import type {
  ChainSource,
  Clock,
  HonorConfig,
  KeyCustody,
  OnChainHtlc,
  OutputDatum,
  RawSettlementCandidate,
} from "../ports/index.js";
import { domainHashAddr } from "./address.js";

export const QID_A = asQuoteId("0123456789abcdef0123456789abcdef") as QuoteId;
export const QID_OTHER = asQuoteId("ffffffffffffffffffffffffffffffff") as QuoteId;
export const SIGNER = "11".repeat(32) as PubKey;
export const PAYEE = "22".repeat(32) as PubKey;
export const PAYER = "33".repeat(32) as PubKey;

/** The reference deriver's expected payee/payer scripts (matches the spine). */
export const PAYEE_SCRIPT: Hex = domainHashAddr(PAYEE);
export const PAYER_SCRIPT: Hex = domainHashAddr(PAYER);

export function opKey(o: Outpoint): string {
  return `${o.txId}:${o.outputIndex}`;
}

// ---------------------------------------------------------------------------
// FakeChain — per-outpoint / per-txid facts.
// ---------------------------------------------------------------------------

export class FakeChain implements ChainSource {
  tip = 120;
  candidates: RawSettlementCandidate[] = [];
  /** Per-outpoint datum; falls back to a valid QID_A inline datum. */
  datums = new Map<string, OutputDatum>();
  /** Per-txid block height (claim depth re-reads). null/absent ⇒ unconfirmed/un-mined. */
  txHeights = new Map<string, number | null>();
  /** Per-lock-outpoint on-chain HTLC. */
  htlcs = new Map<string, OnChainHtlc>();
  /** Per-settlement-txid prevouts (SOURCE binding). */
  txInputs = new Map<string, Array<{ prevout: Outpoint }>>();
  /** Per-outpoint script (SOURCE prevout-script lookup). */
  scripts = new Map<string, Hex>();
  claimTxIdToReturn = "claim01";
  submittedClaims = 0;

  async tipHeight(): Promise<number> {
    return this.tip;
  }
  async getOutputDatum(o: Outpoint): Promise<OutputDatum> {
    return this.datums.get(opKey(o)) ?? { quoteIdHex: QID_A, honorable: true };
  }
  async findSettlementsByQuoteId(_q: QuoteId): Promise<RawSettlementCandidate[]> {
    return this.candidates;
  }
  async getTransaction(txId: Hex): Promise<{ blockHeight: number | null } | null> {
    if (!this.txHeights.has(txId)) {
      return null;
    }
    return { blockHeight: this.txHeights.get(txId) ?? null };
  }
  async getTxInputs(txId: Hex): Promise<Array<{ prevout: Outpoint }>> {
    return this.txInputs.get(txId) ?? [];
  }
  async getOutputScript(o: Outpoint): Promise<Hex> {
    return this.scripts.get(opKey(o)) ?? "00";
  }
  async getHtlc(lock: Outpoint): Promise<OnChainHtlc | null> {
    return this.htlcs.get(opKey(lock)) ?? null;
  }
  async submitClaim(_htlc: OnChainHtlc, _preimage: Hex): Promise<Hex> {
    this.submittedClaims += 1;
    return this.claimTxIdToReturn;
  }
}

// ---------------------------------------------------------------------------
// FakeClock / FakeKeys
// ---------------------------------------------------------------------------

export class FakeClock implements Clock {
  constructor(public t: number) {}
  now(): number {
    return this.t;
  }
}

export class FakeKeys implements KeyCustody {
  constructor(
    private controls = true,
    private throwOnTest = false,
    private preimage: Hex | null = "preimage00",
  ) {}
  async controlsPayee(_payee: PubKey): Promise<boolean> {
    if (this.throwOnTest) throw new Error("keystore unavailable");
    return this.controls;
  }
  async htlcPreimageFor(_q: QuoteId, _p: PubKey): Promise<Hex | null> {
    return this.preimage;
  }
}

// ---------------------------------------------------------------------------
// config + builders
// ---------------------------------------------------------------------------

export function testConfig(over: Partial<HonorConfig> = {}): HonorConfig {
  const maxReorgDepth = over.maxReorgDepth ?? 12;
  const confirmationDepth = over.confirmationDepth ?? 6;
  return {
    maxReorgDepth,
    confirmationDepth,
    claimMargin: over.claimMargin ?? maxReorgDepth + confirmationDepth + 1,
    maxRecheckWindow: over.maxRecheckWindow ?? 3600,
    payerBinding: over.payerBinding ?? "consent",
    requirePayerFunded: over.requirePayerFunded ?? false,
    addressDeriver: over.addressDeriver,
  };
}

export function plainQuote(over: Partial<AcceptedQuote> = {}): AcceptedQuote {
  return {
    quoteId: over.quoteId ?? QID_A,
    signerPubkey: over.signerPubkey ?? SIGNER,
    payeePubkey: over.payeePubkey ?? PAYEE,
    payerPubkey: over.payerPubkey ?? null,
    exferAmount: over.exferAmount ?? 100_000_000n,
    expiresAt: over.expiresAt ?? 10_000,
    issuedAt: over.issuedAt ?? 1_000,
    form: over.form ?? "plain",
  };
}

export function confirmedCandidate(
  over: Partial<RawSettlementCandidate> = {},
): RawSettlementCandidate {
  return {
    outpoint: over.outpoint ?? { txId: "aa00", outputIndex: 0 },
    value: over.value ?? 100_000_000n,
    scriptHex: over.scriptHex ?? PAYEE_SCRIPT,
    // honor an EXPLICIT null (unconfirmed) — `?? 100` would coerce null → 100.
    blockHeight: "blockHeight" in over ? (over.blockHeight ?? null) : 100,
  };
}

export function lockedHtlc(over: Partial<OnChainHtlc> = {}): OnChainHtlc {
  return {
    lock: over.lock ?? { txId: "lock0", outputIndex: 0 },
    receiverPubkey: over.receiverPubkey ?? PAYEE,
    senderPubkey: over.senderPubkey ?? PAYER,
    hashLock: over.hashLock ?? "abcd",
    timeoutHeight: over.timeoutHeight ?? 10_000,
    value: over.value ?? 100_000_000n,
    lockBlockHeight: over.lockBlockHeight ?? 90,
    state: over.state ?? "locked",
  };
}
