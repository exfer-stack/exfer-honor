// `@exfer/honor/adapters` barrel — the OPTIONAL reference port implementations
// (§2.3, §4, Stage 5). Every adapter is REPLACEABLE: a consumer may swap any one
// for its own without touching `/core`, `/forms`, or the value types.
//
//   SqliteStore        — Store<'sync'>  over better-sqlite3 (default gate, D2).
//   PostgresStore      — Store<'async'> over node-postgres (shared multi-instance).
//   IndexerChainSource — ChainSource over exfer-indexer Stage-1 + node JSON-RPC.
//   WalletdVerifier    — the ACCEPT bridge over walletd quote_verify.
//   KeystoreKeyCustody — R2/M3 payee key-custody test-sign over walletd.
//
// `/adapters` is the ONLY layer that may import concrete runtime deps
// (better-sqlite3, pg). `/core` MUST NOT import `/adapters` (§8 lint rule); the
// dependency arrow points adapters → core/ports/spec, never the reverse.

export { SqliteStore, asSqliteTxn } from "./sqlite-store.js";
export type { SqliteGateTxn } from "./sqlite-store.js";

export { PostgresStore, asPostgresTxn } from "./postgres-store.js";
export type {
  PgQueryable,
  PgClient,
  PgPool,
  PostgresGateTxn,
} from "./postgres-store.js";

export { IndexerChainSource } from "./indexer-chain.js";
export type { JsonRpc, IndexerChainSourceOpts } from "./indexer-chain.js";

export { WalletdVerifier, toAcceptedQuote } from "./walletd-verifier.js";
export type { QuoteJson, AcceptOutcome } from "./walletd-verifier.js";

export { KeystoreKeyCustody } from "./keystore-custody.js";
export type { KeystoreKeyCustodyOpts } from "./keystore-custody.js";

export { DDL_SQLITE, DDL_POSTGRES } from "./ddl.js";
