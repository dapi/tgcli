#!/usr/bin/env node
import fs from 'fs';
import { spawn } from 'child_process';
import { setTimeout as delay } from 'timers/promises';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

import { acquireStoreLock, readStoreLock } from './store-lock.js';
import { createServices } from './core/services.js';
import { resolveStoreDir } from './core/store.js';

dotenv.config();

function printUsage() {
  const text = `tgcli CLI\n\n` +
    `Usage:\n` +
    `  tgcli [--json] [--timeout 30s] [--version] <command> [options]\n\n` +
    `Commands:\n` +
    `  auth [--follow]\n` +
    `  auth status\n` +
    `  auth logout\n` +
    `  sync [--once|--follow] [--idle-exit 30s]\n` +
    `  sync status\n` +
    `  sync jobs list [--status pending|in_progress|idle|error] [--limit N] [--channel <id|username>]\n` +
    `  sync jobs add --chat <id|username> [--depth N] [--min-date ISO]\n` +
    `  sync jobs retry [--job-id N] [--channel <id|username>] [--all-errors]\n` +
    `  sync jobs cancel --job-id N|--channel <id|username>\n` +
    `  server\n` +
    `  doctor [--connect]\n` +
    `  channels list [--query TEXT] [--limit N]\n` +
    `  channels show --chat <id|username>\n` +
    `  channels sync --chat <id|username> --enable|--disable\n` +
    `  messages list [--chat <id|username>] [--topic <id>] [--source archive|live|both] [--after ISO] [--before ISO] [--limit N]\n` +
    `  messages search <query> [--chat <id|username>] [--topic <id>] [--source archive|live|both] [--after ISO] [--before ISO] [--tag TAG] [--regex REGEX] [--limit N]\n` +
    `  messages show --chat <id|username> --id <msgId> [--source archive|live|both]\n` +
    `  messages context --chat <id|username> --id <msgId> [--before N] [--after N] [--source archive|live|both]\n` +
    `  send text --to <id|username> --message "..." [--topic <id>]\n` +
    `  send file --to <id|username> --file PATH [--caption "..."] [--filename NAME] [--topic <id>]\n` +
    `  media download --chat <id|username> --id <msgId> [--output PATH]\n` +
    `  topics list --chat <id|username> [--limit N]\n` +
    `  topics search --chat <id|username> --query TEXT [--limit N]\n` +
    `  tags set --chat <id|username> --tags tag1,tag2 [--source manual]\n` +
    `  tags list --chat <id|username> [--source manual]\n` +
    `  tags search --tag TAG [--source manual] [--limit N]\n` +
    `  tags auto [--chat <id|username>] [--limit N] [--source auto] [--no-refresh-metadata]\n` +
    `  metadata get --chat <id|username>\n` +
    `  metadata refresh [--chat <id|username>] [--limit N] [--force] [--only-missing]\n` +
    `  contacts search <query> [--limit N]\n` +
    `  contacts show --user <id>\n` +
    `  contacts alias set --user <id> --alias "Name"\n` +
    `  contacts alias rm --user <id>\n` +
    `  contacts tags add --user <id> --tag TAG [--tag TAG]\n` +
    `  contacts tags rm --user <id> --tag TAG [--tag TAG]\n` +
    `  contacts notes set --user <id> --notes "..." \n` +
    `  groups list [--query TEXT] [--limit N]\n` +
    `  groups info --chat <id|username>\n` +
    `  groups rename --chat <id|username> --name "New Name"\n` +
    `  groups members add --chat <id|username> --user <id> [--user <id>]\n` +
    `  groups members remove --chat <id|username> --user <id> [--user <id>]\n` +
    `  groups invite link get --chat <id|username>\n` +
    `  groups invite link revoke --chat <id|username>\n` +
    `  groups join --code <invite-code>\n` +
    `  groups leave --chat <id|username>\n`;
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

function runWithTimeout(task, timeoutMs, onTimeout) {
  if (!timeoutMs) {
    return task();
  }
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(async () => {
      try {
        if (onTimeout) {
          await onTimeout();
        }
      } finally {
        reject(new Error('Timeout'));
      }
    }, timeoutMs);
  });
  return Promise.race([task(), timeoutPromise]).finally(() => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  });
}

function readVersion() {
  try {
    const pkgPath = new URL('./package.json', import.meta.url);
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return pkg.version || '0.0.0';
  } catch (error) {
    return '0.0.0';
  }
}

