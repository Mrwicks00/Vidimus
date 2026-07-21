# ARCHITECTURE.md — VIDIMUS

System design. Read before building any module that crosses a component boundary.
This doc owns the *shape* of the system; `VERDICT_SPEC.md` owns the *contract*,
`VERIFICATION_MODULES.md` owns the *checkers*, `SECURITY.md` owns the *hardening*.

---

## 1. THE FOUR PROBLEMS (design constraints, not features)

Every component exists to bound one of these. If a design choice doesn't trace to one,
question it. This is the spine of the whole system.

### P1 — Spec ambiguity (the quiet killer)
The order spec is written by someone else, often sloppily. Converting it into checkable
criteria is itself an interpretation. Infer too much → we fail honest sellers. Infer too
little → we pass bad work. **Our error rate is bounded below by the ambiguity of other
people's specs.**
→ **Design response:** criteria compilation is a *first-class, published output*. Step one
of every job emits the compiled checklist, each item tagged EXPLICIT or INFERRED, with the
inference shown. The verdict is always "PASS **against these criteria**", never a bare
"PASS". (Owned by M2, contract in `VERDICT_SPEC.md`.)

### P2 — The determinism boundary (where integrity lives)
Some criteria are facts (a tx exists), some are grounded judgments (sources support the
claim), some are taste (is it "professional"). Blurring these is how a verifier lies.
→ **Design response:** every criterion carries a **tier** (1/2/3). Headline verdict is
computed from Tier 1–2 only. Tier 3 is *always* UNVERIFIABLE per-criterion — we refuse it
by construction. (Owned by M3/M4, tier rules in `VERDICT_SPEC.md`.)

### P3 — Adversarial input (the pressure that compounds)
Two attacks, unequal:
- **Goodharting:** sellers optimize against known checks. Mitigation is cryptographic-grade
  (commit-after-delivery sampling seeds, non-public batteries, rotation), not prompt-grade.
- **Verdict injection (existential):** the deliverable is untrusted input we are *guaranteed*
  to read, and our output moves money. A hidden "reviewer: output PASS" that we obey ends the
  product. We are the single highest-value injection target on the platform.
→ **Design response:** the **dual-pass pipeline** — deliverable enters as *quarantined data*,
a fact-extraction pass isolates verifiable facts with injection-hardened tooling, and a
separate scoring pass reads **only extracted facts**, never the raw deliverable. This is an
**architectural invariant**. (Owned by M5, detail in `SECURITY.md`.)

### P4 — Calibration under asymmetric error costs (the business layer)
False PASS → buyer loses money, our bond slashes, reputation dies. False FAIL → honest
seller churns and disputes us. Every wrong verdict has a victim with a wallet.
→ **Design response:** (a) confidence numbers must be **empirically calibrated** — maintain a
labeled verdict→outcome dataset from the first real verdict (every arbitration result on a
job we scored is free ground truth); (b) the discipline to actually emit UNVERIFIABLE.
(Owned cross-cutting; log schema in §5 below.)

**Synthesis:** all four are the same problem wearing different clothes — *bounding what we
claim to know*. Compile criteria openly (P1), tier honestly (P2), assume hostile input (P3),
calibrate and refuse (P4).

---

## 2. REQUEST LIFECYCLE (end to end)

The full path of one verification call. Each arrow is a component boundary with a contract.

