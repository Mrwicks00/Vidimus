import { createHash } from "node:crypto";
import { Hono, type Context } from "hono";
import { ulid } from "ulid";
import { compileCriteria, InjectionSuspectedError } from "../modules/m2-criteria-compiler.js";
import { applyOnchainChecks, type OnchainDeliverable } from "../modules/m3-onchain.js";
import { applyDataChecks, type DataDeliverable } from "../modules/m3-data.js";
import { applyCodeChecks, type CodeDeliverable } from "../modules/m3-code.js";
import { applyContentChecks, autoFillSingleAssetContentClaims, type ContentDeliverable } from "../modules/m3-content.js";
import { computeHeadline } from "../modules/headline.js";
import { computeDeliverableRequirements } from "../modules/deliverable-requirements.js";
import {
  quarantineSpec,
  quarantineDeliverable,
  quarantineDataDeliverable,
  quarantineCodeDeliverable,
  quarantineContentDeliverable,
  SpecQuarantineError,
} from "../security/quarantine.js";
import { signVerdict } from "../verdict/sign.js";
import { canonicalize } from "../verdict/canonicalize.js";
import { config } from "../config.js";
import type { Criterion, Verdict, VerdictResult } from "../verdict/types.js";
import { appendCalibrationEntry } from "../calibration/log.js";
import { resolveSpecFromJobId } from "../marketplace/resolve-spec.js";
import { extractPayerAddress, findAcceptedJobIdForPayer } from "../marketplace/resolve-payer-task.js";

export const verifyRoute = new Hono();

const ZERO_HASH = `sha256:${"0".repeat(64)}`;

// OKX review: a paid request that needed multiple checks (onchain + content) failed transport-
// level while payment still settled - only possible if our own handler actually finished and
// returned 200 (settlement fires after that, confirmed via the SDK source), meaning the
// client-facing connection died before the response arrived. Researched cause: hosting
// platforms' edge proxies have been observed killing long-held connections well before their
// own documented timeout (see docs/OKX_ASP_LISTING_GUIDE.md §3.3) - this isn't fixable by
// picking a different host, since our own worst-case latency can outrun any of them. Two-part
// fix: run the checks concurrently (below) and bound the whole thing with a deadline we control.
const VERIFY_DEADLINE_MS = 45_000;

class VerificationTimeoutError extends Error {}

function timeoutAfter(ms: number): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new VerificationTimeoutError()), ms));
}

// Each applyXChecks call already parallelizes its own internal work (Promise.all over its own
// criteria) and explicitly ignores any criterion outside its own method family (every one starts
// with `if (!locator || !isXMethod(locator.method)) return c;`) - so all four are safe to run
// concurrently against the same compiled criteria and merge, rather than chaining them
// sequentially. At most one result array will ever actually change a given criterion, since a
// criterion belongs to exactly one method family.
export function mergeCheckedCriteria(original: Criterion[], ...results: Criterion[][]): Criterion[] {
  return original.map((c, i) => results.find((r) => r[i] !== c)?.[i] ?? c);
}

interface VerifyRequestBody {
  jobId?: string;
  spec?: string;
  deliverable?: { onchain?: OnchainDeliverable; data?: DataDeliverable; code?: CodeDeliverable; content?: ContentDeliverable };
}

function buildSummary(criteria: Criterion[], headline: VerdictResult, headlineBasis: string[]): string {
  if (criteria.length === 0) {
    return "No spec provided (or it compiled to zero criteria) - nothing to check.";
  }
  const scored = criteria.filter((c) => headlineBasis.includes(c.id));
  const counts = { PASS: 0, FAIL: 0, PARTIAL: 0, UNVERIFIABLE: 0 } as Record<VerdictResult, number>;
  for (const c of scored) counts[c.result] += 1;

  const parts = [
    `${criteria.length} criteria compiled`,
    `${counts.PASS} PASS / ${counts.FAIL} FAIL / ${counts.PARTIAL} PARTIAL / ${counts.UNVERIFIABLE} UNVERIFIABLE among ${scored.length} tier 1-2 criteria deciding the headline`,
  ];

  if (headline === "PARTIAL") {
    const explicitFail = scored.some((c) => c.result === "FAIL" && c.source === "EXPLICIT");
    const inferredFails = scored.filter((c) => c.result === "FAIL" && c.source === "INFERRED");
    if (!explicitFail && inferredFails.length > 0) {
      parts.push(
        `capped at PARTIAL not FAIL: ${inferredFails.map((c) => `${c.id} (${c.inference_note ?? "our inference"})`).join("; ")} is our own inference, not a stated requirement`,
      );
    }
  }

  return parts.join(". ").slice(0, 280);
}

