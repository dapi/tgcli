const MEDIA_COLUMNS = `
  message_media.media_type,
  message_media.file_id,
  message_media.unique_file_id,
  message_media.file_name,
  message_media.mime_type,
  message_media.file_size,
  message_media.width,
  message_media.height,
  message_media.duration,
  message_media.extra_json
`;
const MEDIA_JOIN = `
  LEFT JOIN message_media
    ON message_media.channel_id = messages.channel_id
   AND message_media.message_id = messages.message_id
`;

function normalizeChannelId(channelId) {
  if (typeof channelId === 'number') return channelId;
  if (typeof channelId === 'bigint') return Number(channelId);
  if (typeof channelId === 'string') {
    const trimmed = channelId.trim();
    if (/^-?\d+$/.test(trimmed)) {
      const numeric = Number(trimmed);
      if (!Number.isNaN(numeric)) return numeric;
    }
    return trimmed;
  }
  throw new Error('Invalid channel ID provided');
}

export function normalizeChannelKey(channelId) {
  return String(normalizeChannelId(channelId));
}

export function parseIsoDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  const ts = date.getTime();
  if (Number.isNaN(ts)) {
    throw new Error('minDate must be a valid ISO-8601 string');
  }
  return Math.floor(ts / 1000);
}

function formatMediaRow(row) {
  if (!row) {
    return null;
  }
  const hasMedia = row.media_type || row.file_id || row.unique_file_id || row.file_name;
  if (!hasMedia) {
    return null;
  }
  const extras = safeParseJson(row.extra_json);
  return {
    type: row.media_type ?? null,
    fileId: row.file_id ?? null,
    uniqueFileId: row.unique_file_id ?? null,
    fileName: row.file_name ?? null,
    mimeType: row.mime_type ?? null,
    fileSize: typeof row.file_size === 'number' ? row.file_size : row.file_size ?? null,
    width: typeof row.width === 'number' ? row.width : row.width ?? null,
    height: typeof row.height === 'number' ? row.height : row.height ?? null,
    duration: typeof row.duration === 'number' ? row.duration : row.duration ?? null,
    extras: extras ?? null,
  };
}

function formatArchivedRow(row) {
  const isBot = row.from_is_bot;
  return {
    channelId: row.channel_id,
    peerTitle: row.peer_title ?? null,
    username: row.username ?? null,
    messageId: row.message_id,
    date: row.date ? new Date(row.date * 1000).toISOString() : null,
    fromId: row.from_id ?? null,
    fromUsername: row.from_username ?? null,
    fromDisplayName: row.from_display_name ?? null,
    fromPeerType: row.from_peer_type ?? null,
    fromIsBot: typeof isBot === 'number' ? Boolean(isBot) : isBot ?? null,
    text: row.text ?? '',
    media: formatMediaRow(row),
    topicId: row.topic_id ?? null,
  };
}

function normalizeTagsList(raw) {
  if (!raw) {
    return [];
  }
  if (Array.isArray(raw)) {
    return raw.filter(Boolean);
  }
  if (typeof raw === 'string') {
    return raw
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean);
  }
  return [];
}

export function formatContactRow(row) {
  if (!row) {
    return null;
  }
  const isBot = row.is_bot;
  const isContact = row.is_contact;
  const tags = normalizeTagsList(row.tags);
  return {
    userId: row.user_id,
    peerType: row.peer_type ?? null,
    username: row.username ?? null,
    displayName: row.display_name ?? null,
    phone: row.phone ?? null,
    isContact: typeof isContact === 'number' ? Boolean(isContact) : isContact ?? null,
    isBot: typeof isBot === 'number' ? Boolean(isBot) : isBot ?? null,
    alias: row.alias ?? null,
    notes: row.notes ?? null,
    tags,
  };
}

