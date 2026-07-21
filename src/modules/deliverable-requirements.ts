// Groups a compiled Criterion[] into the deliverable shape a caller needs to prepare - the
// "what evidence do I need?" pre-flight this whole module exists for (docs/OKX_ASP_LISTING_GUIDE.md
// and this session's discussion: /verify only reveals the required deliverable shape *after* the
// same paid call that needed it already satisfied). Bucket names mirror the four deliverable
// buckets M3 dispatches against (src/modules/m3-*.ts) - reuses the same is*Method guards those
// checkers already rely on, not a new classification.
import {
  isOnchainMethod,
  isDataMethod,
  isCodeMethod,
  isContentMethod,
  type Criterion,
} from "../verdict/types.js";

export type DeliverableRequirements = {
  onchain?: Record<string, number>;
  data?: Record<string, number>;
  code?: Record<string, number>;
  content?: Record<string, number>;
};

const BUCKETS = [
  { key: "onchain", guard: isOnchainMethod },
  { key: "data", guard: isDataMethod },
  { key: "code", guard: isCodeMethod },
  { key: "content", guard: isContentMethod },
] as const;

// Criteria with method: null or a non-locatable method (taste.refused, content.coverage /
// .source_grounding / .no_hallucination) have no claim-array shape to prescribe - they're
// evaluated from the deliverable's own free-form content, not a locatable claim entry - so they
// contribute nothing here, same as they carry no `locator` in the Criterion itself.
export function computeDeliverableRequirements(criteria: Criterion[]): DeliverableRequirements {
  const requirements: DeliverableRequirements = {};

  for (const criterion of criteria) {
    if (!criterion.locator) continue;
    const { method, index } = criterion.locator;

    for (const { key, guard } of BUCKETS) {
      if (!guard(method)) continue;
      const bucket = (requirements[key] ??= {});
      bucket[method] = Math.max(bucket[method] ?? 0, index + 1);
      break;
    }
  }

  return requirements;
}
