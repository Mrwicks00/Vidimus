// M4 Tier-1 content checkers. docs/VERIFICATION_MODULES.md M4, scope locked to this session's
// brief (docs/ROADMAP.md D6.A - Tier-1 content only; Tier-2 grounded checks and the calibration
// log are D6.B, not touched here). `content.presence`, `content.format`, `content.bounds`,
// `content.pattern` - every one confidence 1.0, mechanical, no semantic/quality/topicality
// judgment (that hard line is what keeps this Tier 1, per CLAUDE.md L4).
//
// Same claim-addressing grammar as M3.A/B/C (docs/VERDICT_SPEC.md §2.2): a criterion's `locator`
// points at `deliverable.content[method][index]`. This module only resolves locators whose
// `method` is a ContentMethod - onchain/data/code locators pass through untouched, so all four
// checkers compose over the same criteria[] array without stepping on each other (see
// src/routes/verify.ts).
//
// Extraction boundary: mirrors m3-data.ts. Pass-1 structural extraction (word/line/section
// counts, heading list, JSON parse, CSV header parse) happens once in
// src/security/quarantine.ts's `extractContentAsset`, producing a `ContentFactSet` that crosses
// the seal - this module never re-parses raw bytes into a *different* structural interpretation
// than what quarantine already computed, it only reads the FactSet's precomputed fields (plus
// `raw` for literal/pattern substring search, which is inert data handed to non-instructable
// mechanical tools - regex/string search - never executed or instruction-followed).
import { isContentMethod, type Criterion, type Evidence } from "../verdict/types.js";
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

// ---- delivered content + claim shapes (deliverable-provided, inert data - never instructions) ----

export type ContentFormat = "text" | "markdown" | "json" | "csv";

export interface ContentAsset {
  id: string;
  format: ContentFormat; // seller's own declared shape - content.format re-validates this
  content: string; // raw bytes as UTF-8 text - quarantined/extracted at Pass 1, sealed after
}

// D6.A design gate (2026-07-11): a small vetted pattern registry, not a caller-supplied regex
// string - a claim-controlled regex compiled and run against claim-controlled content is a
// textbook ReDoS vector with no existing timeout/sandboxing infra to mitigate it here. Every
// pattern below is hand-checked linear-time-safe (no nested quantifiers, no ambiguous
// overlapping alternation over the same span).
export const CONTENT_PATTERNS = {
  email: /[^\s@]+@[^\s@]+\.[^\s@]+/,
  url: /https?:\/\/\S+/,
  iso_date: /\b\d{4}-\d{2}-\d{2}\b/,
  semver: /\b\d+\.\d+\.\d+\b/, // v1 simplification: no prerelease/build metadata support
} as const;

export type ContentPatternName = keyof typeof CONTENT_PATTERNS;

export interface ContentPresenceTarget {
  kind: "heading" | "json_key" | "csv_column" | "literal";
  value: string;
}

export interface ContentPresenceClaim {
  assetId: string;
  target: ContentPresenceTarget;
}

// v1: re-validates the asset's own self-declared `format` against its actual content - no extra
// field needed (mirrors data.schema's "declared vs actual" spirit).
export interface ContentFormatClaim {
  assetId: string;
}

export type ContentBoundsMetric = "word_count" | "char_count" | "line_count" | "section_count";

export interface ContentBoundsClaim {
  assetId: string;
  metric: ContentBoundsMetric;
  min?: number;
  max?: number; // at least one of min/max required (enforced at quarantine)
}

export interface ContentPatternClaim {
  assetId: string;
  pattern: ContentPatternName;
}

export interface ContentDeliverable {
  content?: ContentAsset[];
  "content.presence"?: ContentPresenceClaim[];
  "content.format"?: ContentFormatClaim[];
  "content.bounds"?: ContentBoundsClaim[];
  "content.pattern"?: ContentPatternClaim[];
}

// ---- Pass-1 extraction output (crosses the seal - produced by
// src/security/quarantine.ts's extractContentAsset; this module never re-reads the raw asset
// content string except via `raw` here, already sealed and inert). ----

export interface ContentFactSet {
  id: string;
  format: ContentFormat;
  raw: string;
  wordCount: number;
  charCount: number;
  lineCount: number;
  sectionCount: number;
  headings: string[]; // trimmed heading text, in document order
  json: { ok: true; value: unknown } | { ok: false; error: string };
  csv: { ok: true; header: string[]; duplicates: string[] } | { ok: false; error: string };
}

