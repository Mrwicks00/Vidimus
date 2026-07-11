// Unit tests for the pure/offline parts of M3.C (docs/ROADMAP.md D5): output parsing/
// classification and the result-mapping decision functions, plus locator dispatch. No live
// Docker call - the real sandbox mechanism (compiles/tests through a real container, including
// the hostile-code cases) is proven live via scripts/verify-code-sandbox.ts, same split as
// m3-onchain.ts's checkers (live-proven, not unit-tested against a real chain) and m3-data.ts's
// sample_verify (chain-dependent path proven live, pure seed math unit-tested here-equivalent).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyCodeChecks,
  interpretCompileRun,
  interpretTestsRun,
  parseCompileCheckOutput,
  parseTestOutput,
  isMissingModuleDiagnostic,
  isExternalSpecifier,
  extractMissingModuleSpecifier,
  type CodeAsset,
  type CodeDeliverableSealed,
} from "./m3-code.js";
import { quarantineCodeDeliverable } from "../security/quarantine.js";
import type { SandboxRunResult } from "../security/sandbox.js";
import type { Criterion } from "../verdict/types.js";

let seq = 0;
function criterion(method: Criterion["method"], index: number): Criterion {
  seq += 1;
  return {
    id: `c${seq}`,
    text: "fixture criterion",
    source: "EXPLICIT",
    tier: 1,
    method,
    locator: method ? { method: method as "code.compiles" | "code.tests_pass", index } : undefined,
    result: "UNVERIFIABLE",
    confidence: null,
    evidence: { kind: "none", ref: "", detail: "compiled, not yet verified" },
  };
}

function asset(id: string, language: "js" | "ts", files: { path: string; content: string }[]): CodeAsset {
  return { id, language, files };
}

function runResult(overrides: Partial<SandboxRunResult>): SandboxRunResult {
  return { ok: true, exitCode: 0, oomKilled: false, timedOut: false, stdout: "", stderr: "", ...overrides };
}

// ---- parseCompileCheckOutput ----

test("parseCompileCheckOutput: parses a clean result", () => {
  const parsed = parseCompileCheckOutput('{"ok":true,"errors":[],"fileCount":2}');
  assert.deepEqual(parsed, { ok: true, errors: [], fileCount: 2 });
});

test("parseCompileCheckOutput: parses an error result with diagnostic codes", () => {
  const parsed = parseCompileCheckOutput('{"ok":false,"errors":[{"file":"a.ts","message":"boom","code":2307}],"fileCount":1}');
  assert.equal(parsed?.ok, false);
  assert.equal(parsed?.errors[0]?.code, 2307);
});

test("parseCompileCheckOutput: null on unparseable/garbage stdout", () => {
  assert.equal(parseCompileCheckOutput("not json"), null);
  assert.equal(parseCompileCheckOutput('{"foo":"bar"}'), null);
});

// ---- isMissingModuleDiagnostic ----

test("isMissingModuleDiagnostic: true only for TS2307", () => {
  assert.equal(isMissingModuleDiagnostic(2307), true);
  assert.equal(isMissingModuleDiagnostic(2322), false);
  assert.equal(isMissingModuleDiagnostic(undefined), false);
});

// ---- parseTestOutput ----

test("parseTestOutput: parses Node's --test TAP summary footer, all passing", () => {
  const stdout = `TAP version 13\nok 1 - does a thing\n1..1\n# tests 1\n# pass 1\n# fail 0\n`;
  const summary = parseTestOutput(stdout);
  assert.deepEqual(summary, { pass: 1, fail: 0, total: 1, firstFailure: undefined });
});

test("parseTestOutput: extracts first failing test name", () => {
  const stdout = `TAP version 13\nok 1 - a\nnot ok 2 - b breaks\n  ---\n  ...\n1..2\n# tests 2\n# pass 1\n# fail 1\n`;
  const summary = parseTestOutput(stdout);
  assert.equal(summary?.fail, 1);
  assert.equal(summary?.firstFailure, "b breaks");
});

test("parseTestOutput: null when no summary footer present (crash before completion)", () => {
  assert.equal(parseTestOutput("Error: something exploded\n"), null);
});

