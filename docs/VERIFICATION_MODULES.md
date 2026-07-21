# VERIFICATION_MODULES.md — VIDIMUS

Engineering spec for the checkers: **M3** (onchain / data / code sandbox, Tier 1) and
**M4** (content conformance, Tier 2). This is the machinery the buyer's own LLM does not
have — it is the answer to *"why pay you when my agent has an LLM built in?"*: **machinery +
accountability, never a smarter model.**

Every checker obeys the same contract (from `ARCHITECTURE.md` §3):
> input = quarantined blob (via safe extractors) + the relevant `criteria[]`;
> output = per-criterion `{ result, confidence, evidence }`;
> it must **not** write the headline verdict, and must **not** re-open the raw deliverable
> outside the safe-extraction path (dual-pass invariant).

Method names below must match the registry in `VERDICT_SPEC.md` §3.

---

## M3.A — ONCHAIN VERIFIER (Tier 1) — the strongest wedge

Onchain work is deterministic and chain-readable: this is where we're *provably* right.
Build this first (see ROADMAP D3).

### What it checks
Given a criterion about an onchain action (swap / bridge / transfer / mint / contract call)
and the seller's claim (usually tx hash(es) + expected outcome), extract **facts** from the
chain and compare to the criterion.

Fact table to extract per claimed tx:
- `onchain.tx_exists` — does the tx hash exist and is it finalized?
- `onchain.transfer_check` — did the expected asset/amount actually move (within tolerance)?
- `onchain.owner_check` — for mints/NFTs: is the resulting owner the party the spec names?
- `onchain.destination_check` — did funds/assets land at the **spec's** destination, not the
  seller's own address? (Classic fraud: correct amount, wrong recipient.)

### The Safety dimension (differentiator — do not skip)
A technically-correct delivery can still be poisoned. Correct amount + correct wallet is
**Correctness**; we also assess **Safety** by subcontracting `okx-agentic-wallet`'s bundled
`security` subcommands (`token-scan` / `tx-scan` — there is no standalone `okx-security`
skill, despite the registry's naming; see `PLATFORM.md` §1):
- `onchain.safety` — is the delivered token a honeypot / malicious contract? Were the
  approvals set during the job dangerous?
So a swap that delivered "512 OKB to the right wallet" is PASS on correctness but the verdict
also carries a Safety criterion — and if the token is malicious, that criterion FAILs and the
headline reflects it. **No other verifier concept checks that a correct delivery is also
safe.** This is a genuine edge and it's built from an existing OKX skill (composability story
intact — we are the `security` subcommands' *consumer*, not their competitor).

**Tier note (D3/D4 decision, live-tested):** `token-scan`/`tx-scan` return a genuinely graded
verdict (`riskLevel` CRITICAL/HIGH/MEDIUM/LOW; `action` ""/warn/block), not a plain binary
fact — confirmed live, including a real `warn` response driven by a heuristic caution
(`TRANSFER_TO_CONTRACT_ADDRESS`), not just doc-described. Per `VERDICT_SPEC.md` §2.1, only the
scanner's own definitive buckets (CRITICAL/block → FAIL, LOW/safe → PASS, both confidence 1.0)
are asserted; the graded middle (MEDIUM/HIGH/warn) is left UNVERIFIABLE rather than forced
into an uncalibrated Tier-2 number. `onchain.safety` stays registered Tier 1 on that basis —
see `src/modules/m3-onchain.ts` `checkSafety*`.

### How it reads the chain
- **Third-party tx facts** (`tx_exists`/`transfer_check`/`owner_check`/`destination_check`):
  **own direct `viem` RPC reader** (`src/modules/m3-onchain.ts`), not a CLI. The only installed
  skill, `okx-agentic-wallet`, has no arbitrary-tx-hash reader — its `wallet history
  --tx-hash` is scoped to the logged-in wallet's own order history (confirmed empirically
  against a real, unrelated tx — see `CLAUDE_HISTORY.md` Session 3). A seller's claimed
  deliverable tx is always third-party from our perspective, so this is a clean L8 case for
  building our own reader, not a shortcut. `okx-onchain-gateway` / `okx-dex-token`, previously
  named here as CLI backends, **do not exist** as installed skills — corrected.