function parseGlobalFlags(args) {
  const flags = {
    json: false,
    help: false,
    version: false,
    timeout: null,
  };
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
    if (arg === '--version') {
      flags.version = true;
      continue;
    }
    if (arg === '--timeout') {
      const next = args[i + 1];
      if (!next) {
        throw new Error('--timeout requires a value');
      }
      flags.timeout = next;
      i += 1;
      continue;
    }
    if (arg.startsWith('--timeout=')) {
      flags.timeout = arg.slice('--timeout='.length);
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
    if (rule.multiple) {
      if (!flags[key]) {
        flags[key] = [];
      }
      flags[key].push(value);
    } else {
      flags[key] = value;
    }
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

function parseNonNegativeInt(value, label) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative number`);
  }
  return parsed;
}

function parseListValues(value) {
  const raw = Array.isArray(value) ? value : (value ? [value] : []);
  return raw
    .flatMap((entry) => String(entry).split(','))
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function resolveSource(source) {
  const resolved = source ? String(source).toLowerCase() : 'archive';
  if (!['archive', 'live', 'both'].includes(resolved)) {
    throw new Error(`Invalid source: ${source}`);
  }
  return resolved;
}

function parseDateMs(value, label) {
  if (!value) {
    return null;
  }
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return ts;
}

function filterLiveMessagesByDate(messages, fromDate, toDate) {
  const fromMs = parseDateMs(fromDate, 'after');
  const toMs = parseDateMs(toDate, 'before');
  if (!fromMs && !toMs) {
    return messages;
  }
  return messages.filter((message) => {
    const ts = typeof message.date === 'number' ? message.date * 1000 : null;
    if (!ts) {
      return false;
    }
    if (fromMs && ts < fromMs) {
      return false;
    }
    if (toMs && ts > toMs) {
      return false;
    }
    return true;
  });
}

function formatLiveMessage(message, context) {
  const dateIso = message.date ? new Date(message.date * 1000).toISOString() : null;
  return {
    channelId: context.channelId ?? message.peer_id ?? null,
    peerTitle: context.peerTitle ?? null,
    username: context.username ?? null,
    messageId: message.id,
    date: dateIso,
    fromId: message.from_id ?? null,
    fromUsername: message.from_username ?? null,
    fromDisplayName: message.from_display_name ?? null,
    fromPeerType: message.from_peer_type ?? null,
    fromIsBot: typeof message.from_is_bot === 'boolean' ? message.from_is_bot : null,
    text: message.text ?? message.message ?? '',
    media: message.media ?? null,
    topicId: message.topic_id ?? null,
  };
}

function messageDateMs(message) {
  const ts = Date.parse(message.date ?? '');
  return Number.isNaN(ts) ? 0 : ts;
}

function mergeMessageSets(sets, limit) {
  const map = new Map();
  for (const list of sets) {
    for (const message of list) {
      const channelId = message.channelId ?? '';
      const messageId = message.messageId ?? message.id;
      const key = `${String(channelId)}:${String(messageId)}`;
      if (!map.has(key) || message.source === 'live') {
        map.set(key, message);
      }
    }
  }
  const merged = Array.from(map.values());
  merged.sort((a, b) => messageDateMs(b) - messageDateMs(a));
  return limit && limit > 0 ? merged.slice(0, limit) : merged;
}

function normalizeInviteCode(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return trimmed;
  }
  if (trimmed.startsWith('t.me/')) {
    return `https://${trimmed}`;
  }
  if (trimmed.startsWith('+')) {
    return `https://t.me/${trimmed}`;
  }
  if (trimmed.startsWith('@')) {
    return trimmed;
  }
  return `https://t.me/joinchat/${trimmed}`;
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
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    const { flags, rest } = parseFlags(args, {
      follow: { type: 'boolean' },
    });
    const subcommand = rest[0];
    const storeDir = resolveStoreDir();

    if (subcommand === 'status') {
      const { telegramClient, messageSyncService } = createServices({ storeDir });
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
      const { telegramClient, messageSyncService } = createServices({ storeDir });
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
    const { telegramClient, messageSyncService } = createServices({ storeDir });
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
  }, timeoutMs);
}

async function runSync(globalFlags, args) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    const { flags } = parseFlags(args, {
      once: { type: 'boolean' },
      follow: { type: 'boolean' },
      'idle-exit': { type: 'string' },
    });
    const storeDir = resolveStoreDir();
    const release = acquireStoreLock(storeDir);
    const { telegramClient, messageSyncService } = createServices({ storeDir });
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
  }, timeoutMs);
}

async function runServer(globalFlags) {
  const timeoutMs = globalFlags.timeoutMs;
  let child = null;

  const runChild = () => new Promise((resolve, reject) => {
    const serverPath = fileURLToPath(new URL('./mcp-server.js', import.meta.url));
    const handleSignal = (signal) => {
      if (child && !child.killed) {
        child.kill(signal);
      }
    };
    const cleanup = () => {
      process.off('SIGINT', handleSignal);
      process.off('SIGTERM', handleSignal);
    };

    process.on('SIGINT', handleSignal);
    process.on('SIGTERM', handleSignal);

    child = spawn(process.execPath, [serverPath], {
      stdio: 'inherit',
      env: process.env,
    });

    child.on('error', (error) => {
      cleanup();
      reject(error);
    });

    child.on('exit', (code, signal) => {
      cleanup();
      if (code === 0 || signal === 'SIGINT' || signal === 'SIGTERM') {
        resolve();
        return;
      }
      reject(new Error(`Server exited with code ${code ?? 'null'}${signal ? ` (${signal})` : ''}`));
    });
  });

  return runWithTimeout(runChild, timeoutMs, () => {
    if (child && !child.killed) {
      child.kill('SIGTERM');
    }
  });
}

async function runSyncStatus(globalFlags) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    const storeDir = resolveStoreDir();
    const { telegramClient, messageSyncService } = createServices({ storeDir });
    try {
      const queue = messageSyncService.getQueueStats();
      if (globalFlags.json) {
        writeJson({ queue });
      } else {
        console.log(`QUEUE: pending=${queue.pending} in_progress=${queue.in_progress} idle=${queue.idle} error=${queue.error}`);
        console.log(`PROCESSING: ${queue.processing}`);
      }
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
    }
  }, timeoutMs);
}

async function runSyncJobs(globalFlags, args) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    const [mode, ...rest] = args;
    if (!mode) {
      throw new Error('sync jobs requires a subcommand: list | add | retry | cancel');
    }

    const storeDir = resolveStoreDir();

    if (mode === 'list') {
      const { flags } = parseFlags(rest, {
        status: { type: 'string' },
        limit: { type: 'string' },
        channel: { type: 'string' },
      });
      const status = flags.status ? String(flags.status) : null;
      if (status && !['pending', 'in_progress', 'idle', 'error'].includes(status)) {
        throw new Error(`Unknown status: ${status}`);
      }
      const limit = parsePositiveInt(flags.limit, '--limit') ?? 100;
      const { telegramClient, messageSyncService } = createServices({ storeDir });
      try {
        const jobs = messageSyncService.listJobs({
          status,
          channelId: flags.channel,
          limit,
        });
        if (globalFlags.json) {
          writeJson(jobs);
        } else {
          for (const job of jobs) {
            const label = job.peer_title || job.channel_id;
            console.log(`#${job.id} ${label} [${job.status}] ${job.message_count}/${job.target_message_count}`);
          }
        }
      } finally {
        await messageSyncService.shutdown();
        await telegramClient.destroy();
      }
      return;
    }

    const release = acquireStoreLock(storeDir);
    const { telegramClient, messageSyncService } = createServices({ storeDir });
    try {
      if (mode === 'add') {
        const { flags } = parseFlags(rest, {
          chat: { type: 'string' },
          depth: { type: 'string' },
          'min-date': { type: 'string' },
        });
        if (!flags.chat) {
          throw new Error('--chat is required');
        }
        if (!(await telegramClient.isAuthorized().catch(() => false))) {
          throw new Error('Not authenticated. Run `node cli.js auth` first.');
        }
        const depth = parsePositiveInt(flags.depth, '--depth');
        const job = messageSyncService.addJob(flags.chat, {
          depth,
          minDate: flags['min-date'],
        });
        void messageSyncService.processQueue();
        if (globalFlags.json) {
          writeJson(job);
        } else {
          console.log(`Job scheduled for ${job.channel_id} (#${job.id}).`);
        }
        return;
      }

      if (mode === 'retry') {
        const { flags } = parseFlags(rest, {
          'job-id': { type: 'string' },
          channel: { type: 'string' },
          'all-errors': { type: 'boolean' },
        });
        const jobId = parsePositiveInt(flags['job-id'], '--job-id');
        const channelId = flags.channel || null;
        const allErrors = Boolean(flags['all-errors']);
        if (!jobId && !channelId && !allErrors) {
          throw new Error('--job-id, --channel, or --all-errors is required');
        }
        if (allErrors && (jobId || channelId)) {
          throw new Error('Use --all-errors without --job-id/--channel');
        }
        const result = messageSyncService.retryJobs({
          jobId,
          channelId,
          allErrors,
        });
        const authed = await telegramClient.isAuthorized().catch(() => false);
        if (authed && result.updated > 0) {
          void messageSyncService.processQueue();
        }
        if (globalFlags.json) {
          writeJson(result);
        } else {
          console.log(`Re-queued ${result.updated} job(s).`);
        }
        return;
      }

      if (mode === 'cancel') {
        const { flags } = parseFlags(rest, {
          'job-id': { type: 'string' },
          channel: { type: 'string' },
        });
        const jobId = parsePositiveInt(flags['job-id'], '--job-id');
        const channelId = flags.channel || null;
        if (!jobId && !channelId) {
          throw new Error('--job-id or --channel is required');
        }
        if (jobId && channelId) {
          throw new Error('Use --job-id or --channel, not both');
        }
        const result = messageSyncService.cancelJobs({
          jobId,
          channelId,
        });
        if (globalFlags.json) {
          writeJson(result);
        } else {
          console.log(`Canceled ${result.canceled} job(s).`);
        }
        return;
      }

      throw new Error(`Unknown sync jobs subcommand: ${mode}`);
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
      release();
    }
  }, timeoutMs);
}

