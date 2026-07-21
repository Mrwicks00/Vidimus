// Unit tests for M4 Tier-1 content checkers (docs/ROADMAP.md D6.A). All pure/offline - no live
// call of any kind, same posture as m3-data.ts's schema/rowcount tests and m3-code.ts's parsing
// tests. Two levels: (1) the individual checker functions against hand-built ContentFactSets,
// (2) the full quarantine -> applyContentChecks pipeline, including the adversarial case that
// exercises the D4.5 locator-resolution contract for this new method family.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyContentChecks,
  checkBounds,
  checkCoverage,
  checkFormat,
  checkNoHallucination,
  checkPattern,
  checkPresence,
  checkSourceGrounding,
  type ContentDeliverableSealed,
  type ContentFactSet,
} from "./m3-content.js";
import { quarantineContentDeliverable } from "../security/quarantine.js";
import type { Criterion } from "../verdict/types.js";

let seq = 0;
function criterion(method: Criterion["method"], index: number, source: Criterion["source"] = "EXPLICIT", tier: Criterion["tier"] = 1): Criterion {
  seq += 1;
  return {
    id: `c${seq}`,
    text: "fixture criterion",
    source,
    tier,
    method,
    locator: method ? { method: method as NonNullable<Criterion["locator"]>["method"], index } : undefined,
    result: "UNVERIFIABLE",
    confidence: null,
    evidence: { kind: "none", ref: "", detail: "compiled, not yet verified" },
  };
}

function factSet(overrides: Partial<ContentFactSet> & { id: string; format: ContentFactSet["format"]; raw: string }): ContentFactSet {
  const raw = overrides.raw;
  return {
    wordCount: raw.trim() === "" ? 0 : raw.trim().split(/\s+/).length,
    charCount: raw.length,
    lineCount: raw.split("\n").length,
    sectionCount: 0,
    headings: [],
    json: { ok: false, error: "not set by fixture" },
    csv: { ok: false, error: "not set by fixture" },
    ...overrides,
  };
}

// ---- content.presence ----

test("content.presence: heading found -> PASS", () => {
  const c = criterion("content.presence", 0);
  const asset = factSet({ id: "a1", format: "markdown", raw: "# Title\n\n## Risk Disclosure\ntext", headings: ["Title", "Risk Disclosure"], sectionCount: 2 });
  const result = checkPresence(c, { assetId: "a1", target: { kind: "heading", value: "Risk Disclosure" } }, [asset]);
  assert.equal(result.result, "PASS");
  assert.equal(result.confidence, 1.0);
  assert.equal(result.evidence.kind, "extract");
});

test("content.presence: heading absent -> FAIL (mechanical evidence of absence, not UNVERIFIABLE)", () => {
  const c = criterion("content.presence", 0);
  const asset = factSet({ id: "a1", format: "markdown", raw: "# Title\ntext", headings: ["Title"], sectionCount: 1 });
  const result = checkPresence(c, { assetId: "a1", target: { kind: "heading", value: "Risk Disclosure" } }, [asset]);
  assert.equal(result.result, "FAIL");
});

test("content.presence: literal string search works regardless of declared format", () => {
  const c = criterion("content.presence", 0);
  const asset = factSet({ id: "a1", format: "text", raw: "please contact support@example.com for help" });
  const found = checkPresence(c, { assetId: "a1", target: { kind: "literal", value: "support@example.com" } }, [asset]);
  assert.equal(found.result, "PASS");
  const notFound = checkPresence(c, { assetId: "a1", target: { kind: "literal", value: "phone number" } }, [asset]);
  assert.equal(notFound.result, "FAIL");
});

test("content.presence: json_key nested dot-path found and not found", () => {
  const c = criterion("content.presence", 0);
  const asset = factSet({
    id: "a1",
    format: "json",
    raw: '{"delivery":{"status":"complete"}}',
    json: { ok: true, value: { delivery: { status: "complete" } } },
  });
  const found = checkPresence(c, { assetId: "a1", target: { kind: "json_key", value: "delivery.status" } }, [asset]);
  assert.equal(found.result, "PASS");
  const notFound = checkPresence(c, { assetId: "a1", target: { kind: "json_key", value: "delivery.eta" } }, [asset]);
  assert.equal(notFound.result, "FAIL");
});

