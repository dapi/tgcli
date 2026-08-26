import { beforeEach, describe, expect, it, vi } from 'vitest';

import TelegramClient from '../telegram-client.js';

function createMockClient() {
  const telegramClient = Object.create(TelegramClient.prototype);
  telegramClient.ensureLogin = vi.fn().mockResolvedValue(undefined);
  telegramClient.client = {
    getInviteLinkMembers: vi.fn(),
    hideJoinRequest: vi.fn().mockResolvedValue(undefined),
  };
  return telegramClient;
}

function makeRequest(overrides = {}) {
  return {
    user: {
      id: 123,
      username: 'alice',
      displayName: 'Alice Example',
    },
    date: new Date('2026-08-26T01:02:03.000Z'),
    bio: 'Hello',
    isPendingRequest: true,
    ...overrides,
  };
}

describe('listGroupJoinRequests', () => {
  let telegramClient;

  beforeEach(() => {
    telegramClient = createMockClient();
  });

  it('lists pending requests as serializable records', async () => {
    const members = [makeRequest()];
    members.total = 3;
    telegramClient.client.getInviteLinkMembers.mockResolvedValue(members);

    const result = await telegramClient.listGroupJoinRequests('@group', {
      limit: 25,
      query: 'alice',
    });

    expect(telegramClient.client.getInviteLinkMembers).toHaveBeenCalledWith('@group', {
      requested: true,
      limit: 25,
      requestedSearch: 'alice',
      link: undefined,
    });
    expect(result).toEqual({
      total: 3,
      returned: 1,
      hasMore: true,
      requests: [{
        userId: '123',
        username: 'alice',
        displayName: 'Alice Example',
        requestedAt: '2026-08-26T01:02:03.000Z',
        bio: 'Hello',
        pending: true,
      }],
    });
  });

  it('uses a limit of 100 and preserves missing optional profile fields', async () => {
    const members = [makeRequest({
      user: { id: 456, username: null, displayName: 'No Username' },
      bio: null,
    })];
    members.total = 1;
    telegramClient.client.getInviteLinkMembers.mockResolvedValue(members);

    const result = await telegramClient.listGroupJoinRequests('-100123');

    expect(telegramClient.client.getInviteLinkMembers).toHaveBeenCalledWith(-100123, {
      requested: true,
      limit: 100,
      requestedSearch: undefined,
      link: undefined,
    });
    expect(result.requests[0]).toMatchObject({
      userId: '456',
      username: null,
      bio: null,
    });
    expect(result.hasMore).toBe(false);
  });

  it('rejects query together with an invite link before calling Telegram', async () => {
    await expect(telegramClient.listGroupJoinRequests('@group', {
      query: 'alice',
      link: 'https://t.me/+abc',
    })).rejects.toThrow('query cannot be combined with link');

    expect(telegramClient.client.getInviteLinkMembers).not.toHaveBeenCalled();
  });
});

describe('resolveGroupJoinRequest', () => {
  let telegramClient;

  beforeEach(() => {
    telegramClient = createMockClient();
  });

  it.each(['approve', 'decline'])('passes the %s action to mtcute', async (action) => {
    await telegramClient.resolveGroupJoinRequest('@group', '123', action);

    expect(telegramClient.client.hideJoinRequest).toHaveBeenCalledWith({
      chatId: '@group',
      user: 123,
      action,
    });
  });

  it('rejects unsupported actions before calling Telegram', async () => {
    await expect(
      telegramClient.resolveGroupJoinRequest('@group', '123', 'ignore'),
    ).rejects.toThrow('action must be approve or decline');

    expect(telegramClient.client.hideJoinRequest).not.toHaveBeenCalled();
  });
});