async function runDoctor(globalFlags, args) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    const { flags } = parseFlags(args, {
      connect: { type: 'boolean' },
    });
    const storeDir = resolveStoreDir();
    const lock = readStoreLock(storeDir);
    const { telegramClient, messageSyncService } = createServices({ storeDir });
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
  }, timeoutMs);
}

async function runChannels(globalFlags, args) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    const [mode, ...rest] = args;
    if (!mode) {
      throw new Error('channels requires a subcommand');
    }

    const storeDir = resolveStoreDir();
    const release = acquireStoreLock(storeDir);
    const { telegramClient, messageSyncService } = createServices({ storeDir });

    try {
      if (mode === 'list') {
        const { flags } = parseFlags(rest, {
          query: { type: 'string' },
          limit: { type: 'string' },
        });
        const limit = parsePositiveInt(flags.limit, '--limit') ?? 50;
        if (!(await telegramClient.isAuthorized().catch(() => false))) {
          throw new Error('Not authenticated. Run `node cli.js auth` first.');
        }
        const dialogs = flags.query
          ? await telegramClient.searchDialogs(flags.query, limit)
          : await telegramClient.listDialogs(limit);

        if (globalFlags.json) {
          writeJson(dialogs);
        } else {
          for (const dialog of dialogs) {
            const label = dialog.title || dialog.username || dialog.id;
            console.log(`${label} (${dialog.id})`);
          }
        }
        return;
      }

      if (mode === 'show') {
        const { flags } = parseFlags(rest, {
          chat: { type: 'string' },
        });
        if (!flags.chat) {
          throw new Error('--chat is required');
        }

        let channel = messageSyncService.getChannel(flags.chat);
        if (!channel) {
          if (!(await telegramClient.isAuthorized().catch(() => false))) {
            throw new Error('Not authenticated. Run `node cli.js auth` first.');
          }
          const meta = await telegramClient.getPeerMetadata(flags.chat);
          channel = {
            channelId: String(flags.chat),
            peerTitle: meta?.peerTitle ?? null,
            peerType: meta?.peerType ?? null,
            chatType: meta?.chatType ?? null,
            isForum: meta?.isForum ?? null,
            username: meta?.username ?? null,
            syncEnabled: null,
            lastMessageId: null,
            lastMessageDate: null,
            oldestMessageId: null,
            oldestMessageDate: null,
            about: meta?.about ?? null,
            metadataUpdatedAt: null,
            createdAt: null,
            updatedAt: null,
            source: 'live',
          };
        }

        if (globalFlags.json) {
          writeJson(channel);
        } else {
          console.log(JSON.stringify(channel, null, 2));
        }
        return;
      }

      if (mode === 'sync') {
        const { flags } = parseFlags(rest, {
          chat: { type: 'string' },
          enable: { type: 'boolean' },
          disable: { type: 'boolean' },
        });
        if (!flags.chat) {
          throw new Error('--chat is required');
        }
        if (flags.enable && flags.disable) {
          throw new Error('Use either --enable or --disable');
        }
        if (!flags.enable && !flags.disable) {
          throw new Error('--enable or --disable is required');
        }
        const result = messageSyncService.setChannelSync(flags.chat, Boolean(flags.enable));
        if (globalFlags.json) {
          writeJson({
            channelId: result.channel_id,
            syncEnabled: Boolean(result.sync_enabled),
          });
        } else {
          console.log(`Sync ${result.sync_enabled ? 'enabled' : 'disabled'} for ${result.channel_id}`);
        }
        return;
      }

      throw new Error(`Unknown channels subcommand: ${mode}`);
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
      release();
    }
  }, timeoutMs);
}

