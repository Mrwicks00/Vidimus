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
  "content.countable": 1,
  "content.coverage": 2,
  "content.source_grounding": 2,
  "content.no_hallucination": 2,
  "taste.refused": 3,
} as const satisfies Record<string, Tier>;

export type Method = keyof typeof METHOD_REGISTRY;

export interface Evidence {
  kind: EvidenceKind;
  ref: string;
  detail: string;
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
  payment_id: string;
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