test("content.presence: csv_column found and not found", () => {
  const c = criterion("content.presence", 0);
  const asset = factSet({ id: "a1", format: "csv", raw: "tokenId,owner\n1,0xabc", csv: { ok: true, header: ["tokenId", "owner"], duplicates: [] } });
  const found = checkPresence(c, { assetId: "a1", target: { kind: "csv_column", value: "owner" } }, [asset]);
  assert.equal(found.result, "PASS");
  const notFound = checkPresence(c, { assetId: "a1", target: { kind: "csv_column", value: "timestamp" } }, [asset]);
  assert.equal(notFound.result, "FAIL");
});

test("content.presence: kind/format mismatch (heading target on a csv asset) -> UNVERIFIABLE, never a guess", () => {
  const c = criterion("content.presence", 0);
  const asset = factSet({ id: "a1", format: "csv", raw: "tokenId,owner\n1,0xabc", csv: { ok: true, header: ["tokenId", "owner"], duplicates: [] } });
  const result = checkPresence(c, { assetId: "a1", target: { kind: "heading", value: "Risk Disclosure" } }, [asset]);
  assert.equal(result.result, "UNVERIFIABLE");
});

test("content.presence: referenced asset not delivered -> UNVERIFIABLE", () => {
  const c = criterion("content.presence", 0);
  const result = checkPresence(c, { assetId: "missing", target: { kind: "literal", value: "x" } }, []);
  assert.equal(result.result, "UNVERIFIABLE");
});

// ---- ADVERSARIAL CASE (gate 3a): a semantically-plausible-but-mechanically-absent claim must
// resolve UNVERIFIABLE, never PASS. The document genuinely contains the required heading - a
// human skimming it would say "yes, it's there" - but the deliverable never submits a matching
// content.presence *claim* for this criterion's locator slot. Per the D4.5 locator-resolution
// contract (VERDICT_SPEC.md §2.2), the checker must never freelance-search the raw asset for
// what "seems" satisfied; it only resolves the declared, quarantined claim. This is the hard
// line that keeps Tier-1 content mechanical: no smuggled semantic reading of the document.
test("ADVERSARIAL: heading genuinely present in the document, but no content.presence claim submitted -> UNVERIFIABLE, never PASS", async () => {
  const c = criterion("content.presence", 0);
  const raw = {
    content: [{ id: "a1", format: "markdown" as const, content: "# Report\n\n## Risk Disclosure\nThis product carries risk of loss.\n" }],
    // Deliberately no "content.presence" claims array at all - the buyer never declared a claim
    // for this criterion, even though the heading is unmistakably present in the raw document.
  };
  const { sealed, rejected } = quarantineContentDeliverable(raw);
  assert.ok(sealed);
  assert.equal(sealed!.content[0]!.headings.includes("Risk Disclosure"), true, "sanity: the heading really is in the extracted FactSet");
  const [result] = await applyContentChecks([c], sealed, rejected, "");
  assert.equal(result!.result, "UNVERIFIABLE", "must not guess PASS by reading the document itself - only the declared claim may be trusted");
  assert.equal(result!.evidence.kind, "none");
});

// ---- content.format ----

test("content.format: json PASS when it parses, FAIL when it doesn't", () => {
  const c = criterion("content.format", 0);
  const good = factSet({ id: "a1", format: "json", raw: '{"a":1}', json: { ok: true, value: { a: 1 } } });
  assert.equal(checkFormat(c, { assetId: "a1" }, [good]).result, "PASS");
  const bad = factSet({ id: "a1", format: "json", raw: "{not json", json: { ok: false, error: "Unexpected token" } });
  assert.equal(checkFormat(c, { assetId: "a1" }, [bad]).result, "FAIL");
});

test("content.format: csv PASS on clean header, FAIL on duplicate columns or no header", () => {
  const c = criterion("content.format", 0);
  const clean = factSet({ id: "a1", format: "csv", raw: "a,b\n1,2", csv: { ok: true, header: ["a", "b"], duplicates: [] } });
  assert.equal(checkFormat(c, { assetId: "a1" }, [clean]).result, "PASS");
  const dup = factSet({ id: "a1", format: "csv", raw: "a,a\n1,2", csv: { ok: true, header: ["a", "a"], duplicates: ["a"] } });
  assert.equal(checkFormat(c, { assetId: "a1" }, [dup]).result, "FAIL");
  const noHeader = factSet({ id: "a1", format: "csv", raw: "", csv: { ok: false, error: "no header row found" } });
  assert.equal(checkFormat(c, { assetId: "a1" }, [noHeader]).result, "FAIL");
});

