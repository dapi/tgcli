#!/usr/bin/env node
import os from 'os';
import path from 'path';
import { setTimeout as delay } from 'timers/promises';
import dotenv from 'dotenv';

import TelegramClient from './telegram-client.js';
import MessageSyncService from './message-sync-service.js';
import { acquireStoreLock, readStoreLock } from './store-lock.js';

dotenv.config();

const DEFAULT_STORE_DIR = process.env.FROGIVERSE_STORE
  ? path.resolve(process.env.FROGIVERSE_STORE)
  : path.join(os.homedir(), '.frogiverse');

function printUsage() {
  const text = `frogiverse CLI\n\n` +
    `Usage:\n` +
    `  node cli.js [--store DIR] [--json] <command> [options]\n\n` +
    `Commands:\n` +
    `  auth [--follow]\n` +
    `  auth status\n` +
    `  auth logout\n` +
    `  sync [--once|--follow] [--idle-exit 30s]\n` +
    `  doctor [--connect]\n` +
    `  send text --to <id|username> --message "..." [--topic <id>]\n` +
    `  send file --to <id|username> --file PATH [--caption "..."] [--filename NAME] [--topic <id>]\n` +
    `  media download --chat <id|username> --id <msgId> [--output PATH]\n`;
  console.log(text);
}

function writeJson(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function writeError(error, asJson) {
  const message = error?.message ?? String(error);
  if (asJson) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: message })}\n`);
  } else {
    process.stderr.write(`${message}\n`);
  }
}

function parseDuration(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  const raw = value.trim();
  const match = raw.match(/^(\d+)(ms|s|m|h)?$/i);
  if (!match) {
    throw new Error(`Invalid duration: ${value}`);
  }
  const amount = Number(match[1]);
  const unit = (match[2] || 's').toLowerCase();
  if (unit === 'ms') return amount;
  if (unit === 's') return amount * 1000;
  if (unit === 'm') return amount * 60 * 1000;
  if (unit === 'h') return amount * 60 * 60 * 1000;
  return amount * 1000;
}

function parseGlobalFlags(args) {
  const flags = { store: null, json: false, help: false };
  const rest = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('-')) {
      rest.push(...args.slice(i));
      break;
    }
    if (arg === '--json') {
      flags.json = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      flags.help = true;
      continue;
    }
    if (arg === '--store') {
      const next = args[i + 1];
      if (!next) {
        throw new Error('--store requires a value');
      }
      flags.store = next;
      i += 1;
      continue;
    }
    if (arg.startsWith('--store=')) {
      flags.store = arg.slice('--store='.length);
      continue;
    }
    rest.push(...args.slice(i));
    break;
  }
  return { flags, rest };
}

function parseFlags(args, spec) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      rest.push(arg);
      continue;
    }
    const [rawKey, rawValue] = arg.split('=');
    const key = rawKey.slice(2);
    const rule = spec[key];
    if (!rule) {
      rest.push(arg);
      continue;
    }
    if (rule.type === 'boolean') {
      flags[key] = true;
      continue;
    }
    const value = rawValue ?? args[i + 1];
    if (value === undefined) {
      throw new Error(`--${key} requires a value`);
    }
    if (!rawValue) {
      i += 1;
    }
    flags[key] = value;
  }
  return { flags, rest };
}

function parsePositiveInt(value, label) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive number`);
  }
  return parsed;
}

function resolveStoreDir(storeOverride) {
  return storeOverride ? path.resolve(storeOverride) : DEFAULT_STORE_DIR;
}

function createServices(storeDir) {
  const sessionPath = path.join(storeDir, 'session.json');
  const dbPath = path.join(storeDir, 'messages.db');
  const telegramClient = new TelegramClient(
    process.env.TELEGRAM_API_ID,
    process.env.TELEGRAM_API_HASH,
    process.env.TELEGRAM_PHONE_NUMBER,
    sessionPath,
  );
  const messageSyncService = new MessageSyncService(telegramClient, {
    dbPath,
    batchSize: 100,
    interJobDelayMs: 3000,
    interBatchDelayMs: 1200,
  });
  return { telegramClient, messageSyncService };
}

