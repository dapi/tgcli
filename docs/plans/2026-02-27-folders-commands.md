# Folders Commands Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add full CRUD support for Telegram Chat Folders via `tgcli folders` CLI commands and MCP tools.

**Architecture:** Follow existing command patterns (`groups`/`channels`/`contacts`). Add domain methods to `telegram-client.js`, CLI subcommands to `cli.js`, MCP tools to `mcp-server.js`. Folder resolution by numeric ID or title string.

**Tech Stack:** Node.js ES modules, Commander.js (CLI), Zod (MCP schemas), `@mtcute/core` (Telegram API)

---

### Task 1: Add folder domain methods to telegram-client.js

**Files:**
- Modify: `telegram-client.js:1218` (insert before closing `}` of class, before line 1219 `}`)

**Step 1: Add `getFolders` method**

Insert before line 1219 (`}`) — right after `getTopicMessages` method:

```js
  async getFolders() {
    await this.ensureLogin();
    const result = await this.client.getFolders();
    return result.filters.map((f) => {
      if (f._ === 'dialogFilterDefault') return { id: 0, title: 'All Chats', type: 'default' };
      return {
        id: f.id,
        title: typeof f.title === 'string' ? f.title : f.title.text,
        emoji: f.emoticon ?? null,
        color: f.color ?? null,
        type: f._ === 'dialogFilterChatlist' ? 'chatlist' : 'filter',
        contacts: f.contacts ?? false,
        nonContacts: f.nonContacts ?? false,
        groups: f.groups ?? false,
        broadcasts: f.broadcasts ?? false,
        bots: f.bots ?? false,
        excludeMuted: f.excludeMuted ?? false,
        excludeRead: f.excludeRead ?? false,
        excludeArchived: f.excludeArchived ?? false,
        includePeers: f.includePeers?.length ?? 0,
        excludePeers: f.excludePeers?.length ?? 0,
        pinnedPeers: f.pinnedPeers?.length ?? 0,
      };
    });
  }

  async findFolder(idOrName) {
    await this.ensureLogin();
    const id = Number(idOrName);
    if (!isNaN(id)) return this.client.findFolder({ id });
    return this.client.findFolder({ title: String(idOrName) });
  }

  async showFolder(idOrName) {
    await this.ensureLogin();
    const folder = await this.findFolder(idOrName);
    if (!folder) throw new Error(`Folder not found: ${idOrName}`);
    return {
      id: folder.id,
      title: typeof folder.title === 'string' ? folder.title : folder.title.text,
      emoji: folder.emoticon ?? null,
      color: folder.color ?? null,
      type: folder._ === 'dialogFilterChatlist' ? 'chatlist' : 'filter',
      contacts: folder.contacts ?? false,
      nonContacts: folder.nonContacts ?? false,
      groups: folder.groups ?? false,
      broadcasts: folder.broadcasts ?? false,
      bots: folder.bots ?? false,
      excludeMuted: folder.excludeMuted ?? false,
      excludeRead: folder.excludeRead ?? false,
      excludeArchived: folder.excludeArchived ?? false,
      includePeers: folder.includePeers ?? [],
      excludePeers: folder.excludePeers ?? [],
      pinnedPeers: folder.pinnedPeers ?? [],
    };
  }

  async createFolder(options) {
    await this.ensureLogin();
    const params = { title: options.title };
    if (options.emoji) params.emoticon = options.emoji;
    if (options.contacts) params.contacts = true;
    if (options.nonContacts) params.nonContacts = true;
    if (options.groups) params.groups = true;
    if (options.broadcasts) params.broadcasts = true;
    if (options.bots) params.bots = true;
    if (options.excludeMuted) params.excludeMuted = true;
    if (options.excludeRead) params.excludeRead = true;
    if (options.excludeArchived) params.excludeArchived = true;
    if (options.includePeers?.length) params.includePeers = options.includePeers;
    if (options.excludePeers?.length) params.excludePeers = options.excludePeers;
    if (options.pinnedPeers?.length) params.pinnedPeers = options.pinnedPeers;
    const result = await this.client.createFolder(params);
    return { id: result.id, title: typeof result.title === 'string' ? result.title : result.title.text };
  }

  async editFolder(idOrName, modification) {
    await this.ensureLogin();
    const folder = await this.findFolder(idOrName);
    if (!folder) throw new Error(`Folder not found: ${idOrName}`);
    const mod = {};
    if (modification.title !== undefined) mod.title = modification.title;
    if (modification.emoji !== undefined) mod.emoticon = modification.emoji;
    if (modification.contacts !== undefined) mod.contacts = modification.contacts;
    if (modification.nonContacts !== undefined) mod.nonContacts = modification.nonContacts;
    if (modification.groups !== undefined) mod.groups = modification.groups;
    if (modification.broadcasts !== undefined) mod.broadcasts = modification.broadcasts;
    if (modification.bots !== undefined) mod.bots = modification.bots;
    if (modification.excludeMuted !== undefined) mod.excludeMuted = modification.excludeMuted;
    if (modification.excludeRead !== undefined) mod.excludeRead = modification.excludeRead;
    if (modification.excludeArchived !== undefined) mod.excludeArchived = modification.excludeArchived;
    if (modification.includePeers !== undefined) mod.includePeers = modification.includePeers;
    if (modification.excludePeers !== undefined) mod.excludePeers = modification.excludePeers;
    if (modification.pinnedPeers !== undefined) mod.pinnedPeers = modification.pinnedPeers;
    const result = await this.client.editFolder({ folder, modification: mod });
    return { id: result.id, title: typeof result.title === 'string' ? result.title : result.title.text };
  }

  async deleteFolder(idOrName) {
    await this.ensureLogin();
    const folder = await this.findFolder(idOrName);
    if (!folder) throw new Error(`Folder not found: ${idOrName}`);
    await this.client.deleteFolder(folder.id);
    return { deleted: true, id: folder.id };
  }

  async setFoldersOrder(ids) {
    await this.ensureLogin();
    await this.client.setFoldersOrder(ids.map(Number));
    return { ok: true };
  }

  async addChatToFolder(idOrName, chatId) {
    await this.ensureLogin();
    const folder = await this.findFolder(idOrName);
    if (!folder) throw new Error(`Folder not found: ${idOrName}`);
    const peers = folder.includePeers ? [...folder.includePeers] : [];
    peers.push(chatId);
    await this.client.editFolder({ folder, modification: { includePeers: peers } });
    return { ok: true, folderId: folder.id };
  }

  async removeChatFromFolder(idOrName, chatId) {
    await this.ensureLogin();
    const folder = await this.findFolder(idOrName);
    if (!folder) throw new Error(`Folder not found: ${idOrName}`);
    const chatIdStr = String(chatId);
    const peers = (folder.includePeers ?? []).filter((p) => {
      const peerId = typeof p === 'object' && p !== null
        ? String(p.userId ?? p.channelId ?? p.chatId ?? '')
        : String(p);
      return peerId !== chatIdStr;
    });
    await this.client.editFolder({ folder, modification: { includePeers: peers } });
    return { ok: true, folderId: folder.id };
  }

  async joinChatlist(link) {
    await this.ensureLogin();
    const result = await this.client.joinChatlist(link);
    return {
      id: result.id,
      title: typeof result.title === 'string' ? result.title : result.title.text,
      type: 'chatlist',
    };
  }
```

