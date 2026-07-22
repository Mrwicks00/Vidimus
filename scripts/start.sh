#!/usr/bin/env bash
# Host-agnostic start command (Render, Railway, or anywhere else). Restores the onchainos
# session/credential files into $HOME/.onchainos before starting the server - signVerdict()
# shells out to `onchainos wallet sign-message`, which needs an already-authenticated session on
# disk since a deployed instance can't do interactive email+OTP login itself.
set -euo pipefail
cd "$(dirname "$0")/.."

chmod +x bin/onchainos
export PATH="$PWD/bin:$PWD/node_modules/.bin:$PATH"

mkdir -p "$HOME/.onchainos"

# Prefers a plain base64 env var (works identically on any host - Railway/Render/anywhere else,
# since ordinary environment variables already hold arbitrary-length strings, no special
# handling needed). Falls back to Render's "Secret Files" convention (mounted at
# /etc/secrets/<name>.b64) for the existing Render deployment, which used a mounted-file
# workaround for Render's dashboard-paste-box UX rather than any real technical requirement.
restore() {
  local env_var="$1"
  local secret_file="$2"
  local dest_file="$3"
  local b64="${!env_var:-}"
  if [ -z "$b64" ] && [ -f "$secret_file" ]; then
    b64="$(cat "$secret_file")"
  fi
  if [ -n "$b64" ]; then
    echo "$b64" | base64 -d > "$dest_file"
    chmod 600 "$dest_file"
    echo "[start] restored $dest_file"
  else
    echo "[start] WARNING: neither \$$env_var nor $secret_file set - onchainos will not be authenticated"
  fi
}

restore ONCHAINOS_SESSION_B64 /etc/secrets/onchainos-session.b64 "$HOME/.onchainos/session.json"
restore ONCHAINOS_KEYRING_B64 /etc/secrets/onchainos-keyring.b64 "$HOME/.onchainos/keyring.enc"
restore ONCHAINOS_MACHINE_IDENTITY_B64 /etc/secrets/onchainos-machine-identity.b64 "$HOME/.onchainos/machine-identity"
restore ONCHAINOS_WALLETS_B64 /etc/secrets/onchainos-wallets.b64 "$HOME/.onchainos/wallets.json"

onchainos wallet status || echo "[start] WARNING: onchainos wallet status failed - check restored session files"

# okx-a2a A2A communication daemon - OKX.AI's own "agent online status" check pings this,
# not just the HTTP API below. `doctor --fix` starts the daemon itself (detached) as one of
# its repair actions, so no separate backgrounding is needed here; `--non-interactive` skips
# any login-flow prompts that would otherwise hang this script forever. The provider must be
# bound explicitly first: okx-a2a's runtime auto-detection only fires when doctor runs from
# inside an interactive Claude Code session, which never happens in this boot script
# (confirmed live on Render: doctor --fix alone left provider_binding failing with "no
# default AI provider is bound"). Both steps non-fatal - an A2A hiccup must never take down
# the paid /verify endpoint.
#
# Using codex (not claude) as the AI provider here, pointed at NVIDIA NIM's free-tier
# OpenAI-compatible endpoint instead of the Anthropic API - the ANTHROPIC_API_KEY ran out of
# credit and there's no budget to top it up. `codex` supports arbitrary OpenAI-compatible
# providers via `model_providers` in config.toml, but only through the older `wire_api =
# "chat"` protocol, which newer codex releases (0.14x+) removed support for - NIM only speaks
# that older chat-completions shape, not the newer "responses" API - so the version is
# pinned in package.json (@openai/codex@0.90.0, which still accepts wire_api = "chat") rather
# than whatever "latest" would resolve to. This config.toml has no secret in it - the actual
# key comes from the NVIDIA_NIM_API_KEY env var (a plain Render env var is fine here, unlike
# the onchainos credentials above - not a binary file, no base64/Secret-Files dance needed).
mkdir -p "$HOME/.codex"
cat > "$HOME/.codex/config.toml" <<'EOF'
model_provider = "nvidia_nim"
model = "meta/llama-3.1-8b-instruct"

