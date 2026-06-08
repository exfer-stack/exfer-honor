// TYPE-LEVEL test of the F8 guarantee at the Store / HonorEngine boundary (§3.5,
// §4.1). Checked by the `typecheck` gate, not the runtime runner. This proves the
// claim verbatim: a SqliteStore<'sync'>-typed context REJECTS an async DeliverFn
// at COMPILE TIME — the type system, not a runtime hope, forbids escaping the
// synchronous transaction.

import type { HonorEngine, HonorKey } from "../spec/index.js";
import type { HonorTxnInput, Store } from "./store.js";

// A stand-in for the Stage-5 SqliteStore: a Store pinned to the sync txn model.
type SqliteStore = Store<"sync">;
// ...and PostgresStore: the async txn model.
type PostgresStore = Store<"async">;

declare const sqlite: SqliteStore;
declare const postgres: PostgresStore;
declare const key: HonorKey;
declare const engine: HonorEngine;

// txnModel is reflected in the type, so downstream M is inferable.
const _syncModel: "sync" = sqlite.txnModel;
const _asyncModel: "async" = postgres.txnModel;
void _syncModel;
void _asyncModel;

// --- runHonorTxn.deliver under a SqliteStore<'sync'> must be synchronous ---

declare const syncInput: HonorTxnInput<"sync">;
// OK: the gate's deliver returns synchronously (no Promise) for a sync store.
type _SyncGateReturn = ReturnType<typeof syncInput.deliver>;
type _AssertNotPromise = _SyncGateReturn extends Promise<unknown> ? never : true;
const _gateReturnIsSync: _AssertNotPromise = true;
void _gateReturnIsSync;

// --- HonorEngine.honor: the SqliteStore rejects an async deliver at compile time ---
//
// `honor<M, R>` infers R from the deliver body and routes it through
// `EnforceDeliverReturn<M, R>`. Under 'sync', an async body (R = Promise<void>)
// collapses the parameter type to `never` ⇒ unassignable ⇒ compile error. This
// is the genuine F8 enforcement (a bare `=> void` would be void-permissive).

// OK: a synchronous deliver is accepted by a sync-backed honor call.
void engine.honor<"sync", void>(key, (_ctx) => {
  /* synchronous goods write on _ctx.db */
});

// @ts-expect-error — an ASYNC deliver under the 'sync' txn model is a COMPILE ERROR.
//   R = Promise<void> ⇒ EnforceDeliverReturn<'sync', R> = never. The F8 escape
//   (async-deliver commits the better-sqlite3 txn before goods ship) CANNOT be
//   expressed against a SqliteStore<'sync'>. This is the load-bearing assertion.
void engine.honor<"sync", Promise<void>>(key, async (_ctx) => {
  await Promise.resolve();
});

// OK: under the async txn model, the async deliver is exactly what's required.
void engine.honor<"async", Promise<void>>(key, async (_ctx) => {
  await Promise.resolve();
});

// @ts-expect-error — a synchronous deliver under the 'async' txn model is rejected.
void engine.honor<"async", void>(key, (_ctx) => {
  /* must return Promise<void> */
});
