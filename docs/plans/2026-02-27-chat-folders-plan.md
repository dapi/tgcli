# Chat Folders Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add full CRUD commands for Telegram Chat Folders (`tgcli folders`) including shared folder support.

**Architecture:** Three-layer approach matching existing patterns: domain methods in `telegram-client.js`, CLI subcommands in `cli.js`, MCP tools in `mcp-server.js`. All folder operations wrap `@mtcute/core` highlevel methods.

**Tech Stack:** `@mtcute/core` (MTProto), `commander` (CLI), `@modelcontextprotocol/sdk` (MCP), `zod` (MCP schemas)

**GitHub Issue:** https://github.com/kfastov/tgcli/issues/15

---

### Task 1: Add folder domain methods to telegram-client.js

**Files:**
- Modify: `telegram-client.js` (add methods after existing `listForumTopics` at ~line 1196)

**Step 1: Add `getFolders` method**

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
```

**Step 2: Add `findFolder` method**

```js
  async findFolder(idOrName) {
    await this.ensureLogin();
    const id = Number(idOrName);
    if (!isNaN(id)) {
      return this.client.findFolder({ id });
    }
    return this.client.findFolder({ title: String(idOrName) });
  }
```

**Step 3: Add `showFolder` method** (returns raw filter with resolved peer names)

```js
  async showFolder(idOrName) {
    await this.ensureLogin();
    const folder = await this.findFolder(idOrName);
    if (!folder) throw new Error(`Folder not found: ${idOrName}`);
    const result = {
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
    return result;
  }
```

**Step 4: Add `createFolder` method**

```js
  async createFolder(options) {
    await this.ensureLogin();
    const folderParams = {
      title: options.title,
    };
    if (options.emoji) folderParams.emoticon = options.emoji;
    if (options.contacts) folderParams.contacts = true;
    if (options.nonContacts) folderParams.nonContacts = true;
    if (options.groups) folderParams.groups = true;
    if (options.broadcasts) folderParams.broadcasts = true;
    if (options.bots) folderParams.bots = true;
    if (options.excludeMuted) folderParams.excludeMuted = true;
    if (options.excludeRead) folderParams.excludeRead = true;
    if (options.excludeArchived) folderParams.excludeArchived = true;
    if (options.includePeers?.length) folderParams.includePeers = options.includePeers;
    if (options.excludePeers?.length) folderParams.excludePeers = options.excludePeers;
    if (options.pinnedPeers?.length) folderParams.pinnedPeers = options.pinnedPeers;
    const result = await this.client.createFolder(folderParams);
    return {
      id: result.id,
      title: typeof result.title === 'string' ? result.title : result.title.text,
    };
  }
```

**Step 5: Add `editFolder`, `deleteFolder`, `setFoldersOrder`, `addChatToFolder`, `removeChatFromFolder`, `joinChatlist`**

```js
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
    return {
      id: result.id,
      title: typeof result.title === 'string' ? result.title : result.title.text,
    };
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
      const peerId = typeof p === 'object' && p !== null ? String(p.userId ?? p.channelId ?? p.chatId ?? '') : String(p);
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

**Step 6: Smoke-test**

Run: `node cli.js auth status --json` to verify module loads without syntax errors.

**Step 7: Commit**

```bash
git add telegram-client.js
git commit -m "feat(folders): add folder domain methods to telegram-client"
```

---

### Task 2: Add CLI subcommands in cli.js

**Files:**
- Modify: `cli.js` (insert `folders` block before `disableHelpCommand(program)` at ~line 408)

**Step 1: Add `folders` command group with `list` and `show`**

Insert before line 408 (`disableHelpCommand(program)`):

```js
  const folders = program.command('folders').description('Chat folder management');
  folders
    .command('list')
    .description('List all folders')
    .action(withGlobalOptions((globalFlags) => runFoldersList(globalFlags)));
  folders
    .command('show')
    .description('Show folder details')
    .argument('<folder>', 'Folder ID or title')
    .action(withGlobalOptions((globalFlags, folder) => runFoldersShow(globalFlags, folder)));
  folders
    .command('create')
    .description('Create a new folder')
    .option('--title <name>', 'Folder title (max 12 chars)')
    .option('--emoji <emoji>', 'Folder emoji icon')
    .option('--include-contacts', 'Include contacts')
    .option('--include-non-contacts', 'Include non-contacts')
    .option('--include-groups', 'Include groups')
    .option('--include-channels', 'Include channels')
    .option('--include-bots', 'Include bots')
    .option('--exclude-muted', 'Exclude muted chats')
    .option('--exclude-read', 'Exclude read chats')
    .option('--exclude-archived', 'Exclude archived chats')
    .option('--chat <id|username>', 'Chat to include (repeatable)', collectList)
    .option('--exclude-chat <id|username>', 'Chat to exclude (repeatable)', collectList)
    .option('--pin-chat <id|username>', 'Chat to pin (repeatable)', collectList)
    .action(withGlobalOptions((globalFlags, options) => runFoldersCreate(globalFlags, options)));
  folders
    .command('edit')
    .description('Edit a folder')
    .argument('<folder>', 'Folder ID or title')
    .option('--title <name>', 'New title')
    .option('--emoji <emoji>', 'New emoji icon')
    .option('--include-contacts', 'Include contacts')
    .option('--include-non-contacts', 'Include non-contacts')
    .option('--include-groups', 'Include groups')
    .option('--include-channels', 'Include channels')
    .option('--include-bots', 'Include bots')
    .option('--exclude-muted', 'Exclude muted chats')
    .option('--exclude-read', 'Exclude read chats')
    .option('--exclude-archived', 'Exclude archived chats')
    .option('--chat <id|username>', 'Chat to include (repeatable)', collectList)
    .option('--exclude-chat <id|username>', 'Chat to exclude (repeatable)', collectList)
    .option('--pin-chat <id|username>', 'Chat to pin (repeatable)', collectList)
    .action(withGlobalOptions((globalFlags, folder, options) => runFoldersEdit(globalFlags, folder, options)));
  folders
    .command('delete')
    .description('Delete a folder')
    .argument('<folder>', 'Folder ID or title')
    .action(withGlobalOptions((globalFlags, folder) => runFoldersDelete(globalFlags, folder)));
  folders
    .command('reorder')
    .description('Reorder folders')
    .option('--ids <id1,id2,...>', 'Comma-separated folder IDs in desired order')
    .action(withGlobalOptions((globalFlags, options) => runFoldersReorder(globalFlags, options)));
  folders
    .command('join')
    .description('Join a shared folder via invite link')
    .argument('<link>', 'Chatlist invite link')
    .action(withGlobalOptions((globalFlags, link) => runFoldersJoin(globalFlags, link)));
  const folderChats = folders.command('chats').description('Manage chats in a folder');
  folderChats
    .command('add')
    .description('Add chat to folder')
    .argument('<folder>', 'Folder ID or title')
    .option('--chat <id|username>', 'Chat to add (repeatable)', collectList)
    .action(withGlobalOptions((globalFlags, folder, options) => runFolderChatsAdd(globalFlags, folder, options)));
  folderChats
    .command('remove')
    .description('Remove chat from folder')
    .argument('<folder>', 'Folder ID or title')
    .option('--chat <id|username>', 'Chat to remove (repeatable)', collectList)
    .action(withGlobalOptions((globalFlags, folder, options) => runFolderChatsRemove(globalFlags, folder, options)));
```

**Step 2: Add handler functions**

Add after existing handler functions (before the utility section):

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
          const emoji = f.emoji ? `${f.emoji} ` : '';
          console.log(`${emoji}${f.title} (id=${f.id}, type=${f.type})`);
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

async function runFoldersCreate(globalFlags, options = {}) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    if (!options.title) throw new Error('--title is required');
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
        includePeers: options.chat,
        excludePeers: options.excludeChat,
        pinnedPeers: options.pinChat,
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

async function runFoldersEdit(globalFlags, folder, options = {}) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    const storeDir = resolveStoreDir();
    const release = acquireReadLock(storeDir);
    const { telegramClient, messageSyncService } = createServices({ storeDir });
    try {
      if (!(await telegramClient.isAuthorized().catch(() => false))) {
        throw new Error('Not authenticated. Run `tgcli auth` first.');
      }
      const mod = {};
      if (options.title !== undefined) mod.title = options.title;
      if (options.emoji !== undefined) mod.emoji = options.emoji;
      if (options.includeContacts) mod.contacts = true;
      if (options.includeNonContacts) mod.nonContacts = true;
      if (options.includeGroups) mod.groups = true;
      if (options.includeChannels) mod.broadcasts = true;
      if (options.includeBots) mod.bots = true;
      if (options.excludeMuted) mod.excludeMuted = true;
      if (options.excludeRead) mod.excludeRead = true;
      if (options.excludeArchived) mod.excludeArchived = true;
      if (options.chat) mod.includePeers = options.chat;
      if (options.excludeChat) mod.excludePeers = options.excludeChat;
      if (options.pinChat) mod.pinnedPeers = options.pinChat;
      const result = await telegramClient.editFolder(folder, mod);
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
        console.log(`Deleted folder (id=${result.id})`);
      }
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
      release();
    }
  }, timeoutMs);
}

