import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import TelegramClient from '../telegram-client.js';
import MessageSyncService from '../message-sync-service.js';
import { acquireOwnerLock } from '../store-lock.js';
import { callOwner, startOwnerIpc } from '../core/owner-ipc.js';
import { OwnerCoordinator } from '../core/owner-coordinator.js';
import { createOwnerOperations } from '../core/owner-operations.js';
import { getTelegramRequestSignal, runTelegramRequest } from '../core/request-context.js';
import { withSendRetry } from '../core/retry.js';

let storeDir;
let lock;
let stop;
afterEach(async () => {
  if (stop) await stop();
  lock?.release();
  if (storeDir) fs.rmSync(storeDir, { recursive: true, force: true });
  storeDir = lock = stop = undefined;
});

function mockTelegramClient() {
  const telegram = Object.create(TelegramClient.prototype);
  const aborted = [];
  const signals = [];
  telegram.client = {
    getMe: async () => ({ username: 'fixture' }),
    call: vi.fn((_, options) => {
      signals.push(options.abortSignal);
      return new Promise((_, reject) => options.abortSignal.addEventListener('abort', () => {
        aborted.push(true);
        reject(options.abortSignal.reason);
      }, { once: true }));
    }),
    // Simulates mtcute's nested upload helper, including its unlimited retries.
    sendMedia(mediaPeer, media, options) {
      return this.call({ _: 'upload.saveFilePart' }, { ...options, maxRetryCount: Infinity, abortSignal: undefined });
    },
  };
  telegram.options = {};
  return { telegram, aborted, signals };
}

async function startMockOwner() {
  storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcli-cancel-'));
  const file = path.join(storeDir, 'fixture.txt');
  fs.writeFileSync(file, 'fixture');
  lock = acquireOwnerLock(storeDir, { kind: 'server' });
  const { telegram, aborted, signals } = mockTelegramClient();
  const coordinator = new OwnerCoordinator();
  stop = await startOwnerIpc({ storeDir, ownerLock: lock, operations: createOwnerOperations({
    storeDir, coordinator, telegramClient: telegram, messageSyncService: {},
  }) });
  const upload = timeoutMs => callOwner({ storeDir, operation: 'cli.execute', timeoutMs,
    args: { commandPath: 'send file', args: [{ to: 'me', file }], flags: { json: true, timeoutMs } },
  }).catch(error => error);
  return { upload, coordinator, aborted, signals };
}

it('cancels four stalled CLI uploads and lets the next owner request execute', async () => {
  const { upload, coordinator, aborted } = await startMockOwner();
  const errors = await Promise.all(Array.from({ length: 4 }, () => upload(250)));
  expect(errors.map(error => error.code)).toEqual(Array(4).fill('UNKNOWN_RESULT'));
  await vi.waitFor(() => expect(coordinator.active).toBe(0));
  expect(aborted).toHaveLength(4);
  const outcomes = await Promise.all(errors.map(error => callOwner({ storeDir,
    operation: 'owner.requestStatus', args: { requestId: error.requestId } })));
  expect(outcomes.every(outcome => outcome.status === 'unknown' && outcome.code === 'UNKNOWN_RESULT')).toBe(true);
  expect(await callOwner({ storeDir, operation: 'auth.current', timeoutMs: 500 }))
    .toEqual({ authenticated: true, username: 'fixture' });
});

it('cancels accepted work on shutdown and waits for it before returning', async () => {
  const { upload, coordinator, aborted, signals } = await startMockOwner();
  const pending = upload(30000);
  await vi.waitFor(() => expect(signals).toHaveLength(1));
  await stop();
  stop = undefined;
  expect(coordinator.active).toBe(0);
  expect(aborted).toHaveLength(1);
  expect((await pending).code).toBe('UNKNOWN_RESULT');
});

it('does not give persistent sync jobs the deadline of the request that queued them', async () => {
  const service = Object.create(MessageSyncService.prototype);
  service.processing = false;
  service.stopRequested = false;
  service.interJobDelayMs = 0;
  let nextJob = {};
  service._getNextJob = () => { const job = nextJob; nextJob = null; return job; };
  let workerSignal;
  service._processJob = async () => { workerSignal = getTelegramRequestSignal(); };
  await runTelegramRequest(new AbortController().signal, () => service.processQueue());
  expect(workerSignal).toBeUndefined();
  expect(service.processing).toBe(false);
});

it('interrupts retry backoff and never retries a send after cancellation', async () => {
  const controller = new AbortController();
  const send = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
  const pending = runTelegramRequest(controller.signal, () => withSendRetry(send, { retries: 3 }));
  const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  controller.abort();
  await cancelled;
  expect(send).toHaveBeenCalledTimes(1);
});
