// Mirrors src/verdict/types.ts (the backend's source of truth, docs/VERDICT_SPEC.md §1-2).
// Hand-kept in sync rather than shared across the package boundary — this is a display type,
// not a contract the frontend enforces.
export type VerdictResult = "PASS" | "FAIL" | "PARTIAL" | "UNVERIFIABLE";
export type CriterionSource = "EXPLICIT" | "INFERRED";

export interface Criterion {
  id: string;
  text: string;
  source: CriterionSource;
  inference_note?: string;
  tier: 1 | 2 | 3;
  method: string | null;
  result: VerdictResult;
  confidence: number | null;
  evidence: { kind: string; ref: string; detail: string };
}

export interface Verdict {
  vidimus_version: string;
  job_id: string;
  subject: { spec_hash: string; deliverable_hash: string; deliverable_kind: string };
  criteria: Criterion[];
  headline: VerdictResult;
  headline_basis: string[];
  summary: string;
  ruleset_version: string;
  issued_at: string;
  signer: { erc8004_id: string; address: string };
  signature: string;
}

export interface Settlement {
  status: "success" | "pending";
  transaction: string;
  amount: string;
  payer: string;
}

export interface DemoCaseOption {
  id: string;
  label: string;
}

export interface DemoStatus {
  enabled: boolean;
  cooldownRemainingSeconds: number;
  dailyRemaining: number;
  priceAtomic: string;
  agentId: string;
  cases?: DemoCaseOption[];
  defaultCase?: string;
}
