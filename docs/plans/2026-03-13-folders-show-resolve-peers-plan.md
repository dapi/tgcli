# Folders Show Peer Resolution — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `--resolve` flag to `tgcli folders show` that resolves raw peer IDs to readable channel/user names.

**Architecture:** Normalize raw MTCute peer objects in `showFolder()` to `{ type, id }` by default; with `resolve=true`, additionally fetch names via `getChat()`/`getFullUser()`. CLI formats output as typed ID list (default) or grouped-by-type name list (with `--resolve`).

**Tech Stack:** Node.js, vitest, @mtcute/node (GramJS)

---

### Task 1: Add `_normalizePeer()` method with tests

**Files:**
- Modify: `telegram-client.js:1509` (after `_extractPeerId`)
- Test: `tests/folders.test.js`

**Step 1: Write the failing tests**

Add to `tests/folders.test.js`:

```js
describe('_normalizePeer', () => {
  let tc;
  beforeEach(() => { tc = createMockClient(); });

  it('normalizes channel peer', () => {
    expect(tc._normalizePeer({ _: 'inputPeerChannel', channelId: 1951583351 }))
      .toEqual({ type: 'channel', id: 1951583351 });
  });

  it('normalizes user peer', () => {
    expect(tc._normalizePeer({ _: 'inputPeerUser', userId: 272066824 }))
      .toEqual({ type: 'user', id: 272066824 });
  });

  it('normalizes chat peer', () => {
    expect(tc._normalizePeer({ _: 'inputPeerChat', chatId: 555 }))
      .toEqual({ type: 'chat', id: 555 });
  });

  it('infers type from field when _ is missing', () => {
    expect(tc._normalizePeer({ channelId: 123 })).toEqual({ type: 'channel', id: 123 });
    expect(tc._normalizePeer({ userId: 456 })).toEqual({ type: 'user', id: 456 });
    expect(tc._normalizePeer({ chatId: 789 })).toEqual({ type: 'chat', id: 789 });
  });

  it('converts BigInt id to Number', () => {
    expect(tc._normalizePeer({ channelId: BigInt(123) })).toEqual({ type: 'channel', id: 123 });
  });

  it('throws for null peer', () => {
    expect(() => tc._normalizePeer(null)).toThrow();
  });

  it('throws for peer without recognizable fields', () => {
    expect(() => tc._normalizePeer({ foo: 'bar' })).toThrow();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd /home/danil/code/tgcli && npx vitest run tests/folders.test.js`
Expected: FAIL — `_normalizePeer is not a function`

**Step 3: Implement `_normalizePeer()`**

Add after `_extractPeerId` method in `telegram-client.js` (around line 1515):

```js
  _normalizePeer(peer) {
    if (peer == null) throw new Error(`Peer is ${peer}, cannot normalize`);
    if (typeof peer !== 'object') throw new Error(`Peer must be an object, got ${typeof peer}`);

    let type, id;
    if (peer.userId != null) {
      type = 'user';
      id = Number(peer.userId);
    } else if (peer.channelId != null) {
      type = 'channel';
      id = Number(peer.channelId);
    } else if (peer.chatId != null) {
      type = 'chat';
      id = Number(peer.chatId);
    } else {
      throw new Error(`Peer object has no recognizable ID field: ${JSON.stringify(peer)}`);
    }

    return { type, id };
  }
```

**Step 4: Run tests to verify they pass**

Run: `cd /home/danil/code/tgcli && npx vitest run tests/folders.test.js`
Expected: ALL PASS

**Step 5: Commit**

```bash
cd /home/danil/code/tgcli
git add telegram-client.js tests/folders.test.js
git commit -m "feat(folders): add _normalizePeer() method

Extracts type and numeric id from raw MTCute peer objects.
Ref: #19"
```

---

### Task 2: Add `_resolvePeerName()` method with tests

**Files:**
- Modify: `telegram-client.js` (after `_normalizePeer`)
- Test: `tests/folders.test.js`

**Step 1: Write the failing tests**

Add to `tests/folders.test.js`. The mock client needs `getChat` and `getFullUser`:

First, update `createMockClient()` to add these mocks:

```js
// Add to createMockClient() tc.client object:
    getChat: vi.fn(),
    getFullUser: vi.fn(),
```

Then add tests:

```js
describe('_resolvePeerName', () => {
  let tc;
  beforeEach(() => { tc = createMockClient(); });

  it('resolves channel name via getChat', async () => {
    tc.client.getChat.mockResolvedValue({ displayName: 'ИИшница' });
    const result = await tc._resolvePeerName('channel', 1951583351);
    expect(result).toBe('ИИшница');
  });

  it('resolves user name via getFullUser', async () => {
    tc.client.getFullUser.mockResolvedValue({ displayName: 'Иван Иванов' });
    const result = await tc._resolvePeerName('user', 272066824);
    expect(result).toBe('Иван Иванов');
  });

  it('resolves chat name via getChat', async () => {
    tc.client.getChat.mockResolvedValue({ displayName: 'Dev Chat' });
    const result = await tc._resolvePeerName('chat', 555);
    expect(result).toBe('Dev Chat');
  });

  it('falls back to title field', async () => {
    tc.client.getChat.mockResolvedValue({ title: 'Fallback Title' });
    const result = await tc._resolvePeerName('channel', 123);
    expect(result).toBe('Fallback Title');
  });

  it('returns null on error', async () => {
    tc.client.getChat.mockRejectedValue(new Error('PEER_NOT_FOUND'));
    const result = await tc._resolvePeerName('channel', 999);
    expect(result).toBeNull();
  });

  it('returns null for user resolution error', async () => {
    tc.client.getFullUser.mockRejectedValue(new Error('USER_NOT_FOUND'));
    const result = await tc._resolvePeerName('user', 999);
    expect(result).toBeNull();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd /home/danil/code/tgcli && npx vitest run tests/folders.test.js`
Expected: FAIL — `_resolvePeerName is not a function`

**Step 3: Implement `_resolvePeerName()`**

Add after `_normalizePeer` in `telegram-client.js`:

```js
  async _resolvePeerName(type, id) {
    try {
      if (type === 'user') {
        const user = await this.client.getFullUser(id);
        return user.displayName || user.firstName || null;
      }
      const chat = await this.client.getChat(id);
      return chat.displayName || chat.title || null;
    } catch {
      return null;
    }
  }
```

**Step 4: Run tests to verify they pass**

Run: `cd /home/danil/code/tgcli && npx vitest run tests/folders.test.js`
Expected: ALL PASS

**Step 5: Commit**

```bash
cd /home/danil/code/tgcli
git add telegram-client.js tests/folders.test.js
git commit -m "feat(folders): add _resolvePeerName() for lightweight name resolution

Resolves peer ID to name via getChat/getFullUser without fetching full metadata.
Returns null on error (graceful degradation).
Ref: #19"
```

---

### Task 3: Update `showFolder()` to normalize and optionally resolve peers

**Files:**
- Modify: `telegram-client.js:1380-1402` (`showFolder` method)
- Test: `tests/folders.test.js`

**Step 1: Write the failing tests**

Add/update in `tests/folders.test.js`:

```js
describe('showFolder - peer normalization', () => {
  let tc;
  beforeEach(() => { tc = createMockClient(); });

  it('normalizes peers by default (no resolve)', async () => {
    tc.client.findFolder.mockResolvedValue({
      id: 1, title: 'AI', _: 'dialogFilter',
      includePeers: [{ channelId: 1951583351 }, { userId: 272066824 }],
      excludePeers: [{ chatId: 555 }],
      pinnedPeers: [],
    });
    const result = await tc.showFolder('1');
    expect(result.includePeers).toEqual([
      { type: 'channel', id: 1951583351 },
      { type: 'user', id: 272066824 },
    ]);
    expect(result.excludePeers).toEqual([{ type: 'chat', id: 555 }]);
    expect(result.pinnedPeers).toEqual([]);
  });

  it('resolves peer names with resolve=true', async () => {
    tc.client.findFolder.mockResolvedValue({
      id: 1, title: 'AI', _: 'dialogFilter',
      includePeers: [{ channelId: 1951583351 }, { userId: 272066824 }],
      excludePeers: [], pinnedPeers: [],
    });
    tc.client.getChat.mockResolvedValue({ displayName: 'ИИшница' });
    tc.client.getFullUser.mockResolvedValue({ displayName: 'Иван Иванов' });

    const result = await tc.showFolder('1', { resolve: true });
    expect(result.includePeers).toEqual([
      { type: 'channel', id: 1951583351, title: 'ИИшница' },
      { type: 'user', id: 272066824, name: 'Иван Иванов' },
    ]);
  });

  it('marks unresolved peers with (unresolved)', async () => {
    tc.client.findFolder.mockResolvedValue({
      id: 1, title: 'AI', _: 'dialogFilter',
      includePeers: [{ channelId: 999 }],
      excludePeers: [], pinnedPeers: [],
    });
    tc.client.getChat.mockRejectedValue(new Error('PEER_NOT_FOUND'));

    const result = await tc.showFolder('1', { resolve: true });
    expect(result.includePeers).toEqual([
      { type: 'channel', id: 999, title: '(unresolved)' },
    ]);
  });

  it('handles empty peer arrays', async () => {
    tc.client.findFolder.mockResolvedValue({
      id: 1, title: 'AI', _: 'dialogFilter',
      includePeers: [], excludePeers: null, pinnedPeers: undefined,
    });
    const result = await tc.showFolder('1');
    expect(result.includePeers).toEqual([]);
    expect(result.excludePeers).toEqual([]);
    expect(result.pinnedPeers).toEqual([]);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd /home/danil/code/tgcli && npx vitest run tests/folders.test.js`
