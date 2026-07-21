// M5 — ingest quarantine. docs/SECURITY.md §2.1 ("accept as opaque bytes... never execute...
// hash it... mark QUARANTINED") + §3 (canary). This is the boundary ARCHITECTURE.md §3 draws
// as "M5 ingest: may READ raw request bytes, may WRITE quarantined blob + metadata, must NOT
// execute or instruction-follow content."
//
// Two quarantine paths exist today because two ingest surfaces exist: the spec (read into an
// LLM context by M2 - the one place text is ever "interpreted") and the onchain deliverable
// (read only by mechanical RPC/CLI extractors in m3-onchain.ts, never an LLM - but until now
// had no runtime schema validation, just TS type declarations trusted at the JSON boundary).
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { OnchainDeliverable } from "../modules/m3-onchain.js";
import type {
  ColumnType,
  DataAsset,
  DataDeliverableSealed,
  DataFactSet,
  DataRowcountClaim,
  DataSampleVerifyClaim,
  DataSchemaClaim,
} from "../modules/m3-data.js";
import type { CodeAsset, CodeCompilesClaim, CodeDeliverableSealed, CodeTestsPassClaim } from "../modules/m3-code.js";
import {
  CONTENT_PATTERNS,
  type ContentAsset,
  type ContentBoundsClaim,
  type ContentCoverageClaim,
  type ContentDeliverableSealed,
  type ContentFactSet,
  type ContentFormat,
  type ContentFormatClaim,
  type ContentNoHallucinationClaim,
  type ContentPatternClaim,
  type ContentPresenceClaim,
  type ContentSourceGroundingClaim,
} from "../modules/m3-content.js";
import type { Method } from "../verdict/types.js";

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX_HASH = /^0x[0-9a-fA-F]{64}$/;
const HEX_DATA = /^0x[0-9a-fA-F]*$/;
const DECIMAL_STRING = /^[0-9]+$/;

// ---- spec quarantine ----

const MAX_SPEC_LENGTH = 20_000; // specs are short prose; reject oversized rather than truncate.

export interface QuarantinedSpec {
  text: string;
  hash: string;
  canary: string;
}

export class SpecQuarantineError extends Error {}

