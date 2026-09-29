import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import TelegramClient from '../telegram-client.js';

const dirs = [];
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

const withSessionFile = (mode) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcli-session-'));
  dirs.push(dir);
  const sessionPath = path.join(dir, 'session.json');
  fs.writeFileSync(sessionPath, '{}', { mode });
  fs.chmodSync(sessionPath, mode);
  const client = Object.create(TelegramClient.prototype);
  client.sessionPath = sessionPath;
  return { client, sessionPath };
};

describe('session file permissions', () => {
  it('narrows a world-readable session file to 0600', () => {
    const { client, sessionPath } = withSessionFile(0o644);

    client._restrictSessionFileMode();

    expect(fs.statSync(sessionPath).mode & 0o777).toBe(0o600);
  });

  it('does not throw when the session file is absent', () => {
    const client = Object.create(TelegramClient.prototype);
    client.sessionPath = path.join(os.tmpdir(), 'tgcli-does-not-exist', 'session.json');

    expect(() => client._restrictSessionFileMode()).not.toThrow();
  });
});
