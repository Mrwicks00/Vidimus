# ROADMAP.md — VIDIMUS

Gated build plan. **This is not a to-do list — it is a set of gates.** Each checkpoint ends
with a `DONE-WHEN` condition that must be *literally true* before the next checkpoint may
start. Claude Code works **one checkpoint per go**, stops at the gate, shows what passed, and
waits (CLAUDE.md §2). Building ahead of a gate is forbidden.

Timeline assumes ~8 available days. **Submittable state is reached at the end of D3–D4** — the
onchain-only core is a complete, honest, listable product on its own. Everything after is
**upside**, not a race against zero.

Legend: 🔲 not started · 🟡 in progress · ✅ gate met

---

## D1 — PLATFORM FOUNDATION & UNKNOWNS  ✅
**Scope:** get on the platform for real; resolve the two blocking unknowns; skeleton endpoint.
- Install `okx/onchainos-skills`; confirm `onchainos` CLI runs.
- Read SKILL.md in order: `okx-ai-guide` → `okx-agent-task` → `okx-agent-payments-protocol` →
  `okx-security` (PLATFORM §1).
- **Resolve U1** (listing schema) and **U2** (response envelope). Record real shapes in
  PLATFORM §7; mark CLOSED with date.
- Register ASP identity (role=`asp`, ERC-8004 on chain 196) with sandbox creds.
- Stand up the skeleton A2MCP endpoint: returns a **dummy** verdict object (VERDICT_SPEC §1
  shape, empty criteria) behind the x402 402→pay→retry flow.

**DONE-WHEN:** one paid **sandbox** call round-trips end to end — caller hits endpoint → 402 →
pays → retries with paymentId → receives the dummy verdict JSON. **U1 and U2 are CLOSED.**
> Do not write any verification logic until this gate is met. If the SDK fights us, D1 may take
> the full day — that is expected and is the single biggest timeline risk.

---

## D2 — VERDICT SCHEMA + CRITERIA COMPILER  ✅
**Scope:** M6 schema real; M2 compiler real. Still no checkers.
- Implement the canonical Verdict + Criterion objects exactly per VERDICT_SPEC §1–§2
  (validation, canonical serialization scaffolding for later signing).
- Implement M2: spec → `criteria[]`, EXPLICIT/INFERRED tagging with `inference_note`, tier
  assignment, method assignment from the registry (VERDICT_SPEC §6). **Spec-only input**
  (never the deliverable — ARCHITECTURE §3 invariant).
- Implement headline computation (VERDICT_SPEC §4) over hand-fed dummy criteria results.
- Test the compiler on the 5 dry-run agents' specs (XLayer NFT Mint, Onchain Data Explorer,
  WorldCupCaller, Eat This?, CertiK) — eyeball the tagged checklists for sanity.

**DONE-WHEN:** feeding a real spec returns a correct, tagged, tiered `criteria[]`; headline
computation passes unit tests for PASS/FAIL/PARTIAL/UNVERIFIABLE cases.

---

## D3 — ONCHAIN VERIFIER (the wedge) + FIRST LIVE CHECK  ✅
**Scope:** M3.A. This is the strongest, most deterministic module — build it first.
- Implement onchain fact extraction via OnchainOS CLI (`okx-agentic-wallet`,
  `okx-onchain-gateway`, `okx-dex-token`): `tx_exists`, `transfer_check`, `owner_check`,
  `destination_check` (VERIFICATION_MODULES M3.A). `--format json`.
