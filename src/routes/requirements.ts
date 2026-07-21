// Free, unauthenticated pre-flight for /verify (src/routes/verify.ts): runs only the M2 compile
// step and reports the deliverable shape it implies, so a caller can prepare the right evidence
// *before* paying - see this session's design note in docs/OKX_ASP_LISTING_GUIDE.md and
// deliverable-requirements.ts for why this half of /verify needed to be split out on its own.
import { Hono, type Context } from "hono";
import { compileCriteria, InjectionSuspectedError } from "../modules/m2-criteria-compiler.js";
import { computeDeliverableRequirements } from "../modules/deliverable-requirements.js";
import { quarantineSpec, SpecQuarantineError } from "../security/quarantine.js";
import { resolveSpecFromJobId } from "../marketplace/resolve-spec.js";
import { config } from "../config.js";
import type { Criterion } from "../verdict/types.js";

export const requirementsRoute = new Hono();

interface RequirementsRequestBody {
  jobId?: string;
  spec?: string;
}

// Same cooldown/daily-counter shape as src/routes/demo.ts, separate state - this endpoint calls
// the same OpenRouter-billed M2 model, now without a payment to meter it, so it needs its own
// throttle rather than relying on x402.
interface LimiterState {
  lastRunAt: number;
  dayKey: string;
  countToday: number;
}
const state: LimiterState = { lastRunAt: 0, dayKey: "", countToday: 0 };

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}
function rollDayIfNeeded(): void {
  const key = todayKey();
  if (state.dayKey !== key) {
    state.dayKey = key;
    state.countToday = 0;
  }
}
function cooldownRemaining(): number {
  const elapsedMs = Date.now() - state.lastRunAt;
  return Math.max(0, Math.ceil((config.requirementsCooldownSeconds * 1000 - elapsedMs) / 1000));
}

// Strips the not-yet-meaningful evaluation fields (result/confidence/evidence are always
// UNVERIFIABLE/null/"none" straight out of compileCriteria - nothing has checked anything yet)
// so the response doesn't imply a verdict that was never computed.
type CompiledCriterionPreview = Pick<Criterion, "id" | "text" | "source" | "inference_note" | "tier" | "method" | "locator">;
function previewCriterion(c: Criterion): CompiledCriterionPreview {
  const { id, text, source, inference_note, tier, method, locator } = c;
  return { id, text, source, inference_note, tier, method, locator };
}

requirementsRoute.post("/verify/requirements", async (c: Context) => {
  rollDayIfNeeded();
  const cooldown = cooldownRemaining();
  if (cooldown > 0) {
    return c.json({ error: "rate limited - try again shortly", retryAfterSeconds: cooldown }, 429);
  }
  if (state.countToday >= config.requirementsDailyLimit) {
    return c.json({ error: "daily requirements-check budget spent, try again tomorrow" }, 429);
  }

  let rawSpec = "";
  try {
    const body = await c.req.json<RequirementsRequestBody>();
    if (typeof body?.spec === "string") rawSpec = body.spec;
    if (!rawSpec && typeof body?.jobId === "string" && body.jobId) {
      rawSpec = (await resolveSpecFromJobId(body.jobId)) ?? "";
    }
  } catch {
    // no/invalid JSON body - rawSpec stays empty, caught below.
  }

  if (!rawSpec.trim()) {
    return c.json({ error: "no spec provided (and jobId, if given, did not resolve to one)" }, 400);
  }

  let quarantinedSpec: { text: string; hash: string; canary: string };
  try {
    quarantinedSpec = quarantineSpec(rawSpec);
  } catch (err) {
    const message = err instanceof SpecQuarantineError ? err.message : "spec quarantine failed";
    return c.json({ error: message }, 400);
  }

  // Reserve the cooldown/daily slot only once we know there's real compile work to bill for -
  // a 400 above (empty spec, quarantine rejection) shouldn't cost the caller their rate-limit
  // budget.
  state.lastRunAt = Date.now();
  state.countToday += 1;

  let criteria: Criterion[];
  try {
    criteria = await compileCriteria(quarantinedSpec.text, quarantinedSpec.canary);
  } catch (err) {
    if (err instanceof InjectionSuspectedError) {
      // Same SECURITY.md §3 posture as /verify: a tripped canary means compromised input - no
      // criteria are trustworthy, report that plainly rather than any deliverable shape.
      return c.json({
        spec_hash: quarantinedSpec.hash,
        injection_suspected: true,
        criteria: [],
        deliverable_requirements: {},
      });
    }
    const message = err instanceof Error ? err.message : "criteria compilation failed";
    return c.json({ error: message }, 502);
  }

  return c.json({
    spec_hash: quarantinedSpec.hash,
    criteria: criteria.map(previewCriterion),
    deliverable_requirements: computeDeliverableRequirements(criteria),
  });
});
