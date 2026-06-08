// Stage-3 engine unit tests against the in-memory fake ports. Covers the §5
// atomic-honor holes the design freezes:
//   - happy path (R1/R4): one confirmed exact-amount output → exactly one delivery
//   - F3: one quote, two outpoints → first honors, second already_honored
//   - F10: concurrent honor of the same quote → exactly one delivery, other declines
//   - F11: deliver throw rolls back BOTH gate writes (clean) → delivery_failed;
//          rethrowDeliveryErrors re-throws the original consumer error
//   - F9: HTLC one-recovery-model two-phase: Phase A reserve → Phase B promote →
//         exactly one delivery (no commit-then-deliver window)
//   - R6 late-honor / retention: observed-before-expiry honors in window;
//          first-seen-after-expiry declines; sweep deletes past retain
//   - D1 CLAIM_MARGIN assert: strict identity enforced at construction
// Run: npm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHonorEngine } from "./engine.js";
import { createFormRegistry } from "./registry.js";
import {
  FakeChain,
  FakeClock,
  FakeKeys,
  FakeSyncStore,
  PAYEE_SCRIPT,
  QID_A,
  SIGNER,
  TestHtlcForm,
  TestPlainForm,
  confirmedCandidate,
  plainQuote,
  testConfig,
} from "./fakes.test-helpers.js";
import type { HonorDeps } from "../ports/index.js";

function wire(over: Partial<HonorDeps<"sync">> = {}) {
  const store = new FakeSyncStore();
  const chain = new FakeChain();
  const keys = new FakeKeys();
  const clock = new FakeClock(5_000);
  const forms = createFormRegistry([new TestPlainForm()]);
  const config = testConfig();
  const deps: HonorDeps<"sync"> = { store, chain, keys, clock, forms, config, ...over };
  const engine = createHonorEngine(deps);
  return { engine, store, chain, keys, clock, deps };
}

const KEY = { signerPubkey: SIGNER, quoteId: QID_A };

// ---------------------------------------------------------------------------
// happy path (R1/R4) — exactly one delivery
// ---------------------------------------------------------------------------

test("happy: confirmed exact-amount output honors exactly once", async () => {
  const { engine, store, chain } = wire();
  chain.candidates = [confirmedCandidate()];

  await engine.register(plainQuote());
  await engine.markObserved(KEY, 5_000);

  let delivered = 0;
  const out = await engine.honor(KEY, () => {
    delivered += 1;
  });
  assert.equal(out.status, "honored");
  assert.equal(delivered, 1);
  assert.equal(store.deliverCount, 1);

  const seen = store.peekSeen(SIGNER, QID_A);
  assert.notEqual(seen?.honoredAt, null);

  const status = await engine.status(KEY);
  assert.equal(status?.state, "honored");
});

test("canHonor is a pure read: honor verdict without mutation", async () => {
  const { engine, store, chain } = wire();
  chain.candidates = [confirmedCandidate()];
  await engine.register(plainQuote());

  const v = await engine.canHonor(KEY);
  assert.equal(v.decision, "honor");
  // pure read: no honor, no lock.
  assert.equal(store.peekSeen(SIGNER, QID_A)?.honoredAt, null);
  assert.equal(store.deliverCount, 0);
});

test("register is idempotent on (signerPubkey, quoteId)", async () => {
  const { engine } = wire();
  const r1 = await engine.register(plainQuote());
  const r2 = await engine.register(plainQuote());
  assert.equal(r1.created, true);
  assert.equal(r2.created, false);
  assert.equal(r1.retainUntil, r2.retainUntil);
});

// ---------------------------------------------------------------------------
// F3 — one quote, two outpoints → first honors, second already_honored
// ---------------------------------------------------------------------------

test("F3: one quote two outpoints → first honors, second already_honored", async () => {
  const { engine, store, chain } = wire();
  chain.candidates = [confirmedCandidate({ outpoint: { txId: "txA", outputIndex: 0 } })];
  await engine.register(plainQuote());

  const out1 = await engine.honor(KEY, () => {});
  assert.equal(out1.status, "honored");

  // A second settlement for the SAME quote_id appears at a different outpoint.
  chain.candidates = [confirmedCandidate({ outpoint: { txId: "txB", outputIndex: 1 } })];
  const out2 = await engine.honor(KEY, () => {});
  assert.equal(out2.status, "not_ready");
  if (out2.status === "not_ready") {
    assert.equal(out2.verdict.decision, "decline");
    if (out2.verdict.decision === "decline") {
      assert.equal(out2.verdict.reason, "already_honored");
    }
  }
  assert.equal(store.deliverCount, 1); // exactly one delivery
});