- Add the **Safety dimension** via `okx-security` (`onchain.safety`).
- Wire into dispatch: onchain criteria → this checker → per-criterion result + `evidence.kind=tx`.
- **First real verification:** run against a live onchain deliverable (e.g. an XLayer NFT Mint
  #2171 result) — confirm tokenId owner / destination / safety facts from chain.

**DONE-WHEN:** a real onchain deliverable produces a correct verdict with tx-level evidence,
including a Safety criterion. **This is the first build-in-public milestone** ("onchain verifier
catches destination/owner facts from chain"). Also: **submittable-state checkpoint** — from here
the product is a real, listable onchain-verification ASP.

---

## D4 — DUAL-PASS INGEST + SIGNING + ANCHOR  ✅
**Scope:** M5 (hardening) woven around existing checkers; M7 (signing) real.
- Implement quarantine ingest + the dual-pass boundary (SECURITY §2): raw deliverable → Pass 1
  fact extraction (hardened) → sealed → Pass 2 scoring reads only FactSet. Retrofit the D3
  onchain path behind this boundary.
- Add canary/leak detection (SECURITY §3): tripped canary → UNVERIFIABLE + flag, never PASS.
- Implement M7 signing (VERDICT_SPEC §5): canonical serialization → keccak256 → ECDSA with the
  Agentic-Wallet key bound to our ERC-8004 id; populate `signer` + `signature`.
- Ship a tiny **open verifier snippet** (client-side): recompute digest, ecrecover, check
  address↔erc8004 binding. (This is the "trust out of the box" piece; it may be published — it
  contains no SECURITY internals.)

**DONE-WHEN:** verdicts are signed and independently verifiable by the open snippet; a planted
injection in a test deliverable yields UNVERIFIABLE+flag (not PASS); the dual-pass boundary has
no path from raw deliverable to scoring model.

---

## D4.5 — SPEC-AWARE CLAIM↔CRITERION MATCHING (next-entry-point, before D5)  ✅
**Scope (corrected from the original D4 brief, doc-wins convention — see VERDICT_SPEC §2.2):**
replaced the positional claim-matching shortcut (D3/D4: Nth criterion of a method ↔ Nth claim
of that method, recomputed by loop position, never stored) with an explicit, compiler-assigned
`locator: { method, index }` stored on each `Criterion` (VERDICT_SPEC.md §2.2). Not "matching
by criterion id or content" as originally floated — that would let the deliverable redirect
which criterion it answers; instead the criterion declares its own locator at compile time,
before any deliverable exists, and the deliverable is only ever resolved against it, never
consulted to choose it. Stays Tier-1 deterministic: no LLM, no fuzzy/semantic matching.

**DONE-WHEN:** met, 2026-07-10, live paid round-trip (settlement tx
`0x6f9f606573a08511406fc8cbe35674a577502e7e04da9bb2b2b4d377463d3190`) against a real minted
test NFT (contract `0x170f236be4baa04f808d84f8eac0cfa46960e9c3`) — 4 compiled criteria: two
resolved their locator and checked to real PASS (`onchain.tx_exists`, `onchain.owner_check`),
two had locators that did not resolve (one omitted method, one second-occurrence index with no
second claim submitted) and correctly landed UNVERIFIABLE, never FAIL. Headline PARTIAL,
`headline_basis` listed all four. `scripts/verify-verdict.ts` recovered the signer and matched
it to the live on-chain ERC-8004 owner for agent id 4933.

---

## D5 — DATA/SCHEMA CHECKER + CODE SANDBOX  ✅ (M3.B ✅, M3.C ✅)
**Scope:** M3.B + M3.C.
- M3.B: `data.schema`, `data.rowcount`, `data.sample_verify` using the **adversarial sampling
  protocol** (SECURITY §4 — commit-after-delivery seed, non-public battery). Evidence=sample.
  **Shipped 2026-07-11 (Session 7)** — see CLAUDE_HISTORY.md. `deliverable.data` bucket added;
  locator `{method, index}` addressing (D4.5) extended to `data.*` methods unchanged. Seed =
  `keccak256(deliverable_hash ++ blockHash)` where `blockHash` is a real X Layer block read
  strictly after the deliverable's hash was committed by quarantine (bounded ~10s wait, else
  UNVERIFIABLE - never a guessed sample). Live-proven catching a planted "right tx, wrong
  claimed owner" fraud via real adversarial sampling against a real 15-row dataset (2 planted
  bad rows, sample of 10, caught tokenId 4) - `evidence.kind="sample"` with an auditable
  `seed_ref` (block number + hash) in evidence, sample size never surfaced.
- M3.C: isolated container runner for `code.compiles` / `code.tests_pass` — no network, resource
  caps, non-root, destroyed per run (VERIFICATION_MODULES M3.C). Delivered code is hostile input.
  **Shipped 2026-07-11 (Session 8)** — see CLAUDE_HISTORY.md. Real Docker (not a downgraded
  story), one Node.js image (JS+TS), no external dependencies in v1 (dated deviation, missing
  module → UNVERIFIABLE never FAIL), `deliverable.code` bucket added, locator addressing
  extended to `code.*`. Live-proven: 7 branches through a real Docker sandbox (clean
  compile+test PASS, syntax-error FAIL, hostile network-egress attempt genuinely blocked and
  FAILed, hostile infinite-loop wall-clock-killed to UNVERIFIABLE, external-dependency
  UNVERIFIABLE at both compile and test time) plus a full signed HTTP round trip (real
  settlement tx, M2 correctly tagged both methods, signature recovered and matched to the
  on-chain ERC-8004 owner).
