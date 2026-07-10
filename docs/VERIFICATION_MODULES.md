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
**Correctness**; we also assess **Safety** by subcontracting `okx-security`:
- `onchain.safety` — is the delivered token a honeypot / malicious contract? Were the
  approvals set during the job dangerous?
So a swap that delivered "512 OKB to the right wallet" is PASS on correctness but the verdict
also carries a Safety criterion — and if the token is malicious, that criterion FAILs and the
headline reflects it. **No other verifier concept checks that a correct delivery is also
safe.** This is a genuine edge and it's built from an existing OKX skill (composability story
intact — we are okx-security's *consumer*, not its competitor).

### How it reads the chain
- **Default:** OnchainOS CLI skills — `okx-agentic-wallet` (tx history, contract-call reads),
  `okx-onchain-gateway` (tx simulation/tracking), `okx-dex-token` (token metadata, holder
  analysis), `okx-security` (safety). Read each `SKILL.md` for exact subcommands before use;
  never guess (CLAUDE.md rule). `--format json` always.
- **Own RPC fallback (L8):** build a direct RPC reader ONLY if the CLI is too slow,
  rate-limited, missing a needed field, or missing a chain we must verify. Keep the reader
  behind the same internal interface so callers don't care which backend answered.
- **Multi-chain by default:** because the CLI is multi-chain, the onchain verifier is
  natively multi-chain on day one — verify a bridge's *source* and *destination* legs on
  different chains in one job.

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

## M3.C — CODE SANDBOX (Tier 1) — fully our own build (OKX has nothing here)

For code deliverables. **Never execute delivered code on the host.**

### What it checks
- `code.compiles` — does it build in a clean, isolated environment?
- `code.tests_pass` — do the spec's stated tests (or provided tests) pass?

### Isolation requirements (hard)
- Run in a disposable container (Docker or equivalent), **no network** by default, CPU/mem/
  wall-clock caps, read-only mount of the code, non-root, killed and destroyed after each run.
- The sandbox is also an **ingest-hardening surface**: delivered code is hostile input.
  Output captured is *data* (compile logs, test results), never fed back as instructions.
- Language-agnostic runner: Node spawns the container; the container has the toolchain for
  the delivered code's language. Start with the languages our first real customers deliver;
  expand as needed (scope discipline — don't build 20 language images on spec).

### Evidence
`evidence.kind = "test_output"`, `ref` = captured log id, `detail` = pass/fail counts +
first failing case. If the sandbox can't build the environment the spec implies, the
criterion is **UNVERIFIABLE** (we couldn't test), not FAIL.

---

## M4 — CONTENT CONFORMANCE (Tier 2, plus Tier-1 countables)

For prose/report/translation/documentation deliverables. This module straddles tiers — be
strict about which check is which.

### Tier-1 countables (still confidence 1.0)
- `content.countable` — word count, section count, "must contain N code examples", required
  headings present, language is the requested language, file parses/opens. These are
  mechanical: count them, don't judge them.

### Tier-2 grounded judgments (calibrated confidence, evidence-anchored)
- `content.coverage` — does it actually address each required topic/point from the spec?
  Evidence = the passage that covers each point (or its absence).
- `content.source_grounding` — do cited sources exist and support the claims that cite them?
  Evidence = the fetched source + the supported/contradicted determination.
- `content.no_hallucination` — are factual claims grounded rather than invented? Evidence =
  which claims could be grounded and which couldn't.

Every Tier-2 result **must** attach `evidence.kind = "source_check"` with a concrete pointer.
A Tier-2 verdict with no inspectable evidence is a bug — demote to UNVERIFIABLE.

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