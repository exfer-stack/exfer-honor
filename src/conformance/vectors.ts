// CONFORMANCE — the vector loader (§9).
//
// Loads the frozen `{ fixture, expect }` corpus under docs/conformance/vectors and
// surfaces it as typed records. The corpus is the SOURCE OF TRUTH: the executable
// harness (`harness.ts`) runs each vector against an engine + a real Store and
// asserts the vector's expected outcome; a vector is NEVER weakened to make the
// engine pass — a divergence is an engine/forms/store bug.
//
// `/conformance` depends only on `/spec` + node builtins here; the harness pulls
// in `/core` + `/forms`, and the concrete Store adapters are INJECTED by the
// caller (the test file), so this layer never imports `/adapters`.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
/** docs/conformance/vectors, relative to src/conformance. */
export const VECTORS_DIR = join(HERE, "..", "..", "docs", "conformance", "vectors");

/** The frozen, open-ended vector shape (§9): a new rule/hole ships as a new
 *  vector with NO type change. `fixture`/`expect` stay `unknown`-keyed objects. */
export interface Vector {
  readonly id: string;
  readonly title?: string;
  readonly rules: readonly string[];
  readonly datumVersion?: number;
  /** F8: the async-under-sync case is enforced by the typecheck gate (deliver.test-d.ts). */
  readonly compileTimeOnly?: boolean;
  readonly fixture: Record<string, unknown>;
  readonly expect: Record<string, unknown>;
}

/** The full mandatory §9 corpus the design freezes. Any implementation MUST pass these. */
export const MANDATORY_IDS = [
  "plain/happy",
  "datum/multi-id-reject",
  "datum/trailing-bytes",
  "datum/hash-only",
  "datum/version-byte",
  "gate/two-outpoints",
  "gate/legacy-coexist",
  "payee/not-controlled",
  "amount/below",
  "amount/above",
  "payer/consent",
  "payer/source",
  "r6/late-honor",
  "r6/swept-mid-honor",
  "htlc/two-phase",
  "htlc/reorg-withheld",
  "deliver/throws",
  "deliver/async-under-sync",
  "deliver/out-of-band-handle",
  "recovery/crash-pre-commit",
  "recovery/async-ambiguous-commit",
] as const;

/** Load every vector in the corpus, keyed by `<group>/<name>`. */
export function loadAllVectors(): Vector[] {
  const out: Vector[] = [];
  for (const group of readdirSync(VECTORS_DIR, { withFileTypes: true })) {
    if (!group.isDirectory()) continue;
    const groupDir = join(VECTORS_DIR, group.name);
    for (const file of readdirSync(groupDir)) {
      if (!file.endsWith(".json")) continue;
      const vec = JSON.parse(readFileSync(join(groupDir, file), "utf8")) as Vector;
      out.push(vec);
    }
  }
  return out;
}

/** Load a single vector by its `<group>/<name>` id; throws if absent. */
export function loadVector(id: string): Vector {
  const vec = loadAllVectors().find((v) => v.id === id);
  if (vec === undefined) {
    throw new Error(`conformance vector '${id}' not found under ${VECTORS_DIR}`);
  }
  return vec;
}
