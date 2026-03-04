import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import TelegramClient from '../telegram-client.js';

function createMockClient() {
  const tc = Object.create(TelegramClient.prototype);
  tc.ensureLogin = vi.fn().mockResolvedValue(undefined);
  tc.client = {
    sendText: vi.fn().mockResolvedValue({ id: 101 }),
    sendMedia: vi.fn().mockResolvedValue({ id: 202 }),
  };
  return tc;
}

function createTempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcli-send-test-'));
  const filePath = path.join(dir, 'sample.txt');
  fs.writeFileSync(filePath, 'sample file');
  return { dir, filePath };
}

describe('send message reply targeting', () => {
  let tc;
  let temp;

  beforeEach(() => {
    tc = createMockClient();
    temp = createTempFile();
  });

  afterEach(() => {
    fs.rmSync(temp.dir, { recursive: true, force: true });
  });

  it('sendTextMessage uses replyToMessageId when both replyToMessageId and topicId are provided', async () => {
    await tc.sendTextMessage('@chat', 'hello', {
      replyToMessageId: 77,
      topicId: 42,
    });
    expect(tc.client.sendText).toHaveBeenCalledWith('@chat', 'hello', { replyTo: 77 });
  });

  it('sendTextMessage falls back to topicId when replyToMessageId is missing', async () => {
    await tc.sendTextMessage('@chat', 'hello', { topicId: 42 });
    expect(tc.client.sendText).toHaveBeenCalledWith('@chat', 'hello', { replyTo: 42 });
  });

  it('sendFileMessage uses replyToMessageId when both replyToMessageId and topicId are provided', async () => {
    await tc.sendFileMessage('@chat', temp.filePath, {
      replyToMessageId: 77,
      topicId: 42,
    });
    expect(tc.client.sendMedia).toHaveBeenCalledWith('@chat', expect.anything(), { replyTo: 77 });
  });

  it('sendFileMessage falls back to topicId when replyToMessageId is missing', async () => {
    await tc.sendFileMessage('@chat', temp.filePath, { topicId: 42 });
    expect(tc.client.sendMedia).toHaveBeenCalledWith('@chat', expect.anything(), { replyTo: 42 });
  });

  it('sendFileMessage sends without replyTo params when neither replyToMessageId nor topicId is provided', async () => {
    await tc.sendFileMessage('@chat', temp.filePath, {});
    expect(tc.client.sendMedia).toHaveBeenCalledWith('@chat', expect.anything(), undefined);
  });
});
