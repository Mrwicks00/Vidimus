import { test } from "node:test";
import assert from "node:assert/strict";
import { computeHeadline } from "./headline.js";
import type { Criterion, CriterionSource, Tier, VerdictResult } from "../verdict/types.js";

let seq = 0;
function criterion(
  result: VerdictResult,
  opts: { tier?: Tier; source?: CriterionSource } = {},
): Criterion {
  seq += 1;
  return {
    id: `c${seq}`,
    text: "fixture criterion",
    source: opts.source ?? "EXPLICIT",
    tier: opts.tier ?? 1,
    method: null,
    result,
    confidence: result === "PASS" || result === "FAIL" ? 1.0 : null,
    evidence: { kind: result === "UNVERIFIABLE" ? "none" : "tx", ref: "fixture", detail: "fixture" },
  };
}

test("no tier 1/2 criteria -> UNVERIFIABLE headline, empty basis", () => {
  const criteria = [criterion("UNVERIFIABLE", { tier: 3, source: "EXPLICIT" })];
  const { headline, headline_basis } = computeHeadline(criteria);
  assert.equal(headline, "UNVERIFIABLE");
  assert.deepEqual(headline_basis, []);
});

test("all Tier 1/2 PASS -> PASS headline", () => {
  const criteria = [criterion("PASS", { tier: 1 }), criterion("PASS", { tier: 2 })];
  const { headline } = computeHeadline(criteria);
  assert.equal(headline, "PASS");
});

test("EXPLICIT FAIL in scope -> FAIL headline", () => {
  const criteria = [
    criterion("PASS", { tier: 1 }),
    criterion("FAIL", { tier: 1, source: "EXPLICIT" }),
  ];
  const { headline } = computeHeadline(criteria);
  assert.equal(headline, "FAIL");
});

// The pinned regression: an INFERRED-only FAIL must NOT sink the headline to FAIL.
// L11 / VERDICT_SPEC §4 - this is the case the spec was previously silent on.
test("INFERRED-only FAIL -> capped at PARTIAL, not FAIL", () => {
  const criteria = [
    criterion("PASS", { tier: 1, source: "EXPLICIT" }),
    criterion("FAIL", { tier: 2, source: "INFERRED" }),
  ];
  const { headline, headline_basis } = computeHeadline(criteria);
  assert.equal(headline, "PARTIAL");
  assert.equal(headline_basis.length, 2);
});

test("EXPLICIT FAIL alongside an INFERRED FAIL -> EXPLICIT wins, headline is FAIL", () => {
  const criteria = [
    criterion("FAIL", { tier: 1, source: "INFERRED" }),
    criterion("FAIL", { tier: 2, source: "EXPLICIT" }),
  ];
  const { headline } = computeHeadline(criteria);
  assert.equal(headline, "FAIL");
});

test("no FAIL, some UNVERIFIABLE in scope -> PARTIAL", () => {
  const criteria = [criterion("PASS", { tier: 1 }), criterion("UNVERIFIABLE", { tier: 2 })];
  const { headline } = computeHeadline(criteria);
  assert.equal(headline, "PARTIAL");
});

test("mix of PASS and PARTIAL, no FAIL -> PARTIAL", () => {
  const criteria = [criterion("PASS", { tier: 1 }), criterion("PARTIAL", { tier: 2 })];
  const { headline } = computeHeadline(criteria);
  assert.equal(headline, "PARTIAL");
});

test("Tier 3 criteria never affect headline, even if FAIL", () => {
  const criteria = [
    criterion("PASS", { tier: 1 }),
    criterion("PASS", { tier: 2 }),
    criterion("FAIL", { tier: 3, source: "EXPLICIT" }),
  ];
  const { headline, headline_basis } = computeHeadline(criteria);
  assert.equal(headline, "PASS");
  assert.equal(headline_basis.length, 2);
});

test("headline_basis lists every Tier 1/2 id, not just the deciding ones", () => {
  const a = criterion("PASS", { tier: 1 });
  const b = criterion("FAIL", { tier: 2, source: "INFERRED" });
  const c = criterion("UNVERIFIABLE", { tier: 1 });
  const { headline_basis } = computeHeadline([a, b, c]);
  assert.deepEqual(headline_basis, [a.id, b.id, c.id]);
});