- **Rust drop-in decision point (L7):** not exercised in either M3.B or M3.C - no real-world
  rowset/build performance signal to act on yet; default stays TS.

**DONE-WHEN:** a real dataset deliverable is sampled+verified with an auditable `seed_ref`
(✅ M3.B, Session 7); a real code deliverable compiles/tests in the sandbox with captured
evidence (✅ M3.C, Session 8); both return correct PASS/FAIL/PARTIAL/UNVERIFIABLE. **Met -
D5 closed.**

---

## D5.5 — M2 EXPLICIT/INFERRED TAGGING-BIAS FIX (dedicated slice, before D6)  ✅
**Scope:** last known correctness gap before D6 - M2 (Opus) reproducibly over-tagged
implied-but-unstated requirements as EXPLICIT instead of INFERRED, which could let the
compiler's own unstated assumption sink a headline to FAIL instead of capping at PARTIAL (L11).
- **REPRODUCE:** pinned 6-case bias-probe harness (`scripts/probe-m2-bias.ts` /
  `npm run probe-m2-bias`), K=10 live Opus calls per case across onchain/data/code families.
  Baseline: **33/110 (30.0%) mislabeled**, concentrated entirely in the "-inferred" cases (every
  "-explicit" case was 0% mislabeled) - worst offender was the mature `onchain.tx_exists`
  (100%), not a newer-method-specific gap as originally hypothesized.
- **DIAGNOSE:** root cause is a systematic EXPLICIT/INFERRED boundary confusion, not a
  few-shot gap on newer methods - the compiler conflated "the deliverable's defining action is
  named in the spec" (e.g. "mint an NFT") with "the specific checkable fact is literally
  stated" (e.g. "confirm a mint tx exists"), especially when the criterion text closely
  paraphrased the spec's own deliverable wording. Confirmed via sample compiler outputs
  (identical criterion text tagged EXPLICIT and INFERRED across different runs of the same spec).
- **FIX:** prompt hardening only, no post-compile validator - sharpened VERDICT_SPEC §6 rule 1
  in `buildSystemPrompt` (`m2-criteria-compiler.ts`) to state the boundary explicitly (EXPLICIT
  requires the *specific fact* to be asserted, not just the deliverable it verifies) plus 4
  worked few-shot examples spanning all three families, deliberately including the measured
  worst offender. Dual-pass/spec-only invariant untouched.
- **LOCK:** the 6 bias-probe cases are a shared fixture (`src/modules/m2-bias-cases.ts`) reused
  by both the ad-hoc harness and a pinned regression suite in
  `m2-criteria-compiler.test.ts`, gated behind `RUN_LIVE_M2_PROBE=1` (live model calls cost
  money/network, kept out of the default fast `npm test`, matching this project's existing
  live-proof-vs-unit-test separation). Post-FIX re-run (K=10 baseline harness): **1/110 (0.9%)
  mislabeled**, one residual case (`code-inferred`/`code.tests_pass`, 9/10 correct = 90%).
  **Acceptance threshold corrected mid-session** after a caught flaw: the first threshold
  (≥80% correct at K=5) was a flaky gate, not a meaningful one - at a true correct-rate of 0.9
  it would red on pure sampling noise ~8% of the time. A textbook fix (one-sided 95% confidence
  lower bound instead of a raw ratio) doesn't help at any live-call-affordable K either - even a
  perfect K=20 run only yields a ~0.74 Wilson lower bound against an 0.8 threshold; clearing 0.8
  with a true rate of ~0.9 needs K in the ~50s, too many live Opus calls to be worth it. Since
  the gate only needs to catch a real regression back toward the pre-FIX ~20-30%-correct range
  (not certify precision near the current ~90-100% rate), settled on **K=10, threshold ≥60%
  correct** - comfortably below current performance and comfortably above the pre-FIX failure
  range, giving a false-fail probability under 0.01% at the measured true rate. Re-ran the live
  gate at the corrected K=10/threshold=0.6: all 6 pinned cases passed (77/77 full suite, live
  cases included), typecheck clean.

**DONE-WHEN:** bias reproduced and quantified before any fix; root cause diagnosed with
evidence; minimal prompt-only fix preserving all locked invariants; pinned regressions added
with an explicit acceptance threshold; before/after mislabel rate shown (30.0% → 0.9%). **Met,
2026-07-11 - D5.5 closed. Next entry point: D6.**

