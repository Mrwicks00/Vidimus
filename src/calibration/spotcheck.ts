// D6.B reproducibility spot-check (docs/ARCHITECTURE.md §5 / this session's brief): substantiates
// the core claim a Tier-1 confidence=1.0 verdict makes - that an independent party can re-run the
// same checker against the same inputs and get the same result.
//
// Deliberately bypasses M2 (`compileCriteria`) entirely. M2 is the only non-deterministic
// component in the pipeline (an LLM call) - its own reproducibility is a separate, already-
// tracked axis (the m2-bias-cases.ts pinned regression suite), not what this slice is proving.
// This module re-runs the *checker dispatch* directly against a synthetic single-criterion array
// carrying only the logged {method, tier, locator} - the same production dispatch functions used
// in src/routes/verify.ts, not a parallel reimplementation, so a pass here proves the actual
// production code path is deterministic.
//
// Caveat, not hidden: `data.sample_verify`'s seed is derived from a chain-tip block read strictly
// after quarantine (docs/SECURITY.md §4.1) - re-running it later reads a different block, so it
// will not reproduce the identical sample by construction (correct sampling behavior, not a spot-
// check bug). The calibration log doesn't retain `seed_ref` (evidence.kind-only, see types.ts),
// so this mechanism is exercised in the PROOF gate against a `content.*` criterion instead - no
// time-varying input, the cleanest honest demonstration.
import { createHash } from "node:crypto";
import {
  quarantineDeliverable,
  quarantineDataDeliverable,
  quarantineCodeDeliverable,
  quarantineContentDeliverable,
} from "../security/quarantine.js";
import { applyOnchainChecks, type OnchainDeliverable } from "../modules/m3-onchain.js";
import { applyDataChecks, type DataDeliverable } from "../modules/m3-data.js";
import { applyCodeChecks, type CodeDeliverable } from "../modules/m3-code.js";
import { applyContentChecks, type ContentDeliverable } from "../modules/m3-content.js";
import { canonicalize } from "../verdict/canonicalize.js";
import { isOnchainMethod, isDataMethod, isCodeMethod, isContentMethod, type Criterion } from "../verdict/types.js";
import type { CalibrationCriterionEntry } from "./types.js";

export interface RawDeliverable {
  onchain?: OnchainDeliverable;
  data?: DataDeliverable;
  code?: CodeDeliverable;
  content?: ContentDeliverable;
}

export interface SpotCheckResult {
  criterion_id: string;
  method: string | null;
  logged_result: string;
  recomputed_result: string;
  matches: boolean;
  skipped_reason?: string; // set (matches=false, no comparison made) when the method isn't Tier-1-locatable
}

function syntheticCriterion(entry: CalibrationCriterionEntry): Criterion {
  return {
    id: entry.id,
    text: "spot-check synthetic criterion (M2 not re-run)",
    source: "EXPLICIT",
    tier: entry.tier,
    method: entry.method,
    locator: entry.locator ?? undefined,
    result: "UNVERIFIABLE",
    confidence: null,
    evidence: { kind: "none", ref: "", detail: "not yet re-verified" },
  };
}

/**
 * Re-runs the single logged criterion through the real Tier-1 checker dispatch for its method
 * family, against a freshly re-quarantined copy of the same raw deliverable, and compares results.
 */
export async function spotCheckCriterion(entry: CalibrationCriterionEntry, rawDeliverable: RawDeliverable): Promise<SpotCheckResult> {
  const base = { criterion_id: entry.id, method: entry.method, logged_result: entry.result };

  if (entry.tier !== 1 || !entry.locator) {
    return { ...base, recomputed_result: "N/A", matches: false, skipped_reason: "not a Tier-1 locator-bound criterion - not reproducible by this mechanism" };
  }
  const method = entry.locator.method;
  const criteria = [syntheticCriterion(entry)];

  if (isOnchainMethod(method)) {
    const { deliverable: sealed, rejected } = quarantineDeliverable(rawDeliverable.onchain);
    const [result] = await applyOnchainChecks(criteria, sealed, rejected);
    return { ...base, recomputed_result: result!.result, matches: result!.result === entry.result };
  }
  if (isDataMethod(method)) {
    const { sealed, rejected } = quarantineDataDeliverable(rawDeliverable.data);
    // deliverableHash: fine to derive fresh here (only feeds the sample_verify seed, which this
    // mechanism already can't reproduce exactly - see module note above); schema/rowcount are
    // unaffected by its value.
    const deliverableHash = `sha256:${createHash("sha256").update(canonicalize(rawDeliverable), "utf8").digest("hex")}`;
    const [result] = await applyDataChecks(criteria, sealed, rejected, deliverableHash);
    return { ...base, recomputed_result: result!.result, matches: result!.result === entry.result };
  }
  if (isCodeMethod(method)) {
    const { sealed, rejected } = quarantineCodeDeliverable(rawDeliverable.code);
    const [result] = await applyCodeChecks(criteria, sealed, rejected);
    return { ...base, recomputed_result: result!.result, matches: result!.result === entry.result };
  }
  if (isContentMethod(method)) {
    const { sealed, rejected } = quarantineContentDeliverable(rawDeliverable.content);
    // Tier-2 content methods never reach here - the `entry.tier !== 1` guard above already
    // returned. Tier-1 content checkers never read `canary` at all, so the empty string is
    // inert; there's no real per-job canary to reuse in this M2-bypassing spot-check path.
    const [result] = await applyContentChecks(criteria, sealed, rejected, "");
    return { ...base, recomputed_result: result!.result, matches: result!.result === entry.result };
  }
  return { ...base, recomputed_result: "N/A", matches: false, skipped_reason: `method ${method} has no known Tier-1 dispatcher` };
}
