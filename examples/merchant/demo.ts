// NARRATED DEMO RUNNER — zero infra, deterministic, exits 0 iff all four
// scenarios produce the REAL engine outcome the script asserts.
//
//   npm run demo            (from examples/merchant, or `npm run demo` at the root)
//
// The story: an AUTONOMOUS AI AGENT buys metered access to a PAY-PER-CALL API.
// The agent holds an exfer-mcp wallet and settles on its own — no human, no credit
// card, no account. Price is quoted in USD; the binding amount on the wire is
// EXFER (the issuer signs the EXFER amount into the quote). On honor, the API
// service issues an api_key carrying N prepaid calls (credits).
//
// Each scenario prints what truthfully happens at each step. Every honor/decline
// is the REAL verdict from the real engine over the real SqliteStore gate — the
// scenario driver only feeds realistic chain facts (settlement appears / confirms
// to depth / quote expires) by advancing the fake clock + tip.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  apiKeyCount,
  fulfilOnPayment,
  initMerchantTables,
  placeOrder,
  readOrder,
} from "./merchant.js";
import { buildQuotePrice, formatUsd } from "./priceFeed.js";
import { buildService, realModeConfigured, type DemoPorts } from "./service.js";
import {
  CONFIG,
  acceptedQuote,
  currentDepth,
  quoteId,
  resetChain,
  settlementAppears,
  setClock,
  setTip,
} from "./scenario.js";
import type { HonorService } from "exfer-honor";
import type Database from "better-sqlite3";

const SKU = "inference-api"; // the metered plan the agent is buying access to
const CREDITS = 1000; // API calls the agent buys in each scenario
const USD_PRICE = 1250; // cents → $12.50 for 1000 calls
const DEPTH = CONFIG.confirmationDepth; // 6

// USD price → binding EXFER amount (DEMO stub feed; real mode derives the rate
// off-chain from exfer-swap EXFER/BNB reserves × BNB/USD — see priceFeed.ts).
const PRICE_QUOTE = buildQuotePrice(USD_PRICE);
const PRICE = PRICE_QUOTE.exferAmount; // the ONLY binding amount

function hr(): void {
  console.log("─".repeat(72));
}
function step(msg: string): void {
  console.log(`   · ${msg}`);
}
/** Narrate the USD→EXFER pricing line: "price in USD, settle in EXFER". */
function priceLine(): string {
  return (
    `quote: ${formatUsd(PRICE_QUOTE.usdMinor)} @ 1 EXFER = ` +
    `$${PRICE_QUOTE.usdPerExfer}  → ` +
    `${PRICE} base units EXFER (binding)`
  );
}

async function main(): Promise<void> {
  if (realModeConfigured()) {
    console.log(
      "real-service env vars are set; the demo scenario driver only runs against\n" +
        "the in-memory fakes. Unset EXFER_WALLETD_URL/INDEXER_URL/NODE_URL to run the demo.",
    );
    process.exit(0);
  }

  const dir = mkdtempSync(join(tmpdir(), "exfer-api-"));
  const dbPath = join(dir, "api-service.db");
  console.log(`exfer-honor agent ↔ pay-per-call API demo — zero infra (real engine, real SQLite gate)`);
  console.log(`an autonomous AI agent (exfer-mcp wallet) buys metered API access; price USD, settle EXFER`);
  console.log(`SQLite gate + API-service goods on one file: ${dbPath}`);
  console.log(`CONFIRMATION_DEPTH = ${DEPTH}`);
  console.log(`pricing: ${priceLine()}\n`);

  const { service, db, demo } = await buildService({
    dbPath,
    payee: "demo-api-service",
    fast: true,
  });
  if (!demo) throw new Error("demo ports missing in demo mode");
  initMerchantTables(db);

  try {
    await happyPath(service, db, demo);
    await replayDoublePay(service, db, demo);
    await waitsForDepth(service, db, demo);
    await expired(service, db, demo);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }

  hr();
  console.log("ALL FOUR SCENARIOS PASSED — every outcome came from the real engine.");
}

