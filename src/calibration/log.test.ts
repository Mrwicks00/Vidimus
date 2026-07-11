// Unit tests for the D6.B calibration log (docs/ROADMAP.md D6.B). All pure/offline, no live
// calls - temp JSONL files under os.tmpdir(), one unique path per test (log.ts caches append
// state per path, so unique paths avoid cross-test bleed).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendCalibrationEntry, readCalibrationLog, verifyChainIntegrity } from "./log.js";
import type { Criterion, Verdict, VerdictResult } from "../verdict/types.js";

let seq = 0;
function criterion(result: VerdictResult, opts: Partial<Criterion> = {}): Criterion {
  seq += 1;
  return {
    id: `c${seq}`,
    text: "fixture criterion",
    source: "EXPLICIT",
    tier: 1,
    method: "content.bounds",
    locator: { method: "content.bounds", index: 0 },
    result,
    confidence: result === "UNVERIFIABLE" ? null : 1.0,
    evidence: { kind: result === "UNVERIFIABLE" ? "none" : "extract", ref: "content:asset", detail: "fixture" },
    ...opts,
  };
}

function verdict(headline: VerdictResult, criteria: Criterion[], opts: Partial<Verdict> = {}): Verdict {
  return {
    vidimus_version: "1.0",
    job_id: `vd_fixture_${seq}`,
    payment_id: "0xpayment",
    subject: { spec_hash: "sha256:spec", deliverable_hash: "sha256:deliverable", deliverable_kind: "content" },
    criteria,
    headline,
    headline_basis: criteria.map((c) => c.id),
    summary: "fixture summary",
    ruleset_version: "0.0.0-test",
    ruleset_hash: "sha256:ruleset",
    issued_at: new Date().toISOString(),
    signer: { erc8004_id: "4933", address: "0xSigner" },
    signature: "0xsignature",
    ...opts,
  };
}

async function tempLogPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vidimus-calibration-"));
  return join(dir, "calibration-log.jsonl");
}

test("appends an entry with the correct derived shape (no evidence.ref/detail leaked)", async () => {
  const logPath = await tempLogPath();
  const c = criterion("PASS");
  const v = verdict("PASS", [c]);
  const entry = await appendCalibrationEntry(v, "0xdigest", logPath);

  assert.equal(entry.seq, 0);
  assert.equal(entry.prev_hash, null);
  assert.equal(entry.job_id, v.job_id);
  assert.equal(entry.payment_id, v.payment_id);
  assert.equal(entry.verdict_signature, v.signature);
  assert.equal(entry.verdict_digest, "0xdigest");
  assert.equal(entry.headline, "PASS");
  assert.deepEqual(entry.signer, v.signer);
  assert.equal(entry.criteria.length, 1);
  assert.deepEqual(entry.criteria[0], {
    id: c.id,
    method: c.method,
    tier: c.tier,
    confidence: c.confidence,
    result: "PASS",
    evidence_kind: "extract",
    locator: c.locator,
  });
  // evidence.ref/detail must never appear anywhere in the logged row (design gate: kind-only).
  // deepEqual above already proves criteria[0]'s exact key set has no evidence sub-object; this
  // is a belt-and-suspenders scan for the specific ref value the fixture's evidence carried.
  const serialized = JSON.stringify(entry);
  assert.ok(!serialized.includes("content:asset"), "evidence.ref leaked into the log entry");

  await rm(join(logPath, ".."), { recursive: true, force: true });
});

test("logs the correct headline across PASS / FAIL / PARTIAL / UNVERIFIABLE", async () => {
  const logPath = await tempLogPath();
  const headlines: VerdictResult[] = ["PASS", "FAIL", "PARTIAL", "UNVERIFIABLE"];
  for (const headline of headlines) {
    const c = criterion(headline === "UNVERIFIABLE" ? "UNVERIFIABLE" : headline === "FAIL" ? "FAIL" : "PASS");
    await appendCalibrationEntry(verdict(headline, [c]), "0xdigest", logPath);
  }
  const entries = await readCalibrationLog(logPath);
  assert.deepEqual(
    entries.map((e) => e.headline),
    headlines,
  );
  assert.equal(verifyChainIntegrity(entries).ok, true);

  await rm(join(logPath, ".."), { recursive: true, force: true });
});