export interface ContentDeliverableSealed {
  content: ContentFactSet[];
  "content.presence"?: ContentPresenceClaim[];
  "content.format"?: ContentFormatClaim[];
  "content.bounds"?: ContentBoundsClaim[];
  "content.pattern"?: ContentPatternClaim[];
}

function findContentAsset(assets: ContentFactSet[], id: string): ContentFactSet | undefined {
  return assets.find((a) => a.id === id);
}

// ---- content.presence ----

/** Simple dot-path object traversal - no array indices in v1 (dated deviation, kept simple/defensible). */
function resolveJsonKeyPath(value: unknown, path: string): { found: true } | { found: false } {
  const segments = path.split(".").filter((s) => s.length > 0);
  let cursor: unknown = value;
  for (const segment of segments) {
    if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) {
      return { found: false };
    }
    const obj = cursor as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(obj, segment)) {
      return { found: false };
    }
    cursor = obj[segment];
  }
  return { found: true };
}

export function checkPresence(c: Criterion, claim: ContentPresenceClaim, assets: ContentFactSet[]): Criterion {
  const asset = findContentAsset(assets, claim.assetId);
  if (!asset) {
    return unverifiable(c, `content.presence: referenced content "${claim.assetId}" was not delivered or was rejected at quarantine`);
  }
  const { kind, value } = claim.target;

  if (kind === "literal") {
    const found = asset.raw.includes(value);
    return withResult(
      c,
      found ? "PASS" : "FAIL",
      evidence(
        "extract",
        `content:${asset.id}`,
        found ? `literal "${value}" found in content ${asset.id}` : `literal "${value}" not found in content ${asset.id}`,
      ),
    );
  }

  if (kind === "heading") {
    if (asset.format !== "markdown") {
      return unverifiable(c, `content.presence: target kind "heading" does not apply to content ${asset.id} (declared format "${asset.format}", not markdown)`);
    }
    const found = asset.headings.includes(value);
    return withResult(
      c,
      found ? "PASS" : "FAIL",
      evidence(
        "extract",
        `content:${asset.id}`,
        found
          ? `heading "${value}" found in content ${asset.id}`
          : `heading "${value}" not found among content ${asset.id}'s ${asset.headings.length} heading(s): ${asset.headings.join(" | ") || "(none)"}`,
      ),
    );
  }

  if (kind === "json_key") {
    if (asset.format !== "json") {
      return unverifiable(c, `content.presence: target kind "json_key" does not apply to content ${asset.id} (declared format "${asset.format}", not json)`);
    }
    if (!asset.json.ok) {
      return unverifiable(c, `content.presence: content ${asset.id} declared format json but does not parse - ${asset.json.error}`);
    }
    if (typeof asset.json.value !== "object" || asset.json.value === null || Array.isArray(asset.json.value)) {
      return unverifiable(c, `content.presence: content ${asset.id}'s top-level JSON is not an object - key path lookup does not apply`);
    }
    const resolved = resolveJsonKeyPath(asset.json.value, value);
    return withResult(
      c,
      resolved.found ? "PASS" : "FAIL",
      evidence(
        "extract",
        `content:${asset.id}`,
        resolved.found ? `json key path "${value}" present in content ${asset.id}` : `json key path "${value}" not present in content ${asset.id}`,
      ),
    );
  }

  // kind === "csv_column"
  if (asset.format !== "csv") {
    return unverifiable(c, `content.presence: target kind "csv_column" does not apply to content ${asset.id} (declared format "${asset.format}", not csv)`);
  }
  if (!asset.csv.ok) {
    return unverifiable(c, `content.presence: content ${asset.id} declared format csv but header did not parse - ${asset.csv.error}`);
  }
  const found = asset.csv.header.includes(value);
  return withResult(
    c,
    found ? "PASS" : "FAIL",
    evidence(
      "extract",
      `content:${asset.id}`,
      found
        ? `csv column "${value}" found in content ${asset.id}`
        : `csv column "${value}" not found among content ${asset.id}'s header: ${asset.csv.header.join(", ") || "(empty)"}`,
    ),
  );
}

// ---- content.format ----

