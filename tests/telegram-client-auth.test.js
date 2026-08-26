const {
  httpProxyTransportCtor,
  mtcuteClientCtor,
  mtProxyTransportCtor,
  proxyTransportFromUrlMock,
  socksProxyTransportCtor,
} = vi.hoisted(() => ({
  httpProxyTransportCtor: vi.fn(function (proxy) {
    this.proxy = proxy;
  }),
  mtcuteClientCtor: vi.fn(function () {
    return {
      destroy: vi.fn().mockResolvedValue(undefined),
      stopUpdatesLoop: vi.fn().mockResolvedValue(undefined),
      onRawUpdate: { remove: vi.fn() },
    };
  }),
  mtProxyTransportCtor: vi.fn(function (proxy) {
    this.proxy = proxy;
  }),
  proxyTransportFromUrlMock: vi.fn((url) => ({ proxyUrl: url })),
  socksProxyTransportCtor: vi.fn(function (proxy) {
    this.proxy = proxy;
  }),
}));

vi.mock('@mtcute/node', () => ({
  HttpProxyTcpTransport: httpProxyTransportCtor,
  MtProxyTcpTransport: mtProxyTransportCtor,
  SocksProxyTcpTransport: socksProxyTransportCtor,
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
    httpProxyTransportCtor.mockClear();
    mtProxyTransportCtor.mockClear();
    socksProxyTransportCtor.mockClear();
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
    new TelegramClient(12345, 'hash', '+1234567890', '/tmp/tgcli-auth-proxy.session', {
      proxy: 'socks5://127.0.0.1:1080',
    });

    const transport = mtcuteClientCtor.mock.calls[0][0].transport;
    expect(proxyTransportFromUrlMock).toHaveBeenCalledWith('socks5://127.0.0.1:1080');
    expect(transport).toEqual({ proxyUrl: 'socks5://127.0.0.1:1080' });
  });

  it('verifies the selected account identity before reporting authorization', async () => {
    const me = { id: 123456789n, phone: '77071112233' };
    const identityVerifier = vi.fn();
    mtcuteClientCtor.mockImplementationOnce(function () {
      return {
        getMe: vi.fn().mockResolvedValue(me),
        destroy: vi.fn().mockResolvedValue(undefined),
        stopUpdatesLoop: vi.fn().mockResolvedValue(undefined),
        onRawUpdate: { remove: vi.fn() },
      };
    });
    const client = new TelegramClient(12345, 'hash', '+77071112233', '/tmp/tgcli-auth-identity.session', {
      identityVerifier,
    });

    await expect(client.isAuthorized()).resolves.toBe(true);
    expect(identityVerifier).toHaveBeenCalledWith(me);
  });

  it('fails closed when the account identity verifier rejects the session', async () => {
    mtcuteClientCtor.mockImplementationOnce(function () {
      return {
        getMe: vi.fn().mockResolvedValue({ id: 987654321n, phone: '77071112233' }),
        destroy: vi.fn().mockResolvedValue(undefined),
        stopUpdatesLoop: vi.fn().mockResolvedValue(undefined),
        onRawUpdate: { remove: vi.fn() },
      };
    });
    const client = new TelegramClient(12345, 'hash', '+77071112233', '/tmp/tgcli-auth-crossed.session', {
      identityVerifier: () => {
        throw new Error('Account identity mismatch for work');
      },
    });

    await expect(client.isAuthorized()).rejects.toThrow(/identity mismatch/i);
  });

  it('verifies identity immediately after a fresh interactive login', async () => {
    const unauthorized = Object.assign(new Error('AUTH_KEY_UNREGISTERED'), { code: 401 });
    const me = { id: 987654321n, phone: '77079990000' };
    const getMe = vi.fn()
      .mockRejectedValueOnce(unauthorized)
      .mockResolvedValueOnce(me);
    const start = vi.fn().mockResolvedValue(undefined);
    const identityVerifier = vi.fn(() => {
      throw new Error('Account phone mismatch for work');
    });
    mtcuteClientCtor.mockImplementationOnce(function () {
      return {
        getMe,
        start,
        destroy: vi.fn().mockResolvedValue(undefined),
        stopUpdatesLoop: vi.fn().mockResolvedValue(undefined),
        onRawUpdate: { remove: vi.fn() },
      };
    });
    const client = new TelegramClient(12345, 'hash', '+77071112233', '/tmp/tgcli-auth-fresh-crossed.session', {
      identityVerifier,
    });

    await expect(client.login()).resolves.toBe(false);
    expect(start).toHaveBeenCalledTimes(1);
    expect(identityVerifier).toHaveBeenCalledWith(me);
  });
});