// ---- isExternalSpecifier / extractMissingModuleSpecifier ----

test("isExternalSpecifier: bare package names are external, relative/absolute paths are not", () => {
  assert.equal(isExternalSpecifier("left-pad"), true);
  assert.equal(isExternalSpecifier("@scope/pkg"), true);
  assert.equal(isExternalSpecifier("./helper.js"), false);
  assert.equal(isExternalSpecifier("../lib/util.js"), false);
  assert.equal(isExternalSpecifier("/workspace/x.js"), false);
});

test("extractMissingModuleSpecifier: pulls the specifier out of a MODULE_NOT_FOUND message", () => {
  const stderr = "node:internal/modules/cjs/loader:1234\nError: Cannot find module 'left-pad'\nRequire stack:\n";
  assert.equal(extractMissingModuleSpecifier(stderr), "left-pad");
});

test("extractMissingModuleSpecifier: null when no such message is present", () => {
  assert.equal(extractMissingModuleSpecifier("TypeError: x is not a function"), null);
});

// ---- interpretCompileRun (result-mapping table) ----

const jsAsset = asset("a1", "js", [{ path: "index.js", content: "1+1;" }]);
const tsAsset = asset("a1", "ts", [{ path: "index.ts", content: "const x: number = 1;" }]);

test("interpretCompileRun: sandbox unavailable -> UNVERIFIABLE, never FAIL", () => {
  const c = criterion("code.compiles", 0);
  const result = interpretCompileRun(c, jsAsset, runResult({ ok: false, blockedReason: "sandbox image not built" }));
  assert.equal(result.result, "UNVERIFIABLE");
  assert.match(result.evidence.detail, /sandbox image not built/);
});

test("interpretCompileRun: OOM-killed -> UNVERIFIABLE, never FAIL", () => {
  const c = criterion("code.compiles", 0);
  const result = interpretCompileRun(c, jsAsset, runResult({ oomKilled: true, stdout: "" }));
  assert.equal(result.result, "UNVERIFIABLE");
  assert.match(result.evidence.detail, /memory cap/);
});

test("interpretCompileRun: wall-clock timeout -> UNVERIFIABLE, never FAIL", () => {
  const c = criterion("code.compiles", 0);
  const result = interpretCompileRun(c, jsAsset, runResult({ timedOut: true, exitCode: null }));
  assert.equal(result.result, "UNVERIFIABLE");
  assert.match(result.evidence.detail, /wall-clock budget/);
});

test("interpretCompileRun: clean JS syntax -> PASS", () => {
  const c = criterion("code.compiles", 0);
  const result = interpretCompileRun(c, jsAsset, runResult({ stdout: '{"ok":true,"errors":[],"fileCount":1}' }));
  assert.equal(result.result, "PASS");
  assert.equal(result.confidence, 1.0);
});

test("interpretCompileRun: JS syntax error -> FAIL", () => {
  const c = criterion("code.compiles", 0);
  const stdout = '{"ok":false,"errors":[{"file":"index.js","message":"Unexpected token"}],"fileCount":1}';
  const result = interpretCompileRun(c, jsAsset, runResult({ stdout }));
  assert.equal(result.result, "FAIL");
  assert.match(result.evidence.detail, /Unexpected token/);
});

test("interpretCompileRun: TS real diagnostic (non-2307) -> FAIL", () => {
  const c = criterion("code.compiles", 0);
  const stdout = '{"ok":false,"errors":[{"file":"index.ts","message":"Type mismatch","code":2322}],"fileCount":1}';
  const result = interpretCompileRun(c, tsAsset, runResult({ stdout }));
  assert.equal(result.result, "FAIL");
});

test("interpretCompileRun: TS TS2307 missing-module diagnostic -> UNVERIFIABLE, never FAIL", () => {
  const c = criterion("code.compiles", 0);
  const stdout = JSON.stringify({
    ok: false,
    errors: [{ file: "index.ts", message: "Cannot find module 'left-pad'", code: 2307 }],
    fileCount: 1,
  });
  const result = interpretCompileRun(c, tsAsset, runResult({ stdout }));
  assert.equal(result.result, "UNVERIFIABLE");
  assert.match(result.evidence.detail, /does not install/);
});