---

## D6.A — CONTENT CONFORMANCE, TIER-1 ONLY  ✅
**Scope (session brief, 2026-07-11 — split from the original combined D6 below, doc-wins
convention, same pattern as D4.5/D5.5 being inserted as their own dedicated slices):** the
`deliverable.content` bucket and its four Tier-1 mechanical checkers only —
`content.presence`, `content.format`, `content.bounds`, `content.pattern`
(`docs/VERIFICATION_MODULES.md` M4, `src/modules/m3-content.ts`), replacing the earlier
single `content.countable` stub. Tier-2 grounded checks (`content.coverage`/
`source_grounding`/`no_hallucination`) and the calibration log are explicitly **not** in this
slice — deferred to **D6.B** below. Preserved every locked invariant: dual-pass (compiler
never sees the deliverable), EXPLICIT/INFERRED asymmetry (L11), and the D4.5
locator-resolution contract, extended to content as the fourth locatable method family
alongside onchain/data/code.
- **DESIGN gate:** checker set proposed and confirmed before code — see
  `VERIFICATION_MODULES.md` M4 for the final mechanical/UNVERIFIABLE boundary per checker,
  including the deliberate security narrowing of `content.pattern` to a small vetted pattern
  registry rather than a caller-supplied regex (ReDoS hardening — the deliverable is hostile
  input, and a claim-controlled regex compiled against claim-controlled content is a
  textbook attack surface with no existing sandboxing/timeout infra to mitigate it here).
