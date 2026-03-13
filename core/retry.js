import { setTimeout as delay } from 'timers/promises';

function formatErrorMessage(error) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return String(error);
}

function parseRequiredWaitSeconds(error) {
  const text = formatErrorMessage(error);
  const waitMatch = /wait of (\d+) seconds is required/i.exec(text);
  if (waitMatch) {
    return Number(waitMatch[1]);
  }
  const floodWaitMatch = /FLOOD_WAIT_(\d+)/i.exec(text);
  if (floodWaitMatch) {
    return Number(floodWaitMatch[1]);
  }
  return null;
}

function classifyError(error) {
  const message = formatErrorMessage(error);
  const code = error?.code ?? null;
  if (parseRequiredWaitSeconds(error) !== null || /FLOOD_WAIT/i.test(message)) {
    return { type: 'rate_limit', message, code };
  }
  if (/ECONNRESET|ETIMEDOUT|ENETUNREACH/i.test(message) ||
      /ECONNRESET|ETIMEDOUT|ENETUNREACH/.test(code ?? '')) {
    return { type: 'network', message, code };
  }
  return { type: 'api', message, code };
}

function computeRetryWaitSeconds(error, attempt) {
  const rateLimitWait = parseRequiredWaitSeconds(error);
  if (rateLimitWait !== null) {
    return rateLimitWait;
  }
  // Exponential backoff: 1s, 2s, 4s, ...
  return Math.pow(2, attempt - 1);
}

async function withSendRetry(fn, options = {}) {
  const maxRetries = options.retries ?? 0;
  const json = options.json ?? false;
  const retryLog = [];
  const maxAttempts = maxRetries + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await fn();
      return { result, retryLog, attempts: attempt };
    } catch (error) {
      if (attempt >= maxAttempts) {
        error.retryLog = retryLog;
        error.attempts = attempt;
        throw error;
      }

      const classified = classifyError(error);
      const waitSeconds = computeRetryWaitSeconds(error, attempt);

      retryLog.push({
        attempt,
        error: classified,
      });

      if (json) {
        process.stderr.write(`${JSON.stringify({
          event: 'retry',
          attempt,
          maxAttempts,
          error: classified,
          waitSeconds,
        })}\n`);
      } else {
        process.stderr.write(`Retry ${attempt}/${maxRetries}: ${classified.type.toUpperCase()} — ${classified.message}. Waiting ${waitSeconds}s...\n`);
      }

      await delay(waitSeconds * 1000);
    }
  }
}

export { classifyError, computeRetryWaitSeconds, withSendRetry };