// ---------------------------------------------------------------------------
// F10 — concurrent honor of the same quote → exactly one delivery
// ---------------------------------------------------------------------------

test("F10: concurrent honor of same quote → exactly one delivery", async () => {
  const { engine, store, chain } = wire();
  chain.candidates = [confirmedCandidate()];
  await engine.register(plainQuote());

  // Two honor calls race. The FakeSyncStore's runHonorTxn is a synchronous
  // critical section, so whichever locks SEEN first wins; the other raises
  // GateViolation → already_honored. (Promise.all serializes the sync bodies but
  // models the contend-at-the-gate semantics §5.8.)
  const [a, b] = await Promise.all([
    engine.honor(KEY, () => {}),
    engine.honor(KEY, () => {}),
  ]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, ["honored", "not_ready"]);
  assert.equal(store.deliverCount, 1);
});

// ---------------------------------------------------------------------------
// F11 — deliver throw rolls back BOTH gate writes
// ---------------------------------------------------------------------------

test("F11: deliver throw rolls back the gate → delivery_failed, gate clean", async () => {
  const { engine, store, chain } = wire();
  chain.candidates = [confirmedCandidate()];
  await engine.register(plainQuote());

  const out = await engine.honor(KEY, () => {
    throw new Error("goods system down");
  });
  assert.equal(out.status, "delivery_failed");
  if (out.status === "delivery_failed") {
    assert.equal(out.retryable, true);
  }
  // Gate is provably clean: SEEN not honored, no outpoint row.
  assert.equal(store.peekSeen(SIGNER, QID_A)?.honoredAt, null);
  assert.equal(store.peekOutpoint({ txId: "tx1", outputIndex: 0 }), undefined);

  // Retry next tick succeeds (the rollback left a clean slate).
  let delivered = 0;
  const retry = await engine.honor(KEY, () => {
    delivered += 1;
  });
  assert.equal(retry.status, "honored");
  assert.equal(delivered, 1);
});

test("F11: rethrowDeliveryErrors re-throws the original consumer error", async () => {
  const { engine, chain } = wire();
  chain.candidates = [confirmedCandidate()];
  await engine.register(plainQuote());

  const boom = new Error("rethrow me");
  await assert.rejects(
    engine.honor(
      KEY,
      () => {
        throw boom;
      },
      { rethrowDeliveryErrors: true },
    ),
    (e) => e === boom,
  );
});

// ---------------------------------------------------------------------------
// F8 — runtime hot-path guard: async deliver under sync store rolls back
// ---------------------------------------------------------------------------

test("F8 runtime: thenable deliver throws and leaves gate clean", async () => {
  const { engine, store, chain } = wire();
  chain.candidates = [confirmedCandidate()];
  await engine.register(plainQuote());

  await assert.rejects(
    engine.honor(KEY, (() => Promise.resolve()) as unknown as () => void),
  );
  assert.equal(store.peekSeen(SIGNER, QID_A)?.honoredAt, null);
  assert.equal(store.deliverCount, 0);
});

// ---------------------------------------------------------------------------
// F9 — HTLC one recovery model: two-phase, exactly one delivery
// ---------------------------------------------------------------------------

test("F9/F13: HTLC Phase A reserve → Phase B promote → exactly one delivery", async () => {
  const store = new FakeSyncStore();
  const chain = new FakeChain();
  const htlcForm = new TestHtlcForm();
  const deps: HonorDeps<"sync"> = {
    store,
    chain,
    keys: new FakeKeys(),
    clock: new FakeClock(5_000),
    forms: createFormRegistry([htlcForm]),
    config: testConfig(),
  };
  const engine = createHonorEngine(deps);

  chain.candidates = [confirmedCandidate()];
  await engine.register(plainQuote({ form: "htlc" }));

  // Phase A: claim submitted → wait htlc_claim_pending. No delivery, no SEEN lock.
  // (The form reserves the outpoint via the store as part of its prepare; here the
  //  test form only signals claim_submitted — the engine records the claim status.)
  await store.reserveClaimOutpoint(
    SIGNER,
    QID_A,
    { txId: "tx1", outputIndex: 0 },
    "c1a1mtx",
    5_000,
  );
  const phaseA = await engine.honor(KEY, () => {});
  assert.equal(phaseA.status, "not_ready");
  if (phaseA.status === "not_ready") {
    assert.equal(phaseA.verdict.decision, "wait");
  }
  assert.equal(store.deliverCount, 0);
  assert.equal(store.peekSeen(SIGNER, QID_A)?.honoredAt, null);
  assert.equal((await engine.status(KEY))?.state, "claim_submitted");

  // Phase B: claim now buried CLAIM_MARGIN(19) deep off the live tip.
  chain.tip = 200;
  chain.claimTx = { blockHeight: 200 - 19 + 1 }; // depth == 19
  let delivered = 0;
  const phaseB = await engine.honor(KEY, () => {
    delivered += 1;
  });
  assert.equal(phaseB.status, "honored");
  assert.equal(delivered, 1);
  assert.equal(store.deliverCount, 1); // exactly one delivery across both phases
  // The promote did not collide (F13): outpoint promoted claim_pending → honored.
  assert.equal(store.peekOutpoint({ txId: "tx1", outputIndex: 0 })?.state, "honored");
});

