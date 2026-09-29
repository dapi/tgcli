import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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
});