export function safeParseJson(value) {
  if (!value || typeof value !== 'string') {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch (error) {
    return null;
  }
}

export function normalizeTag(tag) {
  if (!tag) return null;
  const normalized = String(tag).trim().toLowerCase();
  return normalized.replace(/\s+/g, ' ');
}

export class ArchiveQueries {
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

  listContactTags(userId) {
    const normalizedId = String(userId);
    return this.listContactTagsStmt.all(normalizedId).map((row) => row.tag);
  }

  getContact(userId) {
    const normalizedId = String(userId);
    const row = this.db.prepare(`
      SELECT
        users.user_id,
        users.peer_type,
        users.username,
        users.display_name,
        users.phone,
        users.is_contact,
        users.is_bot,
        contacts.alias,
        contacts.notes
      FROM users
      LEFT JOIN contacts ON contacts.user_id = users.user_id
      WHERE users.user_id = ?
    `).get(normalizedId);

    if (!row) {
      return null;
    }

    return {
      ...formatContactRow(row),
      tags: this.listContactTags(normalizedId),
    };
  }

  getChannelMetadata(channelId) {
    const normalizedId = normalizeChannelKey(channelId);
    const row = this.db.prepare(`
      SELECT
        channels.channel_id,
        channels.peer_title,
        channels.peer_type,
        channels.chat_type,
        channels.is_forum,
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
      chatType: row.chat_type ?? null,
      isForum: typeof row.is_forum === 'number' ? Boolean(row.is_forum) : row.is_forum ?? null,
      username: row.username,
      about: row.about ?? null,
      metadataUpdatedAt: row.metadata_updated_at ?? null,
    };
  }

  getChannel(channelId) {
    const normalizedId = normalizeChannelKey(channelId);
    const row = this.db.prepare(`
      SELECT
        channels.channel_id,
        channels.peer_title,
        channels.peer_type,
        channels.chat_type,
        channels.is_forum,
        channels.username,
        channels.sync_enabled,
        channels.last_message_id,
        channels.last_message_date,
        channels.oldest_message_id,
        channels.oldest_message_date,
        channels.created_at,
        channels.updated_at,
        channel_metadata.about,
        channel_metadata.updated_at AS metadata_updated_at
      FROM channels
      LEFT JOIN channel_metadata ON channel_metadata.channel_id = channels.channel_id
      WHERE channels.channel_id = ?
    `).get(normalizedId);

    if (!row) {
      return null;
    }

    const syncEnabled = row.sync_enabled;
    const isForum = row.is_forum;
    return {
      channelId: row.channel_id,
      peerTitle: row.peer_title ?? null,
      peerType: row.peer_type ?? null,
      chatType: row.chat_type ?? null,
      isForum: typeof isForum === 'number' ? Boolean(isForum) : isForum ?? null,
      username: row.username ?? null,
      syncEnabled: typeof syncEnabled === 'number' ? Boolean(syncEnabled) : syncEnabled ?? null,
      lastMessageId: row.last_message_id ?? null,
      lastMessageDate: row.last_message_date ?? null,
      oldestMessageId: row.oldest_message_id ?? null,
      oldestMessageDate: row.oldest_message_date ?? null,
      about: row.about ?? null,
      metadataUpdatedAt: row.metadata_updated_at ?? null,
      createdAt: row.created_at ?? null,
      updatedAt: row.updated_at ?? null,
    };
  }

  listJobs(options = {}) {
    const status = options.status ? String(options.status) : null;
    const channelId = options.channelId ? normalizeChannelKey(options.channelId) : null;
    const limit = options.limit && options.limit > 0 ? Number(options.limit) : null;
    const clauses = [];
    const params = [];

    if (status) {
      clauses.push('jobs.status = ?');
      params.push(status);
    }

    if (channelId) {
      clauses.push('jobs.channel_id = ?');
      params.push(channelId);
    }

    const whereClause = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limitClause = limit ? 'LIMIT ?' : '';
    if (limit) {
      params.push(limit);
    }

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
      ${whereClause}
      ORDER BY jobs.updated_at DESC
      ${limitClause}
    `).all(...params);
  }

  getQueueStats() {
    const rows = this.db.prepare(`
      SELECT status, COUNT(*) AS count
      FROM jobs
      GROUP BY status
    `).all();
    const stats = {
      pending: 0,
      in_progress: 0,
      idle: 0,
      error: 0,
    };
    for (const row of rows) {
      if (row.status in stats) {
        stats[row.status] = row.count;
      }
    }
    return {
      processing: this.processing,
      ...stats,
    };
  }

  getSearchStatus() {
    const row = this.db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'message_search'
    `).get();
    const version = this.db.prepare(`
      SELECT value FROM search_meta WHERE key = 'search_index_version'
    `).get()?.value ?? null;
    return {
      enabled: Boolean(row?.name),
      version: version ? Number(version) : null,
    };
  }

  listArchivedMessages({ channelIds, topicId, fromDate, toDate, limit = 50 }) {
    const resolvedIds = Array.isArray(channelIds) ? channelIds : (channelIds ? [channelIds] : []);
    const normalizedIds = resolvedIds.map((id) => normalizeChannelKey(id)).filter(Boolean);
    const clauses = [];
    const params = [];

    if (normalizedIds.length) {
      clauses.push(`messages.channel_id IN (${normalizedIds.map(() => '?').join(', ')})`);
      params.push(...normalizedIds);
    }

    if (typeof topicId === 'number') {
      clauses.push('messages.topic_id = ?');
      params.push(topicId);
    }

    if (fromDate) {
      params.push(parseIsoDate(fromDate));
      clauses.push('messages.date >= ?');
    }

    if (toDate) {
      params.push(parseIsoDate(toDate));
      clauses.push('messages.date <= ?');
    }

    const whereClause = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const finalLimit = limit && limit > 0 ? Number(limit) : 50;
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
        users.display_name AS from_display_name,
        users.peer_type AS from_peer_type,
        users.is_bot AS from_is_bot,
        ${MEDIA_COLUMNS}
      FROM messages
      LEFT JOIN channels ON channels.channel_id = messages.channel_id
      LEFT JOIN users ON users.user_id = messages.from_id
      ${MEDIA_JOIN}
      ${whereClause}
      ORDER BY messages.date DESC
      LIMIT ?
    `).all(...params);

    return rows.map((row) => formatArchivedRow(row));
  }

  getArchivedMessage({ channelId, messageId }) {
    const normalizedId = normalizeChannelKey(channelId);
    const row = this.db.prepare(`
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
        users.display_name AS from_display_name,
        users.peer_type AS from_peer_type,
        users.is_bot AS from_is_bot,
        ${MEDIA_COLUMNS}
      FROM messages
      LEFT JOIN channels ON channels.channel_id = messages.channel_id
      LEFT JOIN users ON users.user_id = messages.from_id
      ${MEDIA_JOIN}
      WHERE messages.channel_id = ? AND messages.message_id = ?
    `).get(normalizedId, Number(messageId));

    if (!row) {
      return null;
    }

    return formatArchivedRow(row);
  }

  getArchivedMessageContext({ channelId, messageId, before = 20, after = 20 }) {
    const normalizedId = normalizeChannelKey(channelId);
    const target = this.getArchivedMessage({ channelId: normalizedId, messageId });
    if (!target) {
      return { target: null, before: [], after: [] };
    }

    const safeBefore = before && before > 0 ? Number(before) : 0;
    const safeAfter = after && after > 0 ? Number(after) : 0;

    const beforeRows = safeBefore > 0
      ? this.db.prepare(`
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
            users.display_name AS from_display_name,
            users.peer_type AS from_peer_type,
            users.is_bot AS from_is_bot,
            ${MEDIA_COLUMNS}
          FROM messages
          LEFT JOIN channels ON channels.channel_id = messages.channel_id
          LEFT JOIN users ON users.user_id = messages.from_id
          ${MEDIA_JOIN}
          WHERE messages.channel_id = ? AND messages.message_id < ?
          ORDER BY messages.message_id DESC
          LIMIT ?
        `).all(normalizedId, Number(messageId), safeBefore)
      : [];

    const afterRows = safeAfter > 0
      ? this.db.prepare(`
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
            users.display_name AS from_display_name,
            users.peer_type AS from_peer_type,
            users.is_bot AS from_is_bot,
            ${MEDIA_COLUMNS}
          FROM messages
          LEFT JOIN channels ON channels.channel_id = messages.channel_id
          LEFT JOIN users ON users.user_id = messages.from_id
          ${MEDIA_JOIN}
          WHERE messages.channel_id = ? AND messages.message_id > ?
          ORDER BY messages.message_id ASC
          LIMIT ?
        `).all(normalizedId, Number(messageId), safeAfter)
      : [];

    const beforeMessages = beforeRows.map((row) => formatArchivedRow(row)).reverse();
    const afterMessages = afterRows.map((row) => formatArchivedRow(row));

    return {
      target,
      before: beforeMessages,
      after: afterMessages,
    };
  }

  searchArchiveMessages(options = {}) {
    const queryText = typeof options.query === 'string' ? options.query.trim() : '';
    const regexText = typeof options.regex === 'string' ? options.regex.trim() : '';
    const tagList = Array.isArray(options.tags) ? options.tags : (options.tag ? [options.tag] : []);
    const normalizedTags = tagList.map((tag) => normalizeTag(tag)).filter(Boolean);
    const resolvedIds = Array.isArray(options.channelIds)
      ? options.channelIds
      : (options.channelIds ? [options.channelIds] : []);
    const normalizedIds = resolvedIds.map((id) => normalizeChannelKey(id)).filter(Boolean);
    const topicId = typeof options.topicId === 'number' ? options.topicId : null;
    const finalLimit = options.limit && options.limit > 0 ? Number(options.limit) : 100;
    const caseInsensitive = options.caseInsensitive !== false;

    let regex = null;
    if (regexText) {
      try {
        regex = new RegExp(regexText, caseInsensitive ? 'i' : '');
      } catch (error) {
        throw new Error(`Invalid regex: ${error.message}`);
      }
    }

    const clauses = [];
    const params = [];
    const joinTags = normalizedTags.length
      ? 'JOIN channel_tags ON channel_tags.channel_id = messages.channel_id'
      : '';

    if (normalizedTags.length) {
      clauses.push(`channel_tags.tag IN (${normalizedTags.map(() => '?').join(', ')})`);
      params.push(...normalizedTags);
    }

    if (normalizedIds.length) {
      clauses.push(`messages.channel_id IN (${normalizedIds.map(() => '?').join(', ')})`);
      params.push(...normalizedIds);
    }

    if (topicId !== null) {
      clauses.push('messages.topic_id = ?');
      params.push(topicId);
    }

    if (options.fromDate) {
      params.push(parseIsoDate(options.fromDate));
      clauses.push('messages.date >= ?');
    }

    if (options.toDate) {
      params.push(parseIsoDate(options.toDate));
      clauses.push('messages.date <= ?');
    }

    if (queryText) {
      clauses.push('message_search MATCH ?');
      params.push(queryText);
    }

    const whereClause = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const preLimit = regex ? Math.min(finalLimit * 5, 1000) : finalLimit;
    params.push(preLimit);

    const baseSelect = `
      SELECT DISTINCT
        messages.channel_id,
        channels.peer_title,
        channels.username,
        messages.message_id,
        messages.date,
        messages.from_id,
        messages.text,
        messages.topic_id,
        users.username AS from_username,
        users.display_name AS from_display_name,
        users.peer_type AS from_peer_type,
        users.is_bot AS from_is_bot,
        ${MEDIA_COLUMNS}
    `;

    const rows = queryText
      ? this.db.prepare(`
          ${baseSelect}
          FROM message_search
          JOIN messages ON messages.id = message_search.rowid
          ${joinTags}
          LEFT JOIN channels ON channels.channel_id = messages.channel_id
          LEFT JOIN users ON users.user_id = messages.from_id
          ${MEDIA_JOIN}
          ${whereClause}
          ORDER BY messages.date DESC
          LIMIT ?
        `).all(...params)
      : this.db.prepare(`
          ${baseSelect}
          FROM messages
          ${joinTags}
          LEFT JOIN channels ON channels.channel_id = messages.channel_id
          LEFT JOIN users ON users.user_id = messages.from_id
          ${MEDIA_JOIN}
          ${whereClause}
          ORDER BY messages.date DESC
          LIMIT ?
        `).all(...params);

    let results = rows.map((row) => formatArchivedRow(row));
    if (regex) {
      results = results.filter((row) => regex.test(row.text || ''));
    }

    return results.slice(0, finalLimit);
  }
}
