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

## D1 — PLATFORM FOUNDATION & UNKNOWNS  🔲
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

## D2 — VERDICT SCHEMA + CRITERIA COMPILER  🔲
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

## D3 — ONCHAIN VERIFIER (the wedge) + FIRST LIVE CHECK  🔲
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

## D4 — DUAL-PASS INGEST + SIGNING + ANCHOR  🔲
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

## D5 — DATA/SCHEMA CHECKER + CODE SANDBOX  🔲
**Scope:** M3.B + M3.C.
- M3.B: `data.schema`, `data.rowcount`, `data.sample_verify` using the **adversarial sampling
  protocol** (SECURITY §4 — commit-after-delivery seed, non-public battery). Evidence=sample.
- M3.C: isolated container runner for `code.compiles` / `code.tests_pass` — no network, resource
  caps, non-root, destroyed per run (VERIFICATION_MODULES M3.C). Delivered code is hostile input.
- **Rust drop-in decision point (L7):** if `data.sample_verify` needs performance on large
  rowsets, this is a sanctioned place to reach for Rust behind the checker interface. Decide
  explicitly; default stays TS.

**DONE-WHEN:** a real dataset deliverable is sampled+verified with an auditable `seed_ref`; a
real code deliverable compiles/tests in the sandbox with captured evidence; both return correct
PASS/FAIL/PARTIAL/UNVERIFIABLE.

---

## D6 — CONTENT CONFORMANCE + CALIBRATION LOG  🔲
**Scope:** M4 + the P4 asset.
- M4 Tier-1 countables (`content.countable`) and Tier-2 grounded checks (`content.coverage`,
  `content.source_grounding`, `content.no_hallucination`) — each Tier-2 result carries a
  `source_check` evidence pointer. Enforce the **taste hard-stop** (Tier 3 → UNVERIFIABLE).
- Stand up the **CalibrationLog** (ARCHITECTURE §5): every verdict logged; schema ready to
  record `later_outcome`. Cap Tier-2 confidence until ground truth accrues (note it in summary).

**DONE-WHEN:** a content deliverable returns tiered results with evidence and a correct taste
refusal; every verdict writes a calibration row.

---

## D7 — LISTING + LIVE DEMO RUNS  🔲
**Scope:** M8. Go live; generate real footage.
- Finalize pricing tiers (PLATFORM §4) against the real U1 schema.
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
| D6 | content + calibration | tiered content w/ taste refusal; log live |
| D7 | listing + demos | listed + ≥3 live runs + footage |
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