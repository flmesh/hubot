// Trace Floodgate message events for a specific node ID.
//
// Description:
//   Query Floodgate message events in Loki for a specific Meshtastic node ID.
//
// Commands:
//   hubot node.trace from:<nodeid> [to:<nodeid>] [minutes:<n>] [limit:<n>] - Trace message events by sender.
//   hubot node.trace to:<nodeid> [from:<nodeid>] [minutes:<n>] [limit:<n>] - Trace message events by receiver.
//   hubot node.trace id:<messageid> [minutes:<n>] [limit:<n>] - Trace message events by Floodgate message ID.

import { deliverPossiblyViaDm } from "./dm-delivery.js";
import { escapeLogqlString, parseLokiRangeLines, queryLokiRange } from "./lib/loki-query.js";

const DEFAULT_MINUTES = 15;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const QUERY_LIMIT_MULTIPLIER = 20;
const MAX_QUERY_LIMIT = 5000;
const REQUEST_TIMEOUT_MS = 10000;
const DEFAULT_CACHE_TTL_SECONDS = 30;
const NODE_ID_INPUT_PATTERN = /^!?([A-Fa-f0-9]{8})$/;
const DECIMAL_NODE_ID_INPUT_PATTERN = /^\d+$/;
const BROADCAST_NODE_ID = "ffffffff";
const MAX_NODE_ID = 0xffffffffn;

let redisClientPromise;
let redisUnavailable = false;
let redisWarningLogged = false;

function normalizeRequestedNodeId(value) {
  const trimmed = String(value ?? "").trim();
  if (trimmed.toLowerCase() === "all" || trimmed.toLowerCase() === "!all") {
    return BROADCAST_NODE_ID;
  }
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

  throw new Error("node IDs must be 8-character lowercase hexadecimal values, optionally prefixed with !, their unsigned decimal equivalent, or 'all'.");
}

function normalizeNodeRef(value) {
  if (value == null) {
    return null;
  }

  const trimmed = String(value).trim();
  if (trimmed.toLowerCase() === "all" || trimmed.toLowerCase() === "!all") {
    return BROADCAST_NODE_ID;
  }
  const match = trimmed.match(/^!?([A-Fa-f0-9]{8})$/);
  if (match) {
    return match[1].toLowerCase();
  }
  if (DECIMAL_NODE_ID_INPUT_PATTERN.test(trimmed)) {
    const parsed = BigInt(trimmed);
    if (parsed <= MAX_NODE_ID) {
      return parsed.toString(16).padStart(8, "0");
    }
  }
  return null;
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
  const raw = process.env.NODE_TRACE_CACHE_TTL_SECONDS ?? process.env.NODE_LOGS_CACHE_TTL_SECONDS;
  if (raw == null || raw === "") {
    return DEFAULT_CACHE_TTL_SECONDS;
  }
  if (raw === "0") {
    return 0;
  }
  return parsePositiveInt(raw, "NODE_TRACE_CACHE_TTL_SECONDS");
}

function getRedisUrl() {
  return process.env.REDIS_URL || "redis://localhost:6379";
}

function cacheKeyFor({ fromNodeId, toNodeId, traceId, minutes, limit }) {
  return `hubot:node-trace:v3:from=${fromNodeId || "-"}:to=${toNodeId || "-"}:id=${traceId || "-"}:${minutes}:${limit}`;
}

async function getRedisClient(robot) {
  if (redisUnavailable) {
    return null;
  }

  if (!redisClientPromise) {
    redisClientPromise = import("redis")
      .then(({ createClient }) => {
        const client = createClient({ url: getRedisUrl() });
        client.on("error", (error) => {
          if (!redisWarningLogged) {
            redisWarningLogged = true;
            robot.logger.warn(`node.trace redis cache unavailable: ${error.message}`);
          }
        });
        return client.connect().then(() => client);
      })
      .catch((error) => {
        redisUnavailable = true;
        robot.logger.warn(`node.trace redis cache disabled: ${error.message}`);
        return null;
      });
  }

  try {
    return await redisClientPromise;
  } catch (error) {
    redisUnavailable = true;
    robot.logger.warn(`node.trace redis cache disabled: ${error.message}`);
    return null;
  }
}

async function getCachedReply({ robot, fromNodeId, toNodeId, traceId, minutes, limit }) {
  const ttlSeconds = getCacheTtlSeconds();
  if (ttlSeconds <= 0) {
    return null;
  }

  const client = await getRedisClient(robot);
  if (!client) {
    return null;
  }

  try {
    return await client.get(cacheKeyFor({ fromNodeId, toNodeId, traceId, minutes, limit }));
  } catch (error) {
    robot.logger.warn(`node.trace redis cache read failed: ${error.message}`);
    return null;
  }
}

