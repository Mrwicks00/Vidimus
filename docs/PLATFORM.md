# PLATFORM.md — VIDIMUS

Everything OKX / OnchainOS. This owns M1 (endpoint/payments), the platform half of M7
(identity/registration), and M8 (listing). **Rule of the house:** do not hand-roll OKX APIs
and do not guess subcommands — install the skills and read each `SKILL.md` for exact syntax
before running anything (OKX's own repo rule; CLAUDE.md §2.3).

Verified facts below come from the OnchainOS skills repo + APP whitepaper + OKX docs. Two
things are **not** verifiable from public pages and are tracked as Day-1 Unknowns (§7) —
resolve them by reading the local SKILL.md files, don't build assumptions around them.

---

## 1. INSTALL & ENVIRONMENT (Day 1, first thing)

```bash
# install the OnchainOS skill pack (through the agent / Claude Code)
npx skills add okx/onchainos-skills
# or the plugin route in Claude Code:
#   /plugin marketplace add okx/onchainos-skills
#   /plugin install onchainos-skills
```
- Installs the `onchainos` Rust CLI (also exposes an MCP server: `onchainos mcp`, rmcp).
- We **call** this CLI; we do not edit it. Rust in *our* codebase is a separate, optional
  decision (L7) — installing their Rust CLI does not obligate us to write Rust.
- Sandbox/test credentials ship for local eval — build and test the full loop **before**
  applying for our own portal keys. This removes the biggest Day-1 blocker.

### SKILL.md read order (Day 1)
1. `okx-ai-guide` — the map: what OKX.AI is, roles, onboarding entry.
2. `okx-ai` (contains what was `okx-agent-task` — that skill was merged in and no longer
   exists standalone) — **ASP registration + service listing + the task/job envelopes.** This
   is where U1 (listing schema, CLOSED §7) and the A2A/A2MCP job lifecycle live. Read closely.
3. `okx-agent-payments-protocol` — the payment dispatcher: x402 / MPP / a2a-pay, the 402
   flow, paymentId, signing. This is M1's contract. Where U2 (response envelope) is resolved.
4. `okx-security` — token risk / tx pre-execution safety / signature+approval checks. This is
   the Safety dimension we subcontract in M3.A.

Also worth reading when M3 onchain work starts: `okx-agentic-wallet` (tx history,
contract-call reads), `okx-onchain-gateway` (simulation/tracking), `okx-dex-token` (token
metadata, holder analysis). Read each `SKILL.md`'s Command Index for exact subcommands.

---

## 2. IDENTITY & REGISTRATION (M7 platform half)

- Identity model: **ERC-8004 on-chain agent identity on X Layer** (chain **196**). Managed via
  the `okx-guide` / `okx-ai` skills (the latter absorbed `okx-agent-task`): register / create /
  update / activate / deactivate / search agents; view ratings; list agent services; set avatar.
- Our role: **`asp`** (Provider / Seller).
- Register the ASP identity early (Day 1) using sandbox creds so downstream signing (M7) has a
  real `erc8004_id` + address to bind to. The verdict's `signer.erc8004_id` (VERDICT_SPEC §1)
  is this identity.
- Payouts land in **USDT or USDG**.

---

## 3. PAYMENTS / x402 (M1)

- Rail: **A2MCP** — plain HTTP. Our priced endpoint returns an **x402-style `402 Payment
  Required`** carrying a challenge; the buyer's payment module signs a credential; a Broker
  settles on X Layer; the buyer **retries the original call citing the `paymentId`**. Zero/low
  gas on X Layer.
- The `okx-agent-payments-protocol` skill is a unified dispatcher across: **x402** (`exact` /
  `aggr_deferred` schemes; TEE **or local-key** signing), **MPP** (`charge` / `session`
  intents), **a2a-pay** (paymentId create / pay / status). For a fixed-price per-call verifier,
  the relevant path is x402 `exact` (single round-trip, fixed price).
- We are an A2MCP **Seller/service**: we implement the *seller surface* of the 402 flow (issue
  challenge → accept paymentId → serve verdict). Read the skill for the exact
  challenge/credential/paymentId fields — **U2**.
- Keys: signing/settlement via the **TEE-secured Agentic Wallet**. Never export keys into app
  code, env dumps, or logs (SECURITY.md T4).

---

## 4. PRICING TIERS (L2)

Base is **0.01 USDT**. The ratio rule: our fee must be a tiny fraction of the deliverable's
value, and any tier that triggers **paid** subcontracted OKX calls must be priced **above** our
cost for those calls (never let a 0.01 job trigger unbounded paid lookups — SECURITY/modules).

| Tier | What it covers | Indicative price | Cost driver |
|------|----------------|------------------|-------------|
| Base | Conformance: criteria compilation, schema/countables, file validity, content Tier-1 | **0.01 USDT** | pure compute |
| Chain | Base + onchain fact verification (tx/transfer/owner/destination) | above supplier cost (RPC/CLI calls) | OnchainOS reads |
| Chain+Safety | Chain + `okx-security` token/approval safety dimension | above chain tier | paid okx-security subcontract |
| Deep/Batch | Sampled data audits, sandboxed code execution, large deliverables | scaled by work | sandbox + sampling compute |

Pricing feeds Revenue Rocket (volume × price) — keep base low for sold-count, price the
expensive tiers to stay margin-positive. Confirm exact tier fields against the listing schema
(**U1**) before hard-coding.

---

## 5. LISTING & REVIEW (M8)

- Register the A2MCP service via `okx-ai` (`agent create` — exact submission fields = **U1**,
  CLOSED §7), submit for OKX review. Review is ~24h and runs in parallel — **submit early**
  (ROADMAP D7) so review overlaps the remaining build, not the deadline.
- To stay hackathon-eligible the ASP must **pass review and go live**. A built-but-unlisted
  service does not count.
- After listing: demo verifications against real live agents (XLayer NFT Mint #2171, Onchain
  Data Explorer #2023, etc.) are **real paid calls** and double as demo footage (M8/ROADMAP D7).

---

## 6. CONSUME vs BUILD (L8, quick reference)

- **Consume:** x402/APP payment, ERC-8004 registration, `okx-agentic-wallet` /
  `okx-onchain-gateway` / `okx-dex-token` reads, `okx-security` safety.
- **Build our own only if their tool limits us:** direct RPC readers (speed/coverage), the code
  sandbox (they have none), the calibration DB/indexer.
- We are `okx-security`'s **consumer**, never its competitor — keep that framing in code/README.

---

## 7. DAY-1 UNKNOWNS (blocking tasks — resolve, don't assume)

Track status here; mark CLOSED with a date + the real shape once read from SKILL.md.

- **U1 — ASP service-listing schema.** Status: **CLOSED 2026-07-10**.
  Source: `okx-ai/references/identity-register.md` + `identity-invariants.md`. Note: the
  `okx-agent-task` skill named in §1/§2/§5 above no longer exists standalone — it was merged
  into **`okx-ai`** (its content lives at `okx-ai/references/task-*.md` and `identity-*.md`);
  update those cross-references when next touched.

  Registration is **not** a REST/JSON listing endpoint — it's a gated, stateful CLI flow via
  `onchainos agent`:
  1. `agent pre-check --role asp [--consent-key <uuid>]` — consent (first wallet use) +
     per-wallet uniqueness gate. Returns `{canCreate, reason?, consent?, existingSameRole,
     aspCount}`.
  2. Identity fields: `name` (brand name, CN 2–12 / EN 3–25 chars, no test markers/celebrity
     names), `description` (≤500 chars), **avatar — required for ASP**: an image file uploaded
     via `agent upload --file <path>` → CDN URL, passed as `--picture` (URLs rejected, must be
     a real upload).
  3. One or more services via `--service`, a JSON array. **Exact camelCase keys** (wrong keys
     silently break the call):
     | key | required | notes |
     |---|---|---|
     | `serviceName` | yes | noun phrase, 5–30 chars |
     | `serviceDescription` | yes | 2-part: ① capability summary ② what buyer must provide, each ≤200 CJK-width chars (CJK=2/ASCII=1), total ≤400 |
     | `serviceType` | yes | `"A2MCP"` (our case) or `"A2A"` — raw enum, never localized |
     | `fee` | yes for A2MCP | **quoted numeric string**, e.g. `"0.01"` — USDT implicit, no symbol, ≤6 dp |
     | `endpoint` | yes for A2MCP | `https://…`, publicly reachable, no localhost/private IP/mock, ≤512 chars |

     Register/create omits `id` and `operation` (those are `update`-only delta keys).
     Example: `--service '[{"serviceName":"Vidimus Base Conformance Check","serviceDescription":"…","serviceType":"A2MCP","fee":"0.01","endpoint":"https://<our-host>/verify"}]'`
  4. QA gate — `agent validate-listing --role asp --name … --description … --service '[…]'` →
     `{pass, findings[{field, code, severity:"block", issue, fix}]}`. Must be clean (or fixes
     applied + user-confirmed) before `create`.
  5. `agent create --role asp --name … --description … --picture <url> --service '[…]'` →
     returns `newAgentId` (our ERC-8004 id; string on WS success, `null` on timeout — poll
     `agent get-my-agents` if so).
  6. `agent activate <id> --preferred-language <BCP-47>` — publishes the listing (go-live).
     `--preferred-language` is required and easy to miss.

  **D1 implication:** this is a mandatory-avatar, consent-gated, conversational flow — it is
  run once, interactively, by Claude Code following `identity-register.md` directly (not
  scripted app code). Do this live during D1 with sandbox creds, not as a build task.

- **U2 — A2MCP response envelope.** Status: **CLOSED 2026-07-10**.
  Source: `okx-agent-payments-protocol/SKILL.md` + `references/accepts-schemes.md`. That skill
  documents the **buyer** side (a Claude Code agent paying an invoice) — but since x402 is
  symmetric, it fully pins the wire shape a **seller** (us) must emit, by specifying exactly
  what it parses. **No OKX skill implements the seller/facilitator side** — verifying the
  signature and settling on-chain is ours to build (L8: build our own where the CLI doesn't
  reach).

  Real shape — x402 **v2**, scheme `exact` (matches L1/L9; EIP-3009 or Permit2 transfer, no
  session/channel complexity):
  - **Unpaid request** → `HTTP 402` + header `PAYMENT-REQUIRED: <base64url(JSON)>`:
    ```json
    {
      "x402Version": 2,
      "resource": { "method": "POST", "url": "https://<host>/verify", "description": "…" },
      "accepts": [{
        "scheme": "exact",
        "network": "eip155:1952",
        "asset": "<USDT contract addr on X Layer testnet>",
        "amount": "<atomic units string>",
        "payTo": "<our address>",
        "maxTimeoutSeconds": 300,
        "extra": { "name": "<token EIP-712 domain name>", "version": "2",
                   "assetTransferMethod": "EIP3009" }
      }]
    }
    ```
    Testnet network id is CAIP-2 `eip155:1952` (X Layer testnet EVM chainId, PLATFORM §8) —
    distinct from OKX's own numeric `chainIndex` taxonomy used by unrelated market-data skills
    (e.g. `okx-dex-market`); do not conflate the two.
  - **Buyer replay** → same request + header `PAYMENT-SIGNATURE: <authorization_header>`
    (base64 JSON; for `exact`+EIP-3009: `{signature, authorization:{from,to,value,validAfter,
    validBefore,nonce}}`).
  - **We must** (the seller-side facilitator, built by us): decode the header, reconstruct the
    EIP-712 digest, `ecrecover`, verify `to == payTo`, `value >= amount`, time window valid,
    nonce unused (replay guard) → submit `transferWithAuthorization` on the token contract on
    X Layer testnet (chainId 1952).
  - **Success response** → `HTTP 200` + header
    `PAYMENT-RESPONSE: <base64url(JSON {status:"success", transaction:"<txHash>",
    amount:"<atomic settled>", payer:"<address>"})>`, body = our actual verdict JSON
    (VERDICT_SPEC §1 shape — dummy/empty criteria for D1). Wrap the envelope around the
    signed verdict; never let header/envelope logic touch the signed payload itself.
  - Legacy v1 (body `x402Version:1`, reply header `X-PAYMENT`) exists in the spec but is out of
    scope for D1 — v2 only.

Both shapes above are what D1's skeleton endpoint implements. If a live sandbox call surfaces
a mismatch, fix it here with a dated note before changing code silently.

---

## 8. HANDY FACTS (X Layer)

- Chain ID **196** (mainnet), 1952 (testnet). Gas token **OKB**. EVM-equivalent (op-geth) since
  the Oct-2025 OP-Stack migration → Solidity/Foundry/Hardhat work with no zkEVM caveats.
- Intra-L2 (our payments, reads, verdict anchoring) confirms fast (~sub-second/1s blocks).
  The 7-day optimistic challenge window only affects withdrawing value **off** X Layer — it
  does **not** touch per-call verification or verdict issuance. Don't conflate it with the
  application-level dispute window.