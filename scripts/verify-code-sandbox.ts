// Standalone live proof for M3.C (docs/ROADMAP.md D5), bypassing the HTTP route/payment/signing
// layers and M2's compile-time tagging - same rationale Session 7 used for
// scripts/verify-data-sample.ts: precise, repeatable cases beat depending on the LLM compiler
// happening to tag code.compiles/code.tests_pass on a given run. Exercises the real mechanism
// end to end through a real Docker container each time: quarantine (incl. path-traversal
// rejection) -> applyCodeChecks -> src/security/sandbox.ts's runSandboxed -> real docker run.
//
// Requires `npm run sandbox:build` to have been run first.
import { quarantineCodeDeliverable } from "../src/security/quarantine.js";
import { applyCodeChecks } from "../src/modules/m3-code.js";
import type { Criterion } from "../src/verdict/types.js";

let seq = 0;
function criterion(method: "code.compiles" | "code.tests_pass", index: number, text: string): Criterion {
  seq += 1;
  return {
    id: `c${seq}`,
    text,
    source: "EXPLICIT",
    tier: 1,
    method,
    locator: { method, index },
    result: "UNVERIFIABLE",
    confidence: null,
    evidence: { kind: "none", ref: "", detail: "compiled, not yet verified" },
  };
}

async function runCase(label: string, raw: unknown, criteria: Criterion[]) {
  console.log(`\n=== ${label} ===`);
  const { sealed, rejected } = quarantineCodeDeliverable(raw);
  if (rejected.length > 0) console.log("quarantine rejections:", rejected);
  const started = Date.now();
  const results = await applyCodeChecks(criteria, sealed, rejected);
  console.log(`(${Date.now() - started}ms)`);
  for (const r of results) {
    console.log(`  [${r.result}] ${r.text}`);
    console.log(`    evidence: ${r.evidence.kind} | ${r.evidence.detail}`);
  }
  return results;
}

async function main() {
  const outcomes: { label: string; expected: string; got: string }[] = [];

  // Case A: clean JS, compiles + tests pass.
  {
    const c1 = criterion("code.compiles", 0, "The delivered JS compiles.");
    const c2 = criterion("code.tests_pass", 0, "The delivered JS's own tests pass.");
    const results = await runCase(
      "A: clean JS - expect PASS / PASS",
      {
        code: [
          {
            id: "clean",
            language: "js",
            files: [
              { path: "math.js", content: "function add(a, b) { return a + b; }\nmodule.exports = { add };\n" },
              {
                path: "math.test.js",
                content:
                  "const test = require('node:test');\nconst assert = require('node:assert');\nconst { add } = require('./math.js');\ntest('adds', () => { assert.equal(add(2, 3), 5); });\n",
              },
            ],
          },
        ],
        "code.compiles": [{ codeId: "clean" }],
        "code.tests_pass": [{ codeId: "clean", testFiles: ["math.test.js"] }],
      },
      [c1, c2],
    );
    outcomes.push({ label: "A.compiles", expected: "PASS", got: results[0]!.result });
    outcomes.push({ label: "A.tests", expected: "PASS", got: results[1]!.result });
  }

  // Case B: syntax error -> FAIL on code.compiles.
  {
    const c1 = criterion("code.compiles", 0, "The delivered JS compiles.");
    const results = await runCase(
      "B: syntax error - expect FAIL",
      {
        code: [{ id: "broken", language: "js", files: [{ path: "broken.js", content: "function( {\n" }] }],
        "code.compiles": [{ codeId: "broken" }],
      },
      [c1],
    );
    outcomes.push({ label: "B.compiles", expected: "FAIL", got: results[0]!.result });
  }

  // Case C: hostile - a test tries a network read under --network none, asserts on it, fails.
  {
    const c1 = criterion("code.tests_pass", 0, "The delivered JS's tests pass (attempts network egress).");
    const results = await runCase(
      "C: hostile network-egress attempt - expect FAIL (network genuinely blocked)",
      {
        code: [
          {
            id: "net-attempt",
            language: "js",
            files: [
              {
                path: "net.test.js",
                content: `const test = require('node:test');
const assert = require('node:assert');
test('tries to reach the outside world', () => {
  return new Promise((resolve, reject) => {
    const req = require('http').get('http://example.com', () => {
      reject(new Error('network egress unexpectedly succeeded'));
    });
    req.on('error', () => {
      // Network is blocked as expected - fail the assertion deliberately so this case
      // demonstrates a real FAIL (not a hang/timeout) while proving --network none held.
      try { assert.fail('network egress was blocked, as expected under --network none'); }
      catch (e) { reject(e); }
    });
    setTimeout(() => reject(new Error('neither success nor error fired in time')), 5000);
  });
});
`,
              },
            ],
          },
        ],
        "code.tests_pass": [{ codeId: "net-attempt", testFiles: ["net.test.js"] }],
      },
      [c1],
    );
    outcomes.push({ label: "C.tests", expected: "FAIL", got: results[0]!.result });
  }

  // Case D: hostile - a test spins forever, blows the wall-clock budget.
  {
    const c1 = criterion("code.tests_pass", 0, "The delivered JS's tests pass (spins forever).");
    const results = await runCase(
      "D: hostile infinite loop - expect UNVERIFIABLE (wall-clock kill)",
      {
        code: [
          {
            id: "spin",
            language: "js",
            files: [{ path: "spin.test.js", content: "const test = require('node:test');\ntest('spins', () => { while (true) {} });\n" }],
          },
        ],
        "code.tests_pass": [{ codeId: "spin", testFiles: ["spin.test.js"] }],
      },
      [c1],
    );
    outcomes.push({ label: "D.tests", expected: "UNVERIFIABLE", got: results[0]!.result });
  }

  // Case E: external dependency, out of v1 scope - both the compile-time (TS2307) and run-time
  // (MODULE_NOT_FOUND) missing-module branches, on one TS asset.
  {
    const c1 = criterion("code.compiles", 0, "The delivered TS compiles.");
    const c2 = criterion("code.tests_pass", 0, "The delivered TS's tests pass.");
    const results = await runCase(
      "E: external dependency (left-pad) - expect UNVERIFIABLE / UNVERIFIABLE",
      {
        code: [
          {
            id: "needs-dep",
            language: "ts",
            files: [
              { path: "pad.ts", content: "import leftPad from 'left-pad';\nexport function pad(s: string) { return leftPad(s, 4); }\n" },
              {
                path: "pad.test.ts",
                content:
                  "import test from 'node:test';\nimport assert from 'node:assert';\nimport { pad } from './pad.js';\ntest('pads', () => { assert.equal(pad('1'), '0001'); });\n",
              },
            ],
          },
        ],
        "code.compiles": [{ codeId: "needs-dep" }],
        "code.tests_pass": [{ codeId: "needs-dep", testFiles: ["pad.test.ts"] }],
      },
      [c1, c2],
    );
    outcomes.push({ label: "E.compiles", expected: "UNVERIFIABLE", got: results[0]!.result });
    outcomes.push({ label: "E.tests", expected: "UNVERIFIABLE", got: results[1]!.result });
  }

  console.log("\n=== SUMMARY ===");
  let allMatch = true;
  for (const o of outcomes) {
    const ok = o.expected === o.got;
    if (!ok) allMatch = false;
    console.log(`${ok ? "OK  " : "MISMATCH"} ${o.label}: expected ${o.expected}, got ${o.got}`);
  }
  if (!allMatch) {
    console.error("\nOne or more cases did not match the expected result mapping.");
    process.exit(1);
  }
  console.log("\nAll cases matched the locked result-mapping table.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
