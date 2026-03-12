import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildSendPhotoSuccessPayload, parseNonNegativeInt, shouldRunMain } from '../cli.js';

describe('tgcli send photo CLI validation', () => {
  const tempDirs = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it('rejects fractional --retries values', () => {
    expect(() => parseNonNegativeInt('1.5', '--retries')).toThrow(
      '--retries must be a non-negative integer',
    );
  });

  it('treats symlinked bin paths as the CLI entrypoint', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcli-cli-entry-'));
    tempDirs.push(tempDir);
    const symlinkPath = path.join(tempDir, 'tgcli');
    fs.symlinkSync(path.resolve('cli.js'), symlinkPath);

    expect(shouldRunMain(symlinkPath)).toBe(true);
    expect(shouldRunMain(path.join(tempDir, 'not-cli'))).toBe(false);
  });

  it('uses the resolved peer id for photo JSON chat_id output', () => {
    expect(buildSendPhotoSuccessPayload({
      method: 'sendPhoto',
      inputChatId: '@some-alias',
      result: {
        chatId: '999',
        messageId: 123,
        media: { type: 'photo', fileId: 'photo-file-id' },
      },
      attempts: 2,
    })).toEqual({
      ok: true,
      method: 'sendPhoto',
      chat_id: '999',
      message_id: 123,
      media: {
        type: 'photo',
        file_id: 'photo-file-id',
      },
      attempts: 2,
    });
  });
});
