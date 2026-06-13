// TESTNET FAUCET — a thin, rate-limited HTTP front-end that drips valueless
// testnet coins to a requested address.
//
// The node RPC is query + broadcast only (no server-side signing), so the faucet
// reuses walletd as the signing engine: it calls walletd `transfer` from a
// funded faucet address. The faucet wallet is funded by the seed node mining to
// the faucet's address (coins mature in the testnet's 10-block maturity).
//
// There is no custodial risk — testnet coins are valueless by construction — so
// the anti-abuse here is purely to keep one client from draining the wallet and
// starving everyone else: a per-address cooldown, a per-IP cooldown, and a hard
// daily budget, all tracked in SQLite so they survive a restart.
//
// Endpoints:
//   POST /faucet  {"address":"<64-hex>"}  -> {"tx_id":"...","amount":N}
//   GET  /healthz                          -> {"healthy":bool,"balance":N,...}
//   GET  /metrics                          -> Prometheus text
//
// Env (FAUCET_WALLETD_URL/TOKEN and FAUCET_FROM_ADDRESS required):
//   FAUCET_WALLETD_URL    walletd base URL holding the funded faucet wallet
//   FAUCET_WALLETD_TOKEN  walletd spend-scope bearer token
//   FAUCET_FROM_ADDRESS   the funded faucet address (64-hex) to spend from
//   FAUCET_AMOUNT         exfers per drip (default 100000)
//   FAUCET_HTTP_PORT      bind port (default 9800)
//   FAUCET_DB             SQLite ledger path (default ./faucet.db)
//   FAUCET_ADDR_COOLDOWN_SECS  per-address cooldown (default 3600)
//   FAUCET_IP_COOLDOWN_SECS    per-IP cooldown (default 60)
//   FAUCET_DAILY_BUDGET   max exfers dripped per rolling 24h (default 0 = unlimited)

import { createServer } from "node:http";
import Database from "better-sqlite3";

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
  walletdUrl: env("FAUCET_WALLETD_URL"),
  walletdToken: env("FAUCET_WALLETD_TOKEN"),
  fromAddress: env("FAUCET_FROM_ADDRESS"),
  amount: intEnv("FAUCET_AMOUNT", 100000),
  httpPort: intEnv("FAUCET_HTTP_PORT", 9800),
  db: env("FAUCET_DB", "./faucet.db"),
  addrCooldownSecs: intEnv("FAUCET_ADDR_COOLDOWN_SECS", 3600),
  ipCooldownSecs: intEnv("FAUCET_IP_COOLDOWN_SECS", 60),
  dailyBudget: intEnv("FAUCET_DAILY_BUDGET", 0),
};

function log(level: string, msg: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra }));
}

const ADDR_RE = /^[0-9a-f]{64}$/;

