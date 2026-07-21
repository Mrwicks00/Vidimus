import { test } from "node:test";
import assert from "node:assert/strict";
import { computeDeliverableRequirements } from "./deliverable-requirements.js";
import type { Criterion } from "../verdict/types.js";

function criterion(opts: Partial<Criterion> & Pick<Criterion, "id">): Criterion {
  return {
    text: "fixture criterion",
    source: "EXPLICIT",
    tier: 1,
    method: null,
    result: "UNVERIFIABLE",
    confidence: null,
    evidence: { kind: "none", ref: "", detail: "compiled, not yet verified" },
    ...opts,
  };
}

test("groups locators by bucket/method, count = max index + 1", () => {
  const criteria: Criterion[] = [
    criterion({ id: "c1", method: "onchain.tx_exists", locator: { method: "onchain.tx_exists", index: 0 } }),
    criterion({ id: "c2", method: "onchain.tx_exists", locator: { method: "onchain.tx_exists", index: 1 } }),
    criterion({ id: "c3", method: "onchain.owner_check", locator: { method: "onchain.owner_check", index: 0 } }),
    criterion({ id: "c4", method: "data.sample_verify", locator: { method: "data.sample_verify", index: 2 } }),
    criterion({ id: "c5", method: "content.format", locator: { method: "content.format", index: 0 } }),
  ];

  assert.deepEqual(computeDeliverableRequirements(criteria), {
    onchain: { "onchain.tx_exists": 2, "onchain.owner_check": 1 },
    data: { "data.sample_verify": 3 },
    content: { "content.format": 1 },
  });
});

test("excludes criteria with no locator (method: null or non-locatable methods)", () => {
  const criteria: Criterion[] = [
    criterion({ id: "c1", method: null }),
    criterion({ id: "c2", method: "taste.refused" }),
    criterion({ id: "c3", method: "content.coverage" }),
    criterion({ id: "c4", method: "onchain.tx_exists", locator: { method: "onchain.tx_exists", index: 0 } }),
  ];

  assert.deepEqual(computeDeliverableRequirements(criteria), {
    onchain: { "onchain.tx_exists": 1 },
  });
});

test("empty criteria list produces no requirements", () => {
  assert.deepEqual(computeDeliverableRequirements([]), {});
});
