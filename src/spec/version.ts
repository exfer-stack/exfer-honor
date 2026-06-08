// THE STANDARD — identity / wire version constants (§3.1, §3.7).
//
// These version INDEPENDENTLY (different clocks): HONOR_API_VERSION gates the
// TS façade contract; SETTLEMENT_DATUM_VERSION gates the on-wire datum format.
// Mirrors EXFER-QUOTE's wire-version-byte vs implementation discipline.
//
// Versioning rules (RFC-2119, §3.7):
//  - A consumer MUST assert `engine.apiVersion === HONOR_API_VERSION` at
//    construction. `createHonorEngine` does this; mismatch throws
//    `api_version_mismatch`.
//  - Any change to a public type's field layout, an operation signature, the
//    HonorVerdict/HonorOutcome discriminants, the DeliverFn txn contract, or the
//    error-code set REQUIRES a major bump of HONOR_API_VERSION.
//  - Adding a SettlementForm, an enum value, or an OPTIONAL field is additive —
//    no bump.
//  - Datum-format changes REQUIRE a SETTLEMENT_DATUM_VERSION bump + a paired
//    decoder behind the version byte, ZERO trailing bytes. A datum encoded under
//    one version MUST NOT decode under another.

/** Semver-major gate on the TS façade contract. */
export const HONOR_API_VERSION = 1 as const;

/** Wire format gate: bare 16-byte quote_id, zero trailing bytes (§6.1). */
export const SETTLEMENT_DATUM_VERSION = 1 as const;
