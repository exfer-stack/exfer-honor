// TESTNET LOOP — a continuous, restartable, observable agent-to-agent
// settlement loop on the persistent exfer testnet.
//
// It drives the same four steps the devnet-loop demo proved once, but forever,
// against the REAL low-difficulty testnet (the seed node mines real Argon2id
// PoW; this daemon does not mine):
//
//   quote   Agent A (payee/seller) issues a signed EXFER-QUOTE (walletd quote_issue).
//   honor   Agent A's gate (the REAL exfer-honor engine) registers the quote
//           write-ahead, then watches the chain.
//   settle  Agent B (payer/buyer) verifies the quote and settles on-chain with
//           the quote_id bound as the output datum (walletd transfer).
//   deliver A's gate finds the settlement via the indexer, waits the confirmation
//           depth, and delivers atomically inside the §5 gate transaction.
//
// Then it sleeps and does it again. Coins circulate A<->B; when the buyer runs
// low it is refilled from the seller's accumulated balance, and only when both
// are dry does it fall back to the faucet — so the loop is self-sustaining and
// does not hammer the faucet rate limit.
//
// Unlike the one-shot demo this is a long-lived process: it persists identities
// and an iteration ledger in SQLite (so a restart resumes the same A/B agents
// and balances), survives per-iteration errors without crashing, exposes
// /healthz + /metrics over HTTP for systemd/monitoring, and shuts down cleanly
// on SIGTERM/SIGINT.
//
// Env (all the *_URL/*_TOKEN are required; the rest have safe defaults):
//   EXFER_NODE_URL        testnet node JSON-RPC base URL (tip/depth + funding confs)
//   EXFER_INDEXER_URL     exfer-indexer base URL (settlement reverse lookup)
//   WALLETD_A_URL         payee/seller walletd base URL
//   WALLETD_A_TOKEN       payee bearer token (spend scope: quote_issue + custody test-sign)
//   WALLETD_B_URL         payer/buyer walletd base URL
//   WALLETD_B_TOKEN       payer bearer token (spend scope: transfer)
//   FAUCET_URL            optional faucet base URL (bootstrap/last-resort funding of B)
//   LOOP_STATE_DB         SQLite path for identities + ledger + honor gate (default ./testnet-loop.db)
//   LOOP_INTERVAL_MS      pause between completed iterations (default 15000)
//   LOOP_HTTP_PORT        health/metrics bind port (default 9799)
//   AMOUNT                exfers paid per settlement (default 1000)
//   REFILL_MULTIPLE       when B is low, refill REFILL_MULTIPLE * AMOUNT (default 20)
//   FEE_BUDGET            exfers reserved for fees when sizing balances (default 10000)
//   CONFIRMATION_DEPTH    honor depth gate (default 6)
//   POLL_MS               honor observe->honor tick interval (default 2000)
//   MAX_CONSECUTIVE_FAILURES  daemon reports unhealthy past this (default 10)

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import Database from "better-sqlite3";
import { createHonorService } from "exfer-honor";
import { asSqliteTxn, type QuoteJson } from "exfer-honor/adapters";

// ----------------------------------------------------------------- config
function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) {
    console.error(JSON.stringify({ level: "fatal", msg: `missing env ${name}` }));
    process.exit(1);
  }
  return v;
}
function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    console.error(JSON.stringify({ level: "fatal", msg: `bad integer env ${name}=${raw}` }));
    process.exit(1);
  }
  return Math.floor(n);
}

const CFG = {
  nodeUrl: env("EXFER_NODE_URL"),
  indexerUrl: env("EXFER_INDEXER_URL"),
  walletdA: env("WALLETD_A_URL"),
  tokenA: env("WALLETD_A_TOKEN"),
  walletdB: env("WALLETD_B_URL"),
  tokenB: env("WALLETD_B_TOKEN"),
  faucetUrl: process.env.FAUCET_URL,
  stateDb: env("LOOP_STATE_DB", "./testnet-loop.db"),
  intervalMs: intEnv("LOOP_INTERVAL_MS", 15000),
  httpPort: intEnv("LOOP_HTTP_PORT", 9799),
  amount: intEnv("AMOUNT", 1000),
  refillMultiple: intEnv("REFILL_MULTIPLE", 20),
  feeBudget: intEnv("FEE_BUDGET", 10000),
  confirmationDepth: intEnv("CONFIRMATION_DEPTH", 6),
  pollMs: intEnv("POLL_MS", 2000),
  maxConsecutiveFailures: intEnv("MAX_CONSECUTIVE_FAILURES", 10),
};

// ----------------------------------------------------------------- logging
function log(level: string, msg: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra }));
}

// ----------------------------------------------- REAL EXFER-ADDR derivation
// address = SHA256( [len("EXFER-ADDR")] || "EXFER-ADDR" || pubkey32 ), byte-exact
// to the node's Hash256::domain_hash — so the honor R4 binding is genuine.
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

