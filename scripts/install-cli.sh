#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

npm install
npm link

echo "Installed CLI from current repository checkout. Run: tgcli --help"

if command -v npx >/dev/null 2>&1; then
  npx -y skills add dapi/tgcli --skill tgcli --agent '*' -g -y
  echo "Installed tgcli skill from GitHub repository."
else
  echo "npx is not available, skipped skill installation."
fi
