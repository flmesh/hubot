import { getMqttCollections } from "./mqtt-db.js";

function getRawMessage(ctx) {
  return ctx?.context?.message?.user?.message ?? null;
}

function getActor(ctx) {
  const rawMessage = getRawMessage(ctx);
  const author = rawMessage?.author;
  const username = author?.username ?? ctx?.context?.message?.user?.name ?? "unknown";
  const discriminator = author?.discriminator;
  const globalName = author?.globalName ?? author?.displayName ?? null;
  const discordTag = discriminator && discriminator !== "0"
    ? `${username}#${discriminator}`
    : globalName ?? username;

  return {
    discord_user_id: author?.id ?? ctx?.context?.message?.user?.id ?? null,
    discord_username: username,
    discord_tag: discordTag,
  };
}

function getLocation(ctx) {
  const rawMessage = getRawMessage(ctx);
  return {
    guild_id: rawMessage?.guildId ?? null,
    channel_id: rawMessage?.channelId ?? null,
    is_dm: rawMessage?.guildId == null,
  };
}

function sanitizeArgs(args) {
  if (!args || typeof args !== "object") {
    return {};
  }

  return Object.fromEntries(
    Object.entries(args)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, value]),
  );
}

function redactError(error) {
  if (!error) {
    return null;
  }

  return {
    name: error.name ?? "Error",
    message: error.message ?? String(error),
  };
}

export async function recordMqttAuditEvent({
  robot,
  commandId,
  phase,
  ctx = null,
  args = {},
  result = null,
  error = null,
  metadata = {},
  collections = null,
}) {
  const document = {
    command_id: commandId,
    phase,
    args: sanitizeArgs(args),
    actor: getActor(ctx),
    location: getLocation(ctx),
    result: result ?? null,
    error: redactError(error),
    metadata,
    created_at: new Date(),
  };

  const loggerLine = [
    `mqtt.audit command=${commandId}`,
    `phase=${phase}`,
    `actor=${document.actor.discord_tag ?? "unknown"}`,
    `user_id=${document.actor.discord_user_id ?? "unknown"}`,
    `guild_id=${document.location.guild_id ?? "dm"}`,
    `channel_id=${document.location.channel_id ?? "unknown"}`,
  ].join(" ");

  if (error) {
    robot?.logger?.warn?.(`${loggerLine} error=${document.error.message}`);
  } else {
    robot?.logger?.info?.(loggerLine);
  }

  try {
    const mqttCollections = collections ?? await getMqttCollections();
    const result = await mqttCollections.mqttAudit.insertOne(document);
    return result?.insertedId ?? document._id ?? null;
  } catch (auditError) {
    robot?.logger?.warn?.(`mqtt.audit persist failed command=${commandId} phase=${phase}: ${auditError.message}`);
    return null;
  }
}

export async function updateMqttAuditEvent({
  robot,
  auditId,
  commandId,
  phase,
  result = null,
  error = null,
  metadata = {},
  collections = null,
}) {
  const update = {
    phase,
    result: result ?? null,
    error: redactError(error),
    metadata,
    completed_at: new Date(),
  };

  const loggerLine = [
    `mqtt.audit command=${commandId}`,
    `phase=${phase}`,
    auditId ? `audit_id=${auditId}` : "audit_id=missing",
  ].join(" ");

  if (error) {
    robot?.logger?.warn?.(`${loggerLine} error=${update.error.message}`);
  } else {
    robot?.logger?.info?.(loggerLine);
  }

  try {
    const mqttCollections = collections ?? await getMqttCollections();
    if (!auditId || !mqttCollections.mqttAudit.updateOne) {
      await mqttCollections.mqttAudit.insertOne({
        command_id: commandId,
        ...update,
        created_at: update.completed_at,
      });
      return null;
    }

    await mqttCollections.mqttAudit.updateOne(
      { _id: auditId },
      { $set: update },
    );
    return auditId;
  } catch (auditError) {
    robot?.logger?.warn?.(`mqtt.audit persist failed command=${commandId} phase=${phase}: ${auditError.message}`);
    return null;
  }
}

export function installMqttAuditBridge(robot, { recordEvent = recordMqttAuditEvent } = {}) {
  if (!robot?.commands?.on) {
    return;
  }

  const pendingMetadata = new Map();

  robot.commands.on("commands:proposal_created", async ({ commandId, confirmationKey }) => {
    const pending = robot.commands.pendingProposals?.get(confirmationKey);
    if (!pending) {
      return;
    }

    pendingMetadata.set(confirmationKey, {
      args: pending.args ?? {},
      ctx: pending.context ?? null,
    });

    await recordEvent({
      robot,
      commandId,
      phase: "confirm_requested",
      ctx: pending.context ?? null,
      args: pending.args ?? {},
      metadata: {
        confirmation_key: confirmationKey,
      },
    });
  });

  robot.commands.on("commands:proposal_confirmed", async ({ commandId, confirmationKey }) => {
    const pending = pendingMetadata.get(confirmationKey) ?? {};
    pendingMetadata.delete(confirmationKey);
    await recordEvent({
      robot,
      commandId,
      phase: "confirmed",
      ctx: pending.ctx ?? null,
      args: pending.args ?? {},
      metadata: {
        confirmation_key: confirmationKey,
      },
    });
  });

  robot.commands.on("commands:proposal_cancelled", async ({ commandId, confirmationKey }) => {
    const pending = pendingMetadata.get(confirmationKey) ?? {};
    pendingMetadata.delete(confirmationKey);
    await recordEvent({
      robot,
      commandId,
      phase: "cancelled",
      ctx: pending.ctx ?? null,
      args: pending.args ?? {},
      metadata: {
        confirmation_key: confirmationKey,
      },
    });
  });
}
