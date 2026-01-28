import http from "http";
import { randomUUID } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import dotenv from "dotenv";
import { z } from "zod";

import TelegramClient from "./telegram-client.js";
import MessageSyncService from "./message-sync-service.js";

dotenv.config();

const HOST = process.env.MCP_HOST ?? process.env.FASTMCP_HOST ?? "127.0.0.1";
const PORT = Number(process.env.MCP_PORT ?? process.env.FASTMCP_PORT ?? "8080");

const telegramClient = new TelegramClient(
  process.env.TELEGRAM_API_ID,
  process.env.TELEGRAM_API_HASH,
  process.env.TELEGRAM_PHONE_NUMBER,
  "./data/session.json",
);

const messageSyncService = new MessageSyncService(telegramClient, {
  dbPath: "./data/messages.db",
  batchSize: 100,
  interJobDelayMs: 3000,
  interBatchDelayMs: 1200,
});

let telegramReady = false;

async function initializeTelegram() {
  if (telegramReady) return;

  console.log("[startup] Initializing Telegram dialogs...");
  const dialogsReady = await telegramClient.initializeDialogCache();

  if (!dialogsReady) {
    throw new Error("Failed to initialize Telegram dialog list");
  }

  const dialogCount = await messageSyncService.refreshChannelsFromDialogs();
  console.log(`[startup] Seeded ${dialogCount} dialogs into archive registry.`);
  messageSyncService.startRealtimeSync();
  messageSyncService.resumePendingJobs();
  telegramReady = true;
}

/**
 * Represents an active MCP session – a transport plus its server instance.
 */
const sessions = new Map();
let shuttingDown = false;

function closeSessionRecord(record, context) {
  if (!record || record.closing) {
    return null;
  }
  record.closing = true;
  if (record.sessionId) {
    sessions.delete(record.sessionId);
  }
  if (record.transport?.close) {
    return record.transport.close().catch((error) => {
      console.error(`[server] error closing ${context}: ${error.message}`);
    });
  }
  return null;
}

const listChannelsSchema = {
  limit: z.number().int().positive().optional().describe("Maximum number of channels to return (default: 50)"),
};

const searchChannelsSchema = {
  keywords: z
    .string()
    .min(1)
    .describe("Keywords to search for in channel titles or usernames"),
  limit: z.number().int().positive().optional().describe("Maximum number of results to return (default: 100)"),
};

const setChannelTagsSchema = {
  channelId: z
    .union([
      z.number({ invalid_type_error: "channelId must be a number" }),
      z.string({ invalid_type_error: "channelId must be a string" }).min(1),
    ])
    .describe("Numeric channel ID or username"),
  tags: z
    .array(z.string().min(1))
    .min(1)
    .describe("List of tags to attach to the channel"),
  source: z
    .string()
    .optional()
    .describe("Tag source label (default: manual)"),
};

const listChannelTagsSchema = {
  channelId: z
    .union([
      z.number({ invalid_type_error: "channelId must be a number" }),
      z.string({ invalid_type_error: "channelId must be a string" }).min(1),
    ])
    .describe("Numeric channel ID or username"),
  source: z
    .string()
    .optional()
    .describe("Optional tag source to filter by"),
};

const listTaggedChannelsSchema = {
  tag: z
    .string()
    .min(1)
    .describe("Tag label to look up"),
  source: z
    .string()
    .optional()
    .describe("Optional tag source to filter by"),
  limit: z.number().int().positive().optional().describe("Maximum number of channels to return (default: 100)"),
};

const refreshChannelMetadataSchema = {
  channelIds: z
    .array(
      z.union([
        z.number({ invalid_type_error: "channelId must be a number" }),
        z.string({ invalid_type_error: "channelId must be a string" }).min(1),
      ]),
    )
    .optional()
    .describe("Optional list of channel IDs/usernames to refresh"),
  limit: z.number().int().positive().optional().describe("Maximum number of channels to refresh (default: 20)"),
  force: z
    .boolean({ invalid_type_error: "force must be a boolean" })
    .optional()
    .describe("Refresh even if cached metadata is fresh"),
  onlyMissing: z
    .boolean({ invalid_type_error: "onlyMissing must be a boolean" })
    .optional()
    .describe("Refresh only channels without cached metadata"),
};

const getChannelMetadataSchema = {
  channelId: z
    .union([
      z.number({ invalid_type_error: "channelId must be a number" }),
      z.string({ invalid_type_error: "channelId must be a string" }).min(1),
    ])
    .describe("Numeric channel ID or username"),
};

const autoTagChannelsSchema = {
  channelIds: z
    .array(
      z.union([
        z.number({ invalid_type_error: "channelId must be a number" }),
        z.string({ invalid_type_error: "channelId must be a string" }).min(1),
      ]),
    )
    .optional()
    .describe("Optional list of channel IDs/usernames to tag"),
  limit: z.number().int().positive().optional().describe("Maximum number of channels to tag (default: 50)"),
  source: z
    .string()
    .optional()
    .describe("Tag source label (default: auto)"),
  refreshMetadata: z
    .boolean({ invalid_type_error: "refreshMetadata must be a boolean" })
    .optional()
    .describe("Refresh cached metadata before tagging (default true)"),
};

const getChannelMessagesSchema = {
  channelId: z
    .union([
      z.number({ invalid_type_error: "channelId must be a number" }),
      z.string({ invalid_type_error: "channelId must be a string" }).min(1),
    ])
    .describe("Numeric channel ID or username"),
  limit: z.number().int().positive().optional().describe("Maximum number of messages to return (default: 100)"),
  filterPattern: z
    .string()
    .optional()
    .describe("Optional regex to filter message content"),
};

