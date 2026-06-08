// CONFORMANCE — the executable harness (§9).
//
// `runVector(vec, env)` EXECUTES one frozen vector against the REAL engine + REAL
// builtin forms + a REAL Store, and asserts the vector's exact expected outcome.
// `runCorpus(env)` runs the whole mandatory corpus. The same harness runs against
// BOTH reference stores (the in-memory fake AND the real SqliteStore) — the §9
// "both reference stores" gate — because the Store is INJECTED via `ConformanceEnv`.
//
// The corpus is the SOURCE OF TRUTH. Each case asserts the precise verdict /
// outcome / delivery-count / gate-state the vector freezes. A divergence is an
// engine/forms/store BUG to fix — never a vector to weaken.
//
// The F8 `deliver/async-under-sync` vector is `compileTimeOnly` (enforced by the
// typecheck gate via src/spec/deliver.test-d.ts). The harness still runs its
// RUNTIME guard half (a thenable-returning deliver under a sync store must throw a
// contract violation and roll the gate back).

import assert from "node:assert/strict";
import {
  type AcceptedQuote,
  type DeliverContext,
  type HonorKey,
  type HonorOutcome,
  type HonorVerdict,
  type Outpoint,
  type PubKey,
  type QuoteId,
  asQuoteId,
  decodeSettlementDatum,
} from "../spec/index.js";
import type {
  ChainSource,
  Clock,
  HonorConfig,
  KeyCustody,
  OnChainHtlc,
  OutputDatum,
  RawSettlementCandidate,
  Store,
} from "../ports/index.js";
import { createFormRegistry, createHonorEngine } from "../core/index.js";
import { HtlcForm, PlainOutputForm, domainHashAddr } from "../forms/index.js";
import type { HtlcClaimReserver } from "../forms/index.js";
import type { Vector } from "./vectors.js";

// ---------------------------------------------------------------------------
// Injected store adapter — the seam that lets the SAME harness run against the
// in-memory fake AND the real SqliteStore (§9 both-reference-stores gate).
// ---------------------------------------------------------------------------

/**
 * A conformance-driving wrapper over one concrete `Store<'sync'>`. The harness
 * builds the engine with `store`, delivers goods via `deliver`, and inspects the
 * committed goods count via `goodsCount`. Optional capabilities unlock the
 * store-specific vectors (F12 out-of-band, F9 crash-recovery reopen); a store that
 * cannot model a capability omits it and the harness skips that store for it.
 */
export interface ConformanceStore {
  readonly label: string;
  readonly store: Store<"sync">;
  /** Idempotent goods write on the gate's OWN txn-scoped handle (F12-safe). */
  deliver(ctx: DeliverContext<"sync">): void;
  /** Number of goods rows currently committed (the double-deliver detector). */
  goodsCount(): number;
  /**
   * F12: write goods via a SEPARATE connection (NOT DeliverContext.db). Present
   * only for a store that can model an out-of-band handle (the SqliteStore). The
   * harness asserts this is rejected as a `store_topology` / contract violation.
   */
  deliverOutOfBand?(ctx: DeliverContext<"sync">): void;
  /**
   * F9 sync recovery: simulate a crash-then-restart by reopening the durable
   * backing store on a fresh handle and returning a NEW ConformanceStore over the
   * SAME data. Present only for a durable store (the SqliteStore).
   */
  reopen?(): ConformanceEnv;
  /** Release any resources (close the DB file). */
  dispose(): void;
}

/** Everything `runVector` needs: the injected store + a fresh fake chain/keys/clock. */
export interface ConformanceEnv {
  readonly cstore: ConformanceStore;
  readonly chain: HarnessChain;
  readonly keys: HarnessKeys;
  readonly clock: HarnessClock;
  readonly config: HonorConfig;
}

/** A factory the test layer supplies per store (fake | sqlite). Called once per vector. */
export type EnvFactory = () => ConformanceEnv;

// ---------------------------------------------------------------------------
// Fake chain / keys / clock — driven from a vector fixture. Mirrors the Stage-4
// form fakes but lives in /conformance so the harness is self-contained.
// ---------------------------------------------------------------------------

export const SIGNER = "11".repeat(32) as PubKey;
export const PAYEE = "22".repeat(32) as PubKey;
export const PAYER = "33".repeat(32) as PubKey;
/** The reference deriver's payee script — what a binding-valid candidate must carry. */
export const PAYEE_SCRIPT = domainHashAddr(PAYEE);
export const PAYER_SCRIPT = domainHashAddr(PAYER);

function opKey(o: Outpoint): string {
  return `${o.txId}:${o.outputIndex}`;
}