test("F9: HTLC reorg un-mines the claim → reorg_withheld, no premature honor", async () => {
  const store = new FakeSyncStore();
  const chain = new FakeChain();
  const htlcForm = new TestHtlcForm();
  htlcForm.claimSubmitted = true; // already past Phase A
  const deps: HonorDeps<"sync"> = {
    store,
    chain,
    keys: new FakeKeys(),
    clock: new FakeClock(5_000),
    forms: createFormRegistry([htlcForm]),
    config: testConfig(),
  };
  const engine = createHonorEngine(deps);
  chain.candidates = [confirmedCandidate()];
  await engine.register(plainQuote({ form: "htlc" }));
  await store.reserveClaimOutpoint(
    SIGNER,
    QID_A,
    { txId: "tx1", outputIndex: 0 },
    "c1a1mtx",
    5_000,
  );

  chain.tip = 200;
  chain.claimTx = null; // claim un-mined by a reorg
  const out = await engine.honor(KEY, () => {});
  assert.equal(out.status, "not_ready");
  if (out.status === "not_ready") {
    assert.equal(out.verdict.decision, "wait");
    if (out.verdict.decision === "wait") {
      assert.equal(out.verdict.reason, "reorg_withheld");
    }
  }
  assert.equal(store.deliverCount, 0);
});

// ---------------------------------------------------------------------------
// R6 — late-honor / retention windowing
// ---------------------------------------------------------------------------

test("R6 late-honor: observed-before-expiry honors after expiry, within retain window", async () => {
  const { engine, store, chain, clock } = wire();
  chain.candidates = [confirmedCandidate()];
  await engine.register(plainQuote()); // expiresAt 10_000, retainUntil 13_600

  // Observe before expiry — THIS is the load-bearing precondition: the late-honor
  // guard (§5.9) only permits an after-expiry honor BECAUSE observed_before_expiry
  // latched. The negative test below proves an after-expiry honor WITHOUT it declines.
  await engine.markObserved(KEY, 9_000);
  assert.equal(
    store.peekSeen(SIGNER, QID_A)?.observedBeforeExpiry,
    true,
    "precondition: observed_before_expiry must be set for the late-honor to be permitted",
  );

  // Honor AFTER expiry but within retain window.
  clock.t = 11_000;
  let delivered = 0;
  const out = await engine.honor(KEY, () => {
    delivered += 1;
  });
  assert.equal(out.status, "honored");
  assert.equal(delivered, 1);
});

test("R6 late-honor: first-seen AFTER expiry without observation declines 'expired_unobserved' (vector r6/late-honor case 2)", async () => {
  // §5.9 / vector r6/late-honor case 2: a quote whose observed_before_expiry never
  // latched (first-seen AT/AFTER expires_at) MUST be DECLINED at the in-txn late-honor
  // guard when honored after expiry — even inside the retain window. This proves the
  // FakeSyncStore enforces `(now < expires_at OR observed_before_expiry)` and matches
  // the real SqliteStore predicate; without that clause the engine would wrongly honor.
  const { engine, store, chain, clock } = wire();
  chain.candidates = [confirmedCandidate()];
  await engine.register(plainQuote()); // expiresAt 10_000, retainUntil 13_600

  // markObserved happens AT/AFTER expiry → does NOT latch (now < expires_at is false).
  const obs = await engine.markObserved(KEY, 10_000);
  assert.equal(obs.withinWindow, false);
  assert.equal(
    store.peekSeen(SIGNER, QID_A)?.observedBeforeExpiry,
    false,
    "observed_before_expiry must stay 0 when first-seen at/after expiry",
  );

  // Honor AFTER expiry but within retain window (10_000 <= now < 13_600).
  clock.t = 11_000;
  let delivered = 0;
  const out = await engine.honor(KEY, () => {
    delivered += 1;
  });

  // Must DECLINE — not honor — with the expired_unobserved reason (§5.9).
  assert.equal(out.status, "not_ready");
  if (out.status === "not_ready") {
    assert.equal(out.verdict.decision, "decline");
    if (out.verdict.decision === "decline") {
      assert.equal(out.verdict.reason, "expired_unobserved");
    }
  }
  assert.equal(delivered, 0, "no delivery for an unobserved late-honor");
  assert.equal(store.deliverCount, 0, "deliver never ran (gate rejected first)");
  assert.equal(
    store.peekSeen(SIGNER, QID_A)?.honoredAt,
    null,
    "SEEN row must remain unhonored (clean gate, F10)",
  );
});

