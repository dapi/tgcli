# Plan: ship tgcli CLI + server

## Goals
- Single CLI + MCP server product with one name, one install path.
- Default store in OS app-data directory; override only via TGCLI_STORE.
- Simple happy path: tgcli auth -> tgcli sync --follow -> tgcli server.
- NPM + Homebrew distribution with clear migration notes.

## Work plan
1) Rename project to tgcli
   - Replace frogiverse with tgcli across CLI/help/logs/docs.
   - Update package.json (name, bin) and environment variable names.

2) Default store
   - Use OS app data dir:
     - macOS: ~/Library/Application Support/tgcli
     - Linux: $XDG_DATA_HOME/tgcli or ~/.local/share/tgcli
     - Windows: %APPDATA%\\tgcli
   - Remove ./data default; keep TGCLI_STORE override only.
   - Ensure server + CLI use the same store resolver.

3) Package CLI for global install
   - cli.js shebang + executable, bin mapping to tgcli.
   - Ensure package files include runtime modules.
   - Update README to prefer npm i -g and brew install.

4) Happy-path commands
   - tgcli auth (interactive, saves session/config).
   - tgcli sync --follow.
   - tgcli server (MCP endpoint).
   - Keep doctor as diagnostics, not a required first step.

5) Docs + release
   - README: Install/Auth/Run sections.
   - MIGRATION.md for v2 (tool names + new store location).

6) Publish
   - Tag last v1.x on main.
   - Release v2.0.0 on plan-mcp-cli (breaking).
   - Publish scoped npm package.

7) Homebrew tap
   - Create dapi/homebrew-tap.
   - Add tgcli.rb formula (depends_on "node") that installs npm package.

## Notes
- Skip tool deprecation aliases for v2.