async function runFoldersReorder(globalFlags, options = {}) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    if (!options.ids) throw new Error('--ids is required');
    const ids = options.ids.split(',').map((s) => Number(s.trim()));
    const storeDir = resolveStoreDir();
    const release = acquireReadLock(storeDir);
    const { telegramClient, messageSyncService } = createServices({ storeDir });
    try {
      if (!(await telegramClient.isAuthorized().catch(() => false))) {
        throw new Error('Not authenticated. Run `tgcli auth` first.');
      }
      await telegramClient.setFoldersOrder(ids);
      if (globalFlags.json) {
        writeJson({ ok: true, order: ids });
      } else {
        console.log(`Reordered folders: ${ids.join(', ')}`);
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

async function runFolderChatsAdd(globalFlags, folder, options = {}) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    if (!options.chat?.length) throw new Error('--chat is required');
    const storeDir = resolveStoreDir();
    const release = acquireReadLock(storeDir);
    const { telegramClient, messageSyncService } = createServices({ storeDir });
    try {
      if (!(await telegramClient.isAuthorized().catch(() => false))) {
        throw new Error('Not authenticated. Run `tgcli auth` first.');
      }
      let result;
      for (const chatId of options.chat) {
        result = await telegramClient.addChatToFolder(folder, chatId);
      }
      if (globalFlags.json) {
        writeJson(result);
      } else {
        console.log(`Added ${options.chat.length} chat(s) to folder`);
      }
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
      release();
    }
  }, timeoutMs);
}

