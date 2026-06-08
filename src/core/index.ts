// `@exfer/honor/core` barrel — the engine (§3.4, §5, §6).
//
// `/core` depends ONLY on `/ports` interfaces + the SettlementForm contract +
// `/spec` (§2.3 single-dependency rule). It never imports a concrete chain, DB,
// indexer, or keystore. `createHonorEngine(deps)` is the ONLY constructor.

export { createHonorEngine } from "./engine.js";
export type { TypedHonorEngine } from "./engine.js";
export { FormRegistry, createFormRegistry } from "./registry.js";
export { scoreQuote, gateStep0, quoteFromSeen } from "./scorer.js";
export type { ScorerDeps } from "./scorer.js";
