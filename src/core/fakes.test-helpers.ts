// In-memory fakes of EVERY port, for the Stage-3 engine unit tests. These are a
// faithful (single-process, single-writer) model of the §5 gate semantics:
//
//  - FakeSyncStore implements the §5.2 (mode 'single') / §5.5 (mode 'promote')
//    write-ahead sequence as ONE synchronous critical section: SEEN hard-lock →
//    CONSUMED insert/promote → deliver(ctx) → commit. A throw anywhere (including
//    the consumer deliver, F11) rolls back the WHOLE mutation (no SEEN honor, no
//    outpoint row). A concurrent honor of the same quote loses the SEEN lock and
//    raises GateViolation (F3/F10).
//  - The §5.8 in-txn re-validation of the R6 late-honor window is folded into the
//    SEEN UPDATE guard, using a single commit-time `now`.
//
// `.test-helpers.ts` is outside the `src/**/*.test.ts` runner glob, so this file
// ships no tests of its own; it is imported by the engine test suites.

import {
  GateViolation,
  asQuoteId,
  type AcceptedQuote,
  type DeliverContext,
  type GateDbTxn,
  type Hex,
  type HonorVerdict,
  type Outpoint,
  type PubKey,
  type QuoteId,
  type SettlementCandidate,
} from "../spec/index.js";
import type {
  ChainSource,
  Clock,
  HonorConfig,
  HonorTxnInput,
  KeyCustody,
  OnChainHtlc,
  OutputDatum,
  RawSettlementCandidate,
  ScoringCtx,
  SeenRow,
  SettlementForm,
  Store,
} from "../ports/index.js";

// ---------------------------------------------------------------------------
// hex helpers
// ---------------------------------------------------------------------------

export const QID_A = asQuoteId("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa") as QuoteId;
export const QID_B = asQuoteId("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb") as QuoteId;
export const SIGNER = "11".repeat(32) as PubKey;
export const PAYEE = "22".repeat(32) as PubKey;
export const PAYER = "33".repeat(32) as PubKey;
export const PAYEE_SCRIPT = "deadbeef" as Hex;

export function outpointKey(o: Outpoint): string {
  return `${o.txId}:${o.outputIndex}`;
}

/**
 * The txn-scoped handle the FakeSyncStore hands the consumer's `deliver` as
 * `DeliverContext.db` (the fake's analogue of SqliteGateTxn). `stageGoods` writes a
 * goods row into the CURRENT txn's staging buffer — published on commit, discarded
 * on rollback — so the in-memory store models the same-txn goods atomicity (F8/F11)
 * that the SqliteStore gets for free from better-sqlite3.
 */
export interface FakeGateTxn {
  readonly handleId: symbol;
  stageGoods(goodsKey: string): void;
}

/** Narrow a `DeliverContext<'sync'>.db` back to the FakeGateTxn the fake minted. */
export function asFakeTxn(db: GateDbTxn<"sync">): FakeGateTxn {
  return db as unknown as FakeGateTxn;
}

// ---------------------------------------------------------------------------
// FakeSyncStore — the §5 gate, modelled as a synchronous critical section.
// ---------------------------------------------------------------------------

interface OutpointRow {
  txId: Hex;
  outputIndex: number;
  signerPubkey: PubKey;
  quoteId: QuoteId;
  state: "claim_pending" | "honored";
  honoredAt: number | null;
  retainUntil: number;
}

export class FakeSyncStore implements Store<"sync"> {
  readonly txnModel = "sync" as const;
  readonly handleId = Symbol("fake-sync-store");

  private readonly seen = new Map<string, SeenRow>();
  private readonly outpoints = new Map<string, OutpointRow>();
  /**
   * Committed consumer-goods ledger, keyed on (signer:quote). The deliver callback
   * writes goods through `ctx.db` (the txn-scoped handle); the write is STAGED and
   * published to this map ONLY when the txn commits — so an F8/F11 rollback discards
   * the goods alongside the gate writes, exactly like the SqliteStore's same-txn
   * goods write. Idempotent on the key (mirrors a real ON CONFLICT DO NOTHING).
   */
  private readonly goods = new Set<string>();
  /** Counts how many times any deliver actually ran (double-deliver detector). */
  deliverCount = 0;