export function checkFormat(c: Criterion, claim: ContentFormatClaim, assets: ContentFactSet[]): Criterion {
  const asset = findContentAsset(assets, claim.assetId);
  if (!asset) {
    return unverifiable(c, `content.format: referenced content "${claim.assetId}" was not delivered or was rejected at quarantine`);
  }
  switch (asset.format) {
    case "json":
      return asset.json.ok
        ? withResult(c, "PASS", evidence("extract", `content:${asset.id}`, `content ${asset.id} parses as valid JSON`))
        : withResult(c, "FAIL", evidence("extract", `content:${asset.id}`, `content ${asset.id} declared format json but failed to parse - ${asset.json.error}`));
    case "csv": {
      if (!asset.csv.ok) {
        return withResult(c, "FAIL", evidence("extract", `content:${asset.id}`, `content ${asset.id} declared format csv but has no header row - ${asset.csv.error}`));
      }
      if (asset.csv.duplicates.length > 0) {
        return withResult(
          c,
          "FAIL",
          evidence("extract", `content:${asset.id}`, `content ${asset.id} csv header has duplicate column(s): ${asset.csv.duplicates.join(", ")}`),
        );
      }
      return withResult(c, "PASS", evidence("extract", `content:${asset.id}`, `content ${asset.id} has a valid csv header (${asset.csv.header.length} column(s))`));
    }
    case "markdown":
      return asset.sectionCount > 0
        ? withResult(c, "PASS", evidence("extract", `content:${asset.id}`, `content ${asset.id} has ${asset.sectionCount} markdown heading(s)`))
        : withResult(c, "FAIL", evidence("extract", `content:${asset.id}`, `content ${asset.id} declared format markdown but has no heading lines`));
    case "text":
      return withResult(c, "PASS", evidence("extract", `content:${asset.id}`, `content ${asset.id} declared format text - nothing structural to validate`));
  }
}

// ---- content.bounds ----

function metricValue(asset: ContentFactSet, metric: ContentBoundsMetric): number {
  switch (metric) {
    case "word_count":
      return asset.wordCount;
    case "char_count":
      return asset.charCount;
    case "line_count":
      return asset.lineCount;
    case "section_count":
      return asset.sectionCount;
  }
}

export function checkBounds(c: Criterion, claim: ContentBoundsClaim, assets: ContentFactSet[]): Criterion {
  const asset = findContentAsset(assets, claim.assetId);
  if (!asset) {
    return unverifiable(c, `content.bounds: referenced content "${claim.assetId}" was not delivered or was rejected at quarantine`);
  }
  const value = metricValue(asset, claim.metric);
  if (claim.min !== undefined && value < claim.min) {
    return withResult(
      c,
      "FAIL",
      evidence("extract", `content:${asset.id}`, `${asset.id} ${claim.metric} is ${value}, required >= ${claim.min} (short by ${claim.min - value})`),
    );
  }
  if (claim.max !== undefined && value > claim.max) {
    return withResult(
      c,
      "FAIL",
      evidence("extract", `content:${asset.id}`, `${asset.id} ${claim.metric} is ${value}, required <= ${claim.max} (over by ${value - claim.max})`),
    );
  }
  return withResult(c, "PASS", evidence("extract", `content:${asset.id}`, `${asset.id} ${claim.metric} is ${value}, within declared bounds`));
}

// ---- content.pattern ----

export function checkPattern(c: Criterion, claim: ContentPatternClaim, assets: ContentFactSet[]): Criterion {
  const asset = findContentAsset(assets, claim.assetId);
  if (!asset) {
    return unverifiable(c, `content.pattern: referenced content "${claim.assetId}" was not delivered or was rejected at quarantine`);
  }
  const regex = CONTENT_PATTERNS[claim.pattern];
  const match = asset.raw.match(regex);
  return withResult(
    c,
    match ? "PASS" : "FAIL",
    evidence(
      "extract",
      `content:${asset.id}`,
      match ? `pattern "${claim.pattern}" matched in content ${asset.id}: "${match[0].slice(0, 100)}"` : `pattern "${claim.pattern}" did not match in content ${asset.id}`,
    ),
  );
}

// ---- dispatch ----

// D6.A: dispatches every criterion whose locator addresses a ContentMethod - onchain/data/code
// locators pass through untouched (m3-onchain.ts / m3-data.ts / m3-code.ts handle those in the
// same pipeline, see src/routes/verify.ts).
export function applyContentChecks(criteria: Criterion[], sealed: ContentDeliverableSealed | undefined, rejections: QuarantineRejection[]): Criterion[] {
  const rejectionByKey = new Map(rejections.map((r) => [`${r.method}[${r.index}]`, r]));
  const assets = sealed?.content ?? [];

  return criteria.map((c) => {
    const locator = c.locator;
    if (!locator || !isContentMethod(locator.method)) return c;
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
      case "content.presence":
        return checkPresence(c, claim as ContentPresenceClaim, assets);
      case "content.format":
        return checkFormat(c, claim as ContentFormatClaim, assets);
      case "content.bounds":
        return checkBounds(c, claim as ContentBoundsClaim, assets);
      case "content.pattern":
        return checkPattern(c, claim as ContentPatternClaim, assets);
    }
  });
}
