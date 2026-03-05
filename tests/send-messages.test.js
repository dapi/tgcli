vi.mock('@mtcute/markdown-parser', () => ({
  md: vi.fn((text) => ({ text, entities: [{ type: 'bold' }] })),
}));
vi.mock('@mtcute/html-parser', () => ({
  html: vi.fn((text) => ({ text, entities: [{ type: 'italic' }] })),
}));

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { md } from '@mtcute/markdown-parser';
import { html } from '@mtcute/html-parser';
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

describe('sendTextMessage parse-mode', () => {
  let tc;

  beforeEach(() => {
    tc = createMockClient();
    vi.clearAllMocks();
  });

  it('--parse-mode markdown calls md() and passes result to sendText', async () => {
    await tc.sendTextMessage('@chat', 'hello **bold**', { parseMode: 'markdown' });
    expect(md).toHaveBeenCalledTimes(1);
    expect(md).toHaveBeenCalledWith('hello **bold**');
    expect(tc.client.sendText).toHaveBeenCalledWith(
      '@chat',
      { text: 'hello **bold**', entities: [{ type: 'bold' }] },
      undefined,
    );
  });

  it('--parse-mode html calls html() and passes result to sendText', async () => {
    await tc.sendTextMessage('@chat', 'hello <b>bold</b>', { parseMode: 'html' });
    expect(html).toHaveBeenCalledTimes(1);
    expect(html).toHaveBeenCalledWith('hello <b>bold</b>');
    expect(tc.client.sendText).toHaveBeenCalledWith(
      '@chat',
      { text: 'hello <b>bold</b>', entities: [{ type: 'italic' }] },
      undefined,
    );
  });

  it('--parse-mode none sends text as-is without calling parsers', async () => {
    await tc.sendTextMessage('@chat', 'plain text', { parseMode: 'none' });
    expect(md).not.toHaveBeenCalled();
    expect(html).not.toHaveBeenCalled();
    expect(tc.client.sendText).toHaveBeenCalledWith('@chat', 'plain text', undefined);
  });

  it('no parseMode sends text as-is (backward compat)', async () => {
    await tc.sendTextMessage('@chat', 'plain text');
    expect(md).not.toHaveBeenCalled();
    expect(html).not.toHaveBeenCalled();
    expect(tc.client.sendText).toHaveBeenCalledWith('@chat', 'plain text', undefined);
  });

  it('invalid parseMode throws error', async () => {
    await expect(
      tc.sendTextMessage('@chat', 'text', { parseMode: 'xml' }),
    ).rejects.toThrow('Invalid parse mode. Allowed values: markdown, html, none');
  });

  it('empty message throws error', async () => {
    await expect(
      tc.sendTextMessage('@chat', '', { parseMode: 'markdown' }),
    ).rejects.toThrow('Message text cannot be empty.');
  });
});