async function rpc<T = unknown>(method: string, params: unknown): Promise<T> {
  const res = await fetch(CFG.walletdUrl, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${CFG.walletdToken}` },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
  });
  if (!res.ok) throw new Error(`${method} -> HTTP ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { result?: T; error?: { message?: string } };
  if (body.error) throw new Error(`${method} -> RPC error ${body.error.message ?? JSON.stringify(body.error)}`);
  return body.result as T;
}

const db = new Database(CFG.db);
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS drips (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    address   TEXT NOT NULL,
    ip        TEXT NOT NULL,
    amount    INTEGER NOT NULL,
    tx_id     TEXT NOT NULL,
    at        INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS drips_address_at ON drips(address, at);
  CREATE INDEX IF NOT EXISTS drips_ip_at ON drips(ip, at);
`);

const lastByAddr = db.prepare("SELECT MAX(at) AS t FROM drips WHERE address = ?");
const lastByIp = db.prepare("SELECT MAX(at) AS t FROM drips WHERE ip = ?");
const sumSince = db.prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM drips WHERE at >= ?");
const insertDrip = db.prepare(
  "INSERT INTO drips (address, ip, amount, tx_id, at) VALUES (?, ?, ?, ?, ?)",
);

const metrics = { startedAt: Date.now(), served: 0, rejected: 0, errors: 0, lastBalance: 0 };

// Returns a rejection reason string, or null if the request is allowed.
function rateLimit(address: string, ip: string, now: number): string | null {
  const a = lastByAddr.get(address) as { t: number | null };
  if (a.t && now - a.t < CFG.addrCooldownSecs) {
    return `address cooldown: retry in ${CFG.addrCooldownSecs - (now - a.t)}s`;
  }
  const i = lastByIp.get(ip) as { t: number | null };
  if (i.t && now - i.t < CFG.ipCooldownSecs) {
    return `ip cooldown: retry in ${CFG.ipCooldownSecs - (now - i.t)}s`;
  }
  if (CFG.dailyBudget > 0) {
    const s = sumSince.get(now - 86400) as { s: number };
    if (s.s + CFG.amount > CFG.dailyBudget) return "daily faucet budget exhausted; try tomorrow";
  }
  return null;
}

function clientIp(req: import("node:http").IncomingMessage): string {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) return xff.split(",")[0]!.trim();
  return req.socket.remoteAddress ?? "unknown";
}

function readBody(req: import("node:http").IncomingMessage, limit = 8192): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > limit) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

async function getBalance(): Promise<number> {
  try {
    const r = await rpc<{ balance: number }>("get_balance", { address: CFG.fromAddress });
    metrics.lastBalance = r.balance ?? 0;
    return metrics.lastBalance;
  } catch {
    return metrics.lastBalance;
  }
}

const server = createServer((req, res) => {
  void (async () => {
    try {
      if (req.method === "GET" && req.url === "/healthz") {
        const balance = await getBalance();
        const healthy = balance >= CFG.amount;
        res.writeHead(healthy ? 200 : 503, { "content-type": "application/json" });
        res.end(JSON.stringify({ healthy, balance, from: CFG.fromAddress, drip: CFG.amount, ...metrics }));
        return;
      }
      if (req.method === "GET" && req.url === "/metrics") {
        const lines = [
          `exfer_faucet_served_total ${metrics.served}`,
          `exfer_faucet_rejected_total ${metrics.rejected}`,
          `exfer_faucet_errors_total ${metrics.errors}`,
          `exfer_faucet_balance ${metrics.lastBalance}`,
          `exfer_faucet_uptime_seconds ${Math.floor((Date.now() - metrics.startedAt) / 1000)}`,
        ];
        res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
        res.end(`${lines.join("\n")}\n`);
        return;
      }
      if (req.method === "POST" && req.url === "/faucet") {
        const ip = clientIp(req);
        let address: string;
        try {
          const parsed = JSON.parse(await readBody(req)) as { address?: unknown };
          address = String(parsed.address ?? "").toLowerCase();
        } catch {
          metrics.rejected++;
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid JSON body; expected {\"address\":\"<64-hex>\"}" }));
          return;
        }
        if (!ADDR_RE.test(address)) {
          metrics.rejected++;
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "address must be 64 lowercase hex chars" }));
          return;
        }
        const now = Math.floor(Date.now() / 1000);
        const reject = rateLimit(address, ip, now);
        if (reject) {
          metrics.rejected++;
          res.writeHead(429, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: reject }));
          return;
        }
        const transfer = await rpc<{ tx_id: string }>("transfer", {
          from: CFG.fromAddress,
          outputs: [{ to: address, amount: CFG.amount }],
          fee_rate: 1,
          client_token: `faucet-${address}-${now}`,
        });
        insertDrip.run(address, ip, CFG.amount, transfer.tx_id, now);
        metrics.served++;
        log("info", "dripped", { address, ip, amount: CFG.amount, tx_id: transfer.tx_id });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ tx_id: transfer.tx_id, amount: CFG.amount }));
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found\n");
    } catch (e) {
      metrics.errors++;
      const detail = e instanceof Error ? e.message : String(e);
      log("error", "request failed", { detail });
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "faucet error", detail }));
    }
  })();
});

function shutdown(sig: string): void {
  log("info", "shutting down", { sig });
  server.close();
  db.close();
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

server.listen(CFG.httpPort, () =>
  log("info", "faucet listening", { port: CFG.httpPort, from: CFG.fromAddress, drip: CFG.amount }),
);
