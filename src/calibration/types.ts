// D6.B calibration log schema (docs/ARCHITECTURE.md §5, P4 asset - see design note there for
// why this supersedes that doc's earlier conceptual sketch). One row per issued verdict,
// appended after signing (src/routes/verify.ts), never mutated after.
//
// Deliberately carries evidence.kind only, never evidence.ref/detail - those can hold
// deliverable-derived text (a quoted heading, a sample value), and a permanent audit log
// retaining a second, ungoverned copy of quarantined content is a hygiene problem this
// project's own posture (docs/SECURITY.md) argues against. `evidence.kind` alone is enough to
// prove the FAIL-vs-UNVERIFIABLE honesty claim this slice exists for.
import type { ClaimLocator, EvidenceKind, Method, Tier, Verdict, VerdictResult } from "../verdict/types.js";

export interface CalibrationCriterionEntry {
  id: string;
  method: Method | null;
  tier: Tier;
  confidence: number | null;
  result: VerdictResult;
  evidence_kind: EvidenceKind;
  locator: ClaimLocator | null;
}

export interface CalibrationLogEntry {
  seq: number;
  logged_at: string;
  job_id: string;
  // NB: in this system payment_id already IS the x402 settlement tx hash
  // (src/x402/middleware.ts sets paymentId = settlement.transaction) - one field, not two.
  payment_id: string;
  verdict_digest: string;
  verdict_signature: string;
  signer: Verdict["signer"];
  ruleset_version: string;
  ruleset_hash: string;
  issued_at: string;
  headline: VerdictResult;
  headline_basis: string[];
  criteria: CalibrationCriterionEntry[];
  // Hash-chain integrity (see src/calibration/log.ts for the append/verify logic and the
  // design-gate justification for chaining over a per-row wallet signature).
  prev_hash: string | null;
  entry_hash: string;
}

export function toCalibrationCriterionEntry(c: Verdict["criteria"][number]): CalibrationCriterionEntry {
  return {
    id: c.id,
    method: c.method,
    tier: c.tier,
    confidence: c.confidence,
    result: c.result,
    evidence_kind: c.evidence.kind,
    locator: c.locator ?? null,
  };
}
