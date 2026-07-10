import type { Criterion, VerdictResult } from "../verdict/types.js";

export interface HeadlineResult {
  headline: VerdictResult;
  headline_basis: string[];
}

// VERDICT_SPEC.md §4 (locked decision L11, CLAUDE.md §1). Pure function of the Tier 1-2
// criteria (S). An EXPLICIT FAIL in S sinks the headline to FAIL; an INFERRED-only FAIL
// (no EXPLICIT FAIL present) is capped at PARTIAL - our own inference being wrong is not
// the same signal as an unmet stated requirement.
export function computeHeadline(criteria: Criterion[]): HeadlineResult {
  const scored = criteria.filter((c) => c.tier === 1 || c.tier === 2);
  const headline_basis = scored.map((c) => c.id);

  if (scored.length === 0) {
    return { headline: "UNVERIFIABLE", headline_basis };
  }
  if (scored.some((c) => c.result === "FAIL" && c.source === "EXPLICIT")) {
    return { headline: "FAIL", headline_basis };
  }
  if (scored.every((c) => c.result === "PASS")) {
    return { headline: "PASS", headline_basis };
  }
  return { headline: "PARTIAL", headline_basis };
}
