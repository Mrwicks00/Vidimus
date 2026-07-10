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

### 2.2 The four results, defined
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
| `onchain.safety` (via okx-security) | 1 | M3 onchain | tx |
| `data.schema` | 1 | M3 data | extract |
| `data.rowcount` | 1 | M3 data | extract |
| `data.sample_verify` | 1 | M3 data | sample |
| `code.compiles` | 1 | M3 sandbox | test_output |
| `code.tests_pass` | 1 | M3 sandbox | test_output |
| `content.countable` (words, sections, N examples) | 1 | M4 | extract |
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
if S is empty:                       headline = UNVERIFIABLE   // nothing checkable existed
elif any(c.result == FAIL for c in S):        headline = FAIL
elif all(c.result == PASS for c in S):        headline = PASS
elif any(c.result == UNVERIFIABLE for c in S)
     and no FAIL:
        if all non-UNVERIFIABLE are PASS:      headline = PARTIAL   // some checkable, some blocked
        else:                                  headline = PARTIAL
else:                                          headline = PARTIAL   // mix of PASS/PARTIAL
```

Rules of thumb encoded above:
- **Any FAIL in scope → FAIL.** One real failure sinks the delivery; that's the honest signal.
- **All PASS → PASS.** Clean.
- **Anything blocked/partial but nothing failed → PARTIAL**, and `summary` must say which
  criteria were UNVERIFIABLE and why, so the caller can decide.
- **Nothing checkable at all → UNVERIFIABLE** headline (don't fake a PASS on an all-taste job).

`headline_basis` lists exactly the `S` criterion ids that drove the result.

---

## 5. SIGNING ENVELOPE (M7)

Purpose: make every verdict **attributable and non-repudiable**, and let any client verify
it mechanically without trusting us (mirrors APP's own credential-signature primitive).

**Canonicalization**
1. Take the verdict object **without** the `signature` field.
2. Serialize with deterministic JSON (sorted keys within each object, no insignificant
   whitespace, UTF-8, arrays in given order). Record the exact canonicalization lib/version
   in `PLATFORM.md` once chosen — both signer and verifier must use the same.
3. `digest = keccak256(canonical_bytes)`.

**Signing**
- ECDSA (secp256k1) with the verifier's signing key, the same key registered to our
  **ERC-8004 identity** on X Layer (chain 196).
- `signature` = `0x` + r‖s‖v.

**What a verifier checks (and what we publish so they can):**
1. Recompute `digest` from the received verdict minus `signature`.
2. `ecrecover(digest, signature)` == `signer.address`.
3. `signer.address` is the address bound to `signer.erc8004_id` in the on-chain registry
   (read via OnchainOS / RPC).
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