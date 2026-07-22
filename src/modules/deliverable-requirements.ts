// Groups a compiled Criterion[] into the deliverable shape a caller needs to prepare - the
// "what evidence do I need?" pre-flight this whole module exists for (docs/OKX_ASP_LISTING_GUIDE.md
// and this session's discussion: /verify only reveals the required deliverable shape *after* the
// same paid call that needed it already satisfied). Bucket names mirror the four deliverable
// buckets M3 dispatches against (src/modules/m3-*.ts) - reuses the same is*Method guards those
// checkers already rely on, not a new classification.
import {
  isOnchainMethod,
  isDataMethod,
  isCodeMethod,
  isContentMethod,
  type Criterion,
  type Method,
} from "../verdict/types.js";

export type DeliverableRequirements = {
  onchain?: Record<string, number>;
  data?: Record<string, number>;
  code?: Record<string, number>;
  content?: Record<string, number>;
};

const BUCKETS = [
  { key: "onchain", guard: isOnchainMethod },
  { key: "data", guard: isDataMethod },
  { key: "code", guard: isCodeMethod },
  { key: "content", guard: isContentMethod },
] as const;

// `content.coverage` / `content.source_grounding` / `content.no_hallucination` ARE locatable
// (widened into CONTENT_METHODS - see verdict/types.ts) and DO get counted below like every
// other method; the claim shape they need is just unusually thin (content.coverage/
// no_hallucination carry nothing but an assetId - m3-content.ts's autoFillSingleAssetContentClaims
// even fills that in automatically for single-asset submissions, so those two often need no
// explicit claim at all). Criteria with method: null or a genuinely non-locatable method
// (taste.refused) still contribute nothing here - no `locator` to read.
export function computeDeliverableRequirements(criteria: Criterion[]): DeliverableRequirements {
  const requirements: DeliverableRequirements = {};

  for (const criterion of criteria) {
    if (!criterion.locator) continue;
    const { method, index } = criterion.locator;

    for (const { key, guard } of BUCKETS) {
      if (!guard(method)) continue;
      const bucket = (requirements[key] ??= {});
      bucket[method] = Math.max(bucket[method] ?? 0, index + 1);
      break;
    }
  }

  return requirements;
}

// ---- concrete example generator (OKX review: "document the exact request schema") ----

// One literal example claim per locatable method, values drawn directly from each method's real
// claim interface (m3-onchain.ts/m3-data.ts/m3-code.ts/m3-content.ts + their quarantine.ts
// schemas) - never invented fields. `content.coverage` / `content.no_hallucination` are
// deliberately `null` here: their whole point is that a single-asset submission needs no claim
// entry at all (see m3-content.ts's autoFillSingleAssetContentClaims) - showing "nothing to add"
// is the actually useful documentation for those two, not a synthetic claim object.
const EXAMPLE_CLAIMS: Partial<Record<Method, unknown>> = {
  "onchain.tx_exists": { txHash: "0xabc123...64-char tx hash" },
  "onchain.transfer_check": { txHash: "0xabc123...64-char tx hash", asset: "native", amountMin: "1000000" },
  "onchain.destination_check": { txHash: "0xabc123...64-char tx hash", destination: "0xrecipient address", asset: "native" },
  "onchain.owner_check": { txHash: "0xabc123...64-char tx hash", asset: "0xnft contract address", tokenId: "1", owner: "0xowner address" },
  "onchain.safety": { kind: "token", chain: "196", tokenAddress: "0xtoken address" },
  "data.schema": { datasetId: "d1", columns: [{ name: "example_column", type: "string" }] },
  "data.rowcount": { datasetId: "d1", minCount: 10 },
  "data.sample_verify": { datasetId: "d1", ground_truth: "onchain_mint", columns: { txHash: "txHash", owner: "owner", tokenId: "tokenId" } },
  "code.compiles": { codeId: "c1" },
  "code.tests_pass": { codeId: "c1", testFiles: ["test/index.test.ts"] },
  "content.presence": { assetId: "a1", target: { kind: "heading", value: "Breaking Changes" } },
  "content.format": { assetId: "a1" },
  "content.bounds": { assetId: "a1", metric: "word_count", min: 200 },
  "content.pattern": { assetId: "a1", pattern: "email" },
  "content.coverage": null,
  "content.no_hallucination": null,
  "content.source_grounding": { assetId: "a1", citedUrls: ["https://example.com/your-source"] },
};

// Example asset-array entry per bucket that has *any* method present, alongside whichever claim
// arrays are needed - a customer needs both halves (the raw asset, and the claim pointing at it)
// except content.coverage/no_hallucination, which - per EXAMPLE_CLAIMS above - need only the
// asset when submitted alone.
const EXAMPLE_ASSET: Record<"data" | "code" | "content", { key: string; entry: unknown }> = {
  data: { key: "datasets", entry: { id: "d1", format: "csv", content: "col_a,col_b\nvalue1,value2" } },
  code: { key: "code", entry: { id: "c1", language: "ts", files: [{ path: "index.ts", content: "export const hello = () => \"world\";" }] } },
  content: { key: "content", entry: { id: "a1", format: "text", content: "<your content here>" } },
};

export function exampleDeliverable(requirements: DeliverableRequirements): Record<string, unknown> {
  const deliverable: Record<string, unknown> = {};

  if (requirements.onchain) {
    const bucket: Record<string, unknown[]> = {};
    for (const method of Object.keys(requirements.onchain)) {
      bucket[method] = [EXAMPLE_CLAIMS[method as Method]];
    }
    deliverable.onchain = bucket;
  }

  for (const key of ["data", "code", "content"] as const) {
    const methods = requirements[key];
    if (!methods) continue;
    const { key: assetKey, entry } = EXAMPLE_ASSET[key];
    const bucket: Record<string, unknown> = { [assetKey]: [entry] };
    for (const method of Object.keys(methods)) {
      const example = EXAMPLE_CLAIMS[method as Method];
      if (example !== null) bucket[method] = [example];
    }
    deliverable[key] = bucket;
  }

  return deliverable;
}
