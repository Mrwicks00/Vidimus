// Reproducibility spot-check CLI (docs/ROADMAP.md D6.B). Given the calibration log and the
// original raw deliverable JSON for one logged job, re-runs every Tier-1 criterion in that job
// through the real production checker dispatch (src/calibration/spotcheck.ts) and reports
// whether each recomputed result matches what was logged. This is the auditable "an independent
// party can re-run our checkers and get the same result" proof - never touches M2/Opus or the
// payment layer.
//
// Usage: npm run spot-check-calibration -- <job_id> <deliverable.json> [log-path]
import { readFileSync } from "node:fs";
import { readCalibrationLog, verifyChainIntegrity } from "../src/calibration/log.js";
import { spotCheckCriterion, type RawDeliverable } from "../src/calibration/spotcheck.js";
import { config } from "../src/config.js";

async function main() {
  const jobId = process.argv[2];
  const deliverablePath = process.argv[3];
  const logPath = process.argv[4] ?? config.calibrationLogPath;
  if (!jobId || !deliverablePath) {
    console.error("Usage: npm run spot-check-calibration -- <job_id> <deliverable.json> [log-path]");
    process.exit(1);
  }

  const entries = await readCalibrationLog(logPath);
  const integrity = verifyChainIntegrity(entries);
  console.log(`Log integrity (${entries.length} rows): ${integrity.ok ? "OK" : `BROKEN at seq ${integrity.brokenAtSeq} - ${integrity.reason}`}`);
  if (!integrity.ok) process.exit(1);

  const entry = entries.find((e) => e.job_id === jobId);
  if (!entry) {
    console.error(`No logged entry found for job_id=${jobId} in ${logPath}`);
    process.exit(1);
  }

  const rawDeliverable = JSON.parse(readFileSync(deliverablePath, "utf8")) as RawDeliverable;

  console.log(`\nJob ${entry.job_id} - logged headline: ${entry.headline}, ${entry.criteria.length} criteria`);
  let allMatch = true;
  let checked = 0;
  for (const c of entry.criteria) {
    const result = await spotCheckCriterion(c, rawDeliverable);
    if (result.skipped_reason) {
      console.log(`  [SKIP] ${c.id} (${c.method}) - ${result.skipped_reason}`);
      continue;
    }
    checked += 1;
    allMatch = allMatch && result.matches;
    console.log(`  [${result.matches ? "MATCH" : "MISMATCH"}] ${c.id} (${c.method}): logged=${result.logged_result} recomputed=${result.recomputed_result}`);
  }

  console.log(`\n${checked} Tier-1 criteria re-verified, ${allMatch ? "all identical to the logged result" : "AT LEAST ONE MISMATCH"}.`);
  process.exit(allMatch ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
