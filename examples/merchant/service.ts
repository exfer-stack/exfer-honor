// SERVICE CONSTRUCTION — the ONLY place demo mode and real mode differ.
//
// Both modes call the SAME `createHonorService({ ...ports/urls, db, payee })` and
// hand the result to the SAME merchant integration (merchant.ts). The merchant
// code never branches on mode.
//
//   REAL MODE  (env EXFER_WALLETD_URL / EXFER_INDEXER_URL / EXFER_NODE_URL set):
//     pass the URLs — the Stage-E façade builds the real IndexerChainSource /
//     WalletdVerifier / KeystoreKeyCustody and a wall-clock Clock.
//
//   DEMO MODE  (default, zero infra):
//     inject the library's OWN in-memory fakes (reused verbatim from
//     `exfer-honor/conformance`: HarnessChain / HarnessKeys / HarnessClock) so the
//     real engine runs over real, scripted chain facts. The SqliteStore is a REAL
//     adapter on a temp file, so the §5 gate is genuinely exercised.

import Database from "better-sqlite3";
import {
  createHonorService,
  httpJsonRpc,
  type HonorService,
} from "exfer-honor";
import { WalletdVerifier } from "exfer-honor/adapters";
import {
  HarnessChain,
  HarnessClock,
  HarnessKeys,
} from "exfer-honor/conformance";

/** Demo-mode handles the scenario driver scripts chain facts through. */
export interface DemoPorts {
  readonly chain: HarnessChain;
  readonly keys: HarnessKeys;
  readonly clock: HarnessClock;
}

export interface BuiltService {
  readonly service: HonorService<"sync">;
  readonly db: Database.Database;
  /** present ONLY in demo mode — the fakes the scenario driver mutates. */
  readonly demo?: DemoPorts;
}

/** True iff the real-service env vars are present (flip to real mode). */
export function realModeConfigured(): boolean {
  return Boolean(
    process.env.EXFER_WALLETD_URL &&
      process.env.EXFER_INDEXER_URL &&
      process.env.EXFER_NODE_URL,
  );
}

/**
 * Build a HonorService over a fresh better-sqlite3 connection.
 *
 * @param dbPath  the sqlite file (real mode → your production DB; demo → a temp file).
 * @param payee   the payee pubkey identity (informational hook).
 * @param fast    demo only: a tiny poll interval so the narrated demo runs quickly.
 */
export async function buildService(opts: {
  dbPath: string;
  payee: string;
  fast?: boolean;
}): Promise<BuiltService> {
  const db = new Database(opts.dbPath);

  if (realModeConfigured()) {
    // REAL MODE — URLs only. The façade wires the real ports.
    const service = await createHonorService({
      walletd: process.env.EXFER_WALLETD_URL as string,
      indexer: process.env.EXFER_INDEXER_URL as string,
      node: process.env.EXFER_NODE_URL as string,
      token: process.env.EXFER_WALLETD_TOKEN,
      db,
      payee: opts.payee,
    });
    return { service, db };
  }

  // DEMO MODE — inject the library's in-memory fakes. The honor decision still
  // comes from the REAL engine over the REAL SqliteStore; we only feed it facts.
  const chain = new HarnessChain();
  const keys = new HarnessKeys();
  const clock = new HarnessClock(0);

  const service = await createHonorService({
    // walletd/indexer/node are unused in demo mode (we inject chainSource +
    // keyCustody + verifier directly); pass harmless placeholders for the type.
    walletd: "http://demo.invalid",
    indexer: "http://demo.invalid",
    node: "http://demo.invalid",
    db,
    payee: opts.payee,
    // injected ports (the façade's documented port-override seam):
    chainSource: chain,
    keyCustody: keys,
    clock,
    // the ACCEPT bridge is unused (we build AcceptedQuotes directly), but the
    // façade requires a verifier instance — a never-called one over a dead URL.
    verifier: new WalletdVerifier(httpJsonRpc("http://demo.invalid")),
    // a tiny poll interval keeps the narrated demo snappy; time itself is the
    // injected fake clock, so there are NO real sleeps in the honor decision.
    pollIntervalMs: opts.fast ? 4 : undefined,
  });

  return { service, db, demo: { chain, keys, clock } };
}
