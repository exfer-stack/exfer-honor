# EXFER-HONOR — Standard Specification (v1)

**Status:** Frozen standard (Stage 2). **API version:** `HONOR_API_VERSION = 1`.
**Datum version:** `SETTLEMENT_DATUM_VERSION = 1`.

This document is the normative, machine-checkable companion to the design
(`EXFER_HONOR_DESIGN.md`). The TypeScript declarations in `src/spec` and
`src/ports` are the executable form of these clauses; this prose is the law they
encode. RFC-2119 keywords (**MUST / MUST NOT / SHOULD / MAY**) are normative.

## 0. Conventions

- All hex is **bare lowercase** `^[0-9a-f]*$` — no `0x` prefix.
- All binding amounts are `bigint` (u64) end-to-end on the binding path; never
  `number`, never a decimal string, until the persistence boundary.
- The wire datum is `SETTLEMENT_DATUM = bare 16-byte quote_id`, strict-decoded
  with **zero trailing bytes**.
- "Honor" = delivering priced goods against an observed, final, 1:1-bound,
  payer-consented settlement, **exactly once**, reorg-revocably.

## 1. Versioning (§3.7)

1. A consumer **MUST** assert `engine.apiVersion === HONOR_API_VERSION` at
   construction. `createHonorEngine` performs this; a mismatch **MUST** throw
   `HonorError('api_version_mismatch', …)`.
2. Any change to a public type's field layout, an operation signature, the
   `HonorVerdict` / `HonorOutcome` discriminants, the `DeliverFn` txn contract,
   or the error-code set **REQUIRES** a major bump of `HONOR_API_VERSION`.
3. Adding a `SettlementForm`, adding an enum value, or adding an OPTIONAL field
   is **additive** — no bump.
4. Datum-format changes **REQUIRE** a `SETTLEMENT_DATUM_VERSION` bump and a
   paired decoder behind the version byte, with **zero trailing bytes**. A datum
   encoded under one version **MUST NOT** decode under another.

## 2. The settlement datum codec (§6.1, F1)

The v1 datum is the **bare 16-byte quote_id**.

1. `decodeSettlementDatum(hex)` **MUST** return a `QuoteId` **iff** `hex` is
   bare-lowercase hex describing **exactly 16 bytes** (32 hex characters).
2. Any other byte length — `0, 1, 15, 17, 32, 4096, …` — **MUST** be rejected.
   A 32-byte input (two concatenated quote_ids) **MUST** be rejected: this is
   the **F1** multi-id attack.
3. A 16-byte quote_id with **any** trailing bytes **MUST** be rejected
   (**F1/R7** — zero trailing bytes).
4. Non-hex or odd-length input **MUST** be rejected.
5. `encodeSettlementDatum(quoteId)` is the inverse and **MUST** reject any input
   that is not exactly a 16-byte bare-hex string — an encoder **MUST NOT** emit a
   malformed datum.
6. A datum passed under the wrong `version` **MUST** be rejected
   (`unknown_version`) (§3.7).

## 3. The error model (§3.6)

1. Policy outcomes (every R1–R7 result) are **VALUES**, not exceptions.
   `honor()` returns `not_ready{verdict}` or `delivery_failed`; it **MUST NOT**
   throw for any policy result.
2. `HonorError` is thrown **ONLY** for infra faults
   (`db_fault` / `chain_fault` / `keystore_fault` / `indexer_fault`), contract
   violations (`malformed_quote`, `api_version_mismatch`, `contract_violation`,
   `store_topology`), gate-lock invariants
   (`seen_lock_violation`, `outpoint_collision`), and the startup
   `claim_margin_assertion`.
3. **Dual-typing rule.** `seen_lock_violation` / `outpoint_collision` raised by a
   concurrent honor of the **same** quote **MUST** be caught inside `honor()` and
   converted to the benign value `not_ready{decline:'already_honored' |
   'outpoint_consumed'}`.
4. **Transient-vs-terminal rule.** Keystore unavailability **MUST** throw a
   retryable `keystore_fault`; `decline:'payee_not_controlled'` is reserved for a
   definitive negative test-sign (R2/M3). An honorable quote can never be
   permanently stranded by a flaky keystore.