// (a) HAPPY PATH ------------------------------------------------------------
async function happyPath(
  service: HonorService<"sync">,
  db: Database.Database,
  demo: DemoPorts,
): Promise<void> {
  hr();
  console.log("SCENARIO (a) HAPPY PATH — agent buys 1000 credits, confirm to depth, issue once");
  resetChain(demo);
  const q = acceptedQuote({ quoteId: quoteId("a"), amount: PRICE, expiresAt: 10_000 });
  setClock(demo, 1_000);
  setTip(demo, 200);
  placeOrder(db, q.quoteId, SKU, CREDITS);
  step(`agent accepts quote ${q.quoteId.slice(0, 8)}… for ${CREDITS} ${SKU} calls — ${priceLine()}`);

  // payment appears, then confirms to depth (tip 200, mined at 195 → depth 6).
  settlementAppears(demo, q, 195);
  step(`agent's EXFER payment observed on-chain at height 195; depth ${currentDepth(demo)} ≥ ${DEPTH} → confirmed`);

  const res = await fulfilOnPayment(service, db, q);
  assert.equal(res.status, "honored", "happy path must honor");
  assert.ok(res.apiKey, "an api_key must be issued");
  assert.equal(res.credits, CREDITS, "the full credit balance must be issued");
  assert.equal(apiKeyCount(db, q.quoteId), 1, "exactly one api_key");
  assert.equal(readOrder(db, q.quoteId)?.state, "fulfilled", "order fulfilled");
  step(`HONORED → api_key issued: ${res.apiKey} with ${res.credits} prepaid calls`);
  step(`order ${q.quoteId.slice(0, 8)}… marked FULFILLED (atomically with the gate)`);
}

// (b) REPLAY / DOUBLE-CREDIT ------------------------------------------------
async function replayDoublePay(
  service: HonorService<"sync">,
  db: Database.Database,
  demo: DemoPorts,
): Promise<void> {
  hr();
  console.log("SCENARIO (b) REPLAY / DOUBLE-CREDIT — same honored quote presented again");
  // Re-present the SAME quote + settlement from (a). It is already honored.
  const q = acceptedQuote({ quoteId: quoteId("a"), amount: PRICE, expiresAt: 10_000 });
  settlementAppears(demo, q, 195);
  step(`re-presenting already-honored quote ${q.quoteId.slice(0, 8)}… (replay attempt)`);

  const before = apiKeyCount(db, q.quoteId);
  const res = await fulfilOnPayment(service, db, q);
  assert.equal(res.status, "declined", "replay must be declined");
  assert.equal(res.declineReason, "already_honored", "gate blocks with already_honored");
  assert.equal(apiKeyCount(db, q.quoteId), before, "no second api_key");
  assert.equal(apiKeyCount(db, q.quoteId), 1, "still exactly one api_key total");
  step(`gate BLOCKED the replay → declined (${res.declineReason})`);
  step(`no extra credits issued (api_key count still ${apiKeyCount(db, q.quoteId)})`);
}

