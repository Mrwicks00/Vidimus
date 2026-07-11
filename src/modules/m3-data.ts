// M3.B data/schema checker. docs/VERIFICATION_MODULES.md M3.B. Scope locked to this session's
// brief (docs/ROADMAP.md D5, M3.B half only - M3.C code sandbox is a separate gate, not touched
// here): `data.schema`, `data.rowcount`, `data.sample_verify` (adversarial sampling protocol,
// docs/SECURITY.md §4).
//
// Same claim-addressing grammar as M3.A (docs/VERDICT_SPEC.md §2.2): a criterion's `locator`
// points at `deliverable.data[method][index]`. This module only resolves locators whose
// `method` is a DataMethod - onchain locators pass through untouched (m3-onchain.ts handles
// those), so the two checkers compose over the same criteria[] array without stepping on each
// other (see src/routes/verify.ts).
import { keccak256, concat, type Address, type Hex } from "viem";
import { publicClient, verifyRowGroundTruth } from "./m3-onchain.js";
import { isDataMethod, type Criterion, type Evidence } from "../verdict/types.js";
import type { QuarantineRejection } from "../security/quarantine.js";

function evidence(kind: Evidence["kind"], ref: string, detail: string): Evidence {
  return { kind, ref, detail };
}

function withResult(c: Criterion, result: Criterion["result"], ev: Evidence): Criterion {
  return { ...c, result, confidence: result === "UNVERIFIABLE" ? null : 1.0, evidence: ev };
}

function unverifiable(c: Criterion, detail: string): Criterion {
  return withResult(c, "UNVERIFIABLE", evidence("none", "", detail));
}

// ---- Delivered data + claim shapes (deliverable-provided, inert data - never instructions) ----

export interface DataAsset {
  id: string;
  format: "csv" | "json"; // json = array of flat row objects
  content: string; // raw bytes as UTF-8 text - quarantined/parsed at Pass 1, sealed after
}

export interface DataSchemaClaim {
  datasetId: string;
  columns: { name: string; type: "string" | "number" | "boolean" }[]; // the declared/expected schema
}

export interface DataRowcountClaim {
  datasetId: string;
  minCount: number; // the declared/expected minimum row count
}

export interface DataSampleVerifyClaim {
  datasetId: string;
  // v1: one ground-truth battery - cross-checks sampled rows against chain fact, reusing
  // m3-onchain's tx reader. The exact predicate battery beyond this stays non-public
  // (SECURITY.md §4.2); only this structural column mapping is client-supplied.
  ground_truth: "onchain_mint";
  columns: { txHash: string; owner?: string; tokenId?: string; asset?: string };
}

export interface DataDeliverable {
  datasets?: DataAsset[];
  "data.schema"?: DataSchemaClaim[];
  "data.rowcount"?: DataRowcountClaim[];
  "data.sample_verify"?: DataSampleVerifyClaim[];
}

// ---- Pass-1 extraction output (the FactSet - the only thing that crosses the seal, SECURITY.md
// §2.2). Produced by src/security/quarantine.ts's quarantineDataDeliverable; this module never
// re-reads the raw `content` string, only this structured result. ----

export type ColumnType = "string" | "number" | "boolean";

export interface DataFactSet {
  id: string;
  columns: { name: string; type: ColumnType }[];
  rowCount: number;
  rows: Record<string, string>[];
}

export interface DataDeliverableSealed {
  datasets: DataFactSet[];
  "data.schema"?: DataSchemaClaim[];
  "data.rowcount"?: DataRowcountClaim[];
  "data.sample_verify"?: DataSampleVerifyClaim[];
}

function findDataset(datasets: DataFactSet[], id: string): DataFactSet | undefined {
  return datasets.find((d) => d.id === id);
}

// ---- data.schema ----

function checkSchema(c: Criterion, claim: DataSchemaClaim, datasets: DataFactSet[]): Criterion {
  const dataset = findDataset(datasets, claim.datasetId);
  if (!dataset) {
    return unverifiable(
      c,
      `data.schema: referenced dataset "${claim.datasetId}" was not delivered or was rejected at quarantine`,
    );
  }
  const actualByName = new Map(dataset.columns.map((col) => [col.name, col.type]));
  const missing: string[] = [];
  const mismatched: string[] = [];
  for (const declared of claim.columns) {
    const actualType = actualByName.get(declared.name);
    if (actualType === undefined) {
      missing.push(declared.name);
    } else if (actualType !== declared.type) {
      mismatched.push(`${declared.name} (declared ${declared.type}, actual ${actualType})`);
    }
  }
  if (missing.length === 0 && mismatched.length === 0) {
    return withResult(
      c,
      "PASS",
      evidence(
        "extract",
        `dataset:${dataset.id}`,
        `all ${claim.columns.length} declared columns present with matching types in dataset ${dataset.id}`,
      ),
    );
  }
  const parts: string[] = [];
  if (missing.length > 0) parts.push(`missing: ${missing.join(", ")}`);
  if (mismatched.length > 0) parts.push(`type mismatch: ${mismatched.join(", ")}`);
  return withResult(
    c,
    "FAIL",
    evidence("extract", `dataset:${dataset.id}`, `dataset ${dataset.id} schema does not match declared schema - ${parts.join("; ")}`),
  );
}