async function runMessages(globalFlags, args) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    const [mode, ...rest] = args;
    if (!mode) {
      throw new Error('messages requires a subcommand: list | search | show | context');
    }

  const storeDir = resolveStoreDir();
  const release = acquireStoreLock(storeDir);
  const { telegramClient, messageSyncService } = createServices({ storeDir });

  const resolveLiveMetadata = async (channelId, fallback = {}) => {
    const meta = messageSyncService.getChannelMetadata(channelId);
    let peerTitle = meta?.peerTitle ?? fallback.peerTitle ?? null;
    let username = meta?.username ?? fallback.username ?? null;
    if (!peerTitle || !username) {
      const live = await telegramClient.getPeerMetadata(channelId);
      peerTitle = peerTitle ?? live?.peerTitle ?? null;
      username = username ?? live?.username ?? null;
    }
    return { peerTitle, username };
  };

  try {
    if (mode === 'list') {
      const { flags } = parseFlags(rest, {
        chat: { type: 'string', multiple: true },
        topic: { type: 'string' },
        source: { type: 'string' },
        after: { type: 'string' },
        before: { type: 'string' },
        limit: { type: 'string' },
      });
      const resolvedSource = resolveSource(flags.source);
      const channelIds = parseListValues(flags.chat);
      const topicId = parsePositiveInt(flags.topic, '--topic');
      const finalLimit = parsePositiveInt(flags.limit, '--limit') ?? 50;
      const sets = [];

      if (resolvedSource === 'archive' || resolvedSource === 'both') {
        const archived = messageSyncService.listArchivedMessages({
          channelIds: channelIds.length ? channelIds : null,
          topicId,
          fromDate: flags.after,
          toDate: flags.before,
          limit: finalLimit,
        });
        sets.push(archived.map((message) => ({ ...message, source: 'archive' })));
      }

      if (resolvedSource === 'live' || resolvedSource === 'both') {
        if (!channelIds.length) {
          throw new Error('--chat is required for live source.');
        }
        if (!(await telegramClient.isAuthorized().catch(() => false))) {
          throw new Error('Not authenticated. Run `node cli.js auth` first.');
        }

        const liveResults = [];
        for (const id of channelIds) {
          let peerTitle = null;
          let username = null;
          let liveMessages = [];

          if (topicId) {
            const results = await telegramClient.getTopicMessages(id, topicId, finalLimit);
            liveMessages = results.messages;
          } else {
            const results = await telegramClient.getMessagesByChannelId(id, finalLimit);
            liveMessages = results.messages;
            peerTitle = results.peerTitle ?? null;
          }

          const meta = await resolveLiveMetadata(id, { peerTitle, username });
          peerTitle = meta.peerTitle;
          username = meta.username;

          const filtered = filterLiveMessagesByDate(liveMessages, flags.after, flags.before);
          const formatted = filtered.map((message) => ({
            ...formatLiveMessage(message, { channelId: String(id), peerTitle, username }),
            source: 'live',
          }));
          liveResults.push(...formatted);
        }
        sets.push(liveResults);
      }

      const messages = resolvedSource === 'both'
        ? mergeMessageSets(sets, finalLimit)
        : (sets[0] ?? []);

      if (globalFlags.json) {
        writeJson({ source: resolvedSource, returned: messages.length, messages });
      } else {
        for (const message of messages) {
          const label = message.peerTitle || message.channelId || 'unknown';
          const text = (message.text || '').replace(/\s+/g, ' ').trim();
          const prefix = resolvedSource === 'both' ? `[${message.source}] ` : '';
          console.log(`${prefix}${message.date ?? ''} ${label} #${message.messageId}: ${text}`);
        }
      }
      return;
    }

    if (mode === 'search') {
      const { flags, rest: queryParts } = parseFlags(rest, {
        chat: { type: 'string', multiple: true },
        topic: { type: 'string' },
        source: { type: 'string' },
        after: { type: 'string' },
        before: { type: 'string' },
        limit: { type: 'string' },
        regex: { type: 'string' },
        tag: { type: 'string', multiple: true },
        tags: { type: 'string' },
        query: { type: 'string' },
        'case-sensitive': { type: 'boolean' },
      });
      const query = flags.query || queryParts.join(' ').trim();
      const resolvedSource = resolveSource(flags.source);
      const channelIds = parseListValues(flags.chat);
      const tagList = [
        ...parseListValues(flags.tag),
        ...parseListValues(flags.tags),
      ];
      const topicId = parsePositiveInt(flags.topic, '--topic');
      const finalLimit = parsePositiveInt(flags.limit, '--limit') ?? 100;
      const caseInsensitive = !flags['case-sensitive'];

      if (!query && !flags.regex && tagList.length === 0) {
        throw new Error('Provide query, regex, or tag for messages search.');
      }

      const sets = [];

      if (resolvedSource === 'archive' || resolvedSource === 'both') {
        const archived = messageSyncService.searchArchiveMessages({
          query,
          regex: flags.regex,
          tags: tagList.length ? tagList : null,
          channelIds: channelIds.length ? channelIds : null,
          topicId,
          fromDate: flags.after,
          toDate: flags.before,
          limit: finalLimit,
          caseInsensitive,
        });
        sets.push(archived.map((message) => ({ ...message, source: 'archive' })));
      }

      if (resolvedSource === 'live' || resolvedSource === 'both') {
        let liveChannelIds = channelIds;
        if (!liveChannelIds.length && tagList.length) {
          const tagged = new Map();
          for (const tag of tagList) {
            const channels = messageSyncService.listTaggedChannels(tag, { limit: 200 });
            for (const channel of channels) {
              tagged.set(channel.channelId, channel);
            }
          }
          liveChannelIds = Array.from(tagged.keys());
        }

        if (!liveChannelIds.length) {
          throw new Error('--chat is required for live search.');
        }
        if (!(await telegramClient.isAuthorized().catch(() => false))) {
          throw new Error('Not authenticated. Run `node cli.js auth` first.');
        }

        let liveRegex = null;
        if (flags.regex) {
          try {
            liveRegex = new RegExp(flags.regex, caseInsensitive ? 'i' : '');
          } catch (error) {
            throw new Error(`Invalid regex: ${error.message}`);
          }
        }

        const liveResults = [];
        for (const id of liveChannelIds) {
          let peerTitle = null;
          let username = null;
          let liveMessages = [];

          if (query) {
            const results = await telegramClient.searchChannelMessages(id, {
              query,
              limit: finalLimit,
              topicId,
            });
            liveMessages = results.messages;
            peerTitle = results.peerTitle ?? null;
          } else if (topicId) {
            const results = await telegramClient.getTopicMessages(id, topicId, finalLimit);
            liveMessages = results.messages;
          } else {
            const results = await telegramClient.getMessagesByChannelId(id, finalLimit);
            liveMessages = results.messages;
            peerTitle = results.peerTitle ?? null;
          }

          const meta = await resolveLiveMetadata(id, { peerTitle, username });
          peerTitle = meta.peerTitle;
          username = meta.username;

          let filtered = filterLiveMessagesByDate(liveMessages, flags.after, flags.before);
          if (liveRegex) {
            filtered = filtered.filter((message) =>
              liveRegex.test(message.text ?? message.message ?? ''),
            );
          }

          const formatted = filtered.map((message) => ({
            ...formatLiveMessage(message, { channelId: String(id), peerTitle, username }),
            source: 'live',
          }));
          liveResults.push(...formatted);
        }

        sets.push(liveResults);
      }

      const messages = resolvedSource === 'both'
        ? mergeMessageSets(sets, finalLimit)
        : (sets[0] ?? []);

      if (globalFlags.json) {
        writeJson({ source: resolvedSource, returned: messages.length, messages });
      } else {
        for (const message of messages) {
          const label = message.peerTitle || message.channelId || 'unknown';
          const text = (message.text || '').replace(/\s+/g, ' ').trim();
          const prefix = resolvedSource === 'both' ? `[${message.source}] ` : '';
          console.log(`${prefix}${message.date ?? ''} ${label} #${message.messageId}: ${text}`);
        }
      }
      return;
    }

    if (mode === 'show') {
      const { flags } = parseFlags(rest, {
        chat: { type: 'string' },
        id: { type: 'string' },
        source: { type: 'string' },
      });
      if (!flags.chat) {
        throw new Error('--chat is required');
      }
      if (!flags.id) {
        throw new Error('--id is required');
      }
      const messageId = parsePositiveInt(flags.id, '--id');
      const resolvedSource = resolveSource(flags.source);
      let message = null;
      let resolvedFrom = null;

      if (resolvedSource === 'live' || resolvedSource === 'both') {
        if (!(await telegramClient.isAuthorized().catch(() => false))) {
          throw new Error('Not authenticated. Run `node cli.js auth` first.');
        }
        const live = await telegramClient.getMessageById(flags.chat, messageId);
        if (live) {
          const meta = await resolveLiveMetadata(flags.chat);
          message = {
            ...formatLiveMessage(live, { channelId: String(flags.chat), ...meta }),
            source: 'live',
          };
          resolvedFrom = 'live';
        }
      }

      if (!message && (resolvedSource === 'archive' || resolvedSource === 'both')) {
        const archived = messageSyncService.getArchivedMessage({
          channelId: flags.chat,
          messageId,
        });
        if (archived) {
          message = { ...archived, source: 'archive' };
          resolvedFrom = 'archive';
        }
      }

      if (!message) {
        throw new Error('Message not found.');
      }

      const payload = { source: resolvedFrom ?? resolvedSource, message };
      if (globalFlags.json) {
        writeJson(payload);
      } else {
        console.log(JSON.stringify(payload, null, 2));
      }
      return;
    }

    if (mode === 'context') {
      const { flags } = parseFlags(rest, {
        chat: { type: 'string' },
        id: { type: 'string' },
        source: { type: 'string' },
        before: { type: 'string' },
        after: { type: 'string' },
      });
      if (!flags.chat) {
        throw new Error('--chat is required');
      }
      if (!flags.id) {
        throw new Error('--id is required');
      }
      const messageId = parsePositiveInt(flags.id, '--id');
      const resolvedSource = resolveSource(flags.source);
      const safeBefore = parseNonNegativeInt(flags.before, '--before') ?? 20;
      const safeAfter = parseNonNegativeInt(flags.after, '--after') ?? 20;
      let context = null;
      let resolvedFrom = null;

      if (resolvedSource === 'live' || resolvedSource === 'both') {
        if (!(await telegramClient.isAuthorized().catch(() => false))) {
          throw new Error('Not authenticated. Run `node cli.js auth` first.');
        }
        const liveContext = await telegramClient.getMessageContext(flags.chat, messageId, {
          before: safeBefore,
          after: safeAfter,
        });
        if (liveContext.target) {
          const meta = await resolveLiveMetadata(flags.chat);
          context = {
            target: {
              ...formatLiveMessage(liveContext.target, { channelId: String(flags.chat), ...meta }),
              source: 'live',
            },
            before: liveContext.before.map((message) => ({
              ...formatLiveMessage(message, { channelId: String(flags.chat), ...meta }),
              source: 'live',
            })),
            after: liveContext.after.map((message) => ({
              ...formatLiveMessage(message, { channelId: String(flags.chat), ...meta }),
              source: 'live',
            })),
          };
          resolvedFrom = 'live';
        }
      }

      if (!context && (resolvedSource === 'archive' || resolvedSource === 'both')) {
        const archiveContext = messageSyncService.getArchivedMessageContext({
          channelId: flags.chat,
          messageId,
          before: safeBefore,
          after: safeAfter,
        });
        if (archiveContext.target) {
          context = {
            target: { ...archiveContext.target, source: 'archive' },
            before: archiveContext.before.map((message) => ({ ...message, source: 'archive' })),
            after: archiveContext.after.map((message) => ({ ...message, source: 'archive' })),
          };
          resolvedFrom = 'archive';
        }
      }

      if (!context) {
        throw new Error('Message not found.');
      }

      const payload = { source: resolvedFrom ?? resolvedSource, ...context };
      if (globalFlags.json) {
        writeJson(payload);
      } else {
        console.log(JSON.stringify(payload, null, 2));
      }
      return;
    }

    throw new Error(`Unknown messages subcommand: ${mode}`);
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
      release();
    }
  }, timeoutMs);
}

