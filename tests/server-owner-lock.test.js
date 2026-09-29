import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { acquireOwnerLock, parseStoreLock, readStoreLock } from '../store-lock.js';

const serverPath = fileURLToPath(new URL('../mcp-server.js', import.meta.url));

describe('server store ownership', () => {
  let storeDir;
  let owner;

  afterEach(() => {
    owner?.release();
    if (storeDir) fs.rmSync(storeDir, { recursive: true, force: true });
  });

  it('claims the store before opening the writable archive or Telegram session', () => {
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcli-server-lock-'));
    fs.writeFileSync(path.join(storeDir, 'config.json'), JSON.stringify({
      apiId: 12345,
      apiHash: 'test-hash',
      phoneNumber: '+1234567890',
    }));
    owner = acquireOwnerLock(storeDir, { kind: 'sync', state: 'ready' });

    const result = spawnSync(process.execPath, [serverPath], {
      env: { ...process.env, TGCLI_STORE: storeDir },
      encoding: 'utf8',
      timeout: 10_000,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Store is locked by another process');
    expect(fs.existsSync(path.join(storeDir, 'messages.db'))).toBe(false);
    expect(fs.existsSync(path.join(storeDir, 'session.json'))).toBe(false);
    expect(parseStoreLock(readStoreLock(storeDir).info)?.ownerId).toBe(owner.info.ownerId);
  });

  it('updates readiness without changing ownership and frees the claim after release', () => {
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcli-server-lock-'));
    owner = acquireOwnerLock(storeDir, { kind: 'server', state: 'starting' });
    owner.update({ state: 'ready', socketPath: '/tmp/test.sock' });

    expect(parseStoreLock(readStoreLock(storeDir).info)).toMatchObject({
      ownerId: owner.info.ownerId,
      kind: 'server',
      state: 'ready',
      socketPath: '/tmp/test.sock',
    });
    expect(() => acquireOwnerLock(storeDir)).toThrow('Store is locked by another process');

    owner.release();
    owner = null;
    const next = acquireOwnerLock(storeDir);
    expect(next.info.ownerId).toBeTruthy();
    next.release();
  });

  it('reclaims a dead owner and preserves the new owner identity', () => {
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcli-server-lock-'));
    fs.writeFileSync(path.join(storeDir, 'LOCK'), JSON.stringify({
      pid: 2147483647,
      ownerId: 'dead-owner',
      state: 'ready',
    }));

    owner = acquireOwnerLock(storeDir, { kind: 'server', state: 'starting' });

    expect(owner.info.ownerId).not.toBe('dead-owner');
    expect(parseStoreLock(readStoreLock(storeDir).info)?.ownerId).toBe(owner.info.ownerId);
    expect(fs.existsSync(path.join(storeDir, 'LOCK.reclaim'))).toBe(false);
  });

  it('recovers after a previous reclaimer crashes', () => {
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcli-server-reclaim-'));
    fs.writeFileSync(path.join(storeDir, 'LOCK'), JSON.stringify({
      pid: 2147483647,
      ownerId: 'dead-owner',
    }));
    fs.writeFileSync(path.join(storeDir, 'LOCK.reclaim'), JSON.stringify({
      pid: 2147483647,
    }));

    owner = acquireOwnerLock(storeDir, { kind: 'server', state: 'starting' });

    expect(owner.info.ownerId).not.toBe('dead-owner');
    expect(fs.existsSync(path.join(storeDir, 'LOCK.reclaim'))).toBe(false);
  });

  it('releases the ownership guard after an abrupt process exit', async () => {
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcli-server-crash-'));
    const lockModule = fileURLToPath(new URL('../store-lock.js', import.meta.url));
    const script = `
      import { acquireOwnerLock } from ${JSON.stringify(lockModule)};
      acquireOwnerLock(process.argv[1], { kind: 'server', state: 'ready' });
      process.stdout.write('ready\\n');
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, storeDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      await new Promise((resolve, reject) => {
        child.stdout.once('data', resolve);
        child.once('error', reject);
        child.once('exit', (code) => reject(new Error(`Owner exited before ready: ${code}`)));
      });
      expect(() => acquireOwnerLock(storeDir)).toThrow('Store is locked by another process');
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await new Promise((resolve) => child.once('exit', resolve));
      }
    }

    owner = acquireOwnerLock(storeDir, { kind: 'server', state: 'starting' });
    expect(owner.info.ownerId).toBeTruthy();
  });

  it('allows only one simultaneous process to claim a free store', async () => {
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcli-server-race-'));
    const lockModule = fileURLToPath(new URL('../store-lock.js', import.meta.url));
    const barrier = path.join(storeDir, 'go');
    const script = `
      import fs from 'node:fs';
      import { setTimeout as delay } from 'node:timers/promises';
      import { acquireOwnerLock } from ${JSON.stringify(lockModule)};
      const [storeDir, barrier] = process.argv.slice(1);
      fs.writeFileSync(storeDir + '/ready-' + process.pid, '');
      while (!fs.existsSync(barrier)) await delay(5);
      try {
        const lock = acquireOwnerLock(storeDir);
        fs.writeFileSync(storeDir + '/winner-' + process.pid, '');
        await delay(200);
        lock.release();
      } catch {
        fs.writeFileSync(storeDir + '/loser-' + process.pid, '');
      }
    `;
    const run = () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script, storeDir, barrier], {
        stdio: 'ignore',
      });
      child.on('error', reject);
      child.on('exit', (code) => resolve(code));
    });
    const first = run();
    const second = run();
    const readyDeadline = Date.now() + 5000;
    while (fs.readdirSync(storeDir).filter((name) => name.startsWith('ready-')).length < 2) {
      if (Date.now() > readyDeadline) throw new Error('Lock contenders did not start');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    fs.writeFileSync(barrier, '');
    expect(await Promise.all([first, second])).toEqual([0, 0]);
    expect(fs.readdirSync(storeDir).filter((name) => name.startsWith('winner-'))).toHaveLength(1);
    expect(fs.readdirSync(storeDir).filter((name) => name.startsWith('loser-'))).toHaveLength(1);
  });
});