- **Safety** (`onchain.safety`): `okx-agentic-wallet`'s bundled `security token-scan`/
  `tx-scan`. Read `references/security.md` / `security-cli-reference.md` for exact subcommands
  before use; never guess (CLAUDE.md rule). The CLI (v4.2.2) has no `--format json` flag at
  all — default stdout is already JSON; do not pass the flag, it errors.
- **Chain coverage differs between the RPC reader and the scanner:** the scanner does not
  cover X Layer testnet (chainId 1952, where our RPC reader and disposable test contracts
  live) at all — confirmed live (hard `Unsupported chainId` error on both commands). X Layer
  mainnet (196) is covered. So the Safety claim carries its **own** `chain`, independent of
  the chain the correctness legs read from — licensed by the next bullet.
- **Multi-chain by default:** because the CLI is multi-chain, the onchain verifier is
  natively multi-chain on day one — verify a bridge's *source* and *destination* legs, or a
  Safety scan, on a different chain than the correctness legs in one job.

### Evidence
`evidence.kind = "tx"`, `ref` = the tx hash(es), `detail` = the extracted fact in plain
language ("USDC 100.0 left 0xSrc at block N; OKB 512.0 arrived 0xBuyer; token 0x… flagged
SAFE by okx-security").

### Determinism note
All of the above are `confidence: 1.0` Tier-1 checks. If a chain is unreachable or a claim
references a tx that can't be found, that criterion is **UNVERIFIABLE** (blocked), not FAIL —
FAIL means we have evidence it's wrong; UNVERIFIABLE means we couldn't get evidence.

---

## M3.B — DATA / SCHEMA CHECKER (Tier 1)

For deliverables that are structured data (CSV/JSON/rowsets), e.g. "give me all X-Layer NFT
mints last 30 days, 5,000+ rows".

### What it checks
- `data.schema` — columns/types/shape match the criteria (right fields, right types).
- `data.rowcount` — plausible count vs the spec's expectation.
- `data.sample_verify` — **the core Tier-1 data check.** Draw a sample and verify each sampled
  record against ground truth (e.g. does this claimed mint tx actually exist onchain and
  actually contain a mint?). Also: duplicate detection, range checks, null/format validation.

### Sampling
The *interface* lives here; the *adversarial protocol* (seed derivation, sizing, rotation)
lives in `SECURITY.md` and must be used — do not implement naive/public sampling.
- The checker requests a sample set from the sampling service, receives `{indices, seed_ref}`,
  verifies those records, and records `evidence.kind = "sample"`, `ref = sampleset_id`.
- Detection math intuition: independent random sampling makes large-scale fakery
  overwhelmingly likely to be caught (e.g. ~50 samples vs 10% fake ≈ 99.5% catch) — but this
  only holds if the seller can't predict which rows we check. Hence the seed rules in
  `SECURITY.md`.

### Evidence
Per-criterion: schema diff, the count, and the sampled-record verification results (how many
sampled, how many verified, which failed and why).

---

## M3.C — CODE SANDBOX (Tier 1) — fully our own build (OKX has nothing here)  **Shipped 2026-07-11 (Session 8)**

For code deliverables. **Never execute delivered code on the host.**

### What it checks
- `code.compiles` — does it build in a clean, isolated environment?
- `code.tests_pass` — do the spec's stated tests (or provided tests) pass?

### Isolation primitive (live-verified, dated correction to the original brief's caution)
The original spec for this module hedged on whether a real container would be available
("Docker or equivalent"). **Resolved 2026-07-11: real Docker (28.2.2, daemon reachable) is
available and was individually exercised live before any code was written** — no downgraded
story needed. Confirmed live, one flag at a time:
- `--network none` — an outbound connect attempt fails immediately (`EAI_AGAIN`).
- `--user 1000:1000` — confirmed non-root inside the container.
- `--memory=64m --memory-swap=64m` — a memory-bombing script gets hard-killed;
  `docker inspect` confirms `OOMKilled=true, ExitCode=137`.
- `--pids-limit=16` — a fork-bomb script hits `EAGAIN` on the 17th spawn attempt.
- `--read-only` root filesystem + `--tmpfs /tmp` for scratch, `--cap-drop=ALL`,
  `--security-opt=no-new-privileges` — defense in depth beyond the four above.

**Operational gotcha, found live, encoded into the runner (`src/security/sandbox.ts`):**
`docker run --rm` in the foreground, killed via an external process timeout, does **not**
stop the container — it keeps running server-side after the CLI client dies. The runner
always runs detached (`docker run -d`), tracks the container id, and explicitly
`docker kill`/`docker rm -f`s it on timeout or completion — it never relies on its own
caller's timeout reaching the container.

### Toolchain scope (v1, dated deviation)
**v1 supports Node.js only — both JavaScript and TypeScript — one sandbox image**
(`node:20-slim` + `typescript` + `@types/node` + `tsx` baked in at **image build time**,
via `sandbox/node.Dockerfile` / `npm run sandbox:build`). Matches CLAUDE.md L6. Other
languages are explicitly deferred, not built on spec (per this module's own original
scope-discipline note).

**No external dependencies in v1.** The hard no-network-at-run-time requirement above means
the sandbox can never `npm install` a delivered project's dependencies (that would need
network, which is denied at run time by design — network is only ever used at *image build*
time, by us, ahead of any job). Code that references an external module the sandbox doesn't
have — surfaced as TypeScript diagnostic `TS2307` at compile time, or a `MODULE_NOT_FOUND`
crash at test time — resolves **UNVERIFIABLE, never FAIL**: we have no fair evidence the
code is broken, only that our v1 sandbox doesn't install dependencies. A *relative* import to
a file the deliverer simply didn't include (their own bug, not a sandbox limitation) still
resolves FAIL. Dependency support is deferred, explicit future work, not silently swallowed.