test("interpretCompileRun: mix of a real error and a 2307 -> FAIL wins (real error present)", () => {
  const c = criterion("code.compiles", 0);
  const stdout = JSON.stringify({
    ok: false,
    errors: [
      { file: "b.ts", message: "Cannot find module 'left-pad'", code: 2307 },
      { file: "a.ts", message: "Type mismatch", code: 2322 },
    ],
    fileCount: 2,
  });
  const result = interpretCompileRun(c, tsAsset, runResult({ stdout }));
  assert.equal(result.result, "FAIL");
});

test("interpretCompileRun: unparseable runner output -> UNVERIFIABLE, never FAIL", () => {
  const c = criterion("code.compiles", 0);
  const result = interpretCompileRun(c, jsAsset, runResult({ stdout: "garbage", exitCode: 1 }));
  assert.equal(result.result, "UNVERIFIABLE");
});

// ---- interpretTestsRun (result-mapping table) ----

test("interpretTestsRun: OOM-killed -> UNVERIFIABLE, never FAIL", () => {
  const c = criterion("code.tests_pass", 0);
  const result = interpretTestsRun(c, jsAsset, runResult({ oomKilled: true }));
  assert.equal(result.result, "UNVERIFIABLE");
});

test("interpretTestsRun: wall-clock timeout (e.g. hostile infinite loop) -> UNVERIFIABLE, never FAIL", () => {
  const c = criterion("code.tests_pass", 0);
  const result = interpretTestsRun(c, jsAsset, runResult({ timedOut: true, exitCode: null }));
  assert.equal(result.result, "UNVERIFIABLE");
  assert.match(result.evidence.detail, /wall-clock budget/);
});

test("interpretTestsRun: all tests pass -> PASS", () => {
  const c = criterion("code.tests_pass", 0);
  const stdout = "# tests 3\n# pass 3\n# fail 0\n";
  const result = interpretTestsRun(c, jsAsset, runResult({ stdout }));
  assert.equal(result.result, "PASS");
});

test("interpretTestsRun: a real test failure -> FAIL", () => {
  const c = criterion("code.tests_pass", 0);
  const stdout = "not ok 1 - expected 2 got 3\n# tests 1\n# pass 0\n# fail 1\n";
  const result = interpretTestsRun(c, jsAsset, runResult({ stdout, exitCode: 1 }));
  assert.equal(result.result, "FAIL");
  assert.match(result.evidence.detail, /expected 2 got 3/);
});

test("interpretTestsRun: crash on an external missing module -> UNVERIFIABLE, never FAIL", () => {
  const c = criterion("code.tests_pass", 0);
  const stderr = "Error: Cannot find module 'left-pad'\n    at ...";
  const result = interpretTestsRun(c, jsAsset, runResult({ stdout: "", stderr, exitCode: 1 }));
  assert.equal(result.result, "UNVERIFIABLE");
  assert.match(result.evidence.detail, /does not install/);
});

