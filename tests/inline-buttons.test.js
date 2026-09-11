import { beforeEach, describe, expect, it, vi } from 'vitest';

import TelegramClient from '../telegram-client.js';

function createClient(message) {
  const telegramClient = Object.create(TelegramClient.prototype);
  telegramClient.ensureLogin = vi.fn().mockResolvedValue(undefined);
  telegramClient.client = {
    getMessages: vi.fn().mockResolvedValue([message]),
    resolvePeer: vi.fn().mockResolvedValue({ id: 123, displayName: 'BotFather' }),
    getCallbackAnswer: vi.fn().mockResolvedValue({
      _: 'messages.botCallbackAnswer',
      message: 'Done',
      alert: false,
      cacheTime: 0,
    }),
  };
  return telegramClient;
}

function createMessage(buttons) {
  return {
    id: 42,
    date: 1_700_000_000,
    text: 'Choose a bot',
    markup: { type: 'inline', buttons },
    raw: { _: 'message' },
  };
}

describe('inline message buttons', () => {
  let callbackButton;

  beforeEach(() => {
    callbackButton = {
      _: 'keyboardInlineButton',
      text: 'CustDev AI',
      type: {
        _: 'inlineButtonTypeCallback',
        data: Uint8Array.from([1, 2, 3]),
        requiresPassword: false,
      },
    };
  });

  it('serializes safe button metadata without callback data', async () => {
    const telegramClient = createClient(createMessage([
      [callbackButton, {
        _: 'keyboardInlineButton',
        text: 'Docs',
        type: { _: 'inlineButtonTypeUrl', url: 'https://example.com' },
      }],
    ]));

    const message = await telegramClient.getMessageById('@BotFather', 42);

    expect(message.inline_buttons).toEqual([
      {
        row: 1,
        column: 1,
        text: 'CustDev AI',
        type: 'callback',
        actionable: true,
        requiresPassword: false,
      },
      {
        row: 1,
        column: 2,
        text: 'Docs',
        type: 'url',
        actionable: false,
        requiresPassword: false,
      },
    ]);
    expect(JSON.stringify(message.inline_buttons)).not.toContain('1,2,3');
  });

  it('clicks an explicitly addressed callback button', async () => {
    const telegramClient = createClient(createMessage([[callbackButton]]));

    const result = await telegramClient.clickInlineButton('@BotFather', 42, {
      row: 1,
      column: 1,
    });

    expect(telegramClient.client.getCallbackAnswer).toHaveBeenCalledWith({
      chatId: '@BotFather',
      message: 42,
      data: callbackButton.type.data,
    });
    expect(result).toEqual({
      messageId: 42,
      button: {
        row: 1,
        column: 1,
        text: 'CustDev AI',
        type: 'callback',
        actionable: true,
        requiresPassword: false,
      },
      answer: {
        message: 'Done',
        alert: false,
        url: null,
        cacheTime: 0,
      },
    });
  });

  it('refuses non-callback and password-protected buttons', async () => {
    const urlClient = createClient(createMessage([[
      {
        _: 'keyboardInlineButton',
        text: 'Open',
        type: { _: 'inlineButtonTypeUrl', url: 'https://example.com' },
      },
    ]]));
    await expect(urlClient.clickInlineButton('@BotFather', 42, { row: 1, column: 1 }))
      .rejects.toThrow('only callback buttons can be clicked');

    const passwordClient = createClient(createMessage([[
      { ...callbackButton, type: { ...callbackButton.type, requiresPassword: true } },
    ]]));
    await expect(passwordClient.clickInlineButton('@BotFather', 42, { row: 1, column: 1 }))
      .rejects.toThrow('Password-protected callback buttons are not supported');
  });

  it('uses 1-based coordinates and rejects a missing button', async () => {
    const telegramClient = createClient(createMessage([[callbackButton]]));

    await expect(telegramClient.clickInlineButton('@BotFather', 42, { row: 2, column: 1 }))
      .rejects.toThrow('Inline button not found at row 2, column 1');
    expect(telegramClient.client.getCallbackAnswer).not.toHaveBeenCalled();
  });
});