  private rk(s: PubKey, q: QuoteId): string {
    return `${s}:${q}`;
  }

  /** Committed goods-row count (the double-deliver detector for the conformance harness). */
  goodsCount(): number {
    return this.goods.size;
  }

  async init(): Promise<void> {}

  async upsertAccepted(
    a: AcceptedQuote,
    acceptedAt: number,
    retainUntil: number,
  ): Promise<void> {
    const k = this.rk(a.signerPubkey, a.quoteId);
    if (this.seen.has(k)) return; // idempotent
    this.seen.set(k, {
      signerPubkey: a.signerPubkey,
      quoteId: a.quoteId,
      payeePubkey: a.payeePubkey,
      payerPubkey: a.payerPubkey,
      exferAmount: a.exferAmount,
      form: a.form,
      acceptedAt,
      expiresAt: a.expiresAt,
      observedBeforeExpiry: false,
      honoredAt: null,
      honoredOutpoint: null,
      retainUntil,
    });
  }

  async getSeen(s: PubKey, q: QuoteId): Promise<SeenRow | null> {
    const row = this.seen.get(this.rk(s, q));
    return row ? { ...row } : null;
  }

  async listHonorable(s: PubKey, now: number): Promise<SeenRow[]> {
    return [...this.seen.values()].filter(
      (r) => r.signerPubkey === s && r.honoredAt === null && now < r.retainUntil,
    );
  }

  async markObservedBeforeExpiry(s: PubKey, q: QuoteId, now: number): Promise<void> {
    const row = this.seen.get(this.rk(s, q));
    if (row && now < row.expiresAt) {
      row.observedBeforeExpiry = true;
    }
  }

  async isOutpointConsumed(o: Outpoint): Promise<boolean> {
    const row = this.outpoints.get(outpointKey(o));
    return row !== undefined && row.state === "honored";
  }

  async reserveClaimOutpoint(
    s: PubKey,
    q: QuoteId,
    o: Outpoint,
    _claimTxId: string,
    _now: number,
  ): Promise<void> {
    const key = outpointKey(o);
    const existing = this.outpoints.get(key);
    if (existing) return; // idempotent re-reserve
    this.outpoints.set(key, {
      txId: o.txId,
      outputIndex: o.outputIndex,
      signerPubkey: s,
      quoteId: q,
      state: "claim_pending",
      honoredAt: null,
      retainUntil: Number.MAX_SAFE_INTEGER,
    });
  }

