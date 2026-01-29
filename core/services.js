import path from 'path';

import TelegramClient from '../telegram-client.js';
import MessageSyncService from '../message-sync-service.js';
import { resolveStorePaths } from './store.js';

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_INTER_JOB_DELAY_MS = 3000;
const DEFAULT_INTER_BATCH_DELAY_MS = 1200;

export function createServices(options = {}) {
  const resolvedStoreDir = options.storeDir ? path.resolve(options.storeDir) : null;
  if (!resolvedStoreDir && (!options.sessionPath || !options.dbPath)) {
    throw new Error('storeDir is required when sessionPath or dbPath are not provided.');
  }

  const paths = resolvedStoreDir ? resolveStorePaths(resolvedStoreDir) : {};
  const sessionPath = options.sessionPath ?? paths.sessionPath;
  const dbPath = options.dbPath ?? paths.dbPath;

  if (!sessionPath || !dbPath) {
    throw new Error('sessionPath and dbPath are required.');
  }

  const telegramClient = new TelegramClient(
    process.env.TELEGRAM_API_ID,
    process.env.TELEGRAM_API_HASH,
    process.env.TELEGRAM_PHONE_NUMBER,
    sessionPath,
  );

  const messageSyncService = new MessageSyncService(telegramClient, {
    dbPath,
    batchSize: options.batchSize ?? DEFAULT_BATCH_SIZE,
    interJobDelayMs: options.interJobDelayMs ?? DEFAULT_INTER_JOB_DELAY_MS,
    interBatchDelayMs: options.interBatchDelayMs ?? DEFAULT_INTER_BATCH_DELAY_MS,
  });

  return {
    storeDir: resolvedStoreDir,
    telegramClient,
    messageSyncService,
  };
}
