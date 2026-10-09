import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
  classifyCliRoute,
  executeOwnerCliCommand,
  runMessageButtonClick,
  runMessageButtonsList,
} from '../cli.js';

function createRuntime() {
  const telegramClient = {
    destroy: vi.fn().mockResolvedValue(undefined),
    isAuthorized: vi.fn().mockResolvedValue(true),
    getMessageById: vi.fn().mockResolvedValue({
      inline_buttons: [{
        row: 1,
        column: 1,
        text: 'CustDev AI',
        type: 'callback',
        actionable: true,
        requiresPassword: false,
      }],
    }),
    clickInlineButton: vi.fn().mockResolvedValue({
      messageId: 42,
      button: { row: 1, column: 1, text: 'CustDev AI', type: 'callback' },
      answer: { message: null, alert: false, url: null, cacheTime: 0 },
    }),
  };
  const messageSyncService = {
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
  createServicesMock.mockReturnValue({ telegramClient, messageSyncService });
  return { telegramClient, messageSyncService };
}

describe('messages buttons CLI', () => {
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

  it('registers list and click commands', () => {
    const program = buildProgram();
    const messages = program.commands.find((command) => command.name() === 'messages');
    const buttons = messages.commands.find((command) => command.name() === 'buttons');

    expect(buttons.commands.map((command) => command.name())).toEqual(['list', 'click']);
    expect(classifyCliRoute('messages buttons list')).toBe('owner');
    expect(classifyCliRoute('messages buttons click')).toBe('owner');
  });

  it('lists button metadata under a read lock', async () => {
    const { telegramClient } = createRuntime();

    await runMessageButtonsList(
      { json: true, timeoutMs: null },
      { chat: '@BotFather', id: '42' },
    );

    expect(acquireReadLockMock).toHaveBeenCalledWith('/tmp/tgcli-store');
    expect(acquireStoreLockMock).not.toHaveBeenCalled();
    expect(telegramClient.getMessageById).toHaveBeenCalledWith('@BotFather', 42);
    expect(JSON.parse(stdoutSpy.mock.calls[0][0])).toMatchObject({
      channelId: '@BotFather',
      messageId: 42,
      buttons: [{ row: 1, column: 1, text: 'CustDev AI' }],
    });
    expect(readRelease).toHaveBeenCalled();
  });

  it('clicks one button under a write lock', async () => {
    const { telegramClient } = createRuntime();

    await runMessageButtonClick(
      { json: true, timeoutMs: null },
      { chat: '@BotFather', id: '42', row: '1', column: '1' },
    );

    expect(acquireStoreLockMock).toHaveBeenCalledWith('/tmp/tgcli-store');
    expect(telegramClient.clickInlineButton).toHaveBeenCalledWith('@BotFather', 42, {
      row: 1,
      column: 1,
    });
    expect(JSON.parse(stdoutSpy.mock.calls[0][0])).toMatchObject({
      channelId: '@BotFather',
      messageId: 42,
    });
    expect(writeRelease).toHaveBeenCalled();
  });

  it('uses the owner services without acquiring another store lock', async () => {
    const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcli-buttons-owner-'));
    const { telegramClient, messageSyncService } = createRuntime();
    try {
      const result = await executeOwnerCliCommand({
        commandPath: 'messages buttons list',
        args: [{ chat: '@BotFather', id: '42' }],
        flags: { json: true, timeoutMs: null },
      }, { telegramClient, messageSyncService }, storeDir);
      expect(JSON.parse(result.stdout)).toMatchObject({ messageId: 42 });
      expect(acquireReadLockMock).not.toHaveBeenCalled();
      expect(telegramClient.destroy).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(storeDir, { recursive: true, force: true });
    }
  });
});