- **BUILD:** `src/verdict/types.ts` (`ContentMethod` family, widened `LocatableMethod`),
  `src/security/quarantine.ts` (`quarantineContentDeliverable` + Pass-1 `extractContentAsset`
  — word/char/line/section counts, heading list, JSON parse, CSV header parse, mirrors
  `m3-data.ts`'s `DataFactSet` extraction-at-quarantine boundary), `src/modules/m3-content.ts`
  (the four checkers + dispatch), wired into `src/routes/verify.ts` alongside onchain/data/code.
- **TESTS:** 22 unit tests (`src/modules/m3-content.test.ts`), including an adversarial case:
  a document that **genuinely contains** a required heading, but whose deliverable never
  submits the matching `content.presence` claim, resolves UNVERIFIABLE — never PASS by
  freelance-reading the document (exercises the D4.5 contract for the new family; this is the
  hard line that keeps Tier-1 content mechanical, not smuggled semantic judgment). Plus a
  pinned content-family EXPLICIT/INFERRED bias-probe pair (`content-explicit`/
  `content-inferred`, added to `src/modules/m2-bias-cases.ts`, same K=10/≥60%-correct
  acceptance convention D5.5 locked). First case design (targeting `content.presence`/
  `content.bounds`) produced a false signal — the compiler was correctly declining to invent
  an arbitrary word-count/heading-title value from a vague spec (not a bug); redesigned around
  `content.format`, a direct structural analog to `code.compiles` with no arbitrary parameter.
  That redesign then measured a **real** recurrence of the D5.5 tagging-boundary-confusion bug
  in the new family (`content-inferred`: 10/10 mistagged EXPLICIT) — the D5.5 prompt fix's
  few-shot examples were onchain/code-specific and didn't transfer zero-shot to `content.*`.
  Fixed the same way D5.5 did: one more worked example added to `buildSystemPrompt`
  (`m2-criteria-compiler.ts`), naming the content-format case explicitly. Re-measured: 1/20
  (5%) mislabeled, `content-inferred` at 9/10 (90%) — same residual shape D5.5 saw on
  `code-inferred`, comfortably inside the K=10/≥60% threshold.
- **LIVE PROOF:** real paid x402 round-trip (settlement tx
  `0x005ae301a1391c13a14bcfa7aef48f73ed9ec93902c57497ff4ceec182e22a6c`, confirmed on-chain) —
  a Markdown changelog deliverable against a 4-requirement spec produced 5 compiled criteria
  (4 EXPLICIT + 1 bonus INFERRED) spanning all four Tier-1 content methods: `content.presence`
  FAIL (heading genuinely absent, mechanical evidence), `content.bounds` PASS (208 words ≥
  200), `content.format` PASS (2 markdown headings found), `content.pattern` and the extra
  INFERRED `content.format` both UNVERIFIABLE (claims deliberately omitted — the D4.5 contract
  firing live, not just in unit tests). Headline correctly sank to **FAIL** (EXPLICIT FAIL
  present, L11), `headline_basis` listed all 5. `scripts/verify-verdict.ts` recovered the
  signer and matched it to the live on-chain ERC-8004 owner for agent id 4933
  (`0xc66f8b978ce501560a9fc6b7161052df8680f7e0`).

**DONE-WHEN:** met, 2026-07-11 — a content deliverable returns correct Tier-1 mechanical
results with evidence across a genuine PASS/FAIL/UNVERIFIABLE mix, live-proven end to end with
a real settlement and a matched signature. **D6.A closed. Next entry point: D6.B.**

---

## D6.B — CALIBRATION LOG  ✅
**Scope (session brief, 2026-07-11 — split from the original combined D6.B, doc-wins
convention, same pattern as D4.5/D5.5/D6.A being inserted as their own dedicated slices):**
the auditable calibration log only — the append-only record that makes Tier-1 determinism
provable to a third party. Tier-2 grounded content checks (`content.coverage`/
`source_grounding`/`no_hallucination`) are explicitly **not** in this slice — deferred to
**D6.C** below. No new checkers, no verdict-shape changes; every locked invariant (dual-pass,
EXPLICIT/INFERRED asymmetry, locator binding, signed verdicts) stands untouched.
- **DESIGN gate:** schema, storage, and integrity model proposed and confirmed before code.
  `CalibrationLogEntry` (`src/calibration/types.ts`) keyed by `verdict_signature` +
  `verdict_digest`, carrying `ruleset_version`/`ruleset_hash`, `signer`, `payment_id` (== the
  x402 settlement tx in this system — `x402/middleware.ts` sets `paymentId =
  settlement.transaction`, one field not two), `headline`/`headline_basis`, and per-criterion
  `{id, method, tier, confidence, result, evidence_kind, locator}` — deliberately
  `evidence.kind` only, never `evidence.ref`/`detail`, so the log never retains a second,
  ungoverned copy of deliverable-derived text. This supersedes `ARCHITECTURE.md` §5's earlier
  conceptual sketch (predates locators/`evidence.kind`/content, and had a `verdict_confidence`
  field the real `Verdict` type never had) — rewritten to match, same "fix the doc" practice as
  the D4 signing-envelope correction. **Storage:** append-only JSONL (`data/calibration-log.jsonl`,
  not committed — runtime state). **Integrity: hash-chained rows**
  (`entry_hash[n]` folds in `prev_hash = entry_hash[n-1]`), chosen over a per-row wallet
  signature — each row already embeds the verdict's own EIP-191 signature (content-authenticity
  is inherited, forging a row requires forging that signature), what a signature alone can't
  prove is that the log wasn't quietly edited/pruned/reordered after the fact, which the chain
  catches in one linear pass; also avoids a second real TEE-wallet round trip on every request.
- **BUILD:** `src/calibration/types.ts`, `src/calibration/log.ts`
  (`appendCalibrationEntry`/`readCalibrationLog`/`verifyChainIntegrity`, write-queued per path
  so concurrent `/verify` calls append serially, no chain races), `src/calibration/spotcheck.ts`
  (the reproducibility mechanism — see below). Wired into `src/routes/verify.ts` right after
  signing; failures are swallowed (`console.warn` only) per `ARCHITECTURE.md` §3's own boundary
  rule that calibration "must NOT affect the current response." `signVerdict`'s previously-
  discarded `digest` return value is now threaded through. `src/config.ts` gained
  `calibrationLogPath` (default `data/calibration-log.jsonl`, gitignored).
- **Reproducibility spot-check** (`src/calibration/spotcheck.ts`,
  `scripts/spot-check-calibration.ts`): re-runs a logged Tier-1 criterion through the **real
  production checker dispatch** (`applyOnchainChecks`/`applyDataChecks`/`applyCodeChecks`/
  `applyContentChecks` — not a reimplementation) against a freshly re-quarantined copy of the
  same raw deliverable, bypassing M2 entirely — M2 (Opus) is the pipeline's only
  non-deterministic component and has its own, already-tracked reproducibility axis (the
  m2-bias-cases.ts pinned suite); this slice's claim is specifically about Tier-1 confidence=1.0
  determinism. Noted, not hidden: `data.sample_verify`'s seed depends on a chain-tip block read
  strictly after quarantine (`SECURITY.md` §4.1), so it won't reproduce byte-identically by
  construction — the mechanism is generic across all four Tier-1 families but is exercised
  end-to-end against `content.*` (no time-varying input, the cleanest demonstration).