**Step 2: Verify no syntax errors**

Run: `node -e "import('./telegram-client.js')"`
Expected: No errors (silent exit)

**Step 3: Commit**

```bash
git add telegram-client.js
git commit -m "feat(folders): add folder domain methods to telegram-client"
```

---

### Task 2: Add CLI subcommands to cli.js

**Files:**
- Modify: `cli.js:407` (insert `folders` command block before `disableHelpCommand(program)` at line 408)
- Modify: `cli.js` (append handler functions at end of file, before any final export)

**Step 1: Add folders command group and subcommands**

Insert at line 407 (after `groups.command('leave')` block, before `disableHelpCommand(program)`):

```js
  // --- Folders ---
  const folders = program.command('folders').description('Chat folder management');
  folders
    .command('list')
    .description('List all folders')
    .action(withGlobalOptions((globalFlags) => runFoldersList(globalFlags)));
  folders
    .command('show <folder>')
    .description('Show folder details')
    .action(withGlobalOptions((globalFlags, folder) => runFoldersShow(globalFlags, folder)));
  folders
    .command('create')
    .description('Create a new folder')
    .requiredOption('--title <name>', 'Folder name (max 12 chars)')
    .option('--emoji <emoji>', 'Emoji icon')
    .option('--include-contacts', 'Include contacts')
    .option('--include-non-contacts', 'Include non-contacts')
    .option('--include-groups', 'Include groups')
    .option('--include-channels', 'Include channels')
    .option('--include-bots', 'Include bots')
    .option('--exclude-muted', 'Exclude muted')
    .option('--exclude-read', 'Exclude read')
    .option('--exclude-archived', 'Exclude archived')
    .option('--chat <id>', 'Chat to include (repeatable)', collectOption, [])
    .option('--exclude-chat <id>', 'Chat to exclude (repeatable)', collectOption, [])
    .option('--pin-chat <id>', 'Pin chat in folder (repeatable)', collectOption, [])
    .action(withGlobalOptions((globalFlags, options) => runFoldersCreate(globalFlags, options)));
  folders
    .command('edit <folder>')
    .description('Edit an existing folder')
    .option('--title <name>', 'Folder name (max 12 chars)')
    .option('--emoji <emoji>', 'Emoji icon')
    .option('--include-contacts', 'Include contacts')
    .option('--include-non-contacts', 'Include non-contacts')
    .option('--include-groups', 'Include groups')
    .option('--include-channels', 'Include channels')
    .option('--include-bots', 'Include bots')
    .option('--exclude-muted', 'Exclude muted')
    .option('--exclude-read', 'Exclude read')
    .option('--exclude-archived', 'Exclude archived')
    .option('--chat <id>', 'Chat to include (repeatable)', collectOption, [])
    .option('--exclude-chat <id>', 'Chat to exclude (repeatable)', collectOption, [])
    .option('--pin-chat <id>', 'Pin chat in folder (repeatable)', collectOption, [])
    .action(withGlobalOptions((globalFlags, folder, options) => runFoldersEdit(globalFlags, folder, options)));
  folders
    .command('delete <folder>')
    .description('Delete a folder')
    .action(withGlobalOptions((globalFlags, folder) => runFoldersDelete(globalFlags, folder)));
  folders
    .command('reorder')
    .description('Reorder folders')
    .requiredOption('--ids <id1,id2,...>', 'Comma-separated folder IDs in desired order')
    .action(withGlobalOptions((globalFlags, options) => runFoldersReorder(globalFlags, options)));
  const foldersChats = folders.command('chats').description('Manage chats in a folder');
  foldersChats
    .command('add <folder>')
    .description('Add chat to folder')
    .requiredOption('--chat <chatId>', 'Chat identifier')
    .action(withGlobalOptions((globalFlags, folder, options) => runFoldersChatsAdd(globalFlags, folder, options)));
  foldersChats
    .command('remove <folder>')
    .description('Remove chat from folder')
    .requiredOption('--chat <chatId>', 'Chat identifier')
    .action(withGlobalOptions((globalFlags, folder, options) => runFoldersChatsRemove(globalFlags, folder, options)));
  folders
    .command('join <link>')
    .description('Join shared folder via invite link')
    .action(withGlobalOptions((globalFlags, link) => runFoldersJoin(globalFlags, link)));
```

