# office3 service

`office3` runs one `com.dapi.tgcli` LaunchAgent. Its source plist is
`~/code/tgcli/ops/office3/com.dapi.tgcli.plist`; the desired state is registered
in `~/code/personal-ops/launchd/registry.json`. The plist launches the canonical
`~/.local/bin/tgcli` wrapper from `~/dotfiles` with the existing office3 store.

Install the matching CLI through `~/dotfiles` first, then use
`~/code/tgcli/scripts/install-office3-launchagent.sh` on office3. The installer
saves any previous plist as `~/Library/LaunchAgents/com.dapi.tgcli.plist.pre-2.9.0`.
Check `~/code/personal-ops/scripts/personalctl launchd status` and `plan` after
installation. Service logs are mode `0600` under `~/code/tgcli/log/` and are
ignored by Git.

For a 24-hour observation, run `python3 ~/code/tgcli/ops/office3/monitor-24h.py
--port 5173` in the background on office3. It samples launchd service status
and the loopback MCP listener every five minutes without Telegram API calls.
The current result is `~/code/tgcli/log/office3-monitor-2.9.0-summary.json`;
individual samples are in the adjacent `.jsonl` file.

If the new service fails, stop its LaunchAgent and reinstall the previous CLI
version through `~/dotfiles` using `TGCLI_SOURCE_DIR=''` and
`TGCLI_VERSION=2.8.3`. Restore the saved plist and bootstrap it. Do not remove
the Telegram store; the archive and session remain in place.