- **TESTS:** 14 new offline unit tests (`src/calibration/log.test.ts`,
  `src/calibration/spotcheck.test.ts`, no live calls) — entry shape correctness and
  evidence.kind-only redaction; headline logged correctly across PASS/FAIL/PARTIAL/UNVERIFIABLE;
  UNVERIFIABLE-vs-FAIL distinguished per criterion by evidence_kind; hash chain holds across
  sequential *and* concurrent appends (write-queue race test); three tamper-detection cases
  (mutate a field, delete a row, reorder two rows) each caught by `verifyChainIntegrity`; the
  spot-check mechanism reproduces real `content.presence`/`content.bounds`/`content.format`
  results via the actual `applyContentChecks` dispatch, plus a deliberate-mismatch case proving
  the comparison itself is live, not a rubber stamp. `npm test`: 115/115 (107 pass, 8 correctly
  skipped `RUN_LIVE_M2_PROBE`-gated cases), `npm run typecheck` clean.
- **PROOF:** `scripts/prove-calibration-log.ts` — zero new Opus calls (per this session's
  explicit direction), zero new payment. Bypasses M1/M2 the same way
  `verify-code-sandbox.ts`/`verify-data-sample.ts` already do; hand-reconstructs the exact
  5-criterion set M2 actually compiled in the D6.A live proof (4 EXPLICIT + 1 bonus INFERRED
  `content.format`, `CLAUDE_HISTORY.md` Session 10) against the same
  `scripts/fixtures/content-deliverable.json`, tagged with that session's real settlement tx
  (`0x005ae301a1391c13a14bcfa7aef48f73ed9ec93902c57497ff4ceec182e22a6c`) as `payment_id` rather
  than spending a new one. Real Tier-1 checker execution reproduced the identical mix
  (`content.presence` FAIL, `content.bounds`/`content.format` PASS, `content.pattern` +
  bonus `content.format` UNVERIFIABLE, headline FAIL) confirmed against a standalone dry run
  before the real signing call. Signed for real via `onchainos wallet sign-message` (no LLM),
  appended to `data/calibration-log.jsonl`, log integrity OK, and all 5 Tier-1 criteria
  re-verified identical via the spot-check mechanism. `npm run spot-check-calibration` (the
  general-purpose CLI, not just the proof script) independently confirmed the same result
  against the logged entry by `job_id`.

**DONE-WHEN:** met, 2026-07-11 — schema/storage/integrity model designed and confirmed before
code; logging wired into the verdict-issue path without affecting the response; append-only
integrity holds under concurrent writes and three tamper scenarios; a real signed verdict was
logged and its Tier-1 criteria reproduced identically via the spot-check mechanism, zero Opus
spend. **D6.B closed. Next entry point: D6.C.**

---

## D6.C — TIER-2 CONTENT GROUNDING  🔲
**Scope:** the remainder of the original combined D6.B — not started, not touched by D6.B's
session (explicit scope lock).
- M4 Tier-2 grounded checks (`content.coverage`, `content.source_grounding`,
  `content.no_hallucination`) — each result carries a `source_check` evidence pointer.
  Enforce the **taste hard-stop** (Tier 3 → UNVERIFIABLE) at the LLM-judgment boundary these
  checks sit right next to. Tier-2 confidence stays capped until the now-standing calibration
  log (D6.B) accrues enough logged verdicts/outcomes to calibrate against (note the cap in
  `summary` per `VERDICT_SPEC.md` §2.1).

**DONE-WHEN:** a content deliverable returns tiered results (Tier 1 *and* Tier 2) with
evidence and a correct taste refusal.

---