const scheduleMessageSyncSchema = {
  channelId: z
    .union([
      z.number({ invalid_type_error: "channelId must be a number" }),
      z.string({ invalid_type_error: "channelId must be a string" }).min(1),
    ])
    .describe("Numeric channel ID or username"),
  depth: z
    .number({ invalid_type_error: "depth must be a number" })
    .int()
    .positive()
    .max(50000)
    .optional()
    .describe("Maximum messages to retain per channel (default 1000)"),
  minDate: z
    .string({ invalid_type_error: "minDate must be a string" })
    .min(1)
    .optional()
    .describe("Earliest ISO-8601 timestamp to backfill (optional)"),
};

const searchSyncedMessagesSchema = {
  channelId: z
    .union([
      z.number({ invalid_type_error: "channelId must be a number" }),
      z.string({ invalid_type_error: "channelId must be a string" }).min(1),
    ])
    .describe("Numeric channel ID or username"),
  pattern: z
    .string({ invalid_type_error: "pattern must be a string" })
    .min(1)
    .describe("Regular expression used to match message text"),
  limit: z
    .number({ invalid_type_error: "limit must be a number" })
    .int()
    .positive()
    .max(200)
    .optional()
    .describe("Maximum number of matches to return (default 50)"),
  caseInsensitive: z
    .boolean({ invalid_type_error: "caseInsensitive must be a boolean" })
    .optional()
    .describe("Whether the pattern should be case-insensitive (default true)"),
  topicId: z
    .number({ invalid_type_error: "topicId must be a number" })
    .int()
    .positive()
    .optional()
    .describe("Optional forum topic ID to constrain the search"),
};

const searchTaggedMessagesSchema = {
  tag: z
    .string({ invalid_type_error: "tag must be a string" })
    .min(1)
    .describe("Tag label to filter channels"),
  query: z
    .string({ invalid_type_error: "query must be a string" })
    .optional()
    .describe("FTS query string to match message text"),
  fromDate: z
    .string({ invalid_type_error: "fromDate must be a string" })
    .optional()
    .describe("ISO-8601 start date (inclusive)"),
  toDate: z
    .string({ invalid_type_error: "toDate must be a string" })
    .optional()
    .describe("ISO-8601 end date (inclusive)"),
  limit: z
    .number({ invalid_type_error: "limit must be a number" })
    .int()
    .positive()
    .max(500)
    .optional()
    .describe("Maximum number of results to return (default 100)"),
  source: z
    .string()
    .optional()
    .describe("Optional tag source to filter by"),
};

const scanTaggedMessagesSchema = {
  tag: z
    .string({ invalid_type_error: "tag must be a string" })
    .min(1)
    .describe("Tag label to scan"),
  query: z
    .string({ invalid_type_error: "query must be a string" })
    .optional()
    .describe("FTS query string to match message text"),
  fromDate: z
    .string({ invalid_type_error: "fromDate must be a string" })
    .optional()
    .describe("ISO-8601 start date (inclusive, default: now-30d)"),
  toDate: z
    .string({ invalid_type_error: "toDate must be a string" })
    .optional()
    .describe("ISO-8601 end date (inclusive)"),
  autoTag: z
    .boolean({ invalid_type_error: "autoTag must be a boolean" })
    .optional()
    .describe("Auto-tag channels before searching (default true)"),
  autoTagLimit: z
    .number({ invalid_type_error: "autoTagLimit must be a number" })
    .int()
    .positive()
    .optional()
    .describe("Maximum number of channels to auto-tag (default 50)"),
  channelIds: z
    .array(
      z.union([
        z.number({ invalid_type_error: "channelId must be a number" }),
        z.string({ invalid_type_error: "channelId must be a string" }).min(1),
      ]),
    )
    .optional()
    .describe("Optional list of channel IDs/usernames to auto-tag"),
  source: z
    .string()
    .optional()
    .describe("Tag source label (default auto)"),
  refreshMetadata: z
    .boolean({ invalid_type_error: "refreshMetadata must be a boolean" })
    .optional()
    .describe("Refresh cached metadata before tagging (default true)"),
  channelLimit: z
    .number({ invalid_type_error: "channelLimit must be a number" })
    .int()
    .positive()
    .optional()
    .describe("Maximum number of tagged channels to return (default 100)"),
  messageLimit: z
    .number({ invalid_type_error: "messageLimit must be a number" })
    .int()
    .positive()
    .max(500)
    .optional()
    .describe("Maximum number of messages to return (default 100)"),
};

const listChannelTopicsSchema = {
  channelId: z
    .union([
      z.number({ invalid_type_error: "channelId must be a number" }),
      z.string({ invalid_type_error: "channelId must be a string" }).min(1),
    ])
    .describe("Numeric channel ID or username"),
  limit: z.number().int().positive().optional().describe("Maximum number of topics to return (default: 100)"),
};

const searchChannelTopicsSchema = {
  channelId: z
    .union([
      z.number({ invalid_type_error: "channelId must be a number" }),
      z.string({ invalid_type_error: "channelId must be a string" }).min(1),
    ])
    .describe("Numeric channel ID or username"),
  query: z
    .string({ invalid_type_error: "query must be a string" })
    .min(1)
    .describe("Search query for forum topic titles"),
  limit: z.number().int().positive().optional().describe("Maximum number of topics to return (default: 100)"),
};

