import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const services = vi.hoisted(() => ({
  shutdown: vi.fn(),
  destroy: vi.fn(),
}));

vi.mock('../core/services.js', () => ({
  createServices: () => ({
    messageSyncService: {
      getQueueStats: () => ({ processing: false }),
      shutdown: services.shutdown,
    },
    telegramClient: { destroy: services.destroy },
  }),
}));

import { runOwnerOperation } from '../core/owner-operations.js';
import { readStoreLock } from '../store-lock.js';

let storeDir;

afterEach(() => {
  services.shutdown.mockReset();
  services.destroy.mockReset();
  if (storeDir) fs.rmSync(storeDir, { recursive: true, force: true });
  storeDir = null;
});

it('releases transient ownership after service shutdown fails', async () => {
  storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcli-cleanup-test-'));
  services.shutdown.mockRejectedValueOnce(new Error('archive shutdown failed'));

  await expect(runOwnerOperation({ storeDir, operation: 'sync.status' }))
    .rejects.toThrow('archive shutdown failed');

  expect(services.destroy).toHaveBeenCalledOnce();
  expect(readStoreLock(storeDir).exists).toBe(false);
});
