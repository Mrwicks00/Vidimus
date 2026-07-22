// M4 content checkers - Tier-1 mechanical (docs/ROADMAP.md D6.A) plus Tier-2 grounded judgments
// (docs/VERIFICATION_MODULES.md M4 "Tier-2"). `content.presence`, `content.format`,
// `content.bounds`, `content.pattern` are confidence 1.0, mechanical, no semantic/quality/
// topicality judgment (that hard line is what keeps them Tier 1, per CLAUDE.md L4).
// `content.coverage`, `content.source_grounding`, `content.no_hallucination` are Tier-2: real
// semantic judgment over the asset text (and, for the latter two, fetched sources), calibrated
// confidence instead of a flat 1.0, every non-UNVERIFIABLE result carrying `evidence.kind =
// "source_check"` with a concrete pointer per that doc's own requirement.
//
// Same claim-addressing grammar as M3.A/B/C (docs/VERDICT_SPEC.md §2.2): a criterion's `locator`
// points at `deliverable.content[method][index]`. This module only resolves locators whose
// `method` is a ContentMethod - onchain/data/code locators pass through untouched, so all seven
// checkers compose over the same criteria[] array without stepping on each other (see
// src/routes/verify.ts).
//
// Extraction boundary: mirrors m3-data.ts for the Tier-1 four. Pass-1 structural extraction
// (word/line/section counts, heading list, JSON parse, CSV header parse) happens once in
// src/security/quarantine.ts's `extractContentAsset`, producing a `ContentFactSet` that crosses
// the seal - this module never re-parses raw bytes into a *different* structural interpretation
// than what quarantine already computed, it only reads the FactSet's precomputed fields (plus
// `raw` for literal/pattern substring search and as the Tier-2 checkers' LLM-extraction input,
// both inert data, never executed or instruction-followed). The Tier-2 checkers additionally
// touch the network (src/security/source-fetch.ts, itself SSRF-guarded) and an LLM
// (src/modules/m4-content-grounding.ts, canary-protected same as M2) - this is why
// `applyContentChecks` is async, unlike its Tier-1-only predecessor.
import { isContentMethod, type Criterion, type Evidence } from "../verdict/types.js";
import type { QuarantineRejection } from "../security/quarantine.js";
import { fetchSourceText } from "../security/source-fetch.js";
import { extractCoverage, extractGrounding, type GroundingClaimResult, type GroundingSource } from "./m4-content-grounding.js";
import { InjectionSuspectedError } from "./m2-criteria-compiler.js";

function evidence(kind: Evidence["kind"], ref: string, detail: string): Evidence {
  return { kind, ref, detail: detail.slice(0, 500) };
}

function withResult(c: Criterion, result: Criterion["result"], ev: Evidence): Criterion {
  return { ...c, result, confidence: result === "UNVERIFIABLE" ? null : 1.0, evidence: ev };
}