const getTopicMessagesSchema = {
  channelId: z
    .union([
      z.number({ invalid_type_error: "channelId must be a number" }),
      z.string({ invalid_type_error: "channelId must be a string" }).min(1),
    ])
    .describe("Numeric channel ID or username"),
  topicId: z
    .number({ invalid_type_error: "topicId must be a number" })
    .int()
    .positive()
    .describe("Forum topic ID"),
  limit: z.number().int().positive().optional().describe("Maximum number of messages to return (default: 50)"),
  filterPattern: z
    .string()
    .optional()
    .describe("Optional regex to filter message content"),
};

const getArchivedTopicMessagesSchema = {
  channelId: z
    .union([
      z.number({ invalid_type_error: "channelId must be a number" }),
      z.string({ invalid_type_error: "channelId must be a string" }).min(1),
    ])
    .describe("Numeric channel ID or username"),
  topicId: z
    .number({ invalid_type_error: "topicId must be a number" })
    .int()
    .positive()
    .describe("Forum topic ID"),
  limit: z.number().int().positive().optional().describe("Maximum number of messages to return (default: 50)"),
};

const messageSourceSchema = z
  .enum(["archive", "live", "both"])
  .optional()
  .describe("Message source (default: archive)");

const channelIdSchema = z.union([
  z.number({ invalid_type_error: "channelId must be a number" }),
  z.string({ invalid_type_error: "channelId must be a string" }).min(1),
]);

const messagesListSchema = {
  channelId: channelIdSchema.optional().describe("Optional numeric channel ID or username"),
  topicId: z
    .number({ invalid_type_error: "topicId must be a number" })
    .int()
    .positive()
    .optional()
    .describe("Optional forum topic ID"),
  source: messageSourceSchema,
  fromDate: z
    .string({ invalid_type_error: "fromDate must be a string" })
    .min(1)
    .optional()
    .describe("Earliest ISO-8601 timestamp to include (optional)"),
  toDate: z
    .string({ invalid_type_error: "toDate must be a string" })
    .min(1)
    .optional()
    .describe("Latest ISO-8601 timestamp to include (optional)"),
  limit: z.number().int().positive().optional().describe("Maximum number of messages to return (default: 50)"),
};

const messagesGetSchema = {
  channelId: channelIdSchema.describe("Numeric channel ID or username"),
  messageId: z
    .number({ invalid_type_error: "messageId must be a number" })
    .int()
    .positive()
    .describe("Message ID"),
  source: messageSourceSchema,
};

const messagesContextSchema = {
  channelId: channelIdSchema.describe("Numeric channel ID or username"),
  messageId: z
    .number({ invalid_type_error: "messageId must be a number" })
    .int()
    .positive()
    .describe("Message ID"),
  before: z
    .number({ invalid_type_error: "before must be a number" })
    .int()
    .min(0)
    .optional()
    .describe("Number of messages to include before the target (default: 20)"),
  after: z
    .number({ invalid_type_error: "after must be a number" })
    .int()
    .min(0)
    .optional()
    .describe("Number of messages to include after the target (default: 20)"),
  source: messageSourceSchema,
};

const messagesSearchSchema = {
  query: z.string().optional().describe("Optional full-text query (archive) or search text (live)"),
  regex: z.string().optional().describe("Optional regex filter for message text"),
  source: messageSourceSchema,
  channelIds: z
    .union([channelIdSchema, z.array(channelIdSchema).min(1)])
    .optional()
    .describe("Channel IDs or usernames to search (optional)"),
  channelId: channelIdSchema.optional().describe("Alias for channelIds"),
  tags: z.array(z.string().min(1)).optional().describe("Channel tags to filter by (optional)"),
  tag: z.string().optional().describe("Alias for tags"),
  topicId: z
    .number({ invalid_type_error: "topicId must be a number" })
    .int()
    .positive()
    .optional()
    .describe("Optional forum topic ID"),
  fromDate: z
    .string({ invalid_type_error: "fromDate must be a string" })
    .min(1)
    .optional()
    .describe("Earliest ISO-8601 timestamp to include (optional)"),
  toDate: z
    .string({ invalid_type_error: "toDate must be a string" })
    .min(1)
    .optional()
    .describe("Latest ISO-8601 timestamp to include (optional)"),
  limit: z.number().int().positive().optional().describe("Maximum number of matches to return (default: 100)"),
  caseInsensitive: z
    .boolean({ invalid_type_error: "caseInsensitive must be a boolean" })
    .optional()
    .describe("Whether regex matching should be case-insensitive (default: true)"),
};

const messagesSendSchema = {
  channelId: channelIdSchema.describe("Numeric channel ID or username"),
  text: z
    .string({ invalid_type_error: "text must be a string" })
    .min(1)
    .describe("Message text to send"),
  topicId: z
    .number({ invalid_type_error: "topicId must be a number" })
    .int()
    .positive()
    .optional()
    .describe("Optional forum topic ID to send into"),
  replyToMessageId: z
    .number({ invalid_type_error: "replyToMessageId must be a number" })
    .int()
    .positive()
    .optional()
    .describe("Optional message ID to reply to"),
};

const messagesSendFileSchema = {
  channelId: channelIdSchema.describe("Numeric channel ID or username"),
  filePath: z
    .string({ invalid_type_error: "filePath must be a string" })
    .min(1)
    .describe("Path to a local file to upload"),
  caption: z.string().optional().describe("Optional caption for the file"),
  filename: z.string().optional().describe("Override file name shown in Telegram"),
  topicId: z
    .number({ invalid_type_error: "topicId must be a number" })
    .int()
    .positive()
    .optional()
    .describe("Optional forum topic ID to send into"),
};

