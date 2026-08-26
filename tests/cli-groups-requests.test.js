import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  acquireReadLockMock,
  acquireStoreLockMock,
  createServicesMock,
  resolveStoreDirMock,
} = vi.hoisted(() => ({
  acquireReadLockMock: vi.fn(),
  acquireStoreLockMock: vi.fn(),
  createServicesMock: vi.fn(),
  resolveStoreDirMock: vi.fn(),
}));

vi.mock('../store-lock.js', () => ({
  acquireReadLock: acquireReadLockMock,
  acquireStoreLock: acquireStoreLockMock,
  readStoreLock: vi.fn(),
}));

vi.mock('../core/services.js', () => ({
  createMessageSyncService: vi.fn(),
  createServices: createServicesMock,
  createTelegramClient: vi.fn(),
}));

vi.mock('../core/store.js', () => ({
  resolveStoreDir: resolveStoreDirMock,
}));

import {
  buildProgram,
  runGroupJoinRequestApprove,
  runGroupJoinRequestDecline,
  runGroupJoinRequestsList,
} from '../cli.js';

function createRuntime() {
  const telegramClient = {
    destroy: vi.fn().mockResolvedValue(undefined),
    isAuthorized: vi.fn().mockResolvedValue(true),
    listGroupJoinRequests: vi.fn().mockResolvedValue({
      total: 1,
      returned: 1,
      hasMore: false,
      requests: [{ userId: '123', displayName: 'Alice' }],
    }),
    resolveGroupJoinRequest: vi.fn().mockResolvedValue(true),
  };
  const messageSyncService = {
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
  createServicesMock.mockReturnValue({ telegramClient, messageSyncService });
  return { telegramClient, messageSyncService };
}

describe('groups requests CLI', () => {
  let readRelease;
  let writeRelease;
  let stdoutSpy;

  beforeEach(() => {
    vi.clearAllMocks();
    resolveStoreDirMock.mockReturnValue('/tmp/tgcli-store');
    readRelease = vi.fn();
    writeRelease = vi.fn();
    acquireReadLockMock.mockReturnValue(readRelease);
    acquireStoreLockMock.mockReturnValue(writeRelease);
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  it('registers list, approve, and decline commands', () => {
    const program = buildProgram();
    const groups = program.commands.find((command) => command.name() === 'groups');
    const requests = groups.commands.find((command) => command.name() === 'requests');

    expect(requests.commands.map((command) => command.name())).toEqual([
      'list',
      'approve',
      'decline',
    ]);
  });

  it('lists requests under a read lock with JSON output', async () => {
    const { telegramClient, messageSyncService } = createRuntime();

    await runGroupJoinRequestsList(
      { json: true, timeoutMs: null },
      { chat: '@group', limit: '25', query: 'alice' },
    );

    expect(acquireReadLockMock).toHaveBeenCalledWith('/tmp/tgcli-store');
    expect(acquireStoreLockMock).not.toHaveBeenCalled();
    expect(telegramClient.listGroupJoinRequests).toHaveBeenCalledWith('@group', {
      limit: 25,
      query: 'alice',
      link: undefined,
    });
    expect(JSON.parse(stdoutSpy.mock.calls[0][0])).toMatchObject({
      channelId: '@group',
      total: 1,
      returned: 1,
    });
    expect(messageSyncService.shutdown).toHaveBeenCalled();
    expect(telegramClient.destroy).toHaveBeenCalled();
    expect(readRelease).toHaveBeenCalled();
  });

  it.each([
    ['approve', runGroupJoinRequestApprove],
    ['decline', runGroupJoinRequestDecline],
  ])('resolves one request with the %s action under a write lock', async (action, runner) => {
    const { telegramClient } = createRuntime();

    await runner(
      { json: true, timeoutMs: null },
      { chat: '@group', user: '123' },
    );

    expect(acquireStoreLockMock).toHaveBeenCalledWith('/tmp/tgcli-store');
    expect(telegramClient.resolveGroupJoinRequest).toHaveBeenCalledWith('@group', '123', action);
    expect(JSON.parse(stdoutSpy.mock.calls[0][0])).toEqual({
      channelId: '@group',
      userId: '123',
      action,
      ok: true,
    });
    expect(writeRelease).toHaveBeenCalled();
  });

  it('requires both chat and user for mutations', async () => {
    createRuntime();

    await expect(runGroupJoinRequestApprove(
      { json: true, timeoutMs: null },
      { chat: '@group' },
    )).rejects.toThrow('--user is required');
  });
});
