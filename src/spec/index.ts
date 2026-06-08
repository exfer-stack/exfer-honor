// THE STANDARD — `@exfer/honor/spec` barrel.
//
// `/spec` is the frozen prose (docs/exfer-honor-spec.md) + these machine-readable
// constants, value types, the datum codec, and the error model. It has ZERO
// runtime dependencies and is the single source of truth every other layer
// (`/ports`, `/forms`, `/core`, `/adapters`, `/conformance`) imports from.

export { HONOR_API_VERSION, SETTLEMENT_DATUM_VERSION } from "./version.js";

export type {
  Hex,
  QuoteId,
  PubKey,
  SignerPubKey,
  SettlementFormId,
  AcceptedQuote,
  Outpoint,
  SettlementCandidate,
  WaitReason,
  DeclineReason,
  HonorVerdict,
  HonorOutcome,
  HonorKey,
  RegisterOpts,
  RegisterResult,
  ObserveResult,
  HonorStatus,
  TxnModel,
  GateDbTxn,
  DeliverContext,
  DeliverFn,
  EnforceDeliverReturn,
  HonorEngine,
} from "./types.js";

export {
  QUOTE_ID_BYTES,
  QUOTE_ID_HEX_LEN,
  decodeSettlementDatum,
  encodeSettlementDatum,
  asQuoteId,
} from "./datum.js";
export type { DecodeResult, DecodeFailure } from "./datum.js";

export { HonorError, GateViolation } from "./errors.js";
export type { HonorErrorCode } from "./errors.js";
