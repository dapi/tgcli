import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { acquireOwnerLock, readStoreLock } from '../store-lock.js';
import { callOwner, ownerSocketPath, startOwnerIpc } from '../core/owner-ipc.js';
import { createOwnerOperations, runOwnerOperation } from '../core/owner-operations.js';

const cliPath = fileURLToPath(new URL('../cli.js', import.meta.url));

function runCli(storeDir, args, { json = true } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...(json ? ['--json'] : []), ...args], {
      env: { ...process.env, TGCLI_STORE: storeDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('private owner IPC', () => {
  let storeDir;
  let lock;
  let stop;

  afterEach(async () => {
    if (stop) await stop();
    if (lock) lock.release();
    if (storeDir) fs.rmSync(storeDir, { recursive: true, force: true });
    stop = null;
    lock = null;
  });

  it('handles concurrent clients, chunked results, and identity checks', async () => {
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcli-ipc-test-'));
    lock = acquireOwnerLock(storeDir, { kind: 'server', state: 'starting' });
    stop = await startOwnerIpc({
      storeDir,
      ownerLock: lock,
      operations: {
        echo: async (args) => args,
        large: async () => ({ text: 'x'.repeat(700000) }),
      },
    });

    expect(fs.statSync(path.dirname(ownerSocketPath(storeDir))).mode & 0o777).toBe(0o700);
    expect(fs.statSync(ownerSocketPath(storeDir)).mode & 0o777).toBe(0o600);
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      callOwner({ storeDir, operation: 'echo', args: { index } })));
    expect(results).toEqual(Array.from({ length: 8 }, (_, index) => ({ index })));
    expect((await callOwner({ storeDir, operation: 'large' })).text).toHaveLength(700000);
    await expect(callOwner({ storeDir, operation: 'not-allowed' })).rejects.toMatchObject({
      code: 'INVALID_OPERATION',
    });

    const saved = readStoreLock(storeDir).info;
    fs.writeFileSync(path.join(storeDir, 'LOCK'), JSON.stringify({
      ...JSON.parse(saved), protocolVersion: 2,
    }));
    await expect(callOwner({ storeDir, operation: 'echo', args: {} })).rejects.toMatchObject({
      code: 'PROTOCOL_MISMATCH',
    });
    fs.writeFileSync(path.join(storeDir, 'LOCK'), JSON.stringify({
      ...JSON.parse(saved), ownerId: 'wrong-owner',
    }));
    await expect(callOwner({ storeDir, operation: 'echo', args: {} })).rejects.toMatchObject({
      code: 'PROTOCOL_MISMATCH',
    });
    fs.writeFileSync(path.join(storeDir, 'LOCK'), saved);

    await stop();
    stop = null;
    expect(fs.existsSync(ownerSocketPath(storeDir))).toBe(false);
  });

  it('reports an unknown result after a submitted request exceeds its deadline', async () => {
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcli-ipc-timeout-'));
    lock = acquireOwnerLock(storeDir, { kind: 'server', state: 'starting' });
    stop = await startOwnerIpc({
      storeDir,
      ownerLock: lock,
      operations: { slow: async () => { await new Promise((resolve) => setTimeout(resolve, 100)); return true; } },
    });
    await expect(callOwner({ storeDir, operation: 'slow', timeoutMs: 20 })).rejects.toMatchObject({
      code: 'UNKNOWN_RESULT',
    });
  });

  it('routes two CLI processes to the owner without opening local services', async () => {
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcli-ipc-cli-'));
    lock = acquireOwnerLock(storeDir, { kind: 'server', state: 'starting' });
    stop = await startOwnerIpc({
      storeDir,
      ownerLock: lock,
      operations: {
        'sync.status': () => ({ queue: { pending: 2, in_progress: 1, idle: 3, error: 0, processing: true } }),
        'sync.once': () => ({ queue: { pending: 0, in_progress: 0, idle: 3, error: 0, processing: false } }),
        'channels.list': () => [{ id: 42, title: 'Example' }],
      },
    });

    const [status, channels, once] = await Promise.all([
      runCli(storeDir, ['sync', 'status']),
      runCli(storeDir, ['channels', 'list']),
      runCli(storeDir, ['sync', '--once', '--idle-exit', '1s']),
    ]);
    expect(status.code, status.stderr).toBe(0);
    expect(channels.code, channels.stderr).toBe(0);
    expect(once.code, once.stderr).toBe(0);
    expect(JSON.parse(status.stdout).queue.processing).toBe(true);
    expect(JSON.parse(channels.stdout)).toEqual([{ id: 42, title: 'Example' }]);
    expect(JSON.parse(once.stdout).mode).toBe('once');
    expect(fs.existsSync(path.join(storeDir, 'messages.db'))).toBe(false);
    expect(fs.existsSync(path.join(storeDir, 'session.json'))).toBe(false);
  });

  it('runs legacy live CLI handlers against the owner services', async () => {
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcli-ipc-live-'));
    lock = acquireOwnerLock(storeDir, { kind: 'server', state: 'starting' });
    let shutdowns = 0;
    const services = {
      telegramClient: {
        isAuthorized: async () => true,
        listGroups: async () => [{ id: 7, title: 'Team' }],
        getFolders: async () => [{ id: 8, title: 'Work', type: 'custom' }],
        destroy: async () => { shutdowns += 1; },
      },
      messageSyncService: { shutdown: async () => { shutdowns += 1; } },
    };
    stop = await startOwnerIpc({ storeDir, ownerLock: lock,
      operations: createOwnerOperations({ storeDir, ...services }) });

    const [groups, folders, textGroups] = await Promise.all([
      runCli(storeDir, ['groups', 'list']),
      runCli(storeDir, ['folders', 'list']),
      runCli(storeDir, ['groups', 'list'], { json: false }),
    ]);
    expect(groups.code, groups.stderr).toBe(0);
    expect(folders.code, folders.stderr).toBe(0);
    expect(textGroups.code, textGroups.stderr).toBe(0);
    expect(JSON.parse(groups.stdout)).toEqual([{ id: 7, title: 'Team' }]);
    expect(JSON.parse(folders.stdout)).toEqual([{ id: 8, title: 'Work', type: 'custom' }]);
    expect(textGroups.stdout).toBe('Team (7)\n');
    expect(shutdowns).toBe(0);
    expect(fs.existsSync(path.join(storeDir, 'messages.db'))).toBe(false);
  });

  it('reports an empty archive when no owner or database exists', async () => {
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcli-ipc-offline-'));
    const [status, doctor] = await Promise.all([
      runCli(storeDir, ['sync', 'status']),
      runCli(storeDir, ['doctor']),
    ]);
    expect(status.code, status.stderr).toBe(0);
    expect(doctor.code, doctor.stderr).toBe(0);
    expect(JSON.parse(status.stdout).queue).toEqual({
      pending: 0, in_progress: 0, idle: 0, error: 0, processing: false,
    });
    expect(JSON.parse(doctor.stdout).authenticated).toBeNull();
    expect(fs.existsSync(path.join(storeDir, 'messages.db'))).toBe(false);
  });

  it('serializes config changes with and without an owner', async () => {
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcli-ipc-config-'));
    const standalone = await runCli(storeDir, ['config', 'set', 'mcp.enabled', 'false']);
    expect(standalone.code, standalone.stderr).toBe(0);
    expect(JSON.parse(standalone.stdout).restartRequired).toBe(false);
    expect(fs.existsSync(path.join(storeDir, 'messages.db'))).toBe(false);

    lock = acquireOwnerLock(storeDir, { kind: 'server', state: 'starting' });
    stop = await startOwnerIpc({ storeDir, ownerLock: lock,
      operations: createOwnerOperations({ storeDir, telegramClient: {}, messageSyncService: {} }) });
    const concurrent = await runCli(storeDir, ['config', 'set', 'mcp.enabled', 'true']);
    expect(concurrent.code, concurrent.stderr).toBe(0);
    expect(JSON.parse(concurrent.stdout).restartRequired).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(storeDir, 'config.json'), 'utf8')).mcp.enabled).toBe(true);
  });

  it('uses the active owner for auth status and logout', async () => {
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcli-ipc-auth-'));
    lock = acquireOwnerLock(storeDir, { kind: 'server', state: 'starting' });
    let logouts = 0;
    stop = await startOwnerIpc({ storeDir, ownerLock: lock,
      operations: createOwnerOperations({
        storeDir,
        telegramClient: {
          getCurrentUser: async () => ({ username: 'example' }),
          client: { logout: async () => { logouts += 1; } },
        },
        messageSyncService: {},
      }) });
    const auth = await runCli(storeDir, ['auth']);
    expect(auth.code, auth.stderr).toBe(0);
    expect(JSON.parse(auth.stdout).authenticated).toBe(true);
    const logout = await runCli(storeDir, ['auth', 'logout']);
    expect(logout.code, logout.stderr).toBe(0);
    expect(JSON.parse(logout.stdout).loggedOut).toBe(true);
    expect(logouts).toBe(1);
    expect(fs.existsSync(path.join(storeDir, 'session.json'))).toBe(false);
  });

  it('keeps file paths relative to the calling CLI and refuses an unreachable owner', async () => {
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcli-ipc-path-'));
    lock = acquireOwnerLock(storeDir, { kind: 'server', state: 'starting' });
    let received;
    stop = await startOwnerIpc({ storeDir, ownerLock: lock, operations: {
      'cli.execute': (request) => {
        received = request;
        return { stdout: '{"ok":true}\n', stderr: '' };
      },
    } });
    const send = await runCli(storeDir, ['send', 'photo', '--to', '@example', '--photo', './example.png']);
    expect(send.code, send.stderr).toBe(0);
    expect(received.commandPath).toBe('send photo');
    expect(received.args[0].photo).toBe(path.resolve('example.png'));

    await stop();
    stop = null;
    lock.update({ state: 'ready', socketPath: ownerSocketPath(storeDir) });
    const unavailable = await runCli(storeDir, ['groups', 'list']);
    expect(unavailable.code).not.toBe(0);
    expect(unavailable.stderr).toContain('Owner IPC is unavailable');
    expect(fs.existsSync(path.join(storeDir, 'session.json'))).toBe(false);
    expect(fs.existsSync(path.join(storeDir, 'messages.db'))).toBe(false);
  });

  it('serves an explicit live message read from the owner session', async () => {
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcli-ipc-message-'));
    lock = acquireOwnerLock(storeDir, { kind: 'server', state: 'starting' });
    let liveReads = 0;
    stop = await startOwnerIpc({ storeDir, ownerLock: lock,
      operations: createOwnerOperations({
        storeDir,
        telegramClient: {
          isAuthorized: async () => true,
          getMessagesByChannelId: async () => {
            liveReads += 1;
            return { messages: [{ id: 9, date: 1700000000, text: 'Hello' }], peerTitle: 'Demo' };
          },
        },
        messageSyncService: { getChannelMetadata: () => ({ peerTitle: 'Demo', username: 'demo' }) },
      }) });
    const live = await runCli(storeDir, ['messages', 'list', '--chat', '@demo', '--source', 'live']);
    expect(live.code, live.stderr).toBe(0);
    expect(JSON.parse(live.stdout).messages[0]).toMatchObject({
      channelId: '@demo', messageId: 9, text: 'Hello', source: 'live',
    });
    expect(liveReads).toBe(1);
    expect(fs.existsSync(path.join(storeDir, 'session.json'))).toBe(false);
  });

  it('keeps transient ownership until timed-out local work really finishes', async () => {
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcli-ipc-local-timeout-'));
    await expect(runOwnerOperation({ storeDir, operation: 'test.slow', timeoutMs: 20,
      localHandler: async () => { await new Promise((resolve) => setTimeout(resolve, 100)); } })).rejects.toMatchObject({
      code: 'UNKNOWN_RESULT',
    });
    expect(readStoreLock(storeDir).exists).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 110));
    expect(readStoreLock(storeDir).exists).toBe(false);
  });
});