// ---- data.rowcount ----

function checkRowcount(c: Criterion, claim: DataRowcountClaim, datasets: DataFactSet[]): Criterion {
  const dataset = findDataset(datasets, claim.datasetId);
  if (!dataset) {
    return unverifiable(
      c,
      `data.rowcount: referenced dataset "${claim.datasetId}" was not delivered or was rejected at quarantine`,
    );
  }
  if (dataset.rowCount >= claim.minCount) {
    return withResult(
      c,
      "PASS",
      evidence("extract", `dataset:${dataset.id}`, `dataset ${dataset.id} has ${dataset.rowCount} rows (>= required ${claim.minCount})`),
    );
  }
  return withResult(
    c,
    "FAIL",
    evidence("extract", `dataset:${dataset.id}`, `dataset ${dataset.id} has only ${dataset.rowCount} rows (required >= ${claim.minCount})`),
  );
}

// ---- data.sample_verify - adversarial sampling (SECURITY.md §4) ----

// Sizing/fraction constants are the non-public part of the battery (SECURITY.md §4.4: "keep the
// actual sizing function private; expose only that a statistically meaningful sample was
// verified plus the audit seed_ref") - never surfaced in a verdict or API response.
const MIN_SAMPLE = 10;
const SAMPLE_FRACTION = 0.05;
const MAX_SAMPLE = 200;

// Bounded wait for a post-commitment block (SECURITY.md §4.1). Never hangs the paid request past
// this budget - times out to UNVERIFIABLE, never a guessed/unsampled result.
const BLOCK_ADVANCE_TIMEOUT_MS = 10_000;
const BLOCK_POLL_INTERVAL_MS = 1_000;