async function runFolderChatsRemove(globalFlags, folder, options = {}) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    if (!options.chat?.length) throw new Error('--chat is required');
    const storeDir = resolveStoreDir();
    const release = acquireReadLock(storeDir);
    const { telegramClient, messageSyncService } = createServices({ storeDir });
    try {
      if (!(await telegramClient.isAuthorized().catch(() => false))) {
        throw new Error('Not authenticated. Run `tgcli auth` first.');
      }
      let result;
      for (const chatId of options.chat) {
        result = await telegramClient.removeChatFromFolder(folder, chatId);
      }
      if (globalFlags.json) {
        writeJson(result);
      } else {
        console.log(`Removed ${options.chat.length} chat(s) from folder`);
      }
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
      release();
    }
  }, timeoutMs);
}
```

**Step 3: Verify CLI loads**

Run: `node cli.js folders --help`
Expected: Shows subcommands list/show/create/edit/delete/reorder/join/chats

**Step 4: Commit**

```bash
git add cli.js
git commit -m "feat(folders): add CLI subcommands for folder management"
```

---

### Task 3: Add MCP tools in mcp-server.js

**Files:**
- Modify: `mcp-server.js` (add schemas near top ~line 150, add tools near end ~line 1270)

**Step 1: Add Zod schemas for folder tools**

Insert after existing schemas:

```js
const listFoldersSchema = {};

