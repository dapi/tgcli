#!/bin/sh
set -eu

if [ "$(hostname)" != "Danils-MacBook-Pro-261" ]; then
  echo "This installer is only for the MacBook" >&2
  exit 2
fi

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
label=com.dapi.tgcli
source_plist="$repo_root/ops/macbook/$label.plist"
installed_plist="$HOME/Library/LaunchAgents/$label.plist"
log_dir="$repo_root/log"
domain="gui/$(id -u)"

if [ "$("$HOME/.local/bin/tgcli" --version)" != "2.9.1" ]; then
  echo "Install tgcli 2.9.1 through dotfiles before loading the service" >&2
  exit 2
fi

mkdir -p "$HOME/Library/LaunchAgents" "$log_dir"
chmod 700 "$log_dir"
touch "$log_dir/tgcli.log" "$log_dir/tgcli.error.log"
chmod 600 "$log_dir/tgcli.log" "$log_dir/tgcli.error.log"
if [ -f "$installed_plist" ]; then
  cp -p "$installed_plist" "$installed_plist.pre-2.9.1"
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