// ----------------------------------------------------------------- JSON-RPC
async function rpc<T = unknown>(
  url: string,
  token: string | null,
  method: string,
  params: unknown = null,
): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
  });
  if (!res.ok) throw new Error(`${method} -> HTTP ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { result?: T; error?: { message?: string } };
  if (body.error) throw new Error(`${method} -> RPC error ${body.error.message ?? JSON.stringify(body.error)}`);
  return body.result as T;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function getHeight(): Promise<number> {
  const r = await rpc<{ height: number }>(CFG.nodeUrl, null, "get_block_height", null);
  return r.height;
}
async function getGenesis(): Promise<string> {
  const r = await rpc<{ genesis_block_id: string }>(CFG.nodeUrl, null, "get_block_height", null);
  return r.genesis_block_id;
}
async function getBalance(walletd: string, token: string, address: string): Promise<number> {
  const r = await rpc<{ balance: number }>(walletd, token, "get_balance", { address });
  return r.balance ?? 0;
}

// ----------------------------------------------------------------- state DB
const db = new Database(CFG.stateDb);
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS identities (
    role     TEXT PRIMARY KEY,            -- 'payee' | 'payer'
    address  TEXT NOT NULL,
    pubkey   TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS loop_iterations (
    seq            INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at     INTEGER NOT NULL,
    quote_id       TEXT,
    amount         INTEGER,
    settle_tx      TEXT,
    settle_height  INTEGER,
    honor_status   TEXT,                  -- 'honored' | 'declined' | 'failed'
    honor_latency_ms INTEGER,
    detail         TEXT
  );
  CREATE TABLE IF NOT EXISTS deliveries (
    quote_id     TEXT PRIMARY KEY,
    delivered_at INTEGER NOT NULL,
    note         TEXT NOT NULL
  );
`);

// Reuse the same A/B identities across restarts so balances persist.
async function ensureIdentity(
  role: "payee" | "payer",
  walletd: string,
  token: string,
): Promise<{ address: string; pubkey: string }> {
  const existing = db.prepare("SELECT address, pubkey FROM identities WHERE role = ?").get(role) as
    | { address: string; pubkey: string }
    | undefined;
  if (existing) return existing;
  const info = await rpc<{ address: string; pubkey: string }>(walletd, token, "generate_standard_address", {
    label: `testnet-loop-${role}`,
  });
  db.prepare("INSERT INTO identities (role, address, pubkey) VALUES (?, ?, ?)").run(
    role,
    info.address,
    info.pubkey,
  );
  log("info", "created identity", { role, address: info.address });
  return { address: info.address, pubkey: info.pubkey };
}

// ----------------------------------------------------------------- metrics
const metrics = {
  startedAt: Date.now(),
  iterations: 0,
  honored: 0,
  declined: 0,
  failed: 0,
  consecutiveFailures: 0,
  lastIterationTs: 0,
  lastHonorLatencyMs: 0,
  height: 0,
  payerBalance: 0,
  payeeBalance: 0,
  faucetCalls: 0,
  refills: 0,
};

// ----------------------------------------------------------------- funding
// Ensure B can pay `needed`. Prefer recycling from A's accumulated balance
// (keeps the loop circular and off the faucet); fall back to the faucet only
// when A is also too low (cold start, or fees have drained the pair).
async function ensureBuyerFunded(
  payer: { address: string; pubkey: string },
  payee: { address: string; pubkey: string },
  needed: number,
): Promise<void> {
  let bBal = await getBalance(CFG.walletdB, CFG.tokenB, payer.address);
  if (bBal >= needed) return;

  const refill = CFG.amount * CFG.refillMultiple;
  const aBal = await getBalance(CFG.walletdA, CFG.tokenA, payee.address);

  if (aBal >= refill + CFG.feeBudget) {
    log("info", "refilling buyer from seller balance", { refill, sellerBalance: aBal });
    const r = await rpc<{ tx_id: string }>(CFG.walletdA, CFG.tokenA, "transfer", {
      from: payee.address,
      outputs: [{ to: payer.address, amount: refill }],
      fee_rate: 1,
    });
    metrics.refills++;
    await waitForBalance(CFG.walletdB, CFG.tokenB, payer.address, needed, 120, `refill ${r.tx_id}`);
    return;
  }

  if (CFG.faucetUrl) {
    log("info", "requesting faucet drip for buyer", { faucet: CFG.faucetUrl });
    const res = await fetch(`${CFG.faucetUrl.replace(/\/$/, "")}/faucet`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: payer.address }),
    });
    if (!res.ok) throw new Error(`faucet -> HTTP ${res.status} ${await res.text()}`);
    metrics.faucetCalls++;
    await waitForBalance(CFG.walletdB, CFG.tokenB, payer.address, needed, 180, "faucet drip");
    return;
  }

  throw new Error(
    `buyer underfunded (have ${bBal}, need ${needed}), seller too low to refill (${aBal}) and no FAUCET_URL`,
  );
}

