// Post periodic AUTHZ denial summaries from Loki to a Discord channel.
//
// Description:
//   Runs on a wall-clock minute boundary (top or bottom of the hour by default),
//   queries Loki for authorization_permission_denied events, and posts a summary embed.
//
// Commands:
//   hubot authz.report.now - Run the report immediately.

import { EmbedBuilder } from "discord.js";
import {
  AUTHZ_ADMIN_PERMISSIONS,
  DEFAULT_AUTHZ_LOOKBACK_MINUTES,
  buildAuthzSummaryQuery,
  parseAuthzSummaryRows,
  parsePositiveInt,
  queryLokiVector,
} from "./lib/authz-loki.js";

const REQUEST_TIMEOUT_MS = 15000;
const DEFAULT_LOOKBACK_MINUTES = DEFAULT_AUTHZ_LOOKBACK_MINUTES;
const DEFAULT_TOP_LIMIT = 10;
const DEFAULT_RUN_MINUTE = 0;
const DEFAULT_SEND_EMPTY = false;
const REPORT_COLOR = 0xdc2626;

function parseBoolean(raw, defaultValue = false) {
  if (raw == null || raw === "") {
    return defaultValue;
  }
  const normalized = String(raw).trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(normalized);
}

function parseRunMinute(raw) {
  if (raw == null || raw === "") {
    return DEFAULT_RUN_MINUTE;
  }

  const normalized = String(raw).trim().toLowerCase();
  if (normalized === "top") {
    return 0;
  }
  if (normalized === "bottom") {
    return 30;
  }

  if (!/^\d+$/.test(normalized)) {
    throw new Error("HUBOT_AUTHZ_REPORT_RUN_MINUTE must be 'top', 'bottom', or an integer minute 0-59");
  }

  const minute = Number(normalized);
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new Error("HUBOT_AUTHZ_REPORT_RUN_MINUTE must be in range 0-59");
  }

  return minute;
}

function getConfig() {
  const enabled = parseBoolean(process.env.HUBOT_AUTHZ_REPORT_ENABLED, false);
  const channelId = String(process.env.HUBOT_AUTHZ_REPORT_CHANNEL_ID ?? "").trim();
  const lookbackMinutes = process.env.HUBOT_AUTHZ_REPORT_LOOKBACK_MINUTES
    ? parsePositiveInt(process.env.HUBOT_AUTHZ_REPORT_LOOKBACK_MINUTES, "HUBOT_AUTHZ_REPORT_LOOKBACK_MINUTES")
    : DEFAULT_LOOKBACK_MINUTES;
  const topLimit = process.env.HUBOT_AUTHZ_REPORT_TOP_LIMIT
    ? parsePositiveInt(process.env.HUBOT_AUTHZ_REPORT_TOP_LIMIT, "HUBOT_AUTHZ_REPORT_TOP_LIMIT")
    : DEFAULT_TOP_LIMIT;
  const runMinute = parseRunMinute(process.env.HUBOT_AUTHZ_REPORT_RUN_MINUTE);
  const sendEmpty = parseBoolean(process.env.HUBOT_AUTHZ_REPORT_SEND_EMPTY, DEFAULT_SEND_EMPTY);

  return {
    enabled,
    channelId,
    lookbackMinutes,
    topLimit,
    runMinute,
    sendEmpty,
  };
}

async function queryLokiAuthzSummary({ robot, lookbackMinutes }) {
  const payload = await queryLokiVector({
    robot,
    query: buildAuthzSummaryQuery(lookbackMinutes),
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    logPrefix: "authz.report",
  });

  return parseAuthzSummaryRows(payload);
}

function renderTopRows(rows, maxRows) {
  const selected = rows.slice(0, maxRows);
  if (selected.length === 0) {
    return "No authorization denials in this window.";
  }

  const lines = selected.map((row, index) => `${index + 1}. ${row.username} | ${row.topic} -> ${row.count}`);

  let output = "";
  for (const line of lines) {
    if (`${output}${line}\n`.length > 1000) {
      break;
    }
    output += `${line}\n`;
  }

  return output.trim() || "No authorization denials in this window.";
}

