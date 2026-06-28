---
name: tgcli-remote
description: Remote tgcli usage over SSH on a VPS. Use when the user says remote tgcli, remote telegram, удаленный tgcli, удаленный телеграмм, or when Telegram tasks must run on a remote server selected by TGCLI_SERVER.
---

# TGCLI Remote

Use tgcli on the remote VPS, not locally.

## Target

- Read the host from `TGCLI_SERVER`.
- SSH as `danil`.
- Prefer `ssh danil@"$TGCLI_SERVER" tgcli ...` for one-off commands.
- Use `ssh danil@"$TGCLI_SERVER" 'bash -lc "..."'` when shell expansion or multiple commands are needed.
- Treat the remote host as the only place where the Telegram session store lives.

## Use

- Use this skill for remote message search, sending, sync, media download, and diagnostics.
- Keep `--json` on machine workflows.
- Prefer `--source archive|live|both` explicitly when reading messages.
- Do not use MCP here; this skill is CLI-only.

## Checks

- `ssh danil@"$TGCLI_SERVER" 'command -v tgcli && tgcli --version'`
- `ssh danil@"$TGCLI_SERVER" 'tgcli config list'`
- `ssh danil@"$TGCLI_SERVER" 'tgcli doctor --connect'`
- `ssh danil@"$TGCLI_SERVER" 'tgcli auth status'`

## Common Commands

```bash
ssh danil@"$TGCLI_SERVER" tgcli messages list --chat @channel --limit 20 --source archive --json
ssh danil@"$TGCLI_SERVER" tgcli messages search "invoice" --chat @channel --source archive --json
ssh danil@"$TGCLI_SERVER" tgcli send text --to @username --message "hello" --json
ssh danil@"$TGCLI_SERVER" tgcli send file --to @channel --file ./report.pdf --caption "report" --json
ssh danil@"$TGCLI_SERVER" tgcli sync --once
ssh danil@"$TGCLI_SERVER" tgcli media download --chat @channel --id 123 --json
```

## Failure Modes

- If `TGCLI_SERVER` is unset, stop and ask for it or read it from `.env.local`.
- If SSH host keys changed, remove the stale entry with `ssh-keygen -R "$TGCLI_SERVER"` and verify the new fingerprint before continuing.
- If `tgcli` is missing remotely, check the remote login shell `PATH` first.
- If auth is missing, run `tgcli auth` on the remote host as `danil`; do not copy secrets back to the local machine unless explicitly requested.

## Notes

- The remote store is expected under `~/.local/share/tgcli`.
- Keep commands narrow and explicit; the remote host is already the execution boundary.