const showFolderSchema = {
  folder: z.union([z.number(), z.string().min(1)]).describe("Folder ID (number) or title (string)"),
};

const createFolderSchema = {
  title: z.string().min(1).max(12).describe("Folder title (max 12 chars)"),
  emoji: z.string().optional().describe("Emoji icon"),
  includeContacts: z.boolean().optional().describe("Include contacts"),
  includeNonContacts: z.boolean().optional().describe("Include non-contacts"),
  includeGroups: z.boolean().optional().describe("Include groups"),
  includeChannels: z.boolean().optional().describe("Include channels/broadcasts"),
  includeBots: z.boolean().optional().describe("Include bots"),
  excludeMuted: z.boolean().optional().describe("Exclude muted chats"),
  excludeRead: z.boolean().optional().describe("Exclude read chats"),
  excludeArchived: z.boolean().optional().describe("Exclude archived chats"),
  chats: z.array(z.union([z.number(), z.string()])).optional().describe("Chats to include"),
  excludeChats: z.array(z.union([z.number(), z.string()])).optional().describe("Chats to exclude"),
  pinChats: z.array(z.union([z.number(), z.string()])).optional().describe("Chats to pin"),
};

const editFolderSchema = {
  folder: z.union([z.number(), z.string().min(1)]).describe("Folder ID or title"),
  title: z.string().min(1).max(12).optional().describe("New title"),
  emoji: z.string().optional().describe("New emoji"),
  includeContacts: z.boolean().optional(),
  includeNonContacts: z.boolean().optional(),
  includeGroups: z.boolean().optional(),
  includeChannels: z.boolean().optional(),
  includeBots: z.boolean().optional(),
  excludeMuted: z.boolean().optional(),
  excludeRead: z.boolean().optional(),
  excludeArchived: z.boolean().optional(),
  chats: z.array(z.union([z.number(), z.string()])).optional(),
  excludeChats: z.array(z.union([z.number(), z.string()])).optional(),
  pinChats: z.array(z.union([z.number(), z.string()])).optional(),
};

const deleteFolderSchema = {
  folder: z.union([z.number(), z.string().min(1)]).describe("Folder ID or title"),
};

const reorderFoldersSchema = {
  ids: z.array(z.number()).min(1).describe("Folder IDs in desired order"),
};

const addChatToFolderSchema = {
  folder: z.union([z.number(), z.string().min(1)]).describe("Folder ID or title"),
  chat: z.union([z.number(), z.string().min(1)]).describe("Chat ID or username to add"),
};

const removeChatFromFolderSchema = {
  folder: z.union([z.number(), z.string().min(1)]).describe("Folder ID or title"),
  chat: z.union([z.number(), z.string().min(1)]).describe("Chat ID or username to remove"),
};