**Important:** Check if `collectOption` helper exists in cli.js. If not, add it:

```js
function collectOption(value, previous) {
  return previous.concat([value]);
}
```

Search for it: `grep -n 'collectOption' cli.js`. If not found, define it near other helper functions at the top of the file.

**Step 2: Add handler functions**

Append these handler functions. Follow the exact pattern from `runGroupsList` (line 3184): `resolveStoreDir` → `acquireReadLock` → `createServices` → auth check → call domain method → `writeJson`/console → cleanup in `finally`.

```js
async function runFoldersList(globalFlags) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    const storeDir = resolveStoreDir();
    const release = acquireReadLock(storeDir);
    const { telegramClient, messageSyncService } = createServices({ storeDir });
    try {
      if (!(await telegramClient.isAuthorized().catch(() => false))) {
        throw new Error('Not authenticated. Run `tgcli auth` first.');
      }
      const folders = await telegramClient.getFolders();
      if (globalFlags.json) {
        writeJson(folders);
      } else {
        for (const f of folders) {
          console.log(`${f.title} (id=${f.id}, type=${f.type})`);
        }
      }
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
      release();
    }
  }, timeoutMs);
}

async function runFoldersShow(globalFlags, folder) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    const storeDir = resolveStoreDir();
    const release = acquireReadLock(storeDir);
    const { telegramClient, messageSyncService } = createServices({ storeDir });
    try {
      if (!(await telegramClient.isAuthorized().catch(() => false))) {
        throw new Error('Not authenticated. Run `tgcli auth` first.');
      }
      const info = await telegramClient.showFolder(folder);
      if (globalFlags.json) {
        writeJson(info);
      } else {
        console.log(JSON.stringify(info, null, 2));
      }
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
      release();
    }
  }, timeoutMs);
}

async function runFoldersCreate(globalFlags, options) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    const storeDir = resolveStoreDir();
    const release = acquireReadLock(storeDir);
    const { telegramClient, messageSyncService } = createServices({ storeDir });
    try {
      if (!(await telegramClient.isAuthorized().catch(() => false))) {
        throw new Error('Not authenticated. Run `tgcli auth` first.');
      }
      const result = await telegramClient.createFolder({
        title: options.title,
        emoji: options.emoji,
        contacts: options.includeContacts,
        nonContacts: options.includeNonContacts,
        groups: options.includeGroups,
        broadcasts: options.includeChannels,
        bots: options.includeBots,
        excludeMuted: options.excludeMuted,
        excludeRead: options.excludeRead,
        excludeArchived: options.excludeArchived,
        includePeers: options.chat?.length ? options.chat : undefined,
        excludePeers: options.excludeChat?.length ? options.excludeChat : undefined,
        pinnedPeers: options.pinChat?.length ? options.pinChat : undefined,
      });
      if (globalFlags.json) {
        writeJson(result);
      } else {
        console.log(`Created folder: ${result.title} (id=${result.id})`);
      }
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
      release();
    }
  }, timeoutMs);
}

async function runFoldersEdit(globalFlags, folder, options) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    const storeDir = resolveStoreDir();
    const release = acquireReadLock(storeDir);
    const { telegramClient, messageSyncService } = createServices({ storeDir });
    try {
      if (!(await telegramClient.isAuthorized().catch(() => false))) {
        throw new Error('Not authenticated. Run `tgcli auth` first.');
      }
      const modification = {};
      if (options.title !== undefined) modification.title = options.title;
      if (options.emoji !== undefined) modification.emoji = options.emoji;
      if (options.includeContacts) modification.contacts = true;
      if (options.includeNonContacts) modification.nonContacts = true;
      if (options.includeGroups) modification.groups = true;
      if (options.includeChannels) modification.broadcasts = true;
      if (options.includeBots) modification.bots = true;
      if (options.excludeMuted) modification.excludeMuted = true;
      if (options.excludeRead) modification.excludeRead = true;
      if (options.excludeArchived) modification.excludeArchived = true;
      if (options.chat?.length) modification.includePeers = options.chat;
      if (options.excludeChat?.length) modification.excludePeers = options.excludeChat;
      if (options.pinChat?.length) modification.pinnedPeers = options.pinChat;
      const result = await telegramClient.editFolder(folder, modification);
      if (globalFlags.json) {
        writeJson(result);
      } else {
        console.log(`Updated folder: ${result.title} (id=${result.id})`);
      }
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
      release();
    }
  }, timeoutMs);
}

async function runFoldersDelete(globalFlags, folder) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    const storeDir = resolveStoreDir();
    const release = acquireReadLock(storeDir);
    const { telegramClient, messageSyncService } = createServices({ storeDir });
    try {
      if (!(await telegramClient.isAuthorized().catch(() => false))) {
        throw new Error('Not authenticated. Run `tgcli auth` first.');
      }
      const result = await telegramClient.deleteFolder(folder);
      if (globalFlags.json) {
        writeJson(result);
      } else {
        console.log(`Deleted folder id=${result.id}`);
      }
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
      release();
    }
  }, timeoutMs);
}

async function runFoldersReorder(globalFlags, options) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    const storeDir = resolveStoreDir();
    const release = acquireReadLock(storeDir);
    const { telegramClient, messageSyncService } = createServices({ storeDir });
    try {
      if (!(await telegramClient.isAuthorized().catch(() => false))) {
        throw new Error('Not authenticated. Run `tgcli auth` first.');
      }
      const ids = options.ids.split(',').map((s) => Number(s.trim()));
      const result = await telegramClient.setFoldersOrder(ids);
      if (globalFlags.json) {
        writeJson(result);
      } else {
        console.log('Folders reordered');
      }
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
      release();
    }
  }, timeoutMs);
}

async function runFoldersChatsAdd(globalFlags, folder, options) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    if (!options.chat) throw new Error('--chat is required');
    const storeDir = resolveStoreDir();
    const release = acquireReadLock(storeDir);
    const { telegramClient, messageSyncService } = createServices({ storeDir });
    try {
      if (!(await telegramClient.isAuthorized().catch(() => false))) {
        throw new Error('Not authenticated. Run `tgcli auth` first.');
      }
      const result = await telegramClient.addChatToFolder(folder, options.chat);
      if (globalFlags.json) {
        writeJson(result);
      } else {
        console.log(`Chat added to folder id=${result.folderId}`);
      }
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
      release();
    }
  }, timeoutMs);
}

async function runFoldersChatsRemove(globalFlags, folder, options) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    if (!options.chat) throw new Error('--chat is required');
    const storeDir = resolveStoreDir();
    const release = acquireReadLock(storeDir);
    const { telegramClient, messageSyncService } = createServices({ storeDir });
    try {
      if (!(await telegramClient.isAuthorized().catch(() => false))) {
        throw new Error('Not authenticated. Run `tgcli auth` first.');
      }
      const result = await telegramClient.removeChatFromFolder(folder, options.chat);
      if (globalFlags.json) {
        writeJson(result);
      } else {
        console.log(`Chat removed from folder id=${result.folderId}`);
      }
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
      release();
    }
  }, timeoutMs);
}

async function runFoldersJoin(globalFlags, link) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    const storeDir = resolveStoreDir();
    const release = acquireReadLock(storeDir);
    const { telegramClient, messageSyncService } = createServices({ storeDir });
    try {
      if (!(await telegramClient.isAuthorized().catch(() => false))) {
        throw new Error('Not authenticated. Run `tgcli auth` first.');
      }
      const result = await telegramClient.joinChatlist(link);
      if (globalFlags.json) {
        writeJson(result);
      } else {
        console.log(`Joined folder: ${result.title} (id=${result.id})`);
      }
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
      release();
    }
  }, timeoutMs);
}
```

