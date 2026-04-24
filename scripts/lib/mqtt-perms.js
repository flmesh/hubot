function splitEnvList(value) {
  return String(value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function getRawMessage(ctx) {
  return ctx?.context?.message?.user?.message ?? null;
}

function getDiscordUserId(ctx) {
  const rawMessage = getRawMessage(ctx);
  return rawMessage?.author?.id ?? ctx?.context?.message?.user?.id ?? null;
}

function getMemberRoleCollection(rawMessage) {
  return rawMessage?.member?.roles?.cache ?? rawMessage?.member?.roles ?? null;
}

function normalizeRoleEntries(roleCollection) {
  if (!roleCollection) {
    return [];
  }

  if (typeof roleCollection.values === "function") {
    return Array.from(roleCollection.values());
  }

  if (Array.isArray(roleCollection)) {
    return roleCollection;
  }

  if (typeof roleCollection === "object") {
    return Object.values(roleCollection);
  }

  return [];
}

export function getAdminRoleConfig() {
  return {
    roleIds: splitEnvList(process.env.MQTT_ADMIN_ROLE_IDS),
    guildId: String(process.env.MQTT_ADMIN_GUILD_ID ?? "").trim(),
  };
}

function hasConfiguredAdminRole(roleCollection, roleIds) {
  if (roleIds.length === 0) {
    return false;
  }

  const roleEntries = normalizeRoleEntries(roleCollection);
  return roleEntries.some((role) => roleIds.includes(String(role?.id ?? role)));
}

export function userHasAdminRole(ctx) {
  const rawMessage = getRawMessage(ctx);
  const { guildId, roleIds } = getAdminRoleConfig();
  return Boolean(rawMessage?.guildId)
    && (!guildId || String(rawMessage.guildId) === guildId)
    && hasConfiguredAdminRole(getMemberRoleCollection(rawMessage), roleIds);
}

export async function userHasAdminRoleViaDiscord(robot, ctx) {
  const rawMessage = getRawMessage(ctx);
  const { guildId, roleIds } = getAdminRoleConfig();
  if (roleIds.length === 0) {
    return false;
  }

  if (rawMessage?.guildId) {
    return (!guildId || String(rawMessage.guildId) === guildId)
      && hasConfiguredAdminRole(getMemberRoleCollection(rawMessage), roleIds);
  }

  if (!guildId) {
    return false;
  }

  const userId = getDiscordUserId(ctx);
  const guilds = robot?.adapter?.client?.guilds;
  if (!userId || !guilds?.fetch) {
    return false;
  }

  try {
    const guild = await guilds.fetch(guildId);
    const member = await guild?.members?.fetch?.(String(userId));
    return hasConfiguredAdminRole(member?.roles?.cache ?? member?.roles, roleIds);
  } catch {
    return false;
  }
}

export async function ensureAdminRole(robot, ctx) {
  const provider = robot?.commands?.permissionProvider;
  if (provider?.hasRole && await provider.hasRole(
    ctx?.context?.user,
    ["env:MQTT_ADMIN_ROLE_IDS"],
    ctx?.context ?? {},
  )) {
    return;
  }

  if (!(await userHasAdminRoleViaDiscord(robot, ctx))) {
    throw new Error("you are not allowed to run this command");
  }
}

export function verifyAdminGuildOnReady(robot) {
  const client = robot?.adapter?.client;
  const { guildId } = getAdminRoleConfig();
  if (!guildId || !client?.guilds?.fetch || !client?.once) {
    return;
  }

  let verified = false;
  const verify = async () => {
    if (verified) {
      return;
    }

    verified = true;
    try {
      const guild = await client.guilds.fetch(guildId);
      robot.logger.info(`MQTT admin guild verified: ${guild?.name ?? "unknown"} (${guildId})`);
    } catch (error) {
      robot.logger.warn(`MQTT_ADMIN_GUILD_ID is not accessible: ${guildId}: ${error.message}`);
    }
  };

  client.once("clientReady", verify);
  client.once("ready", verify);
  if (typeof client.isReady === "function" ? client.isReady() : client.readyAt) {
    verify();
  }
}