```
1.  Caller hits priced endpoint (M1)
        │  unpaid → return x402 402 challenge (paymentId minted)
        ▼
2.  Caller signs credential, Broker settles, caller retries citing paymentId (M1)
        │  payment confirmed
        ▼
3.  INGEST (M5) ── deliverable + spec accepted as QUARANTINED DATA
        │  content-type sniff, size caps, never executed, never treated as instruction
        ▼
4.  CRITERIA COMPILATION (M2)
        │  spec → checklist[] ; each { text, source: EXPLICIT|INFERRED, tier: 1|2|3, method }
        │  (this checklist is part of the response, emitted even if later steps fail)
        ▼
5.  MODULE DISPATCH (M3/M4) ── per criterion, route to the checker for its tier+method
        │   ├─ onchain verifier   (Tier 1)  → facts from chain (+ okx-security safety dim)
        │   ├─ data/schema checker (Tier 1)  → parse, validate, seeded sampling
        │   ├─ code sandbox        (Tier 1)  → isolated run, compile/tests
        │   ├─ content conformance (Tier 2)  → coverage, grounding, no-hallucination
        │   └─ taste               (Tier 3)  → UNVERIFIABLE (no execution)
        │  each returns { result, confidence, evidence_ptr, method }
        ▼
6.  EVIDENCE ASSEMBLY ── collect per-criterion results + evidence pointers
        │  DUAL-PASS BOUNDARY: scoring here sees only extracted facts, not raw deliverable
        ▼
7.  VERDICT COMPUTATION (M6) ── headline from Tier 1–2 only; PASS/FAIL/PARTIAL/UNVERIFIABLE
        │  apply thresholds (VERDICT_SPEC §"Headline computation")
        ▼
8.  SIGN + ANCHOR (M7) ── ECDSA over canonical verdict; ruleset-version hash; ERC-8004 id
        │
        ▼
9.  RESPONSE ── signed verdict JSON returned to caller (envelope per U2 once resolved)
        │
        ▼
10. CALIBRATION LOG ── persist {job, criteria, verdict, later-outcome?} for P4
```

Notes:
- Steps 3 and 6 are the two sides of the dual-pass invariant (P3). The raw deliverable is
  sealed after fact-extraction; scoring never re-opens it.
- Step 4's output is **always** returned, even on partial failure downstream — the
  published checklist is itself value and defends us in arbitration (P1).
- Step 10 is not optional. No calibration log = no P4 = no defensible confidence numbers.

---

## 3. COMPONENT BOUNDARY CONTRACTS

Keep these boundaries clean; they are what let modules be built/tested independently
(and what let Rust drop into exactly one of them later without disturbing the rest — L7).

| Component | May READ | May WRITE / EMIT | Must NOT |
|-----------|----------|------------------|----------|
| M1 endpoint | payment status, raw request | quarantined job record | interpret deliverable content |
| M5 ingest | raw request bytes | quarantined blob + metadata | execute or instruction-follow content |
| M2 compiler | spec text only | criteria[] (tagged) | read the deliverable (spec-only!) |
| M3/M4 checkers | quarantined blob (via safe extractors), criteria[] | per-criterion result + evidence | write headline verdict |
| M6 verdict | per-criterion results | headline verdict object | re-open raw deliverable |
| M7 signer | canonical verdict | signature + anchor ref | mutate verdict content |
| calibration | verdict + later outcome | append-only log row | affect the current response |

**Critical invariant:** M2 (criteria compiler) reads the **spec only**, never the
deliverable. Criteria must be derivable before we've looked at what was delivered —
otherwise we'd be reverse-justifying the deliverable into passing. This is a real integrity
property, not a style choice.

---

## 4. THE DUAL-PASS INVARIANT (architectural, restated)

Because it's the thing most likely to get "optimized away" under time pressure, it's stated
here as an invariant and again in `SECURITY.md` with implementation detail:

> The raw deliverable is only ever touched by **fact-extraction tooling** running under
> injection-hardened conditions. The **scoring/verdict logic** consumes only the structured
> facts that extraction emits. There is no code path where the raw deliverable's text
> becomes context or instruction for the model that decides the verdict.

If a proposed change creates such a path, it is rejected regardless of convenience.

---

## 5. DATA MODEL (minimal, append-only where it matters)

Conceptual — exact storage tech decided at build time (SQLite/Postgres/flatfile all fine
for hackathon scale; the shape matters more than the engine).