**Step 3: Verify no syntax errors**

Run: `node -e "import('./cli.js')"`
Expected: No errors (silent exit)

**Step 4: Commit**

```bash
git add cli.js
git commit -m "feat(folders): add CLI subcommands for folder management"
```

---

### Task 3: Add MCP tools to mcp-server.js

**Files:**
- Modify: `mcp-server.js:259` (insert Zod schemas after `topicsSearchSchema`)
- Modify: `mcp-server.js:1695` (insert tools before `return server;` at line 1697)

**Step 1: Add Zod schemas**

Insert after line 259 (after `topicsSearchSchema`):

```js
const folderIdOrNameSchema = {
  folder: z
    .union([
      z.number({ invalid_type_error: "folder must be a number" }),
      z.string({ invalid_type_error: "folder must be a string" }).min(1),
    ])
    .describe("Folder ID (numeric) or title (string)"),
};

const createFolderSchema = {
  title: z.string().min(1).max(12).describe("Folder name (max 12 chars)"),
  emoji: z.string().optional().describe("Emoji icon"),
  contacts: z.boolean().optional().describe("Include contacts"),
  nonContacts: z.boolean().optional().describe("Include non-contacts"),
  groups: z.boolean().optional().describe("Include groups"),
  broadcasts: z.boolean().optional().describe("Include channels/broadcasts"),
  bots: z.boolean().optional().describe("Include bots"),
  excludeMuted: z.boolean().optional().describe("Exclude muted chats"),
  excludeRead: z.boolean().optional().describe("Exclude read chats"),
  excludeArchived: z.boolean().optional().describe("Exclude archived chats"),
  includePeers: z.array(z.union([z.number(), z.string()])).optional().describe("Chat IDs to include"),
  excludePeers: z.array(z.union([z.number(), z.string()])).optional().describe("Chat IDs to exclude"),
  pinnedPeers: z.array(z.union([z.number(), z.string()])).optional().describe("Chat IDs to pin"),
};

const editFolderSchema = {
  folder: z
    .union([
      z.number({ invalid_type_error: "folder must be a number" }),
      z.string({ invalid_type_error: "folder must be a string" }).min(1),
    ])
    .describe("Folder ID (numeric) or title (string)"),
  title: z.string().min(1).max(12).optional().describe("New folder name"),
  emoji: z.string().optional().describe("Emoji icon"),
  contacts: z.boolean().optional().describe("Include contacts"),
  nonContacts: z.boolean().optional().describe("Include non-contacts"),
  groups: z.boolean().optional().describe("Include groups"),
  broadcasts: z.boolean().optional().describe("Include channels/broadcasts"),
  bots: z.boolean().optional().describe("Include bots"),
  excludeMuted: z.boolean().optional().describe("Exclude muted chats"),
  excludeRead: z.boolean().optional().describe("Exclude read chats"),
  excludeArchived: z.boolean().optional().describe("Exclude archived chats"),
  includePeers: z.array(z.union([z.number(), z.string()])).optional().describe("Chat IDs to include"),
  excludePeers: z.array(z.union([z.number(), z.string()])).optional().describe("Chat IDs to exclude"),
  pinnedPeers: z.array(z.union([z.number(), z.string()])).optional().describe("Chat IDs to pin"),
};

const reorderFoldersSchema = {
  ids: z.array(z.number().int()).min(1).describe("Folder IDs in desired order"),
};

const folderChatSchema = {
  folder: z
    .union([
      z.number({ invalid_type_error: "folder must be a number" }),
      z.string({ invalid_type_error: "folder must be a string" }).min(1),
    ])
    .describe("Folder ID (numeric) or title (string)"),
  chatId: z
    .union([
      z.number({ invalid_type_error: "chatId must be a number" }),
      z.string({ invalid_type_error: "chatId must be a string" }).min(1),
    ])
    .describe("Chat ID to add/remove"),
};

const joinChatlistSchema = {
  link: z.string().min(1).describe("Shared folder invite link"),
};
```

