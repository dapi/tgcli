import { beforeEach, describe, expect, it, vi } from 'vitest';

import TelegramClient from '../telegram-client.js';

function createMockClient() {
  const telegramClient = Object.create(TelegramClient.prototype);
  telegramClient.ensureLogin = vi.fn().mockResolvedValue(undefined);
  telegramClient.client = {
    editInviteLink: vi.fn().mockResolvedValue({
      link: 'https://t.me/+invite',
      approvalNeeded: true,
      isPrimary: false,
    }),
  };
  return telegramClient;
}

describe('editGroupInviteLink', () => {
  let telegramClient;

  beforeEach(() => {
    telegramClient = createMockClient();
  });

  it.each([true, false])('sets requestNeeded=%s on the exact link', async (requestNeeded) => {
    await telegramClient.editGroupInviteLink('@group', ' https://t.me/+invite ', {
      requestNeeded,
    });

    expect(telegramClient.client.editInviteLink).toHaveBeenCalledWith({
      chatId: '@group',
      link: 'https://t.me/+invite',
      withApproval: requestNeeded,
    });
  });

  it('rejects missing link or requestNeeded before calling Telegram', async () => {
    await expect(
      telegramClient.editGroupInviteLink('@group', '', { requestNeeded: true }),
    ).rejects.toThrow('Invite link must be a non-empty string.');
    await expect(
      telegramClient.editGroupInviteLink('@group', 'https://t.me/+invite'),
    ).rejects.toThrow('requestNeeded must be boolean.');

    expect(telegramClient.client.editInviteLink).not.toHaveBeenCalled();
  });
});
