import { test } from "node:test";
import assert from "node:assert/strict";
import { computeDeliverableRequirements, exampleDeliverable } from "./deliverable-requirements.js";
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

// content.coverage/source_grounding/no_hallucination ARE locatable (widened into CONTENT_METHODS
// - see verdict/types.ts) - a compiled criterion for one of these DOES carry a real locator, and
// must be counted like any other content method.
test("content.coverage/source_grounding/no_hallucination are counted like any other content method", () => {
  const criteria: Criterion[] = [
    criterion({ id: "c1", method: "content.coverage", locator: { method: "content.coverage", index: 0 }, tier: 2 }),
    criterion({ id: "c2", method: "content.no_hallucination", locator: { method: "content.no_hallucination", index: 0 }, tier: 2 }),
  ];
  assert.deepEqual(computeDeliverableRequirements(criteria), {
    content: { "content.coverage": 1, "content.no_hallucination": 1 },
  });
});

test("exampleDeliverable: empty requirements -> empty deliverable", () => {
  assert.deepEqual(exampleDeliverable({}), {});
});

test("exampleDeliverable: onchain has no separate asset array, just the claim arrays", () => {
  const example = exampleDeliverable({ onchain: { "onchain.tx_exists": 1 } });
  assert.deepEqual(example, { onchain: { "onchain.tx_exists": [{ txHash: "0xabc123...64-char tx hash" }] } });
});

test("exampleDeliverable: content.coverage/no_hallucination show just the asset, no claim array needed", () => {
  const example = exampleDeliverable({ content: { "content.coverage": 1 } }) as { content: Record<string, unknown> };
  assert.ok(Array.isArray(example.content.content), "asset array present");
  assert.equal(example.content["content.coverage"], undefined, "no claim array needed for the single-asset case");
});

test("exampleDeliverable: content.presence still shows a real example claim (can't be auto-inferred)", () => {
  const example = exampleDeliverable({ content: { "content.presence": 1 } }) as { content: Record<string, unknown> };
  assert.deepEqual(example.content["content.presence"], [{ assetId: "a1", target: { kind: "heading", value: "Breaking Changes" } }]);
});

test("exampleDeliverable: data/code buckets include their asset array alongside the claim", () => {
  const example = exampleDeliverable({ data: { "data.rowcount": 1 }, code: { "code.compiles": 1 } }) as {
    data: Record<string, unknown>;
    code: Record<string, unknown>;
  };
  assert.ok(Array.isArray(example.data.datasets));
  assert.deepEqual(example.data["data.rowcount"], [{ datasetId: "d1", minCount: 10 }]);
  assert.ok(Array.isArray(example.code.code));
  assert.deepEqual(example.code["code.compiles"], [{ codeId: "c1" }]);
});
