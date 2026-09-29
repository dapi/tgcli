import { describe, expect, it, vi } from 'vitest';

import MessageSyncService from '../message-sync-service.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

describe('sync queue concurrency', () => {
  it('processes a queued job once when workers are started concurrently', async () => {
    const service = Object.create(MessageSyncService.prototype);
    const entered = deferred();
    const finish = deferred();
    service.processing = false;
    service.stopRequested = false;
    service.interJobDelayMs = 0;
    service._getNextJob = vi.fn().mockReturnValueOnce({ id: 1 }).mockReturnValue(null);
    service._processJob = vi.fn(async () => {
      entered.resolve();
      await finish.promise;
    });

    const firstWorker = service.processQueue();
    await entered.promise;
    const secondWorker = service.processQueue();
    expect(service._processJob).toHaveBeenCalledTimes(1);

    finish.resolve();
    await Promise.all([firstWorker, secondWorker]);
    expect(service._processJob).toHaveBeenCalledTimes(1);
    expect(service.processing).toBe(false);
  });
});
