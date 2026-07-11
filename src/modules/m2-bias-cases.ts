// Pinned EXPLICIT/INFERRED bias-probe cases (M2 tagging-bias slice, dedicated session between
// M3.C and D6 - see CLAUDE_HISTORY.md). Single source of truth for both the live measurement
// harness (scripts/probe-m2-bias.ts) and the pinned regression test
// (m2-criteria-compiler.test.ts) - same cases, same ground truth, so a future prompt change
// can't silently drift the two apart.
//
// Each case's spec is constructed so the correct EXPLICIT/INFERRED tag for its target method(s)
// is unambiguous by construction: "-explicit" cases literally assert the checkable fact;
// "-inferred" cases only name the deliverable, never the verification fact itself, so a
// reasonable buyer clearly intends the check but never wrote it down.
import type { CriterionSource, Method } from "../verdict/types.js";

export interface BiasProbeCase {
  name: string;
  family: "onchain" | "data" | "code" | "content";
  spec: string;
  targetMethods: Method[];
  groundTruth: CriterionSource;
}

export const BIAS_PROBE_CASES: BiasProbeCase[] = [
  {
    name: "onchain-explicit",
    family: "onchain",
    spec: "Mint an NFT to wallet 0x2085D86C5EC584f337738E9AA8A0c566Fe86f0a9. Confirm the mint transaction exists on-chain, and confirm the resulting owner of the token is exactly 0x2085D86C5EC584f337738E9AA8A0c566Fe86f0a9.",
    targetMethods: ["onchain.tx_exists", "onchain.owner_check"],
    groundTruth: "EXPLICIT",
  },
  {
    name: "onchain-inferred",
    family: "onchain",
    spec: "Mint an NFT to wallet 0x2085D86C5EC584f337738E9AA8A0c566Fe86f0a9.",
    targetMethods: ["onchain.tx_exists", "onchain.owner_check"],
    groundTruth: "INFERRED",
  },
  {
    name: "data-explicit",
    family: "data",
    spec: "Deliver a CSV dataset with exactly the columns tokenId, owner, txHash - no more, no fewer - and containing exactly 500 rows.",
    targetMethods: ["data.schema", "data.rowcount"],
    groundTruth: "EXPLICIT",
  },
  {
    name: "data-inferred",
    family: "data",
    spec: "Deliver a CSV of our 500 NFT mint records (tokenId, owner, txHash) for our records.",
    targetMethods: ["data.sample_verify"],
    groundTruth: "INFERRED",
  },
  {
    name: "code-explicit",
    family: "code",
    spec: "Write a Node.js function that reverses a string, with unit tests. The delivered code must compile with no errors, and all tests must pass.",
    targetMethods: ["code.compiles", "code.tests_pass"],
    groundTruth: "EXPLICIT",
  },
  {
    name: "code-inferred",
    family: "code",
    spec: "Write a Node.js function that reverses a string, with unit tests.",
    targetMethods: ["code.compiles", "code.tests_pass"],
    groundTruth: "INFERRED",
  },
  // v1 case design (2026-07-11) targeted content.presence/content.bounds and measured a 100%
  // "mislabel" rate on the -inferred case - but on inspection the compiler was mostly returning
  // MISSING, not mistagging EXPLICIT: a heading's exact title and a numeric word-count minimum
  // are arbitrary declared values with no obvious default, so a vague spec genuinely gives the
  // compiler no defensible one-sentence basis to invent them (VERDICT_SPEC.md §6 rule 2 - "if an
  // inference isn't defensible in one sentence, don't make it"). That's correct model behavior,
  // not the D5.5 tagging-boundary bug, so the case was replaced rather than treated as a
  // regression. content.format has no such arbitrary parameter - "delivered as JSON implies it
  // should actually be valid JSON" is exactly the same shape of default expectation as
  // code.compiles ("delivered code should obviously compile"), so it mirrors the code-explicit/
  // code-inferred pair directly.
  {
    name: "content-explicit",
    family: "content",
    spec: "Deliver our automated test results as a JSON report. The report must be valid, parseable JSON with no syntax errors.",
    targetMethods: ["content.format"],
    groundTruth: "EXPLICIT",
  },
  {
    name: "content-inferred",
    family: "content",
    spec: "Deliver our automated test results as a JSON report.",
    targetMethods: ["content.format"],
    groundTruth: "INFERRED",
  },
];

// Acceptance threshold + sample size (dated deviation from 100%, recorded 2026-07-11 - see
// CLAUDE_HISTORY.md). M2 is an LLM: not deterministic, so 100%/0% is not a realistic gate.
// Pre-FIX baseline measured 33/110 (30.0%) mislabeled across these cases (K=10 each); post-FIX
// measured 1/110 (0.9%), with exactly one case (code-inferred / code.tests_pass) not hitting 0%
// (9/10 correct = 90%).
//
// Originally set to 0.8 at K=5, which turned out to be a flaky gate, not a meaningful one: at a
// true correct-rate of 0.9, P(X>=4 of 5) ~= 91.9%, so the pinned test would red on pure sampling
// noise ~8% of the time with no real regression. A textbook fix (a one-sided 95% confidence
// lower bound, e.g. Wilson/Clopper-Pearson, instead of a raw ratio) does not help at any
// live-call-affordable K either - worked the numbers: even a perfect K=20 run (18/20) only
// yields a ~0.74 Wilson lower bound, short of 0.8; clearing 0.8 with a true rate of ~0.9 needs
// K in the ~50s, too many live Opus calls to be worth it here.
//
// The gate's actual job is narrower than "certify the true rate is precisely >=0.8" - it only
// needs to catch a real regression back toward the pre-FIX ~20-30%-correct range. That needs
// separation, not statistical tightness, so: K bumped modestly to 10 (general stability) and
// the threshold lowered to 0.6 - comfortably below the measured ~90-100% current rate, and
// comfortably above the pre-FIX failure range, so normal run-to-run variance can't flake it. At
// true p=0.9, K=10, threshold 0.6 (need >=6/10), the false-fail probability is negligible
// (<0.01%), while a regression back to ~20-30% correct still trips it hard.
export const ACCEPTANCE_MIN_CORRECT_RATE = 0.6;
export const ACCEPTANCE_K = 10;
