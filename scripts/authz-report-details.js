// Query Loki for AUTHZ denial tuples that would contribute to the hourly report.
//
// Description:
//   Queries Loki for authorization denial events over the hourly report lookback
//   window and returns unique clientid, username, and topic tuples.
//
// Commands:
//   hubot authz.report.details [clientid:<id>] [minutes:<n>] [limit:<n>]

import { EmbedBuilder } from "discord.js";
import { deliverEmbedPossiblyViaDm } from "./dm-delivery.js";
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
const REPORT_COLOR = 0xdc2626;

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

function aggregateClientTopic(rows) {
  const byKey = new Map();
  for (const row of rows) {
    const key = `${row.clientId}\u0000${row.topic}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.count += row.count;
      continue;
    }

    byKey.set(key, {
      clientId: row.clientId,
      topic: row.topic,
      count: row.count,
    });
  }

  const items = Array.from(byKey.values());
  items.sort((left, right) => right.count - left.count
    || left.clientId.localeCompare(right.clientId)
    || left.topic.localeCompare(right.topic));
  return items;
}

function formatListLines(lines, fallback) {
  if (lines.length === 0) {
    return fallback;
  }

  let output = "";
  for (const line of lines) {
    if (`${output}${line}\n`.length > 1000) {
      break;
    }
    output += `${line}\n`;
  }

  return output.trim() || fallback;
}

function buildEmbed({ rows, lookbackMinutes, clientId, limit }) {
  const totalDenials = rows.reduce((sum, row) => sum + row.count, 0);
  const scope = clientId ? `client ${clientId}` : "all clients";

  const embed = new EmbedBuilder()
    .setColor(REPORT_COLOR)
    .setTitle("MQTT AUTHZ Denial Details")
    .setDescription(`Denied events for ${scope} in the last ${lookbackMinutes} minutes`)
    .addFields({ name: "Total Denials", value: String(totalDenials), inline: true })
    .setTimestamp(new Date());

  if (!clientId) {
    const clientTopicRows = aggregateClientTopic(rows);
    const limitedRows = clientTopicRows.slice(0, limit);
    const lines = limitedRows.map((row, index) => `${index + 1}. ${row.clientId} | ${row.topic}`);

    embed.addFields({
      name: "Unique Pairs",
      value: String(clientTopicRows.length),
      inline: true,
    });

    embed.addFields({
      name: `Top ${limit} clientid+topic pairs`,
      value: formatListLines(lines, "No AUTHZ denial tuples found in this window."),
      inline: false,
    });

    return embed;
  }

  const usernames = Array.from(new Set(rows.map((row) => row.username).filter(Boolean))).sort();
  const topics = new Map();
  for (const row of rows) {
    topics.set(row.topic, (topics.get(row.topic) ?? 0) + row.count);
  }

  const sortedTopics = Array.from(topics.entries())
    .map(([topic, count]) => ({ topic, count }))
    .sort((left, right) => right.count - left.count || left.topic.localeCompare(right.topic));
  const limitedTopics = sortedTopics.slice(0, limit);

  embed.addFields({
    name: "Unique Topics",
    value: String(sortedTopics.length),
    inline: true,
  });

  embed.addFields(
    { name: "Client", value: clientId, inline: true },
    { name: "Username", value: usernames.join(", ") || "unknown", inline: true },
    {
      name: `Topics (${limitedTopics.length}${sortedTopics.length > limit ? ` of ${sortedTopics.length}` : ""})`,
      value: formatListLines(
        limitedTopics.map((row, index) => `${index + 1}. ${row.topic}`),
        "No AUTHZ denial tuples found in this window.",
      ),
      inline: false,
    },
  );

  return embed;
}

async function executeAuthzReportDetails({ robot, clientId, lookbackMinutes, limit }) {
  const rows = await queryLokiAuthzDetails({
    robot,
    lookbackMinutes,
    clientId,
  });

  return buildEmbed({
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
      const embed = await executeAuthzReportDetails({
        robot,
        clientId: normalizeClientId(ctx.args.clientid),
        lookbackMinutes: parseLookbackMinutes(ctx.args.minutes),
        limit: parseLimit(ctx.args.limit),
      });

      return deliverEmbedPossiblyViaDm({
        robot,
        ctx,
        embed,
        commandName: "authz.report.details",
      });
    },
  });
};