function splitEnvList(value) {
  return String(value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function getRawMessageFromContext(context) {
  return context?.message?.user?.message ?? context?.user?.message ?? null;
}

function getDiscordUserId(user, context) {
  const rawMessage = getRawMessageFromContext(context);
  return rawMessage?.author?.id ?? user?.id ?? context?.user?.id ?? null;
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

function resolveRoleIds(roles) {
  return roles.flatMap((role) => {
    const value = String(role ?? "").trim();
    if (!value) {
      return [];
    }

    if (value.startsWith("env:")) {
      return splitEnvList(process.env[value.slice(4)]);
    }

    return [value];
  });
}

function hasAnyRole(roleCollection, roleIds) {
  if (roleIds.length === 0) {
    return false;
  }

  const roleEntries = normalizeRoleEntries(roleCollection);
  return roleEntries.some((role) => roleIds.includes(String(role?.id ?? role)));
}

function getPermissionGuildId(context) {
  const rawMessage = getRawMessageFromContext(context);
  return String(
    process.env.HUBOT_DISCORD_PERMISSION_GUILD_ID
      ?? process.env.MQTT_ADMIN_GUILD_ID
      ?? rawMessage?.guildId
      ?? "",
  ).trim();
}

export function createDiscordRolePermissionProvider(robot) {
  return {
    isDiscordRolePermissionProvider: true,

    async hasRole(user, roles, context = {}) {
      const roleIds = resolveRoleIds(roles);
      if (roleIds.length === 0) {
        return false;
      }

      const rawMessage = getRawMessageFromContext(context);
      if (rawMessage?.guildId) {
        const permissionGuildId = getPermissionGuildId(context);
        return (!permissionGuildId || String(rawMessage.guildId) === permissionGuildId)
          && hasAnyRole(getMemberRoleCollection(rawMessage), roleIds);
      }

      const permissionGuildId = getPermissionGuildId(context);
      if (!permissionGuildId) {
        return false;
      }

      const userId = getDiscordUserId(user, context);
      const guilds = robot?.adapter?.client?.guilds;
      if (!userId || !guilds?.fetch) {
        return false;
      }

      try {
        const guild = await guilds.fetch(permissionGuildId);
        const member = await guild?.members?.fetch?.(String(userId));
        return hasAnyRole(member?.roles?.cache ?? member?.roles, roleIds);
      } catch {
        return false;
      }
    },
  };
}

export function installDiscordRolePermissionProvider(robot) {
  if (!robot?.commands) {
    return null;
  }

  const existingProvider = robot.commands.permissionProvider;
  if (existingProvider?.isDiscordRolePermissionProvider) {
    return existingProvider;
  }

  const discordProvider = createDiscordRolePermissionProvider(robot);

  if (!existingProvider?.hasRole) {
    robot.commands.permissionProvider = discordProvider;
    return discordProvider;
  }

  const combinedProvider = {
    isDiscordRolePermissionProvider: true,

    async hasRole(user, roles, context = {}) {
      if (await existingProvider.hasRole(user, roles, context)) {
        return true;
      }

      return discordProvider.hasRole(user, roles, context);
    },
  };

  robot.commands.permissionProvider = combinedProvider;
  return combinedProvider;
}
