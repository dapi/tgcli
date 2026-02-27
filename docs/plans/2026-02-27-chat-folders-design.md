# Chat Folders (Dialog Filters) — Design

GitHub Issue: https://github.com/kfastov/tgcli/issues/15

## Commands

```
tgcli folders list                          # List all folders
tgcli folders show <id|name>                # Folder details (chats, filters)
tgcli folders create --title <name>         # Create folder
tgcli folders edit <id|name>                # Edit folder
tgcli folders delete <id|name>              # Delete folder
tgcli folders reorder --ids <id1,id2,...>   # Reorder folders
tgcli folders chats add <id|name> --chat <chatId>    # Add chat to folder
tgcli folders chats remove <id|name> --chat <chatId> # Remove chat from folder
tgcli folders join <invite-link>            # Join shared folder via chatlist link
```

## Create/Edit Options

| Flag | Description |
|-|-|
| `--title` | Folder name (max 12 chars) |
| `--emoji` | Emoji icon |
| `--include-contacts` | Include contacts |
| `--include-non-contacts` | Include non-contacts |
| `--include-groups` | Include groups |
| `--include-channels` | Include channels |
| `--include-bots` | Include bots |
| `--exclude-muted` | Exclude muted |
| `--exclude-read` | Exclude read |
| `--exclude-archived` | Exclude archived |
| `--chat` | Chat to include (repeatable) |
| `--exclude-chat` | Chat to exclude (repeatable) |
| `--pin-chat` | Pin chat in folder |

## Implementation Layers

### 1. telegram-client.js

Wrapper methods over `@mtcute/core` highlevel API:

- `getFolders()` — calls `client.getFolders()`, returns array of folder objects
- `findFolder(idOrName)` — calls `client.findFolder()` by id (number) or title (string)
- `createFolder(options)` — calls `client.createFolder()` with title, emoji, filter flags, peer lists
- `editFolder(idOrName, options)` — calls `client.editFolder()` with merged changes
- `deleteFolder(idOrName)` — calls `client.deleteFolder()`
- `setFoldersOrder(ids)` — calls `client.setFoldersOrder()`
- `addChatToFolder(folderId, chatId)` — fetches folder, appends peer to includePeers, calls editFolder
- `removeChatFromFolder(folderId, chatId)` — fetches folder, removes peer from includePeers, calls editFolder
- `joinChatlist(link)` — calls `client.joinChatlist()` with invite link

Folder resolution: if argument is a number — lookup by id; if string — lookup by title match.

### 2. cli.js

Commander subcommands under `program.command('folders')`. Pattern matches existing `channels`/`groups`/`contacts`. Each subcommand calls the corresponding telegram-client method and formats output for `--json` or human-readable.

### 3. mcp-server.js

MCP tools registered alongside existing ones:
- `listFolders`, `showFolder`, `createFolder`, `editFolder`, `deleteFolder`
- `reorderFolders`, `addChatToFolder`, `removeChatFromFolder`, `joinChatlist`

## Technical Notes

- All mtcute methods already exist in `@mtcute/core/highlevel/methods/dialogs/`
- `show` command resolves included/excluded/pinned peers to display human-readable chat names
- Listing chats inside a folder is slow due to Telegram API limitation (fetches all dialogs, filters locally)
- `RawDialogFilterChatlist` type represents shared folders with `hasMyInvites` flag
- Folder title max length: 12 characters (Telegram limit)
- `RawDialogFilterDefault` represents the default "All Chats" folder (no id/filters)