test("R6: honor past retainUntil is rejected at the in-txn window guard (F10/§5.8)", async () => {
  const { engine, store, chain, clock } = wire();
  chain.candidates = [confirmedCandidate()];
  await engine.register(plainQuote()); // retainUntil 13_600
  await engine.markObserved(KEY, 9_000);

  clock.t = 20_000; // past retainUntil
  const out = await engine.honor(KEY, () => {});
  // The §5.8 in-txn guard (now < retainUntil) fails → GateViolation mapped.
  assert.equal(out.status, "not_ready");
  assert.equal(store.deliverCount, 0);
  assert.equal(store.peekSeen(SIGNER, QID_A)?.honoredAt, null);
});

test("R6 markObserved only latches while now < expiresAt", async () => {
  const { engine, store } = wire();
  await engine.register(plainQuote());
  const r = await engine.markObserved(KEY, 10_001); // after expiry
  assert.equal(r.withinWindow, false);
  assert.equal(store.peekSeen(SIGNER, QID_A)?.observedBeforeExpiry, false);
});

test("R6 sweep deletes rows past retainUntil", async () => {
  const { engine, store, chain } = wire();
  chain.candidates = [confirmedCandidate()];
  await engine.register(plainQuote());
  await engine.honor(KEY, () => {});

  const before = store.peekSeen(SIGNER, QID_A);
  assert.notEqual(before, undefined);

  const res = await engine.sweep(20_000); // past retainUntil 13_600
  assert.equal(res.seenDeleted, 1);
  assert.equal(res.outpointsDeleted, 1);
  assert.equal(store.peekSeen(SIGNER, QID_A), undefined);
});

// ---------------------------------------------------------------------------
// D1 — CLAIM_MARGIN startup assert
// ---------------------------------------------------------------------------

test("D1: CLAIM_MARGIN strict-identity assert throws at construction when wrong", () => {
  assert.throws(
    () => {
      const store = new FakeSyncStore();
      createHonorEngine({
        store,
        chain: new FakeChain(),
        keys: new FakeKeys(),
        clock: new FakeClock(0),
        forms: createFormRegistry([new TestPlainForm()]),
        config: testConfig({ claimMargin: 18 }), // 12+6+1 = 19, not 18
      });
    },
    (e: unknown) =>
      e instanceof Error &&
      "code" in e &&
      (e as { code: string }).code === "claim_margin_assertion",
  );
});

test("D1: the derived CLAIM_MARGIN (12+6+1=19) constructs cleanly", () => {
  const store = new FakeSyncStore();
  const engine = createHonorEngine({
    store,
    chain: new FakeChain(),
    keys: new FakeKeys(),
    clock: new FakeClock(0),
    forms: createFormRegistry([new TestPlainForm()]),
    config: testConfig(), // claimMargin defaults to 19
  });
  assert.equal(engine.apiVersion, 1);
});

// ---------------------------------------------------------------------------
// scoring spine declines (R4/M2) — exercised through the test plain form
// ---------------------------------------------------------------------------

test("R4: amount mismatch declines", async () => {
  const { engine, chain } = wire();
  chain.candidates = [confirmedCandidate({ value: 999n })];
  await engine.register(plainQuote());
  const out = await engine.honor(KEY, () => {});
  assert.equal(out.status, "not_ready");
  if (out.status === "not_ready" && out.verdict.decision === "decline") {
    assert.equal(out.verdict.reason, "amount_mismatch");
  }
});

test("M2: datum_hash-only (honorable=false) declines datum_unhonorable", async () => {
  const { engine, chain } = wire();
  chain.candidates = [confirmedCandidate()];
  chain.datum = { quoteIdHex: null, honorable: false };
  await engine.register(plainQuote());
  const out = await engine.honor(KEY, () => {});
  assert.equal(out.status, "not_ready");
  if (out.status === "not_ready" && out.verdict.decision === "decline") {
    assert.equal(out.verdict.reason, "datum_unhonorable");
  }
});

test("registry rejects an unregistered form id (malformed_quote)", async () => {
  const { deps } = wire();
  assert.throws(
    () => deps.forms.get("htlc"),
    (e: unknown) =>
      e instanceof Error &&
      "code" in e &&
      (e as { code: string }).code === "malformed_quote",
  );
});

void PAYEE_SCRIPT;