// (c) WAITS FOR DEPTH -------------------------------------------------------
async function waitsForDepth(
  service: HonorService<"sync">,
  db: Database.Database,
  demo: DemoPorts,
): Promise<void> {
  hr();
  console.log("SCENARIO (c) WAITS FOR DEPTH — shallow payment must not issue credits early");
  resetChain(demo);
  const q = acceptedQuote({ quoteId: quoteId("c"), amount: PRICE, expiresAt: 10_000 });
  setClock(demo, 2_000);
  setTip(demo, 100);
  placeOrder(db, q.quoteId, SKU, CREDITS);
  step(`agent accepts quote ${q.quoteId.slice(0, 8)}… for ${CREDITS} ${SKU} calls (order pending)`);

  // Payment appears mined at height 98, tip 100 → depth 3 (< 6). NOT deep enough.
  settlementAppears(demo, q, 98);
  const shallow = currentDepth(demo) as number;
  step(`payment seen at height 98; depth ${shallow} < ${DEPTH} → waiting for ${DEPTH - shallow} more confirmations…`);

  // PROVE the real engine refuses to honor yet (pure read over the live tip).
  const key = { signerPubkey: q.signerPubkey, quoteId: q.quoteId };
  await service.engine.register(q);
  await service.engine.markObserved(key, demo.clock.now());
  const early = await service.engine.canHonor(key);
  assert.equal(early.decision, "wait", "engine must WAIT while shallow");
  assert.equal(
    early.decision === "wait" ? early.reason : "",
    "insufficient_depth",
    "wait reason is insufficient_depth",
  );
  assert.equal(apiKeyCount(db, q.quoteId), 0, "no early credit issuance");
  assert.equal(readOrder(db, q.quoteId)?.state, "pending", "order still pending");
  step(`engine verdict: WAIT (${early.decision === "wait" ? early.reason : ""}) — no api_key, no credits yet`);

  // Now more blocks arrive: tip climbs to 103 → depth 6 → confirmed to depth.
  setTip(demo, 103);
  step(`3 more blocks mined; tip now 103; depth ${currentDepth(demo)} ≥ ${DEPTH} → confirmed`);
  const res = await fulfilOnPayment(service, db, q);
  assert.equal(res.status, "honored", "honors once buried deep enough");
  assert.equal(res.credits, CREDITS, "full credit balance issued");
  assert.equal(apiKeyCount(db, q.quoteId), 1, "exactly one api_key, after depth reached");
  assert.equal(readOrder(db, q.quoteId)?.state, "fulfilled", "order now fulfilled");
  step(`HONORED → api_key ${res.apiKey} with ${res.credits} credits (only AFTER depth was reached)`);
}

// (d) EXPIRED ---------------------------------------------------------------
async function expired(
  service: HonorService<"sync">,
  db: Database.Database,
  demo: DemoPorts,
): Promise<void> {
  hr();
  console.log("SCENARIO (d) EXPIRED — quote expires before a deep-enough payment");
  resetChain(demo);
  const q = acceptedQuote({ quoteId: quoteId("d"), amount: PRICE, expiresAt: 5_000 });
  // Register BEFORE expiry but never observe a confirmed settlement in time;
  // then jump the clock past expiry + the late-honor recheck window.
  setClock(demo, 4_000);
  setTip(demo, 100);
  placeOrder(db, q.quoteId, SKU, CREDITS);
  step(`agent accepts quote ${q.quoteId.slice(0, 8)}…, expires at t=${q.expiresAt}`);
  step(`now t=${demo.clock.now()} — no confirmed payment has appeared`);

  // Clock advances well past expiresAt + maxRecheckWindow (5000 + 3600 = 8600).
  setClock(demo, 9_000);
  // A payment finally shows up, but the quote (never observed before expiry) is
  // past its retention window → the engine declines expired_unobserved.
  settlementAppears(demo, q, 95);
  step(`clock advanced to t=${demo.clock.now()} (past expiry + recheck window) — too late`);

  const res = await fulfilOnPayment(service, db, q);
  assert.equal(res.status, "declined", "expired quote must be declined");
  assert.ok(
    res.declineReason === "expired_unobserved" || res.declineReason === "expired",
    `decline reason is expiry-related (got ${res.declineReason})`,
  );
  assert.equal(apiKeyCount(db, q.quoteId), 0, "no credits for an expired quote");
  assert.equal(readOrder(db, q.quoteId)?.state, "pending", "order stays pending");
  step(`DECLINED (${res.declineReason}) — no api_key, no credits, order left pending`);
}

main().catch((e) => {
  console.error("\nDEMO FAILED:", e);
  process.exit(1);
});
