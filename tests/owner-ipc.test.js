import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { acquireOwnerLock, readStoreLock } from '../store-lock.js';
import { callOwner, ownerSocketPath, startOwnerIpc } from '../core/owner-ipc.js';

const cliPath = fileURLToPath(new URL('../cli.js', import.meta.url));

function runCli(storeDir, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, '--json', ...args], {
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

  it('reports an empty archive when no owner or database exists', async () => {
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcli-ipc-offline-'));
    const status = await runCli(storeDir, ['sync', 'status']);
    expect(status.code, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout).queue).toEqual({
      pending: 0, in_progress: 0, idle: 0, error: 0, processing: false,
    });
    expect(fs.existsSync(path.join(storeDir, 'messages.db'))).toBe(false);
  });
});