test("interpretTestsRun: crash on a missing *relative* file (deliverer's own bug) -> FAIL", () => {
  const c = criterion("code.tests_pass", 0);
  const stderr = "Error: Cannot find module '../lib/util.js'\n    at ...";
  const result = interpretTestsRun(c, jsAsset, runResult({ stdout: "", stderr, exitCode: 1 }));
  assert.equal(result.result, "FAIL");
  assert.match(result.evidence.detail, /delivered code's own reference/);
});

test("interpretTestsRun: unrelated crash (e.g. broken test-file syntax) -> FAIL", () => {
  const c = criterion("code.tests_pass", 0);
  const stderr = "SyntaxError: Unexpected end of input";
  const result = interpretTestsRun(c, jsAsset, runResult({ stdout: "", stderr, exitCode: 1 }));
  assert.equal(result.result, "FAIL");
});

// ---- applyCodeChecks dispatch ----

test("applyCodeChecks: locator doesn't resolve (no claim submitted) -> UNVERIFIABLE, never FAIL", async () => {
  const c = criterion("code.compiles", 0);
  const [result] = await applyCodeChecks([c], { code: [] }, []);
  assert.equal(result!.result, "UNVERIFIABLE");
  assert.match(result!.evidence.detail, /locator did not resolve/);
});

test("applyCodeChecks: claim referencing an unquarantined/rejected code asset -> UNVERIFIABLE, never FAIL", async () => {
  const c = criterion("code.compiles", 0);
  const sealed: CodeDeliverableSealed = { code: [], "code.compiles": [{ codeId: "missing" }] };
  const [result] = await applyCodeChecks([c], sealed, []);
  assert.equal(result!.result, "UNVERIFIABLE");
  assert.match(result!.evidence.detail, /not delivered or was rejected/);
});

test("applyCodeChecks: quarantine-rejected claim resolves UNVERIFIABLE with the rejection reason, never reaches the checker", async () => {
  const c = criterion("code.compiles", 0);
  const rejection = { method: "code.compiles" as const, index: 0, reason: "quarantine rejected malformed/suspicious claim (code.compiles[0]): bad shape" };
  const [result] = await applyCodeChecks([c], { code: [] }, [rejection]);
  assert.equal(result!.result, "UNVERIFIABLE");
  assert.equal(result!.evidence.detail, rejection.reason);
});

test("applyCodeChecks: code.tests_pass with an undeclared test file -> UNVERIFIABLE, never FAIL", async () => {
  const c = criterion("code.tests_pass", 0);
  const sealed: CodeDeliverableSealed = {
    code: [jsAsset],
    "code.tests_pass": [{ codeId: "a1", testFiles: ["does-not-exist.test.js"] }],
  };
  const [result] = await applyCodeChecks([c], sealed, []);
  assert.equal(result!.result, "UNVERIFIABLE");
  assert.match(result!.evidence.detail, /not present in delivered code/);
});

test("onchain/data-locator criteria pass through applyCodeChecks untouched", async () => {
  const c = criterion("onchain.tx_exists", 0);
  const [result] = await applyCodeChecks([c], undefined, []);
  assert.deepEqual(result, c);
});

// ---- quarantine (path-traversal / shape safety) ----

test("quarantineCodeDeliverable: seals a well-formed JS asset", () => {
  const { sealed, rejected } = quarantineCodeDeliverable({
    code: [{ id: "a1", language: "js", files: [{ path: "index.js", content: "1+1;" }] }],
  });
  assert.equal(rejected.length, 0);
  assert.equal(sealed?.code.length, 1);
  assert.equal(sealed?.code[0]?.id, "a1");
});

test("quarantineCodeDeliverable: rejects a path-traversal file path, drops the whole asset", () => {
  const { sealed } = quarantineCodeDeliverable({
    code: [{ id: "a1", language: "js", files: [{ path: "../../etc/passwd", content: "evil" }] }],
  });
  assert.equal(sealed?.code.length, 0);
});

test("quarantineCodeDeliverable: rejects an absolute file path, drops the whole asset", () => {
  const { sealed } = quarantineCodeDeliverable({
    code: [{ id: "a1", language: "js", files: [{ path: "/etc/passwd", content: "evil" }] }],
  });
  assert.equal(sealed?.code.length, 0);
});

test("quarantineCodeDeliverable: rejects an oversized asset (total content cap)", () => {
  const big = "x".repeat(3_000_000);
  const { sealed } = quarantineCodeDeliverable({
    code: [{ id: "a1", language: "js", files: [{ path: "big.js", content: big }] }],
  });
  assert.equal(sealed?.code.length ?? 0, 0);
});

test("quarantineCodeDeliverable: rejects a code.tests_pass claim with a traversal test file path", () => {
  const { rejected } = quarantineCodeDeliverable({
    code: [{ id: "a1", language: "js", files: [{ path: "index.js", content: "1;" }] }],
    "code.tests_pass": [{ codeId: "a1", testFiles: ["../../secrets.js"] }],
  });
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0]?.method, "code.tests_pass");
});