**Live-discovered subtlety worth flagging for the next session:** Node's own `--test` runner
doesn't always hard-crash on an unresolvable `require`/`import` — it can wrap a
`MODULE_NOT_FOUND` load failure into a single failing TAP pseudo-test instead of a bare
process crash. The missing-module check in `src/modules/m3-code.ts`'s `interpretTestsRun`
therefore runs *before* trusting any parsed pass/fail summary, not only in the "no summary at
all" branch — first discovered when a hand-built live test case briefly misclassified an
external-dependency case as a real FAIL instead of UNVERIFIABLE.

### `code.compiles` semantics
Never executes a single line of delivered code, on either language:
- **JS**: every delivered `.js`/`.mjs`/`.cjs` file is compiled (not run) via Node's `vm.Script`
  — a pure syntax check. A syntax error → FAIL. `vm.Script` never resolves `require`s, so a
  missing-module case can't arise here for JS — only via `code.tests_pass`.
- **TS**: every delivered `.ts`/`.tsx` file is type-checked as one `ts.Program` (so cross-file
  imports within the delivery resolve too) via the TypeScript compiler API directly — `noEmit`,
  structured diagnostics with real error codes, no free-text CLI parsing. `TS2307` → the
  missing-external-module UNVERIFIABLE bucket; any other diagnostic → FAIL.

### `code.tests_pass` semantics
- **JS**: `node --test <declared test files>`.
- **TS**: `tsx --test <declared test files>` (the `tsx` CLI binary directly, not
  `node --import tsx` — the bare-specifier `--import` form doesn't reliably resolve a
  globally-installed loader package regardless of cwd; the CLI binary does).
- Node's `--test` TAP summary footer (`# pass N`, `# fail N`, `# tests N`) is parsed
  mechanically — same non-instructable-extractor posture as the CSV parser in `SECURITY.md`
  §2.2: delivered stdout/stderr is never fed to an LLM or treated as instructions, only
  regex-matched against a format Node itself controls.