  /**
   * THE invariant (§5.2 / §5.5). A synchronous all-or-nothing critical section:
   * SEEN hard-lock (with the §5.8 in-txn R6 window re-validation) → CONSUMED
   * insert ('single') or promote ('promote') → deliver(ctx) → commit. Any throw
   * (GateViolation OR a consumer deliver throw, F11) discards ALL staged mutations.
   */
  async runHonorTxn(input: HonorTxnInput<"sync">): Promise<void> {
    const k = this.rk(input.signerPubkey, input.quoteId);
    const live = this.seen.get(k);

    // -- staged copies (rolled back on any throw) --
    const stagedSeen: SeenRow | null = live ? { ...live } : null;
    const opKey = outpointKey(input.outpoint);
    let stagedOutpoint: OutpointRow | null = null;

    // Step 1: SEEN hard-lock, folding the R6 late-honor window (§5.8, §5.9, F10).
    //   The lockable predicate (re-validated here at the single commit-time `now`):
    //     honored_at IS NULL                                   (not already honored)
    //     AND now < retainUntil                                (inside retention)
    //     AND (now < expiresAt OR observed_before_expiry)      (§5.9 late-honor rule)
    //   A failure is disambiguated onto the matching GateViolation kind so the
    //   engine maps it to a precise DeclineReason: honored → already_honored,
    //   swept/out-of-window/late-unobserved → expired_unobserved.
    if (stagedSeen === null) {
      throw new GateViolation("expired-window", "SEEN row missing (swept mid-honor)");
    }
    if (stagedSeen.honoredAt !== null) {
      throw new GateViolation(
        "seen-already-honored",
        "SEEN row already honored (concurrent honor / re-honor)",
      );
    }
    const insideRetention = input.now < stagedSeen.retainUntil;
    const lateHonorOk =
      input.now < stagedSeen.expiresAt || stagedSeen.observedBeforeExpiry;
    if (!insideRetention || !lateHonorOk) {
      throw new GateViolation(
        "expired-window",
        "SEEN row not lockable (out-of-window / late-honor without observation, §5.9)",
      );
    }
    stagedSeen.honoredAt = input.now;
    stagedSeen.honoredOutpoint = { ...input.outpoint };

    // Step 2: CONSUMED insert ('single') or promote ('promote').
    if (input.mode === "single") {
      const existing = this.outpoints.get(opKey);
      if (existing) {
        throw new GateViolation("outpoint-consumed", "PK collision on insert (R1)");
      }
      stagedOutpoint = {
        txId: input.outpoint.txId,
        outputIndex: input.outpoint.outputIndex,
        signerPubkey: input.signerPubkey,
        quoteId: input.quoteId,
        state: "honored",
        honoredAt: input.now,
        retainUntil: input.retainUntil,
      };
    } else {
      const existing = this.outpoints.get(opKey);
      if (!existing || existing.state !== "claim_pending") {
        throw new GateViolation(
          "outpoint-consumed",
          "promote target not in claim_pending (F13)",
        );
      }
      stagedOutpoint = {
        ...existing,
        state: "honored",
        honoredAt: input.now,
        retainUntil: input.retainUntil,
      };
    }

    // Step 3: deliver INSIDE the txn. A throw propagates UNCAUGHT (F11) → we never
    // commit the staged mutations below. Goods written through `ctx.db` are STAGED
    // here and published ONLY on commit, so a rollback discards them with the gate
    // writes (faithful F8/F11 model — mirrors the SqliteStore same-txn goods write).
    this.deliverCount += 1;
    const stagedGoods = new Set<string>();
    const txnHandle: FakeGateTxn = {
      handleId: this.handleId,
      stageGoods: (goodsKey: string) => {
        stagedGoods.add(goodsKey);
      },
    };
    const ctx: DeliverContext<"sync"> = {
      key: { signerPubkey: input.signerPubkey, quoteId: input.quoteId },
      candidate: input.candidate,
      db: txnHandle as unknown as GateDbTxn<"sync">,
      honoredAt: input.now,
    };
    const ret = input.deliver(ctx) as unknown;
    // F8 runtime hot-path guard: a sync deliver that returned a thenable would
    // commit-before-goods. Reject it so the txn rolls back rather than commits.
    if (ret && typeof (ret as { then?: unknown }).then === "function") {
      this.deliverCount -= 1;
      throw new Error("async deliver under sync store (F8 runtime guard)");
    }

    // COMMIT — atomically publish the staged mutations (gate writes + goods).
    this.seen.set(k, stagedSeen);
    this.outpoints.set(opKey, stagedOutpoint);
    for (const g of stagedGoods) this.goods.add(g);
  }

  async sweep(now: number): Promise<{ seenDeleted: number; outpointsDeleted: number }> {
    let seenDeleted = 0;
    let outpointsDeleted = 0;
    for (const [k, r] of [...this.seen]) {
      if (r.retainUntil < now) {
        this.seen.delete(k);
        seenDeleted += 1;
      }
    }
    for (const [k, r] of [...this.outpoints]) {
      if (r.retainUntil < now) {
        this.outpoints.delete(k);
        outpointsDeleted += 1;
      }
    }
    return { seenDeleted, outpointsDeleted };
  }

