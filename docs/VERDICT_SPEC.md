# VERDICT_SPEC.md — VIDIMUS

The product's law. This is the exact contract for M2 (criteria compiler), M6 (verdict
schema), and the signing half of M7. When code and this doc disagree, **this doc wins** —
fix the code. Changing the schema is a locked-decision-level event: update here first.

---

## 1. THE VERDICT OBJECT (canonical shape)

All fields are required unless marked `?`. Field order below is the **canonical order**
used for signing (see §5). JSON, UTF-8, no trailing whitespace, keys as written.

```jsonc
{
  "vidimus_version": "1.0",              // schema version string
  "job_id": "vd_<ulid>",
  "payment_id": "<paymentId from x402 settlement>",
  "subject": {
    "spec_hash": "sha256:<hex>",         // hash of the spec we compiled from
    "deliverable_hash": "sha256:<hex>",  // hash of the deliverable we inspected
    "deliverable_kind": "onchain_action|dataset|code|content|mixed"
  },
  "criteria": [ /* Criterion[] — see §2 */ ],
  "headline": "PASS|FAIL|PARTIAL|UNVERIFIABLE",   // computed per §4
  "headline_basis": ["<criterion_id>", ...],      // the tier1-2 ids that determined headline
  "summary": "<=280 chars, plain language, no marketing, states what passed/failed/why-unverifiable",
  "ruleset_version": "<semver of the check battery that ran>",
  "ruleset_hash": "sha256:<hex>",         // hash of the committed ruleset (P3)
  "issued_at": "<RFC3339 UTC>",
  "signer": {
    "erc8004_id": "<agent id on X Layer>",
    "address": "0x<verifier signing address>"
  },
  "signature": "0x<ecdsa sig over canonical bytes, see §5>"
}
```

`signature` is the only field excluded from the signed payload (obviously). Everything else
is signed.

---

## 2. THE CRITERION OBJECT

The atomic unit. One per checkable requirement. This is where P1 and P2 live.

```jsonc
{
  "id": "c1",                             // stable within a job
  "text": "Deliverable transfers >= 100 USDC from source chain",  // human-readable requirement
  "source": "EXPLICIT|INFERRED",          // P1: was this stated in the spec, or our interpretation?
  "inference_note": "spec said 'bridge my USDC' — amount inferred from prior line",  // required IFF source=INFERRED
  "tier": 1,                              // P2: 1 mechanical | 2 grounded | 3 taste
  "method": "onchain.transfer_check",     // which checker/technique ran (see registry §3)
  "locator": { "method": "onchain.transfer_check", "index": 0 },  // WHERE in the deliverable
                                           // this criterion binds - see §2.2. Absent when
                                           // method is null or has no locator scheme (Tier 2/3
                                           // content methods, taste.refused).
  "result": "PASS|FAIL|PARTIAL|UNVERIFIABLE",
  "confidence": 1.0,                      // see §2.1
  "evidence": {                           // REQUIRED for every non-UNVERIFIABLE result
    "kind": "tx|extract|test_output|sample|source_check|none",
    "ref": "0x<txhash> | offset:… | uri:… | sampleset_id:…",
    "detail": "OKB received 512.0 at 0xBuyer… matches destination"  // short, factual
  }
}
```

### 2.1 Confidence rules
- **Tier 1** → confidence is **1.0** or the criterion is not Tier 1. Mechanical checks are
  binary and reproducible. If you can't be certain, it wasn't really Tier 1 — demote it.
- **Tier 2** → confidence in **(0,1)**, **calibrated** against the CalibrationLog, never a
  vibes number. Until enough ground truth exists, Tier 2 confidence is capped (see
  `SECURITY.md`/`ROADMAP.md` calibration note) and the summary says so.
- **Tier 3** → `result` is **always UNVERIFIABLE**, `confidence` omitted/`null`, `evidence.kind`
  = `none`. No exceptions.

### 2.2 Locator binding (D4.5, 2026-07-10)

`locator` is how a criterion is deterministically bound to the specific value in the
deliverable it judges, replacing the D3/D4 positional-cursor shortcut (Nth criterion of a
method matched to the Nth deliverable claim of that method, recomputed by loop position and
never stored). Tier-1 deterministic: no LLM, no fuzzy/semantic matching. The criterion
declares where to look; the deliverable can never redirect which criterion it satisfies.

