// Stage-4 FORM unit tests: the REAL engine + REAL PlainOutputForm / HtlcForm
// driven against an in-memory fake ChainSource (the design's "fake ChainSource
// for tests"). Maps to the §9 conformance scenarios:
//
//   PlainOutputForm (R4):
//     plain/happy          — confirmed exact-amount output → exactly one delivery
//     amount/above|below   — != exact → amount_mismatch (never >=)
//     datum/hash-only      — honorable:false → datum_unhonorable (no fallback, M2)
//     datum/multi-id-reject— 32-byte datum → datum_unhonorable (F1)
//     address mismatch     — wrong script → address_mismatch (R4)
//     payee/not-controlled — controlsPayee false → payee_not_controlled; throw → retryable
//     insufficient depth   — shallow → wait insufficient_depth (R4 confirmed-to-depth)
//     payer/consent|source — R5 both modes; covenant-only → payer_binding_failed
//
//   HtlcForm (R3):
//     htlc/two-phase       — Phase A reserve → Phase B promote → exactly one delivery
//     htlc/reorg-withheld  — claim un-mined → reorg_withheld, no premature honor
//     timeout margin       — tip+CLAIM_MARGIN > timeout → withheld
//     R5-HTLC              — sender != payer → payer_binding_failed
//     on-chain enforcement — receiver/value bound to the ACTUAL htlc script
//
// Run: npm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHonorEngine } from "../core/engine.js";
import { createFormRegistry } from "../core/registry.js";
import { FakeSyncStore } from "../core/fakes.test-helpers.js";
import type { HonorDeps } from "../ports/index.js";
import { HtlcForm } from "./htlc.js";
import { PlainOutputForm } from "./plain.js";
import {
  FakeChain,
  FakeClock,
  FakeKeys,
  PAYEE_SCRIPT,
  PAYER,
  PAYER_SCRIPT,
  QID_A,
  QID_OTHER,
  SIGNER,
  confirmedCandidate,
  lockedHtlc,
  opKey,
  plainQuote,
  testConfig,
} from "./fakes.test-helpers.js";

const KEY = { signerPubkey: SIGNER, quoteId: QID_A };

// ===========================================================================
// PlainOutputForm (R4)
// ===========================================================================

function wirePlain(over: Partial<HonorDeps<"sync">> = {}) {
  const store = new FakeSyncStore();
  const chain = new FakeChain();
  const keys = new FakeKeys();
  const clock = new FakeClock(5_000);
  const forms = createFormRegistry([new PlainOutputForm()]);
  const config = testConfig();
  const deps: HonorDeps<"sync"> = { store, chain, keys, clock, forms, config, ...over };
  return { engine: createHonorEngine(deps), store, chain, keys, clock };
}

test("plain/happy: confirmed exact-amount output honors exactly once (R1/R4)", async () => {
  const { engine, store, chain } = wirePlain();
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
  assert.notEqual(store.peekSeen(SIGNER, QID_A)?.honoredAt, null);
  assert.equal(store.peekOutpoint({ txId: "aa00", outputIndex: 0 })?.state, "honored");
});

test("plain: canHonor is a pure read (verdict, no mutation)", async () => {
  const { engine, store, chain } = wirePlain();
  chain.candidates = [confirmedCandidate()];
  await engine.register(plainQuote());
  const v = await engine.canHonor(KEY);
  assert.equal(v.decision, "honor");
  assert.equal(store.peekSeen(SIGNER, QID_A)?.honoredAt, null);
  assert.equal(store.deliverCount, 0);
});

test("amount/above: value above exferAmount declines amount_mismatch (never >=)", async () => {
  const { engine, chain } = wirePlain();
  chain.candidates = [confirmedCandidate({ value: 100_000_001n })];
  await engine.register(plainQuote());
  const v = await engine.canHonor(KEY);
  assert.equal(v.decision, "decline");
  if (v.decision === "decline") assert.equal(v.reason, "amount_mismatch");
});

test("amount/below: value below exferAmount declines amount_mismatch", async () => {
  const { engine, chain } = wirePlain();
  chain.candidates = [confirmedCandidate({ value: 99_999_999n })];
  await engine.register(plainQuote());
  const v = await engine.canHonor(KEY);
  assert.equal(v.decision, "decline");
  if (v.decision === "decline") assert.equal(v.reason, "amount_mismatch");
});

test("datum/hash-only: honorable:false declines datum_unhonorable, no fallback (M2)", async () => {
  const { engine, chain } = wirePlain();
  const c = confirmedCandidate();
  chain.candidates = [c];
  chain.datums.set(opKey(c.outpoint), { quoteIdHex: null, honorable: false });
  await engine.register(plainQuote());
  const v = await engine.canHonor(KEY);
  assert.equal(v.decision, "decline");
  if (v.decision === "decline") assert.equal(v.reason, "datum_unhonorable");
});

