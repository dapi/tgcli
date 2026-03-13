const DEFAULT_BACKOFF_MS = 1000;
const RETRY_BACKOFF_STRATEGIES = new Set(['constant', 'linear', 'exponential']);
const RETRYABLE_TIMEOUT_CODES = new Set(['ETIMEDOUT', 'ERR_OPERATION_TIMED_OUT']);
const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNABORTED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'EPIPE',
  'ENETDOWN',
  'ENETRESET',
  'ENETUNREACH',
  'ERR_NETWORK',
]);
const VALIDATION_ERROR_CODES = new Set(['EACCES', 'EISDIR', 'ENOENT', 'EPERM']);
const TELEGRAM_ERROR_MARKERS = [
  'AUTH_KEY',
  'BOT_METHOD_INVALID',
  'CHANNEL_INVALID',
  'CHANNEL_PRIVATE',
  'CHAT_ADMIN_REQUIRED',
  'CHAT_SEND_MEDIA_FORBIDDEN',
  'CHAT_SEND_PHOTOS_FORBIDDEN',
  'CHAT_WRITE_FORBIDDEN',
  'FLOOD_WAIT',
  'MESSAGE_ID_INVALID',
  'MESSAGE_TOO_LONG',
  'PEER_ID_INVALID',
  'PHOTO_INVALID',
  'RPC',
  'SCHEDULE',
  'USER_BANNED_IN_CHANNEL',
];
const VALIDATION_MESSAGE_PATTERNS = [
  /^--/,
  /^File not found:/,
  /^Message text cannot be empty\./,
  /^filePath must be a string\./,
  /^Invalid parse mode\./,
  /^Invalid schedule date:/,
  /^Not authenticated\./,
];

function formatErrorMessage(error) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error ?? 'Unknown error');
}

function extractErrorCode(error) {
  if (!error || typeof error !== 'object') {
    return null;
  }
  const code = error.code ?? error.errorCode ?? error.rpcCode ?? error.cause?.code ?? null;
  return code === undefined ? null : code;
}

function looksLikeValidationError(message, code) {
  if (code && VALIDATION_ERROR_CODES.has(String(code).toUpperCase())) {
    return true;
  }
  return VALIDATION_MESSAGE_PATTERNS.some((pattern) => pattern.test(message));
}

function looksLikeTimeoutError(message, code) {
  const normalizedCode = code ? String(code).toUpperCase() : '';
  if (normalizedCode && RETRYABLE_TIMEOUT_CODES.has(normalizedCode)) {
    return true;
  }
  const lowered = message.toLowerCase();
  return lowered === 'timeout' || lowered.includes('timed out') || lowered.includes('timeout');
}

function looksLikeRetryableNetworkError(message, code) {
  const normalizedCode = code ? String(code).toUpperCase() : '';
  if (normalizedCode && RETRYABLE_NETWORK_CODES.has(normalizedCode)) {
    return true;
  }
  const lowered = message.toLowerCase();
  return lowered.includes('connection reset')
    || lowered.includes('connection aborted')
    || lowered.includes('broken pipe')
    || lowered.includes('temporary disconnect')
    || lowered.includes('network');
}

function looksLikeTransportError(message, error) {
  if (error?.name === 'TransportError') {
    return true;
  }
  return message.toLowerCase().includes('transport error');
}

function looksLikeTelegramError(message, code, error) {
  if (typeof code === 'number') {
    return true;
  }
  if (error?.name === 'RpcError' || error?.name === 'MtRpcError') {
    return true;
  }
  const upper = message.toUpperCase();
  return TELEGRAM_ERROR_MARKERS.some((marker) => upper.includes(marker));
}

export class SendCommandError extends Error {
  constructor(details) {
    super(details?.message ?? 'Send failed');
    this.name = 'SendCommandError';
    this.details = details;
  }
}

export function parseRetryBackoff(value) {
  if (value && typeof value === 'object' && typeof value.kind === 'string') {
    return {
      kind: value.kind,
      baseMs: Number.isFinite(value.baseMs) ? value.baseMs : DEFAULT_BACKOFF_MS,
      raw: value.raw ?? String(value.kind),
    };
  }

  if (value === undefined || value === null || value === '') {
    return { kind: 'constant', baseMs: DEFAULT_BACKOFF_MS, raw: String(DEFAULT_BACKOFF_MS) };
  }

  const normalized = String(value).trim().toLowerCase();
  if (/^\d+$/.test(normalized)) {
    return { kind: 'constant', baseMs: Number(normalized), raw: normalized };
  }
  if (RETRY_BACKOFF_STRATEGIES.has(normalized)) {
    return { kind: normalized, baseMs: DEFAULT_BACKOFF_MS, raw: normalized };
  }

  throw new Error('--retry-backoff must be a non-negative integer or one of: constant, linear, exponential');
}

export function getRetryDelayMs(backoff, attempt) {
  const strategy = backoff?.kind ?? 'constant';
  const baseMs = Number.isFinite(backoff?.baseMs) ? backoff.baseMs : DEFAULT_BACKOFF_MS;

  if (strategy === 'linear') {
    return baseMs * attempt;
  }
  if (strategy === 'exponential') {
    return baseMs * (2 ** Math.max(0, attempt - 1));
  }
  return baseMs;
}

