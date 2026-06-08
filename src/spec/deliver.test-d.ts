// TYPE-LEVEL test of the F8 guarantee (§3.5). Checked by the `typecheck` gate
// (tsc --noEmit), NOT the runtime runner — the `.test-d.ts` suffix is outside the
// `src/**/*.test.ts` glob. Each `@ts-expect-error` line MUST produce a real type
// error; if the F8 contract regressed, the directive would have nothing to
// suppress and tsc would FAIL this file. That makes the F8 escape a compile
// error, enforced in CI.
//
// IMPORTANT — why this tests `EnforceDeliverReturn`, not a bare `DeliverFn<'sync'>`
// annotation: TypeScript's void-permissiveness ("a value-returning function is
// assignable where a void return is expected") means a bare `(ctx) => void`
// annotation would silently ACCEPT `async (ctx) => {}`. The real F8 enforcement
// lives at the `honor()` call site via return-type INFERENCE through
// `EnforceDeliverReturn`, which bypasses void-permissiveness and genuinely bites.

import type {
  DeliverContext,
  DeliverFn,
  EnforceDeliverReturn,
  TxnModel,
} from "./types.js";

// --- The canonical DeliverFn shape (documentation-level) ---

// OK: synchronous deliver under a sync store.
const syncOk: DeliverFn<"sync"> = (_ctx: DeliverContext<"sync">): void => {
  // write goods on _ctx.db, inside the gate txn
};
void syncOk;

// OK: async deliver under an async store.
const asyncOk: DeliverFn<"async"> = async (
  _ctx: DeliverContext<"async">,
): Promise<void> => {};
void asyncOk;

// @ts-expect-error — a void-returning deliver under an async store is rejected:
//   DeliverFn<'async'> resolves to (ctx) => Promise<void>. (Promise return type
//   is NOT permissive toward void, so this direction is caught even at the alias.)
const asyncBad: DeliverFn<"async"> = (_ctx: DeliverContext<"async">): void => {};
void asyncBad;

// --- The LOAD-BEARING F8 enforcement: EnforceDeliverReturn (call-site shape) ---
//
// Model the honor() parameter exactly: `(ctx) => EnforceDeliverReturn<M, R>` with
// R inferred from the deliver body. A Promise return under 'sync' collapses to
// `never`, so the deliver is unassignable — the async-under-sync escape is a
// genuine type error (NOT reliant on a permissive `void`).

declare function honorLike<M extends TxnModel, R>(
  deliver: (ctx: DeliverContext<M>) => EnforceDeliverReturn<M, R>,
): void;

// OK: synchronous deliver under the sync model.
honorLike<"sync", void>((_ctx) => {
  const x = 1;
  void x;
});

// @ts-expect-error — ASYNC deliver under the 'sync' model is a COMPILE ERROR (F8):
//   R is inferred as Promise<void>, so EnforceDeliverReturn<'sync', R> => never.
honorLike<"sync", Promise<void>>(async (_ctx) => {
  await Promise.resolve();
});

// OK: async deliver under the async model.
honorLike<"async", Promise<void>>(async (_ctx) => {
  await Promise.resolve();
});

// @ts-expect-error — a synchronous deliver under the 'async' model is rejected.
honorLike<"async", void>((_ctx) => {
  const x = 1;
  void x;
});

// --- Static shape assertions on EnforceDeliverReturn ---

// A Promise return under 'sync' is rejected → never.
type _SyncRejectsPromise = EnforceDeliverReturn<"sync", Promise<void>> extends never
  ? true
  : never;
const _syncRejectsPromise: _SyncRejectsPromise = true;
void _syncRejectsPromise;

// A void return under 'sync' is accepted.
type _SyncAcceptsVoid = EnforceDeliverReturn<"sync", void> extends never ? never : true;
const _syncAcceptsVoid: _SyncAcceptsVoid = true;
void _syncAcceptsVoid;

// --- TxnModel is a closed two-state union ---

type _AssertModelsClosed = TxnModel extends "sync" | "async" ? true : never;
const _modelsClosed: _AssertModelsClosed = true;
void _modelsClosed;
