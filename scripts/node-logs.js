// Query EMQX logs in Loki for a specific node ID.
//
// Description:
//   Query EMQX logs in Loki for a specific Meshtastic node ID.
//
// Commands:
//   hubot node.logs clientid:<nodeid> [minutes:<n>] [limit:<n>] - Built-in command-bus form.

const DEFAULT_MINUTES = 15;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const QUERY_LIMIT_MULTIPLIER = 10;
const MAX_QUERY_LIMIT = 1000;
const REQUEST_TIMEOUT_MS = 10000;
const DEFAULT_CACHE_TTL_SECONDS = 30;
const NODE_ID_INPUT_PATTERN = /^!?([A-Fa-f0-9]{8})$/;
const LOGQL_ALLOWED_CLIENTID_REGEX =
  "^(MeshtasticPythonMqttProxy-[A-Za-z0-9!_-]+|MeshtasticAppleMqttProxy-!?[A-Za-z0-9_-]+|MeshtasticAndroidMqttProxy-!?[A-Za-z0-9_-]+|![A-Za-z0-9]+)$";

let redisClientPromise;
let redisUnavailable = false;
let redisWarningLogged = false;

function normalizeRequestedNodeId(value) {
  const trimmed = String(value ?? "").trim();
  const match = trimmed.match(NODE_ID_INPUT_PATTERN);
  if (!match) {
    throw new Error("clientid must be an 8-character lowercase hexadecimal value, optionally prefixed with !");
  }
  return match[1].toLowerCase();
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

function getRedisUrl() {
  return process.env.REDIS_URL || "redis://localhost:6379";
}

function cacheKeyFor({ nodeId, minutes, limit }) {
  return `hubot:node-logs:v1:${nodeId}:${minutes}:${limit}`;
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
            robot.logger.warn(`node.logs redis cache unavailable: ${error.message}`);
          }
        });
        return client.connect().then(() => client);
      })
      .catch((error) => {
        redisUnavailable = true;
        robot.logger.warn(`node.logs redis cache disabled: ${error.message}`);
        return null;
      });
  }

  try {
    return await redisClientPromise;
  } catch (error) {
    redisUnavailable = true;
    robot.logger.warn(`node.logs redis cache disabled: ${error.message}`);
    return null;
  }
}

async function getCachedReply({ robot, nodeId, minutes, limit }) {
  const ttlSeconds = getCacheTtlSeconds();
  if (ttlSeconds <= 0) {
    return null;
  }

  const client = await getRedisClient(robot);
  if (!client) {
    return null;
  }

  try {
    return await client.get(cacheKeyFor({ nodeId, minutes, limit }));
  } catch (error) {
    robot.logger.warn(`node.logs redis cache read failed: ${error.message}`);
    return null;
  }
}

async function setCachedReply({ robot, nodeId, minutes, limit, reply }) {
  const ttlSeconds = getCacheTtlSeconds();
  if (ttlSeconds <= 0) {
    return;
  }

  const client = await getRedisClient(robot);
  if (!client) {
    return;
  }

  try {
    await client.set(cacheKeyFor({ nodeId, minutes, limit }), reply, {
      EX: ttlSeconds,
    });
  } catch (error) {
    robot.logger.warn(`node.logs redis cache write failed: ${error.message}`);
  }
}

function buildReply(entries, requestedNodeId, minutes, limit) {
  const limitedEntries = entries.slice(0, limit);

  if (limitedEntries.length === 0) {
    return `Sorry, I couldn't find any logs for node ${requestedNodeId} in the last ${minutes} minutes.`;
  }

  const rendered = limitedEntries
    .map((entry) => formatEntry(entry.tsNanos, entry.line));

  const truncatedNote = entries.length > limit ? `, matched ${entries.length}` : "";
  const header = `node logs for ${requestedNodeId} (last ${minutes}m, showing ${rendered.length}${truncatedNote}${limit === MAX_LIMIT ? `, capped at max ${MAX_LIMIT}` : ""})`;
  return [header, ...rendered].join("\n");
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

function escapeLogqlString(value) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function nanosToIso(tsNanos) {
  try {
    const ms = Number(BigInt(tsNanos) / 1000000n);
    return new Date(ms).toISOString();
  } catch {
    return tsNanos;
  }
}

function parseLogLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return { msg: line };
  }
}

function formatEntry(tsNanos, line) {
  const parsed = parseLogLine(line);
  const isoTime = parsed.time ? new Date(parsed.time).toISOString() : nanosToIso(tsNanos);
  const level = parsed.level ?? "-";
  const clientId = parsed.clientid ?? "-";
  const action = parsed.action ?? "-";
  const topic = parsed.topic ?? "-";
  const msg = String(parsed.msg ?? line).replace(/\s+/g, " ").trim();

  return `${isoTime} | ${level} | ${clientId} | ${action} | ${topic} | ${msg}`;
}

function parseQueryRangeResult(payload) {
  if (payload?.status !== "success" || !payload?.data?.result) {
    return [];
  }

  const lines = [];
  for (const stream of payload.data.result) {
    for (const value of stream.values ?? []) {
      const tsNanos = value[0];
      const line = value[1];
      lines.push({ tsNanos, line });
    }
  }
  return lines;
}

async function queryLoki({ nodeId, minutes, limit, robot }) {
  const lokiBaseUrl = process.env.LOKI_URL || "http://loki:3100";
  const escapedAllowedRegex = escapeLogqlString(LOGQL_ALLOWED_CLIENTID_REGEX);
  const escapedNodeId = escapeLogqlString(nodeId);
  const query = `{compose_service="emqx"} | json | clientid=~"${escapedAllowedRegex}" | clientid=~".*${escapedNodeId}"`;

  const endNs = Date.now() * 1_000_000;
  const startNs = endNs - minutes * 60 * 1_000_000_000;

  const params = new URLSearchParams({
    query,
    start: String(startNs),
    end: String(endNs),
    limit: String(limit),
    direction: "BACKWARD",
  });

  const headers = {};
  if (process.env.LOKI_USERNAME && process.env.LOKI_PASSWORD) {
    const token = Buffer.from(`${process.env.LOKI_USERNAME}:${process.env.LOKI_PASSWORD}`).toString("base64");
    headers.Authorization = `Basic ${token}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${lokiBaseUrl}/loki/api/v1/query_range?${params.toString()}`, {
      method: "GET",
      headers,
      signal: controller.signal,
    });

    if (!response.ok) {
      const bodyText = await response.text();
      robot.logger.error(`Loki query failed: HTTP ${response.status} ${bodyText}`);
      throw new Error(`Loki query failed with HTTP ${response.status}`);
    }

    const payload = await response.json();
    return parseQueryRangeResult(payload);
  } finally {
    clearTimeout(timeout);
  }
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

      return executeNodeLogs({
        robot,
        clientIdInput: ctx.args.clientid,
        minutes,
        limit,
      });
    },
  });
};