test("datum/multi-id-reject: 32-byte datum strict-decode fails → datum_unhonorable (F1)", async () => {
  const { engine, chain } = wirePlain();
  const c = confirmedCandidate();
  chain.candidates = [c];
  // The indexer surfaced a 32-byte (two-quote_id) hex as honorable; the spine's
  // own strict re-decode MUST still reject it (F1 defence-in-depth).
  chain.datums.set(opKey(c.outpoint), {
    quoteIdHex:
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" as never,
    honorable: true,
  });
  await engine.register(plainQuote());
  const v = await engine.canHonor(KEY);
  assert.equal(v.decision, "decline");
  if (v.decision === "decline") assert.equal(v.reason, "datum_unhonorable");
});

test("address mismatch: wrong scriptHex declines address_mismatch (R4)", async () => {
  const { engine, chain } = wirePlain();
  chain.candidates = [confirmedCandidate({ scriptHex: "deadbeef" })];
  await engine.register(plainQuote());
  const v = await engine.canHonor(KEY);
  assert.equal(v.decision, "decline");
  if (v.decision === "decline") assert.equal(v.reason, "address_mismatch");
});

test("payee/not-controlled: controlsPayee false → payee_not_controlled (R2/M3)", async () => {
  const { engine, chain } = wirePlain({ keys: new FakeKeys(false) });
  chain.candidates = [confirmedCandidate()];
  await engine.register(plainQuote());
  const v = await engine.canHonor(KEY);
  assert.equal(v.decision, "decline");
  if (v.decision === "decline") assert.equal(v.reason, "payee_not_controlled");
});

test("payee custody throw is retryable keystore_fault, NOT a decline (R2/M3, §3.6)", async () => {
  const { engine, chain } = wirePlain({ keys: new FakeKeys(true, true) });
  chain.candidates = [confirmedCandidate()];
  await engine.register(plainQuote());
  await assert.rejects(
    engine.canHonor(KEY),
    (e: unknown) =>
      e instanceof Error && (e as { code?: string }).code === "keystore_fault",
  );
});

test("insufficient depth: shallow output waits insufficient_depth (R4)", async () => {
  const { engine, chain } = wirePlain();
  chain.tip = 102; // depth = 102 - 100 + 1 = 3 < CONFIRMATION_DEPTH 6
  chain.candidates = [confirmedCandidate({ blockHeight: 100 })];
  await engine.register(plainQuote());
  const v = await engine.canHonor(KEY);
  assert.equal(v.decision, "wait");
  if (v.decision === "wait") assert.equal(v.reason, "insufficient_depth");
});

test("unconfirmed output (blockHeight null) waits insufficient_depth (R4)", async () => {
  const { engine, chain } = wirePlain();
  chain.candidates = [confirmedCandidate({ blockHeight: null })];
  await engine.register(plainQuote());
  const v = await engine.canHonor(KEY);
  assert.equal(v.decision, "wait");
  if (v.decision === "wait") assert.equal(v.reason, "insufficient_depth");
});

test("no candidate carrying this quote_id → wait no_candidate (full-equality skip, F1)", async () => {
  const { engine, chain } = wirePlain();
  const c = confirmedCandidate();
  chain.candidates = [c];
  chain.datums.set(opKey(c.outpoint), { quoteIdHex: QID_OTHER, honorable: true });
  await engine.register(plainQuote());
  const v = await engine.canHonor(KEY);
  assert.equal(v.decision, "wait");
  if (v.decision === "wait") assert.equal(v.reason, "no_candidate");
});

// -- R5 payer binding -------------------------------------------------------

test("payer/consent: default CONSENT passes when payer recorded at ACCEPT (R5)", async () => {
  const { engine, chain } = wirePlain({
    config: testConfig({ payerBinding: "consent" }),
  });
  chain.candidates = [confirmedCandidate()];
  await engine.register(plainQuote({ payerPubkey: PAYER }));
  const v = await engine.canHonor(KEY);
  assert.equal(v.decision, "honor");
});

test("payer/source: a payer-keyed prevout funds the settlement → honor (R5)", async () => {
  const { engine, chain } = wirePlain({
    config: testConfig({ payerBinding: "source", requirePayerFunded: true }),
  });
  const c = confirmedCandidate();
  chain.candidates = [c];
  const prevout = { txId: "fund0", outputIndex: 0 };
  chain.txInputs.set(c.outpoint.txId, [{ prevout }]);
  chain.scripts.set(opKey(prevout), PAYER_SCRIPT); // payer-keyed prevout
  await engine.register(plainQuote({ payerPubkey: PAYER }));
  const v = await engine.canHonor(KEY);
  assert.equal(v.decision, "honor");
});