async function runSend(globalFlags, args) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    const [mode, ...rest] = args;
    if (!mode) {
      throw new Error('send requires a subcommand: text | file');
    }

    const storeDir = resolveStoreDir();
    const release = acquireStoreLock(storeDir);
    const { telegramClient, messageSyncService } = createServices({ storeDir });

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
  }, timeoutMs);
}

async function runMedia(globalFlags, args) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
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

    const storeDir = resolveStoreDir();
    const release = acquireStoreLock(storeDir);
    const { telegramClient, messageSyncService } = createServices({ storeDir });

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
  }, timeoutMs);
}

async function runTopics(globalFlags, args) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    const [mode, ...rest] = args;
    if (!mode) {
      throw new Error('topics requires a subcommand: list | search');
    }

    const storeDir = resolveStoreDir();
    const release = acquireStoreLock(storeDir);
    const { telegramClient, messageSyncService } = createServices({ storeDir });

    try {
      if (!(await telegramClient.isAuthorized().catch(() => false))) {
        throw new Error('Not authenticated. Run `node cli.js auth` first.');
      }

      if (mode === 'list') {
        const { flags } = parseFlags(rest, {
          chat: { type: 'string' },
          limit: { type: 'string' },
        });
        if (!flags.chat) {
          throw new Error('--chat is required');
        }
        const limit = parsePositiveInt(flags.limit, '--limit') ?? 100;
        const topics = await telegramClient.listForumTopics(flags.chat, { limit });
        messageSyncService.upsertTopics(flags.chat, topics);

        if (globalFlags.json) {
          writeJson({ total: topics.total ?? topics.length, topics });
        } else {
          for (const topic of topics) {
            console.log(`#${topic.id} ${topic.title ?? ''}`.trim());
          }
        }
        return;
      }

      if (mode === 'search') {
        const { flags } = parseFlags(rest, {
          chat: { type: 'string' },
          query: { type: 'string' },
          limit: { type: 'string' },
        });
        if (!flags.chat) {
          throw new Error('--chat is required');
        }
        if (!flags.query) {
          throw new Error('--query is required');
        }
        const limit = parsePositiveInt(flags.limit, '--limit') ?? 100;
        const topics = await telegramClient.listForumTopics(flags.chat, {
          query: flags.query,
          limit,
        });
        messageSyncService.upsertTopics(flags.chat, topics);

        if (globalFlags.json) {
          writeJson({ total: topics.total ?? topics.length, topics });
        } else {
          for (const topic of topics) {
            console.log(`#${topic.id} ${topic.title ?? ''}`.trim());
          }
        }
        return;
      }

      throw new Error(`Unknown topics subcommand: ${mode}`);
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
      release();
    }
  }, timeoutMs);
}

