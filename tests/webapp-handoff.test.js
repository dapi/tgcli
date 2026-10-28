import { describe, expect, it, vi } from 'vitest';

import TelegramClient from '../telegram-client.js';
import { startWebAppHandoff } from '../core/webapp-handoff.js';

describe('Telegram Mini App handoff', () => {
  it('requests the main app from the authenticated Telegram client', async () => {
    const client = Object.create(TelegramClient.prototype);
    client.ensureLogin = vi.fn().mockResolvedValue(undefined);
    client.client = { openWebview: vi.fn().mockResolvedValue({
      url: 'https://example.org/app#tgWebAppData=signed-private-value',
    }) };

    const result = await client.openMainWebApp('@BotFather');

    expect(client.client.openWebview).toHaveBeenCalledWith({
      bot: '@BotFather', webview: { type: 'main' }, platform: 'macos',
    });
    expect(result.url).toContain('tgWebAppData=signed-private-value');
  });

  it('rejects a non-HTTPS Mini App URL', async () => {
    const client = Object.create(TelegramClient.prototype);
    client.ensureLogin = vi.fn().mockResolvedValue(undefined);
    client.client = { openWebview: vi.fn().mockResolvedValue({ url: 'http://example.org/app' }) };
    await expect(client.openMainWebApp('@BotFather')).rejects.toThrow('non-HTTPS');
  });

  it('serves the signed URL exactly once over loopback', async () => {
    const target = 'https://example.org/app#tgWebAppData=signed-private-value';
    const handoff = await startWebAppHandoff(target);
    expect(handoff.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+$/);
    expect((await fetch(new URL('/', handoff.url))).status).toBe(404);

    const response = await fetch(handoff.url, { redirect: 'manual' });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(target);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await handoff.wait()).toBe('opened');
  });
});
