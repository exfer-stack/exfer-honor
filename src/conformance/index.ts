// `@exfer/honor/conformance` barrel (§9).
//
// The executable conformance harness: the frozen `{ fixture, expect }` vector
// corpus loader + `runVector` / `runCorpus`, which EXECUTE every vector against a
// REAL engine + REAL builtin forms + an INJECTED `Store<'sync'>`. The same harness
// runs against BOTH reference stores (the in-memory fake AND the SqliteStore) — the
// §9 "both reference stores" gate.
//
// `/conformance` depends on `/spec`, `/ports`, `/core`, `/forms`; the concrete
// Store adapter is INJECTED by the caller, so this layer never imports `/adapters`.
// A consumer wiring a NEW Store (or a NEW form) drops their store into a
// `ConformanceStore` adapter and runs the corpus to prove standard-conformance.

export {
  VECTORS_DIR,
  MANDATORY_IDS,
  loadAllVectors,
  loadVector,
} from "./vectors.js";
export type { Vector } from "./vectors.js";

export {
  runVector,
  runtimeVectorIds,
  HarnessChain,
  HarnessKeys,
  HarnessClock,
  defaultConfig,
  SIGNER,
  PAYEE,
  PAYER,
  PAYEE_SCRIPT,
  PAYER_SCRIPT,
  CANON_QID,
} from "./harness.js";
export type {
  ConformanceStore,
  ConformanceEnv,
  EnvFactory,
} from "./harness.js";
