const {
  mtcuteClientCtor,
  mtProxyTransportCtor,
  proxyTransportFromUrlMock,
  socksProxyTransportCtor,
} = vi.hoisted(() => ({
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

  it('normalizes Telegram FakeTLS share-link secrets for mtcute', () => {
    const proxyUrl = 'https://t.me/proxy?server=proxy.example&port=443&secret=ee00112233445566778899aabbccddeeffexample.com';
    new TelegramClient(12345, 'hash', '+1234567890', '/tmp/tgcli-auth-faketls.session', {
      proxy: proxyUrl,
    });

    const normalizedUrl = proxyTransportFromUrlMock.mock.calls[0][0];
    const normalizedSecret = new URL(normalizedUrl).searchParams.get('secret');
    expect(Buffer.from(normalizedSecret, 'base64url')).toEqual(
      Buffer.concat([
        Buffer.from('ee00112233445566778899aabbccddeeff', 'hex'),
        Buffer.from('example.com', 'utf8'),
      ]),
    );
  });
});
