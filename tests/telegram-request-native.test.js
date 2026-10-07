import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import TelegramClient from '../telegram-client.js';
import { runTelegramRequest } from '../core/request-context.js';

let directory;
let telegram;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcli-native-cancel-'));
  telegram = new TelegramClient(12345, 'fixture-only', '+1234567890', path.join(directory, 'session.json'), {
    disableUpdates: true,
  });
});
afterEach(async () => {
  await telegram.destroy();
  fs.rmSync(directory, { recursive: true, force: true });
});

function stallRpc() {
  // Use the real mtcute high-level methods, substituting only the network RPC.
  const call = vi.fn((_, options) => new Promise((resolve, reject) => {
    options.abortSignal.addEventListener('abort', () => reject(options.abortSignal.reason), { once: true });
  }));
  telegram.baseClient._client.call = call;
  return call;
}

it('passes the deadline through the real mtcute getMe implementation', async () => {
  const call = stallRpc();
  const controller = new AbortController();
  const pending = runTelegramRequest(controller.signal, () => telegram.getCurrentUser());
  expect(call.mock.calls[0][1].abortSignal).toBe(controller.signal);
  const cancelled = expect(pending).rejects.toThrow('deadline');
  controller.abort(new Error('deadline'));
  await cancelled;
});

it('interrupts the real mtcute file uploader despite its infinite RPC retries', async () => {
  const call = stallRpc();
  const native = telegram.baseClient._client;
  telegram.ensureLogin = async () => true;
  native.timers.cancel = async () => {};
  native.getPoolSize = async () => 1;
  native.storage.self.getCached = () => ({ userId: 12345, isPremium: false });
  const file = path.join(directory, 'fixture.txt');
  fs.writeFileSync(file, 'fixture');
  const controller = new AbortController();
  const pending = runTelegramRequest(controller.signal, () => telegram.sendFileMessage('me', file));
  const cancelled = expect(pending).rejects.toThrow('upload deadline');
  await vi.waitFor(() => expect(call).toHaveBeenCalled());
  expect(call.mock.calls[0][0]._).toBe('upload.saveFilePart');
  expect(call.mock.calls[0][1]).toMatchObject({ maxRetryCount: Infinity, abortSignal: controller.signal });
  controller.abort(new Error('upload deadline'));
  await cancelled;
});
