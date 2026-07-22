// Fallback spec resolution when a buyer's x402 replay includes neither `spec` nor `jobId` at all
// (OKX ASP review: a real buyer's tooling sent an empty body, producing a signed-but-useless
// UNVERIFIABLE verdict). The x402 protocol itself carries no job correlator - but the payment
// header the buyer already signed does carry their wallet address, and that's enough to look up
// which of our own in-progress tasks they're paying for, *if* there's exactly one candidate.
//
// Best-effort only: every function here degrades to `undefined` on any failure (decode error,
// CLI error, zero matches) rather than throwing - this fallback was never guaranteed to work in
// the first place (see verify.ts's D4.5-style "never guess" contract - zero or multiple matches
// both mean "can't tell", identical to a genuinely nonexistent match).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { decodePaymentSignatureHeader } from "@okxweb3/x402-core/http";
import { config } from "../config.js";

const execFileAsync = promisify(execFile);

// `payload.authorization.from` is the EIP-3009 signer address for the `exact` scheme this server
// registers (src/x402/server.ts) - see @okxweb3/x402-evm's ExactEIP3009Payload type. Never throws:
// a malformed/absent header is legitimate (not every request carries one), not an error to surface.
export function extractPayerAddress(header: string): string | undefined {
  try {
    const decoded = decodePaymentSignatureHeader(header) as { payload?: { authorization?: { from?: unknown } } };
    const from = decoded.payload?.authorization?.from;
    return typeof from === "string" && from.length > 0 ? from.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

interface ProviderTask {
  buyerAgentAddress?: string;
  jobId?: string;
  status?: number;
  paymentMode?: number;
}

type TaskInProgressRunner = (agentId: string) => Promise<{ stdout: string }>;

function defaultRunner(agentId: string): Promise<{ stdout: string }> {
  return execFileAsync("onchainos", ["agent", "task-in-progress", "--agent-ids", agentId]);
}

const ACCEPTED_STATUS = 1; // per docs/.../task-cli-reference.md's status enum (0 created, 1 accepted, ...)
const X402_PAYMENT_MODE = 3;

/**
 * Never throws. Returns the jobId of the single in-progress, accepted, x402-paid task where
 * `payerAddress` is the buyer - or `undefined` if there's zero or more than one candidate
 * (ambiguous, never guessed) or the lookup itself failed.
 *
 * `runner` is only ever overridden in tests - defaults to the real onchainos CLI call in
 * production, same convention as resolve-spec.ts.
 */
export async function findAcceptedJobIdForPayer(payerAddress: string, runner: TaskInProgressRunner = defaultRunner): Promise<string | undefined> {
  let stdout: string;
  try {
    ({ stdout } = await runner(config.erc8004Id));
  } catch (err) {
    console.warn(`[resolve-payer-task] task-in-progress lookup failed for payer=${payerAddress}: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }

  let providerTasks: ProviderTask[];
  try {
    const parsed = JSON.parse(stdout) as { data?: { providerTasks?: ProviderTask[] } };
    providerTasks = parsed.data?.providerTasks ?? [];
  } catch {
    return undefined;
  }

  const matches = providerTasks.filter(
    (t) => typeof t.buyerAgentAddress === "string" && t.buyerAgentAddress.toLowerCase() === payerAddress && t.status === ACCEPTED_STATUS && t.paymentMode === X402_PAYMENT_MODE,
  );

  return matches.length === 1 ? matches[0]!.jobId : undefined;
}