## D7 — LISTING + LIVE DEMO RUNS  🟡
**Scope:** M8. Go live; generate real footage.
- **Permanent hosting + listing submitted (2026-07-12).** Deployed to Render
  (`https://vidimus.onrender.com`, Node web service, `npm install && npm run build` /
  `npm start`) - the D1 blocker note ("don't activate until a permanent host exists") is now
  resolved. Fixed a stale `resource.description` in the 402 challenge left over from the D1/D2
  skeleton ("checkers not yet wired") that was still live in production. Repointed agent
  4933's A2MCP service to the Render endpoint via `onchainos agent update` (a stale D1
  service pointing at a dead `trycloudflare.com` tunnel was discovered - not the "empty
  serviceList" `agent get-agents` misleadingly showed; the dedicated `agent service-list`
  command is the authoritative read) - cleaned up two rounds of accidental duplicate services
  along the way (`operation:create` isn't idempotent; re-running it, including once from a
  second machine, creates a new entry each time) before landing on exactly one correct
  service. `agent activate` submitted 2026-07-12: **"Listing under review"**
  (`approvalRemark: "AI quality review suggested pass"`), ~24h review per PLATFORM §5; the
  endpoint is already publicly callable by agent id pre-approval.
- **Production signing gap found and fixed (2026-07-12) - the real work of this slice.**
  `signVerdict()` (`src/verdict/sign.ts`) shells out to `onchainos wallet sign-message` -
  first production paid round-trip **settled a real payment** (tx
  `0x005ae301a1391c13a14bcfa7aef48f73ed9ec93902c57497ff4ceec182e22a6c`) **then 500'd**,
  because Render's container has neither the `onchainos` binary nor an authenticated wallet
  session. Root-caused before any fix (money-moved-for-nothing is exactly the failure mode
  L9/M7 exists to prevent): the officially-documented headless path is OKX API-Key auth
  (`OKX_API_KEY`/`OKX_SECRET_KEY`/`OKX_PASSPHRASE`, silent `onchainos wallet login`) - but
  every API key generated via the dev portal's "Connect Wallet" screen resolved to a
  *different* OKX account than the one owning agent 4933 (confirmed via the CLI's own
  built-in mismatch guard - `wallet login` warns and refuses to switch without `--force`, so
  no session was ever corrupted while diagnosing this). Root cause, confirmed against the
  live OKX dev-docs (not guessed): "Click Connect Wallet to **create or log in** to an
  account" - connecting a wallet not already linked to the email-based Agentic Wallet
  provisions a *new* dev-portal identity rather than authenticating the existing one; the
  Agentic Wallet (TEE-managed, no externally-held key) structurally has no wallet to connect
  with that screen at all. **Fix, shipped instead:** the `onchainos` binary committed directly
  into the repo (`bin/onchainos` - a public tool, not a secret, verified working since it's
  the exact binary used for every `onchainos` command this whole project) plus a Render start
  script (`scripts/render-start.sh`) that restores an already-authenticated session
  (`session.json`/`keyring.enc`/`machine-identity`/`wallets.json`) from Render's **Secret
  Files** (base64-encoded, never committed - staged locally then deleted, `.gitignore`d
  against recurrence) into `$HOME/.onchainos` before the server starts. Verified this crosses
  machines, not just paths: the identical session that authenticates in this dev sandbox and
  on the developer's own machine also authenticated cleanly inside Render's container (deploy
  log: `loggedIn: true`, matching `accountId`) - re-ran the exact production paid round-trip
  after the fix and got a **real signature** back this time
  (tx `0xebc47e9f3cf306aa0e920ebd2995997ca0b197f99e6ffe29e39ac5d1b11cd4ec`), confirmed via
  `scripts/verify-verdict.ts`: recovered signer matches `signer.address`, and `signer.address`
  matches the live on-chain ERC-8004 owner of agent id 4933. This is now the standing answer
  for "how does a deployed Vidimus instance sign," not a one-off workaround - worth folding
  into `PLATFORM.md`/`SECURITY.md` at the next docs pass (not done this session - scope was
  proving the round-trip, not writing it up permanently).
- Still open before D7 can close: the pricing decision below, ≥3 live verifications across
  kinds, and demo footage.
