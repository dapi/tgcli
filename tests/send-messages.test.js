vi.mock('@mtcute/node', () => ({
  TelegramClient: vi.fn(),
}));
vi.mock('@mtcute/core', () => ({
  InputMedia: {
    auto: vi.fn((path, opts) => ({ path, ...opts })),
    photo: vi.fn((path, opts) => ({ path, ...opts })),
  },
}));
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
    resolvePeer: vi.fn().mockResolvedValue({ _: 'inputPeerChannel', channelId: 999 }),
    _normalizeInputMedia: vi.fn(async (media) => ({ _: 'inputMediaUploadedPhoto', media })),
    call: vi.fn().mockResolvedValue({
      updates: [
        { _: 'updateMessageID', id: 202, randomId: { eq: () => true } },
        { _: 'updateNewChannelMessage', message: { id: 202 } },
      ],
    }),
    getMessages: vi.fn().mockResolvedValue([{ id: 202, media: { type: 'photo', fileId: 'photo-file-id' } }]),
  };
  return tc;
}

function createTempFile(extension = '.txt') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcli-send-test-'));
  const filePath = path.join(dir, `sample${extension}`);
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

  it('parseMode is case-insensitive', async () => {
    await tc.sendTextMessage('@chat', '**bold**', { parseMode: 'Markdown' });
    expect(md).toHaveBeenCalledTimes(1);
    expect(md).toHaveBeenCalledWith('**bold**');
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

describe('sendTextMessage new send parameters', () => {
  let tc;

  beforeEach(() => {
    tc = createMockClient();
  });

  it('--silent passes silent: true in params', async () => {
    await tc.sendTextMessage('@chat', 'hello', { silent: true });
    expect(tc.client.sendText).toHaveBeenCalledWith('@chat', 'hello', { silent: true });
  });

  it('--no-forwards passes noforwards: true in params', async () => {
    await tc.sendTextMessage('@chat', 'hello', { noforwards: true });
    expect(tc.client.sendText).toHaveBeenCalledWith('@chat', 'hello', { forbidForwards: true });
  });

  it('--schedule passes scheduleDate as unix timestamp in params', async () => {
    const scheduleDate = Math.floor(Date.now() / 1000) + 3600;
    await tc.sendTextMessage('@chat', 'hello', { scheduleDate });
    expect(tc.client.sendText).toHaveBeenCalledWith('@chat', 'hello', { scheduleDate });
  });

  it('combined silent + replyTo passes both in params', async () => {
    await tc.sendTextMessage('@chat', 'hello', {
      silent: true,
      replyToMessageId: 55,
    });
    expect(tc.client.sendText).toHaveBeenCalledWith('@chat', 'hello', {
      silent: true,
      replyTo: 55,
    });
  });

  it('combined silent + noforwards + scheduleDate passes all in params', async () => {
    const scheduleDate = Math.floor(Date.now() / 1000) + 7200;
    await tc.sendTextMessage('@chat', 'hello', {
      silent: true,
      noforwards: true,
      scheduleDate,
    });
    expect(tc.client.sendText).toHaveBeenCalledWith('@chat', 'hello', {
      silent: true,
      forbidForwards: true,
      scheduleDate,
    });
  });

  it('noForwards (camelCase) passes noforwards: true in params', async () => {
    await tc.sendTextMessage('@chat', 'hello', { noForwards: true });
    expect(tc.client.sendText).toHaveBeenCalledWith('@chat', 'hello', { forbidForwards: true });
  });

  it('schedule (ISO string) passes scheduleDate as unix timestamp', async () => {
    const iso = '2027-01-15T09:00:00Z';
    const expected = Math.floor(new Date(iso).getTime() / 1000);
    await tc.sendTextMessage('@chat', 'hello', { schedule: iso });
    expect(tc.client.sendText).toHaveBeenCalledWith('@chat', 'hello', { scheduleDate: expected });
  });

  it('no new params still sends undefined params (backward compat)', async () => {
    await tc.sendTextMessage('@chat', 'hello');
    expect(tc.client.sendText).toHaveBeenCalledWith('@chat', 'hello', undefined);
  });
});

describe('sendFileMessage new send parameters', () => {
  let tc;
  let temp;

  beforeEach(() => {
    tc = createMockClient();
    temp = createTempFile();
  });

  afterEach(() => {
    fs.rmSync(temp.dir, { recursive: true, force: true });
  });

  it('--silent passes silent: true in params', async () => {
    await tc.sendFileMessage('@chat', temp.filePath, { silent: true });
    expect(tc.client.sendMedia).toHaveBeenCalledWith('@chat', expect.anything(), { silent: true });
  });

  it('--no-forwards passes noforwards: true in params', async () => {
    await tc.sendFileMessage('@chat', temp.filePath, { noforwards: true });
    expect(tc.client.sendMedia).toHaveBeenCalledWith('@chat', expect.anything(), { forbidForwards: true });
  });

  it('--schedule passes scheduleDate in params', async () => {
    const scheduleDate = Math.floor(Date.now() / 1000) + 3600;
    await tc.sendFileMessage('@chat', temp.filePath, { scheduleDate });
    expect(tc.client.sendMedia).toHaveBeenCalledWith('@chat', expect.anything(), { scheduleDate });
  });

  it('--caption-above passes invertMedia: true in params', async () => {
    await tc.sendFileMessage('@chat', temp.filePath, {
      caption: 'my caption',
      captionAbove: true,
    });
    expect(tc.client.sendMedia).toHaveBeenCalledWith('@chat', expect.anything(), { invert: true });
  });

  it('--caption-above without caption throws error', async () => {
    await expect(
      tc.sendFileMessage('@chat', temp.filePath, { captionAbove: true }),
    ).rejects.toThrow('--caption-above requires --caption for send file');
  });

  it('--spoiler passes spoiler: true in InputMedia.auto options', async () => {
    await tc.sendFileMessage('@chat', temp.filePath, { spoiler: true });
    const { InputMedia } = await import('@mtcute/core');
    expect(InputMedia.auto).toHaveBeenCalledWith(
      expect.stringContaining('file:'),
      expect.objectContaining({ spoiler: true }),
    );
  });

  it('--force-document passes forceDocument: true in InputMedia.auto options', async () => {
    await tc.sendFileMessage('@chat', temp.filePath, { forceDocument: true });
    const { InputMedia } = await import('@mtcute/core');
    expect(InputMedia.auto).toHaveBeenCalledWith(
      expect.stringContaining('file:'),
      expect.objectContaining({ forceDocument: true }),
    );
  });

  it('noForwards (camelCase) passes noforwards: true in params', async () => {
    await tc.sendFileMessage('@chat', temp.filePath, { noForwards: true });
    expect(tc.client.sendMedia).toHaveBeenCalledWith('@chat', expect.anything(), { forbidForwards: true });
  });

  it('schedule (ISO string) passes scheduleDate as unix timestamp', async () => {
    const iso = '2027-06-01T12:00:00Z';
    const expected = Math.floor(new Date(iso).getTime() / 1000);
    await tc.sendFileMessage('@chat', temp.filePath, { schedule: iso });
    expect(tc.client.sendMedia).toHaveBeenCalledWith('@chat', expect.anything(), { scheduleDate: expected });
  });

  it('combined silent + noforwards + replyTo passes all in params', async () => {
    await tc.sendFileMessage('@chat', temp.filePath, {
      silent: true,
      noforwards: true,
      replyToMessageId: 99,
    });
    expect(tc.client.sendMedia).toHaveBeenCalledWith('@chat', expect.anything(), {
      silent: true,
      forbidForwards: true,
      replyTo: 99,
    });
  });

  it('no new params still sends undefined params (backward compat)', async () => {
    await tc.sendFileMessage('@chat', temp.filePath, {});
    expect(tc.client.sendMedia).toHaveBeenCalledWith('@chat', expect.anything(), undefined);
  });
});

describe('sendPhotoMessage', () => {
  let tc;
  let png;
  let jpg;

  beforeEach(() => {
    tc = createMockClient();
    png = createTempFile('.png');
    jpg = createTempFile('.jpg');
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(png.dir, { recursive: true, force: true });
    fs.rmSync(jpg.dir, { recursive: true, force: true });
  });

  it('sends local png via InputMedia.photo', async () => {
    await tc.sendPhotoMessage('@chat', png.filePath, {});
    const { InputMedia } = await import('@mtcute/core');
    expect(InputMedia.photo).toHaveBeenCalledWith(expect.stringContaining('file:'), {});
    expect(tc.client.resolvePeer).toHaveBeenCalledWith('@chat');
    expect(tc.client._normalizeInputMedia).toHaveBeenCalledTimes(1);
    expect(tc.client.call).toHaveBeenCalledTimes(1);
  });

  it('sends local jpg via InputMedia.photo', async () => {
    await tc.sendPhotoMessage('@chat', jpg.filePath, {});
    const { InputMedia } = await import('@mtcute/core');
    expect(InputMedia.photo).toHaveBeenCalledWith(expect.stringContaining('file:'), {});
  });

  it('applies markdown parse mode to photo caption', async () => {
    await tc.sendPhotoMessage('@chat', png.filePath, {
      caption: '**caption**',
      parseMode: 'markdown',
    });
    const { InputMedia } = await import('@mtcute/core');
    expect(md).toHaveBeenCalledWith('**caption**');
    expect(InputMedia.photo).toHaveBeenCalledWith(
      expect.stringContaining('file:'),
      expect.objectContaining({
        caption: { text: '**caption**', entities: [{ type: 'bold' }] },
      }),
    );
  });

  it('passes reply-to, topic fallback, silent, no-forwards, caption-above, spoiler, and schedule to low-level sendMedia request', async () => {
    const scheduleDate = Math.floor(Date.now() / 1000) + 1800;
    await tc.sendPhotoMessage('@chat', png.filePath, {
      caption: 'preview',
      topicId: 42,
      replyToMessageId: 77,
      silent: true,
      noForwards: true,
      captionAbove: true,
      spoiler: true,
      scheduleDate,
    });

    const { InputMedia } = await import('@mtcute/core');
    expect(InputMedia.photo).toHaveBeenCalledWith(
      expect.stringContaining('file:'),
      expect.objectContaining({ spoiler: true }),
    );
    expect(tc.client.call).toHaveBeenCalledWith(expect.objectContaining({
      _: 'messages.sendMedia',
      silent: true,
      scheduleDate,
      noforwards: true,
      invertMedia: true,
      replyTo: {
        _: 'inputReplyToMessage',
        replyToMsgId: 77,
      },
    }));
  });

  it('rejects caption-above without caption for send photo', async () => {
    await expect(
      tc.sendPhotoMessage('@chat', png.filePath, { captionAbove: true }),
    ).rejects.toThrow('--caption-above requires --caption for send photo');
  });

  it('returns best-effort media metadata for successful photo sends', async () => {
    tc.client.call.mockResolvedValueOnce({
      updates: [
        { _: 'updateMessageID', id: 303, randomId: { eq: () => true } },
        { _: 'updateNewChannelMessage', message: { id: 303 } },
      ],
    });
    tc.client.getMessages.mockResolvedValueOnce([{ id: 303, media: { type: 'photo', fileId: 'photo-file-id' } }]);

    const result = await tc.sendPhotoMessage('@chat', png.filePath, {});
    expect(result).toMatchObject({
      messageId: 303,
      method: 'sendPhoto',
      media: {
        type: 'photo',
        fileId: 'photo-file-id',
      },
    });
  });

  it('reuses the same prepared request and randomId across photo send retries', async () => {
    const prepared = await tc.preparePhotoMessage('@chat', png.filePath, { caption: 'retry me' });
    tc.client.call
      .mockRejectedValueOnce(Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' }))
      .mockResolvedValueOnce({
        updates: [
          {
            _: 'updateMessageID',
            id: 404,
            randomId: { eq: (value) => String(value) === String(prepared.request.randomId) },
          },
          { _: 'updateNewChannelMessage', message: { id: 404 } },
        ],
      });
    tc.client.getMessages.mockResolvedValueOnce([{ id: 404, media: { type: 'photo' } }]);

    await expect(tc.sendPreparedPhotoMessage(prepared)).rejects.toThrow('ECONNRESET');
    await tc.sendPreparedPhotoMessage(prepared);

    const [firstRequest] = tc.client.call.mock.calls[0];
    const [secondRequest] = tc.client.call.mock.calls[1];
    expect(firstRequest).not.toBe(secondRequest);
    expect(String(firstRequest.randomId)).toBe(String(prepared.request.randomId));
    expect(String(secondRequest.randomId)).toBe(String(prepared.request.randomId));
    expect(tc.client._normalizeInputMedia).toHaveBeenCalledTimes(2);
  });

  it('does not upload during preparePhotoMessage, so upload failures can be retried later', async () => {
    await tc.preparePhotoMessage('@chat', png.filePath, { caption: 'retry me' });
    expect(tc.client.resolvePeer).not.toHaveBeenCalled();
    expect(tc.client._normalizeInputMedia).not.toHaveBeenCalled();
  });
});

describe('resolveScheduleDate error handling', () => {
  let tc;

  beforeEach(() => {
    tc = createMockClient();
  });

  it('invalid ISO string throws error for sendTextMessage', async () => {
    await expect(
      tc.sendTextMessage('@chat', 'hello', { schedule: 'banana' }),
    ).rejects.toThrow('Invalid schedule date: must be a valid ISO 8601 datetime');
  });

  it('invalid ISO string throws error for sendFileMessage', async () => {
    const temp = createTempFile();
    try {
      await expect(
        tc.sendFileMessage('@chat', temp.filePath, { schedule: 'not-a-date' }),
      ).rejects.toThrow('Invalid schedule date: must be a valid ISO 8601 datetime');
    } finally {
      fs.rmSync(temp.dir, { recursive: true, force: true });
    }
  });

  it('scheduleDate: 0 is passed through (explicit check, not truthy)', async () => {
    await tc.sendTextMessage('@chat', 'hello', { scheduleDate: 0 });
    expect(tc.client.sendText).toHaveBeenCalledWith('@chat', 'hello', undefined);
  });

  it('scheduleDate: null is treated as absent', async () => {
    await tc.sendTextMessage('@chat', 'hello', { scheduleDate: null });
    expect(tc.client.sendText).toHaveBeenCalledWith('@chat', 'hello', undefined);
  });

  it('scheduleDate: undefined is treated as absent', async () => {
    await tc.sendTextMessage('@chat', 'hello', { scheduleDate: undefined });
    expect(tc.client.sendText).toHaveBeenCalledWith('@chat', 'hello', undefined);
  });
});
