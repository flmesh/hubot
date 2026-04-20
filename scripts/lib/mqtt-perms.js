function splitEnvList(value) {
  return String(value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function getRawMessage(ctx) {
  return ctx?.context?.message?.user?.message ?? null;
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
    roleNames: splitEnvList(process.env.MQTT_ADMIN_ROLE_NAMES).map((name) => name.toLowerCase()),
  };
}

export function userHasAdminRole(ctx) {
  const rawMessage = getRawMessage(ctx);
  if (!rawMessage?.guildId) {
    return false;
  }

  const { roleIds, roleNames } = getAdminRoleConfig();
  if (roleIds.length === 0 && roleNames.length === 0) {
    return false;
  }

  const roleEntries = normalizeRoleEntries(getMemberRoleCollection(rawMessage));

  return roleEntries.some((role) => {
    const roleId = String(role?.id ?? role);
    const roleName = String(role?.name ?? "").toLowerCase();
    return roleIds.includes(roleId) || (roleName && roleNames.includes(roleName));
  });
}

export function ensureAdminRole(ctx) {
  if (!userHasAdminRole(ctx)) {
    throw new Error("you are not allowed to run this command");
  }
}
