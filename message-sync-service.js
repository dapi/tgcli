import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { setTimeout as delay } from 'timers/promises';
import { Message, PeersIndex } from '@mtcute/core';
import { normalizeChannelId } from './telegram-client.js';

const DEFAULT_DB_PATH = './data/messages.db';
const DEFAULT_TARGET_MESSAGES = 1000;
const SEARCH_INDEX_VERSION = 1;
const METADATA_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const JOB_STATUS = {
  PENDING: 'pending',
  IN_PROGRESS: 'in_progress',
  IDLE: 'idle',
  ERROR: 'error',
};

const TAG_RULES = [
  {
    tag: 'ai',
    patterns: [
      /\bai\b/iu,
      /\bartificial intelligence\b/iu,
      /\bmachine learning\b/iu,
      /\bml\b/iu,
      /\bgpt\b/iu,
      /\bllm\b/iu,
      /нейросет/iu,
      /искусственн/iu,
      /машинн(ое|ого) обучен/iu,
    ],
  },
  {
    tag: 'memes',
    patterns: [
      /\bmeme(s)?\b/iu,
      /мем/iu,
      /юмор/iu,
      /шутк/iu,
      /\blol\b/iu,
      /\bkek\b/iu,
    ],
  },
  {
    tag: 'news',
    patterns: [
      /\bnews\b/iu,
      /новост/iu,
      /сводк/iu,
      /дайджест/iu,
      /\bbreaking\b/iu,
    ],
  },
  {
    tag: 'crypto',
    patterns: [
      /\bcrypto\b/iu,
      /\bbitcoin\b/iu,
      /\bbtc\b/iu,
      /\beth\b/iu,
      /\bblockchain\b/iu,
      /крипт/iu,
      /блокчейн/iu,
    ],
  },
  {
    tag: 'jobs',
    patterns: [
      /\bjob(s)?\b/iu,
      /ваканс/iu,
      /работа/iu,
      /\bhiring\b/iu,
      /\bcareer\b/iu,
    ],
  },
  {
    tag: 'events',
    patterns: [
      /\bevent(s)?\b/iu,
      /мероприяти/iu,
      /встреч/iu,
      /митап/iu,
      /конференц/iu,
    ],
  },
  {
    tag: 'travel',
    patterns: [
      /\btravel\b/iu,
      /\btrip\b/iu,
      /путешеств/iu,
      /туризм/iu,
    ],
  },
  {
    tag: 'finance',
    patterns: [
      /\bfinance\b/iu,
      /финанс/iu,
      /инвест/iu,
      /\bstock(s)?\b/iu,
      /акци/iu,
    ],
  },
  {
    tag: 'real_estate',
    patterns: [
      /\breal estate\b/iu,
      /недвижим/iu,
      /аренд/iu,
      /\brent\b/iu,
      /квартир/iu,
    ],
  },
  {
    tag: 'education',
    patterns: [
      /\bcourse(s)?\b/iu,
      /курс/iu,
      /обучен/iu,
      /учеб/iu,
    ],
  },
  {
    tag: 'tech',
    patterns: [
      /\btech\b/iu,
      /технол/iu,
      /\bsoftware\b/iu,
      /разработк/iu,
      /\bdev\b/iu,
    ],
  },
  {
    tag: 'marketing',
    patterns: [
      /\bmarketing\b/iu,
      /маркетинг/iu,
      /\bsmm\b/iu,
      /реклам/iu,
    ],
  },
  {
    tag: 'gaming',
    patterns: [
      /\bgam(e|ing|es)\b/iu,
      /игр/iu,
      /стрим/iu,
    ],
  },
  {
    tag: 'sports',
    patterns: [
      /\bsport(s)?\b/iu,
      /спорт/iu,
      /футбол/iu,
      /\bnba\b/iu,
    ],
  },
  {
    tag: 'health',
    patterns: [
      /\bhealth\b/iu,
      /здоров/iu,
      /медиц/iu,
      /fitness/iu,
      /фитнес/iu,
    ],
  },
];

function normalizeChannelKey(channelId) {
  return String(normalizeChannelId(channelId));
}

function normalizePeerType(peer) {
  if (!peer) return 'chat';
  if (peer.type === 'user' || peer.type === 'bot') return 'user';
  if (peer.type === 'channel') return 'channel';
  if (peer.type === 'chat' && peer.chatType && peer.chatType !== 'group') return 'channel';
  return 'chat';
}

function parseIsoDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  const ts = date.getTime();
  if (Number.isNaN(ts)) {
    throw new Error('minDate must be a valid ISO-8601 string');
  }
  return Math.floor(ts / 1000);
}

function toIsoString(dateSeconds) {
  if (!dateSeconds) return null;
  return new Date(dateSeconds * 1000).toISOString();
}

function normalizeTag(tag) {
  if (!tag) return null;
  const normalized = String(tag).trim().toLowerCase();
  return normalized.replace(/\s+/g, ' ');
}

function buildTagText({ peerTitle, username, about }) {
  return [peerTitle, username, about].filter(Boolean).join(' ').trim();
}

function classifyTags(text) {
  if (!text) return [];
  const results = [];
  for (const rule of TAG_RULES) {
    let hits = 0;
    for (const pattern of rule.patterns) {
      if (pattern.test(text)) {
        hits += 1;
      }
    }
    if (hits > 0) {
      const confidence = Math.min(1, hits / 3);
      results.push({ tag: rule.tag, confidence });
    }
  }
  return results;
}

export default class MessageSyncService {
  constructor(telegramClient, options = {}) {
    this.telegramClient = telegramClient;
    this.dbPath = path.resolve(options.dbPath || DEFAULT_DB_PATH);
    this.batchSize = options.batchSize || 100;
    this.interJobDelayMs = options.interJobDelayMs || 3000;
    this.interBatchDelayMs = options.interBatchDelayMs || 1000;
    this.processing = false;
    this.stopRequested = false;
    this.realtimeActive = false;
    this.realtimeHandlers = null;
    this.unsubscribeChannelTooLong = null;

    this._initDatabase();
  }

