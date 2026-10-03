import { describe, expect, it, vi } from 'vitest';

import TelegramClient, { floodWaitSeconds, formatTranscription } from '../telegram-client.js';

describe('floodWaitSeconds', () => {
  it('reads the wait from a FLOOD_WAIT error message', () => {
    expect(floodWaitSeconds(new Error('Telegram API error 420: FLOOD_WAIT_13'))).toBe(13);
  });

  it('prefers a numeric seconds field when the error carries one', () => {
    expect(floodWaitSeconds({ seconds: 7, message: 'FLOOD_WAIT_13' })).toBe(7);
  });

  it('returns null for unrelated errors so they are rethrown', () => {
    expect(floodWaitSeconds(new Error('CHAT_ADMIN_REQUIRED'))).toBeNull();
  });
});

describe('formatTranscription', () => {
  it('normalizes a finished transcription', () => {
    expect(formatTranscription({ text: 'hello', pending: false, transcriptionId: 12n, trialRemainsNum: 2 }))
      .toEqual({ text: 'hello', pending: false, transcriptionId: '12', trialRemaining: 2 });
  });

  it('lets the caller mark a result as still incomplete', () => {
    expect(formatTranscription({ text: 'half', pending: true }, { pending: true }).pending).toBe(true);
  });
});

describe('transcribeVoice', () => {
  const build = () => {
    const client = Object.create(TelegramClient.prototype);
    client.ensureLogin = vi.fn().mockResolvedValue(undefined);
    client.startUpdates = vi.fn().mockResolvedValue(undefined);
    client.client = { resolvePeer: vi.fn().mockResolvedValue({ _: 'inputPeerUser' }), call: vi.fn() };
    return client;
  };

  it('returns immediately when Telegram reports the transcription as done', async () => {
    const client = build();
    client.client.call.mockResolvedValue({ text: 'done', pending: false, transcriptionId: 5n });

    const result = await client.transcribeVoice(123, 7);

    expect(result.text).toBe('done');
    expect(client.client.call).toHaveBeenCalledTimes(1);
  });

  // Polling instead of awaiting the update spends the rate limit and yields draft text
  it('waits for the update instead of polling when the first answer is pending', async () => {
    const client = build();
    client.client.call.mockResolvedValue({ text: 'draft', pending: true, transcriptionId: 5n });
    client._awaitTranscribedAudio = vi.fn().mockResolvedValue({ text: 'final', transcriptionId: 5n });

    const result = await client.transcribeVoice(123, 7, { waitMs: 10 });

    expect(result.text).toBe('final');
    expect(client.client.call).toHaveBeenCalledTimes(1);
  });

  it('marks the result incomplete when the final update never arrives', async () => {
    const client = build();
    client.client.call.mockResolvedValue({ text: 'draft', pending: true, transcriptionId: 5n });
    client._awaitTranscribedAudio = vi.fn().mockResolvedValue(null);

    const result = await client.transcribeVoice(123, 7, { waitMs: 10 });

    expect(result).toMatchObject({ text: 'draft', pending: true });
  });

  it('sleeps through a short flood wait and retries once', async () => {
    const client = build();
    client.client.call
      .mockRejectedValueOnce(new Error('Telegram API error 420: FLOOD_WAIT_1'))
      .mockResolvedValueOnce({ text: 'after the wait', pending: false });

    const result = await client.transcribeVoice(123, 7);

    expect(result.text).toBe('after the wait');
    expect(client.client.call).toHaveBeenCalledTimes(2);
  });

  it('rethrows a flood wait that is longer than the caller allows', async () => {
    const client = build();
    client.client.call.mockRejectedValue(new Error('Telegram API error 420: FLOOD_WAIT_600'));

    await expect(client.transcribeVoice(123, 7, { maxFloodWaitSeconds: 5 })).rejects.toThrow('FLOOD_WAIT_600');
  });
});
