// REPRODUCE harness for the M2 EXPLICIT/INFERRED tagging-bias slice (dedicated session between
// M3.C and D6, see CLAUDE_HISTORY.md). Calls the real compileCriteria() K times per pinned case,
// live against Opus, and tabulates the EXPLICIT/INFERRED tag actually returned for each case's
// target method(s) against a known ground truth. Not a unit test - a measurement tool. Once the
// bias is quantified and (if real) fixed, the surviving cases get pinned into
// m2-criteria-compiler.test.ts as regressions (LOCK phase) - this script is the instrument that
// produces the before/after numbers, not the permanent gate itself.
import { setDefaultResultOrder } from "node:dns";
// This sandbox's outbound IPv6 route to api.anthropic.com times out (confirmed via `curl -6`)
// while IPv4 works fine - undici's default happy-eyeballs-ish behavior was hanging on the v6
// attempt. Environment-local quirk (same family of issue as this project's prior web3.okx.com
// DNS flakiness, CLAUDE_HISTORY.md Sessions 1/5/7) - scoped to this script, not production code.
setDefaultResultOrder("ipv4first");

import { compileCriteria } from "../src/modules/m2-criteria-compiler.js";
import { BIAS_PROBE_CASES, type BiasProbeCase } from "../src/modules/m2-bias-cases.js";
import { randomBytes } from "node:crypto";
import type { Method, CriterionSource } from "../src/verdict/types.js";

const K = Number(process.env.PROBE_K ?? 10);
const CONCURRENCY = Number(process.env.PROBE_CONCURRENCY ?? 5);
// Optional scoping (D6.A): run only the named case(s) rather than the full pinned set, so
// re-confirming a single new family doesn't re-spend live calls on cases already locked by a
// prior session. Comma-separated case `name`s; unset runs everything (the full baseline table).
const CASE_FILTER = process.env.PROBE_CASE_NAMES?.split(",").map((s) => s.trim());

type ProbeCase = BiasProbeCase;

const CASES: ProbeCase[] = CASE_FILTER ? BIAS_PROBE_CASES.filter((c) => CASE_FILTER.includes(c.name)) : BIAS_PROBE_CASES;

interface RunObservation {
  method: Method;
  source: CriterionSource | "MISSING";
}

interface CaseResult {
  case: ProbeCase;
  runs: RunObservation[][]; // one array of observations per run
}

async function runOne(c: ProbeCase): Promise<RunObservation[]> {
  const canary = randomBytes(16).toString("hex");
  const criteria = await compileCriteria(c.spec, canary);
  return c.targetMethods.map((method) => {
    const matches = criteria.filter((cr) => cr.method === method);
    if (matches.length === 0) return { method, source: "MISSING" as const };
    // If the compiler split a target into >1 criterion of the same method, take the first -
    // record that this happened via a stderr note rather than silently averaging.
    if (matches.length > 1) {
      console.error(`  [note] case=${c.name} method=${method}: ${matches.length} criteria emitted, using first`);
    }
    return { method, source: matches[0].source };
  });
}

async function runCase(c: ProbeCase): Promise<CaseResult> {
  const runs: RunObservation[][] = [];
  for (let i = 0; i < K; i++) {
    const obs = await runOne(c);
    runs.push(obs);
    process.stderr.write(`.`);
  }
  return { case: c, runs };
}

async function withConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function main() {
  console.error(`Running ${CASES.length} cases x K=${K} = ${CASES.length * K} live compileCriteria calls (concurrency=${CONCURRENCY})...`);
  const results = await withConcurrency(CASES, CONCURRENCY, runCase);
  console.error("\n");

  console.log("\n=== BASELINE TABLE ===\n");
  console.log(
    "case".padEnd(18) + "method".padEnd(24) + "truth".padEnd(10) + "EXPLICIT".padEnd(10) + "INFERRED".padEnd(10) + "MISSING".padEnd(9) + "mislabel-rate",
  );
  let totalMislabels = 0;
  let totalObservations = 0;
  for (const { case: c, runs } of results) {
    for (const method of c.targetMethods) {
      const observations = runs.map((r) => r.find((o) => o.method === method)!.source);
      const explicitCount = observations.filter((s) => s === "EXPLICIT").length;
      const inferredCount = observations.filter((s) => s === "INFERRED").length;
      const missingCount = observations.filter((s) => s === "MISSING").length;
      const mislabels = observations.filter((s) => s !== c.groundTruth).length;
      totalMislabels += mislabels;
      totalObservations += observations.length;
      const rate = ((mislabels / observations.length) * 100).toFixed(0) + "%";
      console.log(
        c.name.padEnd(18) +
          method.padEnd(24) +
          c.groundTruth.padEnd(10) +
          String(explicitCount).padEnd(10) +
          String(inferredCount).padEnd(10) +
          String(missingCount).padEnd(9) +
          rate,
      );
    }
  }
  console.log(`\nOverall mislabel rate: ${totalMislabels}/${totalObservations} (${((totalMislabels / totalObservations) * 100).toFixed(1)}%)`);

  console.log("\n=== BY FAMILY ===\n");
  const families = ["onchain", "data", "code", "content"] as const;
  for (const fam of families) {
    let mis = 0;
    let total = 0;
    for (const { case: c, runs } of results) {
      if (c.family !== fam) continue;
      for (const method of c.targetMethods) {
        const observations = runs.map((r) => r.find((o) => o.method === method)!.source);
        mis += observations.filter((s) => s !== c.groundTruth).length;
        total += observations.length;
      }
    }
    console.log(`${fam.padEnd(10)} ${mis}/${total} (${((mis / total) * 100).toFixed(1)}%)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
