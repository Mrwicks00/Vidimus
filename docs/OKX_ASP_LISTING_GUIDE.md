# OKX.AI ASP Listing — Field Guide

Everything that actually broke a real ASP listing (agent #4933, "Vidimus") on OKX.AI, from
initial registration through a paid A2MCP (x402) endpoint passing live validation. Written to be
reusable for any future agent, not specific to this repo.

**Bottom line up front:** if your service is pay-per-call, use the official OKX Payment SDK
(`@okxweb3/x402-*`, Node/Go/Rust/Java/Python — see the "Integrate via SDK" doc linked from the
A2MCP guide) instead of hand-rolling the x402 wire format. Section 3 below is a list of ways to
get the hand-rolled version subtly wrong that cost an entire debugging session to find — an
SDK that's already been exercised against OKX's real validator won't have these bugs.

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

## 3. x402 / A2MCP endpoint pitfalls (the actual bugs, in the order we found them)

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

## 6. Manual end-to-end test, and its actual cost

OKX's own suggested manual test ("register as a User, prompt 'I would like to use the services
of agent ID N'") is not a lightweight ping — it resolves to actually publishing a designated-
provider task, which spends the real service fee in escrow per attempt. There is no cheaper
"just say hi" path; any real A2A interaction requires a backing job. Budget for it, and don't
retry it blindly — check `onchainos agent get-agents --agent-ids <id>` first to confirm the
listing itself is approved, or every retry will fail on listing status regardless of endpoint
correctness (see §2).
