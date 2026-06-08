// CORE — the SettlementForm registry implementation (§4.3).
//
// `SettlementForm` is a CLOSED string-literal union at the API edge; the registry
// is keyed by that union and REJECTS unknown form strings at runtime. New forms
// widen the union as an ADDITIVE minor (no HONOR_API_VERSION bump) and register
// here without touching core.
//
// Stage 3 ships a generic, form-agnostic registry: the concrete builtin forms
// (PlainOutputForm `single`, HtlcForm `promote`) land in Stage 4. Until then a
// consumer (or a test) registers its own SettlementForm strategies; the engine
// delegates ALL form-specific candidate validation to `forms.get(quote.form)` and
// never special-cases `plain` vs `htlc` (§4.3).

import { HonorError } from "../spec/index.js";
import type { SettlementFormId } from "../spec/index.js";
import type { SettlementForm, SettlementFormRegistry } from "../ports/index.js";

/**
 * A mutable, in-process registry of `SettlementForm` strategies keyed by the
 * closed `SettlementFormId` union. `get` throws `malformed_quote` for an
 * unregistered id (a quote naming a form no instance knows how to honor is, from
 * the engine's view, a malformed credential it MUST NOT silently honor).
 */
export class FormRegistry implements SettlementFormRegistry {
  private readonly forms = new Map<SettlementFormId, SettlementForm>();

  constructor(initial?: Iterable<SettlementForm>) {
    if (initial) {
      for (const form of initial) {
        this.set(form);
      }
    }
  }

  /** Register (or replace) a form strategy under its own `id`. */
  set(form: SettlementForm): this {
    this.forms.set(form.id, form);
    return this;
  }

  get(id: SettlementFormId): SettlementForm {
    const form = this.forms.get(id);
    if (form === undefined) {
      throw new HonorError(
        "malformed_quote",
        `no SettlementForm registered for id '${id}'`,
      );
    }
    return form;
  }

  has(id: string): boolean {
    return this.forms.has(id as SettlementFormId);
  }
}

/** Convenience: build a registry from a list of forms. */
export function createFormRegistry(
  forms: Iterable<SettlementForm>,
): SettlementFormRegistry {
  return new FormRegistry(forms);
}
