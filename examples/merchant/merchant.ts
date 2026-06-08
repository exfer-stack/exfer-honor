// API-SERVICE integration — the copy-able developer reference.
//
// The seller is a PAY-PER-CALL API (an inference / tool / data endpoint). The
// buyer is an AUTONOMOUS AI AGENT: it holds an exfer-mcp wallet and settles for
// metered access on its own — no human in the loop, no credit card, no account
// signup. It quotes a price in USD, pays the bound EXFER amount, and the API
// service issues it an api_key carrying a balance of N prepaid calls (credits).
//
// This is the ONLY honor-aware code such a service writes. It is IDENTICAL in
// demo mode and in real mode: the service is constructed elsewhere (`buildService`
// in service.ts — fakes vs URLs) and injected here. Nothing in this file knows or
// cares whether the chain underneath is a real exfer node or the library's
// in-memory fakes — that is the whole point.
//
// The API service owns its OWN sqlite tables (`orders`, `api_keys`) on the SAME
// better-sqlite3 connection the HonorService gates on (F12). Because `deliver`
// runs INSIDE the engine's write-ahead honor txn, the gate write (this quote is
// now honored, exactly once) and the goods write (issue api_key + credits, fulfil
// order) COMMIT ATOMICALLY or ROLL BACK together. There is no "honored but no
// credits issued" and no "credits issued twice" window.

import type Database from "better-sqlite3";
import {
  type AcceptedQuote,
  type DeliverContext,
  type HonorService,
  type OnPaidResult,
} from "exfer-honor";
import { asSqliteTxn } from "exfer-honor/adapters";

/** What the API service hands back to the agent once a quote settles. */
export interface Fulfilment {
  readonly status: OnPaidResult["status"];
  /** present iff status === 'honored' — the api_key the agent paid for. */
  readonly apiKey?: string;
  /** present iff status === 'honored' — the prepaid call balance on that key. */
  readonly credits?: number;
  /** present iff status === 'declined' — the closed engine DeclineReason. */
  readonly declineReason?: string;
}

/** Create the API service's own goods tables on the shared connection (F12). */
export function initMerchantTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      quote_id    TEXT PRIMARY KEY,
      sku         TEXT NOT NULL,         -- the metered plan, e.g. 'inference-api'
      credits     INTEGER NOT NULL,      -- how many API calls this order buys
      state       TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'fulfilled'
      fulfilled_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS api_keys (
      quote_id    TEXT PRIMARY KEY,                 -- one key per quote (idempotent)
      api_key     TEXT NOT NULL,
      credits     INTEGER NOT NULL                  -- remaining prepaid calls
    );
  `);
}

/** Record a pending order the agent is about to pay for (API-service side). */
export function placeOrder(
  db: Database.Database,
  quoteId: string,
  sku: string,
  credits: number,
): void {
  db.prepare(
    `INSERT INTO orders (quote_id, sku, credits, state) VALUES (?, ?, ?, 'pending')
       ON CONFLICT(quote_id) DO NOTHING`,
  ).run(quoteId, sku, credits);
}

/** Deterministic, per-quote api_key. A real service would mint a real secret. */
function mintApiKey(quoteId: string): string {
  const seed = quoteId.slice(0, 16).toLowerCase();
  return `sk-exfer-${seed}`;
}

/**
 * Drive a single accepted quote to settlement and issue API credits exactly once.
 *
 * `service.onPaid(quote, deliver)` polls the chain (observe → honor) and, the
 * instant the payment is binding-valid AND confirmed to depth, runs `deliver`
 * INSIDE the atomic honor txn. The deliver issues the api_key + its credit balance
 * and flips the order to 'fulfilled' on the SAME connection — so goods and gate
 * commit together.
 */
export async function fulfilOnPayment(
  service: HonorService<"sync">,
  db: Database.Database,
  quote: AcceptedQuote,
): Promise<Fulfilment> {
  const handle = service.onPaid(quote, (ctx: DeliverContext<"sync">) => {
    // We are now INSIDE the engine's write-ahead honor txn. `ctx.db` is the gate's
    // own txn-scoped handle over the SAME better-sqlite3 connection (F12). Write
    // goods through it so they share the gate's atomic commit/rollback.
    const { db: conn } = asSqliteTxn(ctx.db);
    const quoteId = ctx.key.quoteId;
    const apiKey = mintApiKey(quoteId);

    // How many calls this quote bought (recorded on the pending order).
    const order = conn
      .prepare(`SELECT credits FROM orders WHERE quote_id=?`)
      .get(quoteId) as { credits: number } | undefined;
    const credits = order?.credits ?? 0;

    // Idempotent goods write (ON CONFLICT DO NOTHING): even an ambiguous-commit
    // replay never issues a second api_key (or double-credits) for the same quote.
    conn
      .prepare(
        `INSERT INTO api_keys (quote_id, api_key, credits) VALUES (?, ?, ?)
           ON CONFLICT(quote_id) DO NOTHING`,
      )
      .run(quoteId, apiKey, credits);
    conn
      .prepare(
        `UPDATE orders SET state='fulfilled', fulfilled_at=? WHERE quote_id=?`,
      )
      .run(ctx.honoredAt, quoteId);
  });

  const result = await handle.done;

  if (result.status === "honored") {
    const row = db
      .prepare(`SELECT api_key, credits FROM api_keys WHERE quote_id=?`)
      .get(quote.quoteId) as { api_key: string; credits: number } | undefined;
    return { status: "honored", apiKey: row?.api_key, credits: row?.credits };
  }
  if (result.status === "declined") {
    return { status: "declined", declineReason: result.reason };
  }
  return { status: result.status };
}

/** Read an API-service order row (for narration / assertions). */
export function readOrder(
  db: Database.Database,
  quoteId: string,
): { sku: string; state: string } | undefined {
  return db.prepare(`SELECT sku, state FROM orders WHERE quote_id=?`).get(quoteId) as
    | { sku: string; state: string }
    | undefined;
}

/** Count api_keys issued for a quote (the double-deliver detector). */
export function apiKeyCount(db: Database.Database, quoteId: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM api_keys WHERE quote_id=?`)
    .get(quoteId) as { n: number };
  return row.n;
}
