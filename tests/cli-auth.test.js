import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  acquireStoreLockMock,
  bindAccountIdentityMock,
  createTelegramClientMock,
  createMessageSyncServiceMock,
  loadConfigMock,
  normalizeConfigMock,
  resolveStoreDirMock,
  validateConfigMock,
} = vi.hoisted(() => ({
  acquireStoreLockMock: vi.fn(),
  bindAccountIdentityMock: vi.fn(),
  createTelegramClientMock: vi.fn(),
  createMessageSyncServiceMock: vi.fn(),
  loadConfigMock: vi.fn(),
  normalizeConfigMock: vi.fn(),
  resolveStoreDirMock: vi.fn(),
  validateConfigMock: vi.fn(),
}));

vi.mock('../store-lock.js', () => ({
  acquireStoreLock: acquireStoreLockMock,
  acquireReadLock: vi.fn(),
  readStoreLock: vi.fn(),
}));

vi.mock('../core/config.js', () => ({
  loadConfig: loadConfigMock,
  normalizeConfig: normalizeConfigMock,
  saveConfig: vi.fn(),
  validateConfig: validateConfigMock,
}));

vi.mock('../core/services.js', () => ({
  createMessageSyncService: createMessageSyncServiceMock,
  createServices: vi.fn(),
  createTelegramClient: createTelegramClientMock,
}));

vi.mock('../core/accounts.js', () => ({
  addAccount: vi.fn(),
  bindAccountIdentity: bindAccountIdentityMock,
  listAccounts: vi.fn(),
  resolveAccountContext: vi.fn(),
}));

vi.mock('../core/store.js', () => ({
  resolveStoreDir: resolveStoreDirMock,
}));

import { isCliEntrypoint, runAuthLogin } from '../cli.js';

describe('cli auth command', () => {
  let logSpy;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    resolveStoreDirMock.mockReturnValue('/tmp/tgcli-store');
    loadConfigMock.mockReturnValue({
      config: {
        apiId: '12345',
        apiHash: 'hash',
        phoneNumber: '+1234567890',
      },
    });
    normalizeConfigMock.mockImplementation((config) => config);
    validateConfigMock.mockReturnValue([]);
    acquireStoreLockMock.mockReturnValue(vi.fn());
    bindAccountIdentityMock.mockReset();
    createMessageSyncServiceMock.mockReset();
    createTelegramClientMock.mockReset();
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('completes auth without bootstrapping archive sync by default', async () => {
    const destroy = vi.fn().mockResolvedValue(undefined);
    const login = vi.fn().mockResolvedValue(true);
    createTelegramClientMock.mockReturnValue({
      telegramClient: {
        destroy,
        login,
      },
    });

    await runAuthLogin({ json: false, timeoutMs: null }, {});

    expect(login).toHaveBeenCalledTimes(1);
    expect(createMessageSyncServiceMock).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      'Authenticated. Run `tgcli sync --once` or `tgcli sync --follow` when you need archive data.',
    );
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('binds a named account to the authenticated Telegram user after login', async () => {
    const me = { id: 123456789n, phone: '77071112233' };
    const destroy = vi.fn().mockResolvedValue(undefined);
    createTelegramClientMock.mockReturnValue({
      telegramClient: {
        destroy,
        getCurrentUser: vi.fn().mockResolvedValue(me),
        login: vi.fn().mockResolvedValue(true),
      },
    });

    await runAuthLogin({
      account: { id: 'work', storeDir: '/tmp/tgcli-store' },
      json: false,
      timeoutMs: null,
    }, {});

    expect(bindAccountIdentityMock).toHaveBeenCalledWith('/tmp/tgcli-store', me);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('receives QR login updates and verifies the saved session before reporting success', async () => {
    const loginClient = {
      destroy: vi.fn().mockResolvedValue(undefined),
      login: vi.fn().mockResolvedValue(true),
    };
    const statusClient = {
      destroy: vi.fn().mockResolvedValue(undefined),
      getCurrentUser: vi.fn().mockResolvedValue({ id: 123456789n }),
    };
    createTelegramClientMock
      .mockReturnValueOnce({ telegramClient: loginClient })
      .mockReturnValueOnce({ telegramClient: statusClient });

    await runAuthLogin({ json: false, timeoutMs: null }, { qr: true });

    expect(createTelegramClientMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
      useQr: true,
      disableUpdates: false,
    }));
    expect(createTelegramClientMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
      disableUpdates: true,
    }));
    expect(loginClient.destroy).toHaveBeenCalledTimes(1);
    expect(statusClient.getCurrentUser).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith('QR login verified from saved session.');
    expect(statusClient.destroy).toHaveBeenCalledTimes(1);
  });

  it('does not report QR login success when the saved session is unauthorized', async () => {
    createTelegramClientMock
      .mockReturnValueOnce({ telegramClient: {
        destroy: vi.fn().mockResolvedValue(undefined),
        login: vi.fn().mockResolvedValue(true),
      } })
      .mockReturnValueOnce({ telegramClient: {
        destroy: vi.fn().mockResolvedValue(undefined),
        getCurrentUser: vi.fn().mockResolvedValue(null),
      } });

    await expect(runAuthLogin({ json: false, timeoutMs: null }, { qr: true }))
      .rejects.toThrow('saved session is not authorized');
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('Authenticated.'));
  });

  it('treats symlinked tgcli binaries as the cli entrypoint', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcli-cli-entrypoint-'));
    const symlinkPath = path.join(tmpDir, 'tgcli');

    try {
      fs.symlinkSync(path.join(process.cwd(), 'cli.js'), symlinkPath);
      expect(isCliEntrypoint(symlinkPath)).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
