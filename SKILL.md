---
name: tgcli
description: >
  Use when user wants to read/search/send/analyze Telegram messages via tgcli CLI.
  Trigger on requests about channel/chat history, digests/news, mentions, files, topics,
  contacts, groups, and archive/sync status. For reply/edit/delete/reactions/inline buttons
  or admin operations, use telegram-mcp instead.
---

# tgcli

Telegram CLI skill for AI agents.

## Install

Install this skill from GitHub:

```bash
npx skills add dapi/tgcli --skill tgcli --agent '*' -y
```

Install CLI (dapi fork):

```bash
npm install -g github:dapi/tgcli
```

Authenticate once:

```bash
tgcli auth
```

## Tool Boundary: tgcli vs telegram-mcp

| Use tgcli for | Use telegram-mcp for |
| - | - |
| Read/search/archive messages | reply/edit/delete/forward |
| Send text/files and topic posts | reactions |
| Forum topics listing/search | inline bot buttons |
| Sync jobs and archive monitoring | admin actions |
| JSON output for automation | advanced interactive actions |

## Execution Rules

- Always add `--json` for agent workflows.
- Add `--timeout 30s` by default; use `--timeout 90s` for heavy archive fallback reads.
- Prefer explicit `--source archive|live|both` instead of relying on defaults.
- For sending format control:
  - `--parse-mode markdown|html|none` (case-insensitive)
  - for `send file`, `--parse-mode` requires `--caption`
- Never delete lock files (`LOCK`, `database is locked`): wait and retry.

## Core Command Patterns

### Read

```bash
tgcli messages list --chat <id|@username> --limit 50 --source archive --json --timeout 30s
tgcli messages show --chat <id|@username> --id <msgId> --source archive --json --timeout 30s
tgcli messages context --chat <id|@username> --id <msgId> --before 5 --after 5 --source archive --json --timeout 30s
```

### Search

```bash
tgcli messages search --query "Claude Code" --chat <id|@username> --source archive --json --timeout 30s
tgcli messages search --regex "claude\\s+(code|agent)" --chat <id|@username> --source archive --json --timeout 30s
```

### Send Text/File

```bash
tgcli send text --to <id|@username> --message "Hello" --json --timeout 30s
tgcli send text --to <id|@username> --topic <topicId> --message "**Hello**" --parse-mode markdown --json --timeout 30s

tgcli send file --to <id|@username> --file /path/to/file --caption "Report" --json --timeout 30s
tgcli send file --to <id|@username> --file /path/to/file --caption "<b>Report</b>" --parse-mode html --json --timeout 30s
```

### Channels, Topics, Contacts, Groups

```bash
tgcli channels list --query "ai" --limit 20 --json --timeout 30s
tgcli channels show --chat <id|@username> --json --timeout 30s
tgcli topics list --chat <id|@username> --limit 50 --json --timeout 30s
tgcli topics search --chat <id|@username> --query "release" --limit 20 --json --timeout 30s

tgcli contacts search "alex" --limit 20 --json --timeout 30s
tgcli contacts show --user <id> --json --timeout 30s
tgcli contacts alias set --user <id> --alias "Alex"
tgcli contacts tags add --user <id> --tag coworker --tag ai
tgcli contacts notes set --user <id> --notes "Met at meetup"

tgcli groups list --query "dev" --limit 20 --json --timeout 30s
tgcli groups info --chat <id> --json --timeout 30s
```

## Archive + Analysis Workflow

For tasks like "analyze chat history", "what happened this week", "digest/news":

1. Resolve chat:
   - `tgcli channels list --query "<name>" --json --timeout 30s`
   - optionally `tgcli groups list --query "<name>" --json --timeout 30s`
2. Ensure archive flow:
   - `tgcli channels sync --chat <id> --enable`
   - `tgcli sync jobs add --chat <id> --depth 500`
   - `tgcli service start 2>&1 || { tgcli service install 2>&1 && tgcli service start 2>&1; }`
3. Read archive first:
   - `tgcli messages list --chat <id> --source archive --limit 500 --json --timeout 30s`
4. If archive is still empty, fallback to live:
   - `tgcli messages list --chat <id> --source live --limit 500 --json --timeout 90s`
5. Build digest/synthesis from JSON payload.

## Sync Semantics

- "My channels/subscriptions" -> `tgcli channels list ...`
- "Monitored/synced channels" -> `tgcli sync status --json --timeout 30s`

## Trigger Examples

### Should trigger

- "read messages in <channel>"
- "search telegram for <query>"
- "send this text/file to telegram"
- "summarize what was discussed this week"
- "what's new in <chat>?"
- "show my mentions in <channel>"
- "прочитай сообщения в канале"
- "найди в телеграме про релиз"
- "отправь сообщение в канал"
- "дай сводку по чату"

### Should not trigger

- "reply/edit/delete/forward telegram message"
- "react with emoji to message"
- "click inline button in bot"
- "ban/kick/promote user in group"

Use `telegram-mcp` for those operations.