Expected: FAIL — peers are still raw objects

**Step 3: Update `showFolder()` implementation**

Replace the `showFolder` method in `telegram-client.js:1380-1402`:

```js
  async showFolder(idOrName, options = {}) {
    await this.ensureLogin();
    const folder = await this.findFolder(idOrName);
    if (!folder) throw new Error(`Folder not found: ${idOrName}`);

    const normalizePeers = (peers) => (peers ?? []).map((p) => this._normalizePeer(p));

    const resolvePeers = async (peers) => {
      const normalized = normalizePeers(peers);
      if (!options.resolve) return normalized;

      return Promise.all(normalized.map(async (peer) => {
        const name = await this._resolvePeerName(peer.type, peer.id);
        const nameField = peer.type === 'user' ? 'name' : 'title';
        return { ...peer, [nameField]: name ?? '(unresolved)' };
      }));
    };

    return {
      id: folder.id,
      title: typeof folder.title === 'string' ? folder.title : (folder.title?.text ?? 'Unknown'),
      emoji: folder.emoticon ?? null,
      color: folder.color ?? null,
      type: folder._ === 'dialogFilterChatlist' ? 'chatlist' : folder._ === 'dialogFilterDefault' ? 'default' : 'filter',
      contacts: folder.contacts ?? false,
      nonContacts: folder.nonContacts ?? false,
      groups: folder.groups ?? false,
      broadcasts: folder.broadcasts ?? false,
      bots: folder.bots ?? false,
      excludeMuted: folder.excludeMuted ?? false,
      excludeRead: folder.excludeRead ?? false,
      excludeArchived: folder.excludeArchived ?? false,
      includePeers: await resolvePeers(folder.includePeers),
      excludePeers: await resolvePeers(folder.excludePeers),
      pinnedPeers: await resolvePeers(folder.pinnedPeers),
    };
  }
```

**Step 4: Run tests to verify they pass**

Run: `cd /home/danil/code/tgcli && npx vitest run tests/folders.test.js`
Expected: ALL PASS

**Step 5: Commit**

```bash
cd /home/danil/code/tgcli
git add telegram-client.js tests/folders.test.js
git commit -m "feat(folders): normalize peers in showFolder, add resolve option

showFolder now returns { type, id } for each peer instead of raw MTCute objects.
With resolve=true, additionally fetches channel titles and user names.
Unresolvable peers are marked as (unresolved).
Ref: #19"
```

---

### Task 4: Add `--resolve` flag and update CLI text output

**Files:**
- Modify: `cli.js:429-432` (command definition)
- Modify: `cli.js:3711-3741` (`runFoldersShow` function)

**Step 1: Add `--resolve` option to command definition**

In `cli.js`, change the `folders show` command definition (around line 429):

```js
  folders
    .command('show')
    .description('Show folder details')
    .argument('<folder>', 'Folder ID or title')
    .option('--resolve', 'Resolve peer IDs to names (slower, requires API calls)')
    .action(withGlobalOptions((globalFlags, folder, opts) => runFoldersShow(globalFlags, folder, opts)));
```

**Step 2: Update `runFoldersShow` function**

Replace the `runFoldersShow` function in `cli.js`:

