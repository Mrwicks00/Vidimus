// Standalone live proof for data.sample_verify's chain-dependent path (D5, M3.B), bypassing the
// HTTP route/payment/signing layers - useful when the onchainos wallet sign-message step is
// blocked by this sandbox's known web3.okx.com DNS limitation (see CLAUDE_HISTORY.md Sessions 1
// and 5) but the X Layer RPC itself (a different host) is reachable. Exercises the real
// mechanism end to end: quarantine -> commit-after-delivery seed -> bounded wait for a
// post-commitment block -> per-row chain verification -> aggregate result.
import "dotenv/config";
import { readFileSync } from "node:fs";
import { quarantineDataDeliverable } from "../src/security/quarantine.js";
import { applyDataChecks } from "../src/modules/m3-data.js";
import type { Criterion } from "../src/verdict/types.js";

const csvPath = process.argv[2];
if (!csvPath) {
  console.error("Usage: tsx scripts/verify-data-sample.ts <dataset.csv> <contractAddress>");
  process.exit(1);
}
const assetAddress = process.argv[3];
if (!assetAddress) {
  console.error("Usage: tsx scripts/verify-data-sample.ts <dataset.csv> <contractAddress>");
  process.exit(1);
}

async function main() {
  const csv = readFileSync(csvPath, "utf8");
  const raw = {
    datasets: [{ id: "d1", format: "csv" as const, content: csv }],
    "data.sample_verify": [
      {
        datasetId: "d1",
        ground_truth: "onchain_mint" as const,
        columns: { txHash: "mintTx", owner: "owner", tokenId: "tokenId", asset: "asset" },
      },
    ],
  };
  const { sealed, rejected } = quarantineDataDeliverable(raw);
  if (!sealed) throw new Error("quarantine sealed nothing - check dataset shape");
  console.log(`Quarantined dataset d1: ${sealed.datasets[0]?.rowCount} rows, rejected=${rejected.length}`);

  const criterion: Criterion = {
    id: "c1",
    text: "Each row's mintTx is a genuine mint resulting in the claimed owner (adversarially sampled).",
    source: "EXPLICIT",
    tier: 1,
    method: "data.sample_verify",
    locator: { method: "data.sample_verify", index: 0 },
    result: "UNVERIFIABLE",
    confidence: null,
    evidence: { kind: "none", ref: "", detail: "compiled, not yet verified" },
  };

  // Fold asset into the FactSet rows the same way the real quarantine path would if the
  // deliverable's dataset didn't already carry it - here it does (CSV has an asset column), so
  // no extra step needed; asserting for clarity that the column made it through parsing.
  console.log("Columns:", sealed.datasets[0]?.columns);

  const deliverableHash = "sha256:" + Buffer.from(csv).toString("hex").slice(0, 64).padEnd(64, "0");

  console.log("\nRunning applyDataChecks (will wait for a post-commitment X Layer block)...");
  const started = Date.now();
  const [result] = await applyDataChecks([criterion], sealed, [], deliverableHash);
  console.log(`\nDone in ${Date.now() - started}ms\n`);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