// Tier-2 variant of withResult: confidence is the model's own calibrated float (docs/
// VERIFICATION_MODULES.md's "Tier 2: (0,1), calibrated"), not a hardcoded 1.0 - used only by
// content.coverage, whose extraction schema actually emits one. source_grounding/
// no_hallucination aggregate discrete per-claim booleans instead (see their checkers below), so
// they reuse the plain withResult like the Tier-1 four.
function withTier2Result(c: Criterion, result: Criterion["result"], confidence: number, ev: Evidence): Criterion {
  return { ...c, result, confidence: result === "UNVERIFIABLE" ? null : confidence, evidence: ev };
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

// Tier-2 claim shapes (docs/VERIFICATION_MODULES.md M4 "Tier-2"). content.coverage carries
// nothing but the asset to check - the required topic comes from the criterion's own compiled
// `text`, not a buyer-declared field. source_grounding/no_hallucination declare the URL(s) to
// fetch (src/security/source-fetch.ts) - never auto-discovered from the untrusted asset text
// itself.
export interface ContentCoverageClaim {
  assetId: string;
}

export interface ContentSourceGroundingClaim {
  assetId: string;
  citedUrls: string[];
}

export interface ContentNoHallucinationClaim {
  assetId: string;
  sourceUrls?: string[]; // omitted -> UNVERIFIABLE, honestly, no ground truth to check against
}

export interface ContentDeliverable {
  content?: ContentAsset[];
  "content.presence"?: ContentPresenceClaim[];
  "content.format"?: ContentFormatClaim[];
  "content.bounds"?: ContentBoundsClaim[];
  "content.pattern"?: ContentPatternClaim[];
  "content.coverage"?: ContentCoverageClaim[];
  "content.source_grounding"?: ContentSourceGroundingClaim[];
  "content.no_hallucination"?: ContentNoHallucinationClaim[];
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
  "content.coverage"?: ContentCoverageClaim[];
  "content.source_grounding"?: ContentSourceGroundingClaim[];
  "content.no_hallucination"?: ContentNoHallucinationClaim[];
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

// ---- content.coverage ----

// Below this confidence, the model's own covered/not-covered call isn't reliable enough to
// score either way - UNVERIFIABLE, never a low-confidence guess dressed up as PASS/FAIL.
const COVERAGE_CONFIDENCE_FLOOR = 0.5;

export async function checkCoverage(c: Criterion, claim: ContentCoverageClaim, assets: ContentFactSet[], canary: string): Promise<Criterion> {
  const asset = findContentAsset(assets, claim.assetId);
  if (!asset) {
    return unverifiable(c, `content.coverage: referenced content "${claim.assetId}" was not delivered or was rejected at quarantine`);
  }

  let result;
  try {
    result = await extractCoverage(asset.raw, c.text, canary);
  } catch (err) {
    if (err instanceof InjectionSuspectedError) throw err;
    return unverifiable(c, `content.coverage: extraction failed - ${err instanceof Error ? err.message : "unknown error"}`);
  }

  if (result.confidence < COVERAGE_CONFIDENCE_FLOOR) {
    return unverifiable(c, `content.coverage: extraction confidence too low (${result.confidence.toFixed(2)}) to score reliably`);
  }
  return withTier2Result(
    c,
    result.covered ? "PASS" : "FAIL",
    result.confidence,
    evidence("source_check", `content:${asset.id}`, result.evidencePassage ?? `content ${asset.id} does not appear to cover: ${c.text}`),
  );
}

// ---- content.source_grounding / content.no_hallucination shared plumbing ----

interface FetchedSources {
  reachable: GroundingSource[];
  unreachableUrls: string[];
}

async function fetchAll(urls: string[]): Promise<FetchedSources> {
  const results = await Promise.all(urls.map(async (url) => ({ url, result: await fetchSourceText(url) })));
  const reachable: GroundingSource[] = [];
  const unreachableUrls: string[] = [];
  for (const { url, result } of results) {
    if (result.ok) reachable.push({ url, text: result.text });
    else unreachableUrls.push(`${url} (${result.reason})`);
  }
  return { reachable, unreachableUrls };
}

function summarizeGrounding(claims: GroundingClaimResult[]): { grounded: number; contradicted: GroundingClaimResult[] } {
  return { grounded: claims.filter((cl) => cl.supported === true).length, contradicted: claims.filter((cl) => cl.supported === false) };
}

// ---- content.source_grounding ----

export async function checkSourceGrounding(c: Criterion, claim: ContentSourceGroundingClaim, assets: ContentFactSet[], canary: string): Promise<Criterion> {
  const asset = findContentAsset(assets, claim.assetId);
  if (!asset) {
    return unverifiable(c, `content.source_grounding: referenced content "${claim.assetId}" was not delivered or was rejected at quarantine`);
  }

  const { reachable, unreachableUrls } = await fetchAll(claim.citedUrls);
  if (unreachableUrls.length > 0) {
    // A cited source that doesn't exist/can't be reached is the failure mode this method exists
    // to catch - report it directly, don't silently drop it and grade only what did resolve.
    return withResult(c, "FAIL", evidence("source_check", `content:${asset.id}`, `cited source(s) unreachable: ${unreachableUrls.join("; ")}`));
  }

  let claims: GroundingClaimResult[];
  try {
    claims = await extractGrounding(asset.raw, reachable, canary);
  } catch (err) {
    if (err instanceof InjectionSuspectedError) throw err;
    return unverifiable(c, `content.source_grounding: extraction failed - ${err instanceof Error ? err.message : "unknown error"}`);
  }
  if (claims.length === 0) {
    return unverifiable(c, `content.source_grounding: no citation-backed claim found in content ${asset.id} to check`);
  }

  const { grounded, contradicted } = summarizeGrounding(claims);
  if (contradicted.length > 0) {
    return withResult(c, "FAIL", evidence("source_check", `content:${asset.id}`, `contradicted by cited source(s): ${contradicted.map((cl) => cl.text).join("; ")}`));
  }
  const allGrounded = grounded === claims.length;
  return withResult(
    c,
    allGrounded ? "PASS" : "PARTIAL",
    evidence("source_check", `content:${asset.id}`, `${grounded}/${claims.length} claim(s) supported by the cited source(s)`),
  );
}

// ---- content.no_hallucination ----

export async function checkNoHallucination(c: Criterion, claim: ContentNoHallucinationClaim, assets: ContentFactSet[], canary: string): Promise<Criterion> {
  const asset = findContentAsset(assets, claim.assetId);
  if (!asset) {
    return unverifiable(c, `content.no_hallucination: referenced content "${claim.assetId}" was not delivered or was rejected at quarantine`);
  }
  if (!claim.sourceUrls || claim.sourceUrls.length === 0) {
    return unverifiable(c, `content.no_hallucination: no source provided to ground claims against`);
  }

  const { reachable, unreachableUrls } = await fetchAll(claim.sourceUrls);
  if (reachable.length === 0) {
    return unverifiable(c, `content.no_hallucination: none of the provided source(s) were reachable: ${unreachableUrls.join("; ")}`);
  }

  let claims: GroundingClaimResult[];
  try {
    claims = await extractGrounding(asset.raw, reachable, canary);
  } catch (err) {
    if (err instanceof InjectionSuspectedError) throw err;
    return unverifiable(c, `content.no_hallucination: extraction failed - ${err instanceof Error ? err.message : "unknown error"}`);
  }
  if (claims.length === 0) {
    return unverifiable(c, `content.no_hallucination: no factual claim found in content ${asset.id} to check`);
  }

  const { grounded, contradicted } = summarizeGrounding(claims);
  if (contradicted.length > 0) {
    return withResult(c, "FAIL", evidence("source_check", `content:${asset.id}`, `invented/contradicted claim(s): ${contradicted.map((cl) => cl.text).join("; ")}`));
  }
  const allGrounded = grounded === claims.length;
  return withResult(
    c,
    allGrounded ? "PASS" : "PARTIAL",
    evidence("source_check", `content:${asset.id}`, `${grounded}/${claims.length} claim(s) grounded in the provided source(s)`),
  );
}

// ---- single-asset auto-wire ----

// Fixes a real customer-facing gap (OKX ASP review): `content.coverage[]` / `content.no_hallucination[]`
// carry nothing but `{ assetId }` - per those methods' own claim schemas (src/security/
// quarantine.ts), the actual topic/criterion comes from the compiled criterion text itself, not
// anything buyer-declared. So when a submission has exactly one content asset, there is zero
// ambiguity about which asset every content criterion should check - requiring a buyer to also
// send a second, positionally-indexed array that only ever points back at the one asset they
// already gave us is pure undocumented friction, not a real safety/disambiguation need. Only
// fires for the two assetId-only methods; content.presence/format/bounds/pattern/source_grounding
// all need real buyer-supplied fields (a target, a metric, a pattern name, real citation URLs)
// that can't be safely invented, so those are untouched and correctly stay UNVERIFIABLE without
// an explicit claim. Never overwrites an existing claim (explicit or quarantine-rejected) at a
// given index - only fills a slot that was never submitted at all.
const AUTO_FILLABLE_METHODS = ["content.coverage", "content.no_hallucination"] as const;

export function autoFillSingleAssetContentClaims(
  criteria: Criterion[],
  sealed: ContentDeliverableSealed | undefined,
  rejections: QuarantineRejection[],
): ContentDeliverableSealed | undefined {
  if (!sealed || sealed.content.length !== 1) return sealed;
  const assetId = sealed.content[0]!.id;
  const rejectedKeys = new Set(rejections.map((r) => `${r.method}[${r.index}]`));

  const filled: ContentDeliverableSealed = { ...sealed };
  for (const method of AUTO_FILLABLE_METHODS) {
    const neededLength = criteria.reduce((max, c) => (c.locator?.method === method ? Math.max(max, c.locator.index + 1) : max), 0);
    if (neededLength === 0) continue;
    const existing = sealed[method] ?? [];
    const next = existing.slice();
    for (let i = 0; i < neededLength; i++) {
      if (next[i] === undefined && !rejectedKeys.has(`${method}[${i}]`)) {
        next[i] = { assetId };
      }
    }
    (filled[method] as unknown[]) = next;
  }
  return filled;
}

// ---- dispatch ----

// Dispatches every criterion whose locator addresses a ContentMethod - onchain/data/code
// locators pass through untouched (m3-onchain.ts / m3-data.ts / m3-code.ts handle those in the
// same pipeline, see src/routes/verify.ts). Async (unlike the Tier-1-only predecessor) because
// the Tier-2 checkers touch the network and an LLM. `canary` is the same per-job secret
// compileCriteria already used (src/routes/verify.ts) - reused, not re-minted, since the
// security property (never echo it) doesn't depend on which untrusted surface carried the
// injection attempt.
export async function applyContentChecks(
  criteria: Criterion[],
  sealed: ContentDeliverableSealed | undefined,
  rejections: QuarantineRejection[],
  canary: string,
): Promise<Criterion[]> {
  const rejectionByKey = new Map(rejections.map((r) => [`${r.method}[${r.index}]`, r]));
  const assets = sealed?.content ?? [];

  return Promise.all(
    criteria.map(async (c): Promise<Criterion> => {
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
        case "content.coverage":
          return checkCoverage(c, claim as ContentCoverageClaim, assets, canary);
        case "content.source_grounding":
          return checkSourceGrounding(c, claim as ContentSourceGroundingClaim, assets, canary);
        case "content.no_hallucination":
          return checkNoHallucination(c, claim as ContentNoHallucinationClaim, assets, canary);
      }
    }),
  );
}
