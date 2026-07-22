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
//
// MUST be scoped to the "[Task Details]" section first: when the caller (Vidimus, agentId
// resolved from config) happens to itself be a participant in the job being verified (e.g. it's
// both the ASP being asked to verify a spec AND running this lookup), the output *also* carries
// a "[Your Identity]" section with its own unrelated "- Description:" line (the caller's own
// agent bio) BEFORE "[Task Details]" - confirmed live, this silently returned Vidimus's own bio
// instead of the task spec until this scoping was added. Never match the first "- Description:"
// in the whole output.
const TASK_DETAILS_SECTION = /\[Task Details\]([\s\S]*?)(?:\n\[|$)/;
const DESCRIPTION_BLOCK = /^- Description:[ \t]*\n?([\s\S]*?)\n- [A-Za-z ]+:/m;

export function extractDescription(commonContextOutput: string): string | undefined {
  const section = TASK_DETAILS_SECTION.exec(commonContextOutput)?.[1];
  if (!section) return undefined;
  const match = DESCRIPTION_BLOCK.exec(section);
  const text = match?.[1]?.trim();
  return text ? text : undefined;
}

type CommonContextRunner = (jobId: string) => Promise<{ stdout: string }>;

function defaultRunner(jobId: string): Promise<{ stdout: string }> {
  return execFileAsync("onchainos", ["agent", "common", "context", jobId, "--role", "user", "--agent-id", config.erc8004Id]);
}

export type ResolveSpecResult =
  | { ok: true; spec: string }
  | { ok: false; kind: "invalid_format" | "not_found"; message: string }
  | { ok: false; kind: "unresolved" };

// Deterministic CLI-level rejections, matched on the `onchainos` error text itself (confirmed
// live: `agent common context 88213 ...` -> "--jobid invalid (must be `0x` + 64 chars, got 5
// chars)..."; a well-formed but nonexistent 0x+64-char id -> "...Wallet API error (code=1001):
// task not found"). Both are instant and will never succeed on retry, unlike a real network/DNS
// blip - surfacing them immediately (rather than burning the retry budget and then degrading to
// silent "no spec") is what lets the caller return a clear 400 instead of a paid UNVERIFIABLE
// verdict for what is really just a malformed request.
const INVALID_FORMAT_PATTERN = /--jobid invalid/i;
const NOT_FOUND_PATTERN = /task not found/i;

function classifyError(message: string): "invalid_format" | "not_found" | undefined {
  if (INVALID_FORMAT_PATTERN.test(message)) return "invalid_format";
  if (NOT_FOUND_PATTERN.test(message)) return "not_found";
  return undefined;
}

/**
 * Never throws. x402 payment is already settled by the time this runs (verify.ts parses the
 * request body after x402Gate has settled payment, and there is no refund path from within the
 * handler) - but that only licenses silently degrading *transient* failures (a network/DNS blip,
 * an unparseable CLI output shape) to `{ ok: false, kind: "unresolved" }` and letting the caller
 * fall through to the existing "no spec provided" -> UNVERIFIABLE path, never worse than today's
 * baseline. A deterministically wrong jobId (bad format, genuinely doesn't exist) is a different
 * case - `verify.ts` already returns a 400 post-payment for other definite input errors (e.g.
 * `SpecQuarantineError`), so those are reported as `invalid_format`/`not_found` instead of being
 * silently eaten, and are never retried (retrying a deterministic rejection just burns time).
 *
 * `runner` is only ever overridden in tests (resolve-spec.test.ts) - defaults to the real
 * onchainos CLI call in production.
 */
export async function resolveSpecFromJobId(jobId: string, runner: CommonContextRunner = defaultRunner): Promise<ResolveSpecResult> {
  let lastError = "unknown error";
  for (let attempt = 1; attempt <= RESOLVE_MAX_ATTEMPTS; attempt++) {
    try {
      const { stdout } = await runner(jobId);
      const description = extractDescription(stdout);
      if (description) return { ok: true, spec: description };
      lastError = "common context output did not contain a parseable Description field";
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      const kind = classifyError(lastError);
      if (kind) return { ok: false, kind, message: lastError };
      // Same "transient DNS/network blips against the OKX gateway are observed in practice"
      // reasoning as signVerdict (src/verdict/sign.ts) - retry before giving up rather than
      // silently returning "no spec" on the first blip.
    }
    if (attempt < RESOLVE_MAX_ATTEMPTS) await sleep(RESOLVE_RETRY_DELAY_MS * attempt);
  }

  console.warn(`[resolve-spec] failed to resolve spec for jobId=${jobId} after ${RESOLVE_MAX_ATTEMPTS} attempts: ${lastError}`);
  return { ok: false, kind: "unresolved" };
}
