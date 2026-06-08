// TYPE-LEVEL test of the F8 guarantee THROUGH THE STAGE-E FAÇADE (§3.5). Checked by
// the `typecheck` gate (tsc --noEmit), NOT the runtime runner — `.test-d.ts` is
// outside the `src/**/*.test.ts` glob. Each `@ts-expect-error` MUST produce a real
// type error; if the façade leaked the F8 contract, the directive would have
// nothing to suppress and tsc would FAIL this file.
//
// The point: the ergonomic `onPaid` preserves F8 end-to-end. A `HonorService<'sync'>`
// (the only kind `createHonorService` builds, since it wires a SQLite Store<'sync'>)
// accepts ONLY a synchronous deliver; an `async (ctx) => {}` deliver is a COMPILE
// ERROR — the same `EnforceDeliverReturn<M, R>` enforcement the engine's `honor` uses,
// carried through the façade typing.

import type { HonorService } from "./honor-service.js";
import type { DeliverContext } from "../spec/index.js";

declare const syncService: HonorService<"sync">;
declare const asyncService: HonorService<"async">;

// OK: a synchronous deliver under the SQLite-backed (sync) service.
syncService.onPaid({} as never, (_ctx: DeliverContext<"sync">) => {
  const x = 1;
  void x;
});

// @ts-expect-error — an ASYNC deliver under the 'sync' service is a COMPILE ERROR
//   (F8 preserved through the façade): R is inferred as Promise<void>, so
//   EnforceDeliverReturn<'sync', R> => never ⇒ the deliver parameter is
//   unconstructable.
syncService.onPaid({} as never, async (_ctx: DeliverContext<"sync">) => {
  await Promise.resolve();
});

// OK: an async deliver under an async-model service (e.g. a Postgres-backed
//   advanced wiring) is required to be async.
asyncService.onPaid({} as never, async (_ctx: DeliverContext<"async">) => {
  await Promise.resolve();
});

// @ts-expect-error — a synchronous deliver under the 'async' model is rejected.
asyncService.onPaid({} as never, (_ctx: DeliverContext<"async">) => {
  const x = 1;
  void x;
});