function buildEmbed(rows, { lookbackMinutes, topLimit }) {
  const totalDenials = rows.reduce((sum, row) => sum + row.count, 0);
  const uniquePairs = rows.length;

  return new EmbedBuilder()
    .setColor(REPORT_COLOR)
    .setTitle("MQTT Authorization Denial Summary")
    .setDescription(`Denied events for the last ${lookbackMinutes} minutes`)
    .addFields(
      { name: "Total Denials", value: String(totalDenials), inline: true },
      { name: "Unique topic+username pairs", value: String(uniquePairs), inline: true },
      { name: `Top ${topLimit} pairs`, value: renderTopRows(rows, topLimit), inline: false },
    )
    .setTimestamp(new Date());
}

async function sendEmbedToChannel({ robot, channelId, embed }) {
  const client = robot?.adapter?.client;
  if (!client?.channels?.fetch) {
    throw new Error("Discord client is unavailable on the adapter");
  }

  const channel = await client.channels.fetch(String(channelId));
  if (!channel || typeof channel.send !== "function") {
    throw new Error(`Channel ${channelId} is not sendable`);
  }

  await channel.send({ embeds: [embed] });
}

function getRawMessage(ctx) {
  return ctx?.context?.message?.user?.message ?? null;
}

function isDirectMessageContext(ctx) {
  const rawMessage = getRawMessage(ctx);
  return rawMessage?.guildId == null;
}

function msUntilNextMinuteBoundary(targetMinute, now = new Date()) {
  const next = new Date(now);
  next.setSeconds(0, 0);
  next.setMinutes(targetMinute);

  if (next.getTime() <= now.getTime()) {
    next.setHours(next.getHours() + 1);
  }

  return next.getTime() - now.getTime();
}

export default (robot) => {
  let config;
  try {
    config = getConfig();
  } catch (error) {
    robot.logger.error(`authz.report configuration error: ${error.message}`);
    return;
  }

  if (!config.enabled) {
    return;
  }

  if (!config.channelId) {
    robot.logger.warn("authz.report disabled: HUBOT_AUTHZ_REPORT_CHANNEL_ID is not set");
    return;
  }

  let running = false;
  let timer = null;

  const buildReportEmbed = async () => {
    const rows = await queryLokiAuthzSummary({
      robot,
      lookbackMinutes: config.lookbackMinutes,
    });

    return {
      rows,
      embed: buildEmbed(rows, {
        lookbackMinutes: config.lookbackMinutes,
        topLimit: config.topLimit,
      }),
    };
  };

  const runOnce = async ({ manual = false } = {}) => {
    if (running) {
      robot.logger.warn("authz.report skipped: prior run is still in progress");
      return;
    }

    running = true;
    try {
      const { rows, embed } = await buildReportEmbed();

      if (rows.length === 0 && !config.sendEmpty) {
        robot.logger.info("authz.report: no denials found; skipping empty report");
        return;
      }

      await sendEmbedToChannel({
        robot,
        channelId: config.channelId,
        embed,
      });

      robot.logger.info(`authz.report posted${manual ? " (manual)" : ""}: ${rows.length} pairs`);
    } catch (error) {
      robot.logger.error(`authz.report failed${manual ? " (manual)" : ""}: ${error.message}`);
    } finally {
      running = false;
    }
  };

  const runForDirectMessage = async () => {
    if (running) {
      robot.logger.warn("authz.report skipped: prior run is still in progress");
      return "authz.report skipped: prior run is still in progress.";
    }

    running = true;
    try {
      const { rows, embed } = await buildReportEmbed();
      robot.logger.info(`authz.report generated for DM: ${rows.length} pairs`);
      return embed;
    } catch (error) {
      robot.logger.error(`authz.report failed (manual DM): ${error.message}`);
      return `authz.report failed: ${error.message}`;
    } finally {
      running = false;
    }
  };

  const scheduleNext = () => {
    const delayMs = msUntilNextMinuteBoundary(config.runMinute);
    timer = setTimeout(async () => {
      await runOnce();
      scheduleNext();
    }, delayMs);

    const runAt = new Date(Date.now() + delayMs).toISOString();
    robot.logger.info(`authz.report next run scheduled for ${runAt}`);
  };

  if (robot.commands?.register) {
    robot.commands.register({
      id: "authz.report.now",
      description: "Run the AUTHZ denial summary report immediately",
      aliases: [
        "authz report now",
      ],
      permissions: AUTHZ_ADMIN_PERMISSIONS,
      confirm: "never",
      handler: async (ctx) => {
        if (isDirectMessageContext(ctx)) {
          return runForDirectMessage();
        }

        await runOnce({ manual: true });
        return "Triggered authz.report run.";
      },
    });
  }

  scheduleNext();

  process.on("exit", () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  });
};