  _initDatabase() {
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS channels (
        channel_id TEXT PRIMARY KEY,
        peer_title TEXT,
        peer_type TEXT,
        username TEXT,
        sync_enabled INTEGER NOT NULL DEFAULT 1,
        last_message_id INTEGER DEFAULT 0,
        last_message_date TEXT,
        oldest_message_id INTEGER,
        oldest_message_date TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS channel_metadata (
        channel_id TEXT PRIMARY KEY,
        about TEXT,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS channel_metadata_updated_idx
      ON channel_metadata (updated_at);
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS channel_tags (
        channel_id TEXT NOT NULL,
        tag TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'manual',
        confidence REAL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (channel_id, tag, source)
      );
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS channel_tags_tag_idx
      ON channel_tags (tag);
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT '${JOB_STATUS.PENDING}',
        target_message_count INTEGER DEFAULT ${DEFAULT_TARGET_MESSAGES},
        message_count INTEGER DEFAULT 0,
        cursor_message_id INTEGER,
        cursor_message_date TEXT,
        backfill_min_date TEXT,
        last_synced_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        error TEXT
      );
    `);

    this._ensureJobColumn('target_message_count', `INTEGER DEFAULT ${DEFAULT_TARGET_MESSAGES}`);
    this._ensureJobColumn('message_count', 'INTEGER DEFAULT 0');
    this._ensureJobColumn('cursor_message_id', 'INTEGER');
    this._ensureJobColumn('cursor_message_date', 'TEXT');
    this._ensureJobColumn('backfill_min_date', 'TEXT');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        user_id TEXT PRIMARY KEY,
        peer_type TEXT,
        username TEXT,
        display_name TEXT,
        is_bot INTEGER,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS users_username_idx
      ON users (username);
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        topic_id INTEGER,
        date INTEGER,
        from_id TEXT,
        text TEXT,
        raw_json TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(channel_id, message_id)
      );
    `);

    this._ensureMessageColumn('topic_id', 'INTEGER');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS search_meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);

