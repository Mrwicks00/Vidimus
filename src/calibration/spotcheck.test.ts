// Unit tests for the D6.B reproducibility spot-check (docs/ROADMAP.md D6.B). Offline, no live
// calls - exercises the content family (m3-content.ts is pure, no chain/Docker dependency),
// same rationale as the module-level note in spotcheck.ts for why content is the clean
// demonstration case. Reuses the real applyContentChecks dispatch, not a reimplementation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spotCheckCriterion, type RawDeliverable } from "./spotcheck.js";
import { toCalibrationCriterionEntry } from "./types.js";
import { applyContentChecks } from "../modules/m3-content.js";
import { quarantineContentDeliverable } from "../security/quarantine.js";
import type { Criterion } from "../verdict/types.js";

// Mirrors scripts/fixtures/content-deliverable.json's shape.
const rawDeliverable: RawDeliverable = {
  content: {
    content: [
      {
        id: "changelog",
        format: "markdown",
        content:
          "# Overview\n\nThis release brings a wide set of improvements. " +
          "Word ".repeat(60) +
          "\n\n## Known Issues\n\nSome minor issues remain.\n",
      },
    ],
    "content.presence": [{ assetId: "changelog", target: { kind: "heading", value: "Breaking Changes" } }],
    "content.bounds": [{ assetId: "changelog", metric: "word_count", min: 50 }],
    "content.format": [{ assetId: "changelog" }],
  },
};

let seq = 0;
function compiledCriterion(method: "content.presence" | "content.bounds" | "content.format", index: number): Criterion {
  seq += 1;
  return {
    id: `c${seq}`,
    text: "fixture criterion",
    source: "EXPLICIT",
    tier: 1,
    method,
    locator: { method, index },
    result: "UNVERIFIABLE",
    confidence: null,
    evidence: { kind: "none", ref: "", detail: "compiled, not yet verified" },
  };
}

async function runRealChecker(c: Criterion): Promise<Criterion> {
  const { sealed, rejected } = quarantineContentDeliverable(rawDeliverable.content);
  const [result] = applyContentChecks([c], sealed, rejected);
  return result!;
}

test("spot-check reproduces a real content.presence FAIL (heading genuinely absent)", async () => {
  const c = compiledCriterion("content.presence", 0);
  const original = await runRealChecker(c);
  assert.equal(original.result, "FAIL"); // sanity: fixture doesn't contain "Breaking Changes"

  const loggedEntry = toCalibrationCriterionEntry(original);
  const spotCheck = await spotCheckCriterion(loggedEntry, rawDeliverable);

  assert.equal(spotCheck.recomputed_result, "FAIL");
  assert.equal(spotCheck.matches, true);
});

test("spot-check reproduces a real content.bounds PASS", async () => {
  const c = compiledCriterion("content.bounds", 0);
  const original = await runRealChecker(c);
  assert.equal(original.result, "PASS");

  const spotCheck = await spotCheckCriterion(toCalibrationCriterionEntry(original), rawDeliverable);
  assert.equal(spotCheck.recomputed_result, "PASS");
  assert.equal(spotCheck.matches, true);
});

test("spot-check reproduces a real content.format PASS", async () => {
  const c = compiledCriterion("content.format", 0);
  const original = await runRealChecker(c);
  assert.equal(original.result, "PASS");

  const spotCheck = await spotCheckCriterion(toCalibrationCriterionEntry(original), rawDeliverable);
  assert.equal(spotCheck.recomputed_result, "PASS");
  assert.equal(spotCheck.matches, true);
});

test("spot-check flags a mismatch if the logged result doesn't match reality (tamper/drift detection)", async () => {
  const c = compiledCriterion("content.bounds", 0);
  const original = await runRealChecker(c);
  const loggedEntry = toCalibrationCriterionEntry(original);
  loggedEntry.result = "FAIL"; // simulate a corrupted/incorrect logged row

  const spotCheck = await spotCheckCriterion(loggedEntry, rawDeliverable);
  assert.equal(spotCheck.recomputed_result, "PASS");
  assert.equal(spotCheck.matches, false);
});

test("spot-check declines (does not fake a comparison) for a non-Tier-1 or unlocated criterion", async () => {
  const tasteEntry = toCalibrationCriterionEntry({
    id: "c-taste",
    text: "fixture",
    source: "EXPLICIT",
    tier: 3,
    method: "taste.refused",
    result: "UNVERIFIABLE",
    confidence: null,
    evidence: { kind: "none", ref: "", detail: "taste" },
  });
  const spotCheck = await spotCheckCriterion(tasteEntry, rawDeliverable);
  assert.equal(spotCheck.matches, false);
  assert.ok(spotCheck.skipped_reason);
});
