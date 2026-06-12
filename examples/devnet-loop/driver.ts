// DEVNET LOOP — payee-side honor driver for the agent-to-agent closed-loop demo.
//
// Run by exfer-loop-demo/run-demo.sh. The REAL stack end to end: walletd
// quote_verify (ACCEPT bridge), exfer-indexer Stage-1 reverse lookup, the live
// devnet node for tip/depth, and the REAL §5 atomic gate+deliver over SQLite.
// Nothing is faked.
//
// Env:
//   EXFER_WALLETD_URL   payee (Agent A) walletd base URL
//   EXFER_INDEXER_URL   exfer-indexer base URL
//   EXFER_NODE_URL      devnet node JSON-RPC base URL
//   WALLETD_TOKEN       Agent A bearer token (spend scope: custody test-sign)
//   QUOTE_JSON_PATH     path to the quote object from quote_issue
//   GATE_DB_PATH        SQLite gate DB path
//   POLL_MS             observe→honor tick interval (default 1000)

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { createHonorService } from "exfer-honor";
import { asSqliteTxn } from "exfer-honor/adapters";

// REAL EXFER-ADDR derivation, byte-exact to the node (Hash256::domain_hash):
//   address = SHA256( [len("EXFER-ADDR")] || "EXFER-ADDR" || pubkey32 )
const DS_ADDR = Buffer.from("EXFER-ADDR", "ascii");
function exferAddress(pubkeyHex: string): string {
  const pubkey = Buffer.from(pubkeyHex, "hex");
  if (pubkey.length !== 32) throw new Error(`pubkey must be 32 bytes, got ${pubkey.length}`);
  const h = createHash("sha256");
  h.update(Buffer.from([DS_ADDR.length]));
  h.update(DS_ADDR);
  h.update(pubkey);
  return h.digest("hex");
}

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) {
    console.error(`[honor] missing env ${name}`);
    process.exit(1);
  }
  return v;
}

const quoteJson = JSON.parse(readFileSync(env("QUOTE_JSON_PATH"), "utf8"));
const db = new Database(env("GATE_DB_PATH"));
// The merchant's own goods table on the SAME connection (F12): the gate write
// and the delivery write commit atomically or roll back together.
db.exec(
  `CREATE TABLE IF NOT EXISTS deliveries (
     quote_id TEXT PRIMARY KEY,
     delivered_at INTEGER NOT NULL,
     note TEXT NOT NULL
   )`,
);

const service = await createHonorService({
  walletd: env("EXFER_WALLETD_URL"),
  indexer: env("EXFER_INDEXER_URL"),
  node: env("EXFER_NODE_URL"),
  db,
  token: process.env.WALLETD_TOKEN,
  payee: quoteJson.payee_pubkey,
  pollIntervalMs: Number(env("POLL_MS", "1000")),
  addressDeriver: exferAddress, // the REAL derivation — R4 binding is genuine
});

console.log(`[honor] ACCEPT: verifying quote ${quoteJson.quote_id} via walletd quote_verify`);
const outcome = await service.verifier.accept(quoteJson, "plain");
if (!outcome.accepted) {
  console.error(`[honor] ACCEPT refused: ${outcome.reason}`);
  process.exit(2);
}
console.log(
  `[honor] ACCEPTED quote_id=${outcome.quote.quoteId} amount=${outcome.quote.exferAmount} payee=${outcome.quote.payeePubkey.slice(0, 16)}…`,
);

console.log("[honor] watching the chain (register → observe → depth gate → atomic honor)…");
const { done } = service.onPaid(outcome.quote, (ctx) => {
  const { db: conn } = asSqliteTxn(ctx.db);
  conn
    .prepare("INSERT INTO deliveries (quote_id, delivered_at, note) VALUES (?, ?, ?)")
    .run(
      quoteJson.quote_id,
      Math.floor(Date.now() / 1000),
      "goods delivered to payer agent — inside the atomic gate txn",
    );
  console.log("[honor] DELIVER ran inside the §5 gate transaction");
});

const result = await done;
console.log(`[honor] terminal outcome: ${JSON.stringify(result)}`);
if (result.status === "honored") {
  const row = db
    .prepare("SELECT * FROM deliveries WHERE quote_id = ?")
    .get(quoteJson.quote_id);
  console.log(`[honor] delivery row: ${JSON.stringify(row)}`);
  process.exit(0);
}
process.exit(3);
