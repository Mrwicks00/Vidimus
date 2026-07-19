// Resolves a marketplace jobId to its original task spec text, so a buyer can reference `jobId`
// instead of hand-transcribing (or doctoring) the spec - see docs/OKX_ASP_LISTING_GUIDE.md for
// the live symptom ("always UNVERIFIABLE, no spec provided") this was written to fix, and the
// plan this implements for why the spec (not the deliverable) is the thing worth auto-resolving:
// task descriptions are public marketplace data (confirmed live: a non-participant agent could
// read a random private job's full description via `onchainos agent common context <jobId>`),
// while delivered files are encrypted and scoped to the job's own participants.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "../config.js";

const execFileAsync = promisify(execFile);

const RESOLVE_MAX_ATTEMPTS = 3;
const RESOLVE_RETRY_DELAY_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// `agent common context` prints "a structured natural-language description for the LLM" (its
// own --help text) - there is no --json mode for this lookup, unlike the JSON-returning
// onchainos subcommands used elsewhere in this codebase (signVerdict's `wallet sign-message`,
// m3-onchain.ts's `security token-scan`). We extract just the "- Description:" field from its
// fixed template shape; the description itself may span multiple lines/paragraphs, so capture
// through to the next top-level "- <Field>:" line (observed live: "- Title: ...", "- Description:
// <n paragraphs>", "- Budget: ..." - description content itself never starts a line with "- Word:").
const DESCRIPTION_BLOCK = /^- Description:[ \t]*\n?([\s\S]*?)\n- [A-Za-z ]+:/m;

export function extractDescription(commonContextOutput: string): string | undefined {
  const match = DESCRIPTION_BLOCK.exec(commonContextOutput);
  const text = match?.[1]?.trim();
  return text ? text : undefined;
}

type CommonContextRunner = (jobId: string) => Promise<{ stdout: string }>;

function defaultRunner(jobId: string): Promise<{ stdout: string }> {
  return execFileAsync("onchainos", ["agent", "common", "context", jobId, "--role", "user", "--agent-id", config.erc8004Id]);
}

/**
 * Never throws. x402 payment is already settled by the time this runs (verify.ts parses the
 * request body after x402Gate has settled payment, and there is no refund path from within the
 * handler), so any failure here - a transient onchainos/DNS blip (observed live this session),
 * a bad/unknown jobId, or an unexpected CLI output shape - must degrade to `undefined` and let
 * the caller fall through to the existing "no spec provided" -> UNVERIFIABLE path. Never worse
 * than today's baseline; never a request that was already paid for ending in a 500.
 *
 * `runner` is only ever overridden in tests (resolve-spec.test.ts) - defaults to the real
 * onchainos CLI call in production.
 */
export async function resolveSpecFromJobId(jobId: string, runner: CommonContextRunner = defaultRunner): Promise<string | undefined> {
  let lastError = "unknown error";
  for (let attempt = 1; attempt <= RESOLVE_MAX_ATTEMPTS; attempt++) {
    try {
      const { stdout } = await runner(jobId);
      const description = extractDescription(stdout);
      if (description) return description;
      lastError = "common context output did not contain a parseable Description field";
    } catch (err) {
      // Same "transient DNS/network blips against the OKX gateway are observed in practice"
      // reasoning as signVerdict (src/verdict/sign.ts) - retry before giving up rather than
      // silently returning "no spec" on the first blip.
      lastError = err instanceof Error ? err.message : String(err);
    }
    if (attempt < RESOLVE_MAX_ATTEMPTS) await sleep(RESOLVE_RETRY_DELAY_MS * attempt);
  }

  console.warn(`[resolve-spec] failed to resolve spec for jobId=${jobId} after ${RESOLVE_MAX_ATTEMPTS} attempts: ${lastError}`);
  return undefined;
}