export function quarantineSpec(raw: string): QuarantinedSpec {
  const text = raw.trim();
  if (!text) {
    throw new SpecQuarantineError("quarantine: spec is empty");
  }
  if (text.length > MAX_SPEC_LENGTH) {
    throw new SpecQuarantineError(`quarantine: spec exceeds max length (${MAX_SPEC_LENGTH} chars)`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) {
    throw new SpecQuarantineError("quarantine: spec contains disallowed control bytes");
  }
  const hash = `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
  const canary = randomBytes(16).toString("hex");
  return { text, hash, canary };
}

// ---- deliverable (onchain claims) quarantine ----

const MAX_CLAIMS_PER_METHOD = 50; // DoS guard (SECURITY §2.1 caps) - not a real-world job size.

const TxExistsClaimSchema = z.strictObject({ txHash: z.string().regex(HEX_HASH) });

const TransferCheckClaimSchema = z.strictObject({
  txHash: z.string().regex(HEX_HASH),
  asset: z.union([z.literal("native"), z.string().regex(HEX_ADDRESS)]).optional(),
  amountMin: z.string().regex(DECIMAL_STRING).optional(),
});

const DestinationCheckClaimSchema = z.strictObject({
  txHash: z.string().regex(HEX_HASH),
  destination: z.string().regex(HEX_ADDRESS),
  asset: z.union([z.literal("native"), z.string().regex(HEX_ADDRESS)]).optional(),
});

const OwnerCheckClaimSchema = z.strictObject({
  txHash: z.string().regex(HEX_HASH),
  asset: z.string().regex(HEX_ADDRESS),
  tokenId: z.string().regex(DECIMAL_STRING),
  owner: z.string().regex(HEX_ADDRESS),
});

const SafetyTokenClaimSchema = z.strictObject({
  kind: z.literal("token"),
  chain: z.string().min(1).max(64),
  tokenAddress: z.string().regex(HEX_ADDRESS),
});

const SafetyTxClaimSchema = z.strictObject({
  kind: z.literal("tx"),
  chain: z.string().min(1).max(64),
  from: z.string().regex(HEX_ADDRESS),
  to: z.string().regex(HEX_ADDRESS).optional(),
  data: z.string().regex(HEX_DATA).optional(),
  value: z.string().regex(DECIMAL_STRING).optional(),
});

const SafetyCheckClaimSchema = z.union([SafetyTokenClaimSchema, SafetyTxClaimSchema]);

const CLAIM_SCHEMAS = {
  "onchain.tx_exists": TxExistsClaimSchema,
  "onchain.transfer_check": TransferCheckClaimSchema,
  "onchain.destination_check": DestinationCheckClaimSchema,
  "onchain.owner_check": OwnerCheckClaimSchema,
  "onchain.safety": SafetyCheckClaimSchema,
} as const;

type OnchainMethodKey = keyof typeof CLAIM_SCHEMAS;

const ONCHAIN_METHOD_KEYS = Object.keys(CLAIM_SCHEMAS) as OnchainMethodKey[];

export interface QuarantineRejection {
  method: Method;
  index: number;
  reason: string;
}

export interface QuarantinedDeliverable {
  deliverable: OnchainDeliverable;
  rejected: QuarantineRejection[];
  hash: string;
}

export function quarantineDeliverable(raw: unknown): QuarantinedDeliverable {
  const rejected: QuarantineRejection[] = [];
  const sealed: OnchainDeliverable = {};

  if (raw !== undefined && (typeof raw !== "object" || raw === null || Array.isArray(raw))) {
    // Not shaped like a deliverable at all - quarantine nothing, reject nothing (no claims to
    // evaluate); applyOnchainChecks will resolve every onchain criterion as "no claim submitted."
    raw = undefined;
  }

  const rawObj = (raw ?? {}) as Record<string, unknown>;

  for (const method of ONCHAIN_METHOD_KEYS) {
    const list = rawObj[method];
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      rejected.push({ method, index: 0, reason: `quarantine: ${method} is not an array` });
      continue;
    }
    const capped = list.slice(0, MAX_CLAIMS_PER_METHOD);
    const sealedList: unknown[] = [];
    capped.forEach((claim, index) => {
      const schema = CLAIM_SCHEMAS[method];
      const parsed = schema.safeParse(claim);
      if (parsed.success) {
        sealedList.push(parsed.data);
      } else {
        rejected.push({
          method,
          index,
          reason: `quarantine rejected malformed/suspicious claim (${method}[${index}]): ${parsed.error.issues[0]?.message ?? "schema mismatch"}`,
        });
        // Preserve positional alignment: a rejected claim still occupies its slot so later
        // valid claims in the same method array don't shift into the wrong criterion.
        sealedList.push(undefined);
      }
    });
    (sealed as Record<string, unknown[]>)[method] = sealedList;
  }

  const hash = `sha256:${createHash("sha256").update(JSON.stringify(sealed), "utf8").digest("hex")}`;
  return { deliverable: sealed, rejected, hash };
}

// ---- data deliverable quarantine (D5, M3.B) ----
//
// Two ingest concerns live here, same as the onchain path: (1) the actual delivered data itself
// (datasets[].content) is hostile input - opaque bytes, sniffed and parsed by a narrow,
// non-instructable mechanical extractor (no LLM anywhere in this path, stronger than the spec
// path), capped and REJECTED (never truncated) if oversized; (2) the data.* claims are
// schema-validated the same way onchain claims are. A dataset that fails to parse/quarantine is
// simply dropped from `sealed.datasets` - any claim whose `datasetId` then doesn't resolve
// naturally surfaces as UNVERIFIABLE downstream (src/modules/m3-data.ts's `findDataset` miss),
// so no separate dataset-level rejection channel is needed.

const MAX_DATASETS = 5; // DoS guard - not a real-world job size
const MAX_DATASET_CONTENT_LENGTH = 5_000_000; // ~5MB/dataset - reject oversized, never truncate
// Reject, never truncate: sample_verify must be able to reach any row in the FULL delivered
// set for adversarial sampling to mean anything - silently dropping rows past a cap would let a
// seller hide fake rows past the truncation point and defeat the whole point of unpredictable
// sampling (SECURITY.md §4).
const MAX_ROWS_PER_DATASET = 20_000;

const DataAssetSchema = z.strictObject({
  id: z.string().min(1).max(128),
  format: z.enum(["csv", "json"]),
  content: z.string().max(MAX_DATASET_CONTENT_LENGTH),
});

const DataColumnSchema = z.strictObject({
  name: z.string().min(1).max(128),
  type: z.enum(["string", "number", "boolean"]),
});

const DataSchemaClaimSchema = z.strictObject({
  datasetId: z.string().min(1).max(128),
  columns: z.array(DataColumnSchema).max(200),
});

const DataRowcountClaimSchema = z.strictObject({
  datasetId: z.string().min(1).max(128),
  minCount: z.number().int().nonnegative(),
});

const DataSampleVerifyClaimSchema = z.strictObject({
  datasetId: z.string().min(1).max(128),
  ground_truth: z.literal("onchain_mint"),
  columns: z.strictObject({
    txHash: z.string().min(1).max(128),
    owner: z.string().min(1).max(128).optional(),
    tokenId: z.string().min(1).max(128).optional(),
    asset: z.string().min(1).max(128).optional(),
  }),
});

const DATA_CLAIM_SCHEMAS = {
  "data.schema": DataSchemaClaimSchema,
  "data.rowcount": DataRowcountClaimSchema,
  "data.sample_verify": DataSampleVerifyClaimSchema,
} as const;

type DataMethodKey = keyof typeof DATA_CLAIM_SCHEMAS;

const DATA_METHOD_KEYS = Object.keys(DATA_CLAIM_SCHEMAS) as DataMethodKey[];

type JsonScalar = string | number | boolean | null;

// ---- mechanical CSV parsing (no library - RFC4180-ish: quoted fields, doubled-quote escaping,
// CRLF/LF line endings). This is Pass-1 extraction: it never interprets content as instructions,
// it only ever pulls positional string values. ----
function parseCsv(content: string): { header: string[]; rows: string[][] } {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;
  const n = content.length;
  while (i < n) {
    const ch = content[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (content[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (ch === "\r") {
      i += 1;
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      field = "";
      row = [];
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const [header, ...dataRows] = rows;
  return { header: header ?? [], rows: dataRows.filter((r) => !(r.length === 1 && r[0] === "")) };
}

function inferCsvColumnType(values: string[]): ColumnType {
  const nonEmpty = values.filter((v) => v !== "");
  if (nonEmpty.length === 0) return "string";
  if (nonEmpty.every((v) => v === "true" || v === "false")) return "boolean";
  if (nonEmpty.every((v) => /^-?\d+(\.\d+)?$/.test(v))) return "number";
  return "string";
}

function inferJsonColumns(rows: Record<string, JsonScalar>[]): { name: string; type: ColumnType }[] {
  const keys = new Set<string>();
  for (const row of rows) for (const k of Object.keys(row)) keys.add(k);
  const columns: { name: string; type: ColumnType }[] = [];
  for (const key of keys) {
    let sawNumber = false;
    let sawBoolean = false;
    let sawOther = false;
    for (const row of rows) {
      const v = row[key];
      if (v === null || v === undefined) continue;
      if (typeof v === "number") sawNumber = true;
      else if (typeof v === "boolean") sawBoolean = true;
      else sawOther = true;
    }
    const kindsSeen = Number(sawNumber) + Number(sawBoolean) + Number(sawOther);
    const type: ColumnType = kindsSeen === 1 ? (sawNumber ? "number" : sawBoolean ? "boolean" : "string") : "string";
    columns.push({ name: key, type });
  }
  return columns;
}

type ExtractResult = { ok: true; factSet: DataFactSet } | { ok: false; reason: string };

function extractDataset(asset: { id: string; format: "csv" | "json"; content: string }): ExtractResult {
  if (asset.format === "csv") {
    const { header, rows } = parseCsv(asset.content);
    if (header.length === 0) {
      return { ok: false, reason: `dataset ${asset.id}: CSV has no header row` };
    }
    if (rows.length > MAX_ROWS_PER_DATASET) {
      return { ok: false, reason: `dataset ${asset.id}: exceeds max row count (${MAX_ROWS_PER_DATASET})` };
    }
    const columnValues: Record<string, string[]> = {};
    for (const name of header) columnValues[name] = [];
    const structuredRows: Record<string, string>[] = rows.map((cells) => {
      const structuredRow: Record<string, string> = {};
      header.forEach((name, idx) => {
        const value = cells[idx] ?? "";
        structuredRow[name] = value;
        columnValues[name]!.push(value);
      });
      return structuredRow;
    });
    const columns = header.map((name) => ({ name, type: inferCsvColumnType(columnValues[name] ?? []) }));
    return { ok: true, factSet: { id: asset.id, columns, rowCount: structuredRows.length, rows: structuredRows } };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(asset.content);
  } catch {
    return { ok: false, reason: `dataset ${asset.id}: invalid JSON` };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, reason: `dataset ${asset.id}: JSON content must be an array of row objects` };
  }
  if (parsed.length > MAX_ROWS_PER_DATASET) {
    return { ok: false, reason: `dataset ${asset.id}: exceeds max row count (${MAX_ROWS_PER_DATASET})` };
  }
  const jsonRows: Record<string, JsonScalar>[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return { ok: false, reason: `dataset ${asset.id}: JSON rows must be flat objects` };
    }
    const jsonRow: Record<string, JsonScalar> = {};
    for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
      if (v !== null && typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") {
        return { ok: false, reason: `dataset ${asset.id}: row field "${k}" must be a flat string/number/boolean/null` };
      }
      jsonRow[k] = v as JsonScalar;
    }
    jsonRows.push(jsonRow);
  }
  const columns = inferJsonColumns(jsonRows);
  const structuredRows = jsonRows.map((row) => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(row)) out[k] = v === null || v === undefined ? "" : String(v);
    return out;
  });
  return { ok: true, factSet: { id: asset.id, columns, rowCount: structuredRows.length, rows: structuredRows } };
}

export function quarantineDataDeliverable(raw: unknown): {
  sealed: DataDeliverableSealed | undefined;
  rejected: QuarantineRejection[];
} {
  const rejected: QuarantineRejection[] = [];

  if (raw === undefined || typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    // Not shaped like a data deliverable at all - seal nothing; every data.* criterion's locator
    // will fail to resolve downstream (findDataset/claim lookup misses), same posture as the
    // onchain path's equivalent case.
    return { sealed: undefined, rejected };
  }
  const rawObj = raw as Record<string, unknown>;

  const rawDatasets = Array.isArray(rawObj.datasets) ? rawObj.datasets : [];
  const datasets: DataFactSet[] = [];
  for (const item of rawDatasets.slice(0, MAX_DATASETS)) {
    const parsedAsset = DataAssetSchema.safeParse(item);
    if (!parsedAsset.success) continue; // malformed descriptor - dropped, not sealed
    const extracted = extractDataset(parsedAsset.data as DataAsset);
    if (extracted.ok) datasets.push(extracted.factSet);
    // else: oversized/unparseable - dropped. Any claim referencing this id resolves
    // UNVERIFIABLE downstream via findDataset returning undefined - no separate signal needed.
  }

  const sealedClaims: Partial<Record<DataMethodKey, unknown[]>> = {};
  for (const method of DATA_METHOD_KEYS) {
    const list = rawObj[method];
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      rejected.push({ method, index: 0, reason: `quarantine: ${method} is not an array` });
      continue;
    }
    const capped = list.slice(0, MAX_CLAIMS_PER_METHOD);
    const sealedList: unknown[] = [];
    capped.forEach((claim, index) => {
      const schema = DATA_CLAIM_SCHEMAS[method];
      const parsed = schema.safeParse(claim);
      if (parsed.success) {
        sealedList.push(parsed.data);
      } else {
        rejected.push({
          method,
          index,
          reason: `quarantine rejected malformed/suspicious claim (${method}[${index}]): ${parsed.error.issues[0]?.message ?? "schema mismatch"}`,
        });
        sealedList.push(undefined);
      }
    });
    sealedClaims[method] = sealedList;
  }

  const sealed: DataDeliverableSealed = {
    datasets,
    "data.schema": sealedClaims["data.schema"] as DataSchemaClaim[] | undefined,
    "data.rowcount": sealedClaims["data.rowcount"] as DataRowcountClaim[] | undefined,
    "data.sample_verify": sealedClaims["data.sample_verify"] as DataSampleVerifyClaim[] | undefined,
  };
  return { sealed, rejected };
}

// ---- code deliverable quarantine (D5, M3.C) ----
//
// Delivered code is the most hostile ingest surface in the system - it is, by design, about to
// be handed to a sandbox that runs it (src/security/sandbox.ts). This module never executes it;
// it only validates shape/size and, critically, every file path, since a path becomes a real
// filesystem write location when the sandbox materializes files to a scratch dir *before* the
// container (and its own isolation) even starts. An unsanitized ".." could otherwise escape the
// intended directory ahead of Docker ever engaging - a host-safety concern (T5-adjacent), not an
// injection-shaped one (T1). Re-validated again in the runner itself as defense in depth.

const MAX_CODE_ASSETS = 5; // DoS guard - not a real-world job size
const MAX_FILES_PER_ASSET = 50;
const MAX_FILE_CONTENT_LENGTH = 200_000; // ~200KB/file - reject oversized, never truncate
const MAX_TOTAL_ASSET_SIZE = 2_000_000; // ~2MB/asset across all its files
const MAX_TEST_FILES_PER_CLAIM = 20;

// Relative-safe path: no leading slash, no ".." traversal, no null bytes/control chars.
const SAFE_RELATIVE_PATH = /^[A-Za-z0-9._-][A-Za-z0-9._\-/]*$/;

function isSafeRelativePath(p: string): boolean {
  if (p.length === 0 || p.length > 256) return false;
  if (!SAFE_RELATIVE_PATH.test(p)) return false;
  if (p.split("/").includes("..")) return false;
  return true;
}

const CodeFileSchema = z.strictObject({
  path: z.string().refine(isSafeRelativePath, { message: "unsafe or malformed file path" }),
  content: z.string().max(MAX_FILE_CONTENT_LENGTH),
});

const CodeAssetSchema = z
  .strictObject({
    id: z.string().min(1).max(128),
    language: z.enum(["js", "ts"]),
    files: z.array(CodeFileSchema).min(1).max(MAX_FILES_PER_ASSET),
  })
  .refine((asset) => asset.files.reduce((sum, f) => sum + f.content.length, 0) <= MAX_TOTAL_ASSET_SIZE, {
    message: `total delivered content exceeds ${MAX_TOTAL_ASSET_SIZE} bytes`,
  });

const CodeCompilesClaimSchema = z.strictObject({
  codeId: z.string().min(1).max(128),
});

const CodeTestsPassClaimSchema = z.strictObject({
  codeId: z.string().min(1).max(128),
  testFiles: z
    .array(z.string().refine(isSafeRelativePath, { message: "unsafe or malformed test file path" }))
    .min(1)
    .max(MAX_TEST_FILES_PER_CLAIM),
});

const CODE_CLAIM_SCHEMAS = {
  "code.compiles": CodeCompilesClaimSchema,
  "code.tests_pass": CodeTestsPassClaimSchema,
} as const;

type CodeMethodKey = keyof typeof CODE_CLAIM_SCHEMAS;

const CODE_METHOD_KEYS = Object.keys(CODE_CLAIM_SCHEMAS) as CodeMethodKey[];

export function quarantineCodeDeliverable(raw: unknown): {
  sealed: CodeDeliverableSealed | undefined;
  rejected: QuarantineRejection[];
} {
  const rejected: QuarantineRejection[] = [];

  if (raw === undefined || typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { sealed: undefined, rejected };
  }
  const rawObj = raw as Record<string, unknown>;

  const rawAssets = Array.isArray(rawObj.code) ? rawObj.code : [];
  const assets: CodeAsset[] = [];
  for (const item of rawAssets.slice(0, MAX_CODE_ASSETS)) {
    const parsedAsset = CodeAssetSchema.safeParse(item);
    // Malformed/unsafe asset (including any single unsafe file path) - the whole asset is
    // dropped, never best-effort-repaired. Any claim referencing this id resolves UNVERIFIABLE
    // downstream via findCodeAsset returning undefined - same posture as the data path.
    if (parsedAsset.success) assets.push(parsedAsset.data);
  }

  const sealedClaims: Partial<Record<CodeMethodKey, unknown[]>> = {};
  for (const method of CODE_METHOD_KEYS) {
    const list = rawObj[method];
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      rejected.push({ method, index: 0, reason: `quarantine: ${method} is not an array` });
      continue;
    }
    const capped = list.slice(0, MAX_CLAIMS_PER_METHOD);
    const sealedList: unknown[] = [];
    capped.forEach((claim, index) => {
      const schema = CODE_CLAIM_SCHEMAS[method];
      const parsed = schema.safeParse(claim);
      if (parsed.success) {
        sealedList.push(parsed.data);
      } else {
        rejected.push({
          method,
          index,
          reason: `quarantine rejected malformed/suspicious claim (${method}[${index}]): ${parsed.error.issues[0]?.message ?? "schema mismatch"}`,
        });
        sealedList.push(undefined);
      }
    });
    sealedClaims[method] = sealedList;
  }

  const sealed: CodeDeliverableSealed = {
    code: assets,
    "code.compiles": sealedClaims["code.compiles"] as CodeCompilesClaim[] | undefined,
    "code.tests_pass": sealedClaims["code.tests_pass"] as CodeTestsPassClaim[] | undefined,
  };
  return { sealed, rejected };
}

// ---- content deliverable quarantine (D6.A, M4 Tier-1) ----
//
// Same two-concern split as data/code: (1) the delivered content itself (content[].content) is
// hostile input - opaque bytes, structurally extracted here once (word/line/section counts,
// heading list, JSON parse, CSV header parse) into a ContentFactSet that crosses the seal, never
// re-interpreted a different way downstream, and never fed to an LLM or executed; (2) the
// content.* claims are schema-validated the same way onchain/data/code claims are - `pattern` is
// constrained to the CONTENT_PATTERNS enum (m3-content.ts), never a free-form regex string, so a
// hostile claim can never hand this process an attacker-controlled ReDoS pattern to compile.

const MAX_CONTENT_ASSETS = 10; // DoS guard - not a real-world job size
const MAX_CONTENT_LENGTH = 1_000_000; // ~1MB/asset - reject oversized, never truncate

const ContentAssetSchema = z.strictObject({
  id: z.string().min(1).max(128),
  format: z.enum(["text", "markdown", "json", "csv"]),
  content: z.string().max(MAX_CONTENT_LENGTH),
});

const ContentPresenceClaimSchema = z.strictObject({
  assetId: z.string().min(1).max(128),
  target: z.strictObject({
    kind: z.enum(["heading", "json_key", "csv_column", "literal"]),
    value: z.string().min(1).max(256),
  }),
});

const ContentFormatClaimSchema = z.strictObject({
  assetId: z.string().min(1).max(128),
});

const ContentBoundsClaimSchema = z
  .strictObject({
    assetId: z.string().min(1).max(128),
    metric: z.enum(["word_count", "char_count", "line_count", "section_count"]),
    min: z.number().int().nonnegative().optional(),
    max: z.number().int().nonnegative().optional(),
  })
  .refine((claim) => claim.min !== undefined || claim.max !== undefined, {
    message: "content.bounds claim must declare at least one of min/max",
  });

const ContentPatternClaimSchema = z.strictObject({
  assetId: z.string().min(1).max(128),
  pattern: z.enum(Object.keys(CONTENT_PATTERNS) as [string, ...string[]]),
});

// Tier-2 grounded-judgment claims (docs/VERIFICATION_MODULES.md M4 "Tier-2") - the required
// topics for content.coverage come from the criterion's own compiled `text`, not a buyer-
// declared field, so its claim shape carries nothing but the asset to check. citedUrls/
// sourceUrls are capped at 5 - a DoS guard against a claim demanding an unbounded number of
// live fetches (src/security/source-fetch.ts), same spirit as MAX_CLAIMS_PER_METHOD.
const MAX_SOURCE_URLS = 5;

const ContentCoverageClaimSchema = z.strictObject({
  assetId: z.string().min(1).max(128),
});

const ContentSourceGroundingClaimSchema = z.strictObject({
  assetId: z.string().min(1).max(128),
  citedUrls: z.array(z.url()).min(1).max(MAX_SOURCE_URLS),
});

const ContentNoHallucinationClaimSchema = z.strictObject({
  assetId: z.string().min(1).max(128),
  sourceUrls: z.array(z.url()).max(MAX_SOURCE_URLS).optional(),
});

const CONTENT_CLAIM_SCHEMAS = {
  "content.presence": ContentPresenceClaimSchema,
  "content.format": ContentFormatClaimSchema,
  "content.bounds": ContentBoundsClaimSchema,
  "content.pattern": ContentPatternClaimSchema,
  "content.coverage": ContentCoverageClaimSchema,
  "content.source_grounding": ContentSourceGroundingClaimSchema,
  "content.no_hallucination": ContentNoHallucinationClaimSchema,
} as const;

type ContentMethodKey = keyof typeof CONTENT_CLAIM_SCHEMAS;

const CONTENT_METHOD_KEYS = Object.keys(CONTENT_CLAIM_SCHEMAS) as ContentMethodKey[];

/**
 * Pass-1 structural extraction (SECURITY.md §2.2): converts opaque delivered bytes into a typed
 * FactSet once, here - m3-content.ts's checkers only ever read this, never re-parse `content` a
 * different way. Never fails/rejects the asset itself (unlike dataset extraction, which drops an
 * unparseable dataset) - an asset that doesn't parse as its declared format is a legitimate
 * content.format FAIL, not a quarantine rejection, so json/csv parse failure is captured in the
 * FactSet rather than causing the asset to be dropped.
 */
function extractContentAsset(asset: { id: string; format: ContentFormat; content: string }): ContentFactSet {
  const raw = asset.content;
  const wordCount = raw.trim() === "" ? 0 : raw.trim().split(/\s+/).length;
  const charCount = raw.length;
  const lineCount = raw.split("\n").length;
  const headingMatches = [...raw.matchAll(/^#{1,6}[ \t]+(\S.*)$/gm)];
  const headings = headingMatches.map((m) => m[1]!.trim());
  const sectionCount = headings.length;

  let json: ContentFactSet["json"];
  try {
    json = { ok: true, value: JSON.parse(raw) };
  } catch (err) {
    json = { ok: false, error: err instanceof Error ? err.message : "invalid JSON" };
  }

  let csv: ContentFactSet["csv"];
  const { header } = parseCsv(raw);
  if (header.length === 0) {
    csv = { ok: false, error: "no header row found" };
  } else {
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const name of header) {
      if (seen.has(name)) duplicates.add(name);
      seen.add(name);
    }
    csv = { ok: true, header, duplicates: [...duplicates] };
  }

  return { id: asset.id, format: asset.format, raw, wordCount, charCount, lineCount, sectionCount, headings, json, csv };
}

export function quarantineContentDeliverable(raw: unknown): {
  sealed: ContentDeliverableSealed | undefined;
  rejected: QuarantineRejection[];
} {
  const rejected: QuarantineRejection[] = [];

  if (raw === undefined || typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { sealed: undefined, rejected };
  }
  const rawObj = raw as Record<string, unknown>;

  const rawAssets = Array.isArray(rawObj.content) ? rawObj.content : [];
  const assets: ContentFactSet[] = [];
  for (const item of rawAssets.slice(0, MAX_CONTENT_ASSETS)) {
    const parsedAsset = ContentAssetSchema.safeParse(item);
    // Malformed/oversized descriptor - dropped, never best-effort-repaired. Any claim referencing
    // this id resolves UNVERIFIABLE downstream via findContentAsset returning undefined, same
    // posture as the data/code paths.
    if (parsedAsset.success) assets.push(extractContentAsset(parsedAsset.data as ContentAsset));
  }

  const sealedClaims: Partial<Record<ContentMethodKey, unknown[]>> = {};
  for (const method of CONTENT_METHOD_KEYS) {
    const list = rawObj[method];
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      rejected.push({ method, index: 0, reason: `quarantine: ${method} is not an array` });
      continue;
    }
    const capped = list.slice(0, MAX_CLAIMS_PER_METHOD);
    const sealedList: unknown[] = [];
    capped.forEach((claim, index) => {
      const schema = CONTENT_CLAIM_SCHEMAS[method];
      const parsed = schema.safeParse(claim);
      if (parsed.success) {
        sealedList.push(parsed.data);
      } else {
        rejected.push({
          method,
          index,
          reason: `quarantine rejected malformed/suspicious claim (${method}[${index}]): ${parsed.error.issues[0]?.message ?? "schema mismatch"}`,
        });
        sealedList.push(undefined);
      }
    });
    sealedClaims[method] = sealedList;
  }

  const sealed: ContentDeliverableSealed = {
    content: assets,
    "content.presence": sealedClaims["content.presence"] as ContentPresenceClaim[] | undefined,
    "content.format": sealedClaims["content.format"] as ContentFormatClaim[] | undefined,
    "content.bounds": sealedClaims["content.bounds"] as ContentBoundsClaim[] | undefined,
    "content.pattern": sealedClaims["content.pattern"] as ContentPatternClaim[] | undefined,
    "content.coverage": sealedClaims["content.coverage"] as ContentCoverageClaim[] | undefined,
    "content.source_grounding": sealedClaims["content.source_grounding"] as ContentSourceGroundingClaim[] | undefined,
    "content.no_hallucination": sealedClaims["content.no_hallucination"] as ContentNoHallucinationClaim[] | undefined,
  };
  return { sealed, rejected };
}