async function runTags(globalFlags, args) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    const [mode, ...rest] = args;
    if (!mode) {
      throw new Error('tags requires a subcommand');
    }

    const storeDir = resolveStoreDir();
    const release = acquireStoreLock(storeDir);
    const { telegramClient, messageSyncService } = createServices({ storeDir });

    try {
      if (mode === 'set') {
        const { flags } = parseFlags(rest, {
          chat: { type: 'string' },
          tags: { type: 'string' },
          tag: { type: 'string', multiple: true },
          source: { type: 'string' },
        });
        if (!flags.chat) {
          throw new Error('--chat is required');
        }
        const hasTagFlag = flags.tags !== undefined || flags.tag !== undefined;
        const tagValues = [
          ...parseListValues(flags.tags),
          ...parseListValues(flags.tag),
        ];
        if (!hasTagFlag) {
          throw new Error('--tags or --tag is required');
        }
        const finalTags = messageSyncService.setChannelTags(flags.chat, tagValues, {
          source: flags.source,
        });
        if (globalFlags.json) {
          writeJson({ channelId: flags.chat, tags: finalTags });
        } else {
          console.log(`Tags set for ${flags.chat}: ${finalTags.join(', ')}`);
        }
        return;
      }

      if (mode === 'list') {
        const { flags } = parseFlags(rest, {
          chat: { type: 'string' },
          source: { type: 'string' },
        });
        if (!flags.chat) {
          throw new Error('--chat is required');
        }
        const tags = messageSyncService.listChannelTags(flags.chat, { source: flags.source });
        if (globalFlags.json) {
          writeJson(tags);
        } else {
          console.log(tags.map((tag) => tag.tag).join(', '));
        }
        return;
      }

      if (mode === 'search') {
        const { flags } = parseFlags(rest, {
          tag: { type: 'string' },
          source: { type: 'string' },
          limit: { type: 'string' },
        });
        if (!flags.tag) {
          throw new Error('--tag is required');
        }
        const limit = parsePositiveInt(flags.limit, '--limit') ?? 100;
        const channels = messageSyncService.listTaggedChannels(flags.tag, {
          source: flags.source,
          limit,
        });
        if (globalFlags.json) {
          writeJson(channels);
        } else {
          for (const channel of channels) {
            const label = channel.peerTitle || channel.username || channel.channelId;
            console.log(`${label} (${channel.channelId})`);
          }
        }
        return;
      }

      if (mode === 'auto') {
        const { flags } = parseFlags(rest, {
          chat: { type: 'string', multiple: true },
          limit: { type: 'string' },
          source: { type: 'string' },
          'no-refresh-metadata': { type: 'boolean' },
        });
        if (!(await telegramClient.isAuthorized().catch(() => false))) {
          throw new Error('Not authenticated. Run `node cli.js auth` first.');
        }
        const channelIds = parseListValues(flags.chat);
        const limit = parsePositiveInt(flags.limit, '--limit') ?? 50;
        const results = await messageSyncService.autoTagChannels({
          channelIds: channelIds.length ? channelIds : null,
          limit,
          source: flags.source,
          refreshMetadata: !flags['no-refresh-metadata'],
        });
        if (globalFlags.json) {
          writeJson(results);
        } else {
          for (const entry of results) {
            console.log(`${entry.channelId}: ${entry.tags.map((tag) => tag.tag).join(', ')}`);
          }
        }
        return;
      }

      throw new Error(`Unknown tags subcommand: ${mode}`);
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
      release();
    }
  }, timeoutMs);
}

async function runMetadata(globalFlags, args) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    const [mode, ...rest] = args;
    if (!mode) {
      throw new Error('metadata requires a subcommand');
    }

    const storeDir = resolveStoreDir();
    const release = acquireStoreLock(storeDir);
    const { telegramClient, messageSyncService } = createServices({ storeDir });

    try {
      if (mode === 'get') {
        const { flags } = parseFlags(rest, {
          chat: { type: 'string' },
        });
        if (!flags.chat) {
          throw new Error('--chat is required');
        }
        let metadata = messageSyncService.getChannelMetadata(flags.chat);
        if (!metadata) {
          if (!(await telegramClient.isAuthorized().catch(() => false))) {
            throw new Error('Not authenticated. Run `node cli.js auth` first.');
          }
          const live = await telegramClient.getPeerMetadata(flags.chat);
          metadata = {
            channelId: String(flags.chat),
            peerTitle: live?.peerTitle ?? null,
            peerType: live?.peerType ?? null,
            chatType: live?.chatType ?? null,
            isForum: live?.isForum ?? null,
            username: live?.username ?? null,
            about: live?.about ?? null,
            metadataUpdatedAt: null,
            source: 'live',
          };
        }
        if (globalFlags.json) {
          writeJson(metadata);
        } else {
          console.log(JSON.stringify(metadata, null, 2));
        }
        return;
      }

      if (mode === 'refresh') {
        const { flags } = parseFlags(rest, {
          chat: { type: 'string', multiple: true },
          limit: { type: 'string' },
          force: { type: 'boolean' },
          'only-missing': { type: 'boolean' },
        });
        if (!(await telegramClient.isAuthorized().catch(() => false))) {
          throw new Error('Not authenticated. Run `node cli.js auth` first.');
        }
        const channelIds = parseListValues(flags.chat);
        const limit = parsePositiveInt(flags.limit, '--limit') ?? 20;
        const results = await messageSyncService.refreshChannelMetadata({
          channelIds: channelIds.length ? channelIds : null,
          limit,
          force: Boolean(flags.force),
          onlyMissing: Boolean(flags['only-missing']),
        });
        if (globalFlags.json) {
          writeJson(results);
        } else {
          console.log(JSON.stringify(results, null, 2));
        }
        return;
      }

      throw new Error(`Unknown metadata subcommand: ${mode}`);
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
      release();
    }
  }, timeoutMs);
}

