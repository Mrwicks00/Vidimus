import { createHash } from "node:crypto";
import { Hono, type Context } from "hono";
import { ulid } from "ulid";
import { x402Gate } from "../x402/middleware.js";
import { compileCriteria, InjectionSuspectedError } from "../modules/m2-criteria-compiler.js";
import { applyOnchainChecks, type OnchainDeliverable } from "../modules/m3-onchain.js";
import { applyDataChecks, type DataDeliverable } from "../modules/m3-data.js";
import { applyCodeChecks, type CodeDeliverable } from "../modules/m3-code.js";
import { applyContentChecks, type ContentDeliverable } from "../modules/m3-content.js";
import { computeHeadline } from "../modules/headline.js";
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

export const verifyRoute = new Hono();

const ZERO_HASH = `sha256:${"0".repeat(64)}`;

interface VerifyRequestBody {
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
  const paymentId = c.get("paymentId");

  let rawSpec = "";
  let rawDeliverable: VerifyRequestBody["deliverable"];
  try {
    const body = await c.req.json<VerifyRequestBody>();
    if (typeof body?.spec === "string") rawSpec = body.spec;
    if (body?.deliverable && typeof body.deliverable === "object") rawDeliverable = body.deliverable;
  } catch {
    // no/invalid JSON body - treat as no spec/deliverable, criteria[] stays empty below.
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
    try {
      criteria = await compileCriteria(quarantinedSpec.text, quarantinedSpec.canary);
      criteria = await applyOnchainChecks(criteria, sealedOnchain, onchainRejected);
      criteria = await applyDataChecks(criteria, sealedData, dataRejected, deliverableHash);
      criteria = await applyCodeChecks(criteria, sealedCode, codeRejected);
      criteria = applyContentChecks(criteria, sealedContent, contentRejected);
    } catch (err) {
      if (err instanceof InjectionSuspectedError) {
        // SECURITY.md §3: a tripped canary means the job is compromised input - do not emit
        // PASS, do not trust anything the model produced. Never a silent pass.
        injectionSuspected = true;
        console.warn(`[m5] injection suspected: job spec_hash=${quarantinedSpec.hash} - ${err.message}`);
      } else {
        const message = err instanceof Error ? err.message : "criteria compilation failed";
        return c.json({ error: message }, 502);
      }
    }
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
    payment_id: paymentId,
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

  return c.json(verdict);
}

// GET is registered alongside POST (both x402-gated) because OKX's marketplace endpoint
// validator probes with a plain GET before any real paid call - without this, an unpaid GET
// fell through to the SPA catch-all in index.ts and returned 200 HTML instead of a 402
// challenge, so the listing review saw "not a valid x402 service".
verifyRoute.post("/verify", x402Gate, handleVerify);
verifyRoute.get("/verify", x402Gate, handleVerify);
