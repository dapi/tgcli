import { describe, expect, it, vi } from 'vitest';

import {
  buildSendErrorPayload,
  buildSendSuccessPayload,
  executeSendWithRetries,
  parseRetryBackoff,
  SendCommandError,
} from '../core/send-utils.js';

describe('executeSendWithRetries', () => {
  it('retries once and succeeds on transient network error', async () => {
    const sendFn = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' }))
      .mockResolvedValueOnce({ messageId: 456, media: { type: 'photo', fileId: 'file-123' } });
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await executeSendWithRetries(sendFn, {
      method: 'sendPhoto',
      retries: 2,
      retryBackoff: parseRetryBackoff('25'),
      sleep,
    });

    expect(sendFn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(25);
    expect(result).toEqual({
      result: { messageId: 456, media: { type: 'photo', fileId: 'file-123' } },
      attempts: 2,
    });
  });

  it('does not retry validation errors', async () => {
    const sendFn = vi.fn().mockRejectedValue(new Error('File not found: /tmp/missing.png'));

    await expect(
      executeSendWithRetries(sendFn, {
        method: 'sendPhoto',
        retries: 3,
        retryBackoff: parseRetryBackoff('constant'),
      }),
    ).rejects.toMatchObject({
      name: 'SendCommandError',
      details: expect.objectContaining({
        type: 'validation',
        method: 'sendPhoto',
        attempt: 1,
        retries: 3,
      }),
    });

    expect(sendFn).toHaveBeenCalledTimes(1);
  });

  it('does not retry non-transient telegram errors', async () => {
    const sendFn = vi.fn().mockRejectedValue(
      Object.assign(new Error('CHAT_WRITE_FORBIDDEN'), { code: 403 }),
    );

    await expect(
      executeSendWithRetries(sendFn, {
        method: 'sendPhoto',
        retries: 2,
        retryBackoff: parseRetryBackoff('linear'),
      }),
    ).rejects.toMatchObject({
      name: 'SendCommandError',
      details: expect.objectContaining({
        type: 'telegram',
        method: 'sendPhoto',
        attempt: 1,
        retries: 2,
        code: 403,
      }),
    });

    expect(sendFn).toHaveBeenCalledTimes(1);
  });
});

describe('send payload builders', () => {
  it('creates structured JSON success payload', () => {
    expect(
      buildSendSuccessPayload({
        method: 'sendPhoto',
        chatId: 123,
        messageId: 456,
        media: { type: 'photo', fileId: 'file-123' },
        attempts: 2,
      }),
    ).toEqual({
      ok: true,
      method: 'sendPhoto',
      chat_id: 123,
      message_id: 456,
      media: {
        type: 'photo',
        file_id: 'file-123',
      },
      attempts: 2,
    });
  });

  it('creates structured JSON error payload', () => {
    const error = new SendCommandError({
      type: 'network',
      method: 'sendPhoto',
      message: 'ECONNRESET',
      code: 'ECONNRESET',
      attempt: 2,
      retries: 3,
    });

    expect(buildSendErrorPayload(error.details)).toEqual({
      ok: false,
      error: {
        type: 'network',
        method: 'sendPhoto',
        message: 'ECONNRESET',
        code: 'ECONNRESET',
        attempt: 2,
        retries: 3,
      },
    });
  });
});