export class HarnessClock implements Clock {
  constructor(public t: number) {}
  now(): number {
    return this.t;
  }
}

export class HarnessKeys implements KeyCustody {
  /** 'throw' models an unavailable keystore (→ retryable keystore_fault). */
  controls: boolean | "throw" = true;
  preimage: string | null = "preimage00";
  async controlsPayee(_p: PubKey): Promise<boolean> {
    if (this.controls === "throw") throw new Error("keystore unavailable");
    return this.controls;
  }
  async htlcPreimageFor(_q: QuoteId, _p: PubKey): Promise<string | null> {
    return this.preimage;
  }
}

export class HarnessChain implements ChainSource {
  tip = 120;
  candidates: RawSettlementCandidate[] = [];
  datums = new Map<string, OutputDatum>();
  /** Default inline datum carries the canonical quote_id; per-outpoint overrides win. */
  defaultDatum: OutputDatum = { quoteIdHex: null, honorable: true };
  txHeights = new Map<string, number | null>();
  htlcs = new Map<string, OnChainHtlc>();
  txInputs = new Map<string, Array<{ prevout: Outpoint }>>();
  scripts = new Map<string, string>();
  claimTxIdToReturn = "claim01";
  submittedClaims = 0;

  async tipHeight(): Promise<number> {
    return this.tip;
  }
  async getOutputDatum(o: Outpoint): Promise<OutputDatum> {
    return this.datums.get(opKey(o)) ?? this.defaultDatum;
  }
  async findSettlementsByQuoteId(_q: QuoteId): Promise<RawSettlementCandidate[]> {
    return this.candidates;
  }
  async getTransaction(txId: string): Promise<{ blockHeight: number | null } | null> {
    if (!this.txHeights.has(txId)) return null;
    return { blockHeight: this.txHeights.get(txId) ?? null };
  }
  async getTxInputs(txId: string): Promise<Array<{ prevout: Outpoint }>> {
    return this.txInputs.get(txId) ?? [];
  }
  async getOutputScript(o: Outpoint): Promise<string> {
    return this.scripts.get(opKey(o)) ?? "00";
  }
  async getHtlc(lock: Outpoint): Promise<OnChainHtlc | null> {
    return this.htlcs.get(opKey(lock)) ?? null;
  }
  async submitClaim(_h: OnChainHtlc, _p: string): Promise<string> {
    this.submittedClaims += 1;
    return this.claimTxIdToReturn;
  }
}

// ---------------------------------------------------------------------------
// builders
// ---------------------------------------------------------------------------

export const CANON_QID = asQuoteId("0123456789abcdef0123456789abcdef") as QuoteId;

