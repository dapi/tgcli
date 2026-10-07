import { afterEach, expect, it, vi } from 'vitest';
import { startShutdownWatchdog } from '../core/shutdown.js';

afterEach(() => vi.useRealTimers());

it('forces process termination on a stuck cleanup and disarms after a clean shutdown', () => {
  vi.useFakeTimers();
  const onTimeout = vi.fn();
  const disarm = startShutdownWatchdog({ timeoutMs: 100, onTimeout });
  vi.advanceTimersByTime(99);
  expect(onTimeout).not.toHaveBeenCalled();
  disarm();
  vi.advanceTimersByTime(100);
  expect(onTimeout).not.toHaveBeenCalled();
  startShutdownWatchdog({ timeoutMs: 100, onTimeout });
  vi.advanceTimersByTime(100);
  expect(onTimeout).toHaveBeenCalledTimes(1);
});