async function setCachedReply({ robot, fromNodeId, toNodeId, traceId, minutes, limit, reply }) {
  const ttlSeconds = getCacheTtlSeconds();
  if (ttlSeconds <= 0) {
    return;
  }

  const client = await getRedisClient(robot);
  if (!client) {
    return;
  }

  try {
    await client.set(cacheKeyFor({ fromNodeId, toNodeId, traceId, minutes, limit }), reply, { EX: ttlSeconds });
  } catch (error) {
    robot.logger.warn(`node.trace redis cache write failed: ${error.message}`);
  }
}

function formatNodeRefForLogql(nodeId) {
  return `!${nodeId}`;
}

function nanosToIso(tsNanos) {
  try {
    const ms = Number(BigInt(tsNanos) / 1000000n);
    return new Date(ms).toISOString();
  } catch {
    return tsNanos;
  }
}

function formatDisplayTimestamp(isoTime) {
  return isoTime.replace(".000Z", "Z").replace(/\.\d{3}Z$/, "Z").replace("T", " ");
}

function parseLogLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return { message: line };
  }
}

function matchesNodeTrace(entry, fromNodeId, toNodeId, traceId) {
  const from = normalizeNodeRef(entry.from);
  const to = normalizeNodeRef(entry.to);

  if (traceId && String(entry.id ?? "").trim() !== traceId) {
    return false;
  }

  if (fromNodeId && from !== fromNodeId) {
    return false;
  }

  if (toNodeId && to !== toNodeId) {
    return false;
  }

  return true;
}

function normalizeTraceEntry(tsNanos, line) {
  const parsed = parseLogLine(line);
  return {
    isoTime: parsed.timestamp || nanosToIso(tsNanos),
    outcome: parsed.outcome ?? parsed.message ?? "-",
    id: parsed.id ?? "-",
    channel: parsed.channel ?? "-",
    from: parsed.from ?? "-",
    to: parsed.to ?? "-",
    hopLimit: parsed.hop_limit ?? "-",
    hopStart: parsed.hop_start ?? "-",
    topic: parsed.topic ?? "-",
    viaMqtt: parsed.via_mqtt ?? "-",
  };
}

function formatDisplayNodeRef(value) {
  const normalized = normalizeNodeRef(value);
  if (normalized === BROADCAST_NODE_ID) {
    return "all";
  }
  return value ?? "-";
}

function truncateCell(value, width) {
  const normalized = String(value ?? "-").replace(/\s+/g, " ").trim() || "-";
  if (normalized.length <= width) {
    return normalized;
  }
  if (width <= 1) {
    return normalized.slice(0, width);
  }
  return `${normalized.slice(0, width - 1)}…`;
}

function padCell(value, width) {
  return truncateCell(value, width).padEnd(width, " ");
}

function renderTable(rows, fromNodeId, toNodeId, traceId) {
  const columns = [
    { key: "time", label: "time", width: 20 },
    { key: "outcome", label: "out", width: 8 },
    { key: "channel", label: "ch", width: 9 },
  ];

  if (!traceId) {
    columns.push({ key: "id", label: "id", width: 10 });
  }

  if (!fromNodeId || toNodeId) {
    columns.push({ key: "from", label: "from", width: 10 });
  }

  if (!toNodeId || fromNodeId) {
    columns.push({ key: "to", label: "to", width: 10 });
  }

  columns.push(
    { key: "hops", label: "hop", width: 4 },
    { key: "viaMqtt", label: "mqtt", width: 4 },
    { key: "topic", label: "topic", width: 40 },
  );

  const header = columns.map((column) => padCell(column.label, column.width)).join(" ");
  const lines = rows.map((row) =>
    columns.map((column) => padCell(row[column.key], column.width)).join(" "),
  );

  return [header, ...lines].join("\n");
}

function formatTraceEntry(entry) {
  return {
    time: formatDisplayTimestamp(entry.isoTime),
    outcome: entry.outcome,
    id: entry.id,
    channel: entry.channel,
    from: formatDisplayNodeRef(entry.from),
    to: formatDisplayNodeRef(entry.to),
    hops: `${entry.hopLimit}/${entry.hopStart}`,
    viaMqtt: entry.viaMqtt === true || entry.viaMqtt === "true" ? "Y" : "N",
    topic: entry.topic,
  };
}

function describeFilters(fromNodeId, toNodeId, traceId) {
  if (traceId) {
    return `id ${traceId}`;
  }
  if (fromNodeId && toNodeId) {
    return `from ${formatDisplayNodeRef(fromNodeId)} to ${formatDisplayNodeRef(toNodeId)}`;
  }
  if (fromNodeId) {
    return `from ${formatDisplayNodeRef(fromNodeId)}`;
  }
  return `to ${formatDisplayNodeRef(toNodeId)}`;
}

