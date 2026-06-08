// PORT — the injected dependency bag + the engine constructor signature (§4).
//
// Core consumes exactly FIVE ports + a form registry, all constructor-injected
// in one FROZEN deps bag. `createHonorEngine(deps)` is the ONLY constructor (no
// module-level singletons). At Stage 2 this is a TYPE-LEVEL declaration only —
// the implementation lands in Stage 3 (/core).

import type { HonorEngine, TxnModel } from "../spec/index.js";
import type { ChainSource } from "./chain.js";
import type { Clock, KeyCustody, Logger } from "./custody.js";
import type { HonorConfig, SettlementFormRegistry } from "./form.js";
import type { Store } from "./store.js";

export interface HonorDeps<M extends TxnModel> {
  /** gate persistence (F3/R6) — INJECTED handle (R6 shared per identity). */
  readonly store: Store<M>;
  /** indexer Stage-1 + node reads (swappable). */
  readonly chain: ChainSource;
  /** payee key-custody test-sign (R2/M3). */
  readonly keys: KeyCustody;
  /** injectable now() for determinism / vectors. */
  readonly clock: Clock;
  /** plain + htlc (+ future) strategies. */
  readonly forms: SettlementFormRegistry;
  /** CLAIM_MARGIN, CONFIRMATION_DEPTH, MAX_REORG_DEPTH, MAX_RECHECK_WINDOW, … */
  readonly config: HonorConfig;
  readonly logger?: Logger;
}

/**
 * The ONLY constructor (§4). The real impl asserts apiVersion, derives+asserts
 * CLAIM_MARGIN (D1), and asserts store topology (F12). Declared here as the
 * frozen STANDARD signature; the body lands in Stage 3 (/core).
 */
export type CreateHonorEngine = <M extends TxnModel>(deps: HonorDeps<M>) => HonorEngine;