  // -- test inspection helpers --
  peekSeen(s: PubKey, q: QuoteId): SeenRow | undefined {
    const r = this.seen.get(this.rk(s, q));
    return r ? { ...r } : undefined;
  }
  peekOutpoint(o: Outpoint): OutpointRow | undefined {
    return this.outpoints.get(outpointKey(o));
  }
}

// ---------------------------------------------------------------------------
// FakeClock / FakeKeys / FakeChain
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
    private preimage: Hex | null = null,
  ) {}
  async controlsPayee(_payee: PubKey): Promise<boolean> {
    if (this.throwOnTest) throw new Error("keystore unavailable");
    return this.controls;
  }
  async htlcPreimageFor(_q: QuoteId, _p: PubKey): Promise<Hex | null> {
    return this.preimage;
  }
}

export class FakeChain implements ChainSource {
  tip = 100;
  candidates: RawSettlementCandidate[] = [];
  datum: OutputDatum = { quoteIdHex: QID_A, honorable: true };
  htlc: OnChainHtlc | null = null;
  claimTx: { blockHeight: number | null } | null = null;

  async tipHeight(): Promise<number> {
    return this.tip;
  }
  async getOutputDatum(_o: Outpoint): Promise<OutputDatum> {
    return this.datum;
  }
  async findSettlementsByQuoteId(_q: QuoteId): Promise<RawSettlementCandidate[]> {
    return this.candidates;
  }
  async getTransaction(_txId: Hex): Promise<{ blockHeight: number | null } | null> {
    return this.claimTx;
  }
  async getTxInputs(_txId: Hex): Promise<Array<{ prevout: Outpoint }>> {
    return [];
  }
  async getOutputScript(_o: Outpoint): Promise<Hex> {
    return PAYEE_SCRIPT;
  }
  async getHtlc(_lock: Outpoint): Promise<OnChainHtlc | null> {
    return this.htlc;
  }
  async submitClaim(_htlc: OnChainHtlc, _preimage: Hex): Promise<Hex> {
    return "c1a1mtx";
  }
}

// ---------------------------------------------------------------------------
// Forms — trivial pass-through strategies sufficient for engine wiring tests.
// ---------------------------------------------------------------------------

/**
 * A plain form whose `score` runs the §6.1 spine against the chain candidates:
 * datum strict-decode + honorable (M2/F1), exact amount (R4), address (R4),
 * payee custody (R2/M3), depth (R4). gateMode 'single'.
 */
export class TestPlainForm implements SettlementForm {
  readonly id = "plain" as const;

  async discover(ctx: ScoringCtx): Promise<RawSettlementCandidate[]> {
    return ctx.chain.findSettlementsByQuoteId(ctx.quote.quoteId);
  }

  async score(ctx: ScoringCtx, raw: RawSettlementCandidate[]): Promise<HonorVerdict> {
    if (raw.length === 0) {
      return { decision: "wait", reason: "no_candidate" };
    }
    const c = raw[0];
    if (!c) return { decision: "wait", reason: "no_candidate" };

    const datum = await ctx.chain.getOutputDatum(c.outpoint);
    if (!datum.honorable || datum.quoteIdHex === null) {
      return { decision: "decline", reason: "datum_unhonorable" };
    }
    if (datum.quoteIdHex !== ctx.quote.quoteId) {
      return { decision: "wait", reason: "no_candidate" };
    }
    if (c.value !== ctx.quote.exferAmount) {
      return { decision: "decline", reason: "amount_mismatch" };
    }
    if (c.scriptHex !== PAYEE_SCRIPT) {
      return { decision: "decline", reason: "address_mismatch" };
    }
    const controls = await ctx.keys.controlsPayee(ctx.quote.payeePubkey);
    if (!controls) {
      return { decision: "decline", reason: "payee_not_controlled" };
    }
    if (c.blockHeight === null) {
      return { decision: "wait", reason: "insufficient_depth" };
    }
    const depth = ctx.tip - c.blockHeight + 1;
    if (depth < ctx.config.confirmationDepth) {
      return { decision: "wait", reason: "insufficient_depth" };
    }
    const candidate: SettlementCandidate = {
      form: "plain",
      quoteId: ctx.quote.quoteId,
      txId: c.outpoint.txId,
      outputIndex: c.outpoint.outputIndex,
      value: c.value,
      scriptHex: c.scriptHex,
      blockHeight: c.blockHeight,
      honorable: true,
    };
    return { decision: "honor", candidate, form: "plain" };
  }

