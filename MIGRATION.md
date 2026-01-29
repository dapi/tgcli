# Migration Guide: v1.x -> v2.0.0

This guide covers the breaking changes when moving from the legacy frogiverse builds to tgcli v2.

## CLI rename
- Old command: `frogiverse`
- New command: `tgcli`
- npm package: `@kfastov/tgcli`

## Store location
- Default store moved from `./data` to the OS app-data directory:
  - macOS: `~/Library/Application Support/tgcli`
  - Linux: `$XDG_DATA_HOME/tgcli` (fallback `~/.local/share/tgcli`)
  - Windows: `%APPDATA%\\tgcli`
- Override with `TGCLI_STORE`.
- The `--store` CLI flag is removed. Use `TGCLI_STORE` instead.

## Credentials storage
- Telegram credentials now live in `config.json` inside the tgcli store.
- `.env` loading is removed; use `tgcli auth` to set credentials.

If you have an existing `./data` store, you can either:
- Move it into the new tgcli store directory, or
- Keep it in place and set `TGCLI_STORE=./data`.

## MCP tool surface
Legacy message tools were removed in favor of a unified interface:
- Use `messagesList`, `messagesSearch`, `messagesGet`, `messagesContext`.
- Select archive/live sources with `source=archive|live|both`.

See `docs/mcp-tools.md` for the full current tool list.

## Server startup
- Recommended: `tgcli server` (new CLI command).
- `npm start` still works for local development.
