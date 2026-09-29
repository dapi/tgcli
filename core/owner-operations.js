import { setTimeout as delay } from 'node:timers/promises';

import { createServices } from './services.js';
import { callOwner } from './owner-ipc.js';
import { acquireOwnerLock, isPidAlive, parseStoreLock, readStoreLock } from '../store-lock.js';

export function createOwnerOperations({ telegramClient, messageSyncService }) {
  let mutationTail = Promise.resolve();
  const serialize = (handler) => (args, context) => {
    const current = mutationTail.then(() => handler(args, context));
    mutationTail = current.catch(() => {});
    return current;
  };
  return {
    'sync.status': () => ({ queue: messageSyncService.getQueueStats() }),
    'sync.once': async ({ idleExitMs = 30000 }, { signal }) => {
      await messageSyncService.refreshChannelsFromDialogs();
      messageSyncService.resumePendingJobs();
      let idleSince = null;
      while (!signal?.aborted) {
        const queue = messageSyncService.getQueueStats();
        if (!queue.processing && queue.pending + queue.in_progress === 0) {
          idleSince ??= Date.now();
          if (Date.now() - idleSince >= idleExitMs) return { queue };
        } else {
          idleSince = null;
        }
        await delay(500);
      }
      const error = new Error('Sync request deadline expired');
      error.code = 'UNKNOWN_RESULT';
      throw error;
    },
    'sync.jobs.add': serialize(async ({ chat, depth, minDate }) => {
      if (!(await telegramClient.isAuthorized().catch(() => false))) {
        throw new Error('Not authenticated. Run `tgcli auth` first.');
      }
      const job = messageSyncService.addJob(chat, { depth, minDate });
      void messageSyncService.processQueue();
      return job;
    }),
    'sync.jobs.retry': serialize(async ({ jobId, channelId, allErrors }) => {
      const result = messageSyncService.retryJobs({ jobId, channelId, allErrors });
      const authed = await telegramClient.isAuthorized().catch(() => false);
      if (authed && result.updated > 0) void messageSyncService.processQueue();
      return result;
    }),
    'sync.jobs.cancel': serialize(({ jobId, channelId }) =>
      messageSyncService.cancelJobs({ jobId, channelId })),
    'channels.list': async ({ query, limit }) => {
      if (!(await telegramClient.isAuthorized().catch(() => false))) {
        throw new Error('Not authenticated. Run `tgcli auth` first.');
      }
      return query
        ? telegramClient.searchDialogs(query, limit)
        : telegramClient.listDialogs(limit);
    },
  };
}

export async function runOwnerOperation({ storeDir, operation, args = {}, timeoutMs = 30000 }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = parseStoreLock(readStoreLock(storeDir).info);
    const ownerAlive = info?.pid && isPidAlive(info.pid);
    if (ownerAlive && info.state === 'ready' && info.socketPath) {
      return callOwner({ storeDir, operation, args, timeoutMs: Math.max(1, deadline - Date.now()) });
    }
    if (!info || !ownerAlive || info.state === 'transient') {
      let ownerLock;
      try {
        ownerLock = acquireOwnerLock(storeDir);
      } catch (error) {
        if (!error.message.includes('locked') && !error.message.includes('recovery')) throw error;
      }
      if (ownerLock) {
        let services;
        try {
          services = createServices({ storeDir });
          const handler = createOwnerOperations(services)[operation];
          if (!handler) throw new Error(`Unknown owner operation: ${operation}`);
          return await handler(args, { signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) });
        } finally {
          try {
            if (services) {
              await services.messageSyncService.shutdown();
              await services.telegramClient.destroy();
            }
          } finally {
            ownerLock.release();
          }
        }
      }
    }
    await delay(100);
  }
  throw new Error('Timed out waiting for the store owner');
}
