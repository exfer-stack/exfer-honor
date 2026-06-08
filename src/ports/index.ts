// `@exfer/honor/ports` barrel — the five injectable ports + the SettlementForm
// strategy + the deps bag. Pure interface declarations; zero impl, zero runtime
// deps. These are the extensibility seams (§4).

export type {
  SeenRow,
  GateMode,
  HonorTxnInput,
  Store,
} from "./store.js";

export type {
  RawSettlementCandidate,
  OutputDatum,
  OnChainHtlc,
  ChainSource,
} from "./chain.js";

export type { KeyCustody, Clock, Logger } from "./custody.js";

export type {
  HonorConfig,
  ScoringCtx,
  PrepareResult,
  SettlementForm,
  SettlementFormRegistry,
} from "./form.js";

export type { HonorDeps, CreateHonorEngine } from "./deps.js";
