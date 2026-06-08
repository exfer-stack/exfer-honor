// TYPE-LEVEL test of the Stage-3 F8 CARRY-OVER (§3.5, task): `createHonorEngine`
// PINS the store's TxnModel M onto the returned engine, so a consumer wired with a
// SYNC store gets a `honor` that REJECTS an async deliver AT COMPILE TIME — without
// ever hand-writing `<'sync'>`. Checked by the `typecheck` gate, not the runner.
//
// Each `@ts-expect-error` MUST suppress a real error; if the carry-over regressed,
// tsc would FAIL this file (an unused directive is itself an error).

import { createHonorEngine } from "./engine.js";
import type { HonorDeps } from "../ports/index.js";
import type { HonorKey } from "../spec/index.js";

declare const syncDeps: HonorDeps<"sync">;
declare const asyncDeps: HonorDeps<"async">;
declare const key: HonorKey;

// M is INFERRED from the store — no explicit type args. F8 still bites.
const syncEngine = createHonorEngine(syncDeps);
const asyncEngine = createHonorEngine(asyncDeps);

// OK: a synchronous deliver on a sync-pinned engine.
void syncEngine.honor(key, (_ctx) => {
  /* synchronous goods write on _ctx.db */
});

// @ts-expect-error — an ASYNC deliver on the SYNC-pinned engine is a COMPILE ERROR.
//   R = Promise<void> ⇒ EnforceDeliverReturn<'sync', R> = never. The F8 escape
//   (async-deliver commits the better-sqlite3 txn before goods ship) CANNOT be
//   expressed against the engine `createHonorEngine` returns for a sync store.
void syncEngine.honor(key, async (_ctx) => {
  await Promise.resolve();
});

// OK: an async deliver on the async-pinned engine.
void asyncEngine.honor(key, async (_ctx) => {
  await Promise.resolve();
});

// @ts-expect-error — a synchronous deliver on the ASYNC-pinned engine is rejected.
void asyncEngine.honor(key, (_ctx) => {
  /* must return Promise<void> */
});
