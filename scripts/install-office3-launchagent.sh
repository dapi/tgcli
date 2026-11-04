#!/bin/sh
set -eu

if [ "$(hostname)" != "Danils-iMac-Home" ]; then
  echo "This installer is only for office3" >&2
  exit 2
fi

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
label=com.dapi.tgcli
source_plist="$repo_root/ops/office3/$label.plist"
installed_plist="$HOME/Library/LaunchAgents/$label.plist"
log_dir="$repo_root/log"
domain="gui/$(id -u)"

expected_version=$(node -p 'require(process.argv[1]).version' "$repo_root/package.json" 2>/dev/null \
  || sed -n 's/^  "version": "\([^"]*\)".*/\1/p' "$repo_root/package.json" | head -1)
installed_version=$("$HOME/.local/bin/tgcli" --version)
if [ "$installed_version" != "$expected_version" ]; then
  echo "Install tgcli $expected_version through dotfiles (make tgcli-install) before loading the service; installed: $installed_version" >&2
  exit 2
fi

mkdir -p "$HOME/Library/LaunchAgents" "$log_dir"
chmod 700 "$log_dir"
touch "$log_dir/tgcli.log" "$log_dir/tgcli.error.log"
chmod 600 "$log_dir/tgcli.log" "$log_dir/tgcli.error.log"
if [ -f "$installed_plist" ]; then
  cp -p "$installed_plist" "$installed_plist.pre-$expected_version"
fi
launchctl bootout "$domain/$label" 2>/dev/null || true
cp "$source_plist" "$installed_plist"
chmod 644 "$installed_plist"
launchctl enable "$domain/$label"
if ! launchctl bootstrap "$domain" "$installed_plist" 2>/dev/null; then
  sleep 1
  launchctl bootstrap "$domain" "$installed_plist"
fi
echo "Loaded $label from $installed_plist"