test("payer/source: covenant-only (no payer-keyed prevout) → payer_binding_failed (R5/D3)", async () => {
  const { engine, chain } = wirePlain({
    config: testConfig({ payerBinding: "source", requirePayerFunded: true }),
  });
  const c = confirmedCandidate();
  chain.candidates = [c];
  const prevout = { txId: "fund0", outputIndex: 0 };
  chain.txInputs.set(c.outpoint.txId, [{ prevout }]);
  chain.scripts.set(opKey(prevout), "covenantscript"); // NOT payer-keyed
  await engine.register(plainQuote({ payerPubkey: PAYER }));
  const v = await engine.canHonor(KEY);
  assert.equal(v.decision, "decline");
  if (v.decision === "decline") assert.equal(v.reason, "payer_binding_failed");
});

test("payer null (payer_flag 0): binding is N/A, passes regardless of mode (R5)", async () => {
  const { engine, chain } = wirePlain({
    config: testConfig({ payerBinding: "source", requirePayerFunded: true }),
  });
  chain.candidates = [confirmedCandidate()];
  await engine.register(plainQuote({ payerPubkey: null }));
  const v = await engine.canHonor(KEY);
  assert.equal(v.decision, "honor");
});

// ===========================================================================
// HtlcForm (R3) — two-phase, two clocks, reorg-revocable
// ===========================================================================

function wireHtlc(over: Partial<HonorDeps<"sync">> = {}) {
  const store = new FakeSyncStore();
  const chain = new FakeChain();
  const keys = new FakeKeys();
  const clock = new FakeClock(5_000);
  // The HTLC form is wired with the consumer's store as its claim-outpoint
  // reserver (Phase A reserves claim_pending, F13/M4) — core untouched.
  const forms = createFormRegistry([new HtlcForm(store)]);
  const config = testConfig();
  const deps: HonorDeps<"sync"> = { store, chain, keys, clock, forms, config, ...over };
  return { engine: createHonorEngine(deps), store, chain, keys, clock };
}

const LOCK = { txId: "lock0", outputIndex: 0 };

/** Seed a binding-valid, locked HTLC settlement on the fake chain. */
function seedHtlc(chain: FakeChain, over: Parameters<typeof lockedHtlc>[0] = {}) {
  chain.candidates = [
    {
      outpoint: LOCK,
      value: 100_000_000n,
      scriptHex: PAYEE_SCRIPT,
      blockHeight: 90,
    },
  ];
  chain.htlcs.set(opKey(LOCK), lockedHtlc({ lock: LOCK, ...over }));
}

test("htlc/two-phase: Phase A reserve → Phase B promote → exactly one delivery (F13/R3)", async () => {
  const { engine, store, chain } = wireHtlc();
  seedHtlc(chain);
  await engine.register(plainQuote({ form: "htlc", payerPubkey: PAYER }));

  // Phase A: claim submitted → wait htlc_claim_pending. No delivery, no SEEN lock,
  // but the lock outpoint IS reserved claim_pending (F13/M4).
  const phaseA = await engine.honor(KEY, () => {});
  assert.equal(phaseA.status, "not_ready");
  if (phaseA.status === "not_ready") {
    assert.equal(phaseA.verdict.decision, "wait");
    if (phaseA.verdict.decision === "wait") {
      assert.equal(phaseA.verdict.reason, "htlc_claim_pending");
    }
  }
  assert.equal(store.deliverCount, 0);
  assert.equal(store.peekSeen(SIGNER, QID_A)?.honoredAt, null);
  assert.equal(store.peekOutpoint(LOCK)?.state, "claim_pending");
  assert.equal(chain.submittedClaims, 1);
  assert.equal((await engine.status(KEY))?.state, "claim_submitted");

  // Tick again before the claim is buried: still pending (claim unconfirmed).
  chain.txHeights.set("claim01", null);
  const midway = await engine.honor(KEY, () => {});
  assert.equal(midway.status, "not_ready");
  assert.equal(store.deliverCount, 0);

  // Phase B: claim now buried CLAIM_MARGIN(19) deep off the live tip.
  chain.tip = 200;
  chain.txHeights.set("claim01", 200 - 19 + 1); // depth == 19
  let delivered = 0;
  const phaseB = await engine.honor(KEY, () => {
    delivered += 1;
  });
  assert.equal(phaseB.status, "honored");
  assert.equal(delivered, 1);
  assert.equal(store.deliverCount, 1); // exactly one delivery across all ticks
  // promote did not collide (F13): claim_pending → honored.
  assert.equal(store.peekOutpoint(LOCK)?.state, "honored");
  assert.equal(chain.submittedClaims, 1); // claim submitted exactly once
});

