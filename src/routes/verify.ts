import { Hono } from "hono";
import { createHash } from "node:crypto";
import { ulid } from "ulid";
import { x402Gate } from "../x402/middleware.js";
import { compileCriteria } from "../modules/m2-criteria-compiler.js";
import { config } from "../config.js";
import type { Verdict } from "../verdict/types.js";

export const verifyRoute = new Hono();

const ZERO_HASH = `sha256:${"0".repeat(64)}`;

function sha256Hex(input: string): string {
  return `sha256:${createHash("sha256").update(input, "utf8").digest("hex")}`;
}

verifyRoute.post("/verify", x402Gate, async (c) => {
  const paymentId = c.get("paymentId");

  let spec = "";
  try {
    const body = await c.req.json<{ spec?: string }>();
    if (typeof body?.spec === "string") spec = body.spec;
  } catch {
    // no/invalid JSON body - treat as no spec, criteria[] stays empty below.
  }

  let criteria: Verdict["criteria"] = [];
  if (spec.trim()) {
    try {
      criteria = await compileCriteria(spec);
    } catch (err) {
      const message = err instanceof Error ? err.message : "criteria compilation failed";
      return c.json({ error: message }, 502);
    }
  }

  // D2 scope: only M2 (criteria) is real. Headline/signature stay D1 placeholders
  // until D3 (checkers) and D4 (signing) land - see docs/ROADMAP.md.
  const verdict: Verdict = {
    vidimus_version: "1.0",
    job_id: `vd_${ulid()}`,
    payment_id: paymentId,
    subject: {
      spec_hash: spec.trim() ? sha256Hex(spec) : ZERO_HASH,
      deliverable_hash: ZERO_HASH,
      deliverable_kind: "mixed",
    },
    criteria,
    headline: "UNVERIFIABLE",
    headline_basis: [],
    summary:
      criteria.length > 0
        ? `D2 skeleton: ${criteria.length} criteria compiled from the spec. No checkers wired up yet, so headline stays UNVERIFIABLE.`
        : "D2 skeleton: no spec provided (or it compiled to zero criteria) - nothing to check.",
    ruleset_version: "0.0.0-d2",
    ruleset_hash: ZERO_HASH,
    issued_at: new Date().toISOString(),
    signer: {
      erc8004_id: config.erc8004Id,
      address: config.erc8004Address || config.payToAddress,
    },
    signature: "0x00",
  };

  return c.json(verdict);
});
