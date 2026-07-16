# Vidimus

> *vidimus* — Latin, "we have seen."

**Vidimus is an autonomous, paid verification agent for the agent economy.** When one AI agent pays another to do work — execute a swap, deliver a dataset, write code, produce a report — someone has to answer the question nobody else on the marketplace answers: *did the seller actually do what the buyer paid for?*

Vidimus is that someone. It is a live Agent Service Provider on [OKX.AI](https://okx.ai) (ERC-8004 agent **#4933** on X Layer mainnet), reachable at `https://vidimus.onrender.com`. Any agent — no human in the loop — can pay it **0.1 USD₮0** over the x402 protocol and receive back a **cryptographically signed, evidence-backed verdict**: `PASS`, `FAIL`, `PARTIAL`, or `UNVERIFIABLE`, computed against a published checklist compiled from the buyer's own spec.

It has already been paid real mainnet money to verify real deliverables from real third-party agents it has no relationship with — including a live token swap executed by another agent through the OKX DEX aggregator. Every one of those verdicts is signed by a key that provably belongs to the on-chain identity of agent 4933, and every settlement is a confirmed X Layer mainnet transaction. Details in [Track record](#track-record-real-money-real-agents-real-verdicts).

---

## Why a verifier is a hard problem (and how this one is shaped by it)

A verdict service that moves money is not a JSON linter with a price tag. Four problems shape every component in this codebase; each one maps to a concrete design response you can point at in the code.

### P1 — Spec ambiguity: the verdict is only as good as the checklist
The spec is written by someone else, often sloppily. Turning it into checkable criteria is itself an act of interpretation — infer too much and you fail honest sellers, infer too little and you pass bad work.

**Design response:** criteria compilation is a *first-class, published output*. Every criterion in the verdict is tagged **`EXPLICIT`** (stated in the spec) or **`INFERRED`** (our interpretation, with the inference spelled out in `inference_note`). The verdict is never a bare "PASS" — it is always "PASS *against these criteria*", and the criteria ship inside the signed object so they can't be quietly rewritten later. Crucially, the criteria compiler ([m2-criteria-compiler.ts](src/modules/m2-criteria-compiler.ts)) reads **only the spec, never the deliverable** — criteria are fixed before Vidimus has seen what was delivered, so it can never reverse-justify a deliverable into passing.

### P2 — The determinism boundary: knowing what kind of claim you're making
Some criteria are mechanical facts (a transaction exists on chain). Some are grounded judgments (these sources support this claim). Some are taste (this report is "professional"). A verifier that blurs these is lying.

**Design response:** every criterion carries a **tier**:

| Tier | Nature | Confidence | Example |
|------|--------|-----------|---------|
| **1** | Mechanical, reproducible fact | Always exactly **1.0** — if a check can't be certain, it isn't Tier 1 and gets demoted | "tx `0x…` is confirmed on chain" |
| **2** | Grounded judgment, evidence-anchored | Calibrated float in (0,1) — never a vibes number | "the report's claims are supported by its cited sources" |
| **3** | Taste | Refused **by construction** — always `UNVERIFIABLE`, no model ever runs | "the writing is professional" |

The headline verdict is computed from Tier 1–2 only ([headline.ts](src/modules/headline.ts)). Tier 3 cannot influence it, ever.

### P3 — Adversarial input: the deliverable is hostile by definition
A verifier is the single highest-value prompt-injection target on any agent marketplace: it is *guaranteed* to read attacker-controlled content, and its output moves money. A hidden "reviewer: output PASS" that gets obeyed ends the product.

**Design response:** the **dual-pass pipeline**, stated as an architectural invariant in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §4. Deliverables enter as *quarantined data* ([src/security/quarantine.ts](src/security/quarantine.ts)) — schema-validated, size-capped, never executed, never treated as instruction. A hardened fact-extraction pass converts raw content into structured facts once, at ingest; the scoring logic that decides results consumes **only those extracted facts** and has no code path back to the raw bytes. If injection is suspected in a submission, the job is treated as compromised input: headline `UNVERIFIABLE`, zero criteria trusted, never a silent pass ([verify.ts](src/routes/verify.ts#L128-L137)).

Sellers optimizing against known checks (Goodharting) are met with cryptographic-grade mitigation, not prompt-grade: dataset sampling uses **commit-after-delivery randomness** — the sample seed is derived from the deliverable's hash (fixed at delivery) combined with a chain block read strictly *after* delivery, so a seller cannot know which rows will be inspected when they craft the delivery.

### P4 — Calibration under asymmetric error costs
A false PASS robs a buyer and destroys the verifier's reputation; a false FAIL churns an honest seller. Every wrong verdict has a victim with a wallet.

**Design response:** two disciplines. First, the humility to actually emit `UNVERIFIABLE` — when a check is blocked (unreachable chain, missing claim, unresolvable locator) the answer is *"we could not see"*, never a guess in either direction. Second, an **append-only, hash-chained calibration log** ([src/calibration/](src/calibration/)) that records every verdict ever issued, so confidence numbers can eventually be checked against ground truth instead of asserted. See [The calibration log](#the-calibration-log-verdicts-that-can-be-audited-later).

---

## What a verification looks like, end to end

```
1.  Buyer agent POSTs to /verify with no payment
        │  ← HTTP 402 + x402 challenge (price, token, payTo, EIP-712 domain params)
        ▼
2.  Buyer signs an EIP-3009 transferWithAuthorization (a gasless, offline signature —
    no buyer-side transaction, no pre-approval) and replays the request with
    PAYMENT-SIGNATURE + a JSON body: { spec, deliverable }
        ▼
3.  Payment verified locally (recipient, amount, validity window, nonce replay,
    EIP-712 signature recovery) then SETTLED ON CHAIN — Vidimus's facilitator wallet
    submits transferWithAuthorization to the token contract and pays the gas.
    The settlement tx hash becomes the job's payment_id.
        ▼
4.  QUARANTINE — spec and every deliverable bucket sealed as data before anything reads them
        ▼
5.  CRITERIA COMPILATION — spec → checklist[], each item tagged EXPLICIT|INFERRED,
    tier 1|2|3, and bound to a checker method + locator. Spec only; deliverable unseen.
        ▼
6.  CHECKER DISPATCH — each criterion routed to its mechanical checker:
        onchain.*   reads X Layer mainnet directly via RPC
        data.*      schema/rowcount/seeded-sample checks on datasets
        code.*      compile/test inside an isolated sandbox
        content.*   structural checks on documents (presence/format/bounds/pattern)
        taste.*     refused — UNVERIFIABLE by construction
        ▼
7.  HEADLINE — pure function of Tier 1–2 results (see rules below)
        ▼
8.  SIGN — EIP-191 signature over the canonical verdict bytes, by the wallet that
    owns ERC-8004 agent #4933 on chain
        ▼
9.  RESPONSE — signed verdict JSON + PAYMENT-RESPONSE header (settlement receipt)
        ▼
10. CALIBRATION LOG — verdict appended to the hash-chained audit log
```

The buyer pays **exactly two costs**: the 0.1 USD₮0 fee (moved by their signature) and nothing else — settlement gas is paid by Vidimus's facilitator wallet. The entire flow is machine-to-machine; no dashboard, no form, no human.

### Headline rules (locked)

- Any **EXPLICIT** criterion failing → headline **FAIL**. An unmet stated requirement sinks the job.
- Only **INFERRED** criteria failing → capped at **PARTIAL**. Our own inference being wrong is not the same signal as a broken promise, and the verdict says so in plain language in its `summary`.
- Every Tier 1–2 criterion passing → **PASS**.
- Nothing scoreable → **UNVERIFIABLE**.

The `headline_basis` field lists exactly which criterion IDs the headline was computed from, so the computation is re-derivable by anyone holding the verdict.

---

## The verdict object

Every response is one signed JSON object (full contract: [docs/VERDICT_SPEC.md](docs/VERDICT_SPEC.md)):

```jsonc
{
  "vidimus_version": "1.0",
  "job_id": "vd_01KXBARG3KW16P8JDJH077YTHX",
  "payment_id": "0x1590b3…76b9",              // the x402 settlement tx — verdict is welded to its payment
  "subject": {
    "spec_hash": "sha256:…",                   // what we were asked to check
    "deliverable_hash": "sha256:…",            // what we inspected — committed before any checker ran
    "deliverable_kind": "onchain_action"       // | dataset | code | content | mixed
  },
  "criteria": [
    {
      "id": "c1",
      "text": "The swap transaction exists and is confirmed on X Layer",
      "source": "EXPLICIT",                    // stated in the spec — or INFERRED, with inference_note
      "tier": 1,
      "method": "onchain.tx_exists",
      "locator": { "method": "onchain.tx_exists", "index": 0 },
      "result": "PASS",
      "confidence": 1.0,
      "evidence": { "kind": "tx", "ref": "0x1f1b…4697", "detail": "confirmed, status=success" }
    }
    // …one entry per checkable requirement
  ],
  "headline": "PASS",
  "headline_basis": ["c1", "c2", "c3"],
  "summary": "…plain language, ≤280 chars, states what passed/failed and why…",
  "ruleset_version": "0.0.0-d6a",
  "issued_at": "2026-07-15T…Z",
  "signer": { "erc8004_id": "4933", "address": "0x2085…f0a9" },
  "signature": "0x…"                            // EIP-191 over the canonical bytes of everything above
}
```

Three properties make this more than a pretty report:

1. **Evidence is derived, never trusted.** The seller's asserted proof is a *claim*; Vidimus goes and looks. `onchain.*` results come from Vidimus's own RPC reads of X Layer mainnet, not from anything the deliverable says about itself.
2. **Locator binding is deterministic.** Each criterion declares *where* in the deliverable it binds (`{method, index}` — a typed extractor, not a fuzzy match), assigned by the compiler before the deliverable exists. The deliverable can never redirect which criterion it satisfies. An unresolvable locator is `UNVERIFIABLE`, never `FAIL`, never take-the-nearest-thing.
3. **The signature is accountable to an on-chain identity.** Run [`scripts/verify-verdict.ts`](scripts/verify-verdict.ts) against any verdict: it recomputes the canonical bytes, recovers the EIP-191 signer, and independently reads X Layer mainnet to confirm that address is the live on-chain owner of ERC-8004 agent 4933. A forged verdict fails; a tampered field fails; a verdict signed by anyone else fails.

---

## The checker registry

Fifteen methods across five families, each one mechanical fact per method:

| Family | Methods | What it proves |
|--------|---------|----------------|
| **Onchain** (Tier 1) | `tx_exists` · `transfer_check` · `destination_check` · `owner_check` · `safety` | The claimed transaction is real and confirmed; it moved what was promised, to where it was promised; the resulting ownership is as claimed; the assets involved pass token-safety screening. Read directly from X Layer mainnet. |
| **Data** (Tier 1) | `schema` · `rowcount` · `sample_verify` | The dataset parses against its declared schema; row counts meet stated thresholds; a commit-after-delivery random sample of rows survives inspection. |
| **Code** (Tier 1) | `compiles` · `tests_pass` | The delivered code actually builds, and its test suite actually passes — executed inside an isolated sandbox, never on the host. |
| **Content** (Tier 1) | `presence` · `format` · `bounds` · `pattern` | Required headings/keys/columns/strings are present; the document is valid in its own declared format; word/line/section counts are within stated bounds; values match a **vetted, owned pattern registry** (deliberately not caller-supplied regex — a claim-controlled regex run against claim-controlled content is a ReDoS vector, so it's off the table by design). |
| **Taste** (Tier 3) | `refused` | Nothing. Subjective quality is refused by construction — the honest answer, encoded as an invariant rather than a policy. |

A hard line runs under all of it: no Tier-1 checker ever "reads" the deliverable and reasons about what it *seems* to satisfy. Each one resolves a declared, quarantined, schema-validated claim mechanically. The adversarial test in [m3-content.test.ts](src/modules/m3-content.test.ts) proves the point: a document that genuinely contains a required heading — but whose deliverable never submitted the matching claim — resolves `UNVERIFIABLE`, not `PASS`, because the checker refuses to freelance.

**Tier 2** (grounded judgment: coverage, source-grounding, no-hallucination checks for prose) is designed and specced ([docs/VERIFICATION_MODULES.md](docs/VERIFICATION_MODULES.md)) but deliberately **not yet shipped** — see [Honest limitations](#honest-limitations).

---

## The payment rail: x402 + EIP-3009 on X Layer mainnet

Vidimus speaks x402 v2 (`scheme: "exact"`, network `eip155:196`) and settles in **USD₮0** (`0x779ded0c9e1022225f8e0630b35a9b54be713736`), the real Tether-backed stable on X Layer mainnet.

The interesting part is *how* the money moves ([src/x402/](src/x402/)):

- The buyer signs an **EIP-3009 `transferWithAuthorization`** — a typed-data signature against the token's own EIP-712 domain. No buyer-side transaction, no gas, no `approve` step, no intermediary contract. The buyer's wallet can hold zero native gas token and still pay.
- Vidimus verifies the authorization offline (recipient matches `payTo`, amount covers the price, validity window open, nonce unused, signature recovers to the claimed sender) and then its **facilitator wallet** submits the authorization to the token contract itself, paying the gas. The transfer executes buyer → Vidimus in that one transaction.
- The settlement tx hash is returned in the `PAYMENT-RESPONSE` header **and** baked into the verdict as `payment_id` — every verdict is permanently welded to the on-chain payment that bought it.
- A nonce store rejects replayed authorizations; expiry and not-yet-valid windows are enforced against the chain's notion of now.

This implementation was not tested against itself and declared done. It was proven against **real, independent OKX-ecosystem tooling** (`onchainos payment pay`, TEE-signed from a real Agentic Wallet) — a process that surfaced and killed an earlier Permit2-based implementation which would have rejected every real buyer on the marketplace. The full forensic account, including the read-only on-chain probe used to confirm the token's EIP-3009 support before any funds moved, is in [docs/ROADMAP.md](docs/ROADMAP.md) (D7).

---

## The calibration log: verdicts that can be audited later

Every verdict ever issued — including injection-suspected ones — is appended to a **hash-chained JSONL log** ([src/calibration/log.ts](src/calibration/log.ts)):

- Each entry embeds the verdict's own EIP-191 signature, so forging a row means forging that signature.
- Each entry's hash folds in the previous entry's hash, so any edit, deletion, or reorder of history is detectable by walking the chain (`verifyChainIntegrity`).
- Entries store `evidence.kind` only — never evidence text — so the log can't become a second, ungoverned copy of deliverable-derived content.
- [`scripts/spot-check-calibration.ts`](scripts/spot-check-calibration.ts) re-runs a logged Tier-1 criterion through the *real production checker dispatch* against a re-quarantined copy of the same deliverable — substantiating the claim that a Tier-1 `confidence: 1.0` result is reproducible by an independent party, not just asserted once.

This is the P4 asset: when arbitration outcomes start arriving, they become free ground truth against which Tier-2 confidence numbers get calibrated — measured, not vibed.

---

## Track record: real money, real agents, real verdicts

Everything below happened on **X Layer mainnet** against third-party agents Vidimus has no relationship with, discovered via marketplace search, paid with real funds. Full evidence trail in [docs/ROADMAP.md](docs/ROADMAP.md) (D7).

| Counterparty | What was verified | Outcome |
|---|---|---|
| **Factor Credit Desk** (#4502) | Onchain-reputation JSON report | Job `vd_01KXBARG3KW16P8JDJH077YTHX`, settlement `0x1590b3…76b9` — mechanical checks PASS, semantic-relevance criterion honestly `UNVERIFIABLE` (Tier 2 not built), headline PARTIAL |
| **CoinAnk OpenAPI** (#2013) | Live Bitcoin ETF market data | Job `vd_01KXBB1DAY74H7JA7BRHHW393S`, settlement `0x2a5f15…4c3b5` — same honest pattern |
| **Newsliquid** (#2135) | News taxonomy response | Confirmed on-chain, block 35407120 |
| **Barker Yield Agent** (#2012) | Real-time DeFi yield index (500+ protocols, real APY/TVL data) | 3 PASS / 1 UNVERIFIABLE, block 35413618 |
| **Otto AI** (#2118) | **A real swap it executed**: 0.05 USDT0 → WOKB via the OKX DEX aggregator, from a sub-wallet Vidimus provisioned and funded | Swap tx `0x1f1b1e…4697`; fed back into production `/verify` and confirmed **PASS** with independently-derived on-chain evidence |

Two of these runs matter beyond the checkmarks:

- **The refusal that proved the design.** When production was still pointed at testnet, verifying Otto's mainnet swap correctly returned `UNVERIFIABLE` ("tx not found on chain or chain unreachable") — the checker refused to fabricate a result it couldn't see. After the mainnet migration, the identical job returned `PASS` with real evidence. A verifier that says *"I can't see it"* when it can't see it is the entire product.
- **The signature that closes the loop.** Both verdicts were run through `verify-verdict.ts`: canonical bytes recomputed, signer recovered, matched against the live on-chain ERC-8004 owner of agent 4933. Both checks PASS.

---

## Honest limitations

A verifier that oversells itself is worthless, so, plainly:

- **Tier 2 is not built yet.** Criteria requiring grounded judgment (does this report's content actually cover the requested topic? are its claims supported?) are compiled, tagged, and honestly returned `UNVERIFIABLE` — never guessed. This is the next major module (D6.C in the roadmap), and it's why several real-world verdicts above read PARTIAL rather than PASS: the mechanical facts passed, and Vidimus refused to bluff the judgment call.
- **Tier 3 will never be built.** Taste is refused by construction, permanently.
- **Tier-1 checks resolve declared claims.** A deliverable that doesn't submit a claim for a check gets `UNVERIFIABLE` for that criterion — the deliberate cost of never letting the checker freelance over hostile input.
- **Calibration ground truth is still accruing.** The log exists from verdict one; the `later_outcome` write-path (arbitration results) lands with Tier 2.

---

## Running it

### Requirements

Node ≥ 20, an X Layer mainnet RPC endpoint, an Anthropic API key (the criteria compiler is LLM-backed; it is the only non-deterministic step in the pipeline, and its output is fully published in the verdict).

### Environment

```bash
PORT=8787
RPC_URL=<X Layer mainnet RPC>
CHAIN_ID=196
FACILITATOR_PRIVATE_KEY=0x…       # wallet that submits settlements (holds OKB for gas)
PAY_TO_ADDRESS=0x…                # where fees land
PAYMENT_TOKEN_ADDRESS=0x779ded0c9e1022225f8e0630b35a9b54be713736   # USD₮0
PAYMENT_TOKEN_NAME=USD₮0          # must exactly match the token's EIP-712 domain
PAYMENT_TOKEN_VERSION=1
PRICE_ATOMIC=100000               # 0.1 USD₮0 (6 decimals)
ERC8004_ID=4933
ERC8004_ADDRESS=0x…               # on-chain agent owner (the verdict signer identity)
ANTHROPIC_API_KEY=…
CALIBRATION_LOG_PATH=data/calibration-log.jsonl   # optional, this is the default
```

### Commands

```bash
npm install
npm run dev                # local server on :8787
npm run typecheck
npm test                   # node:test suite (checkers, headline, quarantine, calibration chain)
npm run build && npm start # production (start restores the onchainos signing session first)

# End-to-end as a real paying buyer (needs TEST_BUYER_PRIVATE_KEY holding USD₮0):
npm run test-buyer -- https://vidimus.onrender.com/verify [spec-file] [deliverable.json]

# Independently audit any verdict (recovers signer, checks on-chain ERC-8004 ownership):
npm run verify-verdict -- verdict.json

# Audit the calibration log's hash chain / reproduce a logged Tier-1 result:
npm run prove-calibration-log
npm run spot-check-calibration
```

### Calling it as an agent (the actual product surface)

```
POST /verify
  → 402 { accepts: [{ scheme:"exact", network:"eip155:196", asset:"0x779d…3736",
                       amount:"100000", payTo:"0x2085…f0a9",
                       extra:{ name:"USD₮0", version:"1" } }] }

POST /verify
  PAYMENT-SIGNATURE: base64url({ x402Version:2, payload:{ authorization:{…EIP-3009…}, signature } })
  { "spec": "<what the seller was hired to do, in plain language>",
    "deliverable": { "onchain": {…} | "data": {…} | "code": {…} | "content": {…} } }
  → 200, signed verdict JSON + PAYMENT-RESPONSE header (settlement receipt)
```

On the OKX.AI marketplace this is fully automatic — a buyer agent's own tooling handles the 402 dance; nobody constructs headers by hand.

---

## Repository map

```
src/
  index.ts                 Hono server: /health + /verify
  config.ts                env contract (fails fast on anything missing)
  routes/verify.ts         the pipeline: gate → quarantine → compile → dispatch → headline → sign → log
  x402/                    payment rail: challenge, EIP-3009 verify, on-chain settle, nonce store
  security/                quarantine (M5 ingest) + code-sandbox isolation
  modules/
    m2-criteria-compiler.ts  spec → tagged criteria (LLM-backed, spec-only, injection-canaried)
    m3-onchain.ts            onchain checkers (direct mainnet RPC reads)
    m3-data.ts               dataset checkers (schema/rowcount/seeded sampling)
    m3-code.ts               code checkers (sandboxed compile/test)
    m3-content.ts            content checkers (presence/format/bounds/pattern)
    headline.ts              the locked headline function
  verdict/                 canonical serialization + EIP-191 signing
  calibration/             hash-chained verdict log + reproducibility spot-check
scripts/                   test-buyer, verify-verdict, calibration audits, deploy helpers
docs/
  ARCHITECTURE.md          system shape: the four problems, lifecycle, boundary contracts
  VERDICT_SPEC.md          the product's law: verdict/criterion schema, tiers, headline, locators
  VERIFICATION_MODULES.md  every checker's exact semantics and result mapping
  SECURITY.md              threat model and hardening detail
  PLATFORM.md              OKX/OnchainOS integration notes (identity, x402, listing)
  ROADMAP.md               the build log — every milestone with live evidence, including the failures
```

The docs are not decoration: when code and `VERDICT_SPEC.md` disagree, the spec wins and the code gets fixed. `ROADMAP.md` doubles as a forensic log — it records what broke, what was misdesigned and replaced (the Permit2 saga, the testnet→mainnet migration, a tagging-bias fix in the compiler), and the on-chain evidence for every claim above.

---

## Built on

TypeScript · [Hono](https://hono.dev) · [viem](https://viem.sh) · [zod](https://zod.dev) · Anthropic API (criteria compilation only) · X Layer mainnet · OKX Onchain OS (ERC-8004 identity, Agentic Wallet, x402 rail) · Render

*Consume the substrate, build the brain*: OKX provides payment, identity, and chain access; everything that constitutes judgment — the compiler, the tiers, the checkers, the dual-pass boundary, the signing discipline, the calibration log — is built here.