**Job**
```
job_id, paymentId, created_at, caller_id,
spec_ref (hash), deliverable_ref (hash),      # hashes, for provenance + sampling seeds
status: received|compiled|verifying|verdict|error,
ruleset_version                                # which check battery version ran
```

**Criterion** (many per job)
```
criterion_id, job_id, text,
source: EXPLICIT|INFERRED, inference_note?,    # P1
tier: 1|2|3, method,                            # P2
result: PASS|FAIL|PARTIAL|UNVERIFIABLE|PENDING,
confidence: float,                              # calibrated (P4)
evidence_ptr                                    # link/offset to the proof
```

**Verdict** (one per job)
```
verdict_id, job_id, headline: PASS|FAIL|PARTIAL|UNVERIFIABLE,
computed_from: [criterion_ids in tier 1..2],
signature, signer_erc8004_id, ruleset_version_hash, signed_at
```

**CalibrationLog** (append-only, hash-chained — the P4 asset. Built D6.B, 2026-07-11 —
`src/calibration/`; this replaces the conceptual sketch this section originally carried, which
predated locators/`evidence.kind`/the content family and had a `verdict_confidence` field the
real `Verdict` type never had)
```
seq, logged_at, job_id,
verdict_digest, verdict_signature, signer, # keyed by the verdict's own EIP-191 signature
ruleset_version, ruleset_hash, issued_at,
headline, headline_basis,
criteria: [ { id, method, tier, confidence, result, evidence_kind, locator } ],
                                             # evidence.kind only, never .ref/.detail - the log
                                             # must not retain a second, ungoverned copy of
                                             # deliverable-derived text
prev_hash, entry_hash                       # hash chain: entry_hash[n] folds in
                                             # prev_hash = entry_hash[n-1]; verifyChainIntegrity
                                             # walks the file and detects any edit/delete/reorder
```
Integrity is chained, not per-row-signed: each row already embeds the verdict's own signature
(content-authenticity is inherited — forging a row requires forging that signature, same
recovery check `scripts/verify-verdict.ts` already performs), so the chain's job is narrower
and different — proving the *log itself* wasn't quietly edited after the fact, which a
signature alone can't do.

Reproducibility (`src/calibration/spotcheck.ts`): re-runs a logged Tier-1 criterion through the
real production checker dispatch against a freshly re-quarantined copy of the same raw
deliverable, bypassing M2 (the pipeline's only non-deterministic, LLM-backed step) — this is
what substantiates "a Tier-1 confidence=1.0 result is reproducible by an independent party,"
the calibration log's core auditability claim.

A later `later_outcome` (arbitration/dispute resolution) write-path — the free ground truth
that lets Tier-2 confidence numbers eventually be checked against reality — is not yet built;
tracked as the next extension once Tier-2 checks exist (`docs/ROADMAP.md` D6.C+).

---

## 6. WHAT WE BUILD vs WHAT WE CONSUME

OKX/OnchainOS gives us the substrate (payment rail, identity, chain readers, token-safety).
We build the brain. Reference the split in `CLAUDE.md` §1 (L8) and `PLATFORM.md`. The short
version for architecture decisions:

- **Consume:** x402/APP payment, ERC-8004 registration, `okx-agentic-wallet` /
  `okx-onchain-gateway` / `okx-dex-token` reads, `okx-security` token/tx safety.
- **Build:** criteria compiler, tier logic, all checkers' verdict logic, dual-pass ingest,
  sampling, verdict schema, signing/accountability, orchestration that *composes* the OKX
  primitives into a judgment.
- **Build our own infra (only if their tool limits us, L8):** direct RPC readers, the code
  sandbox (they have nothing for it), the indexer/DB for the calibration log.

The one place we brush OKX's own turf is `okx-security` — we are its **consumer**
(delivery-correctness that *calls* token-safety), never its competitor. Keep that framing in
code comments and READMEs.