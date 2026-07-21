// D6.B calibration log — append-only JSONL, hash-chained (docs/ARCHITECTURE.md §5).
//
// Integrity model (design gate, 2026-07-11): hash-chained rows, not a per-row wallet signature.
// Each row already embeds the verdict's own EIP-191 `verdict_signature` - forging a row's
// *content* for a real job already requires forging that signature (scripts/verify-verdict.ts's
// existing recovery check applies unchanged to it). What a signature alone can't prove is that
// the log wasn't quietly edited/reordered/pruned after the fact - a deleted row still leaves
// every other row's own signature valid. The hash chain (`entry_hash[n]` folds in
// `prev_hash = entry_hash[n-1]`) closes exactly that gap: any edit/delete/reorder breaks every
// `prev_hash` from that point forward, detected in one linear pass (`verifyChainIntegrity`).
// Cheaper too - a second wallet signature per request would be a real TEE-wallet round trip on
// every /verify call for a weaker property the chain already gets for free, locally, offline.
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { canonicalize } from "../verdict/canonicalize.js";
import type { Verdict } from "../verdict/types.js";
import { toCalibrationCriterionEntry, type CalibrationLogEntry } from "./types.js";

function entryHash(rowWithoutHash: Omit<CalibrationLogEntry, "entry_hash">): string {
  return `sha256:${createHash("sha256").update(canonicalize(rowWithoutHash), "utf8").digest("hex")}`;
}

// Per-path tail cache (last seq/hash) + a write-queue mutex, so concurrent /verify requests
// against the same log file append serially instead of racing on "what's the current tail."
// Single-process server (src/index.ts) - an in-memory queue is sufficient, no cross-process
// locking needed at this scale.
interface TailState {
  seq: number; // next seq to assign
  prevHash: string | null;
}
const tailCache = new Map<string, TailState>();
const writeQueues = new Map<string, Promise<unknown>>();

function parseLine(line: string): CalibrationLogEntry {
  return JSON.parse(line) as CalibrationLogEntry;
}

async function loadTail(path: string): Promise<TailState> {
  const cached = tailCache.get(path);
  if (cached) return cached;

  let state: TailState = { seq: 0, prevHash: null };
  try {
    const raw = await readFile(path, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length > 0) {
      const last = parseLine(lines[lines.length - 1]!);
      state = { seq: last.seq + 1, prevHash: last.entry_hash };
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    // file doesn't exist yet - genesis state, created on first append.
  }
  tailCache.set(path, state);
  return state;
}

/**
 * Appends one row derived from a signed verdict. Awaited by the caller but wrapped in try/catch
 * there (docs/ARCHITECTURE.md §3: calibration "must NOT affect the current response") - a log
 * write failure must never turn a 200 verdict into a 500.
 */
export async function appendCalibrationEntry(
  verdict: Verdict,
  verdictDigest: string,
  logPath: string,
  loggedAt: string = new Date().toISOString(),
): Promise<CalibrationLogEntry> {
  const prior = writeQueues.get(logPath) ?? Promise.resolve();
  const next = prior
    .catch(() => {}) // a prior failed append must not poison the queue for later ones
    .then(async () => {
      const tail = await loadTail(logPath);

      const rowWithoutHash: Omit<CalibrationLogEntry, "entry_hash"> = {
        seq: tail.seq,
        logged_at: loggedAt,
        job_id: verdict.job_id,
        verdict_digest: verdictDigest,
        verdict_signature: verdict.signature,
        signer: verdict.signer,
        ruleset_version: verdict.ruleset_version,
        ruleset_hash: verdict.ruleset_hash,
        issued_at: verdict.issued_at,
        headline: verdict.headline,
        headline_basis: verdict.headline_basis,
        criteria: verdict.criteria.map(toCalibrationCriterionEntry),
        prev_hash: tail.prevHash,
      };
      const entry: CalibrationLogEntry = { ...rowWithoutHash, entry_hash: entryHash(rowWithoutHash) };

      await mkdir(dirname(logPath), { recursive: true });
      await appendFile(logPath, `${JSON.stringify(entry)}\n`, "utf8");

      tailCache.set(logPath, { seq: tail.seq + 1, prevHash: entry.entry_hash });
      return entry;
    });
  writeQueues.set(logPath, next);
  return next;
}

export async function readCalibrationLog(logPath: string): Promise<CalibrationLogEntry[]> {
  try {
    const raw = await readFile(logPath, "utf8");
    return raw
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map(parseLine);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

export interface ChainIntegrityResult {
  ok: boolean;
  rowsChecked: number;
  brokenAtSeq?: number;
  reason?: string;
}

/**
 * Walks the log top to bottom, recomputing each row's `entry_hash` from its own content and
 * confirming `prev_hash` correctly chains to the previous row. Detects any edit, deletion,
 * reorder, or insertion - the property a per-row signature alone would not give (see the
 * module-level design note above).
 */
export function verifyChainIntegrity(entries: CalibrationLogEntry[]): ChainIntegrityResult {
  let expectedPrevHash: string | null = null;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.seq !== i) {
      return { ok: false, rowsChecked: i, brokenAtSeq: entry.seq, reason: `expected seq ${i}, found ${entry.seq}` };
    }
    if (entry.prev_hash !== expectedPrevHash) {
      return { ok: false, rowsChecked: i, brokenAtSeq: entry.seq, reason: `prev_hash does not chain to row ${i - 1}` };
    }
    const { entry_hash, ...rowWithoutHash } = entry;
    const recomputed = entryHash(rowWithoutHash);
    if (recomputed !== entry_hash) {
      return { ok: false, rowsChecked: i, brokenAtSeq: entry.seq, reason: `entry_hash mismatch - row content was modified after being appended` };
    }
    expectedPrevHash = entry_hash;
  }
  return { ok: true, rowsChecked: entries.length };
}