const joinChatlistSchema = {
  link: z.string().min(1).describe("Chatlist/shared folder invite link"),
};
```

**Step 2: Register MCP tools**

Insert near end of `registerTools()` function:

```js
  server.tool(
    "listFolders",
    "Lists all chat folders for the authenticated account.",
    listFoldersSchema,
    async () => {
      await telegramClient.ensureLogin();
      const folders = await telegramClient.getFolders();
      return { content: [{ type: "text", text: JSON.stringify(folders, null, 2) }] };
    },
  );

  server.tool(
    "showFolder",
    "Shows details of a specific chat folder including filter settings.",
    showFolderSchema,
    async ({ folder }) => {
      await telegramClient.ensureLogin();
      const info = await telegramClient.showFolder(folder);
      return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
    },
  );

  server.tool(
    "createFolder",
    "Creates a new chat folder with specified filters.",
    createFolderSchema,
    async ({ title, emoji, includeContacts, includeNonContacts, includeGroups, includeChannels, includeBots, excludeMuted, excludeRead, excludeArchived, chats, excludeChats, pinChats }) => {
      await telegramClient.ensureLogin();
      const result = await telegramClient.createFolder({
        title, emoji,
        contacts: includeContacts, nonContacts: includeNonContacts,
        groups: includeGroups, broadcasts: includeChannels, bots: includeBots,
        excludeMuted, excludeRead, excludeArchived,
        includePeers: chats, excludePeers: excludeChats, pinnedPeers: pinChats,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "editFolder",
    "Edits an existing chat folder.",
    editFolderSchema,
    async ({ folder, ...mod }) => {
      await telegramClient.ensureLogin();
      const result = await telegramClient.editFolder(folder, {
        title: mod.title, emoji: mod.emoji,
        contacts: mod.includeContacts, nonContacts: mod.includeNonContacts,
        groups: mod.includeGroups, broadcasts: mod.includeChannels, bots: mod.includeBots,
        excludeMuted: mod.excludeMuted, excludeRead: mod.excludeRead, excludeArchived: mod.excludeArchived,
        includePeers: mod.chats, excludePeers: mod.excludeChats, pinnedPeers: mod.pinChats,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "deleteFolder",
    "Deletes a chat folder.",
    deleteFolderSchema,
    async ({ folder }) => {
      await telegramClient.ensureLogin();
      const result = await telegramClient.deleteFolder(folder);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "reorderFolders",
    "Reorders chat folders.",
    reorderFoldersSchema,
    async ({ ids }) => {
      await telegramClient.ensureLogin();
      await telegramClient.setFoldersOrder(ids);
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, order: ids }, null, 2) }] };
    },
  );

  server.tool(
    "addChatToFolder",
    "Adds a chat to a folder's include list.",
    addChatToFolderSchema,
    async ({ folder, chat }) => {
      await telegramClient.ensureLogin();
      const result = await telegramClient.addChatToFolder(folder, chat);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "removeChatFromFolder",
    "Removes a chat from a folder's include list.",
    removeChatFromFolderSchema,
    async ({ folder, chat }) => {
      await telegramClient.ensureLogin();
      const result = await telegramClient.removeChatFromFolder(folder, chat);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "joinChatlist",
    "Joins a shared folder via invite link.",
    joinChatlistSchema,
    async ({ link }) => {
      await telegramClient.ensureLogin();
      const result = await telegramClient.joinChatlist(link);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );
```

**Step 3: Verify MCP server loads**

Run: `node -e "import('./mcp-server.js')"` — should not throw.

**Step 4: Commit**

```bash
git add mcp-server.js
git commit -m "feat(folders): add MCP tools for folder management"
```

---

### Task 4: Smoke test all commands

**Step 1: Test list**

Run: `node cli.js folders list --json --timeout 30s`
Expected: JSON array of folders

**Step 2: Test create + show + delete cycle**

```bash
node cli.js folders create --title "Test" --emoji "🧪" --json --timeout 30s
# Note the id from output
node cli.js folders show <id> --json --timeout 30s
node cli.js folders delete <id> --json --timeout 30s
```

**Step 3: Test help output**

Run: `node cli.js folders --help`
Expected: All subcommands listed

**Step 4: Commit tag**

```bash
git add -A
git commit -m "test: verify folders commands smoke test"
```

---

### Task 5: Update tgcli skill documentation

**Files:**
- Modify: tgcli skill file (if accessible) — add `folders` command patterns

**Step 1: Add folders section to skill's command reference**

Add to the skill file under a new `### Folders` section:

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

**Step 2: Commit**

```bash
git commit -am "docs: add folders commands to skill reference"
```
