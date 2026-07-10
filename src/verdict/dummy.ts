import { ulid } from "ulid";
import { config } from "../config.js";

export interface DummyVerdict {
  vidimus_version: string;
  job_id: string;
  payment_id: string;
  subject: {
    spec_hash: string;
    deliverable_hash: string;
    deliverable_kind: "onchain_action" | "dataset" | "code" | "content" | "mixed";
  };
  criteria: unknown[];
  headline: "PASS" | "FAIL" | "PARTIAL" | "UNVERIFIABLE";
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

// D1 skeleton only: no real criteria evaluated, no real signing yet (M6/M7 land in D2/D4).
export function buildDummyVerdict(paymentId: string): DummyVerdict {
  return {
    vidimus_version: "1.0",
    job_id: `vd_${ulid()}`,
    payment_id: paymentId,
    subject: {
      spec_hash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      deliverable_hash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      deliverable_kind: "mixed",
    },
    criteria: [],
    headline: "UNVERIFIABLE",
    headline_basis: [],
    summary: "D1 skeleton response - no criteria compiler or checkers wired up yet.",
    ruleset_version: "0.0.0-d1",
    ruleset_hash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    issued_at: new Date().toISOString(),
    signer: {
      erc8004_id: config.erc8004Id,
      address: config.erc8004Address || config.payToAddress,
    },
    signature: "0x00",
  };
}