function sampleSize(rowCount: number): number {
  return Math.min(rowCount, MAX_SAMPLE, Math.max(MIN_SAMPLE, Math.ceil(rowCount * SAMPLE_FRACTION)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * SECURITY.md §4.1 commit-after-delivery seed: `commitBlockNumber` is the chain tip captured the
 * moment the deliverable was sealed (its hash already fixed by then) - this waits for a block
 * strictly newer than that, i.e. one that did not exist when the seller submitted, so the seed
 * depends on entropy they could not have precomputed against. Bounded: never polls past
 * BLOCK_ADVANCE_TIMEOUT_MS: returns null on timeout rather than falling back to a predictable
 * seed. A transient RPC error is treated the same as "not yet advanced" and retried until the
 * deadline, not surfaced as a hard failure.
 */
async function waitForCommittedBlock(commitBlockNumber: bigint): Promise<{ blockNumber: bigint; blockHash: Hex } | null> {
  const deadline = Date.now() + BLOCK_ADVANCE_TIMEOUT_MS;
  for (;;) {
    try {
      const block = await publicClient.getBlock();
      if (block.number > commitBlockNumber) {
        return { blockNumber: block.number, blockHash: block.hash };
      }
    } catch {
      // transient RPC blip - fall through to the deadline check and retry.
    }
    if (Date.now() >= deadline) return null;
    await sleep(BLOCK_POLL_INTERVAL_MS);
  }
}

function deriveSeed(deliverableHash: string, blockHash: Hex): Hex {
  const hashHex = deliverableHash.startsWith("sha256:") ? deliverableHash.slice("sha256:".length) : deliverableHash;
  return keccak256(concat([`0x${hashHex}` as Hex, blockHash]));
}

function counterHex(i: number): Hex {
  return `0x${i.toString(16).padStart(8, "0")}` as Hex;
}

/**
 * Deterministic expansion of `seed` into up to `size` distinct row indices in [0, rowCount).
 * Pure, no chain calls - independently unit-testable. Re-derivable by any third party who knows
 * `seed` (== keccak256(deliverable_hash ++ blockHash) - deliverable_hash is in the signed
 * verdict, blockHash is public chain data, both auditable after the fact) and `rowCount`,
 * proving exactly which rows were checked without that having been predictable beforehand.
 */
export function deriveSampleIndices(seed: Hex, rowCount: number, size: number): number[] {
  const indices = new Set<number>();
  const target = Math.min(size, rowCount);
  if (target <= 0 || rowCount <= 0) return [];
  let counter = 0;
  const maxAttempts = rowCount * 4 + 100; // safety valve if target is close to rowCount
  while (indices.size < target && counter < maxAttempts) {
    const h = keccak256(concat([seed, counterHex(counter)]));
    indices.add(Number(BigInt(h) % BigInt(rowCount)));
    counter += 1;
  }
  return [...indices].sort((a, b) => a - b);
}

async function checkSampleVerify(
  c: Criterion,
  claim: DataSampleVerifyClaim,
  datasets: DataFactSet[],
  deliverableHash: string,
  commitBlockNumber: bigint,
): Promise<Criterion> {
  const dataset = findDataset(datasets, claim.datasetId);
  if (!dataset) {
    return unverifiable(
      c,
      `data.sample_verify: referenced dataset "${claim.datasetId}" was not delivered or was rejected at quarantine`,
    );
  }
  if (claim.ground_truth !== "onchain_mint") {
    return unverifiable(c, `data.sample_verify: unsupported ground-truth battery "${claim.ground_truth}"`);
  }
  if (dataset.rowCount === 0) {
    return unverifiable(c, `data.sample_verify: dataset ${dataset.id} has no rows to sample`);
  }

  const committed = await waitForCommittedBlock(commitBlockNumber);
  if (!committed) {
    return unverifiable(
      c,
      "data.sample_verify: could not obtain a post-delivery committed block for adversarial sampling within the time budget - refusing to sample rather than guess",
    );
  }

  const seed = deriveSeed(deliverableHash, committed.blockHash);
  const size = sampleSize(dataset.rowCount);
  const indices = deriveSampleIndices(seed, dataset.rowCount, size);

  const results = await Promise.all(
    indices.map(async (i) => {
      const row = dataset.rows[i]!;
      const txHash = row[claim.columns.txHash] as Hex | undefined;
      if (!txHash) {
        return { status: "blocked" as const, detail: `row ${i}: no value in column "${claim.columns.txHash}"` };
      }
      const owner = claim.columns.owner ? (row[claim.columns.owner] as Address | undefined) : undefined;
      const tokenId = claim.columns.tokenId ? row[claim.columns.tokenId] : undefined;
      const asset = claim.columns.asset ? (row[claim.columns.asset] as Address | undefined) : undefined;
      const result = await verifyRowGroundTruth({ txHash, owner, tokenId, asset });
      return { status: result.status, detail: `row ${i}: ${result.detail}` };
    }),
  );

  const failed = results.filter((r) => r.status === "mismatch");
  const blocked = results.filter((r) => r.status === "blocked");
  const verified = results.filter((r) => r.status === "verified");
  // seed_ref (SECURITY.md §4.1): block number + hash, enough for a third party to recompute
  // deriveSeed(deliverable_hash, blockHash) and re-derive the exact same row set independently -
  // the sample size/fraction constants above are deliberately never included here.
  const ref = `sample:${dataset.id}:${committed.blockNumber}`;
  const seedRefText = `seed_ref: block ${committed.blockNumber} hash ${committed.blockHash}`;

  if (failed.length > 0) {
    return withResult(
      c,
      "FAIL",
      evidence(
        "sample",
        ref,
        `${failed.length}/${results.length} sampled rows failed ground-truth verification (${seedRefText}) - first: ${failed[0]!.detail}`,
      ),
    );
  }
  if (blocked.length > 0) {
    return withResult(
      c,
      "UNVERIFIABLE",
      evidence(
        "sample",
        ref,
        `${blocked.length}/${results.length} sampled rows could not be checked, ${verified.length} verified, 0 failed (${seedRefText}) - first blocked: ${blocked[0]!.detail}`,
      ),
    );
  }
  return withResult(
    c,
    "PASS",
    evidence("sample", ref, `${verified.length}/${results.length} sampled rows independently verified against chain (${seedRefText})`),
  );
}

// D5: dispatches every criterion whose locator addresses a DataMethod - onchain locators pass
// through untouched (m3-onchain.ts's applyOnchainChecks handles those in the same pipeline, see
// src/routes/verify.ts). `deliverableHash` must already be fixed (computed by quarantine over
// both the onchain and data buckets) before this runs - it is both the audit value in
// subject.deliverable_hash and half the sample_verify seed input, so its commitment necessarily
// precedes any sampling (SECURITY.md §4.1).
export async function applyDataChecks(
  criteria: Criterion[],
  sealed: DataDeliverableSealed | undefined,
  rejections: QuarantineRejection[],
  deliverableHash: string,
): Promise<Criterion[]> {
  const rejectionByKey = new Map(rejections.map((r) => [`${r.method}[${r.index}]`, r]));
  const datasets = sealed?.datasets ?? [];

  // Only pay for a chain-tip read (and the bounded wait it enables) if a sample_verify
  // criterion actually needs one.
  const needsCommitBlock = criteria.some((c) => c.locator?.method === "data.sample_verify");
  const commitBlockNumber = needsCommitBlock ? await publicClient.getBlockNumber() : 0n;

  return Promise.all(
    criteria.map(async (c) => {
      const locator = c.locator;
      if (!locator || !isDataMethod(locator.method)) return c;
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
        case "data.schema":
          return checkSchema(c, claim as DataSchemaClaim, datasets);
        case "data.rowcount":
          return checkRowcount(c, claim as DataRowcountClaim, datasets);
        case "data.sample_verify":
          return checkSampleVerify(c, claim as DataSampleVerifyClaim, datasets, deliverableHash, commitBlockNumber);
      }
    }),
  );
}