async function handleVerify(c: Context) {
  let rawSpec = "";
  let rawDeliverable: VerifyRequestBody["deliverable"];
  let jobIdGiven = false;
  try {
    const body = await c.req.json<VerifyRequestBody>();
    if (typeof body?.spec === "string") rawSpec = body.spec;
    if (body?.deliverable && typeof body.deliverable === "object") rawDeliverable = body.deliverable;
    // `jobId` is the marketplace-friendly alternative to hand-transcribing `spec` - resolved from
    // the task's own public record (see resolve-spec.ts). An explicit `spec` always wins if both
    // are present, so existing callers (scripts/test-buyer.ts) are unaffected.
    if (!rawSpec && typeof body?.jobId === "string" && body.jobId) {
      jobIdGiven = true;
      const resolved = await resolveSpecFromJobId(body.jobId);
      if (resolved.ok) {
        rawSpec = resolved.spec;
      } else if (resolved.kind === "invalid_format") {
        return c.json({ error: `jobId "${body.jobId}" is not valid: ${resolved.message} - jobId must be the full on-chain job id (0x + 64 hex chars), not the short task number shown in the marketplace UI.` }, 400);
      } else if (resolved.kind === "not_found") {
        return c.json({ error: `jobId "${body.jobId}" was not found - double-check it's the exact on-chain job id.` }, 400);
      }
      // kind === "unresolved" (transient/unparseable) - fall through with rawSpec still "",
      // exactly today's baseline: degrades to "no spec provided" -> UNVERIFIABLE, never a 500
      // for a request that already settled payment.
    }
  } catch {
    // no/invalid JSON body - treat as no spec/deliverable, criteria[] stays empty below.
  }

  // Fallback for a real observed failure (OKX review): the buyer's own tooling sent neither
  // `spec` nor `jobId` at all - only fires when the body gave us truly nothing to go on (never
  // when the buyer explicitly gave a jobId that turned out wrong; that's already a clear 400
  // above, and silently overriding an explicit-but-wrong input would hide a real bug on their
  // side rather than surface it). The payer's wallet address is still readable straight off the
  // payment header they already signed, independent of what the x402 middleware did with it -
  // see resolve-payer-task.ts for why the SDK doesn't hand this to us any other way.
  if (!rawSpec && !jobIdGiven) {
    const paymentHeader = c.req.header("payment-signature") || c.req.header("x-payment");
    const payer = paymentHeader ? extractPayerAddress(paymentHeader) : undefined;
    const inferredJobId = payer ? await findAcceptedJobIdForPayer(payer) : undefined;
    if (inferredJobId) {
      const resolved = await resolveSpecFromJobId(inferredJobId);
      if (resolved.ok) rawSpec = resolved.spec;
      // any other outcome - fall through exactly as if this fallback never ran; it was never
      // guaranteed to resolve anything.
    }
  }

  // M5 quarantine (docs/SECURITY.md §2.1): every ingest surface is sealed before anything
  // downstream reads it - the spec before it ever reaches the M2 LLM call, all deliverable
  // buckets before their claims ever reach the M3 checkers (Pass 2 never sees raw/rejected
  // input). D5 adds the `data` bucket (M3.B) and the `code` bucket (M3.C); D6.A adds the
  // `content` bucket (M4 Tier-1) alongside the D3/D4 `onchain` one.
  let quarantinedSpec: { text: string; hash: string; canary: string } | undefined;
  if (rawSpec.trim()) {
    try {
      quarantinedSpec = quarantineSpec(rawSpec);
    } catch (err) {
      const message = err instanceof SpecQuarantineError ? err.message : "spec quarantine failed";
      return c.json({ error: message }, 400);
    }
  }
  const { deliverable: sealedOnchain, rejected: onchainRejected } = quarantineDeliverable(rawDeliverable?.onchain);
  const { sealed: sealedData, rejected: dataRejected } = quarantineDataDeliverable(rawDeliverable?.data);
  const { sealed: sealedCode, rejected: codeRejected } = quarantineCodeDeliverable(rawDeliverable?.code);
  const { sealed: sealedContent, rejected: contentRejected } = quarantineContentDeliverable(rawDeliverable?.content);

  const hasOnchain = Boolean(rawDeliverable?.onchain);
  const hasData = Boolean(rawDeliverable?.data);
  const hasCode = Boolean(rawDeliverable?.code);
  const hasContent = Boolean(rawDeliverable?.content);
  // Folds all sealed buckets into one commitment, fixed here - before compileCriteria or any
  // checker runs. This is the value that goes into subject.deliverable_hash *and* the
  // sample_verify seed input (SECURITY.md §4.1: seed derived from data fixed at delivery time,
  // combined with a block read strictly after this point) - one value, multiple uses, so there
  // is no path where the seed could be computed from something other than the committed delivery.
  const deliverableHash =
    hasOnchain || hasData || hasCode || hasContent
      ? `sha256:${createHash("sha256").update(canonicalize({ onchain: sealedOnchain, data: sealedData, code: sealedCode, content: sealedContent }), "utf8").digest("hex")}`
      : ZERO_HASH;
  const deliverableKind: Verdict["subject"]["deliverable_kind"] =
    [hasOnchain, hasData, hasCode, hasContent].filter(Boolean).length > 1
      ? "mixed"
      : hasData
        ? "dataset"
        : hasCode
          ? "code"
          : hasContent
            ? "content"
            : hasOnchain
              ? "onchain_action"
              : "mixed";

  let criteria: Verdict["criteria"] = [];
  let injectionSuspected = false;
  if (quarantinedSpec) {
    const spec = quarantinedSpec;
    const runChecks = async (): Promise<Criterion[]> => {
      const compiled = await compileCriteria(spec.text, spec.canary);
      // Single-asset auto-wire (OKX review): deliverableHash above already committed to the
      // buyer's real submission - this only affects what the checkers see, never the commitment.
      const effectiveSealedContent = autoFillSingleAssetContentClaims(compiled, sealedContent, contentRejected);
      // All four run concurrently against the same compiled criteria and merge - each already
      // parallelizes its own internal work and ignores criteria outside its own method family,
      // so the old sequential chaining here only added latency, never correctness.
      const [onchainResult, dataResult, codeResult, contentResult] = await Promise.all([
        applyOnchainChecks(compiled, sealedOnchain, onchainRejected),
        applyDataChecks(compiled, sealedData, dataRejected, deliverableHash),
        applyCodeChecks(compiled, sealedCode, codeRejected),
        applyContentChecks(compiled, effectiveSealedContent, contentRejected, spec.canary),
      ]);
      return mergeCheckedCriteria(compiled, onchainResult, dataResult, codeResult, contentResult);
    };

    try {
      criteria = await Promise.race([runChecks(), timeoutAfter(VERIFY_DEADLINE_MS)]);
    } catch (err) {
      if (err instanceof InjectionSuspectedError) {
        // SECURITY.md §3: a tripped canary means the job is compromised input - do not emit
        // PASS, do not trust anything the model produced. Never a silent pass.
        injectionSuspected = true;
        console.warn(`[m5] injection suspected: job spec_hash=${spec.hash} - ${err.message}`);
      } else if (err instanceof VerificationTimeoutError) {
        // The underlying LLM/RPC calls aren't forcibly cancelled here - they keep running until
        // their own bounded retry/timeout budgets finish, but nothing further reads their result
        // once we've already returned this response. Status >= 400 means the SDK's payment
        // middleware skips settlement (confirmed via its source earlier) - a real customer isn't
        // charged for a job that couldn't finish in time, unlike the connection-drop failure
        // mode this whole change exists to fix.
        return c.json({ error: "verification did not complete within the time budget - not charged (this response's status means the x402 middleware skips settlement)." }, 504);
      } else {
        const message = err instanceof Error ? err.message : "criteria compilation failed";
        return c.json({ error: message }, 502);
      }
    }
  }

  // OKX review: a submission that produced literally nothing to check (no spec/jobId resolved,
  // including after the payer-task fallback above) was returning a signed-but-useless 200
  // UNVERIFIABLE verdict, billed like any real result. `injectionSuspected` is deliberately
  // excluded - that case means the buyer DID send a spec, it was just flagged as a suspected
  // attack, a real chargeable outcome, not a "nothing was sent" one. Confirmed via the OKX
  // Payment SDK's own source (@okxweb3/x402-hono): settlement is skipped for any response
  // status >= 400, so this 400 also means the buyer is not charged for the no-op - not just a
  // clearer error, the actual fix for the billing complaint too.
  if (!injectionSuspected && criteria.length === 0) {
    return c.json(
      {
        error:
          'no checkable input received: provide either "spec" (plain text) or a valid "jobId" (the on-chain job id), plus a "deliverable" matching the compiled criteria - see POST /verify/requirements for the exact shape.',
      },
      400,
    );
  }

  const { headline, headline_basis } = injectionSuspected
    ? { headline: "UNVERIFIABLE" as VerdictResult, headline_basis: [] as string[] }
    : computeHeadline(criteria);

  const summary = injectionSuspected
    ? "Suspected injection in submitted spec - treated as compromised input, not scored. No criteria are trustworthy from this submission."
    : buildSummary(criteria, headline, headline_basis);

  const verdictBody: Omit<Verdict, "signature"> = {
    vidimus_version: "1.0",
    job_id: `vd_${ulid()}`,
    subject: {
      spec_hash: quarantinedSpec ? quarantinedSpec.hash : ZERO_HASH,
      deliverable_hash: deliverableHash,
      deliverable_kind: deliverableKind,
    },
    criteria: injectionSuspected ? [] : criteria,
    headline,
    headline_basis,
    summary,
    ruleset_version: "0.0.0-d6a",
    ruleset_hash: ZERO_HASH,
    issued_at: new Date().toISOString(),
    signer: {
      erc8004_id: config.erc8004Id,
      address: config.erc8004Address || config.payToAddress,
    },
  };

  const { signature, digest } = await signVerdict(verdictBody);
  const verdict: Verdict = { ...verdictBody, signature };

  // D6.B calibration log (docs/ARCHITECTURE.md §5 / §3 boundary table: "must NOT affect the
  // current response") - every issued verdict, including injection-suspected ones, is logged;
  // a log-write failure is swallowed here so it can never turn this 200 into a 500.
  try {
    await appendCalibrationEntry(verdict, digest, config.calibrationLogPath);
  } catch (err) {
    console.warn(`[calibration] failed to append log entry for job_id=${verdict.job_id}: ${err instanceof Error ? err.message : err}`);
  }

  // `deliverable_requirements` is deliberately outside the signed verdict body (attached to the
  // HTTP response only) - it's derived, informational shape-guidance, not evidence, so it
  // shouldn't change what gets canonicalized/signed. Reuses the exact same function the free
  // /verify/requirements pre-flight already uses (src/modules/deliverable-requirements.ts), so
  // even a buyer who skipped that pre-flight sees what shape was expected, right in the paid
  // response they already have (OKX review: "return a clear hint, not UNVERIFIABLE").
  const deliverableRequirements = injectionSuspected ? {} : computeDeliverableRequirements(criteria);
  return c.json({ ...verdict, deliverable_requirements: deliverableRequirements });
}

// Payment gating (both GET and POST) lives in the global paymentMiddleware mounted in
// src/index.ts, not here - see src/x402/server.ts for the route table.
verifyRoute.post("/verify", handleVerify);
verifyRoute.get("/verify", handleVerify);
