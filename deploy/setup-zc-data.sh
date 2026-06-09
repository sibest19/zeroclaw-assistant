#!/usr/bin/env bash
# Assemble the ZeroClaw container volume (zc-data) from versioned sources.
# Re-run after editing config.toml / IDENTITY.md / sops.
set -euo pipefail
cd "$(dirname "$0")"

ZC=zc-data
mkdir -p "$ZC/.zeroclaw/agents/assistant/workspace" "$ZC/workspace/sops"

# Config + SOPs
cp config.toml "$ZC/.zeroclaw/config.toml"
rsync -a --delete sops/ "$ZC/workspace/sops/" 2>/dev/null || cp -R sops/. "$ZC/workspace/sops/"

# Persona (agent identity document) — versionata in deploy/IDENTITY.md
cp IDENTITY.md "$ZC/.zeroclaw/agents/assistant/workspace/IDENTITY.md"

# Codex auth: NON versionato (segreto), vive solo in zc-data/.zeroclaw/
# (auth-profiles.json cifrato + .secret_key). Su una macchina nuova non c'è:
# fai login UNA volta dentro il container.
if [ -f "$ZC/.zeroclaw/auth-profiles.json" ]; then
  echo "✓ auth Codex già presente in zc-data"
else
  echo "⚠ auth Codex assente — dopo 'docker compose up -d' esegui:"
  echo "   docker compose exec -it zeroclaw zeroclaw auth login --model-provider openai-codex --device-code"
fi

echo "✓ zc-data pronto"