    const searchSchema = this.db.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'table' AND name = 'message_search'
    `).get();
    const needsSearchRecreate = !searchSchema?.sql
      || !searchSchema.sql.includes("tokenize='unicode61'");
    const storedVersion = this.db.prepare(`
      SELECT value FROM search_meta WHERE key = 'search_index_version'
    `).get()?.value;
    const needsVersionRebuild = Number(storedVersion ?? 0) !== SEARCH_INDEX_VERSION;
    const shouldRebuildSearch = needsSearchRecreate || needsVersionRebuild;

    if (needsSearchRecreate) {
      this.db.exec(`
        DROP TRIGGER IF EXISTS messages_ai;
        DROP TRIGGER IF EXISTS messages_ad;
        DROP TRIGGER IF EXISTS messages_au;
        DROP TABLE IF EXISTS message_search;
      `);
    }

    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS message_search USING fts5(
        text,
        content='messages',
        content_rowid='id',
        tokenize='unicode61'
      );
    `);

    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS messages_ai
      AFTER INSERT ON messages BEGIN
        INSERT INTO message_search(rowid, text)
        VALUES (new.id, COALESCE(new.text, ''));
      END;
    `);

    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS messages_ad
      AFTER DELETE ON messages BEGIN
        INSERT INTO message_search(message_search, rowid, text)
        VALUES ('delete', old.id, COALESCE(old.text, ''));
      END;
    `);

    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS messages_au
      AFTER UPDATE ON messages BEGIN
        INSERT INTO message_search(message_search, rowid, text)
        VALUES ('delete', old.id, COALESCE(old.text, ''));
        INSERT INTO message_search(rowid, text)
        VALUES (new.id, COALESCE(new.text, ''));
      END;
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS messages_channel_topic_idx
      ON messages (channel_id, topic_id, message_id);
    `);

    this.db.exec(`
      INSERT OR IGNORE INTO channels (channel_id, sync_enabled)
      SELECT channel_id, 1
      FROM jobs
      WHERE channel_id IS NOT NULL;
    `);

    this.upsertChannelStmt = this.db.prepare(`
      INSERT INTO channels (channel_id, peer_title, peer_type, username, updated_at)
      VALUES (@channel_id, @peer_title, @peer_type, @username, CURRENT_TIMESTAMP)
      ON CONFLICT(channel_id) DO UPDATE SET
        peer_title = excluded.peer_title,
        peer_type = excluded.peer_type,
        username = excluded.username,
        updated_at = CURRENT_TIMESTAMP
      RETURNING channel_id, sync_enabled;
    `);

    this.upsertChannelMetadataStmt = this.db.prepare(`
      INSERT INTO channel_metadata (channel_id, about, updated_at)
      VALUES (@channel_id, @about, CURRENT_TIMESTAMP)
      ON CONFLICT(channel_id) DO UPDATE SET
        about = excluded.about,
        updated_at = CURRENT_TIMESTAMP
    `);

    this.insertChannelTagStmt = this.db.prepare(`
      INSERT INTO channel_tags (channel_id, tag, source, confidence, updated_at)
      VALUES (@channel_id, @tag, @source, @confidence, CURRENT_TIMESTAMP)
      ON CONFLICT(channel_id, tag, source) DO UPDATE SET
        confidence = excluded.confidence,
        updated_at = CURRENT_TIMESTAMP
    `);

    this.deleteChannelTagsStmt = this.db.prepare(`
      DELETE FROM channel_tags
      WHERE channel_id = ? AND source = ?
    `);

    this.upsertUserStmt = this.db.prepare(`
      INSERT INTO users (user_id, peer_type, username, display_name, is_bot, updated_at)
      VALUES (@user_id, @peer_type, @username, @display_name, @is_bot, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id) DO UPDATE SET
        peer_type = COALESCE(excluded.peer_type, users.peer_type),
        username = COALESCE(excluded.username, users.username),
        display_name = COALESCE(excluded.display_name, users.display_name),
        is_bot = COALESCE(excluded.is_bot, users.is_bot),
        updated_at = CURRENT_TIMESTAMP
    `);

    this.insertMessageStmt = this.db.prepare(`
      INSERT OR IGNORE INTO messages (channel_id, message_id, topic_id, date, from_id, text, raw_json)
      VALUES (@channel_id, @message_id, @topic_id, @date, @from_id, @text, @raw_json)
    `);

    this.upsertMessageStmt = this.db.prepare(`
      INSERT INTO messages (channel_id, message_id, topic_id, date, from_id, text, raw_json)
      VALUES (@channel_id, @message_id, @topic_id, @date, @from_id, @text, @raw_json)
      ON CONFLICT(channel_id, message_id) DO UPDATE SET
        topic_id = excluded.topic_id,
        date = excluded.date,
        from_id = excluded.from_id,
        text = excluded.text,
        raw_json = excluded.raw_json
    `);

    this.insertMessagesTx = this.db.transaction((records) => {
      let inserted = 0;
      for (const record of records) {
        const result = this.insertMessageStmt.run(record);
        inserted += result.changes;
      }
      return inserted;
    });

    this.setChannelTagsTx = this.db.transaction((channelId, source, tags) => {
      this.deleteChannelTagsStmt.run(channelId, source);
      for (const entry of tags) {
        this.insertChannelTagStmt.run({
          channel_id: channelId,
          tag: entry.tag,
          source,
          confidence: entry.confidence ?? null,
        });
      }
    });

    this.upsertUsersTx = this.db.transaction((records) => {
      for (const record of records) {
        this.upsertUserStmt.run(record);
      }
    });

    if (shouldRebuildSearch) {
      this.db.prepare("INSERT INTO message_search(message_search) VALUES ('rebuild')").run();
      this.db.prepare(`
        INSERT INTO search_meta (key, value)
        VALUES ('search_index_version', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(String(SEARCH_INDEX_VERSION));
    }
  }

  _ensureJobColumn(column, definition) {
    const existing = this.db.prepare('PRAGMA table_info(jobs)').all();
    if (!existing.some((col) => col.name === column)) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN ${column} ${definition}`);
    }
  }

  _ensureMessageColumn(column, definition) {
    const existing = this.db.prepare('PRAGMA table_info(messages)').all();
    if (!existing.some((col) => col.name === column)) {
      this.db.exec(`ALTER TABLE messages ADD COLUMN ${column} ${definition}`);
    }
  }

  async refreshChannelsFromDialogs() {
    const dialogs = await this.telegramClient.listDialogs(0);
    this.upsertChannels(dialogs);
    return dialogs.length;
  }

  upsertChannels(dialogs = []) {
    const tx = this.db.transaction((items) => {
      for (const dialog of items) {
        this.upsertChannelStmt.get({
          channel_id: String(dialog.id),
          peer_title: dialog.title ?? null,
          peer_type: dialog.type ?? null,
          username: dialog.username ?? null,
        });
      }
    });

    tx(dialogs);
  }

  listActiveChannels() {
    return this.db.prepare(`
      SELECT channel_id, peer_title, peer_type, username, sync_enabled,
             last_message_id, last_message_date, oldest_message_id, oldest_message_date,
             created_at, updated_at
      FROM channels
      WHERE sync_enabled = 1
      ORDER BY updated_at DESC
    `).all();
  }

  setChannelSync(channelId, enabled) {
    const normalizedId = normalizeChannelKey(channelId);
    const value = enabled ? 1 : 0;
    const stmt = this.db.prepare(`
      INSERT INTO channels (channel_id, sync_enabled, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(channel_id) DO UPDATE SET
        sync_enabled = excluded.sync_enabled,
        updated_at = CURRENT_TIMESTAMP
      RETURNING channel_id, sync_enabled;
    `);

    return stmt.get(normalizedId, value);
  }

  setChannelTags(channelId, tags, options = {}) {
    const normalizedId = normalizeChannelKey(channelId);
    const source = options.source ? String(options.source) : 'manual';
    const uniqueTags = new Set();
    for (const tag of tags || []) {
      const normalizedTag = normalizeTag(tag);
      if (normalizedTag) {
        uniqueTags.add(normalizedTag);
      }
    }
    const finalTags = [...uniqueTags].map((tag) => ({ tag, confidence: null }));

    this.db.prepare(`
      INSERT INTO channels (channel_id, updated_at)
      VALUES (?, CURRENT_TIMESTAMP)
      ON CONFLICT(channel_id) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
    `).run(normalizedId);

    this.setChannelTagsTx(normalizedId, source, finalTags);
    return finalTags.map((entry) => entry.tag);
  }

  listChannelTags(channelId, options = {}) {
    const normalizedId = normalizeChannelKey(channelId);
    const source = options.source ? String(options.source) : null;
    const rows = this.db.prepare(`
      SELECT tag, source, confidence, created_at, updated_at
      FROM channel_tags
      WHERE channel_id = ?
      ${source ? 'AND source = ?' : ''}
      ORDER BY tag ASC
    `).all(...(source ? [normalizedId, source] : [normalizedId]));

    return rows.map((row) => ({
      tag: row.tag,
      source: row.source,
      confidence: row.confidence,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  listTaggedChannels(tag, options = {}) {
    const normalizedTag = normalizeTag(tag);
    if (!normalizedTag) {
      return [];
    }
    const source = options.source ? String(options.source) : null;
    const limit = options.limit && options.limit > 0 ? Number(options.limit) : 100;
    const rows = this.db.prepare(`
      SELECT channels.channel_id, channels.peer_title, channels.peer_type, channels.username,
             channel_tags.tag, channel_tags.source, channel_tags.confidence
      FROM channel_tags
      JOIN channels ON channels.channel_id = channel_tags.channel_id
      WHERE channel_tags.tag = ?
      ${source ? 'AND channel_tags.source = ?' : ''}
      ORDER BY channels.peer_title ASC
      LIMIT ?
    `).all(...(source ? [normalizedTag, source, limit] : [normalizedTag, limit]));

    return rows.map((row) => ({
      channelId: row.channel_id,
      peerTitle: row.peer_title,
      peerType: row.peer_type,
      username: row.username,
      tag: row.tag,
      source: row.source,
      confidence: row.confidence,
    }));
  }

  getChannelMetadata(channelId) {
    const normalizedId = normalizeChannelKey(channelId);
    const row = this.db.prepare(`
      SELECT
        channels.channel_id,
        channels.peer_title,
        channels.peer_type,
        channels.username,
        channel_metadata.about,
        channel_metadata.updated_at AS metadata_updated_at
      FROM channels
      LEFT JOIN channel_metadata ON channel_metadata.channel_id = channels.channel_id
      WHERE channels.channel_id = ?
    `).get(normalizedId);

    if (!row) {
      return null;
    }

    return {
      channelId: row.channel_id,
      peerTitle: row.peer_title,
      peerType: row.peer_type,
      username: row.username,
      about: row.about ?? null,
      metadataUpdatedAt: row.metadata_updated_at ?? null,
    };
  }

  async refreshChannelMetadata(options = {}) {
    const limit = options.limit && options.limit > 0 ? Number(options.limit) : 20;
    const force = Boolean(options.force);
    const onlyMissing = Boolean(options.onlyMissing);
    const channelIds = Array.isArray(options.channelIds) ? options.channelIds : null;

    let rows;
    if (channelIds && channelIds.length) {
      rows = channelIds.map((id) => this._getChannelWithMetadata(normalizeChannelKey(id))).filter(Boolean);
    } else {
      rows = this.db.prepare(`
        SELECT
          channels.channel_id,
          channels.peer_title,
          channels.peer_type,
          channels.username,
          channel_metadata.about,
          channel_metadata.updated_at AS metadata_updated_at
        FROM channels
        LEFT JOIN channel_metadata ON channel_metadata.channel_id = channels.channel_id
        ORDER BY channels.updated_at DESC
        LIMIT ?
      `).all(limit);
    }

    const results = [];
    for (const row of rows) {
      if (onlyMissing && row.metadata_updated_at) {
        continue;
      }
      if (!force && !this._isMetadataStale(row.metadata_updated_at)) {
        continue;
      }

      const metadata = await this.telegramClient.getPeerMetadata(
        row.channel_id,
        row.peer_type,
      );

      if (metadata.peerTitle || metadata.peerType || metadata.username) {
        this.upsertChannelStmt.get({
          channel_id: row.channel_id,
          peer_title: metadata.peerTitle ?? row.peer_title ?? null,
          peer_type: metadata.peerType ?? row.peer_type ?? null,
          username: metadata.username ?? row.username ?? null,
        });
      }

      this.upsertChannelMetadataStmt.run({
        channel_id: row.channel_id,
        about: metadata.about ?? null,
      });

      results.push({
        channelId: row.channel_id,
        peerTitle: metadata.peerTitle ?? row.peer_title ?? null,
        peerType: metadata.peerType ?? row.peer_type ?? null,
        username: metadata.username ?? row.username ?? null,
        about: metadata.about ?? null,
        metadataUpdatedAt: new Date().toISOString(),
      });
    }

    return results;
  }

  async autoTagChannels(options = {}) {
    const limit = options.limit && options.limit > 0 ? Number(options.limit) : 50;
    const source = options.source ? String(options.source) : 'auto';
    const refreshMetadata = options.refreshMetadata !== false;
    const channelIds = Array.isArray(options.channelIds) ? options.channelIds : null;

    let rows;
    if (channelIds && channelIds.length) {
      rows = channelIds.map((id) => this._getChannelWithMetadata(normalizeChannelKey(id))).filter(Boolean);
    } else {
      rows = this.db.prepare(`
        SELECT
          channels.channel_id,
          channels.peer_title,
          channels.peer_type,
          channels.username,
          channel_metadata.about,
          channel_metadata.updated_at AS metadata_updated_at
        FROM channels
        LEFT JOIN channel_metadata ON channel_metadata.channel_id = channels.channel_id
        ORDER BY channels.updated_at DESC
        LIMIT ?
      `).all(limit);
    }

    const results = [];
    for (const row of rows) {
      let about = row.about;
      let metadataUpdatedAt = row.metadata_updated_at;
      let peerTitle = row.peer_title;
      let username = row.username;
      let peerType = row.peer_type;
      if (refreshMetadata && this._isMetadataStale(metadataUpdatedAt)) {
        const metadata = await this.telegramClient.getPeerMetadata(
          row.channel_id,
          row.peer_type,
        );
        if (metadata.peerTitle || metadata.peerType || metadata.username) {
          peerTitle = metadata.peerTitle ?? peerTitle;
          username = metadata.username ?? username;
          peerType = metadata.peerType ?? peerType;
          this.upsertChannelStmt.get({
            channel_id: row.channel_id,
            peer_title: peerTitle ?? null,
            peer_type: peerType ?? null,
            username: username ?? null,
          });
        }
        this.upsertChannelMetadataStmt.run({
          channel_id: row.channel_id,
          about: metadata.about ?? null,
        });
        about = metadata.about ?? null;
        metadataUpdatedAt = new Date().toISOString();
      }

      const tagText = buildTagText({
        peerTitle,
        username,
        about,
      }).toLowerCase();
      const tags = classifyTags(tagText);
      this.setChannelTagsTx(row.channel_id, source, tags);

      results.push({
        channelId: row.channel_id,
        peerTitle,
        peerType,
        username,
        tags: tags.map((entry) => ({
          tag: entry.tag,
          confidence: entry.confidence,
        })),
        metadataUpdatedAt: metadataUpdatedAt ?? null,
      });
    }

    return results;
  }

  addJob(channelId, options = {}) {
    const normalizedId = normalizeChannelKey(channelId);
    const target = options.depth && options.depth > 0 ? Number(options.depth) : DEFAULT_TARGET_MESSAGES;
    const minDate = options.minDate ? parseIsoDate(options.minDate) : null;
    const minDateIso = minDate ? new Date(minDate * 1000).toISOString() : null;

    this.db.prepare(`
      INSERT INTO channels (channel_id, updated_at)
      VALUES (?, CURRENT_TIMESTAMP)
      ON CONFLICT(channel_id) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
    `).run(normalizedId);

    const stmt = this.db.prepare(`
      INSERT INTO jobs (
        channel_id,
        status,
        error,
        target_message_count,
        message_count,
        cursor_message_id,
        cursor_message_date,
        backfill_min_date,
        updated_at
      )
      VALUES (?, '${JOB_STATUS.PENDING}', NULL, ?, 0, NULL, NULL, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(channel_id) DO UPDATE SET
        status='${JOB_STATUS.PENDING}',
        error=NULL,
        target_message_count=excluded.target_message_count,
        backfill_min_date=excluded.backfill_min_date,
        updated_at=CURRENT_TIMESTAMP
      RETURNING *;
    `);

    return stmt.get(normalizedId, target, minDateIso);
  }

  listJobs() {
    return this.db.prepare(`
      SELECT
        jobs.id,
        jobs.channel_id,
        channels.peer_title,
        channels.peer_type,
        jobs.status,
        jobs.target_message_count,
        jobs.message_count,
        jobs.cursor_message_id,
        jobs.cursor_message_date,
        jobs.backfill_min_date,
        jobs.last_synced_at,
        jobs.created_at,
        jobs.updated_at,
        jobs.error
      FROM jobs
      LEFT JOIN channels ON channels.channel_id = jobs.channel_id
      ORDER BY jobs.updated_at DESC
    `).all();
  }

  startRealtimeSync() {
    if (this.realtimeActive) {
      return;
    }

    const newMessageHandler = (message) => {
      this._handleIncomingMessage(message, { isEdit: false });
    };
    const editMessageHandler = (message) => {
      this._handleIncomingMessage(message, { isEdit: true });
    };
    const deleteMessageHandler = (update) => {
      this._handleDeleteMessage(update);
    };

    this.telegramClient.client.onNewMessage.add(newMessageHandler);
    this.telegramClient.client.onEditMessage.add(editMessageHandler);
    this.telegramClient.client.onDeleteMessage.add(deleteMessageHandler);

    this.realtimeHandlers = {
      newMessageHandler,
      editMessageHandler,
      deleteMessageHandler,
    };

    this.unsubscribeChannelTooLong = this.telegramClient.onChannelTooLong((payload) => {
      this._handleChannelTooLong(payload);
    });

    this.realtimeActive = true;
  }

  async processQueue() {
    if (this.processing) {
      return;
    }
    if (this.stopRequested) {
      return;
    }
    this.processing = true;
    try {
      while (true) {
        if (this.stopRequested) {
          break;
        }
        const job = this._getNextJob();
        if (!job) {
          break;
        }
        await this._processJob(job);
        await delay(this.interJobDelayMs);
      }
    } finally {
      this.processing = false;
    }
  }

  resumePendingJobs() {
    this._resetErroredJobs();
    void this.processQueue();
  }

  async shutdown() {
    this.stopRequested = true;

    while (this.processing) {
      await delay(100);
    }

    if (this.db && this.db.open) {
      this.db.prepare(`
        UPDATE jobs
        SET status = ?, error = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE status = ?
      `).run(JOB_STATUS.PENDING, JOB_STATUS.IN_PROGRESS);
    }

    if (this.realtimeActive && this.realtimeHandlers) {
      this.telegramClient.client.onNewMessage.remove(this.realtimeHandlers.newMessageHandler);
      this.telegramClient.client.onEditMessage.remove(this.realtimeHandlers.editMessageHandler);
      this.telegramClient.client.onDeleteMessage.remove(this.realtimeHandlers.deleteMessageHandler);
      this.realtimeHandlers = null;
      if (this.unsubscribeChannelTooLong) {
        this.unsubscribeChannelTooLong();
        this.unsubscribeChannelTooLong = null;
      }
      this.realtimeActive = false;
    }

    if (this.db && this.db.open) {
      this.db.close();
    }
  }

  _getNextJob() {
    return this.db.prepare(`
      SELECT * FROM jobs
      WHERE status IN ('${JOB_STATUS.PENDING}', '${JOB_STATUS.IN_PROGRESS}')
      ORDER BY updated_at ASC
      LIMIT 1
    `).get();
  }

  _resetErroredJobs() {
    this.db.prepare(`
      UPDATE jobs
      SET status = ?, error = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE status = ?
    `).run(JOB_STATUS.PENDING, JOB_STATUS.ERROR);
  }

  searchMessages({ channelId, topicId, pattern, limit = 50, caseInsensitive = true }) {
    const normalizedId = normalizeChannelKey(channelId);
    const flags = caseInsensitive ? 'i' : '';
    let regex;
    try {
      regex = new RegExp(pattern, flags);
    } catch (error) {
      throw new Error(`Invalid pattern: ${error.message}`);
    }

    const topicClause = typeof topicId === 'number' ? 'AND topic_id = ?' : '';
    const params = typeof topicId === 'number' ? [normalizedId, topicId] : [normalizedId];
    const rows = this.db.prepare(`
      SELECT
        messages.message_id,
        messages.date,
        messages.from_id,
        messages.text,
        messages.topic_id,
        users.username AS from_username,
        users.display_name AS from_display_name
      FROM messages
      LEFT JOIN users ON users.user_id = messages.from_id
      WHERE channel_id = ?
      ${topicClause}
      ORDER BY message_id DESC
    `).all(...params);

    const matches = [];
    for (const row of rows) {
      const text = row.text || '';
      if (regex.test(text)) {
        matches.push({
          messageId: row.message_id,
          date: row.date ? new Date(row.date * 1000).toISOString() : null,
          fromId: row.from_id,
          fromUsername: row.from_username ?? null,
          fromDisplayName: row.from_display_name ?? null,
          text,
          topicId: row.topic_id ?? null,
        });
        if (matches.length >= limit) {
          break;
        }
      }
    }

    return matches;
  }

  getArchivedMessages({ channelId, topicId, limit = 50 }) {
    const normalizedId = normalizeChannelKey(channelId);
    const topicClause = typeof topicId === 'number' ? 'AND topic_id = ?' : '';
    const params = typeof topicId === 'number'
      ? [normalizedId, topicId, limit]
      : [normalizedId, limit];
    const rows = this.db.prepare(`
      SELECT
        messages.message_id,
        messages.date,
        messages.from_id,
        messages.text,
        messages.topic_id,
        users.username AS from_username,
        users.display_name AS from_display_name
      FROM messages
      LEFT JOIN users ON users.user_id = messages.from_id
      WHERE channel_id = ?
      ${topicClause}
      ORDER BY message_id DESC
      LIMIT ?
    `).all(...params);

    return rows.map((row) => ({
      messageId: row.message_id,
      date: row.date ? new Date(row.date * 1000).toISOString() : null,
      fromId: row.from_id,
      fromUsername: row.from_username ?? null,
      fromDisplayName: row.from_display_name ?? null,
      text: row.text,
      topicId: row.topic_id ?? null,
    }));
  }

  getMessageStats(channelId) {
    const normalizedId = normalizeChannelKey(channelId);
    const summary = this.db.prepare(`
      SELECT
        COUNT(*) AS total,
        MIN(message_id) AS oldestMessageId,
        MAX(message_id) AS newestMessageId,
        MIN(date) AS oldestDate,
        MAX(date) AS newestDate
      FROM messages
      WHERE channel_id = ?
    `).get(normalizedId);

    return {
      total: summary.total || 0,
      oldestMessageId: summary.oldestMessageId || null,
      newestMessageId: summary.newestMessageId || null,
      oldestDate: summary.oldestDate ? new Date(summary.oldestDate * 1000).toISOString() : null,
      newestDate: summary.newestDate ? new Date(summary.newestDate * 1000).toISOString() : null,
    };
  }

  searchTaggedMessages({ tag, query, fromDate, toDate, limit = 100, source = null }) {
    const normalizedTag = normalizeTag(tag);
    if (!normalizedTag) {
      return [];
    }
    const queryText = typeof query === 'string' ? query.trim() : '';
    const params = [normalizedTag];
    const sourceClause = source ? 'AND channel_tags.source = ?' : '';
    if (source) {
      params.push(String(source));
    }

    let dateClause = '';
    if (fromDate) {
      params.push(parseIsoDate(fromDate));
      dateClause += ' AND messages.date >= ?';
    }
    if (toDate) {
      params.push(parseIsoDate(toDate));
      dateClause += ' AND messages.date <= ?';
    }

    const finalLimit = limit && limit > 0 ? Number(limit) : 100;

    if (queryText) {
      params.push(queryText);
      params.push(finalLimit);
      const rows = this.db.prepare(`
        SELECT
          messages.channel_id,
          channels.peer_title,
          channels.username,
          messages.message_id,
          messages.date,
          messages.from_id,
          messages.text,
          messages.topic_id,
          users.username AS from_username,
          users.display_name AS from_display_name
        FROM message_search
        JOIN messages ON messages.id = message_search.rowid
        JOIN channel_tags ON channel_tags.channel_id = messages.channel_id
        LEFT JOIN channels ON channels.channel_id = messages.channel_id
        LEFT JOIN users ON users.user_id = messages.from_id
        WHERE channel_tags.tag = ?
        ${sourceClause}
        ${dateClause}
        AND message_search MATCH ?
        ORDER BY messages.date DESC
        LIMIT ?
      `).all(...params);

      return rows.map((row) => ({
        channelId: row.channel_id,
        peerTitle: row.peer_title,
        username: row.username,
        messageId: row.message_id,
        date: row.date ? new Date(row.date * 1000).toISOString() : null,
        fromId: row.from_id,
        fromUsername: row.from_username ?? null,
        fromDisplayName: row.from_display_name ?? null,
        text: row.text,
        topicId: row.topic_id ?? null,
      }));
    }

    params.push(finalLimit);
    const rows = this.db.prepare(`
      SELECT
        messages.channel_id,
        channels.peer_title,
        channels.username,
        messages.message_id,
        messages.date,
        messages.from_id,
        messages.text,
        messages.topic_id,
        users.username AS from_username,
        users.display_name AS from_display_name
      FROM messages
      JOIN channel_tags ON channel_tags.channel_id = messages.channel_id
      LEFT JOIN channels ON channels.channel_id = messages.channel_id
      LEFT JOIN users ON users.user_id = messages.from_id
      WHERE channel_tags.tag = ?
      ${sourceClause}
      ${dateClause}
      ORDER BY messages.date DESC
      LIMIT ?
    `).all(...params);

    return rows.map((row) => ({
      channelId: row.channel_id,
      peerTitle: row.peer_title,
      username: row.username,
      messageId: row.message_id,
      date: row.date ? new Date(row.date * 1000).toISOString() : null,
      fromId: row.from_id,
      fromUsername: row.from_username ?? null,
      fromDisplayName: row.from_display_name ?? null,
      text: row.text,
      topicId: row.topic_id ?? null,
    }));
  }

  async _processJob(job) {
    if (this.stopRequested) {
      this._updateJobStatus(job.id, JOB_STATUS.PENDING);
      return;
    }

    this._updateJobStatus(job.id, JOB_STATUS.IN_PROGRESS);

    try {
      const channelId = normalizeChannelKey(job.channel_id);
      const syncResult = await this._syncNewerMessages(channelId);
      if (this.stopRequested || syncResult.stoppedEarly) {
        this._updateJobStatus(job.id, JOB_STATUS.PENDING);
        return;
      }

      const currentCount = this._countMessages(channelId);
      const targetCount = job.target_message_count || DEFAULT_TARGET_MESSAGES;
      const backfillResult = await this._backfillHistory(job, currentCount, targetCount);
      if (this.stopRequested || backfillResult.stoppedEarly) {
        this._updateJobRecord(job.id, {
          status: JOB_STATUS.PENDING,
          messageCount: backfillResult.finalCount,
          cursorMessageId: backfillResult.cursorMessageId,
          cursorMessageDate: backfillResult.cursorMessageDate,
        });
        return;
      }

      const shouldContinue = backfillResult.hasMoreOlder;
      const finalStatus = shouldContinue ? JOB_STATUS.PENDING : JOB_STATUS.IDLE;

      this._updateJobRecord(job.id, {
        status: finalStatus,
        messageCount: backfillResult.finalCount,
        cursorMessageId: backfillResult.cursorMessageId,
        cursorMessageDate: backfillResult.cursorMessageDate,
      });
    } catch (error) {
      if (this.stopRequested) {
        this._updateJobStatus(job.id, JOB_STATUS.PENDING);
        return;
      }
      const waitMatch = /wait of (\d+) seconds is required/i.exec(error.message || '');
      if (waitMatch) {
        const waitSeconds = Number(waitMatch[1]);
        this.db.prepare(`
          UPDATE jobs
          SET status = ?, error = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(JOB_STATUS.PENDING, `Rate limited, waiting ${waitSeconds}s`, job.id);
        await delay(waitSeconds * 1000);
      } else {
        this._markJobError(job.id, error);
      }
    }
  }

  _updateJobStatus(id, status) {
    this.db.prepare(`
      UPDATE jobs
      SET status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(status, id);
  }

  _updateJobRecord(id, { status, messageCount, cursorMessageId, cursorMessageDate }) {
    this.db.prepare(`
      UPDATE jobs
      SET status = ?,
          message_count = ?,
          cursor_message_id = ?,
          cursor_message_date = ?,
          last_synced_at = CURRENT_TIMESTAMP,
          error = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      status,
      messageCount ?? 0,
      cursorMessageId ?? null,
      cursorMessageDate ?? null,
      id,
    );
  }

  _markJobError(id, error) {
    this.db.prepare(`
      UPDATE jobs
      SET status = ?, error = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(JOB_STATUS.ERROR, error.message || String(error), id);
  }

  _countMessages(channelId) {
    return this.db.prepare(`
      SELECT COUNT(*) AS cnt
      FROM messages
      WHERE channel_id = ?
    `).get(String(channelId)).cnt;
  }

  _buildMessageRecord(channelId, message) {
    return {
      channel_id: channelId,
      message_id: message.id,
      topic_id: message.topic_id ?? null,
      date: message.date ?? null,
      from_id: message.from_id ?? null,
      text: message.text ?? null,
      raw_json: JSON.stringify(message),
    };
  }

  _buildUserRecordFromPeer(peer) {
    if (!peer?.id) {
      return null;
    }
    const username = typeof peer.username === 'string' && peer.username ? peer.username : null;
    let displayName = null;
    if (typeof peer.displayName === 'string' && peer.displayName.trim()) {
      displayName = peer.displayName.trim();
    } else {
      const nameParts = [peer.firstName, peer.lastName].filter(Boolean);
      displayName = nameParts.length ? nameParts.join(' ') : null;
    }
    const peerType = normalizePeerType(peer);
    const isBot = typeof peer.isBot === 'boolean' ? (peer.isBot ? 1 : 0) : null;

    return {
      user_id: peer.id.toString(),
      peer_type: peerType,
      username,
      display_name: displayName,
      is_bot: isBot,
    };
  }

  _buildUserRecordFromSerialized(message) {
    if (!message?.from_id) {
      return null;
    }
    const userId = String(message.from_id);
    if (!userId || userId === 'unknown') {
      return null;
    }
    const username = message.from_username ?? null;
    const displayName = message.from_display_name ?? null;
    const peerType = message.from_peer_type ?? null;
    const isBot = typeof message.from_is_bot === 'boolean' ? (message.from_is_bot ? 1 : 0) : null;
    if (!username && !displayName && !peerType && isBot === null) {
      return null;
    }

    return {
      user_id: userId,
      peer_type: peerType,
      username,
      display_name: displayName,
      is_bot: isBot,
    };
  }

  _getChannel(channelId) {
    return this.db.prepare(`
      SELECT channel_id, peer_title, peer_type, username, sync_enabled,
             last_message_id, last_message_date, oldest_message_id, oldest_message_date
      FROM channels
      WHERE channel_id = ?
    `).get(channelId);
  }

  _getChannelWithMetadata(channelId) {
    return this.db.prepare(`
      SELECT
        channels.channel_id,
        channels.peer_title,
        channels.peer_type,
        channels.username,
        channel_metadata.about,
        channel_metadata.updated_at AS metadata_updated_at
      FROM channels
      LEFT JOIN channel_metadata ON channel_metadata.channel_id = channels.channel_id
      WHERE channels.channel_id = ?
    `).get(channelId);
  }

  _isMetadataStale(updatedAt) {
    if (!updatedAt) {
      return true;
    }
    const ts = new Date(updatedAt).getTime();
    if (Number.isNaN(ts)) {
      return true;
    }
    return Date.now() - ts > METADATA_TTL_MS;
  }

  _updateChannelCursors(channelId, { lastMessageId, lastMessageDate, oldestMessageId, oldestMessageDate }) {
    const existing = this._getChannel(channelId);
    if (!existing) {
      return;
    }

    let nextLastId = existing.last_message_id || 0;
    let nextLastDate = existing.last_message_date || null;
    if (Number.isFinite(lastMessageId) && lastMessageId > nextLastId) {
      nextLastId = lastMessageId;
      nextLastDate = lastMessageDate || nextLastDate;
    }

    let nextOldestId = existing.oldest_message_id || null;
    let nextOldestDate = existing.oldest_message_date || null;
    if (Number.isFinite(oldestMessageId) && (!nextOldestId || oldestMessageId < nextOldestId)) {
      nextOldestId = oldestMessageId;
      nextOldestDate = oldestMessageDate || nextOldestDate;
    }

    this.db.prepare(`
      UPDATE channels
      SET last_message_id = ?,
          last_message_date = ?,
          oldest_message_id = ?,
          oldest_message_date = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE channel_id = ?
    `).run(
      nextLastId,
      nextLastDate,
      nextOldestId,
      nextOldestDate,
      channelId,
    );
  }

  _ensureChannelFromPeer(channelId, peer) {
    const peerTitle = peer?.displayName ?? null;
    const peerType = normalizePeerType(peer);
    const username = peer?.username ?? null;
    return this.upsertChannelStmt.get({
      channel_id: channelId,
      peer_title: peerTitle,
      peer_type: peerType,
      username,
    });
  }

  _isChannelActive(channelId) {
    const row = this.db.prepare(`
      SELECT sync_enabled
      FROM channels
      WHERE channel_id = ?
    `).get(channelId);

    if (!row) {
      return false;
    }
    return row.sync_enabled === 1;
  }

  _handleIncomingMessage(message, { isEdit }) {
    if (!message?.chat?.id) {
      return;
    }

    const channelId = String(message.chat.id);
    const channelRow = this._ensureChannelFromPeer(channelId, message.chat);
    const syncEnabled = channelRow ? channelRow.sync_enabled === 1 : this._isChannelActive(channelId);
    if (!syncEnabled) {
      return;
    }

    const senderRecord = this._buildUserRecordFromPeer(message.sender || message.from || message.author);
    if (senderRecord) {
      this.upsertUserStmt.run(senderRecord);
    }

    const serialized = this.telegramClient._serializeMessage(message, message.chat);
    const record = this._buildMessageRecord(channelId, serialized);

    if (isEdit) {
      this.upsertMessageStmt.run(record);
    } else {
      this.insertMessageStmt.run(record);
    }

    const messageDate = toIsoString(serialized.date);
    this._updateChannelCursors(channelId, {
      lastMessageId: serialized.id,
      lastMessageDate: messageDate,
      oldestMessageId: serialized.id,
      oldestMessageDate: messageDate,
    });
  }

  _handleDeleteMessage(update) {
    if (!update?.messageIds?.length) {
      return;
    }

    const ids = update.messageIds;
    const placeholders = ids.map(() => '?').join(', ');

    if (update.channelId) {
      const channelId = normalizeChannelKey(update.channelId);
      this.db.prepare(`
        DELETE FROM messages
        WHERE channel_id = ? AND message_id IN (${placeholders})
      `).run(channelId, ...ids);
      return;
    }

    this.db.prepare(`
      DELETE FROM messages
      WHERE message_id IN (${placeholders})
        AND channel_id IN (
          SELECT channel_id FROM channels WHERE peer_type IN ('chat', 'user')
        )
    `).run(...ids);
  }

  _handleChannelTooLong({ channelId, diff }) {
    if (!diff?.messages?.length) {
      return;
    }

    const peers = PeersIndex.from(diff);
    const records = [];
    const userRecords = new Map();
    let batchChannelId = null;
    let latestMessageId = null;
    let latestMessageDate = null;
    let oldestMessageId = null;
    let oldestMessageDate = null;

    for (const rawMessage of diff.messages) {
      if (rawMessage._ === 'messageEmpty') {
        continue;
      }
      const message = new Message(rawMessage, peers);
      const channelKey = String(message.chat?.id ?? normalizeChannelKey(channelId));
      batchChannelId = batchChannelId ?? channelKey;

      const channelRow = this._ensureChannelFromPeer(channelKey, message.chat);
      const syncEnabled = channelRow ? channelRow.sync_enabled === 1 : this._isChannelActive(channelKey);
      if (!syncEnabled) {
        continue;
      }

      const senderRecord = this._buildUserRecordFromPeer(message.sender || message.from || message.author);
      if (senderRecord) {
        userRecords.set(senderRecord.user_id, senderRecord);
      }

      const serialized = this.telegramClient._serializeMessage(message, message.chat);
      records.push(this._buildMessageRecord(channelKey, serialized));

      const messageDateIso = toIsoString(serialized.date);
      if (Number.isFinite(serialized.id)) {
        if (!latestMessageId || serialized.id > latestMessageId) {
          latestMessageId = serialized.id;
          latestMessageDate = messageDateIso;
        }
        if (!oldestMessageId || serialized.id < oldestMessageId) {
          oldestMessageId = serialized.id;
          oldestMessageDate = messageDateIso;
        }
      }
    }

    if (!records.length || !batchChannelId) {
      return;
    }

    if (userRecords.size) {
      this.upsertUsersTx([...userRecords.values()]);
    }

    this.insertMessagesTx(records);

    this._updateChannelCursors(batchChannelId, {
      lastMessageId: latestMessageId,
      lastMessageDate: latestMessageDate,
      oldestMessageId: oldestMessageId,
      oldestMessageDate: oldestMessageDate,
    });

    void this._syncNewerMessages(batchChannelId);
  }

  async _syncNewerMessages(channelId) {
    const normalizedId = normalizeChannelKey(channelId);
    const channel = this._getChannel(normalizedId);
    if (!channel || channel.sync_enabled !== 1) {
      return { hasMoreNewer: false, stoppedEarly: false };
    }

    let minId = channel.last_message_id || 0;
    let lastMessageId = channel.last_message_id || 0;
    let lastMessageDate = channel.last_message_date || null;
    let oldestMessageId = channel.oldest_message_id || null;
    let oldestMessageDate = channel.oldest_message_date || null;
    let hasMoreNewer = false;
    let stoppedEarly = false;
    let peerTitle = channel.peer_title;
    let peerType = channel.peer_type;

    while (true) {
      if (this.stopRequested) {
        stoppedEarly = true;
        break;
      }
      const { peerTitle: title, peerType: type, messages } = await this.telegramClient.getMessagesByChannelId(
        normalizedId,
        this.batchSize,
        { minId },
      );

      if (this.stopRequested) {
        stoppedEarly = true;
        break;
      }

      peerTitle = title ?? peerTitle;
      peerType = type ?? peerType;

      const newMessages = messages
        .filter((msg) => msg.id > minId)
        .sort((a, b) => a.id - b.id);

      if (!newMessages.length) {
        hasMoreNewer = false;
        break;
      }

      const userRecords = new Map();
      for (const message of newMessages) {
        const userRecord = this._buildUserRecordFromSerialized(message);
        if (userRecord) {
          userRecords.set(userRecord.user_id, userRecord);
        }
      }

      const records = newMessages.map((msg) => this._buildMessageRecord(normalizedId, msg));
      this.insertMessagesTx(records);
      if (userRecords.size) {
        this.upsertUsersTx([...userRecords.values()]);
      }

      const newest = newMessages[newMessages.length - 1];
      const oldest = newMessages[0];

      lastMessageId = newest.id;
      lastMessageDate = toIsoString(newest.date) || lastMessageDate;

      if (!oldestMessageId || oldest.id < oldestMessageId) {
        oldestMessageId = oldest.id;
        oldestMessageDate = toIsoString(oldest.date) || oldestMessageDate;
      }

      minId = newest.id;
      hasMoreNewer = newMessages.length >= this.batchSize;

      if (!hasMoreNewer || this.stopRequested) {
        if (this.stopRequested) {
          stoppedEarly = true;
        }
        break;
      }

      await delay(this.interBatchDelayMs);
    }

    if (peerTitle || peerType) {
      this.upsertChannelStmt.get({
        channel_id: normalizedId,
        peer_title: peerTitle ?? null,
        peer_type: peerType ?? null,
        username: channel.username ?? null,
      });
    }

    this._updateChannelCursors(normalizedId, {
      lastMessageId,
      lastMessageDate,
      oldestMessageId,
      oldestMessageDate,
    });

    return {
      hasMoreNewer,
      lastMessageId,
      oldestMessageId,
      stoppedEarly,
    };
  }

  async _backfillHistory(job, currentCount, targetCount) {
    if (currentCount >= targetCount) {
      return {
        finalCount: currentCount,
        oldestMessageId: null,
        oldestMessageDate: null,
        hasMoreOlder: false,
        insertedCount: 0,
        cursorMessageId: job.cursor_message_id ?? null,
        cursorMessageDate: job.cursor_message_date ?? null,
        stoppedEarly: false,
      };
    }

    const channelId = normalizeChannelKey(job.channel_id);
    const channel = this._getChannel(channelId);
    const peer = await this.telegramClient.client.resolvePeer(normalizeChannelId(channelId));
    const minDateSeconds = job.backfill_min_date ? parseIsoDate(job.backfill_min_date) : null;

    let total = currentCount;
    let currentOldestId = channel?.oldest_message_id ?? null;
    let currentOldestDate = channel?.oldest_message_date ?? null;
    let insertedCount = 0;
    let nextOffsetId = job.cursor_message_id ?? currentOldestId ?? channel?.last_message_id ?? 0;
    let nextOffsetDate = null;
    if (job.cursor_message_date) {
      nextOffsetDate = parseIsoDate(job.cursor_message_date);
    } else if (currentOldestDate) {
      nextOffsetDate = parseIsoDate(currentOldestDate);
    } else if (channel?.last_message_date) {
      nextOffsetDate = parseIsoDate(channel.last_message_date);
    }
    let stopDueToDate = false;
    let stoppedEarly = false;

    while (total < targetCount) {
      if (this.stopRequested) {
        stoppedEarly = true;
        break;
      }
      if (nextOffsetId !== 0 && nextOffsetId <= 1) {
        break;
      }

      const chunkLimit = Math.min(this.batchSize, targetCount - total);
      const iterator = this.telegramClient.client.iterHistory(peer, {
        limit: chunkLimit,
        chunkSize: chunkLimit,
        reverse: false,
        offset: { id: nextOffsetId, date: nextOffsetDate ?? 0 },
        addOffset: 0,
      });

      const records = [];
      const userRecords = new Map();
      let lowestIdInChunk = null;
      let lowestDateInChunk = null;
      let lowestDateSecondsInChunk = null;

      for await (const message of iterator) {
        if (this.stopRequested) {
          stoppedEarly = true;
          break;
        }
        const serialized = this.telegramClient._serializeMessage(message, peer);
        if (minDateSeconds && serialized.date && serialized.date < minDateSeconds) {
          stopDueToDate = true;
          break;
        }

        const senderRecord = this._buildUserRecordFromPeer(message.sender || message.from || message.author);
        if (senderRecord) {
          userRecords.set(senderRecord.user_id, senderRecord);
        }

        records.push(this._buildMessageRecord(channelId, serialized));

        if (!lowestIdInChunk || serialized.id < lowestIdInChunk) {
          lowestIdInChunk = serialized.id;
          lowestDateSecondsInChunk = serialized.date ?? null;
          lowestDateInChunk = toIsoString(serialized.date);
        }
      }

      if (this.stopRequested) {
        break;
      }

      if (!records.length) {
        break;
      }

      if (userRecords.size) {
        this.upsertUsersTx([...userRecords.values()]);
      }

      const inserted = this.insertMessagesTx(records);

      total += inserted;
      insertedCount += inserted;

      const previousOffsetId = nextOffsetId;
      const previousOffsetDate = nextOffsetDate ?? 0;
      nextOffsetId = lowestIdInChunk ?? nextOffsetId;
      if (Number.isFinite(lowestDateSecondsInChunk)) {
        nextOffsetDate = lowestDateSecondsInChunk;
      }

      if (lowestIdInChunk && (!currentOldestId || lowestIdInChunk < currentOldestId)) {
        currentOldestId = lowestIdInChunk;
        currentOldestDate = lowestDateInChunk || currentOldestDate;
      }

      if (nextOffsetId === previousOffsetId && (nextOffsetDate ?? 0) === previousOffsetDate) {
        break;
      }

      if (stopDueToDate || total >= targetCount || this.stopRequested) {
        if (this.stopRequested) {
          stoppedEarly = true;
        }
        break;
      }

      await delay(this.interBatchDelayMs);
    }

    if (currentOldestId) {
      this._updateChannelCursors(channelId, {
        oldestMessageId: currentOldestId,
        oldestMessageDate: currentOldestDate,
      });
    }

    return {
      finalCount: this._countMessages(channelId),
      oldestMessageId: currentOldestId,
      oldestMessageDate: currentOldestDate,
      hasMoreOlder: insertedCount > 0 && total < targetCount && !stopDueToDate && !stoppedEarly,
      insertedCount,
      cursorMessageId: nextOffsetId ?? job.cursor_message_id ?? null,
      cursorMessageDate: Number.isFinite(nextOffsetDate) && nextOffsetDate > 0
        ? toIsoString(nextOffsetDate)
        : job.cursor_message_date ?? null,
      stoppedEarly,
    };
  }
}
