// Query EMQX logs in Loki for a specific node ID.
//
// Description:
//   Query EMQX logs in Loki for a specific Meshtastic node ID.
//
// Commands:
//   hubot node.logs clientid:<nodeid> [minutes:<n>] [limit:<n>] - Built-in command-bus form.

import { deliverPossiblyViaDm } from "./dm-delivery.js";
import { escapeLogqlString, parseLokiRangeLines, queryLokiRange } from "./lib/loki-query.js";
import { readCachedText, writeCachedText } from "./lib/redis-cache.js";
import { renderFixedWidthTable } from "./lib/fixed-width-table.js";

const DEFAULT_MINUTES = 15;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const QUERY_LIMIT_MULTIPLIER = 10;
const MAX_QUERY_LIMIT = 1000;
const REQUEST_TIMEOUT_MS = 10000;
const DEFAULT_CACHE_TTL_SECONDS = 30;
const NODE_ID_INPUT_PATTERN = /^!?([A-Fa-f0-9]{8})$/;
const DECIMAL_NODE_ID_INPUT_PATTERN = /^\d+$/;
const MAX_NODE_ID = 0xffffffffn;
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const LOGQL_ALLOWED_CLIENTID_REGEX =
  "^(MeshtasticPythonMqttProxy-[A-Za-z0-9!_-]+|MeshtasticAppleMqttProxy-!?[A-Za-z0-9_-]+|MeshtasticAndroidMqttProxy-!?[A-Za-z0-9_-]+|![A-Za-z0-9]+)$";

function normalizeRequestedNodeId(value) {
  const trimmed = String(value ?? "").trim();
  const match = trimmed.match(NODE_ID_INPUT_PATTERN);
  if (match) {
    return match[1].toLowerCase();
  }

  if (DECIMAL_NODE_ID_INPUT_PATTERN.test(trimmed)) {
    const parsed = BigInt(trimmed);
    if (parsed <= MAX_NODE_ID) {
      return parsed.toString(16).padStart(8, "0");
    }
  }

  throw new Error("clientid must be an 8-character lowercase hexadecimal value, optionally prefixed with !, or its unsigned decimal equivalent.");
}

function parsePositiveInt(value, fieldName) {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
  return parsed;
}

function getCacheTtlSeconds() {
  const raw = process.env.NODE_LOGS_CACHE_TTL_SECONDS;
  if (raw == null || raw === "") {
    return DEFAULT_CACHE_TTL_SECONDS;
  }
  if (raw === "0") {
    return 0;
  }
  return parsePositiveInt(raw, "NODE_LOGS_CACHE_TTL_SECONDS");
}

function cacheKeyFor({ nodeId, minutes, limit }) {
  return `hubot:node-logs:v1:${nodeId}:${minutes}:${limit}`;
}

async function getCachedReply({ robot, nodeId, minutes, limit }) {
  const ttlSeconds = getCacheTtlSeconds();
  return readCachedText({
    robot,
    cacheName: "node.logs",
    redisUrl: REDIS_URL,
    key: cacheKeyFor({ nodeId, minutes, limit }),
    ttlSeconds,
    logPrefix: "node.logs",
  });
}

async function setCachedReply({ robot, nodeId, minutes, limit, reply }) {
  const ttlSeconds = getCacheTtlSeconds();
  await writeCachedText({
    robot,
    cacheName: "node.logs",
    redisUrl: REDIS_URL,
    key: cacheKeyFor({ nodeId, minutes, limit }),
    ttlSeconds,
    text: reply,
    logPrefix: "node.logs",
  });
}

function buildReply(entries, requestedNodeId, minutes, limit) {
  const limitedEntries = entries.slice(0, limit);

  if (limitedEntries.length === 0) {
    return `Sorry, I couldn't find any logs for node ${requestedNodeId} in the last ${minutes} minutes.`;
  }

  const truncatedNote = entries.length > limit ? `, matched ${entries.length}` : "";
  const header = `node.logs for ${requestedNodeId} (last ${minutes}m, showing ${limitedEntries.length}${truncatedNote}${limit === MAX_LIMIT ? `, capped at max ${MAX_LIMIT}` : ""})`;
  const rows = limitedEntries.map((entry) => formatEntry(entry.tsNanos, entry.line));
  return `${header}\n\`\`\`text\n${renderTable(rows)}\n\`\`\``;
}

async function executeNodeLogs({ robot, clientIdInput, minutes, limit }) {
  const requestedNodeId = normalizeRequestedNodeId(clientIdInput);
  const cachedReply = await getCachedReply({
    robot,
    nodeId: requestedNodeId,
    minutes,
    limit,
  });
  if (cachedReply) {
    return cachedReply;
  }

  const queryLimit = Math.min(MAX_QUERY_LIMIT, Math.max(limit, limit * QUERY_LIMIT_MULTIPLIER));

  const entries = await queryLoki({
    nodeId: requestedNodeId,
    minutes,
    limit: queryLimit,
    robot,
  });

  const reply = buildReply(entries, requestedNodeId, minutes, limit);
  await setCachedReply({
    robot,
    nodeId: requestedNodeId,
    minutes,
    limit,
    reply,
  });
  return reply;
}