test("htlc/reorg-withheld: claim un-mined by reorg → reorg_withheld, no premature honor (R3)", async () => {
  const { engine, store, chain } = wireHtlc();
  seedHtlc(chain);
  await engine.register(plainQuote({ form: "htlc", payerPubkey: PAYER }));

  // Phase A.
  await engine.honor(KEY, () => {});
  assert.equal(store.peekOutpoint(LOCK)?.state, "claim_pending");

  // Claim was seen buried deep, then a reorg un-mines it.
  chain.tip = 200;
  chain.txHeights.set("claim01", null); // un-mined
  const out = await engine.honor(KEY, () => {});
  assert.equal(out.status, "not_ready");
  if (out.status === "not_ready") {
    assert.equal(out.verdict.decision, "wait");
    if (out.verdict.decision === "wait") {
      assert.equal(out.verdict.reason, "reorg_withheld");
    }
  }
  assert.equal(store.deliverCount, 0);
  // The once-pending reservation is NOT promoted while withheld.
  assert.equal(store.peekOutpoint(LOCK)?.state, "claim_pending");
});

test("htlc: reorg drops claim depth below CLAIM_MARGIN → withheld (reorg-revocable, R3)", async () => {
  const { engine, store, chain } = wireHtlc();
  seedHtlc(chain);
  await engine.register(plainQuote({ form: "htlc", payerPubkey: PAYER }));
  await engine.honor(KEY, () => {}); // Phase A

  // Claim mined but a shallow reorg leaves it only 4 deep (< 19).
  chain.tip = 100;
  chain.txHeights.set("claim01", 100 - 4 + 1); // depth == 4
  const out = await engine.honor(KEY, () => {});
  assert.equal(out.status, "not_ready");
  if (out.status === "not_ready" && out.verdict.decision === "wait") {
    assert.equal(out.verdict.reason, "reorg_withheld");
  }
  assert.equal(store.deliverCount, 0);
});

test("htlc timeout margin: tip + CLAIM_MARGIN > timeoutHeight → withheld (R3)", async () => {
  const { engine, store, chain } = wireHtlc();
  // timeout too close: tip(120) + claimMargin(19) = 139 > timeoutHeight 130.
  seedHtlc(chain, { timeoutHeight: 130 });
  await engine.register(plainQuote({ form: "htlc", payerPubkey: PAYER }));
  const out = await engine.honor(KEY, () => {});
  assert.equal(out.status, "not_ready");
  if (out.status === "not_ready" && out.verdict.decision === "wait") {
    assert.equal(out.verdict.reason, "reorg_withheld");
  }
  assert.equal(store.deliverCount, 0);
  assert.equal(chain.submittedClaims, 0); // never submitted a claim that can't bury
});

test("htlc R5-HTLC: on-chain sender != payer → payer_binding_failed (R5)", async () => {
  const { engine, chain } = wireHtlc();
  seedHtlc(chain, { senderPubkey: "44".repeat(32) as never });
  await engine.register(plainQuote({ form: "htlc", payerPubkey: PAYER }));
  const v = await engine.canHonor(KEY);
  assert.equal(v.decision, "decline");
  if (v.decision === "decline") assert.equal(v.reason, "payer_binding_failed");
});

test("htlc on-chain enforcement: receiver != payee → address_mismatch (R3)", async () => {
  const { engine, chain } = wireHtlc();
  seedHtlc(chain, { receiverPubkey: "55".repeat(32) as never });
  await engine.register(plainQuote({ form: "htlc", payerPubkey: PAYER }));
  const v = await engine.canHonor(KEY);
  assert.equal(v.decision, "decline");
  if (v.decision === "decline") assert.equal(v.reason, "address_mismatch");
});

test("htlc on-chain enforcement: value != exferAmount → amount_mismatch (R3, EXACT)", async () => {
  const { engine, chain } = wireHtlc();
  seedHtlc(chain, { value: 100_000_001n });
  await engine.register(plainQuote({ form: "htlc", payerPubkey: PAYER }));
  const v = await engine.canHonor(KEY);
  assert.equal(v.decision, "decline");
  if (v.decision === "decline") assert.equal(v.reason, "amount_mismatch");
});

test("htlc: no on-chain HTLC for the lock → wait no_candidate (R3)", async () => {
  const { engine, chain } = wireHtlc();
  chain.candidates = [
    { outpoint: LOCK, value: 100_000_000n, scriptHex: PAYEE_SCRIPT, blockHeight: 90 },
  ];
  // no htlc seeded
  await engine.register(plainQuote({ form: "htlc" }));
  const v = await engine.canHonor(KEY);
  assert.equal(v.decision, "wait");
  if (v.decision === "wait") assert.equal(v.reason, "no_candidate");
});