**Step 2: Add tool registrations**

Insert before `return server;` (line 1697):

```js
  // --- Folder tools ---

  server.tool(
    "listFolders",
    "Lists all Telegram chat folders for the authenticated account.",
    {},
    async () => {
      await telegramClient.ensureLogin();
      const folders = await telegramClient.getFolders();
      return {
        content: [{ type: "text", text: JSON.stringify(folders, null, 2) }],
      };
    },
  );

  server.tool(
    "showFolder",
    "Shows detailed information about a specific chat folder.",
    folderIdOrNameSchema,
    async ({ folder }) => {
      await telegramClient.ensureLogin();
      const info = await telegramClient.showFolder(folder);
      return {
        content: [{ type: "text", text: JSON.stringify(info, null, 2) }],
      };
    },
  );

  server.tool(
    "createFolder",
    "Creates a new Telegram chat folder with specified filters and peers.",
    createFolderSchema,
    async (params) => {
      await telegramClient.ensureLogin();
      const result = await telegramClient.createFolder(params);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.tool(
    "editFolder",
    "Edits an existing Telegram chat folder.",
    editFolderSchema,
    async ({ folder, ...modification }) => {
      await telegramClient.ensureLogin();
      const result = await telegramClient.editFolder(folder, modification);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.tool(
    "deleteFolder",
    "Deletes a Telegram chat folder.",
    folderIdOrNameSchema,
    async ({ folder }) => {
      await telegramClient.ensureLogin();
      const result = await telegramClient.deleteFolder(folder);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.tool(
    "reorderFolders",
    "Reorders Telegram chat folders.",
    reorderFoldersSchema,
    async ({ ids }) => {
      await telegramClient.ensureLogin();
      const result = await telegramClient.setFoldersOrder(ids);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.tool(
    "addChatToFolder",
    "Adds a chat to a Telegram chat folder.",
    folderChatSchema,
    async ({ folder, chatId }) => {
      await telegramClient.ensureLogin();
      const result = await telegramClient.addChatToFolder(folder, chatId);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.tool(
    "removeChatFromFolder",
    "Removes a chat from a Telegram chat folder.",
    folderChatSchema,
    async ({ folder, chatId }) => {
      await telegramClient.ensureLogin();
      const result = await telegramClient.removeChatFromFolder(folder, chatId);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.tool(
    "joinChatlist",
    "Joins a shared Telegram chat folder via invite link.",
    joinChatlistSchema,
    async ({ link }) => {
      await telegramClient.ensureLogin();
      const result = await telegramClient.joinChatlist(link);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  );
```