```js
async function runFoldersShow(globalFlags, folder, opts = {}) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    const storeDir = resolveStoreDir();
    const release = acquireReadLock(storeDir);
    const { telegramClient, messageSyncService } = createServices({ storeDir });
    try {
      if (!(await telegramClient.isAuthorized().catch(() => false))) {
        throw new Error('Not authenticated. Run `tgcli auth` first.');
      }
      const info = await telegramClient.showFolder(folder, { resolve: opts.resolve });
      if (globalFlags.json) {
        writeJson(info);
      } else {
        console.log(`${info.title} (id=${info.id}, type=${info.type})`);
        if (info.emoji) console.log(`  emoji: ${info.emoji}`);
        const flags = ['contacts', 'nonContacts', 'groups', 'broadcasts', 'bots'].filter((f) => info[f]);
        if (flags.length) console.log(`  includes: ${flags.join(', ')}`);
        const excludes = ['excludeMuted', 'excludeRead', 'excludeArchived'].filter((f) => info[f]);
        if (excludes.length) console.log(`  excludes: ${excludes.join(', ')}`);

        if (opts.resolve) {
          // Group peers by type and show with names
          const printResolvedPeers = (peers, label) => {
            if (!peers?.length) return;
            const grouped = {};
            for (const p of peers) {
              const group = p.type + 's';
              if (!grouped[group]) grouped[group] = [];
              const displayName = p.name ?? p.title ?? '(unresolved)';
              grouped[group].push(`${displayName} (${p.id})`);
            }
            for (const [group, items] of Object.entries(grouped)) {
              console.log(`  ${group}:`);
              for (const item of items) console.log(`    - ${item}`);
            }
          };
          printResolvedPeers(info.includePeers);
          if (info.excludePeers?.length) {
            console.log('  excluded:');
            for (const p of info.excludePeers) {
              const displayName = p.name ?? p.title ?? '(unresolved)';
              console.log(`    - ${displayName} (${p.id})`);
            }
          }
          if (info.pinnedPeers?.length) {
            console.log('  pinned:');
            for (const p of info.pinnedPeers) {
              const displayName = p.name ?? p.title ?? '(unresolved)';
              console.log(`    - ${displayName} (${p.id})`);
            }
          }
        } else {
          // Show typed ID list
          const printPeers = (peers, label) => {
            if (!peers?.length) {
              console.log(`  ${label}: (none)`);
              return;
            }
            console.log(`  ${label}:`);
            for (const p of peers) console.log(`    - ${p.type}:${p.id}`);
          };
          printPeers(info.includePeers, 'includePeers');
          printPeers(info.excludePeers, 'excludePeers');
          printPeers(info.pinnedPeers, 'pinnedPeers');
        }
      }
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
      release();
    }
  }, timeoutMs);
}
```

**Step 3: Run full test suite**

Run: `cd /home/danil/code/tgcli && npx vitest run`
Expected: ALL PASS

**Step 4: Manual smoke test (optional)**

```bash
cd /home/danil/code/tgcli
node cli.js folders show AI --json --timeout 30s
node cli.js folders show AI --timeout 30s
node cli.js folders show AI --resolve --timeout 30s
node cli.js folders show AI --resolve --json --timeout 30s
```

**Step 5: Commit**

```bash
cd /home/danil/code/tgcli
git add cli.js
git commit -m "feat(folders): add --resolve flag to folders show CLI command

Without --resolve: shows typed peer ID list (channel:123, user:456).
With --resolve: groups peers by type and shows resolved names.
Ref: #19"
```

---

### Task 5: Update SKILL.md with Folders documentation

**Files:**
- Modify: `SKILL.md`

**Step 1: Add Folders section**

Add before the `### Sync Jobs` section in `SKILL.md`:

```markdown
### Folders

```bash
tgcli folders list --json --timeout 30s
tgcli folders show <name|id> --json --timeout 30s
tgcli folders show <name|id> --resolve --json --timeout 30s
tgcli folders create --title "Name" --emoji "🤖" --json --timeout 30s
tgcli folders edit <name|id> --title "New Name" --json --timeout 30s
tgcli folders delete <name|id> --json --timeout 30s
tgcli folders order <id1> <id2> <id3> --json --timeout 30s
tgcli folders add-chat <folder> --chat <id> --json --timeout 30s
tgcli folders remove-chat <folder> --chat <id> --json --timeout 30s
tgcli folders join --link "https://t.me/addlist/slug" --json --timeout 30s
```

Use `--resolve` with `folders show` to resolve peer IDs to readable channel/user names (slower, requires API calls per peer). Without `--resolve`, peers are shown as typed IDs (e.g., `channel:123`).
```

**Step 2: Commit**

```bash
cd /home/danil/code/tgcli
git add SKILL.md
git commit -m "docs: add Folders section to SKILL.md

Documents all folders subcommands including new --resolve flag.
Ref: #19"
```

---

### Task 6: Fix existing test expectations for normalized peers

**Files:**
- Modify: `tests/folders.test.js`

**Context:** The existing `showFolder` test (line 149-176) expects raw peer objects (`{ userId: 123 }`). After Task 3, `showFolder` normalizes peers, so this test will break. This task updates the existing test expectations.

**Step 1: Update existing showFolder test**

In `tests/folders.test.js`, find the existing test at line 153:

```js
// Before (will break):
expect(result.includePeers).toEqual([{ userId: 123 }]);

// After (matches new normalized output):
expect(result.includePeers).toEqual([{ type: 'user', id: 123 }]);
```

**Step 2: Run tests**

Run: `cd /home/danil/code/tgcli && npx vitest run tests/folders.test.js`
Expected: ALL PASS

**Step 3: Commit**

```bash
cd /home/danil/code/tgcli
git add tests/folders.test.js
git commit -m "test: update showFolder test expectations for normalized peers

Ref: #19"
```

**IMPORTANT:** This task should be done together with Task 3 (they are coupled). When implementing, merge this into Task 3's commit.
