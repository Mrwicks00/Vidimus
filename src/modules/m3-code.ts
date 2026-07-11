// M3.C code sandbox checker. docs/VERIFICATION_MODULES.md M3.C, scope locked to this session's
// brief (docs/ROADMAP.md D5, M3.C - the last piece closing D5): `code.compiles`,
// `code.tests_pass`. Delivered code never executes on this process or its host filesystem
// outside a disposable container (src/security/sandbox.ts owns that boundary) - this module only
// decides *what* command to run for a given claim and how to interpret the sandbox's *output*
// (exit code + captured logs), never the raw delivered source itself as anything but bytes to
// hand to the sandbox.
//
// Same claim-addressing grammar as M3.A/M3.B (docs/VERDICT_SPEC.md §2.2): a criterion's
// `locator` points at `deliverable.code[method][index]`. This module only resolves locators
// whose `method` is a CodeMethod - onchain/data locators pass through untouched (m3-onchain.ts /
// m3-data.ts handle those), so all three checkers compose over the same criteria[] array
// without stepping on each other (see src/routes/verify.ts).
import { isCodeMethod, type Criterion, type Evidence } from "../verdict/types.js";
import { runSandboxed, type SandboxRunResult } from "../security/sandbox.js";
import type { QuarantineRejection } from "../security/quarantine.js";

function evidence(kind: Evidence["kind"], ref: string, detail: string): Evidence {
  return { kind, ref, detail: detail.slice(0, 500) };
}

function withResult(c: Criterion, result: Criterion["result"], ev: Evidence): Criterion {
  return { ...c, result, confidence: result === "UNVERIFIABLE" ? null : 1.0, evidence: ev };
}

function unverifiable(c: Criterion, detail: string): Criterion {
  return withResult(c, "UNVERIFIABLE", evidence("none", "", detail));
}

// ---- delivered code + claim shapes (deliverable-provided, inert data - never instructions) ----

export interface CodeAsset {
  id: string;
  language: "js" | "ts";
  files: { path: string; content: string }[]; // relative paths, validated at quarantine
}

// v1: checks every delivered file in the asset - no per-file targeting yet (matches the whole-
// dataset granularity of data.schema/data.rowcount).
export interface CodeCompilesClaim {
  codeId: string;
}

export interface CodeTestsPassClaim {
  codeId: string;
  testFiles: string[]; // relative paths, must be among the asset's own delivered files
}

export interface CodeDeliverable {
  code?: CodeAsset[];
  "code.compiles"?: CodeCompilesClaim[];
  "code.tests_pass"?: CodeTestsPassClaim[];
}

export interface CodeDeliverableSealed {
  code: CodeAsset[];
  "code.compiles"?: CodeCompilesClaim[];
  "code.tests_pass"?: CodeTestsPassClaim[];
}

function findCodeAsset(assets: CodeAsset[], id: string): CodeAsset | undefined {
  return assets.find((a) => a.id === id);
}

// ---- pure output parsing/classification (unit-testable independent of any live Docker call -
// same rationale as m3-data.ts's deriveSampleIndices / m2-criteria-compiler.ts's containsCanary)

const CHECK_JS_PATH = "/opt/vidimus/check-js.js";
const CHECK_TS_PATH = "/opt/vidimus/check-ts.js";

export interface CompileCheckOutput {
  ok: boolean;
  errors: { file: string; message: string; code?: number }[];
  fileCount: number;
}

/**
 * Parses the structured JSON our own baked-in check-js.js/check-ts.js runner scripts print -
 * never the delivered code's own output (that's parseTestOutput below). Null if the sandbox
 * didn't produce parseable JSON (the runner script itself crashed before printing).
 */
export function parseCompileCheckOutput(stdout: string): CompileCheckOutput | null {
  try {
    const parsed = JSON.parse(stdout.trim()) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as Record<string, unknown>).ok !== "boolean" ||
      !Array.isArray((parsed as Record<string, unknown>).errors)
    ) {
      return null;
    }
    return parsed as CompileCheckOutput;
  } catch {
    return null;
  }
}

/**
 * TS diagnostic code 2307 = "Cannot find module '<x>' or its corresponding type declarations." -
 * the one compile-time signal that specifically means "needs a dependency we don't install" (v1
 * scope decision: SECURITY.md's hard no-network-at-run-time requirement means no npm install is
 * possible inside the sandbox, so this resolves UNVERIFIABLE, not FAIL - see
 * VERIFICATION_MODULES.md M3.C's dated deviation note). Any other diagnostic code is a real
 * compile error.
 */
export function isMissingModuleDiagnostic(errorCode: number | undefined): boolean {
  return errorCode === 2307;
}

export interface TestSummary {
  pass: number;
  fail: number;
  total: number;
  firstFailure?: string;
}

