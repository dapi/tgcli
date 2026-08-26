import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { assertSafeDownloadTarget, resolveDownloadPath } from '../telegram-client.js';

describe('account-local media downloads', () => {
  it('uses the selected account download directory when output is omitted', () => {
    const accountDownloads = path.resolve('/tmp/tgcli/accounts/work/downloads');

    const result = resolveDownloadPath(null, {
      channelId: '@channel',
      messageId: 42,
      summary: { type: 'photo', mimeType: 'image/jpeg' },
      defaultDownloadDir: accountDownloads,
    });

    expect(result).toBe(path.join(accountDownloads, '@channel', 'photo-42.jpg'));
  });

  it('keeps traversal-shaped channel ids inside the selected account downloads', () => {
    const accountDownloads = path.resolve('/tmp/tgcli/accounts/work/downloads');

    const result = resolveDownloadPath(null, {
      channelId: '../../default',
      messageId: 42,
      summary: { type: 'photo', mimeType: 'image/jpeg' },
      defaultDownloadDir: accountDownloads,
    });

    expect(result.startsWith(`${accountDownloads}${path.sep}`)).toBe(true);
  });

  it('rejects a hard-linked automatic download target', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcli-download-target-test-'));
    try {
      const victim = path.join(root, 'victim');
      const target = path.join(root, 'downloads', '@channel', 'photo-42.jpg');
      fs.writeFileSync(victim, 'keep');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.linkSync(victim, target);

      expect(() => assertSafeDownloadTarget(target, path.join(root, 'downloads')))
        .toThrow(/hard.?link|multiple links/i);
      expect(fs.readFileSync(victim, 'utf8')).toBe('keep');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