**Grammar — typed extractor, not a raw JSON pointer:**
```jsonc
{ "method": "onchain.transfer_check", "index": 0 }
```
`method` is a value from the §3 registry; `index` is the 0-based ordinal occurrence of that
method among the job's `criteria[]`. Chosen over a general path string (e.g. RFC 6901 JSON
Pointer) because the deliverable is a closed, flat `method -> claim[]` map that is already
Zod-validated per method at quarantine (`SECURITY.md` §2.1) — a typed `{method, index}` pair
resolves with a direct array lookup, no path parsing/escaping/validation surface, and stays
trivially constrainable in the M2 compiler's structured-output schema the same way `method`
already is.

**Who assigns it, and when:** the M2 compiler, immediately after tagging each criterion's
`method`, in the same pass that produces `criteria[]` — before any deliverable exists.
`index` is a pure function of criteria order (how many earlier criteria in this compile
output already had that method). Present for `onchain.*` (D4.5), `data.*` (D5 M3.B),
`code.*` (D5 M3.C), and `content.presence` / `content.format` / `content.bounds` /
`content.pattern` (D6.A M4 Tier-1) — every method family backed by a deliverable-provided
claim array; absent for `method: null` and for method families with no locator scheme yet
(`content.coverage` / `content.source_grounding` / `content.no_hallucination` — Tier 2,
deferred post-hackathon — and `taste.refused`).

**Resolution contract:**
- No `locator` → not a locator-bound criterion; unaffected by this section.
- `locator` present but doesn't resolve (no claims submitted for `method`, `index` out of
  range, or quarantine rejected that exact slot) → **UNVERIFIABLE**, never FAIL.
