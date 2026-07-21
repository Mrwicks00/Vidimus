// Canonical Verdict + Criterion types. Source of truth: docs/VERDICT_SPEC.md §1-2.
// When this file and the spec disagree, the spec wins - fix this file.

export type VerdictResult = "PASS" | "FAIL" | "PARTIAL" | "UNVERIFIABLE";

export type CriterionSource = "EXPLICIT" | "INFERRED";

export type Tier = 1 | 2 | 3;

export type EvidenceKind = "tx" | "extract" | "test_output" | "sample" | "source_check" | "none";

// §3 method registry. tier is fixed per method - a criterion's tier must match its
// method's registered tier (enforced in the compiler, not left to model judgment).
export const METHOD_REGISTRY = {
  "onchain.tx_exists": 1,
  "onchain.transfer_check": 1,
  "onchain.owner_check": 1,
  "onchain.destination_check": 1,
  "onchain.safety": 1,
  "data.schema": 1,
  "data.rowcount": 1,
  "data.sample_verify": 1,
  "code.compiles": 1,
  "code.tests_pass": 1,
  "content.presence": 1,
  "content.format": 1,
  "content.bounds": 1,
  "content.pattern": 1,
  "content.coverage": 2,
  "content.source_grounding": 2,
  "content.no_hallucination": 2,
  "taste.refused": 3,
} as const satisfies Record<string, Tier>;

export type Method = keyof typeof METHOD_REGISTRY;

// D4.5 (docs/VERDICT_SPEC.md §2, dated note): the onchain methods are the only ones backed
// today by a deliverable-provided claim array a locator can index into. Single source of
// truth shared by the M2 compiler (assigns locators) and the M3 checker (resolves them) -
// see verdict/types.ts import in both.
export const ONCHAIN_METHODS = [
  "onchain.tx_exists",
  "onchain.transfer_check",
  "onchain.destination_check",
  "onchain.owner_check",
  "onchain.safety",
] as const satisfies readonly Method[];

export type OnchainMethod = (typeof ONCHAIN_METHODS)[number];

export function isOnchainMethod(method: Method | null): method is OnchainMethod {
  return method !== null && (ONCHAIN_METHODS as readonly string[]).includes(method);
}

// D5 (docs/VERDICT_SPEC.md §2.2): the data methods are the second family backed by a
// deliverable-provided claim array a locator can index into - `data.*` claims address into
// `deliverable.data`'s per-method claim arrays the same way onchain claims address into
// `deliverable.onchain`'s. Same grammar, new bucket.
export const DATA_METHODS = ["data.schema", "data.rowcount", "data.sample_verify"] as const satisfies readonly Method[];

export type DataMethod = (typeof DATA_METHODS)[number];

export function isDataMethod(method: Method | null): method is DataMethod {
  return method !== null && (DATA_METHODS as readonly string[]).includes(method);
}

// D5 M3.C (docs/VERDICT_SPEC.md §2.2): the code methods are the third family backed by a
// deliverable-provided claim array - `code.*` claims address into `deliverable.code`'s
// per-method claim arrays the same way data/onchain claims address into their own buckets.
// Same grammar, new bucket.
export const CODE_METHODS = ["code.compiles", "code.tests_pass"] as const satisfies readonly Method[];

export type CodeMethod = (typeof CODE_METHODS)[number];

export function isCodeMethod(method: Method | null): method is CodeMethod {
  return method !== null && (CODE_METHODS as readonly string[]).includes(method);
}

// D6.A (docs/VERDICT_SPEC.md §2.2): the content methods are the fourth family backed by a
// deliverable-provided claim array - `content.*` claims address into `deliverable.content`'s
// per-method claim arrays the same way onchain/data/code claims address into their own buckets.
// Same grammar, new bucket. Replaces the earlier single `content.countable` stub (D6.A design
// gate, 2026-07-11) - see docs/VERIFICATION_MODULES.md M4.
export const CONTENT_METHODS = [
  "content.presence",
  "content.format",
  "content.bounds",
  "content.pattern",
] as const satisfies readonly Method[];

export type ContentMethod = (typeof CONTENT_METHODS)[number];

export function isContentMethod(method: Method | null): method is ContentMethod {
  return method !== null && (CONTENT_METHODS as readonly string[]).includes(method);
}

// Every method family with a locator scheme today. Widen this union (and add a family-specific
// `is*Method` guard above) when a future module gets its own addressable claim array - `method`
// on `ClaimLocator` is this union, not `OnchainMethod` alone, from D5 onward.
export type LocatableMethod = OnchainMethod | DataMethod | CodeMethod | ContentMethod;

export function isLocatableMethod(method: Method | null): method is LocatableMethod {
  return isOnchainMethod(method) || isDataMethod(method) || isCodeMethod(method) || isContentMethod(method);
}

export interface Evidence {
  kind: EvidenceKind;
  ref: string;
  detail: string;
}

// D4.5: an explicit, compiler-assigned pointer into the deliverable's claim arrays, replacing
// the D3/D4 positional-cursor shortcut. `method` mirrors the owning criterion's `method`;
// `index` is the 0-based ordinal occurrence of that method among criteria[] at compile time -
// assigned once, before any deliverable exists, never recomputed downstream. See
// docs/VERDICT_SPEC.md §2 for the resolution contract. Widened D5 from `OnchainMethod` to
// `LocatableMethod` (onchain | data | code) - same grammar, more addressable buckets.
export interface ClaimLocator {
  method: LocatableMethod;
  index: number;
}

export interface Criterion {
  id: string;
  text: string;
  source: CriterionSource;
  // Required IFF source === "INFERRED" (§2, §6 rule 2: silent inference is forbidden).
  inference_note?: string;
  tier: Tier;
  // null when no registered method fits (§6 rule 4: that's UNVERIFIABLE, not a guess -
  // never invent a method string that isn't in METHOD_REGISTRY).
  method: Method | null;
  // Present iff `method` is locatable (isLocatableMethod: onchain | data | code | content,
  // D6.A). Absent for method: null and for taste.refused / content.coverage / .source_grounding
  // / .no_hallucination - no locator scheme yet (Tier 2/3, deferred post-hackathon).
  locator?: ClaimLocator;
  result: VerdictResult;
  // Tier 1: 1.0 or not really Tier 1 (§2.1). Tier 2: (0,1), calibrated. Tier 3: null.
  // Also null for any criterion whose result hasn't been computed yet (pre-verification).
  confidence: number | null;
  // REQUIRED for every non-UNVERIFIABLE result; kind "none" for UNVERIFIABLE / not-yet-run.
  evidence: Evidence;
}

export interface Verdict {
  vidimus_version: string;
  job_id: string;
  subject: {
    spec_hash: string;
    deliverable_hash: string;
    deliverable_kind: "onchain_action" | "dataset" | "code" | "content" | "mixed";
  };
  criteria: Criterion[];
  headline: VerdictResult;
  headline_basis: string[];
  summary: string;
  ruleset_version: string;
  ruleset_hash: string;
  issued_at: string;
  signer: {
    erc8004_id: string;
    address: string;
  };
  signature: string;
}