async function withShutdown(handler) {
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await handler();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

async function waitForIdle(service, idleExitMs) {
  let idleStart = null;
  while (true) {
    const stats = service.getQueueStats();
    const active = stats.pending + stats.in_progress;
    if (!stats.processing && active === 0) {
      if (!idleStart) {
        idleStart = Date.now();
      }
      if (Date.now() - idleStart >= idleExitMs) {
        return;
      }
    } else {
      idleStart = null;
    }
    await delay(500);
  }
}

async function runAuth(globalFlags, args) {
  const { flags, rest } = parseFlags(args, {
    follow: { type: 'boolean' },
  });
  const subcommand = rest[0];
  const storeDir = resolveStoreDir(globalFlags.store);

  if (subcommand === 'status') {
    const { telegramClient, messageSyncService } = createServices(storeDir);
    try {
      const authenticated = await telegramClient.isAuthorized().catch(() => false);
      const search = messageSyncService.getSearchStatus();
      const payload = { authenticated, ftsEnabled: search.enabled };
      if (globalFlags.json) {
        writeJson(payload);
      } else {
        console.log(authenticated ? 'Authenticated.' : 'Not authenticated.');
      }
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
    }
    return;
  }

  if (subcommand === 'logout') {
    const release = acquireStoreLock(storeDir);
    const { telegramClient, messageSyncService } = createServices(storeDir);
    try {
      await telegramClient.login();
      await telegramClient.client.logout();
      if (globalFlags.json) {
        writeJson({ loggedOut: true });
      } else {
        console.log('Logged out.');
      }
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
      release();
    }
    return;
  }

  const release = acquireStoreLock(storeDir);
  const { telegramClient, messageSyncService } = createServices(storeDir);
  try {
    const loginSuccess = await telegramClient.login();
    if (!loginSuccess) {
      throw new Error('Failed to login to Telegram.');
    }
    const dialogCount = await messageSyncService.refreshChannelsFromDialogs();
    if (flags.follow) {
      await telegramClient.startUpdates();
      messageSyncService.startRealtimeSync();
      messageSyncService.resumePendingJobs();
      await withShutdown(async () => {
        await messageSyncService.shutdown();
        await telegramClient.destroy();
        release();
      });
      return;
    }

    if (globalFlags.json) {
      writeJson({ authenticated: true, dialogs: dialogCount });
    } else {
      console.log(`Authenticated. Seeded ${dialogCount} dialogs.`);
    }
  } finally {
    if (!flags.follow) {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
      release();
    }
  }
}

async function runSync(globalFlags, args) {
  const { flags } = parseFlags(args, {
    once: { type: 'boolean' },
    follow: { type: 'boolean' },
    'idle-exit': { type: 'string' },
  });
  const storeDir = resolveStoreDir(globalFlags.store);
  const release = acquireStoreLock(storeDir);
  const { telegramClient, messageSyncService } = createServices(storeDir);
  const idleExitMs = parseDuration(flags['idle-exit'] || '30s');
  const follow = flags.follow || !flags.once;

  try {
    if (!(await telegramClient.isAuthorized().catch(() => false))) {
      throw new Error('Not authenticated. Run `node cli.js auth` first.');
    }

    await messageSyncService.refreshChannelsFromDialogs();
    messageSyncService.resumePendingJobs();

    if (follow) {
      await telegramClient.startUpdates();
      messageSyncService.startRealtimeSync();
      if (!globalFlags.json) {
        console.log('Sync running. Press Ctrl+C to stop.');
      }
      await withShutdown(async () => {
        await messageSyncService.shutdown();
        await telegramClient.destroy();
        release();
      });
      return;
    }

    await waitForIdle(messageSyncService, idleExitMs);
    const stats = messageSyncService.getQueueStats();
    if (globalFlags.json) {
      writeJson({ ok: true, mode: 'once', queue: stats });
    } else {
      console.log('Sync complete.');
    }
  } finally {
    if (!follow) {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
      release();
    }
  }
}

async function runDoctor(globalFlags, args) {
  const { flags } = parseFlags(args, {
    connect: { type: 'boolean' },
  });
  const storeDir = resolveStoreDir(globalFlags.store);
  const lock = readStoreLock(storeDir);
  const { telegramClient, messageSyncService } = createServices(storeDir);
  try {
    let authenticated = false;
    let connected = false;
    try {
      authenticated = await telegramClient.isAuthorized();
      if (flags.connect && authenticated) {
        await telegramClient.startUpdates();
        connected = true;
      }
    } catch (error) {
      authenticated = false;
    }

    const search = messageSyncService.getSearchStatus();
    const queue = messageSyncService.getQueueStats();

    const payload = {
      storeDir,
      lockHeld: lock.exists,
      lockInfo: lock.info,
      authenticated,
      connected,
      ftsEnabled: search.enabled,
      ftsVersion: search.version,
      queue,
    };

    if (globalFlags.json) {
      writeJson(payload);
      return;
    }

    console.log(`STORE: ${payload.storeDir}`);
    console.log(`LOCKED: ${payload.lockHeld}${payload.lockInfo ? ` (${payload.lockInfo})` : ''}`);
    console.log(`AUTHENTICATED: ${payload.authenticated}`);
    console.log(`CONNECTED: ${payload.connected}`);
    console.log(`FTS: ${payload.ftsEnabled}${payload.ftsVersion ? ` (v${payload.ftsVersion})` : ''}`);
    console.log(`QUEUE: pending=${queue.pending} in_progress=${queue.in_progress} idle=${queue.idle} error=${queue.error}`);
  } finally {
    await messageSyncService.shutdown();
    await telegramClient.destroy();
  }
}

async function runSend(globalFlags, args) {
  const [mode, ...rest] = args;
  if (!mode) {
    throw new Error('send requires a subcommand: text | file');
  }

  const storeDir = resolveStoreDir(globalFlags.store);
  const release = acquireStoreLock(storeDir);
  const { telegramClient, messageSyncService } = createServices(storeDir);

  try {
    if (!(await telegramClient.isAuthorized().catch(() => false))) {
      throw new Error('Not authenticated. Run `node cli.js auth` first.');
    }

    if (mode === 'text') {
      const { flags } = parseFlags(rest, {
        to: { type: 'string' },
        message: { type: 'string' },
        topic: { type: 'string' },
      });
      if (!flags.to) {
        throw new Error('--to is required');
      }
      if (!flags.message) {
        throw new Error('--message is required');
      }
      const topicId = parsePositiveInt(flags.topic, '--topic');
      const result = await telegramClient.sendTextMessage(flags.to, flags.message, { topicId });
      const payload = { channelId: flags.to, ...result };

      if (globalFlags.json) {
        writeJson(payload);
      } else {
        console.log(`Message sent (${result.messageId}).`);
      }
      return;
    }

    if (mode === 'file') {
      const { flags } = parseFlags(rest, {
        to: { type: 'string' },
        file: { type: 'string' },
        caption: { type: 'string' },
        filename: { type: 'string' },
        topic: { type: 'string' },
      });
      if (!flags.to) {
        throw new Error('--to is required');
      }
      if (!flags.file) {
        throw new Error('--file is required');
      }
      const topicId = parsePositiveInt(flags.topic, '--topic');
      const result = await telegramClient.sendFileMessage(flags.to, flags.file, {
        caption: flags.caption,
        filename: flags.filename,
        topicId,
      });
      const payload = { channelId: flags.to, ...result };

      if (globalFlags.json) {
        writeJson(payload);
      } else {
        console.log(`File sent (${result.messageId}).`);
      }
      return;
    }

    throw new Error(`Unknown send subcommand: ${mode}`);
  } finally {
    await messageSyncService.shutdown();
    await telegramClient.destroy();
    release();
  }
}

async function runMedia(globalFlags, args) {
  const [mode, ...rest] = args;
  if (!mode) {
    throw new Error('media requires a subcommand: download');
  }
  if (mode !== 'download') {
    throw new Error(`Unknown media subcommand: ${mode}`);
  }

  const { flags } = parseFlags(rest, {
    chat: { type: 'string' },
    id: { type: 'string' },
    output: { type: 'string' },
  });
  if (!flags.chat) {
    throw new Error('--chat is required');
  }
  if (!flags.id) {
    throw new Error('--id is required');
  }
  const messageId = parsePositiveInt(flags.id, '--id');

  const storeDir = resolveStoreDir(globalFlags.store);
  const release = acquireStoreLock(storeDir);
  const { telegramClient, messageSyncService } = createServices(storeDir);

  try {
    if (!(await telegramClient.isAuthorized().catch(() => false))) {
      throw new Error('Not authenticated. Run `node cli.js auth` first.');
    }
    const result = await telegramClient.downloadMessageMedia(flags.chat, messageId, {
      outputPath: flags.output,
    });

    if (globalFlags.json) {
      writeJson(result);
    } else {
      console.log(`Downloaded to ${result.path} (${result.bytes} bytes).`);
    }
  } finally {
    await messageSyncService.shutdown();
    await telegramClient.destroy();
    release();
  }
}

async function main() {
  try {
    const { flags: globalFlags, rest } = parseGlobalFlags(process.argv.slice(2));
    if (globalFlags.help || rest.length === 0) {
      printUsage();
      return;
    }

    const [command, ...args] = rest;
    if (command === 'auth') {
      await runAuth(globalFlags, args);
      return;
    }
    if (command === 'sync') {
      await runSync(globalFlags, args);
      return;
    }
    if (command === 'doctor') {
      await runDoctor(globalFlags, args);
      return;
    }
    if (command === 'send') {
      await runSend(globalFlags, args);
      return;
    }
    if (command === 'media') {
      await runMedia(globalFlags, args);
      return;
    }

    printUsage();
  } catch (error) {
    writeError(error, process.argv.includes('--json'));
    process.exit(1);
  }
}

await main();