const mediaDownloadSchema = {
  channelId: channelIdSchema.describe("Numeric channel ID or username"),
  messageId: z
    .number({ invalid_type_error: "messageId must be a number" })
    .int()
    .positive()
    .describe("Message ID containing media"),
  outputPath: z
    .string()
    .min(1)
    .optional()
    .describe("Optional file path or directory for the download"),
};

function resolveSource(source) {
  const resolved = source ? String(source).toLowerCase() : "archive";
  if (!["archive", "live", "both"].includes(resolved)) {
    throw new Error(`Invalid source: ${source}`);
  }
  return resolved;
}

function resolveChannelIds(channelIds, channelId) {
  const resolved = [];
  if (Array.isArray(channelIds)) {
    resolved.push(...channelIds);
  } else if (channelIds) {
    resolved.push(channelIds);
  }
  if (channelId) {
    resolved.push(channelId);
  }
  const filtered = resolved.filter((id) => id !== null && id !== undefined && String(id).trim() !== "");
  return filtered.length ? filtered : null;
}

function parseDateMs(value, label) {
  if (!value) return null;
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) {
    throw new Error(`${label} must be a valid ISO-8601 string`);
  }
  return ts;
}

function filterLiveMessagesByDate(messages, fromDate, toDate) {
  const fromMs = parseDateMs(fromDate, "fromDate");
  const toMs = parseDateMs(toDate, "toDate");
  if (!fromMs && !toMs) {
    return messages;
  }
  return messages.filter((message) => {
    const ts = typeof message.date === "number" ? message.date * 1000 : null;
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
    fromIsBot: typeof message.from_is_bot === "boolean" ? message.from_is_bot : null,
    text: message.text ?? message.message ?? "",
    media: message.media ?? null,
    topicId: message.topic_id ?? null,
  };
}

function messageDateMs(message) {
  const ts = Date.parse(message.date ?? "");
  return Number.isNaN(ts) ? 0 : ts;
}

function mergeMessageSets(sets, limit) {
  const map = new Map();
  for (const list of sets) {
    for (const message of list) {
      const channelId = message.channelId ?? "";
      const messageId = message.messageId ?? message.id;
      const key = `${String(channelId)}:${String(messageId)}`;
      if (!map.has(key) || message.source === "live") {
        map.set(key, message);
      }
    }
  }
  const merged = Array.from(map.values());
  merged.sort((a, b) => messageDateMs(b) - messageDateMs(a));
  return limit && limit > 0 ? merged.slice(0, limit) : merged;
}

function createServerInstance() {
  const server = new McpServer({
    name: "example-mcp-server",
    version: "1.0.0",
  });

  server.tool(
    "listChannels",
    "Lists available Telegram dialogs for the authenticated account.",
    listChannelsSchema,
    async ({ limit }) => {
      await telegramClient.ensureLogin();
      const dialogs = await telegramClient.listDialogs(limit ?? 50);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(dialogs, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "searchChannels",
    "Searches dialogs by title or username.",
    searchChannelsSchema,
    async ({ keywords, limit }) => {
      await telegramClient.ensureLogin();
      const matches = await telegramClient.searchDialogs(keywords, limit ?? 100);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(matches, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "listActiveChannels",
    "Lists dialogs tracked in the local archive registry.",
    {},
    async () => {
      const channels = messageSyncService.listActiveChannels();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(channels, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "setChannelTags",
    "Assign tags to a channel for later cross-channel search.",
    setChannelTagsSchema,
    async ({ channelId, tags, source }) => {
      const finalTags = messageSyncService.setChannelTags(channelId, tags, { source });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ channelId, tags: finalTags }, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "listChannelTags",
    "List tags attached to a channel.",
    listChannelTagsSchema,
    async ({ channelId, source }) => {
      const tags = messageSyncService.listChannelTags(channelId, { source });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(tags, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "listTaggedChannels",
    "List channels that carry a specific tag.",
    listTaggedChannelsSchema,
    async ({ tag, source, limit }) => {
      const channels = messageSyncService.listTaggedChannels(tag, { source, limit });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(channels, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "refreshChannelMetadata",
    "Fetches and caches extended metadata for channels.",
    refreshChannelMetadataSchema,
    async ({ channelIds, limit, force, onlyMissing }) => {
      await telegramClient.ensureLogin();
      const results = await messageSyncService.refreshChannelMetadata({
        channelIds,
        limit,
        force,
        onlyMissing,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(results, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "getChannelMetadata",
    "Returns cached metadata for a channel.",
    getChannelMetadataSchema,
    async ({ channelId }) => {
      const metadata = messageSyncService.getChannelMetadata(channelId);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(metadata, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "autoTagChannels",
    "Auto-tags channels based on title, username, and cached metadata.",
    autoTagChannelsSchema,
    async ({ channelIds, limit, source, refreshMetadata }) => {
      await telegramClient.ensureLogin();
      const results = await messageSyncService.autoTagChannels({
        channelIds,
        limit,
        source,
        refreshMetadata,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(results, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "getChannelMessages",
    "Retrieves recent messages for a channel by numeric ID or username.",
    getChannelMessagesSchema,
    async ({ channelId, limit, filterPattern }) => {
      await telegramClient.ensureLogin();

      const { peerTitle, messages } = await telegramClient.getMessagesByChannelId(
        channelId,
        limit ?? 100,
      );

      let formatted = messages.map((msg) => ({
        id: msg.id,
        date: msg.date ? new Date(msg.date * 1000).toISOString() : "unknown",
        text: msg.text ?? msg.message ?? "",
        from_id: msg.from_id ?? "unknown",
        from_username: msg.from_username ?? null,
        from_display_name: msg.from_display_name ?? null,
        from_is_bot: typeof msg.from_is_bot === "boolean" ? msg.from_is_bot : null,
        topic_id: msg.topic_id ?? null,
      }));

      if (filterPattern) {
        try {
          const regex = new RegExp(filterPattern);
          formatted = formatted.filter((msg) => msg.text && regex.test(msg.text));
        } catch (error) {
          throw new Error(`Invalid filterPattern: ${error.message}`);
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                peerTitle,
                totalFetched: messages.length,
                returned: formatted.length,
                messages: formatted,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    "listChannelTopics",
    "Lists forum topics for a supergroup.",
    listChannelTopicsSchema,
    async ({ channelId, limit }) => {
      await telegramClient.ensureLogin();
      const topics = await telegramClient.listForumTopics(channelId, { limit: limit ?? 100 });
      messageSyncService.upsertTopics(channelId, topics);

      const formatted = topics.map((topic) => {
        let lastMessage = null;
        try {
          const msg = topic.lastMessage;
          lastMessage = {
            id: msg.id,
            date: msg.date ? msg.date.toISOString() : null,
            text: msg.text ?? msg.message ?? "",
          };
        } catch (error) {
          lastMessage = null;
        }

        return {
          id: topic.id,
          title: topic.title,
          date: topic.date ? topic.date.toISOString() : null,
          isClosed: topic.isClosed,
          isPinned: topic.isPinned,
          unreadCount: topic.unreadCount,
          lastMessage,
        };
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                total: topics.total ?? formatted.length,
                returned: formatted.length,
                topics: formatted,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    "searchChannelTopics",
    "Searches forum topics by title.",
    searchChannelTopicsSchema,
    async ({ channelId, query, limit }) => {
      await telegramClient.ensureLogin();
      const topics = await telegramClient.listForumTopics(channelId, { query, limit: limit ?? 100 });
      messageSyncService.upsertTopics(channelId, topics);

      const formatted = topics.map((topic) => ({
        id: topic.id,
        title: topic.title,
        date: topic.date ? topic.date.toISOString() : null,
        isClosed: topic.isClosed,
        isPinned: topic.isPinned,
        unreadCount: topic.unreadCount,
      }));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                total: topics.total ?? formatted.length,
                returned: formatted.length,
                topics: formatted,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    "getTopicMessages",
    "Retrieves recent messages for a forum topic by topic ID.",
    getTopicMessagesSchema,
    async ({ channelId, topicId, limit, filterPattern }) => {
      await telegramClient.ensureLogin();
      const { messages, total } = await telegramClient.getTopicMessages(
        channelId,
        topicId,
        limit ?? 50,
      );

      let formatted = messages.map((msg) => ({
        id: msg.id,
        date: msg.date ? new Date(msg.date * 1000).toISOString() : "unknown",
        text: msg.text ?? msg.message ?? "",
        from_id: msg.from_id ?? "unknown",
        from_username: msg.from_username ?? null,
        from_display_name: msg.from_display_name ?? null,
        from_is_bot: typeof msg.from_is_bot === "boolean" ? msg.from_is_bot : null,
        topic_id: msg.topic_id ?? null,
      }));

      if (filterPattern) {
        try {
          const regex = new RegExp(filterPattern);
          formatted = formatted.filter((msg) => msg.text && regex.test(msg.text));
        } catch (error) {
          throw new Error(`Invalid filterPattern: ${error.message}`);
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                total,
                returned: formatted.length,
                messages: formatted,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    "messagesList",
    "Lists messages from the archive or live Telegram API.",
    messagesListSchema,
    async ({ channelId, topicId, source, fromDate, toDate, limit }) => {
      const resolvedSource = resolveSource(source);
      const finalLimit = limit ?? 50;
      const sets = [];

      if (resolvedSource === "archive" || resolvedSource === "both") {
        const archived = messageSyncService.listArchivedMessages({
          channelIds: channelId ? [channelId] : null,
          topicId,
          fromDate,
          toDate,
          limit: finalLimit,
        });
        sets.push(archived.map((message) => ({ ...message, source: "archive" })));
      }

      if (resolvedSource === "live" || resolvedSource === "both") {
        if (!channelId) {
          throw new Error("channelId is required for live source.");
        }
        await telegramClient.ensureLogin();
        const channelMeta = messageSyncService.getChannelMetadata(channelId);
        let peerTitle = channelMeta?.peerTitle ?? null;
        let username = channelMeta?.username ?? null;
        let peerId = channelMeta?.channelId ?? String(channelId);
        let liveMessages = [];

        if (topicId) {
          const results = await telegramClient.getTopicMessages(channelId, topicId, finalLimit);
          liveMessages = results.messages;
          if (!peerTitle || !username) {
            const meta = await telegramClient.getPeerMetadata(channelId);
            peerTitle = peerTitle ?? meta?.peerTitle ?? null;
            username = username ?? meta?.username ?? null;
          }
        } else {
          const results = await telegramClient.getMessagesByChannelId(channelId, finalLimit);
          liveMessages = results.messages;
          peerTitle = peerTitle ?? results.peerTitle ?? null;
          peerId = results.peerId ?? peerId;
        }

        const filtered = filterLiveMessagesByDate(liveMessages, fromDate, toDate);
        const formatted = filtered.map((message) => ({
          ...formatLiveMessage(message, { channelId: peerId, peerTitle, username }),
          source: "live",
        }));
        sets.push(formatted);
      }

      const messages = resolvedSource === "both"
        ? mergeMessageSets(sets, finalLimit)
        : (sets[0] ?? []);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                source: resolvedSource,
                returned: messages.length,
                messages,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    "messagesGet",
    "Fetches a specific message from the archive or live Telegram API.",
    messagesGetSchema,
    async ({ channelId, messageId, source }) => {
      const resolvedSource = resolveSource(source);
      const channelMeta = messageSyncService.getChannelMetadata(channelId);
      let message = null;
      let resolvedFrom = null;

      if (resolvedSource === "live" || resolvedSource === "both") {
        await telegramClient.ensureLogin();
        const live = await telegramClient.getMessageById(channelId, messageId);
        if (live) {
          let peerTitle = channelMeta?.peerTitle ?? null;
          let username = channelMeta?.username ?? null;
          if (!peerTitle || !username) {
            const meta = await telegramClient.getPeerMetadata(channelId);
            peerTitle = peerTitle ?? meta?.peerTitle ?? null;
            username = username ?? meta?.username ?? null;
          }
          message = {
            ...formatLiveMessage(live, { channelId: String(channelId), peerTitle, username }),
            source: "live",
          };
          resolvedFrom = "live";
        }
      }

      if (!message && (resolvedSource === "archive" || resolvedSource === "both")) {
        const archived = messageSyncService.getArchivedMessage({ channelId, messageId });
        if (archived) {
          message = { ...archived, source: "archive" };
          resolvedFrom = "archive";
        }
      }

      if (!message) {
        throw new Error("Message not found.");
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                source: resolvedFrom ?? resolvedSource,
                message,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    "messagesContext",
    "Returns surrounding messages for a target message.",
    messagesContextSchema,
    async ({ channelId, messageId, before, after, source }) => {
      const resolvedSource = resolveSource(source);
      const safeBefore = Number.isFinite(before) ? before : 20;
      const safeAfter = Number.isFinite(after) ? after : 20;
      const channelMeta = messageSyncService.getChannelMetadata(channelId);
      let context = null;
      let resolvedFrom = null;

      if (resolvedSource === "live" || resolvedSource === "both") {
        await telegramClient.ensureLogin();
        const liveContext = await telegramClient.getMessageContext(channelId, messageId, {
          before: safeBefore,
          after: safeAfter,
        });
        if (liveContext.target) {
          let peerTitle = channelMeta?.peerTitle ?? null;
          let username = channelMeta?.username ?? null;
          if (!peerTitle || !username) {
            const meta = await telegramClient.getPeerMetadata(channelId);
            peerTitle = peerTitle ?? meta?.peerTitle ?? null;
            username = username ?? meta?.username ?? null;
          }
          context = {
            target: {
              ...formatLiveMessage(liveContext.target, { channelId: String(channelId), peerTitle, username }),
              source: "live",
            },
            before: liveContext.before.map((message) => ({
              ...formatLiveMessage(message, { channelId: String(channelId), peerTitle, username }),
              source: "live",
            })),
            after: liveContext.after.map((message) => ({
              ...formatLiveMessage(message, { channelId: String(channelId), peerTitle, username }),
              source: "live",
            })),
          };
          resolvedFrom = "live";
        }
      }

      if (!context && (resolvedSource === "archive" || resolvedSource === "both")) {
        const archiveContext = messageSyncService.getArchivedMessageContext({
          channelId,
          messageId,
          before: safeBefore,
          after: safeAfter,
        });
        if (archiveContext.target) {
          context = {
            target: { ...archiveContext.target, source: "archive" },
            before: archiveContext.before.map((message) => ({ ...message, source: "archive" })),
            after: archiveContext.after.map((message) => ({ ...message, source: "archive" })),
          };
          resolvedFrom = "archive";
        }
      }

      if (!context) {
        throw new Error("Message not found.");
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                source: resolvedFrom ?? resolvedSource,
                ...context,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    "messagesSearch",
    "Searches messages across the archive or live Telegram API.",
    messagesSearchSchema,
    async ({
      query,
      regex,
      source,
      channelIds,
      channelId,
      tags,
      tag,
      topicId,
      fromDate,
      toDate,
      limit,
      caseInsensitive,
    }) => {
      const resolvedSource = resolveSource(source);
      const finalLimit = limit ?? 100;
      const resolvedTags = Array.isArray(tags) ? tags : (tag ? [tag] : null);
      const resolvedChannelIds = resolveChannelIds(channelIds, channelId);

      if (!query && !regex && (!resolvedTags || resolvedTags.length === 0)) {
        throw new Error("Provide query, regex, or tags for messagesSearch.");
      }

      const sets = [];

      if (resolvedSource === "archive" || resolvedSource === "both") {
        const archived = messageSyncService.searchArchiveMessages({
          query,
          regex,
          tags: resolvedTags,
          channelIds: resolvedChannelIds,
          topicId,
          fromDate,
          toDate,
          limit: finalLimit,
          caseInsensitive,
        });
        sets.push(archived.map((message) => ({ ...message, source: "archive" })));
      }

      if (resolvedSource === "live" || resolvedSource === "both") {
        let liveChannelIds = resolvedChannelIds;
        if ((!liveChannelIds || liveChannelIds.length === 0) && resolvedTags?.length) {
          const tagged = new Map();
          for (const tagValue of resolvedTags) {
            const channels = messageSyncService.listTaggedChannels(tagValue, { limit: 200 });
            for (const channel of channels) {
              tagged.set(channel.channelId, channel);
            }
          }
          liveChannelIds = Array.from(tagged.keys());
        }

        if (!liveChannelIds || liveChannelIds.length === 0) {
          throw new Error("channelIds are required for live search.");
        }

        let liveRegex = null;
        if (regex) {
          try {
            liveRegex = new RegExp(regex, caseInsensitive === false ? "" : "i");
          } catch (error) {
            throw new Error(`Invalid regex: ${error.message}`);
          }
        }

        await telegramClient.ensureLogin();
        const liveResults = [];

        for (const id of liveChannelIds) {
          const channelMeta = messageSyncService.getChannelMetadata(id);
          let peerTitle = channelMeta?.peerTitle ?? null;
          let username = channelMeta?.username ?? null;
          let liveMessages = [];

          if (query) {
            const results = await telegramClient.searchChannelMessages(id, {
              query,
              limit: finalLimit,
              topicId,
            });
            liveMessages = results.messages;
            peerTitle = peerTitle ?? results.peerTitle ?? null;
          } else if (topicId) {
            const results = await telegramClient.getTopicMessages(id, topicId, finalLimit);
            liveMessages = results.messages;
          } else {
            const results = await telegramClient.getMessagesByChannelId(id, finalLimit);
            liveMessages = results.messages;
            peerTitle = peerTitle ?? results.peerTitle ?? null;
          }

          if (!peerTitle || !username) {
            const meta = await telegramClient.getPeerMetadata(id);
            peerTitle = peerTitle ?? meta?.peerTitle ?? null;
            username = username ?? meta?.username ?? null;
          }

          let filtered = filterLiveMessagesByDate(liveMessages, fromDate, toDate);
          if (liveRegex) {
            filtered = filtered.filter((message) =>
              liveRegex.test(message.text ?? message.message ?? ""),
            );
          }

          const formatted = filtered.map((message) => ({
            ...formatLiveMessage(message, { channelId: String(id), peerTitle, username }),
            source: "live",
          }));
          liveResults.push(...formatted);
        }

        sets.push(liveResults);
      }

      const messages = resolvedSource === "both"
        ? mergeMessageSets(sets, finalLimit)
        : (sets[0] ?? []);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                source: resolvedSource,
                returned: messages.length,
                messages,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    "messagesSend",
    "Sends a text message to a channel or chat.",
    messagesSendSchema,
    async ({ channelId, text, topicId, replyToMessageId }) => {
      await telegramClient.ensureLogin();
      const result = await telegramClient.sendTextMessage(channelId, text, {
        topicId,
        replyToMessageId,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ channelId, ...result }, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "messagesSendFile",
    "Sends a file with an optional caption.",
    messagesSendFileSchema,
    async ({ channelId, filePath, caption, filename, topicId }) => {
      await telegramClient.ensureLogin();
      const result = await telegramClient.sendFileMessage(channelId, filePath, {
        caption,
        filename,
        topicId,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ channelId, ...result }, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "mediaDownload",
    "Downloads media from a message to a local file.",
    mediaDownloadSchema,
    async ({ channelId, messageId, outputPath }) => {
      await telegramClient.ensureLogin();
      const result = await telegramClient.downloadMessageMedia(channelId, messageId, {
        outputPath,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "scheduleMessageSync",
    "Schedules a background job to archive channel messages locally.",
    scheduleMessageSyncSchema,
    async ({ channelId, depth, minDate }) => {
      await telegramClient.ensureLogin();
      const job = messageSyncService.addJob(channelId, { depth, minDate });
      void messageSyncService.processQueue();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(job, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "searchSyncedMessages",
    "Searches stored messages for a channel using a regular expression.",
    searchSyncedMessagesSchema,
    async ({ channelId, pattern, limit, caseInsensitive, topicId }) => {
      const results = messageSyncService.searchMessages({
        channelId,
        topicId,
        pattern,
        limit,
        caseInsensitive,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(results, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "searchTaggedMessages",
    "Search archived messages across channels that share a tag.",
    searchTaggedMessagesSchema,
    async ({ tag, query, fromDate, toDate, limit, source }) => {
      const results = messageSyncService.searchTaggedMessages({
        tag,
        query,
        fromDate,
        toDate,
        limit,
        source,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(results, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "scanTaggedMessages",
    "Auto-tags channels (optional) and searches archived messages across tagged channels.",
    scanTaggedMessagesSchema,
    async ({
      tag,
      query,
      fromDate,
      toDate,
      autoTag,
      autoTagLimit,
      channelIds,
      source,
      refreshMetadata,
      channelLimit,
      messageLimit,
    }) => {
      const shouldAutoTag = autoTag !== false;
      if (shouldAutoTag) {
        await telegramClient.ensureLogin();
      }
      const resolvedFromDate = fromDate ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

      const results = await messageSyncService.scanTaggedMessages({
        tag,
        query,
        fromDate: resolvedFromDate,
        toDate,
        autoTag: shouldAutoTag,
        autoTagLimit,
        channelIds,
        source,
        refreshMetadata,
        channelLimit,
        messageLimit,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(results, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "getArchivedTopicMessages",
    "Returns stored messages for a forum topic from the local archive.",
    getArchivedTopicMessagesSchema,
    async ({ channelId, topicId, limit }) => {
      const results = messageSyncService.getArchivedMessages({
        channelId,
        topicId,
        limit: limit ?? 50,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(results, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "getSyncedMessageStats",
    "Returns summary statistics for stored messages in a channel.",
    {
      channelId: z
        .union([
          z.number({ invalid_type_error: "channelId must be a number" }),
          z.string({ invalid_type_error: "channelId must be a string" }).min(1),
        ])
        .describe("Numeric channel ID or username"),
    },
    async ({ channelId }) => {
      const stats = messageSyncService.getMessageStats(channelId);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(stats, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "listMessageSyncJobs",
    "Lists tracked message sync jobs and their current status.",
    {},
    async () => {
      const jobs = messageSyncService.listJobs();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(jobs, null, 2),
          },
        ],
      };
    },
  );

  return server;
}

async function ensureSession(req, res, body) {
  if (shuttingDown) {
    res.writeHead(503, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Server is shutting down",
        },
        id: null,
      }),
    );
    return null;
  }

  const sessionId = req.headers["mcp-session-id"];

  if (sessionId && typeof sessionId === "string") {
    const existing = sessions.get(sessionId);
    if (existing) {
      return existing;
    }

    res.writeHead(404, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32001,
          message: "Session not found",
        },
        id: null,
      }),
    );
    return null;
  }

  if (!isInitializeRequest(body)) {
    res.writeHead(400, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Bad Request: No valid session ID provided",
        },
        id: null,
      }),
    );
    return null;
  }

  const record = { server: null, transport: null, sessionId: null };

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sessionId) => {
      record.sessionId = sessionId;
      sessions.set(sessionId, record);
    },
    onsessionclosed: (sessionId) => {
      const existing = sessions.get(sessionId);
      if (existing) {
        existing.closing = true;
        sessions.delete(sessionId);
      }
    },
  });

  record.transport = transport;

  transport.onerror = (error) => {
    console.error(`[transport] error: ${error.message}`);
  };

  transport.onclose = () => {
    if (record.sessionId) {
      sessions.delete(record.sessionId);
    }
  };

  const serverInstance = createServerInstance();
  record.server = serverInstance;

  await serverInstance.connect(transport);

  return record;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req
      .on("data", (chunk) => chunks.push(chunk))
      .on("end", () => {
        try {
          const raw = Buffer.concat(chunks).toString("utf8");
          resolve(raw.length ? JSON.parse(raw) : {});
        } catch (error) {
          reject(error);
        }
      })
      .on("error", (error) => reject(error));
  });
}

async function handlePost(req, res) {
  const body = await readBody(req);
  const sessionRecord = await ensureSession(req, res, body);
  if (!sessionRecord) {
    return;
  }

  try {
    await sessionRecord.transport.handleRequest(req, res, body);
  } catch (error) {
    console.error(`[http] POST handling failed: ${error?.message ?? error}`);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: "Internal server error",
          },
          id: null,
        }),
      );
    }
  }
}

async function handleSessionRequest(req, res) {
  if (shuttingDown) {
    res.writeHead(503, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Server is shutting down",
        },
        id: null,
      }),
    );
    return;
  }

  const sessionIdHeader = req.headers["mcp-session-id"];
  if (!sessionIdHeader || typeof sessionIdHeader !== "string") {
    res.writeHead(400, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Invalid or missing session ID",
        },
        id: null,
      }),
    );
    return;
  }

  const record = sessions.get(sessionIdHeader);
  if (!record) {
    res.writeHead(404, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32001,
          message: "Session not found",
        },
        id: null,
      }),
    );
    return;
  }

  await record.transport.handleRequest(req, res);
}

await initializeTelegram().catch((error) => {
  console.error(`[startup] Telegram initialization failed: ${error?.message ?? error}`);
  process.exit(1);
});

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "", `http://${req.headers.host ?? `${HOST}:${PORT}`}`);

    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({ status: "ok" }),
      );
      return;
    }

    if (req.method === "POST" && url.pathname === "/mcp") {
      await handlePost(req, res);
      return;
    }

    if ((req.method === "GET" || req.method === "DELETE") && url.pathname === "/mcp") {
      await handleSessionRequest(req, res);
      return;
    }

    if (req.method === "POST") {
      res.writeHead(404, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32601,
            message: "Endpoint not found",
          },
          id: null,
        }),
      );
      return;
    }

    res.writeHead(405, { Allow: "GET, POST, DELETE" }).end();
  } catch (error) {
    console.error(`[http] unexpected error: ${error?.message ?? error}`);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: "Internal server error",
          },
          id: null,
        }),
      );
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[startup] MCP HTTP server listening on http://${HOST}:${PORT}/mcp`);
});

server.on("error", (error) => {
  console.error(`[http] server error: ${error.message}`);
});

async function shutdown() {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log("[shutdown] received termination signal, closing resources...");
  const closeTasks = [];
  for (const record of sessions.values()) {
    const task = closeSessionRecord(record, "shutdown");
    if (task) {
      closeTasks.push(task);
    }
  }
  if (closeTasks.length) {
    await Promise.allSettled(closeTasks);
  }
  server.closeAllConnections?.();
  server.close(() => {
    console.log("[shutdown] HTTP server closed");
  });

  try {
    await messageSyncService.shutdown();
  } catch (error) {
    console.error(`[shutdown] error while stopping message sync: ${error?.message ?? error}`);
  }

  try {
    await telegramClient.destroy();
  } catch (error) {
    console.error(`[shutdown] error while closing Telegram client: ${error?.message ?? error}`);
  }
}

process.on("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});

process.on("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});