## 4. The delivery contract (§3.5, F8)

1. `DeliverFn<M>` is parameterized by the store's `TxnModel`. `DeliverFn<'sync'>`
   has **no `Promise` union**: a sync-backed engine accepts **only**
   `(ctx) => void`. An `async` deliver under a sync store **MUST** be a compile
   error.
2. The engine **MUST** also guard at runtime: inside the synchronous txn body it
   **MUST** reject a thenable return with `HonorError('contract_violation', …)`,
   rolling the txn back rather than committing.
3. Goods writes **MUST** go through `DeliverContext.db` — the same txn-scoped
   handle the gate writes ran on (F12). A separate connection (sync) or an
   out-of-band client (async) is **UNDEFINED BEHAVIOR that voids F3**.

## 5. The cross-boundary atomic honor transaction (§5)

1. `honor()` **MUST** run the gate writes and the consumer's `deliver` inside
   **one local ACID transaction**: the SEEN hard-lock and the CONSUMED-outpoint
   write **MUST** commit before any goods move, and the gate **MUST NOT** commit
   if `deliver` throws (**F3/F11**).
2. A throw from `deliver()` **MUST** propagate uncaught through the txn body so
   the store rolls back **both** gate writes. The engine **MUST NOT** wrap
   `deliver()` in a `try/catch` inside the txn body. `honor()` then returns
   `delivery_failed{retryable:true}` (default) or re-throws if
   `opts.rethrowDeliveryErrors` is set (**F11**).
3. The R6 late-honor predicate
   (`observed_before_expiry == 1 AND now < retain_until`) **MUST** be re-asserted
   **inside** `runHonorTxn` against the freshly-locked row at a single
   commit-time `now` (**F10**).
4. Plain output uses `mode:'single'` (insert directly as `'honored'`, §5.2). HTLC
   uses Phase A `reserveClaimOutpoint(state='claim_pending')` then Phase B
   `mode:'promote'` (**UPDATE**, not INSERT, so no PK collision) (**F13**).

## 6. The scoring spine (§6.1, every form, in order)

0. Load the SEEN row (R6). If `honored_at != NULL` → `decline 'already_honored'`.
1. `discover()` candidates; none → `wait 'no_candidate'`.
2. STRICT-decode the datum: `honorable == false` → `decline 'datum_unhonorable'`
   (M2); non-16-byte / multi-id / trailing → `decline 'datum_unhonorable'`
   (F1/R7); full-equality `decoded.quoteId === quote.quoteId` else skip.
3. AMOUNT: `candidate.value === quote.exferAmount` (EXACT `==`, never `>=`) else
   `decline 'amount_mismatch'` (R4).
4. ADDRESS: `candidate.scriptHex === domain_hash(EXFER-ADDR, payeePubkey)` else
   `decline 'address_mismatch'` (R4/M2 — no datum_hash fallback).
5. PAYEE CUSTODY: `keys.controlsPayee(payeePubkey)`; throws → `keystore_fault`
   (retryable); false → `decline 'payee_not_controlled'` (R2/M3).
6. PAYER BINDING (R5), per config: `payerPubkey == null` → pass; CONSENT
   (default) → pass; SOURCE (opt-in) → payer-keyed prevouts fund the settlement
   else `decline 'payer_binding_failed'`.
7. → form-specific depth / preimage gate.
8. all pass → `honor{candidate, form}`.

## 7. Conformance vectors (§9)

The mandatory vector corpus is enumerated in
[`conformance/index.md`](./conformance/index.md). Each vector is
`{ fixture, expect }` (open-ended schema, so a new rule/hole ships as a new
vector with no type change). Every implementation **MUST** pass the full corpus
against the in-memory fakes and against both reference stores.

## 8. Rule & hole coverage

See design §10. R1–R7 (the honor rules) and F1/F3/M2/M3/M4 + F8–F13 (the closed
holes) each map to a normative clause above and a conformance vector below.