export function classifySendError(error, { method, attempt = 1, retries = 0 } = {}) {
  if (error instanceof SendCommandError) {
    return error.details;
  }

  const message = formatErrorMessage(error);
  const code = extractErrorCode(error);

  if (looksLikeValidationError(message, code)) {
    return {
      type: 'validation',
      method,
      message,
      code,
      attempt,
      retries,
      retryable: false,
    };
  }

  if (looksLikeTimeoutError(message, code)) {
    const normalizedCode = code ? String(code).toUpperCase() : '';
    return {
      type: 'timeout',
      method,
      message,
      code,
      attempt,
      retries,
      retryable: normalizedCode ? RETRYABLE_TIMEOUT_CODES.has(normalizedCode) : message.toLowerCase() !== 'timeout',
    };
  }

  if (looksLikeRetryableNetworkError(message, code)) {
    return {
      type: 'network',
      method,
      message,
      code,
      attempt,
      retries,
      retryable: true,
    };
  }

  if (looksLikeTransportError(message, error)) {
    return {
      type: 'network',
      method,
      message,
      code,
      attempt,
      retries,
      retryable: true,
    };
  }

  if (looksLikeTelegramError(message, code, error)) {
    return {
      type: 'telegram',
      method,
      message,
      code,
      attempt,
      retries,
      retryable: false,
    };
  }

  return {
    type: 'unknown',
    method,
    message,
    code,
    attempt,
    retries,
    retryable: false,
  };
}

function createTimeoutDetails({ method, attempt, retries }) {
  return {
    type: 'timeout',
    method,
    message: 'Timeout',
    code: null,
    attempt,
    retries,
    retryable: false,
  };
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getRemainingTimeoutMs(deadlineAt, now) {
  if (deadlineAt === null) {
    return null;
  }
  return deadlineAt - now();
}

export async function executeSendWithRetries(sendFn, options = {}) {
  const retries = Number.isInteger(options.retries) && options.retries >= 0 ? options.retries : 0;
  const method = options.method ?? 'sendMedia';
  const backoff = parseRetryBackoff(options.retryBackoff);
  const sleep = options.sleep ?? delay;
  const now = options.now ?? (() => Date.now());
  const deadlineAt = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? now() + options.timeoutMs
    : null;

  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    const remainingBeforeAttemptMs = getRemainingTimeoutMs(deadlineAt, now);
    if (remainingBeforeAttemptMs !== null && remainingBeforeAttemptMs <= 0) {
      throw new SendCommandError(createTimeoutDetails({
        method,
        attempt: Math.max(1, attempt - 1),
        retries,
      }));
    }

    try {
      const result = await sendFn({ attempt });
      return { result, attempts: attempt };
    } catch (error) {
      const details = classifySendError(error, { method, attempt, retries });
      const shouldRetry = details.retryable && attempt <= retries;
      if (!shouldRetry) {
        throw new SendCommandError(details);
      }

      if (typeof options.onRetry === 'function') {
        try {
          options.onRetry(details);
        } catch (callbackError) {
          console.error('[executeSendWithRetries] onRetry callback error:', callbackError);
        }
      }

      const retryDelayMs = getRetryDelayMs(backoff, attempt);
      if (deadlineAt !== null) {
        const remainingMs = getRemainingTimeoutMs(deadlineAt, now);
        if (remainingMs <= 0) {
          throw new SendCommandError(createTimeoutDetails({ method, attempt, retries }));
        }
        if (retryDelayMs > 0) {
          await sleep(Math.min(retryDelayMs, remainingMs));
          if (getRemainingTimeoutMs(deadlineAt, now) <= 0) {
            throw new SendCommandError(createTimeoutDetails({ method, attempt, retries }));
          }
        }
      } else if (retryDelayMs > 0) {
        await sleep(retryDelayMs);
      }
    }
  }

  // Unreachable: the loop always exits via return (success) or throw (in catch).
  // Kept as a safety net in case future refactors break the loop invariant.
  throw new SendCommandError(createTimeoutDetails({ method, attempt: retries + 1, retries }));
}

export function buildSendSuccessPayload({ method, chatId, messageId, media, attempts }) {
  const payload = {
    ok: true,
    method,
    chat_id: chatId,
    message_id: messageId,
    attempts,
  };

  if (media && typeof media === 'object') {
    const mediaPayload = {};
    if (media.type) mediaPayload.type = media.type;
    if (media.fileId) mediaPayload.file_id = media.fileId;
    if (Object.keys(mediaPayload).length > 0) {
      payload.media = mediaPayload;
    }
  }

  return payload;
}

export function buildSendErrorPayload(details = {}) {
  const payload = {
    ok: false,
    error: {
      type: details.type ?? 'unknown',
      method: details.method ?? 'sendMedia',
      message: details.message ?? 'Unknown error',
      attempt: details.attempt ?? 1,
      retries: details.retries ?? 0,
    },
  };

  if (details.code !== undefined && details.code !== null && details.code !== '') {
    payload.error.code = details.code;
  }

  return payload;
}

export function formatSendErrorMessage(details = {}) {
  const attempt = details.attempt ?? 1;
  const retries = details.retries ?? 0;
  const totalAttempts = retries + 1;
  const codeSuffix = details.code !== undefined && details.code !== null && details.code !== ''
    ? `, code ${details.code}`
    : '';
  return `${details.method ?? 'sendMedia'} failed [${details.type ?? 'unknown'}]: ${details.message ?? 'Unknown error'} (attempt ${attempt}/${totalAttempts}${codeSuffix})`;
}
