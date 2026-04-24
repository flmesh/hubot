// Query Loki for AUTHZ denial tuples that would contribute to the hourly report.
//
// Description:
//   Queries Loki for authorization denial events over the hourly report lookback
//   window and returns unique clientid, username, and topic tuples.
//
// Commands:
//   hubot authz.report.details [clientid:<id>] [minutes:<n>] [limit:<n>]

import { deliverPossiblyViaDm } from "./dm-delivery.js";
import { renderFixedWidthTable } from "./lib/fixed-width-table.js";
import {
  AUTHZ_ADMIN_PERMISSIONS,
  DEFAULT_AUTHZ_LOOKBACK_MINUTES,
  buildAuthzDetailsQuery,
  parseAuthzDetailsRows,
  parsePositiveInt,
  queryLokiVector,
} from "./lib/authz-loki.js";

const REQUEST_TIMEOUT_MS = 15000;
const DEFAULT_LOOKBACK_MINUTES = DEFAULT_AUTHZ_LOOKBACK_MINUTES;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

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

async function queryLokiAuthzDetails({ robot, lookbackMinutes, clientId }) {
  const payload = await queryLokiVector({
    robot,
    query: buildAuthzDetailsQuery({ lookbackMinutes, clientId }),
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    logPrefix: "authz.report.details",
  });

  return parseAuthzDetailsRows(payload);
}

function renderTable(rows) {
  const columns = [
    { key: "clientId", label: "clientid", width: 40 },
    { key: "username", label: "username", width: 18 },
    { key: "topic", label: "topic", width: 64 },
    { key: "count", label: "count", width: 5 },
  ];
  return renderFixedWidthTable(columns, rows);
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