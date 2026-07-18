#!/usr/bin/env bash
# Render start command. Restores the onchainos session/credential files from
# Render's Secret Files (mounted at /etc/secrets/<filename>, base64-encoded to
# survive the dashboard's text-only content box) into $HOME/.onchainos before
# starting the server - signVerdict() shells out to `onchainos wallet
# sign-message`, which needs an already-authenticated session on disk since
# this deployed instance can't do interactive email+OTP login itself.
set -euo pipefail
cd "$(dirname "$0")/.."

chmod +x bin/onchainos
export PATH="$PWD/bin:$PWD/node_modules/.bin:$PATH"

mkdir -p "$HOME/.onchainos"

restore() {
  local secret_file="$1"
  local dest_file="$2"
  if [ -f "$secret_file" ]; then
    base64 -d "$secret_file" > "$dest_file"
    chmod 600 "$dest_file"
    echo "[render-start] restored $dest_file"
  else
    echo "[render-start] WARNING: $secret_file not found - onchainos will not be authenticated"
  fi
}

restore /etc/secrets/onchainos-session.b64 "$HOME/.onchainos/session.json"
restore /etc/secrets/onchainos-keyring.b64 "$HOME/.onchainos/keyring.enc"
restore /etc/secrets/onchainos-machine-identity.b64 "$HOME/.onchainos/machine-identity"
restore /etc/secrets/onchainos-wallets.b64 "$HOME/.onchainos/wallets.json"

onchainos wallet status || echo "[render-start] WARNING: onchainos wallet status failed - check restored session files"

# okx-a2a A2A communication daemon - OKX.AI's own "agent online status" check pings this,
# not just the HTTP API below. `doctor --fix` starts the daemon itself (detached) as one of
# its repair actions, so no separate backgrounding is needed here; `--non-interactive` skips
# any login-flow prompts that would otherwise hang this script forever. AI provider auth
# comes from ANTHROPIC_API_KEY (already required above, in config.ts) via the `claude` CLI's
# own documented auth precedence - no separate token/session file to restore. The provider
# must be bound explicitly first: okx-a2a's runtime auto-detection only fires when doctor
# runs from inside an interactive Claude Code session, which never happens in this boot
# script (confirmed live on Render: doctor --fix alone left provider_binding failing with
# "no default AI provider is bound"). Both steps non-fatal like the onchainos check above -
# an A2A hiccup must never take down the paid /verify endpoint.
okx-a2a ai-provider set --provider claude --json || echo "[render-start] WARNING: okx-a2a ai-provider set failed"
okx-a2a doctor --fix --non-interactive --json || echo "[render-start] WARNING: okx-a2a doctor --fix reported issues - A2A online-status check may fail, /verify is unaffected"

# Re-run doctor --fix every 2 minutes for the life of the container. The one-shot check above
# only covers boot time - if the detached daemon dies or the Claude/XMTP binding goes stale
# later, Render's own health check never notices (it only watches the HTTP port), so nothing
# would otherwise catch or repair it. Runs in the background so it never blocks or crashes the
# paid /verify endpoint; non-fatal like the checks above.
(
  while true; do
    sleep 120
    okx-a2a doctor --fix --non-interactive --json || echo "[render-start] WARNING: periodic okx-a2a doctor --fix failed"
  done
) &

exec node dist/src/index.js
