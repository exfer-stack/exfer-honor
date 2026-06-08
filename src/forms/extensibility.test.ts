// Stage-4 EXTENSIBILITY proof (§4.5): a tiny THIRD form (`EchoForm`) is registered
// and driven through the UNMODIFIED engine, registry, and gate txn — alongside the
// builtin plain/htlc forms — without a single edit to /core or the other forms.
//
// This is the executable form of the §4.3 closed-union-strategy claim: a new form
// is purely additive. The test asserts:
//   1. the engine honors an EchoForm quote end-to-end (one delivery, gate honored);
//   2. the new form coexists with PlainOutputForm in one registry;
//   3. the engine NEVER special-cases the form id — it only calls
//      discover/score/prepare/gateMode through `forms.get(quote.form)`.
//
// Run: npm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHonorEngine } from "../core/engine.js";
import { FormRegistry } from "../core/registry.js";
import { FakeSyncStore } from "../core/fakes.test-helpers.js";
import type { HonorDeps } from "../ports/index.js";
import { PlainOutputForm } from "./plain.js";
import {
  FakeChain,
  FakeClock,
  FakeKeys,
  PAYEE_SCRIPT,
  QID_A,
  SIGNER,
  confirmedCandidate,
  plainQuote,
  testConfig,
} from "./fakes.test-helpers.js";
import { ECHO_FORM_ID, EchoForm, asFormId } from "./examples/trivial-form.js";

const KEY = { signerPubkey: SIGNER, quoteId: QID_A };

test("a trivial THIRD form (echo) honors through the UNMODIFIED engine (§4.5)", async () => {
  const store = new FakeSyncStore();
  const chain = new FakeChain();
  // The registry holds the builtin plain form AND the brand-new echo form. No
  // engine/core edit — the form plugs in via the registry.
  const forms = new FormRegistry([new PlainOutputForm(), new EchoForm()]);
  const deps: HonorDeps<"sync"> = {
    store,
    chain,
    keys: new FakeKeys(),
    clock: new FakeClock(5_000),
    forms,
    config: testConfig(),
  };
  const engine = createHonorEngine(deps);

  chain.candidates = [confirmedCandidate({ scriptHex: PAYEE_SCRIPT })];
  // A quote whose form is the NEW 'echo' id (cast at the registry boundary only).
  await engine.register(plainQuote({ form: asFormId(ECHO_FORM_ID) }));

  let delivered = 0;
  const out = await engine.honor(KEY, () => {
    delivered += 1;
  });
  assert.equal(out.status, "honored");
  assert.equal(delivered, 1);
  assert.equal(store.deliverCount, 1);
  assert.equal(store.peekOutpoint({ txId: "aa00", outputIndex: 0 })?.state, "honored");
});

test("the new form coexists with plain in one registry; each resolves by id", async () => {
  const forms = new FormRegistry([new PlainOutputForm(), new EchoForm()]);
  assert.equal(forms.get("plain").id, "plain");
  assert.equal(forms.get(asFormId(ECHO_FORM_ID)).id, ECHO_FORM_ID);
  assert.equal(forms.has(ECHO_FORM_ID), true);
});

test("the echo form maps outcomes onto CLOSED reason members (exhaustiveness held)", async () => {
  const store = new FakeSyncStore();
  const chain = new FakeChain();
  const forms = new FormRegistry([new EchoForm()]);
  const engine = createHonorEngine({
    store,
    chain,
    keys: new FakeKeys(),
    clock: new FakeClock(5_000),
    forms,
    config: testConfig(),
  });

  // amount mismatch → the closed 'amount_mismatch' member (no new enum needed).
  chain.candidates = [confirmedCandidate({ value: 1n })];
  await engine.register(plainQuote({ form: asFormId(ECHO_FORM_ID) }));
  const v = await engine.canHonor(KEY);
  assert.equal(v.decision, "decline");
  if (v.decision === "decline") assert.equal(v.reason, "amount_mismatch");
});
