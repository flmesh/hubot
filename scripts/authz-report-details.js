// Query Loki for AUTHZ denial tuples that would contribute to the hourly report.
//
// Description:
//   Queries Loki for authorization denial events over the hourly report lookback
//   window and returns unique clientid, username, and topic tuples.
//
// Commands:
//   hubot authz.report.details [clientid:<id>] [minutes:<n>] [limit:<n>]

import { deliverPossiblyViaDm } from "./dm-delivery.js";

const REQUEST_TIMEOUT_MS = 15000;
const DEFAULT_LOOKBACK_MINUTES = 60;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const AUTHZ_ADMIN_PERMISSIONS = {
  roles: ["env:MQTT_ADMIN_ROLE_IDS"],
};

function parsePositiveInt(raw, fieldName) {
  if (!/^\d+$/.test(String(raw ?? ""))) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
  return parsed;
}

function parseLookbackMinutes(raw) {
  if (raw == null || raw === "") {
    return process.env.HUBOT_AUTHZ_REPORT_LOOKBACK_MINUTES
      ? parsePositiveInt(process.env.HUBOT_AUTHZ_REPORT_LOOKBACK_MINUTES, "HUBOT_AUTHZ_REPORT_LOOKBACK_MINUTES")
      : DEFAULT_LOOKBACK_MINUTES;
  }

  return parsePositiveInt(String(raw), "minutes");
}

function parseLimit(raw) {
  if (raw == null || raw === "") {
    return DEFAULT_LIMIT;
  }

  return Math.min(parsePositiveInt(String(raw), "limit"), MAX_LIMIT);
}

function normalizeClientId(raw) {
  const value = String(raw ?? "").trim();
  return value || null;
}

function escapeLogqlString(value) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function buildAuthzDetailsQuery({ lookbackMinutes, clientId }) {
  const filters = [
    '{compose_service="emqx", tag="AUTHZ"}',
    '| json',
    '| msg=~"authorization_permission_denied|cannot_publish_to_topic_due_to_not_authorized"',
    '| topic!=""',
    '| username!=""',
    '| clientid!=""',
  ];

  if (clientId) {
    filters.push(`| clientid="${escapeLogqlString(clientId)}"`);
  }

  return [
    'sum by (clientid, username, topic) (',
    'count_over_time(',
    ...filters,
    `[${lookbackMinutes}m]`,
    ')',
    ')',
  ].join(' ');
}

function parseVectorResult(payload) {
  if (payload?.status !== "success" || payload?.data?.resultType !== "vector") {
    return [];
  }

  const rows = [];
  for (const item of payload.data.result ?? []) {
    const clientId = String(item?.metric?.clientid ?? "").trim();
    const username = String(item?.metric?.username ?? "").trim();
    const topic = String(item?.metric?.topic ?? "").trim();
    const count = Number(item?.value?.[1] ?? 0);

    if (!clientId || !username || !topic || !Number.isFinite(count) || count <= 0) {
      continue;
    }

    rows.push({ clientId, username, topic, count });
  }

  rows.sort((left, right) => right.count - left.count || left.clientId.localeCompare(right.clientId) || left.username.localeCompare(right.username) || left.topic.localeCompare(right.topic));
  return rows;
}

async function queryLokiAuthzDetails({ robot, lookbackMinutes, clientId }) {
  const lokiBaseUrl = process.env.LOKI_URL || "http://loki:3100";
  const query = buildAuthzDetailsQuery({ lookbackMinutes, clientId });
  const queryTimeNs = Date.now() * 1_000_000;

  const params = new URLSearchParams({
    query,
    time: String(queryTimeNs),
  });

  const headers = {};
  if (process.env.LOKI_USERNAME && process.env.LOKI_PASSWORD) {
    const token = Buffer.from(`${process.env.LOKI_USERNAME}:${process.env.LOKI_PASSWORD}`).toString("base64");
    headers.Authorization = `Basic ${token}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${lokiBaseUrl}/loki/api/v1/query?${params.toString()}`, {
      method: "GET",
      headers,
      signal: controller.signal,
    });

    if (!response.ok) {
      const bodyText = await response.text();
      robot.logger.error(`authz.report.details Loki query failed: HTTP ${response.status} ${bodyText}`);
      throw new Error(`Loki query failed with HTTP ${response.status}`);
    }

    return parseVectorResult(await response.json());
  } finally {
    clearTimeout(timeout);
  }
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

function renderTable(rows) {
  const columns = [
    { key: "clientId", label: "clientid", width: 40 },
    { key: "username", label: "username", width: 18 },
    { key: "topic", label: "topic", width: 64 },
    { key: "count", label: "count", width: 5 },
  ];

  const header = columns.map((column) => padCell(column.label, column.width)).join(" ");
  const lines = rows.map((row) =>
    columns.map((column) => padCell(row[column.key], column.width)).join(" "),
  );

  return [header, ...lines].join("\n");
}

function buildReply({ rows, lookbackMinutes, clientId, limit }) {
  const limitedRows = rows.slice(0, limit);

  if (limitedRows.length === 0) {
    return clientId
      ? `No AUTHZ denial tuples found for client ${clientId} in the last ${lookbackMinutes} minutes.`
      : `No AUTHZ denial tuples found in the last ${lookbackMinutes} minutes.`;
  }

  const scopeLabel = clientId ? `client ${clientId}` : "all clients";
  const truncatedNote = rows.length > limit ? `, matched ${rows.length}` : "";
  const header = `authz.report.details for ${scopeLabel} (last ${lookbackMinutes}m, showing ${limitedRows.length}${truncatedNote}${limit === MAX_LIMIT ? `, capped at max ${MAX_LIMIT}` : ""})`;
  return `${header}\n\`\`\`text\n${renderTable(limitedRows)}\n\`\`\``;
}

async function executeAuthzReportDetails({ robot, clientId, lookbackMinutes, limit }) {
  const rows = await queryLokiAuthzDetails({
    robot,
    lookbackMinutes,
    clientId,
  });

  return buildReply({
    rows,
    lookbackMinutes,
    clientId,
    limit,
  });
}

export default (robot) => {
  robot.commands.register({
    id: "authz.report.details",
    description: "Show unique AUTHZ denial tuples for the hourly report window",
    aliases: [
      "authz report details",
      "authz report client",
    ],
    permissions: AUTHZ_ADMIN_PERMISSIONS,
    args: {
      clientid: { type: "string", required: false },
      minutes: { type: "number", required: false, default: DEFAULT_LOOKBACK_MINUTES },
      limit: { type: "number", required: false, default: DEFAULT_LIMIT },
    },
    confirm: "never",
    examples: [
      "authz.report.details",
      "authz.report.details clientid:MeshtasticPythonMqttProxy-a1b2c3d4",
      "authz.report.details minutes:30",
      "authz.report.details clientid:!a1b2c3d4 limit:10",
      "authz.report.details --help",
    ],
    handler: async (ctx) => {
      const reply = await executeAuthzReportDetails({
        robot,
        clientId: normalizeClientId(ctx.args.clientid),
        lookbackMinutes: parseLookbackMinutes(ctx.args.minutes),
        limit: parseLimit(ctx.args.limit),
      });

      return deliverPossiblyViaDm({
        robot,
        ctx,
        text: reply,
        commandName: "authz.report.details",
      });
    },
  });
};