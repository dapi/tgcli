import { AsyncLocalStorage } from 'node:async_hooks';

const requests = new AsyncLocalStorage();

export function runTelegramRequest(signal, work) {
  return requests.run(signal ? { signal, clients: new WeakMap() } : undefined, work);
}

export function getTelegramRequestSignal() {
  return requests.getStore()?.signal;
}

function waitForRpc(work, signal) {
  let onAbort;
  return new Promise((resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    // mtcute may still be waiting for a shared initial connection before it
    // reaches sendRpc. Its aborted signal prevents dispatch after connection.
    Promise.resolve(work).then(resolve, reject);
    if (signal.aborted) onAbort();
  }).finally(() => signal.removeEventListener('abort', onAbort));
}

export function requestTelegramClient(client) {
  const context = requests.getStore();
  if (!context || !client) return client;
  const { signal, clients } = context;
  if (clients.has(client)) return clients.get(client);
  // Like mtcute's withParams(), wrap its nested high-level clients as well.
  // Merge the signal last: upload helpers pass abortSignal: undefined and can
  // otherwise erase default call options. Never mutate the shared client.
  const wrapped = new Proxy(client, {
    get(target, property, receiver) {
      if (property === 'call') {
        return (message, options = {}) => {
          signal.throwIfAborted();
          const abortSignal = options.abortSignal && options.abortSignal !== signal
            ? AbortSignal.any([signal, options.abortSignal]) : signal;
          abortSignal.throwIfAborted();
          return waitForRpc(target.call(message, { ...options, abortSignal }), abortSignal);
        };
      }
      const value = Reflect.get(target, property, target);
      if (value && typeof value === 'object' && 'storage' in value && typeof value.call === 'function') {
        return requestTelegramClient(value);
      }
      // Lifecycle methods may use private fields and must keep their receiver.
      if (['destroy', 'disconnect', 'connect', 'prepare'].includes(property) && typeof value === 'function') {
        return value.bind(target);
      }
      return typeof value === 'function' ? value.bind(receiver) : value;
    },
  });
  clients.set(client, wrapped);
  return wrapped;
}
