// @exfer/honor — public entrypoint.
//
// Re-exports THE STANDARD: the frozen value types, the façade interface, the
// version constants, the closed enums, the error model, the pure datum codec
// (/spec), and the five injectable ports + the SettlementForm strategy (/ports).
//
// Sub-path exports `@exfer/honor/{spec,ports}` are also available and enforce the
// §2.3 single-dependency layering. The engine (/core), the builtin forms
// (/forms), the reference adapters (/adapters), and the conformance harness
// (/conformance) land in later stages.

export * from "./spec/index.js";
export * from "./ports/index.js";
export * from "./forms/index.js";
export * from "./core/index.js";
