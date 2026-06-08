// Conformance-vector corpus STRUCTURE tests (§9). At Stage 2 the vectors are
// declarative fixtures; the executable Conformance.check harness lands in Stage 6.
// These tests assert the corpus parses, every fixture matches the frozen shape,
// the mandatory corpus is complete, and ids/dirs agree. Run: npm test
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const VECTORS_DIR = join(HERE, "..", "..", "docs", "conformance", "vectors");

// The mandatory corpus the design §9 freezes. Any implementation MUST pass these.
const MANDATORY_IDS = [
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

interface Vector {
  id: string;
  title?: string;
  rules: string[];
  datumVersion?: number;
  compileTimeOnly?: boolean;
  fixture: Record<string, unknown>;
  expect: Record<string, unknown>;
}

function loadAllVectors(): Array<{ relId: string; path: string; vec: Vector }> {
  const out: Array<{ relId: string; path: string; vec: Vector }> = [];
  for (const group of readdirSync(VECTORS_DIR, { withFileTypes: true })) {
    if (!group.isDirectory()) continue;
    const groupDir = join(VECTORS_DIR, group.name);
    for (const file of readdirSync(groupDir)) {
      if (!file.endsWith(".json")) continue;
      const path = join(groupDir, file);
      const vec = JSON.parse(readFileSync(path, "utf8")) as Vector;
      const relId = `${group.name}/${file.replace(/\.json$/, "")}`;
      out.push({ relId, path, vec });
    }
  }
  return out;
}

const ID_RE = /^[a-z0-9]+\/[a-z0-9-]+$/;
const RULE_RE = /^[RFMD][0-9]+$/;

test("every vector file parses as JSON and matches the frozen { fixture, expect } shape", () => {
  const vectors = loadAllVectors();
  assert.ok(vectors.length > 0, "corpus is non-empty");
  for (const { relId, vec } of vectors) {
    assert.equal(typeof vec.id, "string", `${relId}: id is a string`);
    assert.match(vec.id, ID_RE, `${relId}: id matches '<group>/<name>'`);
    assert.ok(Array.isArray(vec.rules) && vec.rules.length > 0, `${relId}: has rules`);
    for (const r of vec.rules) {
      assert.match(r, RULE_RE, `${relId}: rule '${r}' is an R/F/M/D tag`);
    }
    assert.equal(typeof vec.fixture, "object", `${relId}: fixture is an object`);
    assert.notEqual(vec.fixture, null, `${relId}: fixture non-null`);
    assert.equal(typeof vec.expect, "object", `${relId}: expect is an object`);
    assert.notEqual(vec.expect, null, `${relId}: expect non-null`);
    if (vec.datumVersion !== undefined) {
      assert.ok(
        Number.isInteger(vec.datumVersion) && vec.datumVersion >= 1,
        `${relId}: datumVersion is a positive int`,
      );
    }
  }
});

test("the vector's declared id agrees with its <dir>/<file> location", () => {
  for (const { relId, vec } of loadAllVectors()) {
    assert.equal(vec.id, relId, `${relId}: id matches path`);
  }
});

test("the full mandatory §9 corpus is present (and ids are unique)", () => {
  const present = new Set(loadAllVectors().map((v) => v.vec.id));
  for (const id of MANDATORY_IDS) {
    assert.ok(present.has(id), `mandatory vector '${id}' is present`);
  }
  assert.equal(
    present.size,
    loadAllVectors().length,
    "no duplicate vector ids in the corpus",
  );
});

test("the F8 vector is flagged compileTimeOnly (enforced by the typecheck gate)", () => {
  const f8 = loadAllVectors().find((v) => v.vec.id === "deliver/async-under-sync");
  assert.ok(f8, "F8 vector present");
  assert.equal(f8?.vec.compileTimeOnly, true, "F8 vector is compile-time-only");
});

test("delivery-count expectations, where present, are non-negative integers", () => {
  for (const { relId, vec } of loadAllVectors()) {
    const d = (vec.expect as { deliveries?: unknown }).deliveries;
    if (d !== undefined) {
      assert.ok(
        Number.isInteger(d) && (d as number) >= 0,
        `${relId}: deliveries is a non-negative int`,
      );
    }
  }
});