**Step 3: Verify no syntax errors**

Run: `node -e "import('./mcp-server.js')"`
Expected: No errors (silent exit)

**Step 4: Commit**

```bash
git add mcp-server.js
git commit -m "feat(folders): add MCP tools for folder management"
```

---

### Task 4: Smoke test all CLI commands

**Step 1: Test help output**

Run: `node cli.js folders --help`
Expected: Shows `folders` subcommands (list, show, create, edit, delete, reorder, chats, join)

**Step 2: Test folders list**

Run: `node cli.js folders list --json --timeout 30s`
Expected: JSON array of folders with id, title, type fields

**Step 3: Test folders create + show + delete cycle**

```bash
node cli.js folders create --title "Test" --emoji "🧪" --json --timeout 30s
# Note the id from output
node cli.js folders show <id> --json --timeout 30s
node cli.js folders delete <id> --json --timeout 30s
```

Expected: Each returns valid JSON; create returns `{id, title}`, show returns detailed info, delete returns `{deleted: true, id: ...}`

**Step 4: Fix any issues found**

If any command fails, debug and fix. Re-run the failing test.

**Step 5: Commit any fixes**

```bash
git add -A
git commit -m "fix(folders): address smoke test findings"
```

---

### Task 5: Update tgcli skill documentation

