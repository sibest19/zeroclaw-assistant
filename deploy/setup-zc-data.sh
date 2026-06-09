#!/usr/bin/env bash
# Assemble the ZeroClaw container volume (zc-data) from versioned sources + the
# Codex auth profile already created natively. Re-run after editing config/persona.
set -euo pipefail
cd "$(dirname "$0")"

ZC=zc-data
mkdir -p "$ZC/.zeroclaw/agents/assistant/workspace" "$ZC/workspace/sops"

# Config + SOPs
cp config.toml "$ZC/.zeroclaw/config.toml"
rsync -a --delete sops/ "$ZC/workspace/sops/" 2>/dev/null || cp -R sops/. "$ZC/workspace/sops/"

# Persona (agent identity document) — versionata in deploy/IDENTITY.md
cp IDENTITY.md "$ZC/.zeroclaw/agents/assistant/workspace/IDENTITY.md"

# Codex auth profile: NON è versionato (segreto). Riusa quello esistente se c'è
# (native/ in dev, o un file fornito sul server), altrimenti: 'zeroclaw auth login'
# dentro il container.
if [ -f "$ZC/.zeroclaw/auth-profiles.json" ]; then
  echo "✓ auth Codex già presente in zc-data"
elif [ -f native/.zeroclaw/auth-profiles.json ]; then
  cp native/.zeroclaw/auth-profiles.json "$ZC/.zeroclaw/auth-profiles.json"
  echo "✓ auth Codex riusata da native/"
else
  echo "⚠ nessun auth-profiles.json — esegui 'docker compose exec zeroclaw zeroclaw auth login --model-provider openai-codex'"
fi

echo "✓ zc-data pronto"