### Isolation requirements (hard) — implemented as designed
- Disposable container, **no network** at run time, CPU/mem/wall-clock/pids caps, read-only
  mount of the code, non-root, killed and destroyed after each run
  (`src/security/sandbox.ts`).
- The sandbox is also an **ingest-hardening surface**: delivered code is hostile input.
  Output captured is *data* (compile logs, test results), never fed back as instructions.
  File paths are validated twice (quarantine, then again in the runner before every write) —
  a `../` path becomes a real filesystem write location before the container's own isolation
  even engages, a host-safety concern distinct from prompt injection.

### Result mapping (locked before coding, live-proven — see CLAUDE_HISTORY.md Session 8)

| Condition | Result |
|---|---|
| Locator doesn't resolve / quarantine-rejected slot | UNVERIFIABLE |
| Sandbox image missing / Docker unreachable at request time | UNVERIFIABLE |
| `code.compiles`: syntax error (JS) / real diagnostic (TS, not `TS2307`) | **FAIL** |
| `code.compiles`: TS `TS2307` (external module) | UNVERIFIABLE |
| `code.tests_pass`: parsed fail count > 0, no missing-module signature | **FAIL** |
| `code.tests_pass`: crash or wrapped failure naming an external module | UNVERIFIABLE |
| `code.tests_pass`: crash naming the deliverer's own relative import, or any other crash | **FAIL** |
| Container OOM-killed | **UNVERIFIABLE** (resource cap, not evidence of wrongness) |
| Container hits the wall-clock budget, killed by the runner | **UNVERIFIABLE** (same reasoning) |
| Clean run, 0 failures, parseable output | **PASS** |

**A run killed on a resource/time cap is always UNVERIFIABLE, never FAIL** — "blocked ≠
failed" applied literally, including for a deliberately hostile deliverable (an infinite-loop
test that blows the wall-clock budget resolves UNVERIFIABLE, not FAIL, even though the intent
was obviously to defeat the check — we have no fair per-criterion evidence either way).

### Wire shape
`deliverable.code`: `{ code: CodeAsset[], "code.compiles": CodeCompilesClaim[],
"code.tests_pass": CodeTestsPassClaim[] }` — same `{method, index}` locator grammar as
onchain/data (`VERDICT_SPEC.md` §2.2), `LocatableMethod` widened to include `CodeMethod`.
Quarantine caps (`src/security/quarantine.ts`) reject oversized/unsafe assets and claims,
never truncate — including rejecting the entire asset if any single file path is unsafe.