async function waitForBalance(
  walletd: string,
  token: string,
  address: string,
  target: number,
  tries: number,
  label: string,
): Promise<void> {
  for (let i = 0; i < tries; i++) {
    const bal = await getBalance(walletd, token, address);
    if (bal >= target) {
      log("info", "funding confirmed", { label, balance: bal });
      return;
    }
    // 2s, not 1s: the node caps balance/utxo queries at 30/min/IP and all the
    // co-located services share that budget.
    await sleep(2000);
  }
  throw new Error(`timed out waiting for ${label}: ${address} never reached ${target}`);
}

// ----------------------------------------------------------------- honor service
// One service for the whole daemon: A is always the payee, the gate DB and the
// merchant goods table (`deliveries`) live on the same connection (F12), and
// pollIntervalMs drives the observe->honor ticks for each iteration's quote.
// Constructed in main() once the payee identity exists; the binding payee is
// carried per-quote in AcceptedQuote.payeePubkey, so config.payee is only an
// informational hook.
let honor: Awaited<ReturnType<typeof createHonorService>>;

// ----------------------------------------------------------------- one iteration
async function runIteration(
  payee: { address: string; pubkey: string },
  payer: { address: string; pubkey: string },
): Promise<void> {
  const startedAt = Math.floor(Date.now() / 1000);
  const amount = CFG.amount;
  const row = db
    .prepare("INSERT INTO loop_iterations (started_at, amount) VALUES (?, ?)")
    .run(startedAt, amount);
  const seq = Number(row.lastInsertRowid);

  // 1. Make sure the buyer can pay (recycle from seller, else faucet).
  await ensureBuyerFunded(payer, payee, amount + CFG.feeBudget);

  // 2. QUOTE — seller issues a signed EXFER-QUOTE.
  const quoteRes = await rpc<{ quote: QuoteJson }>(
    CFG.walletdA,
    CFG.tokenA,
    "quote_issue",
    {
      address: payee.address,
      payee_pubkey: payee.pubkey,
      currency: "USD",
      amount_minor: 100,
      rate_exfers_per_unit: 1,
      exfer_amount: amount,
      ttl_secs: 900,
      memo: "testnet-loop: pay-per-call API access",
    },
  );
  const quote = quoteRes.quote;
  const quoteId = quote.quote_id;
  db.prepare("UPDATE loop_iterations SET quote_id = ? WHERE seq = ?").run(quoteId, seq);
  log("info", "quote issued", { seq, quoteId, amount });

  // 3. HONOR — accept + register (R6 write-ahead) BEFORE the payment lands.
  const outcome = await honor.verifier.accept(quote, "plain");
  if (!outcome.accepted) throw new Error(`ACCEPT refused: ${outcome.reason}`);
  const honorStart = Date.now();
  const { done } = honor.onPaid(outcome.quote, (ctx) => {
    const { db: conn } = asSqliteTxn(ctx.db);
    conn
      .prepare("INSERT OR IGNORE INTO deliveries (quote_id, delivered_at, note) VALUES (?, ?, ?)")
      .run(quoteId, Math.floor(Date.now() / 1000), "goods delivered inside the §5 gate txn");
  });
  // Small grace so register lands before settle (mirrors the demo).
  await sleep(1500);

  // 4. SETTLE — buyer verifies then pays with datum=quote_id.
  const verify = await rpc<{ valid: boolean; reason?: string }>(CFG.walletdB, CFG.tokenB, "quote_verify", {
    quote,
  });
  if (!verify.valid) throw new Error(`buyer quote_verify invalid: ${verify.reason}`);
  const transfer = await rpc<{ tx_id: string; tip_height?: number }>(CFG.walletdB, CFG.tokenB, "transfer", {
    from: payer.address,
    outputs: [{ to: payee.address, amount }],
    fee_rate: 1,
    datum: quoteId,
    client_token: `settle-${quoteId}`,
  });
  const settleTx = transfer.tx_id;
  db.prepare("UPDATE loop_iterations SET settle_tx = ?, settle_height = ? WHERE seq = ?").run(
    settleTx,
    transfer.tip_height ?? null,
    seq,
  );
  log("info", "settled on-chain", { seq, quoteId, settleTx });

  // 5. Wait for the gate to fire (depth gate).
  const result = await done;
  const latency = Date.now() - honorStart;
  metrics.lastHonorLatencyMs = latency;
  db.prepare("UPDATE loop_iterations SET honor_status = ?, honor_latency_ms = ? WHERE seq = ?").run(
    result.status,
    latency,
    seq,
  );
  if (result.status === "honored") {
    metrics.honored++;
    log("info", "LOOP CLOSED: mine -> quote -> settle -> honor", { seq, quoteId, latencyMs: latency });
  } else {
    metrics.declined++;
    throw new Error(`honor terminal status=${result.status} ${JSON.stringify(result)}`);
  }
}

