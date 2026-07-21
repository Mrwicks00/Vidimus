// Unit test for the canary tripwire itself (SECURITY.md §3) - deterministic, no live model
// call. Proves the detection mechanism fires on a leak regardless of whether any particular
// live prompt-injection attempt happens to fool the model (see CLAUDE_HISTORY.md Session 5:
// two real injection attempts against the live compileCriteria call were both correctly
// resisted by the model, so the InjectionSuspectedError path wasn't fired live - this test
// closes the gap so the mechanism is proven independently of that outcome).
import { test } from "node:test";
import assert from "node:assert/strict";
import { containsCanary, assignLocators, compileCriteria } from "./m2-criteria-compiler.js";
import { BIAS_PROBE_CASES, ACCEPTANCE_MIN_CORRECT_RATE, ACCEPTANCE_K } from "./m2-bias-cases.js";
import { randomBytes } from "node:crypto";

test("containsCanary: false when the canary never appears", () => {
  const output = {
    criteria: [{ id: "c1", text: "The page must have a logo.", inference_note: null }],
  };
  assert.equal(containsCanary(output, "deadbeefcafef00d"), false);
});

test("containsCanary: true when the canary leaks into a criterion's text field", () => {
  const output = {
    criteria: [{ id: "c1", text: "deadbeefcafef00d", inference_note: null }],
  };
  assert.equal(containsCanary(output, "deadbeefcafef00d"), true);
});

test("containsCanary: true when the canary leaks anywhere in the structured output, not just text", () => {
  const output = {
    criteria: [
      { id: "c1", text: "The page must have a logo.", inference_note: "leaked: deadbeefcafef00d" },
    ],
  };
  assert.equal(containsCanary(output, "deadbeefcafef00d"), true);
});

// D4.5: assignLocators is the pure core of the locator-binding layer - unit-tested
// independently of any live compileCriteria call, same rationale as containsCanary above.
test("assignLocators: sequential 0-based indices within a single onchain method", () => {
  const locators = assignLocators(["onchain.tx_exists", "onchain.tx_exists", "onchain.tx_exists"]);
  assert.deepEqual(locators, [
    { method: "onchain.tx_exists", index: 0 },
    { method: "onchain.tx_exists", index: 1 },
    { method: "onchain.tx_exists", index: 2 },
  ]);
});

test("assignLocators: independent counters per method, interleaved order", () => {
  const locators = assignLocators([
    "onchain.transfer_check",
    "onchain.destination_check",
    "onchain.transfer_check",
    "onchain.destination_check",
    "onchain.transfer_check",
  ]);
  assert.deepEqual(locators, [
    { method: "onchain.transfer_check", index: 0 },
    { method: "onchain.destination_check", index: 0 },
    { method: "onchain.transfer_check", index: 1 },
    { method: "onchain.destination_check", index: 1 },
    { method: "onchain.transfer_check", index: 2 },
  ]);
});

// content.coverage/source_grounding/no_hallucination became locatable when M4 Tier-2 shipped
// (widened CONTENT_METHODS, src/verdict/types.ts) - taste.refused (Tier 3, no locator scheme)
// and method: null remain the non-locatable cases this test actually covers now.
test("assignLocators: undefined for null method and for non-locatable methods", () => {
  const locators = assignLocators([null, "content.coverage", "onchain.owner_check", "taste.refused"]);
  assert.deepEqual(locators, [undefined, { method: "content.coverage", index: 0 }, { method: "onchain.owner_check", index: 0 }, undefined]);
});

// D5: assignLocators widened from onchain-only to isLocatableMethod (onchain | data) - same
// assignment logic, more method families, so data.* methods get real locators too.
test("assignLocators: sequential indices within a single data method", () => {
  const locators = assignLocators(["data.sample_verify", "data.sample_verify"]);
  assert.deepEqual(locators, [
    { method: "data.sample_verify", index: 0 },
    { method: "data.sample_verify", index: 1 },
  ]);
});

test("assignLocators: onchain and data method counters are independent, interleaved order", () => {
  const locators = assignLocators(["data.schema", "onchain.tx_exists", "data.schema", "onchain.tx_exists"]);
  assert.deepEqual(locators, [
    { method: "data.schema", index: 0 },
    { method: "onchain.tx_exists", index: 0 },
    { method: "data.schema", index: 1 },
    { method: "onchain.tx_exists", index: 1 },
  ]);
});

