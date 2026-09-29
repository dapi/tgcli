export class OwnerCoordinator {
  constructor({ maxLive = 4 } = {}) {
    if (!Number.isInteger(maxLive) || maxLive < 1) throw new Error('maxLive must be positive');
    this.maxLive = maxLive;
    this.active = 0;
    this.waiters = [];
  }

  async runLive(work, { signal } = {}) {
    if (signal?.aborted) throw this.abortedError();
    if (this.active >= this.maxLive) {
      await new Promise((resolve, reject) => {
        const waiter = { resolve, reject, signal };
        this.waiters.push(waiter);
        if (signal) {
          waiter.onAbort = () => {
            this.waiters = this.waiters.filter((entry) => entry !== waiter);
            reject(this.abortedError());
          };
          signal.addEventListener('abort', waiter.onAbort, { once: true });
        }
      });
    } else {
      this.active += 1;
    }
    try {
      if (signal?.aborted) throw this.abortedError();
      return await work();
    } finally {
      this.release();
    }
  }

  release() {
    while (this.waiters.length) {
      const next = this.waiters.shift();
      next.signal?.removeEventListener('abort', next.onAbort);
      if (next.signal?.aborted) {
        next.reject(this.abortedError());
        continue;
      }
      next.resolve();
      return;
    }
    this.active -= 1;
  }

  abortedError() {
    const error = new Error('Owner request deadline expired before execution');
    error.code = 'OWNER_BUSY';
    return error;
  }
}
