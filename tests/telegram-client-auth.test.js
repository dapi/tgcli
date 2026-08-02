const {
  httpProxyTransportCtor,
  mtcuteClientCtor,
  mtProxyTransportCtor,
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
  socksProxyTransportCtor: vi.fn(function (proxy) {
    this.proxy = proxy;
  }),
}));

vi.mock('@mtcute/node', () => ({
  HttpProxyTcpTransport: httpProxyTransportCtor,
  MtProxyTcpTransport: mtProxyTransportCtor,
  SocksProxyTcpTransport: socksProxyTransportCtor,
  TelegramClient: mtcuteClientCtor,
}));

vi.mock('@mtcute/core', () => ({
  InputMedia: {},
}));

import { beforeEach, describe, expect, it, vi } from 'vitest';

import TelegramClient from '../telegram-client.js';

describe('telegram client auth bootstrap options', () => {
  beforeEach(() => {
    mtcuteClientCtor.mockReset();
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

    expect(socksProxyTransportCtor).toHaveBeenCalledWith({
      host: '127.0.0.1',
      port: 1080,
      user: undefined,
      password: undefined,
      version: 5,
    });
    expect(mtcuteClientCtor.mock.calls[0][0]).toEqual(expect.objectContaining({
      transport: expect.objectContaining({
        proxy: expect.objectContaining({ host: '127.0.0.1', port: 1080, version: 5 }),
      }),
    }));
  });
});
