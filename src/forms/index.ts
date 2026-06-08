// `@exfer/honor/forms` barrel — the SettlementForm contract (re-exported from
// /ports) + the builtin strategies (§4.3, §6).
//
// `/forms` depends ONLY on `/ports` + `/spec` (the §2.3 layering rule): it never
// imports a concrete chain, DB, indexer, or keystore. Each form is a pure
// strategy plugged into the engine via the registry; the engine NEVER
// special-cases `plain` vs `htlc` (§4.3) — it delegates ALL form-specific
// candidate validation and gating to `forms.get(quote.form)`.
//
// Adding a form (§4.5): widen the SettlementFormId union (additive minor, no
// HONOR_API_VERSION bump), implement SettlementForm, register it, ship a
// conformance vector — core, the gate txn, and every other form stay untouched.
// See `examples/trivial-form` for a worked third form.

import type { SettlementForm } from "../ports/index.js";
import { HtlcForm, type HtlcClaimReserver } from "./htlc.js";
import { PlainOutputForm } from "./plain.js";

export { PlainOutputForm } from "./plain.js";
export { HtlcForm } from "./htlc.js";
export type { HtlcClaimReserver } from "./htlc.js";
export { runBindingSpine } from "./spine.js";
export type { SpineResult } from "./spine.js";
export {
  domainHashAddr,
  referenceAddressDeriver,
  EXFER_ADDR_DOMAIN_TAG,
} from "./address.js";

/**
 * The two standard builtin forms (§6.2 plain `single`, §6.3 HTLC `promote`),
 * ready to drop into a `FormRegistry`. The HTLC form is wired with the consumer's
 * claim-outpoint reserver (its Store) so Phase A reserves `claim_pending` (F13/M4).
 *
 * @example
 *   const forms = createFormRegistry(builtinForms({ htlcReserver: store }));
 */
export function builtinForms(
  opts: {
    readonly htlcReserver?: HtlcClaimReserver;
  } = {},
): SettlementForm[] {
  return [new PlainOutputForm(), new HtlcForm(opts.htlcReserver)];
}
