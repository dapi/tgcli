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
  runGroupInviteLinkEdit,
  runGroupInviteLinkGet,
} from '../cli.js';

function createRuntime() {
  const telegramClient = {
    destroy: vi.fn().mockResolvedValue(undefined),
    editGroupInviteLink: vi.fn().mockImplementation(
      async (_chat, link, { requestNeeded }) => ({
        link,
        approvalNeeded: requestNeeded,
        isPrimary: false,
      }),
    ),
    getGroupInviteLink: vi.fn().mockResolvedValue({
      link: 'https://t.me/+invite',
      approvalNeeded: true,
      isPrimary: true,
    }),
    isAuthorized: vi.fn().mockResolvedValue(true),
  };
  const messageSyncService = {
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
  createServicesMock.mockReturnValue({ telegramClient, messageSyncService });
  return { telegramClient, messageSyncService };
}

describe('groups invite edit CLI', () => {
  let readRelease;
  let release;
  let stdoutSpy;

  beforeEach(() => {
    vi.clearAllMocks();
    resolveStoreDirMock.mockReturnValue('/tmp/tgcli-store');
    readRelease = vi.fn();
    release = vi.fn();
    acquireReadLockMock.mockReturnValue(readRelease);
    acquireStoreLockMock.mockReturnValue(release);
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  it('registers edit under groups invite', () => {
    const program = buildProgram();
    const groups = program.commands.find((command) => command.name() === 'groups');
    const invite = groups.commands.find((command) => command.name() === 'invite');

    expect(invite.commands.map((command) => command.name())).toEqual([
      'get',
      'edit',
      'revoke',
    ]);
  });

  it.each([
    ['true', true],
    ['false', false],
  ])('edits request-needed=%s under a write lock', async (rawValue, requestNeeded) => {
    const { telegramClient, messageSyncService } = createRuntime();

    await runGroupInviteLinkEdit(
      { json: true, timeoutMs: null },
      { chat: '@group', link: 'https://t.me/+invite', requestNeeded: rawValue },
    );

    expect(acquireStoreLockMock).toHaveBeenCalledWith('/tmp/tgcli-store');
    expect(telegramClient.editGroupInviteLink).toHaveBeenCalledWith(
      '@group',
      'https://t.me/+invite',
      { requestNeeded },
    );
    expect(JSON.parse(stdoutSpy.mock.calls[0][0])).toEqual({
      channelId: '@group',
      link: 'https://t.me/+invite',
      requestNeeded,
      isPrimary: false,
    });
    expect(messageSyncService.shutdown).toHaveBeenCalled();
    expect(telegramClient.destroy).toHaveBeenCalled();
    expect(release).toHaveBeenCalled();
  });

  it('reads back approval state for the primary link', async () => {
    const { telegramClient } = createRuntime();

    await runGroupInviteLinkGet(
      { json: true, timeoutMs: null },
      { chat: '@group' },
    );

    expect(telegramClient.getGroupInviteLink).toHaveBeenCalledWith('@group');
    expect(JSON.parse(stdoutSpy.mock.calls[0][0])).toEqual({
      link: 'https://t.me/+invite',
      requestNeeded: true,
      isPrimary: true,
    });
  });

  it('requires chat, link, and request-needed', async () => {
    createRuntime();

    await expect(runGroupInviteLinkEdit(
      { json: true, timeoutMs: null },
      { link: 'https://t.me/+invite', requestNeeded: 'true' },
    )).rejects.toThrow('--chat is required');
    await expect(runGroupInviteLinkEdit(
      { json: true, timeoutMs: null },
      { chat: '@group', requestNeeded: 'true' },
    )).rejects.toThrow('--link is required');
    await expect(runGroupInviteLinkEdit(
      { json: true, timeoutMs: null },
      { chat: '@group', link: 'https://t.me/+invite' },
    )).rejects.toThrow('--request-needed is required');
  });
});
