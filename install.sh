#!/usr/bin/env bash
set -euo pipefail

REPO="github:dapi/tgcli"
SKILL_REPO="dapi/tgcli"
SKILL_NAME="tgcli"

info()  { printf '\033[1;34m%s\033[0m\n' "$*"; }
ok()    { printf '\033[1;32m%s\033[0m\n' "$*"; }
warn()  { printf '\033[1;33m%s\033[0m\n' "$*"; }
error() { printf '\033[1;31m%s\033[0m\n' "$*" >&2; }

# Activate node version managers if npm is not already in PATH
if ! command -v npm >/dev/null 2>&1; then
  set +u  # version managers use unset variables
  if command -v mise >/dev/null 2>&1; then
    eval "$(mise activate bash 2>/dev/null)" || true
    eval "$(mise env 2>/dev/null)" || true
  fi
  if [ -s "${HOME:-}/.nvm/nvm.sh" ]; then
    . "$HOME/.nvm/nvm.sh"
  fi
  if command -v fnm >/dev/null 2>&1; then
    eval "$(fnm env 2>/dev/null)" || true
  fi
  set -u
fi

if ! command -v node >/dev/null 2>&1; then
  error "Node.js is required but not found. Install it first: https://nodejs.org"
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  error "npm is required but not found."
  exit 1
fi

# Install or update CLI
if command -v tgcli >/dev/null 2>&1; then
  info "Updating tgcli..."
else
  info "Installing tgcli..."
fi
npm install -g "$REPO"
ok "tgcli $(tgcli --version 2>/dev/null || echo 'installed')"

# Install or update skill
if command -v npx >/dev/null 2>&1; then
  info "Installing tgcli skill for AI agents..."
  npx skills add "$SKILL_REPO" --skill "$SKILL_NAME" --agent '*' -y
  ok "Skill '$SKILL_NAME' installed"
else
  warn "npx not found — skipping skill installation"
fi

echo ""
ok "Done!"
if ! tgcli auth status >/dev/null 2>&1; then
  info "Next step: run 'tgcli auth' to log in to Telegram"
fi