function nanosToIso(tsNanos) {
  try {
    const ms = Number(BigInt(tsNanos) / 1000000n);
    return new Date(ms).toISOString();
  } catch {
    return tsNanos;
  }
}

function normalizeEpochToIso(value) {
  const raw = String(value ?? "").trim();
  if (!/^\d+$/.test(raw)) {
    return null;
  }

  try {
    const epoch = BigInt(raw);
    let ms;

    if (raw.length >= 19) {
      ms = epoch / 1000000n;
    } else if (raw.length >= 16) {
      ms = epoch / 1000n;
    } else if (raw.length >= 13) {
      ms = epoch;
    } else {
      ms = epoch * 1000n;
    }

    return new Date(Number(ms)).toISOString();
  } catch {
    return null;
  }
}

function parseTimestampToIso(value, fallbackNanos) {
  if (value == null || value === "") {
    return nanosToIso(fallbackNanos);
  }

  if (typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value.trim()))) {
    return normalizeEpochToIso(value) ?? nanosToIso(fallbackNanos);
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return nanosToIso(fallbackNanos);
  }

  return parsed.toISOString();
}

function formatDisplayTimestamp(isoTime) {
  return isoTime.replace(".000Z", "Z").replace(/\.\d{3}Z$/, "Z").replace("T", " ");
}

function parseLogLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return { msg: line };
  }
}

function renderTable(rows) {
  const columns = [
    { key: "time", label: "time", width: 20 },
    { key: "level", label: "lvl", width: 5 },
    { key: "clientId", label: "client", width: 16 },
    { key: "action", label: "act", width: 7 },
    { key: "topic", label: "topic", width: 34 },
    { key: "msg", label: "msg", width: 48 },
  ];
  return renderFixedWidthTable(columns, rows);
}

function formatEntry(tsNanos, line) {
  const parsed = parseLogLine(line);
  const isoTime = parseTimestampToIso(parsed.time, tsNanos);
  return {
    time: formatDisplayTimestamp(isoTime),
    level: parsed.level ?? "-",
    clientId: parsed.clientid ?? "-",
    action: parsed.action ?? "-",
    topic: parsed.topic ?? "-",
    msg: parsed.msg ?? line,
  };
}

async function queryLoki({ nodeId, minutes, limit, robot }) {
  const escapedAllowedRegex = escapeLogqlString(LOGQL_ALLOWED_CLIENTID_REGEX);
  const escapedNodeId = escapeLogqlString(nodeId);
  const query = `{compose_service="emqx"} | json | clientid=~"${escapedAllowedRegex}" | clientid=~".*${escapedNodeId}"`;

  const endNs = Date.now() * 1_000_000;
  const startNs = endNs - minutes * 60 * 1_000_000_000;

  const payload = await queryLokiRange({
    robot,
    query,
    startNs,
    endNs,
    limit,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    logPrefix: "node.logs",
  });

  return parseLokiRangeLines(payload);
}

export default (robot) => {
  robot.commands.register({
    id: "node.logs",
    description: "Query the MQTT logs for a Meshtastic client ID",
    aliases: [
      "node logs",
      "show node logs",
      "logs for node",
    ],
    args: {
      clientid: { type: "string", required: true },
      minutes: { type: "number", required: false, default: DEFAULT_MINUTES },
      limit: { type: "number", required: false, default: DEFAULT_LIMIT },
    },
    confirm: "never",
    examples: [
      "node.logs clientid:a1b2c3d4",
      "node.logs clientid:!a1b2c3d4",
      "node.logs clientid:a1b2c3d4 minutes:30",
      "node.logs clientid:a1b2c3d4 minutes:30 limit:10",
      "node.logs --clientid a1b2c3d4",
      "node.logs --clientid a1b2c3d4 --minutes 30 --limit 10",
      "node.logs --help",
    ],
    handler: async (ctx) => {
      const minutes = ctx.args.minutes ? parsePositiveInt(String(ctx.args.minutes), "minutes") : DEFAULT_MINUTES;
      let limit = ctx.args.limit ? parsePositiveInt(String(ctx.args.limit), "limit") : DEFAULT_LIMIT;
      if (limit > MAX_LIMIT) {
        limit = MAX_LIMIT;
      }

      const reply = await executeNodeLogs({
        robot,
        clientIdInput: ctx.args.clientid,
        minutes,
        limit,
      });

      return deliverPossiblyViaDm({
        robot,
        ctx,
        text: reply,
        commandName: "node.logs",
      });
    },
  });
};