async function runContacts(globalFlags, args) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    const [mode, ...rest] = args;
    if (!mode) {
      throw new Error('contacts requires a subcommand');
    }

    const storeDir = resolveStoreDir();
    const release = acquireStoreLock(storeDir);
    const { telegramClient, messageSyncService } = createServices({ storeDir });

    try {
      if (mode === 'search') {
        const { flags, rest: queryParts } = parseFlags(rest, {
          limit: { type: 'string' },
        });
        const query = queryParts.join(' ').trim();
        if (!query) {
          throw new Error('search requires a query');
        }
        if (!(await telegramClient.isAuthorized().catch(() => false))) {
          throw new Error('Not authenticated. Run `node cli.js auth` first.');
        }
        await messageSyncService.refreshContacts();
        const contacts = messageSyncService.searchContacts(query, {
          limit: parsePositiveInt(flags.limit, '--limit') ?? 50,
        });

        if (globalFlags.json) {
          writeJson(contacts);
        } else {
          for (const contact of contacts) {
            const label = contact.alias || contact.displayName || contact.username || contact.userId;
            console.log(`${label} (${contact.userId})`);
          }
        }
        return;
      }

      if (mode === 'show') {
        const { flags } = parseFlags(rest, {
          user: { type: 'string' },
        });
        if (!flags.user) {
          throw new Error('--user is required');
        }
        let contact = messageSyncService.getContact(flags.user);
        if (!contact) {
          if (!(await telegramClient.isAuthorized().catch(() => false))) {
            throw new Error('Not authenticated. Run `node cli.js auth` first.');
          }
          await messageSyncService.refreshContacts();
          contact = messageSyncService.getContact(flags.user);
        }
        if (!contact) {
          throw new Error('Contact not found.');
        }

        if (globalFlags.json) {
          writeJson(contact);
        } else {
          console.log(JSON.stringify(contact, null, 2));
        }
        return;
      }

      if (mode === 'alias') {
        const [action, ...aliasArgs] = rest;
        if (action === 'set') {
          const { flags } = parseFlags(aliasArgs, {
            user: { type: 'string' },
            alias: { type: 'string' },
          });
          if (!flags.user) {
            throw new Error('--user is required');
          }
          if (!flags.alias) {
            throw new Error('--alias is required');
          }
          const alias = messageSyncService.setContactAlias(flags.user, flags.alias);
          if (globalFlags.json) {
            writeJson({ userId: flags.user, alias });
          } else {
            console.log(`Alias set for ${flags.user}: ${alias}`);
          }
          return;
        }
        if (action === 'rm') {
          const { flags } = parseFlags(aliasArgs, {
            user: { type: 'string' },
          });
          if (!flags.user) {
            throw new Error('--user is required');
          }
          messageSyncService.removeContactAlias(flags.user);
          if (globalFlags.json) {
            writeJson({ userId: flags.user, removed: true });
          } else {
            console.log(`Alias removed for ${flags.user}`);
          }
          return;
        }
        throw new Error('contacts alias requires set | rm');
      }

      if (mode === 'tags') {
        const [action, ...tagArgs] = rest;
        const { flags } = parseFlags(tagArgs, {
          user: { type: 'string' },
          tag: { type: 'string', multiple: true },
        });
        if (!flags.user) {
          throw new Error('--user is required');
        }
        const rawTags = Array.isArray(flags.tag) ? flags.tag : [];
        const tags = rawTags.flatMap((entry) => entry.split(',').map((item) => item.trim()).filter(Boolean));
        if (!tags.length) {
          throw new Error('--tag is required');
        }
        if (action === 'add') {
          const updated = messageSyncService.addContactTags(flags.user, tags);
          if (globalFlags.json) {
            writeJson({ userId: flags.user, tags: updated });
          } else {
            console.log(`Tags updated for ${flags.user}: ${updated.join(', ')}`);
          }
          return;
        }
        if (action === 'rm') {
          const updated = messageSyncService.removeContactTags(flags.user, tags);
          if (globalFlags.json) {
            writeJson({ userId: flags.user, tags: updated });
          } else {
            console.log(`Tags updated for ${flags.user}: ${updated.join(', ')}`);
          }
          return;
        }
        throw new Error('contacts tags requires add | rm');
      }

      if (mode === 'notes') {
        const [action, ...noteArgs] = rest;
        if (action !== 'set') {
          throw new Error('contacts notes requires set');
        }
        const { flags } = parseFlags(noteArgs, {
          user: { type: 'string' },
          notes: { type: 'string' },
        });
        if (!flags.user) {
          throw new Error('--user is required');
        }
        if (flags.notes === undefined) {
          throw new Error('--notes is required');
        }
        const notes = messageSyncService.setContactNotes(flags.user, flags.notes);
        if (globalFlags.json) {
          writeJson({ userId: flags.user, notes });
        } else {
          console.log(`Notes updated for ${flags.user}.`);
        }
        return;
      }

      throw new Error(`Unknown contacts subcommand: ${mode}`);
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
      release();
    }
  }, timeoutMs);
}

