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
export PATH="$PWD/bin:$PATH"

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

exec node dist/src/index.js
