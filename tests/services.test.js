import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { telegramClientCtor, messageSyncServiceCtor } = vi.hoisted(() => ({
  telegramClientCtor: vi.fn(function (...args) {
    return { kind: 'telegram', args };
  }),
  messageSyncServiceCtor: vi.fn(function (...args) {
    return { kind: 'sync', args };
  }),
}));

vi.mock('../telegram-client.js', () => ({
  default: telegramClientCtor,
}));

vi.mock('../message-sync-service.js', () => ({
  default: messageSyncServiceCtor,
}));

import {
  createMessageSyncService,
  createServices,
  createTelegramClient,
} from '../core/services.js';
import { addAccount } from '../core/accounts.js';

describe('core services helpers', () => {
  let storeDir;

  beforeEach(() => {
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcli-services-test-'));
    fs.writeFileSync(path.join(storeDir, 'config.json'), JSON.stringify({
      apiId: '12345',
      apiHash: 'hash-value',
      phoneNumber: '+1234567890',
      proxy: 'socks5://127.0.0.1:1080',
    }));
    telegramClientCtor.mockClear();
    messageSyncServiceCtor.mockClear();
  });

  afterEach(() => {
    fs.rmSync(storeDir, { recursive: true, force: true });
  });

  it('creates a telegram client without bootstrapping the archive service', () => {
    const result = createTelegramClient({
      storeDir,
      forceSms: true,
      useQr: true,
      disableUpdates: true,
    });

    expect(telegramClientCtor).toHaveBeenCalledWith(
      '12345',
      'hash-value',
      '+1234567890',
      path.join(storeDir, 'session.json'),
      {
        forceSms: true,
        useQr: true,
        disableUpdates: true,
        proxy: 'socks5://127.0.0.1:1080',
      },
    );
    expect(messageSyncServiceCtor).not.toHaveBeenCalled();
    expect(result.sessionPath).toBe(path.join(storeDir, 'session.json'));
  });

  it('creates a message sync service on demand for an existing telegram client', () => {
    const fakeClient = { kind: 'telegram' };
    const result = createMessageSyncService(fakeClient, {
      storeDir,
      batchSize: 7,
      interJobDelayMs: 11,
      interBatchDelayMs: 13,
    });

    expect(messageSyncServiceCtor).toHaveBeenCalledWith(fakeClient, {
      dbPath: path.join(storeDir, 'messages.db'),
      batchSize: 7,
      interJobDelayMs: 11,
      interBatchDelayMs: 13,
    });
    expect(result.dbPath).toBe(path.join(storeDir, 'messages.db'));
  });

  it('keeps the legacy createServices composition intact', () => {
    const result = createServices({ storeDir });

    expect(telegramClientCtor).toHaveBeenCalledTimes(1);
    expect(messageSyncServiceCtor).toHaveBeenCalledTimes(1);
    expect(result.sessionPath).toBe(path.join(storeDir, 'session.json'));
    expect(result.dbPath).toBe(path.join(storeDir, 'messages.db'));
  });

  it('installs a fail-closed identity verifier for named account stores', () => {
    const account = addAccount(storeDir, {
      id: 'work',
      phoneNumber: '+77071112233',
    });
    fs.writeFileSync(path.join(account.storeDir, 'config.json'), JSON.stringify({
      apiId: '12345',
      apiHash: 'hash-value',
      phoneNumber: '+77071112233',
    }));

    createTelegramClient({ storeDir: account.storeDir, disableUpdates: true });

    const options = telegramClientCtor.mock.calls[0][4];
    expect(options.identityVerifier).toBeTypeOf('function');
    expect(() => options.identityVerifier({ id: 1n, phoneNumber: '77071112233' })).not.toThrow();
    expect(() => options.identityVerifier({ id: 1n, phone: '77079990000' })).toThrow(/phone mismatch/i);
  });

  it('refuses a named account store whose identity metadata was removed', () => {
    const account = addAccount(storeDir, {
      id: 'work',
      phoneNumber: '+77071112233',
    });
    fs.writeFileSync(path.join(account.storeDir, 'config.json'), JSON.stringify({
      apiId: '12345',
      apiHash: 'hash-value',
      phoneNumber: '+77071112233',
    }));
    fs.unlinkSync(path.join(account.storeDir, 'account.json'));

    expect(() => createTelegramClient({
      storeDir: account.storeDir,
      disableUpdates: true,
    })).toThrow(/account metadata.*missing|missing.*account metadata/i);
    expect(telegramClientCtor).not.toHaveBeenCalled();
  });

  it('TELEGRAM_PROXY env var overrides proxy from config.json', () => {
    process.env.TELEGRAM_PROXY = 'mtproto://proxy.example.com:20123?secret=aabbcc';
    try {
      createTelegramClient({ storeDir, disableUpdates: true });
      expect(telegramClientCtor.mock.calls[0][4]).toMatchObject({
        proxy: 'mtproto://proxy.example.com:20123?secret=aabbcc',
      });
    } finally {
      delete process.env.TELEGRAM_PROXY;
    }
  });

  it('TELEGRAM_PROXY env var is used when config.json has no proxy', () => {
    fs.writeFileSync(path.join(storeDir, 'config.json'), JSON.stringify({
      apiId: '12345',
      apiHash: 'hash-value',
      phoneNumber: '+1234567890',
    }));
    process.env.TELEGRAM_PROXY = 'socks5://127.0.0.1:9050';
    try {
      createTelegramClient({ storeDir, disableUpdates: true });
      expect(telegramClientCtor.mock.calls[0][4]).toMatchObject({
        proxy: 'socks5://127.0.0.1:9050',
      });
    } finally {
      delete process.env.TELEGRAM_PROXY;
    }
  });
});