/**
 * Node's built-in `--test` runner prints a TAP summary footer ("# pass N", "# fail N",
 * "# tests N") when run non-interactively - mechanical, narrow parse of a format Node itself
 * controls (not attacker-controlled), same non-instructable-extractor posture as the CSV parser
 * in quarantine.ts. Null if no summary footer is found (the process crashed before the test
 * runner could finish - see extractMissingModuleSpecifier below for that case).
 */
export function parseTestOutput(output: string): TestSummary | null {
  const passMatch = output.match(/^# pass (\d+)$/m);
  const failMatch = output.match(/^# fail (\d+)$/m);
  if (!passMatch || !failMatch) return null;
  const totalMatch = output.match(/^# tests (\d+)$/m);
  const pass = Number.parseInt(passMatch[1]!, 10);
  const fail = Number.parseInt(failMatch[1]!, 10);
  const total = totalMatch ? Number.parseInt(totalMatch[1]!, 10) : pass + fail;
  const firstFailureMatch = output.match(/^not ok \d+ - (.+)$/m);
  return { pass, fail, total, firstFailure: firstFailureMatch?.[1] };
}

/**
 * A specifier is "external" (needs npm install, out of v1 scope -> UNVERIFIABLE) unless it's a
 * relative/absolute path into the delivered code's own tree, in which case a missing target is
 * the deliverer's own bug - a real FAIL, not a sandbox limitation.
 */
export function isExternalSpecifier(specifier: string): boolean {
  return !specifier.startsWith(".") && !specifier.startsWith("/");
}

/**
 * Node's uncaught MODULE_NOT_FOUND crash before any test could run prints
 * "Cannot find module 'x'" to stderr. Distinguished from a genuine test *failure* by only being
 * consulted when parseTestOutput found no summary footer at all (a real failure still produces a
 * clean summary; a crash before the runner even starts does not).
 */
export function extractMissingModuleSpecifier(output: string): string | null {
  const match = output.match(/Cannot find module '([^']+)'/);
  return match ? match[1]! : null;
}

// ---- code.compiles ----

async function checkCompiles(c: Criterion, claim: CodeCompilesClaim, assets: CodeAsset[]): Promise<Criterion> {
  const asset = findCodeAsset(assets, claim.codeId);
  if (!asset) {
    return unverifiable(c, `code.compiles: referenced code "${claim.codeId}" was not delivered or was rejected at quarantine`);
  }
  const script = asset.language === "ts" ? CHECK_TS_PATH : CHECK_JS_PATH;
  const run = await runSandboxed(asset.files, ["node", script, "/workspace"]);
  return interpretCompileRun(c, asset, run);
}

export function interpretCompileRun(c: Criterion, asset: CodeAsset, run: SandboxRunResult): Criterion {
  if (!run.ok) {
    return unverifiable(c, run.blockedReason ?? "code.compiles: sandbox could not run");
  }
  if (run.oomKilled) {
    return unverifiable(c, "code.compiles: sandbox hit its memory cap - blocked, not evidence the code is wrong");
  }
  if (run.timedOut) {
    return unverifiable(c, "code.compiles: sandbox hit its wall-clock budget - blocked, not evidence the code is wrong");
  }
  const parsed = parseCompileCheckOutput(run.stdout);
  if (!parsed) {
    return unverifiable(
      c,
      `code.compiles: sandbox runner produced no parseable result (exit ${run.exitCode}) - ${run.stderr.slice(0, 300) || "no stderr"}`,
    );
  }
  if (parsed.ok) {
    return withResult(
      c,
      "PASS",
      evidence("test_output", `code:${asset.id}:compiles`, `all ${parsed.fileCount} ${asset.language} file(s) compiled cleanly`),
    );
  }
  // TS only: a missing-module diagnostic (TS2307) never fires for JS, since check-js.js's
  // vm.Script check is pure syntax - it never resolves requires at all.
  const missingModuleErrors = asset.language === "ts" ? parsed.errors.filter((e) => isMissingModuleDiagnostic(e.code)) : [];
  const realErrors = parsed.errors.filter((e) => !(asset.language === "ts" && isMissingModuleDiagnostic(e.code)));
  if (realErrors.length === 0 && missingModuleErrors.length > 0) {
    return unverifiable(
      c,
      `code.compiles: ${missingModuleErrors.length} file(s) reference a module our v1 sandbox does not install (no network at run time) - not evidence the code is wrong: ${missingModuleErrors[0]!.file}: ${missingModuleErrors[0]!.message}`,
    );
  }
  return withResult(
    c,
    "FAIL",
    evidence(
      "test_output",
      `code:${asset.id}:compiles`,
      `${realErrors.length}/${parsed.fileCount} file(s) failed to compile - first: ${realErrors[0]!.file}: ${realErrors[0]!.message}`,
    ),
  );
}

// ---- code.tests_pass ----

async function checkTestsPass(c: Criterion, claim: CodeTestsPassClaim, assets: CodeAsset[]): Promise<Criterion> {
  const asset = findCodeAsset(assets, claim.codeId);
  if (!asset) {
    return unverifiable(c, `code.tests_pass: referenced code "${claim.codeId}" was not delivered or was rejected at quarantine`);
  }
  const missingFiles = claim.testFiles.filter((f) => !asset.files.some((af) => af.path === f));
  if (missingFiles.length > 0) {
    return unverifiable(c, `code.tests_pass: declared test file(s) not present in delivered code: ${missingFiles.join(", ")}`);
  }
  const workspacePaths = claim.testFiles.map((f) => `/workspace/${f}`);
  const argv = asset.language === "ts" ? ["tsx", "--test", ...workspacePaths] : ["node", "--test", ...workspacePaths];
  const run = await runSandboxed(asset.files, argv);
  return interpretTestsRun(c, asset, run);
}

export function interpretTestsRun(c: Criterion, asset: CodeAsset, run: SandboxRunResult): Criterion {
  if (!run.ok) {
    return unverifiable(c, run.blockedReason ?? "code.tests_pass: sandbox could not run");
  }
  if (run.oomKilled) {
    return unverifiable(c, "code.tests_pass: sandbox hit its memory cap - blocked, not evidence the tests failed");
  }
  if (run.timedOut) {
    return unverifiable(c, "code.tests_pass: sandbox hit its wall-clock budget - blocked, not evidence the tests failed");
  }
  const combined = `${run.stderr}\n${run.stdout}`;
  // Checked before trusting any parsed summary: live-verified (Session 8) that Node's own test
  // runner doesn't always hard-crash on an unresolvable `require`/`import` - it can wrap a
  // MODULE_NOT_FOUND load failure into a single failing TAP pseudo-test instead, which would
  // otherwise look identical to a genuine test failure to parseTestOutput below. Checking the
  // missing-module signature first, regardless of whether a summary parsed, catches both shapes.
  const missingSpecifier = extractMissingModuleSpecifier(combined);
  if (missingSpecifier && isExternalSpecifier(missingSpecifier)) {
    return unverifiable(
      c,
      `code.tests_pass: tests require module "${missingSpecifier}" our v1 sandbox does not install (no network at run time) - not evidence the tests fail`,
    );
  }

  const summary = parseTestOutput(run.stdout);
  if (summary) {
    if (summary.fail === 0) {
      return withResult(c, "PASS", evidence("test_output", `code:${asset.id}:tests`, `${summary.pass}/${summary.total} test(s) passed`));
    }
    return withResult(
      c,
      "FAIL",
      evidence(
        "test_output",
        `code:${asset.id}:tests`,
        `${summary.fail}/${summary.total} test(s) failed${summary.firstFailure ? ` - first: ${summary.firstFailure}` : ""}`,
      ),
    );
  }
  // No parseable summary and no missing-module signature - the process crashed some other way
  // before the test runner could finish (e.g. a syntax error in the test file itself). A real
  // signal, not a sandbox limitation.
  return withResult(
    c,
    "FAIL",
    evidence(
      "test_output",
      `code:${asset.id}:tests`,
      `test run crashed before completing (exit ${run.exitCode})${missingSpecifier ? ` - missing "${missingSpecifier}" (delivered code's own reference)` : ""}: ${combined.trim().slice(0, 300)}`,
    ),
  );
}

// ---- dispatch ----

// D5 M3.C: dispatches every criterion whose locator addresses a CodeMethod - onchain/data
// locators pass through untouched (m3-onchain.ts / m3-data.ts handle those in the same
// pipeline, see src/routes/verify.ts).
export async function applyCodeChecks(
  criteria: Criterion[],
  sealed: CodeDeliverableSealed | undefined,
  rejections: QuarantineRejection[],
): Promise<Criterion[]> {
  const rejectionByKey = new Map(rejections.map((r) => [`${r.method}[${r.index}]`, r]));
  const assets = sealed?.code ?? [];

  return Promise.all(
    criteria.map(async (c) => {
      const locator = c.locator;
      if (!locator || !isCodeMethod(locator.method)) return c;
      const method = locator.method;
      const index = locator.index;
      const rejection = rejectionByKey.get(`${method}[${index}]`);
      if (rejection) {
        return unverifiable(c, rejection.reason);
      }
      const claim = sealed?.[method]?.[index];
      if (!claim) {
        return unverifiable(c, `locator did not resolve: no ${method} claim submitted at ${method}[${index}]`);
      }
      switch (method) {
        case "code.compiles":
          return checkCompiles(c, claim as CodeCompilesClaim, assets);
        case "code.tests_pass":
          return checkTestsPass(c, claim as CodeTestsPassClaim, assets);
      }
    }),
  );
}
