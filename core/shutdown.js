export const SHUTDOWN_TIMEOUT_MS = 10000;

export function startShutdownWatchdog({ timeoutMs = SHUTDOWN_TIMEOUT_MS,
  onTimeout = () => {
    console.error('[shutdown] Cleanup exceeded its deadline; exiting without releasing live ownership early.');
    process.exit(1);
  } } = {}) {
  // A stuck operation must not outlive the process that owns its store. The OS
  // releases the ownership guard on exit; another writer cannot enter early.
  const timer = setTimeout(onTimeout, timeoutMs);
  timer.unref?.();
  return () => clearTimeout(timer);
}