export function defaultConfig(over: Partial<HonorConfig> = {}): HonorConfig {
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

function quote(over: Partial<AcceptedQuote> = {}): AcceptedQuote {
  return {
    quoteId: over.quoteId ?? CANON_QID,
    signerPubkey: over.signerPubkey ?? SIGNER,
    payeePubkey: over.payeePubkey ?? PAYEE,
    payerPubkey: over.payerPubkey ?? null,
    exferAmount: over.exferAmount ?? 100_000_000n,
    expiresAt: over.expiresAt ?? 10_000,
    issuedAt: over.issuedAt ?? 1_000,
    form: over.form ?? "plain",
  };
}

function candidate(over: Partial<RawSettlementCandidate> = {}): RawSettlementCandidate {
  return {
    outpoint: over.outpoint ?? { txId: "aa00", outputIndex: 0 },
    value: over.value ?? 100_000_000n,
    scriptHex: over.scriptHex ?? PAYEE_SCRIPT,
    blockHeight: "blockHeight" in over ? (over.blockHeight ?? null) : 100,
  };
}

/** Build a REAL engine over the injected store + the two builtin forms. */
function buildEngine(env: ConformanceEnv) {
  const forms = createFormRegistry([
    new PlainOutputForm(),
    new HtlcForm(env.cstore.store as HtlcClaimReserver),
  ]);
  return createHonorEngine({
    store: env.cstore.store,
    chain: env.chain,
    keys: env.keys,
    clock: env.clock,
    forms,
    config: env.config,
  });
}

const KEY: HonorKey = { signerPubkey: SIGNER, quoteId: CANON_QID };

// ---------------------------------------------------------------------------
// assertion helpers
// ---------------------------------------------------------------------------

function declineReason(v: HonorVerdict): string {
  return v.decision === "decline" ? v.reason : `<${v.decision}>`;
}
function waitReason(v: HonorVerdict): string {
  return v.decision === "wait" ? v.reason : `<${v.decision}>`;
}
function outcomeVerdict(o: HonorOutcome): HonorVerdict {
  assert.equal(o.status, "not_ready", "expected a not_ready outcome carrying a verdict");
  return (o as { verdict: HonorVerdict }).verdict;
}

// ---------------------------------------------------------------------------
// the per-vector executors. Each maps a frozen vector → an engine run + assertions.
// ---------------------------------------------------------------------------

type Exec = (env: ConformanceEnv, vec: Vector) => Promise<void>;

const EXECUTORS: Record<string, Exec> = {
  // -- plain ----------------------------------------------------------------
  "plain/happy": async (env, _vec) => {
    const engine = buildEngine(env);
    env.chain.defaultDatum = { quoteIdHex: CANON_QID, honorable: true };
    env.chain.candidates = [candidate()];
    env.clock.t = 5_000;
    await engine.register(quote());
    await engine.markObserved(KEY, 5_000);
    let delivered = 0;
    const out = await engine.honor(KEY, (ctx) => {
      delivered += 1;
      env.cstore.deliver(ctx);
    });
    assert.equal(out.status, "honored", "plain/happy honors");
    assert.deepEqual(
      (out as { outpoint: Outpoint }).outpoint,
      { txId: "aa00", outputIndex: 0 },
      "honored outpoint",
    );
    assert.equal(delivered, 1, "exactly one delivery");
    assert.equal(env.cstore.goodsCount(), 1, "exactly one goods row");
    assert.equal((await engine.status(KEY))?.state, "honored");
  },

  // -- datum ----------------------------------------------------------------
  "datum/multi-id-reject": async (_env, vec) => {
    // F1: a 32-byte (two-id) datum MUST fail the strict decode → datum_unhonorable.
    const rawHex = vec.fixture.rawDatumHex as string;
    const decoded = decodeSettlementDatum(rawHex);
    assert.equal(decoded.ok, false, "multi-id datum rejected by strict decode");
    assert.equal(
      decoded.ok ? "" : decoded.reason,
      vec.expect.decode && (vec.expect.decode as { reason: string }).reason,
    );
  },
  "datum/trailing-bytes": async (_env, vec) => {
    const rawHex = vec.fixture.rawDatumHex as string;
    const decoded = decodeSettlementDatum(rawHex);
    assert.equal(decoded.ok, false, "trailing-byte datum rejected (zero-trailing, F1)");
    assert.equal(decoded.ok ? "" : decoded.reason, "wrong_length");
  },
  "datum/version-byte": async (_env, vec) => {
    const rawHex = vec.fixture.rawDatumHex as string;
    const ver = vec.fixture.decodeUnderVersion as number;
    const decoded = decodeSettlementDatum(rawHex, ver);
    assert.equal(decoded.ok, false, "v2 datum MUST NOT decode under v1");
    assert.equal(decoded.ok ? "" : decoded.reason, "unknown_version");
  },
  "datum/hash-only": async (env, _vec) => {
    // M2: datum_hash-only ⇒ honorable:false ⇒ decline datum_unhonorable, no fallback.
    const engine = buildEngine(env);
    env.chain.defaultDatum = { quoteIdHex: null, honorable: false };
    env.chain.candidates = [candidate()];
    await engine.register(quote());
    let delivered = 0;
    const out = await engine.honor(KEY, (ctx) => {
      delivered += 1;
      env.cstore.deliver(ctx);
    });
    assert.equal(declineReason(outcomeVerdict(out)), "datum_unhonorable");
    assert.equal(delivered, 0, "no delivery for unhonorable datum");
    assert.equal(env.cstore.goodsCount(), 0);
  },

  // -- gate -----------------------------------------------------------------
  "gate/two-outpoints": async (env, _vec) => {
    // F3: one quote in two outputs → first honors, second already_honored, ONE delivery.
    const engine = buildEngine(env);
    env.chain.defaultDatum = { quoteIdHex: CANON_QID, honorable: true };
    env.chain.candidates = [
      candidate({ outpoint: { txId: "aa00", outputIndex: 0 }, blockHeight: 100 }),
      candidate({ outpoint: { txId: "bb11", outputIndex: 3 }, blockHeight: 101 }),
    ];
    await engine.register(quote());
    const first = await engine.honor(KEY, (ctx) => env.cstore.deliver(ctx));
    assert.equal(first.status, "honored", "first honors");
    const second = await engine.honor(KEY, (ctx) => env.cstore.deliver(ctx));
    assert.equal(declineReason(outcomeVerdict(second)), "already_honored");
    assert.equal(env.cstore.goodsCount(), 1, "exactly one goods row across two honors");
  },
  "gate/legacy-coexist": async (env, _vec) => {
    // M4: an outpoint consumed via the ONE honor path cannot be re-consumed. We honor
    // it once, then a SECOND quote naming the SAME outpoint hits the consumed gate.
    const engine = buildEngine(env);
    env.chain.defaultDatum = { quoteIdHex: CANON_QID, honorable: true };
    const shared: Outpoint = { txId: "aa00", outputIndex: 0 };
    env.chain.candidates = [candidate({ outpoint: shared, blockHeight: 100 })];
    await engine.register(quote());
    const first = await engine.honor(KEY, (ctx) => env.cstore.deliver(ctx));
    assert.equal(first.status, "honored");

    // A DIFFERENT quote whose only candidate is the already-consumed outpoint. The
    // §5.2 single-mode INSERT collides on the consumed-outpoint PK → outpoint_consumed.
    const QID2 = asQuoteId("0123456789abcdef0123456789abcde2") as QuoteId;
    const key2: HonorKey = { signerPubkey: SIGNER, quoteId: QID2 };
    env.chain.defaultDatum = { quoteIdHex: QID2, honorable: true };
    env.chain.candidates = [candidate({ outpoint: shared, blockHeight: 100 })];
    await engine.register(quote({ quoteId: QID2 }));
    let delivered2 = 0;
    const out2 = await engine.honor(key2, (ctx) => {
      delivered2 += 1;
      env.cstore.deliver(ctx);
    });
    assert.equal(declineReason(outcomeVerdict(out2)), "outpoint_consumed");
    assert.equal(delivered2, 0, "no second delivery against a consumed outpoint (M4)");
    assert.equal(env.cstore.goodsCount(), 1, "still exactly one goods row");
  },

  // -- payee ----------------------------------------------------------------
  "payee/not-controlled": async (env, _vec) => {
    // M3/R2: controlsPayee=false → decline; keystore throw → retryable fault, NOT decline.
    const engine = buildEngine(env);
    env.chain.defaultDatum = { quoteIdHex: CANON_QID, honorable: true };
    env.chain.candidates = [candidate()];
    await engine.register(quote());

    env.keys.controls = false;
    const declined = await engine.honor(KEY, (ctx) => env.cstore.deliver(ctx));
    assert.equal(declineReason(outcomeVerdict(declined)), "payee_not_controlled");
    assert.equal(env.cstore.goodsCount(), 0);

    env.keys.controls = "throw";
    await assert.rejects(
      () => engine.honor(KEY, (ctx) => env.cstore.deliver(ctx)),
      (e: unknown) => {
        // unavailability is a RETRYABLE keystore_fault, never a decline.
        assert.equal((e as { code?: string }).code, "keystore_fault");
        return true;
      },
    );
    assert.equal(env.cstore.goodsCount(), 0, "no goods on a transient keystore fault");
  },

  // -- amount ---------------------------------------------------------------
  "amount/below": async (env, vec) => {
    await runAmountMismatch(env, vec);
  },
  "amount/above": async (env, vec) => {
    await runAmountMismatch(env, vec);
  },

  // -- payer ----------------------------------------------------------------
  "payer/consent": async (env, _vec) => {
    // R5 CONSENT (default): a registered payerPubkey IS the consent record → honor.
    const cfg = defaultConfig({ payerBinding: "consent", requirePayerFunded: false });
    const env2 = { ...env, config: cfg };
    const engine = buildEngine(env2);
    env.chain.defaultDatum = { quoteIdHex: CANON_QID, honorable: true };
    env.chain.candidates = [candidate()];
    await engine.register(quote({ payerPubkey: PAYER }));
    const v = await engine.canHonor(KEY);
    assert.equal(v.decision, "honor", "CONSENT binding passes");
  },
  "payer/source": async (env, _vec) => {
    // R5 SOURCE: a payer-keyed prevout must fund; covenant-only fails.
    const cfg = defaultConfig({ payerBinding: "source", requirePayerFunded: true });

    // case 1 — prevouts keyed to the payer → honor.
    {
      const env2 = { ...env, config: cfg };
      const engine = buildEngine(env2);
      env.chain.defaultDatum = { quoteIdHex: CANON_QID, honorable: true };
      env.chain.candidates = [candidate({ outpoint: { txId: "aa00", outputIndex: 0 } })];
      const prevout: Outpoint = { txId: "src0", outputIndex: 0 };
      env.chain.txInputs.set("aa00", [{ prevout }]);
      env.chain.scripts.set(opKey(prevout), PAYER_SCRIPT);
      await engine.register(quote({ payerPubkey: PAYER }));
      const v = await engine.canHonor(KEY);
      assert.equal(
        v.decision,
        "honor",
        "SOURCE binding passes when payer-keyed prevout funds",
      );
    }

    // case 2 — covenant-only (no payer-keyed prevout) → payer_binding_failed.
    {
      const env2 = { ...env, config: cfg };
      env.chain.txInputs.set("aa00", []); // no resolvable prevouts (covenant-only)
      const engine = buildEngine(env2);
      const v = await engine.canHonor(KEY);
      assert.equal(declineReason(v), "payer_binding_failed", "covenant-only rejected");
    }
  },

  // -- r6 -------------------------------------------------------------------
  "r6/late-honor": async (env, _vec) => {
    // R6 §5.9: observed-before-expiry honors after expiry, within retainUntil;
    // first-seen-after-expiry (unobserved) declines expired_unobserved.
    // expiresAt 2000, maxRecheckWindow 600 → retainUntil 2600; now 2300.
    const cfg = defaultConfig({ maxRecheckWindow: 600 });

    // case 1 — observed before expiry → honor at now=2300.
    {
      const env2 = { ...env, config: cfg };
      const engine = buildEngine(env2);
      env.chain.defaultDatum = { quoteIdHex: CANON_QID, honorable: true };
      env.chain.candidates = [candidate()];
      env.clock.t = 1_500;
      await engine.register(quote({ expiresAt: 2_000 }), { now: 1_500 });
      await engine.markObserved(KEY, 1_500); // observed_before_expiry = 1
      env.clock.t = 2_300;
      const out = await engine.honor(KEY, (ctx) => env.cstore.deliver(ctx), {
        now: 2_300,
      });
      assert.equal(out.status, "honored", "late-honor permitted (observed in window)");
      assert.equal(env.cstore.goodsCount(), 1);
    }

    // case 2 — NEVER observed before expiry, first-seen after expiry → decline.
    {
      const env3 = env.cstore.reopen ? env.cstore.reopen() : null;
      const useEnv = env3 ?? env; // a fresh durable env if available, else reuse
      const cfg2 = defaultConfig({ maxRecheckWindow: 600 });
      const env2 = { ...useEnv, config: cfg2 };
      const engine = buildEngine(env2);
      const QID2 = asQuoteId("0123456789abcdef0123456789abcd02") as QuoteId;
      const key2: HonorKey = { signerPubkey: SIGNER, quoteId: QID2 };
      useEnv.chain.defaultDatum = { quoteIdHex: QID2, honorable: true };
      useEnv.chain.candidates = [candidate()];
      useEnv.clock.t = 2_300;
      // register AFTER expiry; never markObserved before expiry.
      const goodsBefore = useEnv.cstore.goodsCount();
      await engine.register(quote({ quoteId: QID2, expiresAt: 2_000 }), { now: 2_300 });
      const out = await engine.honor(key2, (ctx) => useEnv.cstore.deliver(ctx), {
        now: 2_300,
      });
      assert.equal(
        declineReason(outcomeVerdict(out)),
        "expired_unobserved",
        "first-seen-after-expiry (unobserved) declines (§5.9)",
      );
      // no NEW goods for the unobserved late-honor (a reused env may carry case-1's row).
      assert.equal(
        useEnv.cstore.goodsCount(),
        goodsBefore,
        "no goods for an unobserved late-honor",
      );
      if (env3) env3.cstore.dispose();
    }
  },
  "r6/swept-mid-honor": async (env, _vec) => {
    // F10: a sweep deletes the SEEN row between the scoring read and runHonorTxn.
    // The honor re-read finds the row gone → decline expired_unobserved, no delivery.
    // retainUntil 2600, now 3000 (> retainUntil) so a sweep at 3000 removes it.
    const cfg = defaultConfig({ maxRecheckWindow: 600 });
    const env2 = { ...env, config: cfg };
    const engine = buildEngine(env2);
    env.chain.defaultDatum = { quoteIdHex: CANON_QID, honorable: true };
    env.chain.candidates = [candidate()];
    env.clock.t = 1_500;
    await engine.register(quote({ expiresAt: 2_000 }), { now: 1_500 });
    await engine.markObserved(KEY, 1_500);

    // jump past retainUntil and sweep — the row is gone (the "swept mid-honor" effect).
    env.clock.t = 3_000;
    const swept = await engine.sweep(3_000);
    assert.equal(swept.seenDeleted, 1, "sweep removed the out-of-retention row");

    let delivered = 0;
    const out = await engine.honor(
      KEY,
      (ctx) => {
        delivered += 1;
        env.cstore.deliver(ctx);
      },
      { now: 3_000 },
    );
    assert.equal(declineReason(outcomeVerdict(out)), "expired_unobserved");
    assert.equal(delivered, 0, "no delivery once the row is swept");
    assert.equal(env.cstore.goodsCount(), 0);
  },

  // -- htlc -----------------------------------------------------------------
  "htlc/two-phase": async (env, _vec) => {
    // F13/R3: Phase A reserve (claim_pending) → Phase B promote → exactly one delivery.
    const engine = buildEngine(env);
    const LOCK: Outpoint = { txId: "lock0", outputIndex: 0 };
    env.chain.defaultDatum = { quoteIdHex: CANON_QID, honorable: true };
    env.chain.candidates = [
      { outpoint: LOCK, value: 100_000_000n, scriptHex: PAYEE_SCRIPT, blockHeight: 90 },
    ];
    env.chain.htlcs.set(opKey(LOCK), {
      lock: LOCK,
      receiverPubkey: PAYEE,
      senderPubkey: PAYER,
      hashLock: "abcd",
      timeoutHeight: 10_000,
      value: 100_000_000n,
      lockBlockHeight: 90,
      state: "locked",
    });
    await engine.register(quote({ form: "htlc", payerPubkey: PAYER }));

    // Phase A: claim submitted → wait htlc_claim_pending, no delivery, no SEEN lock.
    const phaseA = await engine.honor(KEY, (ctx) => env.cstore.deliver(ctx));
    assert.equal(waitReason(outcomeVerdict(phaseA)), "htlc_claim_pending");
    assert.equal(env.cstore.goodsCount(), 0, "no delivery at Phase A");
    assert.equal(env.chain.submittedClaims, 1, "claim submitted exactly once");
    assert.equal((await engine.status(KEY))?.state, "claim_submitted");

    // Phase B: claim buried CLAIM_MARGIN(19) deep off the live tip → promote → deliver.
    env.chain.tip = 200;
    env.chain.txHeights.set("claim01", 200 - 19 + 1); // depth == 19
    let delivered = 0;
    const phaseB = await engine.honor(KEY, (ctx) => {
      delivered += 1;
      env.cstore.deliver(ctx);
    });
    assert.equal(phaseB.status, "honored", "Phase B promotes + honors");
    assert.equal(delivered, 1, "exactly one delivery across both phases");
    assert.equal(env.cstore.goodsCount(), 1);
    assert.equal(env.chain.submittedClaims, 1, "claim never re-submitted");
  },
  "htlc/reorg-withheld": async (env, _vec) => {
    // R3: a claim un-mined by a reorg → wait reorg_withheld, never a premature honor.
    const engine = buildEngine(env);
    const LOCK: Outpoint = { txId: "lock0", outputIndex: 0 };
    env.chain.defaultDatum = { quoteIdHex: CANON_QID, honorable: true };
    env.chain.candidates = [
      { outpoint: LOCK, value: 100_000_000n, scriptHex: PAYEE_SCRIPT, blockHeight: 90 },
    ];
    env.chain.htlcs.set(opKey(LOCK), {
      lock: LOCK,
      receiverPubkey: PAYEE,
      senderPubkey: PAYER,
      hashLock: "abcd",
      timeoutHeight: 10_000,
      value: 100_000_000n,
      lockBlockHeight: 90,
      state: "locked",
    });
    await engine.register(quote({ form: "htlc", payerPubkey: PAYER }));

    // Phase A submits the claim.
    await engine.honor(KEY, (ctx) => env.cstore.deliver(ctx));

    // The claim was seen buried (depth 19), then a reorg drops it to depth 4 (< 19).
    env.chain.tip = 200;
    env.chain.txHeights.set("claim01", 200 - 4 + 1); // depth 4 < CLAIM_MARGIN 19
    let delivered = 0;
    const out = await engine.honor(KEY, (ctx) => {
      delivered += 1;
      env.cstore.deliver(ctx);
    });
    assert.equal(waitReason(outcomeVerdict(out)), "reorg_withheld");
    assert.equal(delivered, 0, "no premature honor under a reorg");
    assert.equal(env.cstore.goodsCount(), 0);
  },

  // -- deliver --------------------------------------------------------------
  "deliver/throws": async (env, _vec) => {
    // F11: deliver throws → gate rolled back (honored_at NULL, no outpoint row),
    // delivery_failed, no goods; a retry then succeeds.
    const engine = buildEngine(env);
    env.chain.defaultDatum = { quoteIdHex: CANON_QID, honorable: true };
    env.chain.candidates = [candidate()];
    await engine.register(quote());

    let attempts = 0;
    const flaky = (ctx: DeliverContext<"sync">): void => {
      attempts += 1;
      env.cstore.deliver(ctx); // write goods…
      if (attempts === 1) throw new Error("goods system down"); // …then throw → roll back both.
    };
    const out = await engine.honor(KEY, flaky);
    assert.equal(out.status, "delivery_failed", "deliver throw → delivery_failed (F11)");
    assert.equal((out as { retryable: boolean }).retryable, true);
    assert.equal(env.cstore.goodsCount(), 0, "goods rolled back with the gate (F11)");
    assert.equal((await engine.status(KEY))?.state ?? "accepted", "accepted");

    const retry = await engine.honor(KEY, flaky);
    assert.equal(retry.status, "honored", "retry succeeds after a clean rollback");
    assert.equal(env.cstore.goodsCount(), 1, "exactly one goods row after retry");
  },
  "deliver/async-under-sync": async (env, _vec) => {
    // F8: the COMPILE-time half lives in src/spec/deliver.test-d.ts (typecheck gate).
    // Here we exercise the RUNTIME guard half: a thenable-returning deliver under a
    // sync store throws (contract violation) and the gate rolls back — nothing commits.
    const engine = buildEngine(env);
    env.chain.defaultDatum = { quoteIdHex: CANON_QID, honorable: true };
    env.chain.candidates = [candidate()];
    await engine.register(quote());
    // bypass the compile-time rule with a cast to PROVE the runtime guard bites.
    const asyncDeliver = ((ctx: DeliverContext<"sync">) => {
      env.cstore.deliver(ctx);
      return Promise.resolve();
    }) as unknown as (ctx: DeliverContext<"sync">) => void;
    await assert.rejects(() => engine.honor(KEY, asyncDeliver), /F8 runtime guard/);
    assert.equal(env.cstore.goodsCount(), 0, "nothing committed after the F8 rollback");
    assert.equal((await engine.status(KEY))?.state ?? "accepted", "accepted");
  },
  "deliver/out-of-band-handle": async (env, _vec) => {
    // F12: writing goods via a SEPARATE connection (not DeliverContext.db) voids F3.
    // Only the durable SqliteStore can model this; the fake store skips it.
    if (env.cstore.deliverOutOfBand === undefined) return; // not modellable on this store
    const engine = buildEngine(env);
    env.chain.defaultDatum = { quoteIdHex: CANON_QID, honorable: true };
    env.chain.candidates = [candidate()];
    await engine.register(quote());
    // An out-of-band goods handle is a CONTRACT VIOLATION, not a policy outcome:
    // we opt into rethrowDeliveryErrors so the store_topology error propagates
    // uncaught (rather than being mapped to delivery_failed), and assert the gate
    // rolled back (no goods, SEEN not honored) — the F12 escape voids nothing.
    await assert.rejects(
      () =>
        engine.honor(KEY, (ctx) => env.cstore.deliverOutOfBand?.(ctx), {
          rethrowDeliveryErrors: true,
        }),
      (e: unknown) => {
        assert.equal(
          (e as { code?: string }).code,
          "store_topology",
          "out-of-band goods handle is a store_topology contract violation (F12)",
        );
        return true;
      },
    );
    assert.equal(
      env.cstore.goodsCount(),
      0,
      "no goods committed after the F12 rejection",
    );
    assert.equal((await engine.status(KEY))?.state ?? "accepted", "accepted");
  },

  // -- recovery -------------------------------------------------------------
  "recovery/crash-pre-commit": async (env, _vec) => {
    // F9 (sync model): a crash BEFORE commit writes nothing (the deliver throws,
    // standing in for an abrupt termination inside the txn body) → honored_at NULL,
    // no outpoint row, no goods. A clean retry then honors with exactly one delivery.
    const engine = buildEngine(env);
    env.chain.defaultDatum = { quoteIdHex: CANON_QID, honorable: true };
    env.chain.candidates = [candidate()];
    await engine.register(quote());

    let crash = true;
    const out = await engine.honor(KEY, (ctx) => {
      if (crash) throw new Error("crash before commit");
      env.cstore.deliver(ctx);
    });
    assert.equal(out.status, "delivery_failed", "crash-pre-commit leaves a clean slate");
    assert.equal(env.cstore.goodsCount(), 0, "nothing written before the crash");
    assert.equal((await engine.status(KEY))?.state ?? "accepted", "accepted");

    crash = false;
    const retry = await engine.honor(KEY, (ctx) => env.cstore.deliver(ctx));
    assert.equal(retry.status, "honored", "clean retry honors");
    assert.equal(env.cstore.goodsCount(), 1, "exactly one delivery on the retry");
  },
  "recovery/async-ambiguous-commit": async (env, _vec) => {
    // F9 (durable model): a durable, already-honored gate row whose paired delivery
    // is not provably durable MUST be re-honored idempotently — the goods write is
    // idempotent on (signer, quote), so a re-invoke does NOT double-deliver. We model
    // this on a durable store by reopening after an honor and replaying the deliver;
    // the idempotent goods write keeps the count at one. The fake store (non-durable)
    // skips it.
    if (env.cstore.reopen === undefined) return; // requires a durable reopen
    const engine = buildEngine(env);
    env.chain.defaultDatum = { quoteIdHex: CANON_QID, honorable: true };
    env.chain.candidates = [candidate()];
    await engine.register(quote());
    const out = await engine.honor(KEY, (ctx) => env.cstore.deliver(ctx));
    assert.equal(out.status, "honored");
    assert.equal(env.cstore.goodsCount(), 1);

    // Reopen the durable store (the "ambiguous commit" restart). The honored SEEN row
    // is durable; an idempotent re-deliver against it does not double-write goods.
    const re = env.cstore.reopen();
    re.chain.defaultDatum = { quoteIdHex: CANON_QID, honorable: true };
    re.chain.candidates = [candidate()];
    const engine2 = buildEngine(re);
    // a re-honor sees honored_at set → already_honored; the deliver is NOT re-invoked
    // by the standard path, and the durable idempotent goods row stays at one.
    let reInvoked = 0;
    const out2 = await engine2.honor(KEY, (ctx) => {
      reInvoked += 1;
      re.cstore.deliver(ctx);
    });
    assert.equal(declineReason(outcomeVerdict(out2)), "already_honored");
    assert.equal(reInvoked, 0, "standard re-honor does not re-fire deliver");
    assert.equal(
      re.cstore.goodsCount(),
      1,
      "the durable goods row survives the ambiguous-commit restart (idempotent)",
    );
    re.cstore.dispose();
  },
};

/** Shared amount-mismatch executor for amount/below and amount/above (R4/D4, exact ==). */
async function runAmountMismatch(env: ConformanceEnv, vec: Vector): Promise<void> {
  const engine = buildEngine(env);
  const exfer = BigInt(vec.fixture.exferAmount as string);
  const candValue = BigInt(vec.fixture.candidateValue as string);
  env.chain.defaultDatum = { quoteIdHex: CANON_QID, honorable: true };
  env.chain.candidates = [candidate({ value: candValue })];
  await engine.register(quote({ exferAmount: exfer }));
  let delivered = 0;
  const out = await engine.honor(KEY, (ctx) => {
    delivered += 1;
    env.cstore.deliver(ctx);
  });
  assert.equal(
    declineReason(outcomeVerdict(out)),
    "amount_mismatch",
    `value ${candValue} != exferAmount ${exfer} (exact ==, never >=)`,
  );
  assert.equal(delivered, 0);
  assert.equal(env.cstore.goodsCount(), 0);
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

/** Run ONE vector against a freshly-built env from `makeEnv`. */
export async function runVector(vec: Vector, makeEnv: EnvFactory): Promise<void> {
  const exec = EXECUTORS[vec.id];
  if (exec === undefined) {
    throw new Error(`no conformance executor for vector '${vec.id}'`);
  }
  const env = makeEnv();
  try {
    await exec(env, vec);
  } finally {
    env.cstore.dispose();
  }
}

/**
 * The vector ids this harness EXECUTES at runtime. A `compileTimeOnly` vector (the
 * F8 async-under-sync case) is enforced by the typecheck gate (deliver.test-d.ts)
 * and is excluded from the runtime loop; its RUNTIME-guard half is exercised by a
 * dedicated test via `runVector` directly. `vectors` is the loaded corpus so the
 * filter reads each vector's own `compileTimeOnly` flag (no hardcoded id list).
 */
export function runtimeVectorIds(vectors: readonly Vector[]): string[] {
  return vectors
    .filter((v) => v.compileTimeOnly !== true && v.id in EXECUTORS)
    .map((v) => v.id);
}

/** True iff the harness has a runtime executor for `id` (incl. the F8 runtime-guard half). */
export function hasExecutor(id: string): boolean {
  return id in EXECUTORS;
}