- Confirm pricing against the real U1 schema (PLATFORM §4): **decided 2026-07-11 - flat 0.1
  USDT per job, no tiers**, replacing the originally-planned Base/Chain/Chain+Safety/Deep table.
  Before going live, still confirm: (1) the M2 `compileCriteria()` Opus cost - **measured
  2026-07-11** (`scripts/measure-m2-cost.ts`, 3 real Opus calls, all `thinking: adaptive` +
  `effort: high` as shipped): content spec (D6.A fixture, 5 criteria) → 3297 in / 358 out
  tokens, **thinking_tokens: 0** → **$0.0254**, 74.6% margin. Onchain spec (the
  `test-buyer.ts` NFT-mint fixture) run **twice** to check variance, not assumed from one
  sample: run 1 → 3486 in / 3078 out (**thinking_tokens: 2318**), 8 criteria → **$0.0944**,
  **5.6% margin**; run 2 (same spec, same code) → 3486 in / 2538 out (**thinking_tokens:
  1550**), 12 criteria → **$0.0809**, **19.1% margin**. Both onchain runs land in a thin,
  unstable margin band an order of magnitude worse than the content spec, and the same input
  produced a different criteria count (8 vs 12) as well as different thinking spend -
  **finding: cost is spec-shape-dependent, not a fixed per-job constant, and onchain-style
  specs are the expensive case** (more entities/facts to reason through -> adaptive thinking
  runs longer). At the observed low end (5.6%), a single retry-on-transient-failure or a
  slightly harder onchain spec could plausibly go **negative** - this is a real pricing risk,
  not a solved item. **Decision, 2026-07-11: stay at 0.1 USDT for the hackathon**, thin
  onchain-segment margin knowingly accepted rather than solved - explicitly a revisit-later
  call, not a resolved one, worth reopening (price bump, `effort` cap, or per-complexity
  pricing) if the service gets real traction post-hackathon. Options considered and shelved
  for now: cap `effort` below `high` for M2 specifically (cheaper, may cost tagging accuracy
  - would need a bias-probe re-run per D5.5's own precedent), price by spec complexity
  instead of flat. Data/code deliverable kinds and the `okx-agentic-wallet security`
  subcontract cost remain unmeasured - not blocking at the accepted 0.1 USDT price, but
  worth knowing before any future price revisit.
  (2) the `okx-agentic-wallet security` subcontract's real cost also fits under the same flat
  price - not yet measured.
- **Submit the A2MCP listing for OKX review** (~24h, parallel) — do this **early in the day** so
  review overlaps, not blocks (PLATFORM §5).
- Run live verifications against 3+ real agents across kinds (onchain: #2171; data: #2023; plus
  one content/other). Each is a real paid call **and** demo capture.
- Capture the money shot: catch a real failure/fraud on camera (wrong destination, fake rows,
  malicious token) → the winning clip.

**DONE-WHEN:** listing submitted (review pending is fine); ≥3 live verifications recorded with
evidence; demo footage captured.

---

## D8 — BUFFER / POLISH / SUBMIT  🔲
**Scope:** slack + submission. (Deliberately reserved — do not pre-spend it.)
- Absorb any review feedback to get **live** (eligibility requires live).
- README (public — no SECURITY internals), demo video, submission form, the launch/thread on X.
- Final pass: every verdict has evidence; no Tier-3 scored; no raw-deliverable→scorer path; keys
  never logged.

**DONE-WHEN:** service is **live** on okx.ai, submission filed, thread posted.

---

## CHECKPOINT SUMMARY
| Day | Delivers | Gate essence |
|-----|----------|--------------|
| D1 | platform + skeleton | one paid sandbox round-trip; U1+U2 closed |
| D2 | schema + compiler | tagged criteria + headline tests pass |
| D3 | onchain verifier | real onchain verdict w/ tx evidence — **submittable** |
| D4 | dual-pass + signing | signed + injection→UNVERIFIABLE |
| D5 | data + code | sampled data + sandboxed code verdicts |
| D6.A | content Tier-1 | mechanical content checks, PASS/FAIL/UNVERIFIABLE mix, live-proven |
| D6.B | calibration log | append-only, hash-chained, real verdict logged + spot-check reproduced |
| D6.C | content Tier-2 | tiered content w/ taste refusal |
| D7 | listing + demos | hosted + listing submitted + prod signing proven; ≥3 live runs + footage still open |
| D8 | buffer + submit | live + submitted + posted |

---

## V2 PARKING LOT (do NOT build during the hackathon)
Ideas that will tempt scope creep. Park them; ship V1 first.
- Agent **quality index** built from our own verdict history (the smarter score the platform
  lacks — the old "Vetted" idea, now downstream of us).
- **Spec-writing** upsell (Specsmith): agents author specs against our criteria format.
- **A2A mode** listing for large custom/negotiated audits (escrow-side), beyond A2MCP.
- **session-intent** streaming subscriptions for continuous monitoring of a provider.
- Expanded language images for the sandbox; more chains; more Tier-2 grounding techniques.
- TEE **attestation** of which code produced a verdict (beyond signing).
- Reputation-graph / wash-trade forensics as a separate product.

Anything here is a *future* product. If it's not one of the 8 locked modules, it does not enter
this build.