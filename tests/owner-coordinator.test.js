import { expect, it } from 'vitest';

import { OwnerCoordinator } from '../core/owner-coordinator.js';
import { createOwnerOperations } from '../core/owner-operations.js';

it('bounds live calls and rejects a queued call after its deadline', async () => {
  const coordinator = new OwnerCoordinator({ maxLive: 2 });
  const releases = [];
  let started = 0;
  const hold = () => coordinator.runLive(() => new Promise((resolve) => {
    started += 1;
    releases.push(resolve);
  }));
  const first = hold();
  const second = hold();
  const third = hold();
  expect(started).toBe(2);

  const controller = new AbortController();
  const expired = coordinator.runLive(() => { throw new Error('must not start'); },
    { signal: controller.signal });
  controller.abort();
  await expect(expired).rejects.toMatchObject({ code: 'OWNER_BUSY' });

  releases.shift()('first');
  await new Promise((resolve) => setImmediate(resolve));
  expect(started).toBe(3);
  releases.shift()('second');
  releases.shift()('third');
  expect(await Promise.all([first, second, third])).toEqual(['first', 'second', 'third']);
  expect(coordinator.active).toBe(0);
});

it('lets another CLI live read start while one Telegram request is stalled', async () => {
  const coordinator = new OwnerCoordinator({ maxLive: 2 });
  let resolveFirst;
  let calls = 0;
  const operations = createOwnerOperations({
    storeDir: '/tmp/unused-tgcli-owner-coordinator-test',
    coordinator,
    telegramClient: {
      isAuthorized: async () => true,
      listDialogs: async () => {
        calls += 1;
        if (calls === 1) return new Promise((resolve) => { resolveFirst = resolve; });
        return [{ id: 2 }];
      },
    },
    messageSyncService: {},
  });
  const first = operations['channels.list']({ limit: 1 }, {});
  await new Promise((resolve) => setImmediate(resolve));
  expect(resolveFirst).toBeTypeOf('function');
  const second = operations['channels.list']({ limit: 1 }, {});
  expect(await second).toEqual([{ id: 2 }]);
  resolveFirst([{ id: 1 }]);
  expect(await first).toEqual([{ id: 1 }]);
});

it('keeps logout, sync refresh, and job authorization behind the live limit', async () => {
  const coordinator = new OwnerCoordinator({ maxLive: 1 });
  let releaseFirst;
  const effects = [];
  const operations = createOwnerOperations({
    storeDir: '/tmp/unused-tgcli-owner-coordinator-test',
    coordinator,
    telegramClient: {
      isAuthorized: async () => { effects.push('auth'); return true; },
      listDialogs: async () => new Promise((resolve) => { releaseFirst = resolve; }),
      client: { logout: async () => { effects.push('logout'); } },
    },
    messageSyncService: {
      refreshChannelsFromDialogs: async () => { effects.push('refresh'); },
      addJob: () => { effects.push('add'); },
      retryJobs: () => { effects.push('retry'); return { updated: 0 }; },
    },
  });
  const first = operations['channels.list']({ limit: 1 }, {});
  await new Promise((resolve) => setImmediate(resolve));
  expect(releaseFirst).toBeTypeOf('function');
  const controller = new AbortController();
  const context = { signal: controller.signal };
  const queued = [
    operations['auth.logout']({}, context),
    operations['sync.once']({}, context),
    operations['sync.jobs.add']({ chat: '1' }, context),
    operations['sync.jobs.retry']({ jobId: 1 }, context),
  ];
  controller.abort();
  await Promise.all(queued.map((task) => expect(task).rejects.toMatchObject({ code: 'OWNER_BUSY' })));
  expect(effects).toEqual(['auth']);
  releaseFirst([]);
  await first;
});