- `locator` resolves to more than one value → **UNVERIFIABLE**, never take-first, never
  guess. For the `{method, index}` grammar this is unreachable by construction — an integer
  index into an array denotes at most one element, and `index` is assigned as a strict
  bijection over same-method criteria by the compiler's single pass — so the rule is
  satisfied by grammar choice, not a runtime branch. Recorded here rather than papered over
  with dead code, matching this doc's practice of stating what wasn't (and can't be) live-
  exercised rather than implying it was.
- `locator` resolves to exactly one value → bind it, hand it to the criterion's existing
  checker unchanged. Checker output feeds §4 headline computation exactly as before — no new
  verdict states.

### 2.3 The four results, defined
- **PASS** — criterion met, with evidence.
- **FAIL** — criterion not met, with evidence showing the gap.
- **PARTIAL** — measurably partially met (e.g. "3 code examples required, 2 present"); evidence
  quantifies the shortfall. Use only when partiality is *measurable*, not as a hedge.
- **UNVERIFIABLE** — we cannot obtain fair evidence at this criterion's tier. Mandatory for
  Tier 3; also used when a Tier 1/2 check is blocked (missing data, unreachable chain,
  ambiguous spec that can't be responsibly inferred). **Never** substitute a guess.

---

## 3. METHOD REGISTRY

`method` must be one of the registered techniques (keeps verdicts auditable and maps to
`VERIFICATION_MODULES.md`). Extend the registry there, not ad hoc.

| method | tier | module | emits evidence.kind |
|--------|------|--------|---------------------|
| `onchain.tx_exists` | 1 | M3 onchain | tx |
| `onchain.transfer_check` | 1 | M3 onchain | tx |
| `onchain.owner_check` | 1 | M3 onchain | tx |
| `onchain.destination_check` | 1 | M3 onchain | tx |
| `onchain.safety` (via `okx-agentic-wallet` bundled `security token-scan`/`tx-scan`) | 1 | M3 onchain | tx |
| `data.schema` | 1 | M3 data | extract |
| `data.rowcount` | 1 | M3 data | extract |
| `data.sample_verify` | 1 | M3 data | sample |
| `code.compiles` | 1 | M3 sandbox | test_output |
| `code.tests_pass` | 1 | M3 sandbox | test_output |
| `content.presence` (required heading/json_key/csv_column/literal, via locator) | 1 | M4 | extract |
| `content.format` (re-validates the asset's own declared format: json/csv_headers/markdown_structure) | 1 | M4 | extract |
| `content.bounds` (word/char/line/section count vs declared min/max) | 1 | M4 | extract |
| `content.pattern` (matches a vetted pattern: email/url/iso_date/semver — never a caller-supplied regex, ReDoS hardening) | 1 | M4 | extract |
| `content.coverage` | 2 | M4 | source_check |
| `content.source_grounding` | 2 | M4 | source_check |
| `content.no_hallucination` | 2 | M4 | source_check |
| `taste.refused` | 3 | — | none |

---

## 4. HEADLINE COMPUTATION (deterministic)

The headline is a pure function of the **Tier 1 and Tier 2** criteria only. Tier 3 never
affects it (it only ever contributes UNVERIFIABLE line items the caller can read).

Let `S` = set of criteria with tier ∈ {1,2}.

```
if S is empty:                                  headline = UNVERIFIABLE  // nothing checkable existed
elif any(c.result == FAIL
         and c.source == EXPLICIT for c in S):  headline = FAIL
elif all(c.result == PASS for c in S):          headline = PASS
else:                                           headline = PARTIAL       // any INFERRED-only FAIL,
                                                                          // any UNVERIFIABLE, or a
                                                                          // PASS/PARTIAL mix
```

Rules of thumb encoded above:
- **Any EXPLICIT FAIL in scope → FAIL.** A stated requirement not met sinks the delivery;
  that's the honest signal.
- **An INFERRED-only FAIL is capped at PARTIAL, never FAIL.** An INFERRED criterion is *our*
  interpretation of the spec, not something the buyer actually wrote down (§6 rule 2). If
  we inferred wrong, that's our liability to disclose, not proof the deliverable failed a
  stated requirement — it must not sink the headline to FAIL on its own. `summary` must name
  the INFERRED criterion, its `inference_note`, and why the headline was capped rather than
  sunk. (If an EXPLICIT FAIL is *also* present in `S`, EXPLICIT wins and headline is FAIL —
  the cap only applies when INFERRED FAILs are the only FAILs in scope.)
- **All PASS → PASS.** Clean.
- **Anything blocked/partial but nothing (EXPLICIT-)failed → PARTIAL**, and `summary` must say
  which criteria were UNVERIFIABLE (or INFERRED-FAIL-capped) and why, so the caller can decide.
- **Nothing checkable at all → UNVERIFIABLE** headline (don't fake a PASS on an all-taste job).

`headline_basis` lists every id in `S` — i.e. all Tier 1–2 criteria that fed the computation,
not just the subset that happened to decide the branch taken.

**Locked (see `CLAUDE.md` §1 L11):** the EXPLICIT/INFERRED distinction above is settled product
behavior, not an open question — do not relitigate it in code or re-derive a different rule
from first principles.

---

## 5. SIGNING ENVELOPE (M7)

Purpose: make every verdict **attributable and non-repudiable**, and let any client verify
it mechanically without trusting us (mirrors APP's own credential-signature primitive).

**Canonicalization**
1. Take the verdict object **without** the `signature` field.
2. Serialize with deterministic JSON (sorted keys within each object, no insignificant
   whitespace, UTF-8, arrays in given order). Implementation: `src/verdict/canonicalize.ts`, a
   hand-rolled recursive serializer (no RFC 8785 library — the schema has no exotic numeric
   edge cases: `confidence` is `null` or a decimal in `[0,1]`, tiers are `1|2|3`, everything
   else is strings/arrays/objects).
3. `digest = keccak256(canonical_bytes)`. Carried in the signing machinery as the content
   fingerprint, but see the correction below — it is **not** what is directly ECDSA'd.

**Correction (D4, 2026-07-10 — key-custody constraint discovered, live-tested before coding):**
the signing key is TEE-secured inside the OKX Agentic Wallet (`SECURITY.md` T4 /
`PLATFORM.md` §3) — it can never be exported for a raw ECDSA-over-arbitrary-digest operation.
The **only** signing primitive the wallet exposes is `onchainos wallet sign-message
--type personal|eip712` (EIP-191 personal_sign or EIP-712 typed data — see
`.agents/skills/okx-agentic-wallet/references/wallet-cli-reference.md` §"Sign Message"). So:

- **Signing**: `signature` = EIP-191 **personal_sign** over the **canonical JSON string itself**
  (not the digest) — `onchainos wallet sign-message --chain 196 --from <signer.address>
  --type personal --message <canonical_json>`. Live-verified against the real agentic wallet
  before this was accepted as the scheme: a `personal` signature over an arbitrary test string
  recovers correctly via `viem`'s standard `recoverMessageAddress`, with zero custom
  EIP-191-prefix handling needed on the verify side.
- **Verify path** (§ below) is therefore `recoverMessageAddress({message: canonical_json,
  signature})` (viem or any EIP-191-aware library) — not a hand-rolled
  `ecrecover(digest, signature)`. This is arguably *more* portable than raw-digest ecrecover
  (every wallet's "sign message" UI produces exactly this shape), not less secure — but it is a
  deviation from this section's original literal text, recorded here per the "doc wins, fix the
  doc first" rule rather than silently diverging in code.
- `digest` remains useful as an audit/content-fingerprint value (e.g. for logs), it just isn't
  the thing ECDSA is applied to.

**Signing key**: ECDSA (secp256k1), the same key registered to our **ERC-8004 identity** on
X Layer (chain 196) — confirmed live (D4) that the currently-authenticated Agentic Wallet
session's address equals agentId 4933's `ownerAddress`/`agentWalletAddress`, and is distinct
from the facilitator/settlement address.

**What a verifier checks (and what we publish so they can — see `scripts/verify-verdict.ts`):**
1. Recompute the canonical JSON string from the received verdict minus `signature`.
2. `recoverMessageAddress({message: canonical_json, signature})` == `signer.address` (EIP-191
   personal_sign recovery — not raw ecrecover(digest, signature)).
3. `signer.address` is the address bound to `signer.erc8004_id` in the on-chain registry
   (read via OnchainOS / RPC — `onchainos agent get-agents --agent-ids <id>` →
   `ownerAddress`/`agentWalletAddress`).
4. `ruleset_hash` matches a published ruleset version (so they know *which* battery ran).

This is the "verifiable layer" the tweet promises. Note it's an **extra assurance on top of
the same product** — it does not change the verdict content or the narrative (per the
earlier decision: signing is a slide, not a pivot).

**Key custody:** signing key lives with the Agentic Wallet (TEE-secured per OKX). Never
export it into application code or logs. See `PLATFORM.md` for wallet/key handling.

---

## 6. CRITERIA-COMPILATION CONTRACT (M2)

How a spec becomes `criteria[]`. This is the P1 machinery.

**Input:** the order spec text (and only the spec — never the deliverable; see
`ARCHITECTURE.md` §3 invariant).

**Output:** an ordered `criteria[]` with every item tagged and tiered, produced *before*
any verification runs.

**Rules:**
1. **Extract EXPLICIT criteria first** — every requirement literally stated. `source=EXPLICIT`.
2. **Add INFERRED criteria only where a reasonable buyer clearly intended them** — and for
   each, populate `inference_note` with the exact reasoning and the spec fragment it derives
   from. If an inference isn't defensible in one sentence, don't make it — instead emit the
   affected criterion as `tier` appropriate but expect `UNVERIFIABLE` if the ambiguity blocks
   checking. **Silent inference is forbidden.**
3. **Assign tier honestly** using P2: is the requirement a fact (1), an evidence-grounded
   judgment (2), or taste (3)? When unsure between 2 and 3, choose 3 (refuse) — err toward
   humility.
4. **Assign method** from the registry (§3). If no registered method fits a criterion, it is
   `UNVERIFIABLE` (we don't have a defensible way to check it yet), not a guess.
5. The compiled `criteria[]` is **always returned to the caller**, even if verification later
   errors out. The checklist itself is a deliverable.

**Ambiguity posture:** if the spec is too vague to compile responsibly, the honest output is
a criteria set heavy on `UNVERIFIABLE` with notes explaining what the spec failed to
specify — which is also the natural wedge toward a future "spec-writing" upsell. We surface
the ambiguity; we never paper over it.