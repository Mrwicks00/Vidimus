// PROOF gate for D6.B (docs/ROADMAP.md). Bypasses M1 (HTTP/payment) and M2 (Opus criteria
// compilation) - same established convention as scripts/verify-code-sandbox.ts /
// verify-data-sample.ts for a "real mechanism, precise repeatable criteria" proof, and this
// session's explicit brief (no new Opus call; reuses the D6.A content fixture - CLAUDE_HISTORY.md
// Session 10). The criteria[] below is hand-reconstructed to exactly match what M2 actually
// compiled that session (4 EXPLICIT + 1 bonus INFERRED content.format at a second locator index
// with no matching claim) - not invented, a faithful replay of an already-proven compile.
//
// Runs the real Tier-1 checker dispatch, the real headline computation, a real M7 signature
// (onchainos wallet sign-message - no LLM involved), appends to the real calibration log, then
// runs the reproducibility spot-check against two of the logged Tier-1 criteria and verifies
// the log's hash chain.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { quarantineContentDeliverable } from "../src/security/quarantine.js";
import { applyContentChecks } from "../src/modules/m3-content.js";
import { computeHeadline } from "../src/modules/headline.js";
import { signVerdict } from "../src/verdict/sign.js";
import { canonicalize } from "../src/verdict/canonicalize.js";
import { appendCalibrationEntry, readCalibrationLog, verifyChainIntegrity } from "../src/calibration/log.js";
import { spotCheckCriterion } from "../src/calibration/spotcheck.js";
import { config } from "../src/config.js";
import type { Criterion, Verdict } from "../src/verdict/types.js";

const fixturePath = new URL("./fixtures/content-deliverable.json", import.meta.url);
const rawDeliverable = JSON.parse(readFileSync(fixturePath, "utf8")) as { content: unknown };

function criterion(id: string, method: Criterion["method"], index: number, source: Criterion["source"]): Criterion {
  return {
    id,
    text: "reconstructed from the D6.A live-proof compile (CLAUDE_HISTORY.md Session 10)",
    source,
    inference_note: source === "INFERRED" ? "M2 additionally inferred a second content.format check on this asset" : undefined,
    tier: 1,
    method,
    locator: method ? { method: method as "content.presence" | "content.format" | "content.bounds" | "content.pattern", index } : undefined,
    result: "UNVERIFIABLE",
    confidence: null,
    evidence: { kind: "none", ref: "", detail: "compiled, not yet verified" },
  };
}

async function main() {
  const criteria: Criterion[] = [
    criterion("c1", "content.presence", 0, "EXPLICIT"),
    criterion("c2", "content.bounds", 0, "EXPLICIT"),
    criterion("c3", "content.format", 0, "EXPLICIT"),
    criterion("c4", "content.pattern", 0, "EXPLICIT"),
    criterion("c5", "content.format", 1, "INFERRED"),
  ];

  const { sealed, rejected } = quarantineContentDeliverable(rawDeliverable.content);
  const checked = applyContentChecks(criteria, sealed, rejected);
  const { headline, headline_basis } = computeHeadline(checked);

  console.log("--- checker results ---");
  for (const c of checked) console.log(`  [${c.result}] ${c.id} ${c.method} - ${c.evidence.detail}`);
  console.log(`headline: ${headline}`);

  const deliverableHash = `sha256:${createHash("sha256").update(canonicalize(rawDeliverable), "utf8").digest("hex")}`;

  const verdictBody: Omit<Verdict, "signature"> = {
    vidimus_version: "1.0",
    job_id: `vd_calibration_proof_${Date.now()}`,
    subject: { spec_hash: "sha256:reused-from-d6a-fixture", deliverable_hash: deliverableHash, deliverable_kind: "content" },
    criteria: checked,
    headline,
    headline_basis,
    summary: "D6.B calibration-log PROOF gate: replay of the D6.A content live-proof criteria set.",
    ruleset_version: "0.0.0-d6b",
    ruleset_hash: `sha256:${"0".repeat(64)}`,
    issued_at: new Date().toISOString(),
    signer: { erc8004_id: config.erc8004Id, address: config.erc8004Address || config.payToAddress },
  };

  console.log("\nSigning with the real Agentic Wallet (onchainos, no LLM)...");
  const { signature, digest } = await signVerdict(verdictBody);
  const verdict: Verdict = { ...verdictBody, signature };
  console.log(`signature: ${signature}`);

  const entry = await appendCalibrationEntry(verdict, digest, config.calibrationLogPath);
  console.log(`\nAppended calibration log entry: seq=${entry.seq} job_id=${entry.job_id}`);

  const entries = await readCalibrationLog(config.calibrationLogPath);
  const integrity = verifyChainIntegrity(entries);
  console.log(`Log integrity (${entries.length} rows total): ${integrity.ok ? "OK" : `BROKEN - ${integrity.reason}`}`);

  console.log("\n--- reproducibility spot-check ---");
  let allMatch = true;
  for (const c of entry.criteria.filter((c) => c.tier === 1 && c.locator)) {
    const result = await spotCheckCriterion(c, rawDeliverable as any);
    allMatch = allMatch && result.matches;
    console.log(`  [${result.matches ? "MATCH" : "MISMATCH"}] ${c.id} (${c.method}): logged=${result.logged_result} recomputed=${result.recomputed_result}`);
  }

  console.log(`\nPROOF gate: ${integrity.ok && allMatch ? "PASS" : "FAIL"}`);
  process.exit(integrity.ok && allMatch ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
