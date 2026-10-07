import { describe, expect, it, vi } from 'vitest';

import { getTelegramRequestSignal, requestTelegramClient, runTelegramRequest } from '../core/request-context.js';

describe('Telegram request cancellation', () => {
  it('cancels nested RPCs even when a helper supplies abortSignal: undefined', async () => {
    const native = { storage: {}, call: vi.fn(() => new Promise(() => {})) };
    const client = {
      _client: native,
      upload() { return this._client.call({ _: 'upload.saveFilePart' }, { abortSignal: undefined, maxRetryCount: Infinity }); },
    };
    const controller = new AbortController();
    const pending = runTelegramRequest(controller.signal, () => requestTelegramClient(client).upload());
    expect(native.call.mock.calls[0][1]).toMatchObject({ abortSignal: controller.signal, maxRetryCount: Infinity });
    const cancelled = expect(pending).rejects.toThrow('deadline');
    controller.abort(new Error('deadline'));
    await cancelled;
    expect(getTelegramRequestSignal()).toBeUndefined();
  });

  it('keeps concurrent request signals isolated and combines explicit RPC cancellation', async () => {
    const signals = [];
    const client = { call: (_, options) => { signals.push(options.abortSignal); return Promise.resolve(true); } };
    const a = new AbortController();
    const b = new AbortController();
    const own = new AbortController();
    await Promise.all([
      runTelegramRequest(a.signal, async () => {
        await new Promise(resolve => setImmediate(resolve));
        await requestTelegramClient(client).call({}, { abortSignal: own.signal });
      }),
      runTelegramRequest(b.signal, () => requestTelegramClient(client).call({})),
    ]);
    expect(signals[0]).toBe(b.signal);
    own.abort();
    expect(signals[1].aborted).toBe(true);
    expect(b.signal.aborted).toBe(false);
    expect(requestTelegramClient(client)).toBe(client);
  });

  it('does not dispatch a new RPC after its deadline', async () => {
    const call = vi.fn();
    const controller = new AbortController();
    controller.abort(new Error('deadline'));
    expect(() => runTelegramRequest(controller.signal, () => requestTelegramClient({ call }).call({})))
      .toThrow('deadline');
    expect(call).not.toHaveBeenCalled();
  });

  it('keeps lifecycle receivers compatible with private client fields', async () => {
    class Client {
      #closed = false;
      destroy() { this.#closed = true; }
      get destroyed() { return this.#closed; }
    }
    await runTelegramRequest(new AbortController().signal, () => {
      const client = requestTelegramClient(new Client());
      client.destroy();
      expect(client.destroyed).toBe(true);
    });
  });
});