[model_providers.nvidia_nim]
name = "NVIDIA NIM"
base_url = "https://integrate.api.nvidia.com/v1"
env_key = "NVIDIA_NIM_API_KEY"
wire_api = "chat"
EOF
[ -n "${NVIDIA_NIM_API_KEY:-}" ] || echo "[start] WARNING: NVIDIA_NIM_API_KEY is not set - codex/A2A replies will fail"

# codex's own "logged in" state is separate from the model_providers config above - it's
# whether codex has *any* OpenAI-account credential on disk, checked by `okx-a2a doctor`'s
# provider_cli gate regardless of which model_provider is actually active. Without this,
# doctor reports blockingFailures and wants an interactive `codex login --device-auth`,
# which can't run on a headless box anyway. `--with-api-key` just writes a local auth
# record - it does NOT change which provider actual completions route through (that's
# still model_provider = "nvidia_nim" above, via NVIDIA_NIM_API_KEY's own env_key) -
# confirmed locally: a real completion via NIM still succeeds after this.
echo "${NVIDIA_NIM_API_KEY:-unused-placeholder}" | codex login --with-api-key || echo "[start] WARNING: codex login --with-api-key failed"

okx-a2a ai-provider set --provider codex --json || echo "[start] WARNING: okx-a2a ai-provider set failed"
okx-a2a doctor --fix --non-interactive --json || echo "[start] WARNING: okx-a2a doctor --fix reported issues - A2A online-status check may fail, /verify is unaffected"

# The A2A daemon writes its own activity log (message sync, heartbeats) to a file that never
# reaches Render's captured stdout - stream it in, prefixed, so real inbound-message activity
# is actually visible in the dashboard. (Deliberately not doing this for `okx-a2a logs llm` -
# that's the full Claude transcript per reply, tens of KB each, too high-volume to stream
# permanently; run it manually via Render's Shell when deep-diagnosing a specific reply.)
(okx-a2a logs server 2>&1 | sed -u 's/^/[okx-a2a] /') &

# Keep-warm self-ping through the PUBLIC url (not localhost - a free-tier host's spin-down
# counts only inbound edge traffic, so an internal ping wouldn't register). A slept instance
# takes 30-60s to cold-start, during which the edge drops paid POST replays with no HTTP
# response at all - observed as OKX review failures (replayStatus=0, empty txHash) that look
# identical to a dead endpoint. Same fallback priority as config.ts's publicBaseUrl - keep the
# two in sync if this chain ever changes. Non-fatal like everything else in this section.
if [ -n "${PUBLIC_BASE_URL:-}" ]; then
  keep_warm_url="$PUBLIC_BASE_URL"
elif [ -n "${RAILWAY_PUBLIC_DOMAIN:-}" ]; then
  keep_warm_url="https://${RAILWAY_PUBLIC_DOMAIN}"
elif [ -n "${RENDER_EXTERNAL_URL:-}" ]; then
  keep_warm_url="$RENDER_EXTERNAL_URL"
else
  keep_warm_url="http://localhost:${PORT:-3000}"
fi
(
  while true; do
    sleep 300
    curl -s -o /dev/null --max-time 30 "${keep_warm_url}/health" || echo "[start] WARNING: keep-warm ping failed"
  done
) &

# Re-run doctor --fix every 2 minutes for the life of the container. The one-shot check above
# only covers boot time - if the detached daemon dies or the Claude/XMTP binding goes stale
# later, Render's own health check never notices (it only watches the HTTP port), so nothing
# would otherwise catch or repair it. Runs in the background so it never blocks or crashes the
# paid /verify endpoint; non-fatal like the checks above.
(
  while true; do
    sleep 120
    okx-a2a doctor --fix --non-interactive --json || echo "[start] WARNING: periodic okx-a2a doctor --fix failed"
  done
) &

exec node dist/src/index.js
