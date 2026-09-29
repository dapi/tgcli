import { setTimeout as delay } from 'node:timers/promises';

import { createServices } from './services.js';
import { callOwner } from './owner-ipc.js';
import { OwnerCoordinator } from './owner-coordinator.js';
import { acquireOwnerLock, isPidAlive, parseStoreLock, readStoreLock } from '../store-lock.js';

let cliModulePromise;
function loadCliModule() {
  cliModulePromise ??= import('../cli.js').catch((error) => {
    cliModulePromise = null;
    throw error;
  });
  return cliModulePromise;
}

export function createOwnerOperations({ storeDir, telegramClient, messageSyncService, onAuthLogout,
  coordinator = new OwnerCoordinator() }) {
  return {
    'auth.current': (_, context) => coordinator.runLive(async () => {
      const me = await telegramClient.getCurrentUser();
      return { authenticated: Boolean(me), username: me?.username ?? null };
    }, context),
    'auth.logout': async () => {
      await telegramClient.client.logout();
      if (onAuthLogout) setTimeout(() => void onAuthLogout(), 250);
      return { loggedOut: true };
    },
    'sync.status': () => ({ queue: messageSyncService.getQueueStats() }),
    'doctor.status': ({ connect = false }, context) => coordinator.runLive(async () => {
      const authenticated = await telegramClient.isAuthorized().catch(() => false);
      if (connect && authenticated) await telegramClient.startUpdates();
      return {
        authenticated,
        connected: Boolean(connect && authenticated),
        search: messageSyncService.getSearchStatus(),
        queue: messageSyncService.getQueueStats(),
      };
    }, context),
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
    'sync.jobs.add': async ({ chat, depth, minDate }) => {
      if (!(await telegramClient.isAuthorized().catch(() => false))) {
        throw new Error('Not authenticated. Run `tgcli auth` first.');
      }
      const job = messageSyncService.addJob(chat, { depth, minDate });
      void messageSyncService.processQueue();
      return job;
    },
    'sync.jobs.retry': async ({ jobId, channelId, allErrors }) => {
      const result = messageSyncService.retryJobs({ jobId, channelId, allErrors });
      const authed = await telegramClient.isAuthorized().catch(() => false);
      if (authed && result.updated > 0) void messageSyncService.processQueue();
      return result;
    },
    'sync.jobs.cancel': ({ jobId, channelId }) =>
      messageSyncService.cancelJobs({ jobId, channelId }),
    'channels.list': ({ query, limit }, context) => coordinator.runLive(async () => {
      if (!(await telegramClient.isAuthorized().catch(() => false))) {
        throw new Error('Not authenticated. Run `tgcli auth` first.');
      }
      return query
        ? telegramClient.searchDialogs(query, limit)
        : telegramClient.listDialogs(limit);
    }, context),
    'cli.execute': (request, context) => coordinator.runLive(async () => {
      const { executeOwnerCliCommand } = await loadCliModule();
      return executeOwnerCliCommand(request, { telegramClient, messageSyncService }, storeDir);
    }, context),
  };
}

export async function runOwnerOperation({ storeDir, operation, args = {}, timeoutMs = null, localHandler }) {
  const deadline = Date.now() + (timeoutMs ?? 30000);
  while (Date.now() < deadline) {
    const info = parseStoreLock(readStoreLock(storeDir).info);
    const ownerAlive = info?.pid && isPidAlive(info.pid);
    if (ownerAlive && info.state === 'ready' && info.socketPath) {
      return callOwner({ storeDir, operation, args,
        timeoutMs: timeoutMs === null ? 24 * 60 * 60 * 1000 : Math.max(1, deadline - Date.now()) });
    }
    if (!info || !ownerAlive || info.state === 'transient') {
      let ownerLock;
      try {
        ownerLock = acquireOwnerLock(storeDir);
      } catch (error) {
        if (!error.message.includes('locked') && !error.message.includes('recovery')) throw error;
      }
      if (ownerLock) {
        const work = (async () => {
          let services;
          try {
            if (localHandler) return await localHandler();
            services = createServices({ storeDir });
            const handler = createOwnerOperations(services)[operation];
            if (!handler) throw new Error(`Unknown owner operation: ${operation}`);
            return await handler(args, { signal: timeoutMs === null
              ? undefined : AbortSignal.timeout(Math.max(1, deadline - Date.now())) });
          } finally {
            let cleanupError;
            if (services) {
              try { await services.messageSyncService.shutdown(); } catch (error) { cleanupError = error; }
              try { await services.telegramClient.destroy(); } catch (error) { cleanupError ??= error; }
            }
            try {
              ownerLock.release();
            } catch (error) {
              cleanupError ??= error;
            }
            if (cleanupError) throw cleanupError;
          }
        })();
        if (timeoutMs === null) return work;
        const remaining = Math.max(1, deadline - Date.now());
        let timer;
        try {
          return await Promise.race([work, new Promise((_, reject) => {
            timer = setTimeout(() => {
              const error = new Error('Local owner operation timed out; its result is unknown');
              error.code = 'UNKNOWN_RESULT';
              reject(error);
            }, remaining);
          })]);
        } finally {
          clearTimeout(timer);
        }
      }
    }
    await delay(100);
  }
  throw new Error('Timed out waiting for the store owner');
}
