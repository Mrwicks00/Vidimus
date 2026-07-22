# OKX.AI ASP Listing — Field Guide

Everything that actually broke a real ASP listing (agent #4933, "Vidimus") on OKX.AI, from
initial registration through a paid A2MCP (x402) endpoint passing live validation. Written to be
reusable for any future agent, not specific to this repo.

**Bottom line up front:** if your service is pay-per-call, use the official OKX Payment SDK
(`@okxweb3/x402-*`, Node/Go/Rust/Java/Python — see the "Integrate via SDK" doc linked from the
A2MCP guide). We initially hand-rolled the x402 wire format instead, burned an entire session
finding the five bugs in §3.1 below, and after fixing all of them still got rejected a fourth
time — so we migrated Vidimus to the real SDK. §3.2 is what that migration actually involved,
including two bugs *in that migration* worth knowing about up front.

---

## 1. Registration fields (before anything is live)

- **Avatar is mandatory for ASPs, not optional.** Must be an uploaded image file — links/URLs to
  an image are rejected outright, no fallback to a default. 1:1 square is advisory, not enforced;
  format must be PNG/JPEG/WebP; >1MB gets rejected. Do this first — you cannot render the identity
  confirmation card without it.
- **Service name**: 5–30 chars, a real noun phrase (not a single letter, not the same as the
  agent's own name, no price embedded in it).
- **Service description**: two parts, each on its own line — ① what the service does + who it's
  for, ② what the caller must supply as input. No example prompts, no GitHub/wallet links, no
  tech-stack details, no disclaimers. Counted in East-Asian display width (CJK=2, ASCII=1).
- **Fee**: a bare numeric string (`"0.1"`), never `"0.1 USDT"` — USDT is implicit and the only
  currency. ≤6 decimal places.
- **Endpoint**: must be `https://`, publicly reachable, not `localhost`/private-IP/`.internal`.
  Changing it later requires a separate `update` call — get it right before submitting.

## 2. The listing-status trap (easy to lose an hour to)

**A rejected/unlisted ASP's endpoint being 100% technically correct changes nothing until you
resubmit.** OKX's job-matching/discovery pipeline filters on the ASP's *approval status*
independently of whether the endpoint actually works. Symptoms if you miss this:

- You fix every real bug, confirm the endpoint passes every validator, and a designated-provider
  test job *still* fails with "Agent NNNN does not currently offer any services matching this
  job" or "the x402 endpoint... is invalid" — even though direct calls to the endpoint prove
  otherwise.
- Check `onchainos agent get-agents --agent-ids <id>` → look at `approvalDisplayStatus` /
  `approvalLabel`. `5` = "Listing rejected", `2` = "Listing under review" (what you want after
  resubmitting), and only an *approved/listed* status makes the ASP eligible for real
  job-matching.
- **Fix**: `onchainos agent activate --agent-id <id> --preferred-language en-US` once your code
  fixes are actually deployed. This resubmits for review — it does not itself pass or fail
  anything, it just re-queues the review.

Don't waste retries against a designated-provider test job while the ASP is still in rejected
status — the job pipeline will keep saying "no matching services" regardless of endpoint health.

## 3. x402 / A2MCP endpoint

### 3.1 Hand-rolled pitfalls (why we stopped hand-rolling)

All four of these produced the *same* generic-sounding rejections ("endpoint unreachable",
"has not passed x402 standard validation", "no response, timed out") — none of the error text
told us which of these it actually was. The only way to isolate each one was bisecting: run
`onchainos agent x402-check --endpoint <url>` and `onchainos agent x402-validate ...` against a
**local** server, then a **public tunnel** (`cloudflared tunnel --url http://localhost:PORT`,
no login needed, gives a throwaway `https://*.trycloudflare.com` URL), then production — and
diff byte-for-byte against a real, already-listed A2MCP agent's response (`onchainos agent
search --query "<keyword>"` finds one; pick one with `soldCount > 0`).

1. **`resource` object shape.** The wire spec is `{url, description, mimeType}`. A non-spec
   extra field (we had `method: "POST"`) or a missing `mimeType` makes a strict-schema
   deserializer on OKX's side fail in a way that surfaces as **"the 402 response's `accepts` is
   empty"** — not a schema error, an empty-array error. Confirmed by diffing our decoded
   `PAYMENT-REQUIRED` payload against a real listed agent's.

2. **GET must also return the 402 challenge, not just POST.** OKX's validator probes with a
   plain GET before ever attempting a real paid call. If your app only gates the POST route
   (the one real clients use) and an unmatched GET falls through to a SPA/static-file catch-all,
   the validator sees `200 HTML` and concludes "not a valid x402 service" — even though your real
   POST endpoint is perfect. Gate **both** methods with the same x402 middleware.

3. **Don't let a CDN re-compress the response.** If you sit behind Cloudflare (Render's shared
   `*.onrender.com` domains do), Cloudflare may Brotli-compress your JSON body
   (`content-encoding: br`) even though your own server never compresses it. Some validator HTTP
   clients advertise Brotli support in `Accept-Encoding` but don't actually decode it, silently
   reading garbage bytes. Send `Cache-Control: no-store, no-transform` and, more effectively,
   have your own server declare `Content-Encoding: identity` on the 402 response — an origin that
   already declares an encoding stops Cloudflare from applying its own on top. Verify with
   `curl -D - <url> -H "Accept-Encoding: gzip, br"` and check the `content-encoding` header.

4. **Base64 padding.** This was the actual root cause, and the hardest to find. Encode the
   `PAYMENT-REQUIRED` header value as **standard, padded base64** (`Buffer.toString("base64")`
   in Node), not unpadded `base64url` (`-`/`_` alphabet, no `=` padding). The unpadded form
   worked fine against `localhost` (apparently a more lenient/dev code path) but was silently
   rejected on every real public HTTPS path we tested — Render *and* an unrelated Cloudflare
   tunnel both failed identically until this was fixed, which is what proved it wasn't a
   Render-specific or Cloudflare-specific issue.

5. **A failed/invalid payment attempt should still look like a valid x402 challenge.** If a
   request carries a bad `PAYMENT-SIGNATURE`, don't just return a bare `{"error": "..."}" with no
   `PAYMENT-REQUIRED` header and no `accepts` array — that shape alone can trip "not a valid x402
   service" checks that probe the invalid-signature path specifically. Re-emit the full challenge
   (header + `accepts`) alongside the error field.

### 3.2 What migrating to the real SDK actually involves (Node/Hono)

```bash
npm install @okxweb3/x402-hono @okxweb3/x402-core @okxweb3/x402-evm
```

Server side, once, mounted globally (not per-route):

```ts
import { OKXFacilitatorClient } from "@okxweb3/x402-core";
import { x402ResourceServer, paymentMiddleware } from "@okxweb3/x402-hono";
import { ExactEvmScheme } from "@okxweb3/x402-evm/exact/server";

const facilitatorClient = new OKXFacilitatorClient({ apiKey, secretKey, passphrase }); // OKX
// Developer Portal credentials - a different thing from your onchainos/wallet credentials.
const resourceServer = new x402ResourceServer(facilitatorClient).register("eip155:196", new ExactEvmScheme());

app.use(paymentMiddleware(
  {
    "GET /verify": { accepts: {...}, description: "...", mimeType: "application/json" },
    "POST /verify": { accepts: {...}, description: "...", mimeType: "application/json" },
  },
  resourceServer,
));
```

Declaring both verbs in the SDK's own route table is what replaces §3.1 bug #2 (GET not gated) -
structurally, not by remembering to apply middleware twice. Client side (buyer), replacing
hand-signed EIP-3009 + hand-encoded headers:

```ts
import { x402Client } from "@okxweb3/x402-core/client";
import { x402HTTPClient } from "@okxweb3/x402-core/http";
import { ExactEvmScheme, toClientEvmSigner } from "@okxweb3/x402-evm";

const client = new x402HTTPClient(new x402Client().register("eip155:196", new ExactEvmScheme(toClientEvmSigner(account))));
const paymentRequired = client.getPaymentRequiredResponse((name) => response.headers.get(name));
const paymentPayload = await client.createPaymentPayload(paymentRequired);
const headers = client.encodePaymentSignatureHeader(paymentPayload); // spread into your fetch call
```

Two bugs we hit *in this migration itself*, both silent (no error until you actually exercise the
paid path):

1. **`accepts.extra.name`/`extra.version` (the token's EIP-712 domain) are still your
   responsibility.** It's tempting to think the SDK/facilitator knows this for a well-known
   stablecoin - it doesn't. Omit it and the *client* throws `"EIP-712 domain parameters (name,
   version) are required in payment requirements for asset ..."` the moment it tries to sign -
   the 402 challenge itself looks completely fine, so this only surfaces on a real paid attempt.
2. **`resource.url` in the challenge comes back `http://`, not `https://`, on Render** (or any
   proxy that terminates TLS and forwards plain HTTP internally) - the SDK builds it from the
   raw incoming request and, unlike a hand-rolled builder, doesn't consult `x-forwarded-proto`
   itself. Override it explicitly per route (`resource: "https://your-domain/verify"` in the
   route config) rather than trusting request-derived scheme detection. On Render specifically,
   `process.env.RENDER_EXTERNAL_URL` is always the correct public URL.

One behavioral difference worth knowing before you design your response schema: the SDK verifies
the payment signature, runs your route handler, buffers the response, *then* settles on-chain -
the opposite order of a naive hand-rolled implementation that settles first and only calls the
handler once payment is confirmed. If your response body embeds anything derived from the
settlement (a tx hash, e.g.), it won't exist yet at handler time - either move that reference to
metadata outside anything you cryptographically sign, or rely on the standard `PAYMENT-RESPONSE`
header the SDK attaches to the same HTTP response instead of duplicating it in the body.

**Settlement is skipped entirely if your handler returns status >= 400** (confirmed by reading
`@okxweb3/x402-hono`'s compiled source, not just its types: `if (res.status >= 400) return;`
right after `await next()`, before `processSettlement` is ever called). This is load-bearing, not
just an implementation detail - it means "return 400 for a request that gave you nothing checkable"
is simultaneously the fix for "give an actionable error" *and* "don't bill for a no-op verdict".
A route handler that always returns 200 (even a signed-but-empty UNVERIFIABLE verdict) will always
charge the buyer; a route handler that returns 400 for genuinely bad/missing input never will.

Also worth designing for up front: **the x402 protocol carries no job/task correlator by
itself** - a paid replay is just a signed payment against your fixed resource URL, nothing more.
If your buyer's own tooling forgets to include a `jobId`/`spec` in the request body (observed
live via an OKX review), you have no way to know which task this is for *from the payment alone*
- except that the payment header does carry the payer's wallet address
(`decodePaymentSignatureHeader` from `@okxweb3/x402-core/http`, `payload.authorization.from` for
the `exact` EIP-3009 scheme), which you can correlate against your own in-progress/accepted task
list (`onchainos agent task-in-progress`) as a best-effort fallback - see
`src/marketplace/resolve-payer-task.ts`. Only trust this when exactly one task matches; multiple
concurrent accepted tasks from the same buyer are genuinely ambiguous and should never be guessed.

### 3.3 "Connection error"/"endpoint down" reports that aren't your route handler at all

Three separate, real root causes produced review complaints that all read identically from OKX's
side ("connection error", "no HTTP response", `replayStatus=0`) - worth telling apart, because the
fix for each is completely different, and none of them are a bug *in* your route handler's logic.

1. **An unbounded LLM call hangs the whole request.** If your verification pipeline calls out to
   an LLM (compiling criteria, judging content, etc.) via an OpenAI-SDK-compatible client, the SDK
   defaults to a **10-minute timeout** plus its **own internal retries (2 by default)** - these
   stack multiplicatively with any retry loop you've already written around it. A single stalled
   attempt against a free/rate-limited model (observed live: one run took 86.8s just to compile a
   spec under load) can silently block the entire response for minutes, which every caller
   (including your own test client, and OKX's review harness) sees as a dead connection, not a
   slow one. **Fix**: set an explicit, short `timeout` and `maxRetries: 0` on the SDK client
   itself (`new OpenAI({ timeout: 20_000, maxRetries: 0, ... })`) so *your own* outer retry loop
   - which knows things the SDK doesn't (e.g. "don't retry a tripped security canary") - stays in
   control of worst-case latency, instead of an invisible 10-minute default plus double-retries
   deciding it for you. Confirmed live: before the fix, a second consecutive request hung past 5
   minutes with zero response; after, back-to-back real paid requests completed in 21-46s each.

2. **Free-tier cold start.** A dormant Render (or similar PaaS) free/starter-tier instance takes
   30-60s to wake on the first request after idling - `/health` alone can take 10s+ on a cold
   instance. Mitigate with a keep-warm self-ping (`scripts/start.sh` in this repo pings its
   own public `/health` every 5 minutes in the background) - cheap, and removes this specific
   cause entirely, though it doesn't help #3 below.

3. **Shared-domain edge flakiness - genuinely not fixable in your own code.** Confirmed live,
   independently of your app: `https://<app>.onrender.com` sits behind Render's shared
   `*.onrender.com` edge (a Cloudflare-fronted CDN, per the CNAME chain), which can **intermittently
   drop TLS handshakes from automated/datacenter clients specifically** for a window of several
   minutes, then recover on its own with no code change and no redeploy. Reproduced directly: a
   plain `curl`/`onchainos agent x402-check` against the exact same URL failed at the TLS layer
   ("unexpected EOF") twice in a row, then succeeded on the third identical attempt seconds later
   - while an external vantage point (a different fetch tool) got a clean `200` the whole time,
   and Render's own status page showed all-green. A raw TCP connect to the app's specific
   Cloudflare-assigned IP failed the same way a *different* Cloudflare-hosted IP did not,
   confirming it wasn't a general Cloudflare/network problem, something narrower to that
   IP/edge-node combination. There is no application-layer fix for this - if it recurs often
   enough to matter, the actual fix is moving off the shared `onrender.com` domain (a custom
   domain, or a different host), not another code change. Worth knowing so you don't burn time
   re-debugging your own route handler for a review failure that's actually this.

### 3.4 A gotcha in any code that shells out to a CLI and tries to classify the failure

If your route handler shells out to `onchainos` (or any CLI) via Node's `execFile`/`execFileAsync`
and needs to tell *which* error happened (bad input vs. a real outage) by inspecting the error
text, don't check `err.message` - on a non-zero exit, Node's error object's `.message` is just the
generic `"Command failed: <command that ran>"`. The CLI's **actual** error output (e.g.
`onchainos`'s own `{"ok":false,"error":"..."}` JSON, written to stdout even on exit code 1) lands
on the error object's `.stdout` property instead. A pattern-match against `.message` alone will
silently never match anything in production, even though the exact same regex works perfectly
against a hand-written test mock that (incorrectly) puts the CLI text directly into `.message`.
Caught live, post-deploy, not by the test suite - the fix was checking `.stdout` first, falling
back to `.message`/`String(err)` only if `.stdout` is absent or unparseable.

## 4. Fast local iteration loop

Testing only against production Render costs a full deploy-and-wait cycle per guess. Faster path:

```bash
# 1. Run the server locally
PORT=8799 npx tsx src/index.ts &

# 2. Expose it publicly without touching your real host (no account needed)
cloudflared tunnel --url http://localhost:8799
# → prints a https://<random>.trycloudflare.com URL

# 3. Test the exact same checks OKX's pipeline uses
onchainos agent x402-check --endpoint https://<random>.trycloudflare.com/verify
onchainos agent x402-validate --endpoint https://<random>.trycloudflare.com/verify \
  --agent-id <your-user-agent-id> --job-id <any> --fee-amount <fee> --fee-token USDT
```

A pure `localhost` curl test is *not sufficient* — several of the bugs above only manifested over
a real public HTTPS path, not plain local HTTP. The tunnel gets you the real code path without a
deploy cycle.

## 5. Deploying an *authenticated* onchainos + okx-a2a session to a headless server

This is a separate class of problem from everything above — it's not about the x402 wire
format, it's about the fact that `onchainos` normally needs an **interactive** email+OTP login,
which a Render/any headless server can never do. If your agent's server-side code shells out to
`onchainos wallet sign-message` (or anything else requiring an authenticated session) and you
just deploy the binary with no credentials, it silently has no wallet.

**The pattern**: authenticate once, locally (interactive login), then transplant the resulting
credential files into the deployed environment.

- `onchainos` stores its session under `~/.onchainos/`: `session.json`, `keyring.enc`,
  `machine-identity`, `wallets.json`. Some of these are binary/encrypted, not plain text.
- Render's **Secret Files** feature (mounted read-only at `/etc/secrets/<filename>` in the
  running container) only accepts **text** in its dashboard paste box — it can't take raw
  binary. **Base64-encode each file before pasting it in**, upload as `<name>.b64`, then decode
  back to the real filename at boot:

  ```bash
  # locally, after `onchainos wallet auth` / login
  base64 -w0 ~/.onchainos/session.json         # paste output as Render Secret File "onchainos-session.b64"
  base64 -w0 ~/.onchainos/keyring.enc           # → "onchainos-keyring.b64"
  base64 -w0 ~/.onchainos/machine-identity      # → "onchainos-machine-identity.b64"
  base64 -w0 ~/.onchainos/wallets.json          # → "onchainos-wallets.b64"
  ```

  ```bash
  # in your Render start script, before starting the actual server
  mkdir -p "$HOME/.onchainos"
  base64 -d /etc/secrets/onchainos-session.b64          > "$HOME/.onchainos/session.json"
  base64 -d /etc/secrets/onchainos-keyring.b64           > "$HOME/.onchainos/keyring.enc"
  base64 -d /etc/secrets/onchainos-machine-identity.b64  > "$HOME/.onchainos/machine-identity"
  base64 -d /etc/secrets/onchainos-wallets.b64           > "$HOME/.onchainos/wallets.json"
  chmod 600 "$HOME/.onchainos"/*
  onchainos wallet status   # sanity check the restore actually worked
  ```

  Never commit these files or their base64 to git — Secret Files exist precisely so credentials
  never touch the repo.

- **The restored session goes stale the moment your local wallet changes** (switch accounts, add
  a wallet, anything that touches `~/.onchainos/`) — the Secret Files are a point-in-time copy,
  not a live sync. Symptom: everything deploys fine, the endpoint answers, but any code path that
  shells out to `onchainos wallet sign-message --from <address>` fails with `"no address matches
  from=<address> chain=..."` even though `onchainos wallet addresses` proves that address exists
  *locally* right now. Fix is the same four-file base64 regenerate-and-repaste as the initial
  setup above, not a code change - confirm with `onchainos wallet addresses` locally first that
  the address your code actually signs with (whatever env var it reads) is present before
  re-uploading.

- **If you also run the `okx-a2a` A2A daemon server-side** (needed so OKX.AI's "agent online
  status" check gets a response, separate from any HTTP API you expose), two more non-obvious
  gotchas:
  1. `okx-a2a doctor --fix` alone leaves `provider_binding` failing with *"no default AI provider
     is bound"* — its runtime auto-detection only works from inside an interactive Claude Code
     session, which a boot script never is. Call `okx-a2a ai-provider set --provider claude
     --json` explicitly first.
  2. Having `ANTHROPIC_API_KEY` set is **not** the same as the `claude` CLI binary existing on
     the box — that env var only satisfies your own app's direct Anthropic SDK calls. If
     `okx-a2a` needs to shell out to the actual `claude` CLI, add `@anthropic-ai/claude-code` as
     a real npm dependency so the binary is actually installed. Once it's there, `ANTHROPIC_API_KEY`
     alone is sufficient for it to authenticate non-interactively — no OAuth token or exported
     session file needed for that part specifically.
  3. `autostart` (OS-level daemon autostart) will always report failing on Render — no
     systemd/dbus in the container. This is cosmetic/optional (`doctor --fix` marks it
     `optional`, overall `ready: true` regardless) — don't chase fixing it.
  4. Run both `okx-a2a` calls non-fatally (`|| echo "WARNING..."`) in the start script — an A2A
     hiccup should never be able to take down your actual paid API.
  5. If your Anthropic credit runs out and you have no budget to top it up, `okx-a2a` can run on
     `codex` instead of `claude`, pointed at any free OpenAI-compatible endpoint (e.g. NVIDIA
     NIM's free tier, `https://integrate.api.nvidia.com/v1`) via `model_providers` in
     `~/.codex/config.toml`. Two gotchas: (a) that config only works through the older
     `wire_api = "chat"` protocol, which codex releases 0.14x+ dropped - pin an exact older
     version (`@openai/codex@0.90.0` is confirmed working) rather than `^latest`; (b) `okx-a2a`'s
     `provider_cli` doctor check wants the `codex` CLI to have *some* logged-in credential on
     disk, separate from which `model_provider` actual completions route through - satisfy it
     non-interactively with `echo "$KEY" | codex login --with-api-key`, which doesn't change
     the active provider. Then `okx-a2a ai-provider set --provider codex --json`. The free
     model's tool-use reliability for actually executing the reply (not just answering) is
     noticeably weaker than Claude's - budget for occasional missed replies if you go this route.

## 6. Manual end-to-end test, and its actual cost

OKX's own suggested manual test ("register as a User, prompt 'I would like to use the services
of agent ID N'") is not a lightweight ping — it resolves to actually publishing a designated-
provider task, which spends the real service fee in escrow per attempt. There is no cheaper
"just say hi" path; any real A2A interaction requires a backing job. Budget for it, and don't
retry it blindly — check `onchainos agent get-agents --agent-ids <id>` first to confirm the
listing itself is approved, or every retry will fail on listing status regardless of endpoint
correctness (see §2).