function buildReply(entries, fromNodeId, toNodeId, traceId, minutes, limit) {
  const limitedEntries = entries.slice(0, limit);
  const filterLabel = describeFilters(fromNodeId, toNodeId, traceId);

  if (limitedEntries.length === 0) {
    return `Sorry, I couldn't find any Floodgate trace events ${filterLabel} in the last ${minutes} minutes.`;
  }

  const rendered = limitedEntries.map(formatTraceEntry);
  const truncatedNote = entries.length > limit ? `, matched ${entries.length}` : "";
  const header = `node.trace ${filterLabel} (last ${minutes}m, showing ${rendered.length}${truncatedNote}${limit === MAX_LIMIT ? `, capped at max ${MAX_LIMIT}` : ""})`;
  return `${header}\n\`\`\`text\n${renderTable(rendered, fromNodeId, toNodeId, traceId)}\n\`\`\``;
}

async function queryLoki({ fromNodeId, toNodeId, traceId, minutes, limit, robot }) {
  const structuredFilters = [];
  if (traceId) {
    structuredFilters.push(`| id="${escapeLogqlString(traceId)}"`);
  }
  if (fromNodeId) {
    structuredFilters.push(`| from="${escapeLogqlString(formatNodeRefForLogql(fromNodeId))}"`);
  }
  if (toNodeId) {
    structuredFilters.push(`| to="${escapeLogqlString(formatNodeRefForLogql(toNodeId))}"`);
  }

  const query = [
    `{compose_service="floodgate", event="message"}`,
    "| json",
    ...structuredFilters,
  ].join(" ");

  const endNs = Date.now() * 1_000_000;
  const startNs = endNs - minutes * 60 * 1_000_000_000;

  const payload = await queryLokiRange({
    robot,
    query,
    startNs,
    endNs,
    limit,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    logPrefix: "node.trace",
  });

  return parseLokiRangeLines(payload);
}

async function executeNodeTrace({ robot, fromInput, toInput, idInput, minutes, limit }) {
  const fromNodeId = fromInput ? normalizeRequestedNodeId(fromInput) : null;
  const toNodeId = toInput ? normalizeRequestedNodeId(toInput) : null;
  const traceId = idInput ? String(idInput).trim() : null;

  if (traceId && (fromNodeId || toNodeId)) {
    throw new Error("id:<messageid> cannot be combined with from:<nodeid> or to:<nodeid>.");
  }

  if (!fromNodeId && !toNodeId && !traceId) {
    throw new Error("Provide either id:<messageid> or at least one of from:<nodeid> or to:<nodeid>.");
  }

  const cachedReply = await getCachedReply({
    robot,
    fromNodeId,
    toNodeId,
    traceId,
    minutes,
    limit,
  });
  if (cachedReply) {
    return cachedReply;
  }

  const queryLimit = Math.min(MAX_QUERY_LIMIT, Math.max(limit, limit * QUERY_LIMIT_MULTIPLIER));
  const rawEntries = await queryLoki({
    fromNodeId,
    toNodeId,
    traceId,
    minutes,
    limit: queryLimit,
    robot,
  });

  const normalizedEntries = rawEntries
    .map((entry) => normalizeTraceEntry(entry.tsNanos, entry.line))
    .filter((entry) => matchesNodeTrace(entry, fromNodeId, toNodeId, traceId));

  const reply = buildReply(normalizedEntries, fromNodeId, toNodeId, traceId, minutes, limit);
  await setCachedReply({
    robot,
    fromNodeId,
    toNodeId,
    traceId,
    minutes,
    limit,
    reply,
  });
  return reply;
}

export default (robot) => {
  robot.commands.register({
    id: "node.trace",
    description: "Trace message events by from/to Meshtastic node IDs or message ID",
    aliases: [
      "node trace",
      "trace node",
    ],
    args: {
      from: { type: "string", required: false },
      to: { type: "string", required: false },
      id: { type: "string", required: false },
      minutes: { type: "number", required: false, default: DEFAULT_MINUTES },
      limit: { type: "number", required: false, default: DEFAULT_LIMIT },
    },
    confirm: "never",
    examples: [
      "node.trace from:a1b2c3d4",
      "node.trace to:!a1b2c3d4",
      "node.trace id:1234567890",
      "node.trace from:a1b2c3d4 to:9e9fba3c minutes:30",
      "node.trace from:a1b2c3d4 minutes:30 limit:10",
      "node.trace id:1234567890 minutes:30 limit:10",
      "node.trace --from a1b2c3d4 --to 9e9fba3c --minutes 30 --limit 10",
      "node.trace --id 1234567890 --minutes 30 --limit 10",
      "node.trace --help",
    ],
    handler: async (ctx) => {
      const minutes = ctx.args.minutes ? parsePositiveInt(String(ctx.args.minutes), "minutes") : DEFAULT_MINUTES;
      let limit = ctx.args.limit ? parsePositiveInt(String(ctx.args.limit), "limit") : DEFAULT_LIMIT;
      if (limit > MAX_LIMIT) {
        limit = MAX_LIMIT;
      }

      const reply = await executeNodeTrace({
        robot,
        fromInput: ctx.args.from,
        toInput: ctx.args.to,
        idInput: ctx.args.id,
        minutes,
        limit,
      });

      return deliverPossiblyViaDm({
        robot,
        ctx,
        text: reply,
        commandName: "node.trace",
      });
    },
  });
};
