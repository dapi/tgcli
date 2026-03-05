# tgcli

Telegram CLI with background sync and an optional MCP server for your personal account (MTProto, not bot API).

## Quick Install (CLI + Skill)

One command to install or update both the CLI and the AI agent skill:

```bash
curl -fsSL https://raw.githubusercontent.com/dapi/tgcli/main/install.sh | bash
```

### Manual Installation

Install CLI only:

```bash
npm install -g @dapi/tgcli
```

Install skill for AI agents:

```bash
npx skills add dapi/tgcli --skill tgcli --agent '*' -g -y
```

Restart your agent session after skill installation so the new skill is picked up.

## Using the Skill

After installation, ask your agent to perform Telegram tasks via `tgcli`, for example:

```text
List last 20 messages from @channel
Search messages in @channel for "invoice"
Send a message to @username with markdown parse mode
Send ./report.pdf to @channel with HTML caption
```

## Authentication

Get Telegram API credentials:
1. Go to https://my.telegram.org/apps
2. Log in with your phone number
3. Create a new application
4. Copy `api_id` and `api_hash`

Then authenticate:

```bash
tgcli auth
```

## Quick start

```bash
tgcli auth
tgcli sync --follow
tgcli messages list --chat @username --limit 20
tgcli messages search "course" --chat @channel --source archive
tgcli send text --to @username --message "hello"
tgcli send text --to @username --message "**hi**" --parse-mode markdown
tgcli send text --to @username --message "done" --reply-to 123
tgcli send file --to @channel --file ./report.pdf --caption "<b>weekly report</b>" --parse-mode html
tgcli send file --to @channel --file ./report.pdf --reply-to 123
tgcli server
```

## Commands

```bash
tgcli auth           Authentication and session setup
tgcli config         View and edit config
tgcli sync           Archive backfill and realtime sync
tgcli server         Run background sync service (MCP optional)
tgcli service        Install/start/stop/status/logs for background service
tgcli channels       List/search channels
tgcli messages       List/search messages
tgcli send           Send text or files
tgcli media          Download media
tgcli topics         Forum topics
tgcli tags           Channel tags
tgcli metadata       Channel metadata cache
tgcli contacts       Contacts and people
tgcli groups         Group management
tgcli doctor         Diagnostics and sanity checks
```

Use `tgcli [command] --help` for details. Add `--json` for machine-readable output.

### send text

Send a text message to a user, group, or channel.

| Flag | Description |
|-|-|
| `--to` | Recipient: `@username`, phone number, or chat ID |
| `--message` | Message body |
| `--parse-mode` | `markdown`, `html`, or `none` (default: plain text) |
| `--reply-to` | Message ID to reply to |

The `markdown` mode uses **mtcute's own Markdown dialect**, which differs from
Telegram Bot API MarkdownV2. See [mtcute docs](https://mtcute.dev/guide/topics/parsers.html)
for the supported syntax.

```bash
# Markdown (mtcute dialect, not Bot API MarkdownV2)
tgcli send text --to @username --message "Check [this link](https://example.com)" --parse-mode markdown

# HTML
tgcli send text --to @username --message "Check <a href='https://example.com'>this link</a>" --parse-mode html

# Plain text (default)
tgcli send text --to @username --message "Hello world"
```

## MCP (optional)

Enable it via config:

```bash
tgcli config set mcp.enabled true
```

By default the server binds to `http://127.0.0.1:8080/mcp`. To change it:

```bash
tgcli config set mcp.host 127.0.0.1
tgcli config set mcp.port 8080
```

Then run `tgcli server` and point your client at the configured address.

## Configuration & Store

The tgcli store lives in the OS app-data directory and contains `config.json`, sessions, and `messages.db`.
Override the location with `TGCLI_STORE`.

Legacy version: see `MIGRATION.md`.
