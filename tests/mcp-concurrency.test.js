import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  initializeDialogCache: vi.fn().mockResolvedValue(true),
  ensureLogin: vi.fn().mockResolvedValue(true),
  listDialogs: vi.fn().mockResolvedValue([]),
  destroy: vi.fn().mockResolvedValue(undefined),
  refreshChannelsFromDialogs: vi.fn().mockResolvedValue(0),
  startRealtimeSync: vi.fn(),
  resumePendingJobs: vi.fn(),
  listArchivedMessages: vi.fn().mockReturnValue([]),
  addJob: vi.fn().mockReturnValue({ id: 1, channel_id: '123', status: 'pending' }),
  processQueue: vi.fn().mockResolvedValue(undefined),
  shutdown: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../core/config.js', () => ({
  loadConfig: () => ({
    config: {
      apiId: '12345',
      apiHash: 'test-hash',
      phoneNumber: '+10000000000',
      mcp: { enabled: true, host: '127.0.0.1', port: Number(process.env.TGCLI_TEST_PORT ?? 0) },
    },
    path: 'test-config.json',
  }),
  validateConfig: () => [],
}));

vi.mock('../core/store.js', () => ({
  resolveStoreDir: () => process.env.TGCLI_TEST_STORE,
}));

vi.mock('../core/services.js', () => ({
  createServices: () => ({
    telegramClient: {
      initializeDialogCache: mocks.initializeDialogCache,
      ensureLogin: mocks.ensureLogin,
      listDialogs: mocks.listDialogs,
      destroy: mocks.destroy,
    },
    messageSyncService: {
      refreshChannelsFromDialogs: mocks.refreshChannelsFromDialogs,
      startRealtimeSync: mocks.startRealtimeSync,
      resumePendingJobs: mocks.resumePendingJobs,
      listArchivedMessages: mocks.listArchivedMessages,
      addJob: mocks.addJob,
      processQueue: mocks.processQueue,
      shutdown: mocks.shutdown,
    },
  }),
}));

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

describe('concurrent MCP clients', () => {
  let storeDir;
  let server;
  let baseUrl;
  const clients = [];

  async function connectClient() {
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    const client = new Client({ name: 'tgcli-concurrency-test', version: '1.0.0' });
    await client.connect(transport);
    clients.push({ client, transport });
    return { client, transport };
  }

  beforeAll(async () => {
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcli-mcp-concurrency-'));
    process.env.TGCLI_TEST_STORE = storeDir;
    server = await import('../mcp-server.js');
    if (!server.httpServer.listening) {
      await new Promise((resolve) => server.httpServer.once('listening', resolve));
    }
    baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;
  });

  afterAll(async () => {
    await server?.shutdown();
    await Promise.all(clients.map(({ client }) => client.close().catch(() => {})));
    fs.rmSync(storeDir, { recursive: true, force: true });
    delete process.env.TGCLI_TEST_STORE;
  });

  it('serves overlapping calls on independent MCP sessions', async () => {
    const [first, second] = await Promise.all([connectClient(), connectClient()]);
    expect(first.transport.sessionId).toBeTruthy();
    expect(second.transport.sessionId).toBeTruthy();
    expect(first.transport.sessionId).not.toBe(second.transport.sessionId);

    const gate = deferred();
    const bothEntered = deferred();
    let entered = 0;
    mocks.listDialogs.mockImplementation(async () => {
      entered += 1;
      if (entered === 2) bothEntered.resolve();
      await gate.promise;
      return [{ id: String(entered), title: 'Test dialog' }];
    });

    const firstCall = first.client.callTool({ name: 'listChannels', arguments: { limit: 1 } });
    const archiveRead = await second.client.callTool({
      name: 'messagesList',
      arguments: { channelId: '123', source: 'archive', limit: 1 },
    });
    expect(archiveRead.isError).not.toBe(true);
    const syncJob = await second.client.callTool({
      name: 'scheduleMessageSync',
      arguments: { channelId: '123', depth: 10 },
    });
    expect(syncJob.isError).not.toBe(true);
    expect(mocks.processQueue).toHaveBeenCalledTimes(1);
    const secondCall = second.client.callTool({ name: 'listChannels', arguments: { limit: 1 } });
    await bothEntered.promise;
    gate.resolve();
    const [firstResult, secondResult] = await Promise.all([firstCall, secondCall]);
    expect(firstResult.isError).not.toBe(true);
    expect(secondResult.isError).not.toBe(true);
    expect(mocks.listDialogs).toHaveBeenCalledTimes(2);

    await first.transport.terminateSession();
    await first.client.close();
    const remainingResult = await second.client.callTool({ name: 'listChannels', arguments: { limit: 1 } });
    expect(remainingResult.isError).not.toBe(true);
    expect(mocks.destroy).not.toHaveBeenCalled();
  });

  it('drains an active tool call before closing shared services', async () => {
    const active = await connectClient();
    const gate = deferred();
    const entered = deferred();
    mocks.listDialogs.mockImplementation(async () => {
      entered.resolve();
      await gate.promise;
      return [{ id: 'last', title: 'Last dialog' }];
    });

    const call = active.client.callTool({ name: 'listChannels', arguments: { limit: 1 } });
    await entered.promise;
    const closing = server.shutdown();
    await new Promise((resolve) => setImmediate(resolve));
    expect(mocks.destroy).not.toHaveBeenCalled();
    gate.resolve();
    const result = await call;
    expect(result.isError).not.toBe(true);
    await closing;
    expect(mocks.shutdown).toHaveBeenCalledTimes(1);
    expect(mocks.destroy).toHaveBeenCalledTimes(1);
  });
});
