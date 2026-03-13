# Design: folders show — resolve peer IDs to names

**Issue:** https://github.com/dapi/tgcli/issues/19
**Date:** 2026-03-13
**Status:** Approved

## Problem

`tgcli folders show AI --json` returns `includePeers` as raw `inputPeerChannel`/`inputPeerUser` objects with numeric IDs and accessHash. Impossible to understand which channels/chats/users belong to a folder without manual resolution.

## Solution

Add `--resolve` flag to `folders show` that resolves peer IDs to readable names.

### Approach: Resolve in showFolder (approach A)

Minimal changes, uses existing `getPeerMetadata()` pattern infrastructure.

## Scope

### In scope
- `telegram-client.js`: `_normalizePeer()`, `_resolvePeerName()`, updated `showFolder(idOrName, { resolve })`
- `cli.js`: `--resolve` flag in `folders show`, updated text output
- `SKILL.md`: Folders section with `folders show --resolve` documentation
- Tests for `_normalizePeer()` and `showFolder`

### Out of scope
- MCP server (`mcp-server.js`) — separate issue
- Caching peer names
- Batch API resolution

## Design

### Domain layer (`telegram-client.js`)

#### `showFolder(idOrName, options = {})`

Add `options.resolve` parameter (default: false).

**Without resolve (default):** each peer in `includePeers`/`excludePeers`/`pinnedPeers` is normalized from raw MTCute object to:
```js
{ type: "channel"|"user"|"chat", id: Number }
```

Uses `_extractPeerId()` + type detection (`userId` → user, `channelId` → channel, `chatId` → chat). Fast, no API calls.

**With resolve:** additionally calls lightweight `getChat()`/`getFullUser()` (NOT `getFullChat`) for each peer and adds `title`/`name` field:
```js
{ type: "channel", id: -1001951583351, title: "ИИшница" }
{ type: "user", id: 272066824, name: "Иван Иванов" }
```

#### New private methods

- `_normalizePeer(peer)` — extracts type + id from raw MTCute peer object
- `_resolvePeerName(type, id)` — lightweight name resolution via `getChat()`/`getFullUser()` only

### CLI layer (`cli.js`)

#### Flag `--resolve`

Boolean option on `folders show` command (default: false). Passed to `telegramClient.showFolder(folder, { resolve })`.

#### Text output without `--resolve`

```
AI (id=38, type=filter)
  emoji: 🤖
  includes: groups, broadcasts
  includePeers:
    - channel:-1001951583351
    - channel:-1002273349814
    - user:272066824
  excludePeers: (none)
  pinnedPeers: (none)
```

#### Text output with `--resolve`

```
AI (id=38, type=filter)
  emoji: 🤖
  includes: groups, broadcasts
  channels:
    - ИИшница (-1001951583351)
    - Refat Talks: Tech & AI (-1002273349814)
  users:
    - Иван Иванов (272066824)
```

#### JSON output

Always contains normalized peers (not raw). With `--resolve` adds `title`/`name` fields.

### Error handling

- If a peer cannot be resolved (deleted channel, banned user, no access): don't fail the command
- Show `{ type: "channel", id: -100..., title: "(unresolved)" }`
- In text output: `- (unresolved) (-100...)`
- Empty peer lists: `(none)` in text, `[]` in JSON

### SKILL.md

Add Folders section documenting:
```bash
tgcli folders list --json --timeout 30s
tgcli folders show <name|id> --json --timeout 30s
tgcli folders show <name|id> --resolve --json --timeout 30s
```
