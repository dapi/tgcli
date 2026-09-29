import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { PassThrough } from 'node:stream';

const {
  mtcuteClientCtor,
  proxyTransportFromUrlMock,
} = vi.hoisted(() => ({
  mtcuteClientCtor: vi.fn(function () {
    return {
      destroy: vi.fn().mockResolvedValue(undefined),
      stopUpdatesLoop: vi.fn().mockResolvedValue(undefined),
      onRawUpdate: { remove: vi.fn() },
    };
  }),
  proxyTransportFromUrlMock: vi.fn((url) => ({ proxyUrl: url })),
}));

vi.mock('@mtcute/node', () => ({
  HttpProxyTcpTransport: vi.fn(),
  MtProxyTcpTransport: vi.fn(),
  SocksProxyTcpTransport: vi.fn(),
  TelegramClient: mtcuteClientCtor,
  proxyTransportFromUrl: proxyTransportFromUrlMock,
}));

vi.mock('@mtcute/core', () => ({
  InputMedia: {},
}));

import { beforeEach, describe, expect, it, vi } from 'vitest';

import TelegramClient from '../telegram-client.js';

describe('telegram client auth bootstrap options', () => {
  beforeEach(() => {
    mtcuteClientCtor.mockReset();
    proxyTransportFromUrlMock.mockClear();
    mtcuteClientCtor.mockImplementation(function () {
      return {
        destroy: vi.fn().mockResolvedValue(undefined),
        stopUpdatesLoop: vi.fn().mockResolvedValue(undefined),
        onRawUpdate: { remove: vi.fn() },
      };
    });
  });

  it('disables mtcute updates when requested', () => {
    new TelegramClient(12345, 'hash', '+1234567890', '/tmp/tgcli-auth-disable-updates.session', {
      disableUpdates: true,
    });

    expect(mtcuteClientCtor).toHaveBeenCalledWith(expect.objectContaining({
      apiId: 12345,
      apiHash: 'hash',
      disableUpdates: true,
    }));
    expect(mtcuteClientCtor.mock.calls[0][0]).not.toHaveProperty('updates');
  });

  it('keeps updates configuration enabled by default', () => {
    new TelegramClient(12345, 'hash', '+1234567890', '/tmp/tgcli-auth-with-updates.session');

    expect(mtcuteClientCtor).toHaveBeenCalledWith(expect.objectContaining({
      apiId: 12345,
      apiHash: 'hash',
      updates: expect.objectContaining({
        catchUp: true,
      }),
    }));
    expect(mtcuteClientCtor.mock.calls[0][0]).not.toHaveProperty('disableUpdates');
  });

  it('routes MTProto traffic through the configured proxy', () => {
    const proxyUrl = 'socks5://127.0.0.1:1080';
    new TelegramClient(12345, 'hash', '+1234567890', '/tmp/tgcli-auth-proxy.session', {
      proxy: proxyUrl,
    });

    expect(proxyTransportFromUrlMock).toHaveBeenCalledWith(proxyUrl);
    const transport = mtcuteClientCtor.mock.calls[0][0].transport;
    expect(transport).toEqual(expect.objectContaining({ proxyUrl }));
  });

  it('normalizes Telegram FakeTLS share-link secrets for mtcute', () => {
    const proxyUrl = 'https://t.me/proxy?server=proxy.example&port=443&secret=ee00112233445566778899aabbccddeeff6578616d706c652e636f6d';
    new TelegramClient(12345, 'hash', '+1234567890', '/tmp/tgcli-auth-faketls.session', {
      proxy: proxyUrl,
    });

    const normalizedUrl = proxyTransportFromUrlMock.mock.calls[0][0];
    const normalizedSecret = new URL(normalizedUrl).searchParams.get('secret');
    expect(Buffer.from(normalizedSecret, 'base64url')).toEqual(
      Buffer.from('ee00112233445566778899aabbccddeeff6578616d706c652e636f6d', 'hex'),
    );
  });

  it('renders a QR without printing its login token as text', () => {
    const client = new TelegramClient(12345, 'hash', '', '/tmp/tgcli-auth-qr.session', { useQr: true });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const url = 'tg://login?token=private-login-token';

    try {
      client._buildStartParams().qrCodeHandler(url, new Date('2026-09-28T12:00:00Z'));
      expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining(url));
      expect(logSpy).toHaveBeenCalledWith('Waiting for Telegram to confirm the QR login...');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('explains pending QR 2FA and does not submit an empty password', async () => {
    const client = new TelegramClient(12345, 'hash', '', '/tmp/tgcli-auth-qr-2fa.session', { useQr: true });
    const ask = vi.spyOn(client, '_askHiddenQuestion')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('correct-password');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      const params = client._buildStartParams();
      expect(await params.password()).toBe('correct-password');
      expect(ask).toHaveBeenCalledTimes(2);
      expect(ask).toHaveBeenCalledWith('Telegram requires your 2FA password to finish QR login: ');
      expect(logSpy).toHaveBeenCalledWith('A 2FA password is required here. Press Ctrl+C to cancel login.');
      params.invalidCodeCallback('password');
      expect(logSpy).toHaveBeenCalledWith('Telegram rejected that 2FA password. Try again.');
      expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('correct-password'));
    } finally {
      logSpy.mockRestore();
    }
  });

  it('closes an interactive prompt when the client is destroyed', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const prompt = readline.createInterface({ input, output, terminal: true });
    prompt.question('Password: ', () => {});
    const client = Object.create(TelegramClient.prototype);
    client.client = { destroy: vi.fn().mockResolvedValue(undefined) };
    client.activeReadline = prompt;
    client.updatesRunning = false;
    client.rawUpdateHandler = null;

    try {
      await client.destroy();
      expect(prompt.closed).toBe(true);
      expect(client.activeReadline).toBe(null);
    } finally {
      input.destroy();
      output.destroy();
    }
  });

  it('lets a timed-out login process exit while stdin remains open', async () => {
    const childScript = `
      import TelegramClient from './telegram-client.js';
      const client = Object.create(TelegramClient.prototype);
      client.client = { destroy: async () => {} };
      client.updatesRunning = false;
      client.rawUpdateHandler = null;
      void client._askQuestion('code: ');
      setTimeout(() => { void client.destroy(); }, 100);
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', childScript], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let timeoutId;

    try {
      const exitCode = await Promise.race([
        new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('exit', (code) => resolve(code));
        }),
        new Promise((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error('Login process kept stdin open')), 5000);
        }),
      ]);
      expect(exitCode).toBe(0);
    } finally {
      clearTimeout(timeoutId);
      child.kill();
      child.stdin.destroy();
    }
  });

});
