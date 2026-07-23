// Unit tests for the parallel-checks merge helper (see verify.ts's VERIFY_DEADLINE_MS/
// mergeCheckedCriteria comment for why this exists: OKX review found a paid request could
// settle payment yet the buyer received nothing, traced to our own worst-case latency
// outrunning a hosting proxy's patience - running the four checkers concurrently instead of
// sequentially cuts real latency, but only if the merge correctly reassembles their results).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeCheckedCriteria } from "./verify.js";
import type { Criterion } from "../verdict/types.js";

function criterion(id: string, method: Criterion["method"]): Criterion {
  return {
    id,
    text: "fixture criterion",
    source: "EXPLICIT",
    tier: 1,
    method,
    result: "UNVERIFIABLE",
    confidence: null,
    evidence: { kind: "none", ref: "", detail: "compiled, not yet verified" },
  };
}

test("mergeCheckedCriteria: each family's own result wins for its own criteria, others pass through", () => {
  const original = [criterion("c1", "onchain.tx_exists"), criterion("c2", "content.presence"), criterion("c3", null)];

  const onchainResult = original.map((c) => c); // untouched
  const dataResult = original.map((c) => c); // untouched
  const codeResult = original.map((c) => c); // untouched
  const contentResult = [original[0]!, { ...original[1]!, result: "PASS" as const }, original[2]!];

  const merged = mergeCheckedCriteria(original, onchainResult, dataResult, codeResult, contentResult);

  assert.equal(merged[0], original[0]); // untouched by every family
  assert.equal(merged[1]!.result, "PASS"); // content's change won
  assert.equal(merged[2], original[2]); // untouched, no locator
});

test("mergeCheckedCriteria: multiple families each modify their own disjoint criteria", () => {
  const original = [criterion("c1", "onchain.tx_exists"), criterion("c2", "data.rowcount"), criterion("c3", "code.compiles")];

  const onchainResult = [{ ...original[0]!, result: "PASS" as const }, original[1]!, original[2]!];
  const dataResult = [original[0]!, { ...original[1]!, result: "FAIL" as const }, original[2]!];
  const codeResult = [original[0]!, original[1]!, { ...original[2]!, result: "PASS" as const }];
  const contentResult = original.map((c) => c); // untouched

  const merged = mergeCheckedCriteria(original, onchainResult, dataResult, codeResult, contentResult);

  assert.equal(merged[0]!.result, "PASS");
  assert.equal(merged[1]!.result, "FAIL");
  assert.equal(merged[2]!.result, "PASS");
});

test("mergeCheckedCriteria: no family touches anything -> identical to original", () => {
  const original = [criterion("c1", "onchain.tx_exists"), criterion("c2", null)];
  const unchanged = original.map((c) => c);

  const merged = mergeCheckedCriteria(original, unchanged, unchanged, unchanged, unchanged);

  assert.deepEqual(merged, original);
  assert.equal(merged[0], original[0]);
  assert.equal(merged[1], original[1]);
});

test("mergeCheckedCriteria: empty criteria list -> empty result", () => {
  assert.deepEqual(mergeCheckedCriteria([], [], [], [], []), []);
});
