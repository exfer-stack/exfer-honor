// ADAPTER — the FIXED gate DDL (§4.1, §5.5, §3.1, §7).
//
// The two durable gate tables are part of THE STANDARD; only the SQL dialect
// varies per adapter (§4.1). Both stores create the same logical schema:
//
//   quote_seen                 — the R6 write-ahead record + the SEEN hard-lock
//                                target (§5.2 step 1). PK (signer_pubkey, quote_id)
//                                gives the per-quote idempotency + the R6 per-
//                                accepting-identity partition (§7). Carries the
//                                form-aware `form` column (§3.1) so the engine
//                                picks the strategy without a chain round-trip.
//   quote_consumed_outpoint    — the consumed-outpoint gate. PK (tx_id,
//                                output_index) enforces R1 one-settlement-one-quote
//                                at the DB. The form-aware `state` column
//                                (CHECK IN ('claim_pending','honored'), §5.5/F13)
//                                lets the HTLC two-phase path reserve at Phase A and
//                                PROMOTE at Phase B without a self-collision.
//
// Amounts cross the persistence boundary as TEXT (§0): a u64 `bigint` does not fit
// a signed 64-bit INTEGER, so `exfer_amount` is a canonical decimal string.

/** SQLite dialect (better-sqlite3, TxnModel 'sync'). */
export const DDL_SQLITE = `
CREATE TABLE IF NOT EXISTS quote_seen (
  signer_pubkey          TEXT    NOT NULL,
  quote_id               TEXT    NOT NULL,
  payee_pubkey           TEXT    NOT NULL,
  payer_pubkey           TEXT,
  exfer_amount           TEXT    NOT NULL,
  form                   TEXT    NOT NULL,
  accepted_at            INTEGER NOT NULL,
  expires_at             INTEGER NOT NULL,
  observed_before_expiry INTEGER NOT NULL DEFAULT 0,
  honored_at             INTEGER,
  honored_tx_id          TEXT,
  honored_output_index   INTEGER,
  retain_until           INTEGER NOT NULL,
  PRIMARY KEY (signer_pubkey, quote_id)
);

CREATE TABLE IF NOT EXISTS quote_consumed_outpoint (
  tx_id         TEXT    NOT NULL,
  output_index  INTEGER NOT NULL,
  signer_pubkey TEXT    NOT NULL,
  quote_id      TEXT    NOT NULL,
  state         TEXT    NOT NULL CHECK (state IN ('claim_pending','honored')),
  honored_at    INTEGER,
  claim_tx_id   TEXT,
  retain_until  INTEGER NOT NULL,
  PRIMARY KEY (tx_id, output_index)
);

CREATE INDEX IF NOT EXISTS idx_quote_seen_honorable
  ON quote_seen (signer_pubkey, honored_at, retain_until);
`;

/**
 * Postgres dialect (node-postgres, TxnModel 'async'). Identical logical schema;
 * `BIGINT`/`TEXT` choices mirror the SQLite table. `exfer_amount` is TEXT for the
 * same u64-overflow reason (§0). DDL is idempotent (IF NOT EXISTS) — `init()`
 * MUST be safe to call repeatedly (§4.1).
 */
export const DDL_POSTGRES = `
CREATE TABLE IF NOT EXISTS quote_seen (
  signer_pubkey          TEXT    NOT NULL,
  quote_id               TEXT    NOT NULL,
  payee_pubkey           TEXT    NOT NULL,
  payer_pubkey           TEXT,
  exfer_amount           TEXT    NOT NULL,
  form                   TEXT    NOT NULL,
  accepted_at            BIGINT  NOT NULL,
  expires_at             BIGINT  NOT NULL,
  observed_before_expiry BOOLEAN NOT NULL DEFAULT FALSE,
  honored_at             BIGINT,
  honored_tx_id          TEXT,
  honored_output_index   INTEGER,
  retain_until           BIGINT  NOT NULL,
  PRIMARY KEY (signer_pubkey, quote_id)
);

CREATE TABLE IF NOT EXISTS quote_consumed_outpoint (
  tx_id         TEXT    NOT NULL,
  output_index  INTEGER NOT NULL,
  signer_pubkey TEXT    NOT NULL,
  quote_id      TEXT    NOT NULL,
  state         TEXT    NOT NULL CHECK (state IN ('claim_pending','honored')),
  honored_at    BIGINT,
  claim_tx_id   TEXT,
  retain_until  BIGINT  NOT NULL,
  PRIMARY KEY (tx_id, output_index)
);

CREATE INDEX IF NOT EXISTS idx_quote_seen_honorable
  ON quote_seen (signer_pubkey, honored_at, retain_until);
`;