test("content.format: markdown PASS with at least one heading, FAIL with none", () => {
  const c = criterion("content.format", 0);
  const withHeading = factSet({ id: "a1", format: "markdown", raw: "# Title\ntext", sectionCount: 1, headings: ["Title"] });
  assert.equal(checkFormat(c, { assetId: "a1" }, [withHeading]).result, "PASS");
  const noHeading = factSet({ id: "a1", format: "markdown", raw: "just prose, no headings", sectionCount: 0, headings: [] });
  assert.equal(checkFormat(c, { assetId: "a1" }, [noHeading]).result, "FAIL");
});

test("content.format: text always PASS - nothing structural to validate", () => {
  const c = criterion("content.format", 0);
  const asset = factSet({ id: "a1", format: "text", raw: "anything at all" });
  assert.equal(checkFormat(c, { assetId: "a1" }, [asset]).result, "PASS");
});

// ---- content.bounds ----

test("content.bounds: word_count within range -> PASS", () => {
  const c = criterion("content.bounds", 0);
  const asset = factSet({ id: "a1", format: "text", raw: "one two three four five" });
  const result = checkBounds(c, { assetId: "a1", metric: "word_count", min: 3, max: 10 }, [asset]);
  assert.equal(result.result, "PASS");
});

test("content.bounds: below min -> FAIL, evidence quantifies the shortfall", () => {
  const c = criterion("content.bounds", 0);
  const asset = factSet({ id: "a1", format: "text", raw: "one two" });
  const result = checkBounds(c, { assetId: "a1", metric: "word_count", min: 500 }, [asset]);
  assert.equal(result.result, "FAIL");
  assert.match(result.evidence.detail, /short by 498/);
});

test("content.bounds: above max -> FAIL, evidence quantifies the overage", () => {
  const c = criterion("content.bounds", 0);
  const asset = factSet({ id: "a1", format: "text", raw: "one two three four five six" });
  const result = checkBounds(c, { assetId: "a1", metric: "word_count", max: 3 }, [asset]);
  assert.equal(result.result, "FAIL");
  assert.match(result.evidence.detail, /over by 3/);
});

// ---- content.pattern ----

test("content.pattern: vetted pattern match/no-match", () => {
  const c = criterion("content.pattern", 0);
  const withEmail = factSet({ id: "a1", format: "text", raw: "reach us at hello@example.com anytime" });
  assert.equal(checkPattern(c, { assetId: "a1", pattern: "email" }, [withEmail]).result, "PASS");
  const withoutEmail = factSet({ id: "a1", format: "text", raw: "no contact info here" });
  assert.equal(checkPattern(c, { assetId: "a1", pattern: "email" }, [withoutEmail]).result, "FAIL");
});

// ---- Tier-2: content.coverage / content.source_grounding / content.no_hallucination ----
// Only the deterministic, network-free paths are covered here - live LLM/fetch calls are
// exercised via the manual local-server check, same convention as m2-criteria-compiler.test.ts
// keeping live model calls out of the default suite. Unreachable-URL cases below use a private/
// loopback address specifically so source-fetch.ts's SSRF guard rejects them before any network
// call, keeping these tests offline too.

test("content.coverage: missing/unresolved asset -> UNVERIFIABLE, never a guess", async () => {
  const c = criterion("content.coverage", 0, "EXPLICIT", 2);
  const result = await checkCoverage(c, { assetId: "does-not-exist" }, [], "canary");
  assert.equal(result.result, "UNVERIFIABLE");
  assert.equal(result.confidence, null);
});

test("content.source_grounding: missing/unresolved asset -> UNVERIFIABLE, never a guess", async () => {
  const c = criterion("content.source_grounding", 0, "EXPLICIT", 2);
  const result = await checkSourceGrounding(c, { assetId: "does-not-exist", citedUrls: ["https://example.com/a"] }, [], "canary");
  assert.equal(result.result, "UNVERIFIABLE");
});

test("content.source_grounding: unreachable cited URL -> FAIL, names the URL, never silently dropped", async () => {
  const c = criterion("content.source_grounding", 0, "EXPLICIT", 2);
  const asset = factSet({ id: "a1", format: "text", raw: "Per our source, the sky is blue." });
  const result = await checkSourceGrounding(c, { assetId: "a1", citedUrls: ["http://127.0.0.1:1/unreachable"] }, [asset], "canary");
  assert.equal(result.result, "FAIL");
  assert.match(result.evidence.detail, /unreachable/);
  assert.equal(result.evidence.kind, "source_check");
});