// ----------------------------------------------------------------- http server
function startHttpServer(): ReturnType<typeof createServer> {
  const server = createServer((req, res) => {
    if (req.url === "/healthz") {
      const healthy = metrics.consecutiveFailures < CFG.maxConsecutiveFailures;
      res.writeHead(healthy ? 200 : 503, { "content-type": "application/json" });
      res.end(JSON.stringify({ healthy, ...metrics }));
      return;
    }
    if (req.url === "/metrics") {
      const lines = [
        `exfer_loop_iterations_total ${metrics.iterations}`,
        `exfer_loop_honored_total ${metrics.honored}`,
        `exfer_loop_declined_total ${metrics.declined}`,
        `exfer_loop_failed_total ${metrics.failed}`,
        `exfer_loop_consecutive_failures ${metrics.consecutiveFailures}`,
        `exfer_loop_last_honor_latency_ms ${metrics.lastHonorLatencyMs}`,
        `exfer_loop_chain_height ${metrics.height}`,
        `exfer_loop_payer_balance ${metrics.payerBalance}`,
        `exfer_loop_payee_balance ${metrics.payeeBalance}`,
        `exfer_loop_faucet_calls_total ${metrics.faucetCalls}`,
        `exfer_loop_refills_total ${metrics.refills}`,
        `exfer_loop_uptime_seconds ${Math.floor((Date.now() - metrics.startedAt) / 1000)}`,
      ];
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
      res.end(`${lines.join("\n")}\n`);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found\n");
  });
  server.listen(CFG.httpPort, () => log("info", "health/metrics listening", { port: CFG.httpPort }));
  return server;
}

// ----------------------------------------------------------------- main
let shuttingDown = false;
let lastGaugeAt = 0;
async function main(): Promise<void> {
  log("info", "testnet-loop starting", {
    node: CFG.nodeUrl,
    indexer: CFG.indexerUrl,
    amount: CFG.amount,
    intervalMs: CFG.intervalMs,
    faucet: CFG.faucetUrl ?? "(none)",
  });

  const genesis = await getGenesis();
  log("info", "connected to testnet node", { genesis });

  const payee = await ensureIdentity("payee", CFG.walletdA, CFG.tokenA);
  const payer = await ensureIdentity("payer", CFG.walletdB, CFG.tokenB);
  honor = await createHonorService({
    walletd: CFG.walletdA,
    indexer: CFG.indexerUrl,
    node: CFG.nodeUrl,
    db,
    token: CFG.tokenA,
    payee: payee.pubkey,
    pollIntervalMs: CFG.pollMs,
    addressDeriver: exferAddress,
  });
  log("info", "identities ready", { payee: payee.address, payer: payer.address });

  const server = startHttpServer();

  const shutdown = (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("info", "shutting down", { sig });
    server.close();
    db.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  while (!shuttingDown) {
    try {
      metrics.height = await getHeight();
      await runIteration(payee, payer);
      metrics.iterations++;
      metrics.consecutiveFailures = 0;
      metrics.lastIterationTs = Date.now();
    } catch (e) {
      metrics.failed++;
      metrics.consecutiveFailures++;
      const detail = e instanceof Error ? e.message : String(e);
      log("error", "iteration failed", { consecutiveFailures: metrics.consecutiveFailures, detail });
      // Record the failure against the most recent OPEN row only, so a failure
      // before this iteration inserted its row can't relabel a completed one.
      db.prepare(
        "UPDATE loop_iterations SET honor_status = 'failed', detail = ? WHERE seq = (SELECT MAX(seq) FROM loop_iterations) AND honor_status IS NULL",
      ).run(detail);
    }
    // Refresh balance gauges for /metrics, but at most every 15s — the node
    // caps balance/utxo queries at 30/min/IP across all co-located services, so
    // these observability reads must stay frugal.
    if (Date.now() - lastGaugeAt > 15000) {
      try {
        metrics.payerBalance = await getBalance(CFG.walletdB, CFG.tokenB, payer.address);
        metrics.payeeBalance = await getBalance(CFG.walletdA, CFG.tokenA, payee.address);
        lastGaugeAt = Date.now();
      } catch {
        /* gauges are best-effort */
      }
    }
    if (!shuttingDown) await sleep(CFG.intervalMs);
  }
}

main().catch((e) => {
  log("fatal", "daemon crashed", { detail: e instanceof Error ? e.stack : String(e) });
  process.exit(1);
});