async function runGroups(globalFlags, args) {
  const timeoutMs = globalFlags.timeoutMs;
  return runWithTimeout(async () => {
    const [mode, ...rest] = args;
    if (!mode) {
      throw new Error('groups requires a subcommand');
    }

    const storeDir = resolveStoreDir();
    const release = acquireStoreLock(storeDir);
    const { telegramClient, messageSyncService } = createServices({ storeDir });

    try {
      if (!(await telegramClient.isAuthorized().catch(() => false))) {
        throw new Error('Not authenticated. Run `node cli.js auth` first.');
      }

      if (mode === 'list') {
        const { flags } = parseFlags(rest, {
          query: { type: 'string' },
          limit: { type: 'string' },
        });
        const groups = await telegramClient.listGroups({
          query: flags.query,
          limit: parsePositiveInt(flags.limit, '--limit') ?? 100,
        });

        if (globalFlags.json) {
          writeJson(groups);
        } else {
          for (const group of groups) {
            console.log(`${group.title} (${group.id})`);
          }
        }
        return;
      }

      if (mode === 'info') {
        const { flags } = parseFlags(rest, {
          chat: { type: 'string' },
        });
        if (!flags.chat) {
          throw new Error('--chat is required');
        }
        const info = await telegramClient.getGroupInfo(flags.chat);
        if (globalFlags.json) {
          writeJson(info);
        } else {
          console.log(JSON.stringify(info, null, 2));
        }
        return;
      }

      if (mode === 'rename') {
        const { flags } = parseFlags(rest, {
          chat: { type: 'string' },
          name: { type: 'string' },
        });
        if (!flags.chat) {
          throw new Error('--chat is required');
        }
        if (!flags.name) {
          throw new Error('--name is required');
        }
        await telegramClient.renameGroup(flags.chat, flags.name);
        if (globalFlags.json) {
          writeJson({ channelId: flags.chat, name: flags.name });
        } else {
          console.log(`Group renamed: ${flags.name}`);
        }
        return;
      }

      if (mode === 'members') {
        const [action, ...memberArgs] = rest;
        const { flags } = parseFlags(memberArgs, {
          chat: { type: 'string' },
          user: { type: 'string', multiple: true },
        });
        if (!flags.chat) {
          throw new Error('--chat is required');
        }
        const users = Array.isArray(flags.user)
          ? flags.user.flatMap((entry) => entry.split(',').map((item) => item.trim()).filter(Boolean))
          : [];
        if (!users.length) {
          throw new Error('--user is required');
        }
        if (action === 'add') {
          const failed = await telegramClient.addGroupMembers(flags.chat, users);
          if (globalFlags.json) {
            writeJson({ channelId: flags.chat, failed });
          } else if (failed.length) {
            console.log(`Some members failed: ${JSON.stringify(failed, null, 2)}`);
          } else {
            console.log('Members added.');
          }
          return;
        }
        if (action === 'remove') {
          const result = await telegramClient.removeGroupMembers(flags.chat, users);
          if (globalFlags.json) {
            writeJson({ channelId: flags.chat, ...result });
          } else {
            console.log(`Removed: ${result.removed.join(', ')}`);
            if (result.failed.length) {
              console.log(`Failed: ${JSON.stringify(result.failed, null, 2)}`);
            }
          }
          return;
        }
        throw new Error('groups members requires add | remove');
      }

      if (mode === 'invite') {
        const [action, ...inviteArgs] = rest;
        const { flags } = parseFlags(inviteArgs, {
          chat: { type: 'string' },
        });
        if (!flags.chat) {
          throw new Error('--chat is required');
        }
        if (action === 'link') {
          const [linkAction] = inviteArgs.filter((arg) => !arg.startsWith('--'));
          if (linkAction === 'get') {
            const link = await telegramClient.getGroupInviteLink(flags.chat);
            if (globalFlags.json) {
              writeJson({ link: link.link });
            } else {
              console.log(link.link);
            }
            return;
          }
          if (linkAction === 'revoke') {
            const existing = await telegramClient.getGroupInviteLink(flags.chat);
            const link = await telegramClient.revokeGroupInviteLink(flags.chat, existing);
            if (globalFlags.json) {
              writeJson({ link: link.link });
            } else {
              console.log(link.link);
            }
            return;
          }
        }
        throw new Error('groups invite requires link get|revoke');
      }

      if (mode === 'join') {
        const { flags } = parseFlags(rest, {
          code: { type: 'string' },
        });
        if (!flags.code) {
          throw new Error('--code is required');
        }
        const invite = normalizeInviteCode(flags.code);
        if (!invite) {
          throw new Error('Invalid invite code.');
        }
        const chat = await telegramClient.joinGroup(invite);
        if (globalFlags.json) {
          writeJson({
            id: chat.id?.toString?.() ?? null,
            title: chat.displayName || chat.title || 'Unknown',
            username: chat.username ?? null,
          });
        } else {
          console.log(`Joined: ${chat.displayName || chat.title || 'Unknown'}`);
        }
        return;
      }

      if (mode === 'leave') {
        const { flags } = parseFlags(rest, {
          chat: { type: 'string' },
        });
        if (!flags.chat) {
          throw new Error('--chat is required');
        }
        await telegramClient.leaveGroup(flags.chat);
        if (globalFlags.json) {
          writeJson({ channelId: flags.chat, left: true });
        } else {
          console.log(`Left ${flags.chat}`);
        }
        return;
      }

      throw new Error(`Unknown groups subcommand: ${mode}`);
    } finally {
      await messageSyncService.shutdown();
      await telegramClient.destroy();
      release();
    }
  }, timeoutMs);
}

async function main() {
  try {
    const { flags: globalFlags, rest } = parseGlobalFlags(process.argv.slice(2));
    globalFlags.timeoutMs = globalFlags.timeout ? parseDuration(globalFlags.timeout) : null;
    if (globalFlags.version) {
      console.log(readVersion());
      return;
    }
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
      if (args[0] === 'status') {
        await runSyncStatus(globalFlags);
        return;
      }
      if (args[0] === 'jobs') {
        await runSyncJobs(globalFlags, args.slice(1));
        return;
      }
      await runSync(globalFlags, args);
      return;
    }
    if (command === 'server') {
      await runServer(globalFlags);
      return;
    }
    if (command === 'doctor') {
      await runDoctor(globalFlags, args);
      return;
    }
    if (command === 'channels') {
      await runChannels(globalFlags, args);
      return;
    }
    if (command === 'messages') {
      await runMessages(globalFlags, args);
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
    if (command === 'topics') {
      await runTopics(globalFlags, args);
      return;
    }
    if (command === 'tags') {
      await runTags(globalFlags, args);
      return;
    }
    if (command === 'metadata') {
      await runMetadata(globalFlags, args);
      return;
    }
    if (command === 'contacts') {
      await runContacts(globalFlags, args);
      return;
    }
    if (command === 'groups') {
      await runGroups(globalFlags, args);
      return;
    }

    printUsage();
  } catch (error) {
    writeError(error, process.argv.includes('--json'));
    process.exit(1);
  }
}

await main();