test("distinguishes UNVERIFIABLE (evidence.kind=none) from FAIL (evidence.kind set) per criterion", async () => {
  const logPath = await tempLogPath();
  const failC = criterion("FAIL", { id: "cfail" });
  const unverifiableC = criterion("UNVERIFIABLE", { id: "cunverifiable" });
  const entry = await appendCalibrationEntry(verdict("PARTIAL", [failC, unverifiableC]), "0xdigest", logPath);

  const fail = entry.criteria.find((c) => c.id === "cfail")!;
  const unverifiable = entry.criteria.find((c) => c.id === "cunverifiable")!;
  assert.equal(fail.result, "FAIL");
  assert.notEqual(fail.evidence_kind, "none");
  assert.equal(unverifiable.result, "UNVERIFIABLE");
  assert.equal(unverifiable.evidence_kind, "none");

  await rm(join(logPath, ".."), { recursive: true, force: true });
});

test("hash chain holds across multiple sequential appends", async () => {
  const logPath = await tempLogPath();
  for (let i = 0; i < 5; i++) {
    await appendCalibrationEntry(verdict("PASS", [criterion("PASS")]), "0xdigest", logPath);
  }
  const entries = await readCalibrationLog(logPath);
  assert.equal(entries.length, 5);
  assert.deepEqual(
    entries.map((e) => e.seq),
    [0, 1, 2, 3, 4],
  );
  for (let i = 1; i < entries.length; i++) {
    assert.equal(entries[i]!.prev_hash, entries[i - 1]!.entry_hash);
  }
  assert.equal(verifyChainIntegrity(entries).ok, true);

  await rm(join(logPath, ".."), { recursive: true, force: true });
});

test("hash chain survives a cold read (new process reading an existing file) and continues correctly", async () => {
  const logPath = await tempLogPath();
  await appendCalibrationEntry(verdict("PASS", [criterion("PASS")]), "0xdigest", logPath);
  await appendCalibrationEntry(verdict("PASS", [criterion("PASS")]), "0xdigest", logPath);

  const fromDisk = await readCalibrationLog(logPath);
  assert.equal(fromDisk.length, 2);
  assert.equal(verifyChainIntegrity(fromDisk).ok, true);

  await rm(join(logPath, ".."), { recursive: true, force: true });
});

test("concurrent appends to the same log still produce a valid, non-racing chain", async () => {
  const logPath = await tempLogPath();
  await Promise.all(
    Array.from({ length: 10 }, () => appendCalibrationEntry(verdict("PASS", [criterion("PASS")]), "0xdigest", logPath)),
  );
  const entries = await readCalibrationLog(logPath);
  assert.equal(entries.length, 10);
  assert.deepEqual(
    entries.map((e) => e.seq),
    Array.from({ length: 10 }, (_, i) => i),
  );
  assert.equal(verifyChainIntegrity(entries).ok, true);

  await rm(join(logPath, ".."), { recursive: true, force: true });
});

test("tamper detection: mutating a logged field breaks the chain from that row onward", async () => {
  const logPath = await tempLogPath();
  for (let i = 0; i < 3; i++) {
    await appendCalibrationEntry(verdict("PASS", [criterion("PASS")]), "0xdigest", logPath);
  }
  const entries = await readCalibrationLog(logPath);
  entries[1]!.headline = "FAIL"; // tamper with row 1's content, entry_hash left stale

  const result = verifyChainIntegrity(entries);
  assert.equal(result.ok, false);
  assert.equal(result.brokenAtSeq, 1);
  assert.match(result.reason ?? "", /entry_hash mismatch/);

  await rm(join(logPath, ".."), { recursive: true, force: true });
});

test("tamper detection: deleting a row breaks every subsequent prev_hash link", async () => {
  const logPath = await tempLogPath();
  for (let i = 0; i < 3; i++) {
    await appendCalibrationEntry(verdict("PASS", [criterion("PASS")]), "0xdigest", logPath);
  }
  const entries = await readCalibrationLog(logPath);
  entries.splice(1, 1); // silently remove row 1

  const result = verifyChainIntegrity(entries);
  assert.equal(result.ok, false);
  // row that was seq=2 is now at array index 1, so seq mismatch is caught first.
  assert.equal(result.brokenAtSeq, 2);

  await rm(join(logPath, ".."), { recursive: true, force: true });
});

test("tamper detection: reordering two rows breaks the chain", async () => {
  const logPath = await tempLogPath();
  for (let i = 0; i < 3; i++) {
    await appendCalibrationEntry(verdict("PASS", [criterion("PASS")]), "0xdigest", logPath);
  }
  const entries = await readCalibrationLog(logPath);
  [entries[1], entries[2]] = [entries[2]!, entries[1]!];

  const result = verifyChainIntegrity(entries);
  assert.equal(result.ok, false);

  await rm(join(logPath, ".."), { recursive: true, force: true });
});