test("content.no_hallucination: missing/unresolved asset -> UNVERIFIABLE, never a guess", async () => {
  const c = criterion("content.no_hallucination", 0, "EXPLICIT", 2);
  const result = await checkNoHallucination(c, { assetId: "does-not-exist" }, [], "canary");
  assert.equal(result.result, "UNVERIFIABLE");
});

test("content.no_hallucination: no sourceUrls provided -> UNVERIFIABLE, honestly, no ground truth given", async () => {
  const c = criterion("content.no_hallucination", 0, "EXPLICIT", 2);
  const asset = factSet({ id: "a1", format: "text", raw: "Some claims with no source attached." });
  const result = await checkNoHallucination(c, { assetId: "a1" }, [asset], "canary");
  assert.equal(result.result, "UNVERIFIABLE");
});

test("content.no_hallucination: all sourceUrls unreachable -> UNVERIFIABLE, not a guess in either direction", async () => {
  const c = criterion("content.no_hallucination", 0, "EXPLICIT", 2);
  const asset = factSet({ id: "a1", format: "text", raw: "Some claims citing an unreachable source." });
  const result = await checkNoHallucination(c, { assetId: "a1", sourceUrls: ["http://127.0.0.1:1/unreachable"] }, [asset], "canary");
  assert.equal(result.result, "UNVERIFIABLE");
});

// ---- dispatch / cross-family passthrough ----

test("applyContentChecks: onchain/data/code-locator criteria pass through untouched", async () => {
  const onchainCriterion = criterion("onchain.tx_exists", 0);
  const result = await applyContentChecks([onchainCriterion], undefined, [], "");
  assert.deepEqual(result[0], onchainCriterion);
});

test("applyContentChecks: locator doesn't resolve (claim array present but short) -> UNVERIFIABLE, never FAIL", async () => {
  const c = criterion("content.bounds", 1); // index 1, but only one claim will be sealed below
  const sealed: ContentDeliverableSealed = {
    content: [factSet({ id: "a1", format: "text", raw: "hello world" })],
    "content.bounds": [{ assetId: "a1", metric: "word_count", min: 1 }],
  };
  const [result] = await applyContentChecks([c], sealed, [], "");
  assert.equal(result!.result, "UNVERIFIABLE");
});

// ---- quarantine round-trip (D6.A) ----

test("quarantineContentDeliverable: extracts word/line/section counts and headings from a markdown asset", () => {
  const raw = {
    content: [{ id: "a1", format: "markdown", content: "# Title\nsome body text here\n\n## Section Two\nmore text" }],
  };
  const { sealed } = quarantineContentDeliverable(raw);
  assert.ok(sealed);
  const asset = sealed!.content[0]!;
  assert.equal(asset.sectionCount, 2);
  assert.deepEqual(asset.headings, ["Title", "Section Two"]);
  assert.ok(asset.wordCount > 0);
});

test("quarantineContentDeliverable: malformed claim is rejected, positional slot preserved as undefined", () => {
  const raw = {
    content: [{ id: "a1", format: "text", content: "hello" }],
    "content.bounds": [{ assetId: "a1", metric: "word_count" }], // neither min nor max - schema refine should reject
  };
  const { sealed, rejected } = quarantineContentDeliverable(raw);
  assert.ok(sealed);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0]!.method, "content.bounds");
  assert.equal(sealed!["content.bounds"]![0], undefined);
});

test("quarantineContentDeliverable: content.pattern only accepts the vetted pattern enum, never an arbitrary regex string", () => {
  const raw = {
    content: [{ id: "a1", format: "text", content: "hello" }],
    "content.pattern": [{ assetId: "a1", pattern: "(a+)+$" }], // attacker-supplied "regex" - must be rejected by the enum, not compiled
  };
  const { rejected } = quarantineContentDeliverable(raw);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0]!.method, "content.pattern");
});

test("quarantineContentDeliverable: oversized content asset is rejected outright, never truncated", () => {
  const raw = {
    content: [{ id: "a1", format: "text", content: "x".repeat(1_000_001) }],
  };
  const { sealed } = quarantineContentDeliverable(raw);
  assert.ok(sealed);
  assert.equal(sealed!.content.length, 0, "oversized asset dropped, not truncated and kept");
});
