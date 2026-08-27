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

`tgcli auth` only establishes or refreshes the Telegram session. Archive seeding and realtime sync are separate:

```bash
tgcli sync --once
# or
tgcli sync --follow
```

If confirmation codes in-app do not arrive, you can use QR login:

```bash
tgcli auth --qr
```

Other auth variants:

```bash
# Ask Telegram to resend code via SMS (when available)
tgcli auth --force-sms

# Verbose MTProto logs for troubleshooting auth
MTCUTE_LOG_LEVEL=5 tgcli auth

# Verbose logs with QR flow
MTCUTE_LOG_LEVEL=5 tgcli auth --qr
```

## Multiple accounts

The account used without `--account` remains the `default` account in the
legacy tgcli store. Adding another profile does not move, rewrite, or log out
that session.

```bash
# Register an isolated profile. This does not contact Telegram yet.
tgcli accounts add work --phone "+7 707 111 22 33" --alias office

# Authenticate and use only that profile.
tgcli --account work auth
tgcli --account office auth status
tgcli --account +77071112233 messages search "invoice"

# Environment selection is also supported.
TGCLI_ACCOUNT=work tgcli sync --follow

tgcli accounts list --json
```

Named profiles use separate `config.json`, `session.json`, `messages.db`,
downloads, locks, sync jobs, and service state under
`<default-store>/accounts/<id>/`. After login tgcli binds the profile to the
authenticated Telegram user ID. Every authorization check verifies both the
configured phone and that immutable user ID; a crossed or copied session fails
closed instead of changing the profile.

Background services are isolated too. The default account keeps the legacy
service name, while named accounts use labels such as
`com.dapi.tgcli.work` (launchd) or `tgcli-work` (systemd) and separate logs.

## Quick start

```bash
tgcli auth
tgcli sync --follow
tgcli messages list --chat @username --limit 20
tgcli messages search "course" --chat @channel --source archive
tgcli send text --to @username --message "hello"
tgcli send text --to @username --message "**hi**" --parse-mode markdown
tgcli send text --to @username --message "done" --reply-to 123
tgcli send photo --to @channel --photo ./screenshot.png --caption "UI diff" --json --timeout 30s
tgcli send file --to @channel --file ./report.pdf --caption "<b>weekly report</b>" --parse-mode html
tgcli send file --to @channel --file ./report.pdf --reply-to 123
tgcli groups requests list --chat @group --json --timeout 30s
tgcli server
```

## Commands

```bash
tgcli auth           Authentication and session setup
tgcli accounts       Manage isolated Telegram account profiles
tgcli config         View and edit config
tgcli sync           Archive backfill and realtime sync
tgcli server         Run background sync service (MCP optional)
tgcli service        Install/start/stop/status/logs for background service
tgcli channels       List/search channels
tgcli messages       List/search messages
tgcli send           Send text, photos, or files
tgcli media          Download media
tgcli topics         Forum topics
tgcli tags           Channel tags
tgcli metadata       Channel metadata cache
tgcli contacts       Contacts and people
tgcli groups         Group management
tgcli doctor         Diagnostics and sanity checks
```

Use `tgcli [command] --help` for details. Add `--json` for machine-readable output.
Select a profile with the global `--account <id|alias|phone>` option.

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

# Explicit plain text (same as default)
tgcli send text --to @username --message "Hello world" --parse-mode none

# Plain text (default, no flag)
tgcli send text --to @username --message "Hello world"
```

### send photo

Send a local image as a Telegram photo preview with optional retries for transient transport failures.

| Flag | Description |
|-|-|
| `--to` | Recipient: `@username`, phone number, or chat ID |
| `--photo` | Local image path |
| `--caption` | Optional caption |
| `--parse-mode` | `markdown`, `html`, or `none` for caption text |
| `--reply-to` | Message ID to reply to |
| `--topic` | Forum topic ID |
| `--silent` | Send without notification |
| `--no-forwards` | Prevent forwarding |
| `--caption-above` | Place caption above photo |
| `--spoiler` | Mark photo as spoiler |
| `--schedule` | Schedule send (e.g. `2025-01-01T12:00:00`) |
| `--retries` | Retry count for transient network/transport failures (default: `2`) |
| `--retry-backoff` | Backoff in milliseconds or strategy: `constant`, `linear`, `exponential` |

```bash
tgcli send photo --to @channel --photo ./table.png --caption "Comparison" --json --timeout 30s
tgcli send photo --to @channel --photo ./screenshot.png --caption "**Build**" --parse-mode markdown --reply-to 123
tgcli send photo --to @channel --photo ./chart.jpg --caption "Daily chart" --silent --no-forwards --spoiler
tgcli send photo --to @channel --photo ./diff.png --retries 3 --retry-backoff exponential --json
```

`tgcli send photo` returns structured JSON on success/failure in `--json` mode, including `method`, `message_id`, attempt count, and best-effort `media.file_id`.

### send file

Use `send file` for generic uploads and document-style media. If you need Telegram photo preview rendering for local PNG/JPG, prefer `send photo`.

### group join requests

Administrators can list, approve, and decline pending join requests using the
authenticated MTProto user account:

```bash
tgcli groups requests list --chat @group --limit 100 --json --timeout 30s
tgcli groups requests list --chat @group --query "Alice" --json --timeout 30s
tgcli groups requests list --chat @group --link "https://t.me/+invite" --json --timeout 30s
tgcli groups requests approve --chat @group --user 123456789 --json --timeout 30s
tgcli groups requests decline --chat @group --user 123456789 --json --timeout 30s
```

`--query` and `--link` are mutually exclusive. These commands require group
administrator permissions that allow managing invite requests. Approval and
decline operate on one user at a time; tgcli intentionally has no bulk command.

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

### Telegram proxy

Telegram traffic can be routed through a SOCKS5, HTTP, or MTProto proxy. The
setting applies to authentication, live requests, and background sync:

```bash
# Global fallback for every account profile
printf '%s\n' 'proxy=socks5://127.0.0.1:1080' > ~/.tgclirc
chmod 600 ~/.tgclirc

# Existing SSH SOCKS5 tunnel through voldar
tgcli config set proxy socks5://127.0.0.1:1080

# Remove the proxy and connect directly again
tgcli config unset proxy
```

Supported URL formats include `socks5://host:port`,
`socks5://user:password@host:port`, `http://host:port`, and Telegram MTProto
proxy URLs such as `https://t.me/proxy?server=...&port=443&secret=...`.

The proxy is optional; when it is unset, tgcli connects directly to Telegram.
Effective proxy precedence is `TELEGRAM_PROXY`, then the selected profile's
`config.json`, then the global `~/.tgclirc`. The rc file uses `key=value`
syntax, ignores blank lines and `#` comments, and is especially useful when all
isolated account profiles must share one proxy.

## Configuration & Store

The tgcli store lives in the OS app-data directory and contains `config.json`, sessions, and `messages.db`.
Override the base/default location with `TGCLI_STORE`. Named accounts remain
under that base store's `accounts/` directory unless a generated background
service pins their resolved store directly.

`~/.tgclirc` contains global fallback defaults outside any store. Keep it mode
`0600` when the proxy URL contains credentials.

Legacy version: see `MIGRATION.md`.