// D5 M3.C: assignLocators widened again to isLocatableMethod (onchain | data | code) - same
// assignment logic, a third method family.
test("assignLocators: sequential indices within a single code method", () => {
  const locators = assignLocators(["code.compiles", "code.compiles", "code.tests_pass"]);
  assert.deepEqual(locators, [
    { method: "code.compiles", index: 0 },
    { method: "code.compiles", index: 1 },
    { method: "code.tests_pass", index: 0 },
  ]);
});

test("assignLocators: onchain, data, and code method counters are all independent", () => {
  const locators = assignLocators(["code.compiles", "data.schema", "onchain.tx_exists", "code.compiles"]);
  assert.deepEqual(locators, [
    { method: "code.compiles", index: 0 },
    { method: "data.schema", index: 0 },
    { method: "onchain.tx_exists", index: 0 },
    { method: "code.compiles", index: 1 },
  ]);
});

// LOCK phase, M2 tagging-bias slice (CLAUDE_HISTORY.md, session between M3.C and D6): pinned
// regression for the EXPLICIT/INFERRED boundary-confusion bug diagnosed and fixed that session
// (buildSystemPrompt rule 1 + worked examples, m2-criteria-compiler.ts). Pre-FIX baseline: 33/110
// (30.0%) mislabeled across BIAS_PROBE_CASES x K=10 live runs, worst case onchain.tx_exists at
// 100%. Post-FIX: 1/110 (0.9%), only code-inferred/code.tests_pass short of 0% (9/10 correct).
//
// Unlike containsCanary/assignLocators above, this can't be a pure-function unit test - the bug
// lives in live model behavior, not in deterministic code. Live LLM calls are non-deterministic,
// cost real money, and need network + ANTHROPIC_API_KEY, so this suite stays opt-in
// (RUN_LIVE_M2_PROBE=1) rather than part of the default `npm test` run - same reasoning this
// project has already applied throughout D3-D5 (scripts/verify-*.ts live proofs kept separate
// from the fast, deterministic unit suite). Run explicitly via:
//   RUN_LIVE_M2_PROBE=1 npm test
// or standalone via `npx tsx scripts/probe-m2-bias.ts` for the full K=10 baseline-table report.
//
// K and the acceptance threshold both come from m2-bias-cases.ts, not a local default - see the
// comment there for why 0.8/K=5 was replaced with 0.6/K=10 (the original was a flaky gate, not
// a meaningful one; a proper confidence-bound gate would need K in the ~50s to be non-flaky at
// this threshold, too many live calls to be worth it - see that file's comment for the numbers).
const RUN_LIVE = process.env.RUN_LIVE_M2_PROBE === "1";
const LIVE_K = Number(process.env.PROBE_K ?? ACCEPTANCE_K);

for (const c of BIAS_PROBE_CASES) {
  test(
    `[live] M2 bias-probe pinned regression: ${c.name} (${c.groundTruth}, K=${LIVE_K}, threshold >=${ACCEPTANCE_MIN_CORRECT_RATE * 100}% correct)`,
    { skip: !RUN_LIVE && "set RUN_LIVE_M2_PROBE=1 to run (live model calls, costs money)" },
    async () => {
      const observations: string[] = [];
      for (let i = 0; i < LIVE_K; i++) {
        const canary = randomBytes(16).toString("hex");
        const criteria = await compileCriteria(c.spec, canary);
        for (const method of c.targetMethods) {
          const match = criteria.find((cr) => cr.method === method);
          observations.push(match ? match.source : "MISSING");
        }
      }
      const correct = observations.filter((o) => o === c.groundTruth).length;
      const rate = correct / observations.length;
      assert.ok(
        rate >= ACCEPTANCE_MIN_CORRECT_RATE,
        `${c.name}: only ${correct}/${observations.length} (${(rate * 100).toFixed(0)}%) correctly tagged ${c.groundTruth}, below the ${ACCEPTANCE_MIN_CORRECT_RATE * 100}% acceptance threshold. Observed: ${observations.join(", ")}`,
      );
    },
  );
}