  gateMode(): "single" {
    return "single";
  }
}

/**
 * A minimal HTLC form for the F9/F13 wiring tests. Phase A submits a claim and
 * reserves the outpoint as claim_pending; Phase B (claim buried CLAIM_MARGIN
 * deep) promotes. gateMode 'promote'.
 */
export class TestHtlcForm implements SettlementForm {
  readonly id = "htlc" as const;
  /** Toggled by the test once the claim is submitted. */
  claimSubmitted = false;

  async discover(ctx: ScoringCtx): Promise<RawSettlementCandidate[]> {
    return ctx.chain.findSettlementsByQuoteId(ctx.quote.quoteId);
  }

  async score(ctx: ScoringCtx, raw: RawSettlementCandidate[]): Promise<HonorVerdict> {
    const c = raw[0];
    if (!c) return { decision: "wait", reason: "no_candidate" };
    const candidate: SettlementCandidate = {
      form: "htlc",
      quoteId: ctx.quote.quoteId,
      txId: c.outpoint.txId,
      outputIndex: c.outpoint.outputIndex,
      value: c.value,
      scriptHex: c.scriptHex,
      blockHeight: c.blockHeight,
      honorable: true,
    };
    return { decision: "honor", candidate, form: "htlc" };
  }

  async prepare(
    ctx: ScoringCtx,
    v: Extract<HonorVerdict, { decision: "honor" }>,
  ): Promise<
    | { kind: "ready" }
    | { kind: "claim_submitted"; claimTxId: string }
    | { kind: "wait"; reason: import("../spec/index.js").WaitReason }
  > {
    if (!this.claimSubmitted) {
      this.claimSubmitted = true;
      return { kind: "claim_submitted", claimTxId: "c1a1mtx" };
    }
    // Phase B: require the claim buried CLAIM_MARGIN deep off the live tip.
    const claim = await ctx.chain.getTransaction("c1a1mtx");
    if (!claim || claim.blockHeight === null) {
      return { kind: "wait", reason: "reorg_withheld" };
    }
    const depth = ctx.tip - claim.blockHeight + 1;
    if (depth < ctx.config.claimMargin) {
      return { kind: "wait", reason: "reorg_withheld" };
    }
    void v;
    return { kind: "ready" };
  }

  gateMode(): "promote" {
    return "promote";
  }
}

// ---------------------------------------------------------------------------
// config + quote builders
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
  };
}

export function plainQuote(over: Partial<AcceptedQuote> = {}): AcceptedQuote {
  return {
    quoteId: over.quoteId ?? QID_A,
    signerPubkey: over.signerPubkey ?? SIGNER,
    payeePubkey: over.payeePubkey ?? PAYEE,
    payerPubkey: over.payerPubkey ?? null,
    exferAmount: over.exferAmount ?? 1000n,
    expiresAt: over.expiresAt ?? 10_000,
    issuedAt: over.issuedAt ?? 1_000,
    form: over.form ?? "plain",
  };
}

export function confirmedCandidate(
  over: Partial<RawSettlementCandidate> = {},
): RawSettlementCandidate {
  return {
    outpoint: over.outpoint ?? { txId: "tx1", outputIndex: 0 },
    value: over.value ?? 1000n,
    scriptHex: over.scriptHex ?? PAYEE_SCRIPT,
    blockHeight: over.blockHeight ?? 90,
  };
}
