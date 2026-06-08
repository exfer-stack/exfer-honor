# Conformance vectors

The frozen scenario list any `exfer-honor` implementation MUST pass (design §9).
Each vector is a `{ fixture, expect }` record (open-ended schema — a new
rule/hole ships as a new vector with **no type change**). At Stage 2 the vectors
are **declarative fixtures**, validated for structure; the executable
`Conformance.check(engine, vector)` harness lands in Stage 6 and exercises them
against the in-memory fakes and both reference stores.

The shared shape is documented in [`vector.schema.json`](./vector.schema.json)
and mirrored by the `ConformanceVector` type in
`src/spec` consumers / the Stage-6 harness. Each vector file lives under
`vectors/<group>/<name>.json`.

## Mandatory corpus

| Vector | Asserts | Rule / Hole |
|---|---|---|
| `plain/happy` | single confirmed exact-amount output → exactly one delivery | R1, R4 |
| `datum/multi-id-reject` | 32-byte datum w/ two quote_ids → `datum_unhonorable` | **F1** |
| `datum/trailing-bytes` | 16-byte quote_id + trailing → `datum_unhonorable` | **F1/R7** |
| `datum/hash-only` | `datum_hash`-only → `datum_unhonorable`, no address+amount fallback | **M2** |
| `datum/version-byte` | a v2-encoded datum MUST NOT decode under v1 | §3.7 |
| `gate/two-outpoints` | one quote_id in two outputs → first honors, second `already_honored` | **F3** |
| `gate/legacy-coexist` | no zero-gate path can re-consume a gated outpoint | **M4** |
| `payee/not-controlled` | `controlsPayee=false` → `payee_not_controlled`; keystore-throw → retryable | **M3/R2** |
| `amount/below` | `value < exferAmount` → `amount_mismatch` (never `>=`) | R4/D4 |
| `amount/above` | `value > exferAmount` → `amount_mismatch` (never `>=`) | R4/D4 |
| `payer/consent` | R5 CONSENT binding passes | R5/D3 |
| `payer/source` | R5 SOURCE binding; covenant-only → `payer_binding_failed` | R5/D3 |
| `r6/late-honor` | observed-before-expiry honors in window; first-seen-after-expiry declines | R6 |
| `r6/swept-mid-honor` | sweep vs honor contend → no double, correct decline | **F10** |
| `htlc/two-phase` | Phase A reserve → Phase B promote → exactly one delivery | **F13/R3** |
| `htlc/reorg-withheld` | claim un-mined → `reorg_withheld`, no premature honor | R3 |
| `deliver/throws` | gate rolled back (`honored_at IS NULL`, no row) → `delivery_failed` | **F11** |
| `deliver/async-under-sync` | does NOT compile (type test) + runtime guard throws | **F8** |
| `deliver/out-of-band-handle` | separate-connection write → `store_topology` / `contract_violation` | **F12** |
| `recovery/crash-pre-commit` | nothing written, clean retry | F9 |
| `recovery/async-ambiguous-commit` | re-invoke deliver for honored-but-unproven row | **F9** |

The `deliver/async-under-sync` row is a **compile-time** assertion — see
`src/spec/deliver.test-d.ts`. It has a placeholder fixture here only so the
corpus index is complete; it is enforced by the typecheck gate, not the runtime
harness.