### Evidence
`evidence.kind = "test_output"`, `ref` = `code:<assetId>:compiles|tests`, `detail` = pass/fail
counts + first failing case, capped at 500 chars (verbosity control only — unlike the M3.B
row-truncation prohibition, this cap can't hide fraud, it only trims log text).

---

## M4 — CONTENT CONFORMANCE (Tier 2, plus Tier-1 mechanical checkers)  **Tier-1 shipped 2026-07-11 (Session 10, D6.A); Tier-2 shipped 2026-07-21**

For prose/report/translation/documentation deliverables. This module straddles tiers — be
strict about which check is which.

### Tier-1 mechanical checkers (confidence 1.0 — D6.A, `src/modules/m3-content.ts`)

Four discrete methods, one per mechanical fact — same one-method-per-fact pattern as
M3.A/B/C, replacing the earlier single `content.countable` stub. Same claim-addressing
grammar as M3.A/B/C (`VERDICT_SPEC.md` §2.2): a criterion's `locator` points at
`deliverable.content[method][index]`.

**Wire shape** (`deliverable.content`): `{ content: ContentAsset[], "content.presence":
ContentPresenceClaim[], "content.format": ContentFormatClaim[], "content.bounds":
ContentBoundsClaim[], "content.pattern": ContentPatternClaim[] }`, where `ContentAsset =
{ id, format: "text"|"markdown"|"json"|"csv", content }`. Pass-1 extraction
(`src/security/quarantine.ts`'s `extractContentAsset`) converts each raw asset into a
`ContentFactSet` once at quarantine time (word/char/line/section counts, heading list, JSON
parse result, CSV header parse result) — the checkers only ever read this, never re-parse raw
bytes a different way (mirrors `m3-data.ts`'s `DataFactSet` boundary).

- `content.presence` — `{ assetId, target: { kind: "heading"|"json_key"|"csv_column"|
  "literal", value } }`. Resolves the target against the asset's own declared `format`
  (heading→markdown, json_key→json with dot-path object traversal (no array indices in v1),
  csv_column→csv header, literal→any format, raw substring search). Found → PASS; genuinely
  absent (structure parsed fine, target just isn't there) → **FAIL** with mechanical evidence
  of absence; target kind incompatible with the asset's declared format, or the asset doesn't
  parse as needed to resolve the target → **UNVERIFIABLE**.
- `content.format` — `{ assetId }` (no extra field — re-validates the asset's *own*
  self-declared `format`, mirrors `data.schema`'s "declared vs actual" spirit). json→
  `JSON.parse` succeeds; csv→header row present with no duplicate columns; markdown→≥1
  heading line found; text→trivially PASS (nothing structural to validate). Mismatch → FAIL.
- `content.bounds` — `{ assetId, metric: "word_count"|"char_count"|"line_count"|
  "section_count", min?, max? }` (at least one of min/max required, enforced at quarantine).
  In range → PASS; out of range → **FAIL**, evidence quantifies the exact shortfall/overage.
  Deliberately binary (not PARTIAL) to match the shipped `data.rowcount` precedent for the
  same "count vs threshold" shape — keeps a wildly-unmet EXPLICIT bound able to sink the
  headline to FAIL like any other broken EXPLICIT requirement (design gate, 2026-07-11).
- `content.pattern` — `{ assetId, pattern: "email"|"url"|"iso_date"|"semver" }`. Matches
  against a small **vetted pattern registry we own** (`CONTENT_PATTERNS` in
  `m3-content.ts`), deliberately **not** a caller-supplied regex string — the deliverable is
  hostile input by this project's own posture, and a claim-controlled regex compiled and run
  against claim-controlled content is a textbook ReDoS vector with no existing sandboxing/
  timeout infra to mitigate it. Every vetted pattern is hand-checked linear-time-safe (no
  nested quantifiers, no ambiguous overlapping alternation). Match → PASS; no match → FAIL;
  missing asset → UNVERIFIABLE.

All four: missing/quarantine-rejected asset → UNVERIFIABLE; locator doesn't resolve (no claim
submitted, index out of range, rejected slot) → UNVERIFIABLE, never FAIL, per the D4.5
resolution contract extended to this fourth locatable family. `evidence.kind = "extract"`
throughout.

**The hard line (design gate, 2026-07-11):** every Tier-1 content checker is purely
mechanical — exact string/regex/structural match against a declared, quarantined claim.
None of them ever read the criterion's free-text `text` field or reason about what a
document "seems" to satisfy. A criterion that would require meaning, quality, tone,
correctness, or topicality judgment is never assigned a Tier-1 content method at all (M2
leaves `method: null` if nothing mechanical fits, per `VERDICT_SPEC.md` §6 rule 4) — it is
never smuggled into one of these four checkers as a best-effort guess. Live-proven: a
document that **genuinely contains** a required heading, but whose deliverable never submits
the matching `content.presence` claim, resolves UNVERIFIABLE, not PASS — the checker never
freelance-searches the raw asset for what "seems" satisfied, it only resolves the declared
claim (`src/modules/m3-content.test.ts`'s adversarial case).

### Tier-2 grounded judgments (calibrated confidence, evidence-anchored — shipped this session)

Widening `CONTENT_METHODS` (`src/verdict/types.ts`) was the only change needed to make these
locatable - `assignLocators`/`isLocatableMethod` picked them up automatically, the exact extension
point that field was left for. M2's system prompt (`src/modules/m2-criteria-compiler.ts`) needed
one addition, though: without explicit guidance the model defaulted every content criterion to
`content.presence` (Tier 1) even when a Tier-2 method fit better - confirmed live before the fix,
corrected by adding a short rule distinguishing "one exact structural target" (presence) from
"a topic actually being addressed" (coverage) from "a citation being valid" (source_grounding).

- `content.coverage` (`src/modules/m3-content.ts` `checkCoverage`) — does the asset actually
  address the topic the criterion's own compiled `text` describes? A single LLM extraction call
  (`src/modules/m4-content-grounding.ts` `extractCoverage`) reads the asset text and the
  criterion's requirement text (both DATA, canary-protected same as M2) and returns
  `covered`/`confidence`/`evidence_passage`. Below `COVERAGE_CONFIDENCE_FLOOR` (0.5) →
  UNVERIFIABLE, never a low-confidence guess dressed up as PASS/FAIL.
- `content.source_grounding` (`checkSourceGrounding`) — buyer declares `citedUrls`; each is
  fetched via `src/security/source-fetch.ts` (SSRF-guarded: resolves the hostname itself,
  rejects private/reserved ranges including cloud metadata addresses, re-validates every
  redirect hop, size/timeout/content-type capped, retries transient network blips). Any
  unreachable citation → FAIL outright (the failure mode this method exists to catch). All
  reachable → `extractGrounding` (shared with no_hallucination) extracts claims and determines
  per-claim support; any contradicted → FAIL, all supported → PASS, otherwise PARTIAL.
- `content.no_hallucination` (`checkNoHallucination`) — buyer optionally declares `sourceUrls`
  to ground claims against; omitted (or all unreachable) → UNVERIFIABLE, honestly - no ground
  truth to check against, never a guess in either direction. Otherwise the same
  `extractGrounding` call, aggregated as `grounded/total` claims; any contradicted → FAIL.

Every Tier-2 result **must** attach `evidence.kind = "source_check"` with a concrete pointer
(a quoted passage, or the fetched URL + support determination). A Tier-2 verdict with no
inspectable evidence is a bug — demote to UNVERIFIABLE. Confidence is the model's own calibrated
float only for `content.coverage`, whose extraction schema emits one directly; the other two
aggregate discrete per-claim booleans (grounded/contradicted/undetermined) into PASS/FAIL/PARTIAL
the same deterministic way the Tier-1 checkers do, so they reuse that plain confidence-1.0-or-null
convention rather than a separate float.

### The hard stop (P2 / L4)
Anything that is **taste** — "is it professional?", "is it well-written?", "is it good?" —
is **Tier 3 → `taste.refused` → UNVERIFIABLE**. Do not score it. Do not let a Tier-2 check
quietly smuggle a taste judgment in. If a spec's only requirements are taste, the job's
headline is UNVERIFIABLE and the summary says so honestly ("criteria were subjective; Vidimus
verifies the checkable, not the tasteful").

---

## CROSS-MODULE NOTES

- **Tier discipline is the product.** A reviewer glancing at any verdict should be able to
  see, per line, whether we *knew* (Tier 1), *judged with evidence* (Tier 2), or *declined*
  (Tier 3). Never blur.
- **Evidence or it didn't happen.** No PASS/FAIL/PARTIAL without an `evidence` pointer.
  UNVERIFIABLE is the only result allowed to carry `evidence.kind="none"`.
- **Blocked ≠ failed.** Can't reach the chain / can't build the sandbox / missing data →
  UNVERIFIABLE. We reserve FAIL for "we have evidence it's wrong."
- **Rust drop-in point (L7):** the `data.sample_verify` hot path (verifying thousands of
  records) and/or the signing-integrity path are the sanctioned places to reach for Rust if a
  module demands performance or stricter correctness. Everything else stays TS. Keep it behind
  the checker interface so it's a swap, not a rewrite.
- **Composition:** M3.A subcontracts `okx-security`; the data checker may subcontract
  `okx-dex-token` for holder/metadata ground truth. Each subcontract is itself a paid OKX
  call — factor its cost into the pricing tier (never let a 0.01 job trigger unbounded paid
  lookups; see `PLATFORM.md` pricing).