**Files:**
- Modify: `/home/danil/.neovate/skills/tgcli/SKILL.md`
- Modify: `/home/danil/.config/crush/skills/tgcli/SKILL.md` (mirror)
- Modify: `docs/mcp-tools.md` (add folder MCP tools)

**Step 1: Add Folders section to SKILL.md**

Find the appropriate section in SKILL.md (after Groups or Contacts section) and add:

```markdown
### Folders

```bash
tgcli folders list --json --timeout 30s
tgcli folders show <id|name> --json --timeout 30s
tgcli folders create --title "AI channels" --emoji "🤖" --include-channels --json --timeout 30s
tgcli folders edit <id|name> --title "New name" --json --timeout 30s
tgcli folders delete <id|name> --json --timeout 30s
tgcli folders reorder --ids 1,2,3 --json --timeout 30s
tgcli folders chats add <id|name> --chat <chatId> --json --timeout 30s
tgcli folders chats remove <id|name> --chat <chatId> --json --timeout 30s
tgcli folders join <invite-link> --json --timeout 30s
```
```

**Step 2: Copy same changes to mirror location**

Ensure `/home/danil/.config/crush/skills/tgcli/SKILL.md` has the same content.

**Step 3: Update docs/mcp-tools.md**

Add folder MCP tools section: `listFolders`, `showFolder`, `createFolder`, `editFolder`, `deleteFolder`, `reorderFolders`, `addChatToFolder`, `removeChatFromFolder`, `joinChatlist`.

**Step 4: Update skill description frontmatter**

Update the `description` field in SKILL.md to mention folders:

```yaml
description: >
  Use when user wants to read/search/send/analyze Telegram messages via tgcli CLI.
  Trigger on requests about channel/chat history, digests/news, mentions, files, topics,
  contacts, groups, folders, tags, media downloads, and archive/sync status.
  Also covers group admin (rename, members, invite links, join/leave) and folder management (CRUD, shared folders).
  For reply/edit/delete/reactions/inline buttons, use telegram-mcp instead.
```

**Step 5: Commit**

```bash
git add docs/mcp-tools.md
git commit -m "docs(folders): update skill docs and MCP tools documentation"
```
