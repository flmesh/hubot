// MQTT account management commands backed by MongoDB.
//
// Description:
//   Manage MQTT account provisioning, credentials, status, profiles, and ACL
//   materialization through the command bus.
//
// Commands:
//   None

import { deliverDirectEmbedToUserId, deliverEmbedPossiblyViaDm } from "./dm-delivery.js";
import { installDiscordRolePermissionProvider } from "./lib/discord-role-permissions.js";
import { buildPasswordMaterial } from "./lib/mqtt-auth.js";
import { installMqttAuditBridge, recordMqttAuditEvent, updateMqttAuditEvent } from "./lib/mqtt-audit.js";
import { getMqttCollections } from "./lib/mqtt-db.js";
import {
  buildMyAccountEmbed,
  buildCredentialEmbed,
  buildProfileListEmbed,
  buildProfileShowEmbed,
  buildWhoisEmbed,
  summarizeCommandResult,
} from "./lib/mqtt-discord-format.js";
import { verifyAdminGuildOnReady } from "./lib/mqtt-perms.js";
import { validateUsernamePolicy } from "./lib/mqtt-policy.js";
import {
  buildAclDocuments,
  getDefaultProfile,
  getProfileByName,
  listProfiles,
  reapplyProfileToAssignedUsers,
  replaceProfileManagedAcls,
} from "./lib/mqtt-profiles.js";

const MQTT_ADMIN_PERMISSIONS = {
  roles: ["env:MQTT_ADMIN_ROLE_IDS"],
};

function getRawMessage(ctx) {
  return ctx?.context?.message?.user?.message ?? null;
}

function getDiscordIdentity(ctx) {
  const rawMessage = getRawMessage(ctx);
  const author = rawMessage?.author;
  const userId = author?.id ?? ctx?.context?.message?.user?.id ?? null;
  const username = author?.username ?? ctx?.context?.message?.user?.name ?? "unknown";
  const discriminator = author?.discriminator;
  const globalName = author?.globalName ?? author?.displayName ?? null;
  const discordTag = discriminator && discriminator !== "0"
    ? `${username}#${discriminator}`
    : globalName ?? username;

  return { rawMessage, userId, username, discordTag };
}

async function deliverCredentials({ robot, ctx, username, password, profileName, action, commandName }) {
  const embed = buildCredentialEmbed({ username, password, profileName, action });
  return deliverEmbedPossiblyViaDm({
    robot,
    ctx,
    embed,
    commandName,
  });
}

async function loadCollectionsWithPolicy() {
  const collections = await getMqttCollections();
  const policy = await collections.usernamePolicy.findOne({ _id: "default" });
  return { collections, policy };
}

async function ensureUsernameAvailable({ collections, username, discordUserId }) {
  const [existingUserByName, existingUserByOwner, pendingRequestByName, pendingRequestByOwner] = await Promise.all([
    collections.users.findOne({ username }),
    collections.users.findOne({ discord_user_id: discordUserId }),
    collections.requests.findOne({ requested_username: username, status: "pending" }),
    collections.requests.findOne({ discord_user_id: discordUserId, status: "pending" }),
  ]);

  if (existingUserByName) {
    throw new Error("username is already in use");
  }

  if (existingUserByOwner) {
    throw new Error(`you already have an MQTT account: ${existingUserByOwner.username}`);
  }

  if (pendingRequestByName) {
    throw new Error("username already has a pending request");
  }

  if (pendingRequestByOwner) {
    throw new Error("you already have a pending MQTT request");
  }
}

async function createAccount({ robot, ctx, requestedUsername }) {
  const { userId, discordTag } = getDiscordIdentity(ctx);
  if (!userId) {
    throw new Error("could not determine your Discord identity");
  }

  const { collections, policy } = await loadCollectionsWithPolicy();
  const username = validateUsernamePolicy(requestedUsername, policy);
  await ensureUsernameAvailable({ collections, username, discordUserId: userId });

  const profile = await getDefaultProfile(collections);
  if (!profile) {
    throw new Error("no active default profile is configured");
  }

  const { password, salt, passwordHash } = buildPasswordMaterial();
  const now = new Date();
  const acls = buildAclDocuments({
    username,
    profileName: profile.name,
    rules: profile.rules,
  });

  const requestDocument = {
    discord_user_id: userId,
    discord_tag: discordTag,
    requested_username: username,
    status: "approved",
    profile: profile.name,
    created_at: now,
    reviewed_at: now,
    reviewed_by: "hubot",
    provisioned_at: now,
  };

  await collections.users.insertOne({
    username,
    password_hash: passwordHash,
    salt,
    is_superuser: false,
    discord_user_id: userId,
    discord_tag: discordTag,
    profile: profile.name,
    status: "active",
    created_at: now,
    created_by: "hubot",
  });

  try {
    if (acls.length > 0) {
      await collections.mqttAcl.insertMany(acls);
    }
    await collections.requests.insertOne(requestDocument);
  } catch (error) {
    await collections.users.deleteOne({ username });
    await collections.mqttAcl.deleteMany({ username, managed_by: "hubot-profile" });
    throw error;
  }

  return { username, password, profileName: profile.name };
}

async function getMyAccount({ robot, ctx }) {
  const { userId } = getDiscordIdentity(ctx);
  if (!userId) {
    throw new Error("could not determine your Discord identity");
  }

  const collections = await getMqttCollections();
  const user = await collections.users.findOne({ discord_user_id: userId });
  if (!user) {
    throw new Error("you do not have an MQTT account");
  }

  return deliverEmbedPossiblyViaDm({
    robot,
    ctx,
    embed: buildMyAccountEmbed(user),
    commandName: "mqtt.my-account",
  });
}

async function rotateMyPassword({ robot, ctx }) {
  const { userId, discordTag } = getDiscordIdentity(ctx);
  if (!userId) {
    throw new Error("could not determine your Discord identity");
  }

  const collections = await getMqttCollections();
  const user = await collections.users.findOne({ discord_user_id: userId });
  if (!user) {
    throw new Error("you do not have an MQTT account");
  }

  if (user.status !== "active") {
    throw new Error(`your MQTT account is not active (status: ${user.status ?? "unknown"})`);
  }

  const { password, salt, passwordHash } = buildPasswordMaterial();
  const now = new Date();
  await collections.users.updateOne(
    { _id: user._id },
    {
      $set: {
        password_hash: passwordHash,
        salt,
        updated_at: now,
        updated_by: discordTag,
      },
    },
  );

  return { username: user.username, password, profileName: user.profile ?? "unset" };
}

async function getUserByUsernameOrThrow(collections, username) {
  const normalized = String(username ?? "").trim().toLowerCase();
  if (!normalized) {
    throw new Error("username is required");
  }

  const user = await collections.users.findOne({ username: normalized });
  if (!user) {
    throw new Error(`MQTT account not found: ${normalized}`);
  }

  return user;
}

async function getAccountWhois({ robot, ctx }) {
  const collections = await getMqttCollections();
  const user = await getUserByUsernameOrThrow(collections, ctx.args.username);

  return deliverEmbedPossiblyViaDm({
    robot,
    ctx,
    embed: buildWhoisEmbed(user),
    commandName: "mqtt.whois",
  });
}

async function updateAccountStatus({ robot, ctx, status }) {
  const { discordTag } = getDiscordIdentity(ctx);
  const collections = await getMqttCollections();
  const user = await getUserByUsernameOrThrow(collections, ctx.args.username);
  const now = new Date();

  await collections.users.updateOne(
    { _id: user._id },
    {
      $set: {
        status,
        updated_at: now,
        updated_by: discordTag,
      },
    },
  );

  return `MQTT account ${user.username} is now ${status}.`;
}

async function rotateUserPassword({ robot, ctx, targetUsername }) {
  const { discordTag } = getDiscordIdentity(ctx);
  const collections = await getMqttCollections();
  const user = await getUserByUsernameOrThrow(collections, targetUsername);
  const { password, salt, passwordHash } = buildPasswordMaterial();
  const now = new Date();

  await collections.users.updateOne(
    { _id: user._id },
    {
      $set: {
        password_hash: passwordHash,
        salt,
        updated_at: now,
        updated_by: discordTag,
      },
    },
  );

  return {
    username: user.username,
    password,
    profileName: user.profile ?? "unset",
    discordUserId: user.discord_user_id ?? null,
  };
}

async function resetUserPassword({ robot, ctx }) {
  const result = await rotateUserPassword({
    robot,
    ctx,
    targetUsername: ctx.args.username,
  });

  try {
    await deliverDirectEmbedToUserId({
      robot,
      userId: result.discordUserId,
      embed: buildCredentialEmbed({
        username: result.username,
        password: result.password,
        profileName: result.profileName,
        action: "rotated",
      }),
      commandName: "mqtt.reset",
    });

    return `Password reset for ${result.username}. I sent the new credentials to the account owner via DM.`;
  } catch (error) {
    robot.logger.warn(`mqtt.reset owner DM delivery failed for ${result.username}: ${error.message}`);
    return `Password reset for ${result.username}, but I could not DM the account owner. Follow up manually.`;
  }
}

async function setUserProfile({ robot, ctx }) {
  const { discordTag } = getDiscordIdentity(ctx);
  const collections = await getMqttCollections();
  const user = await getUserByUsernameOrThrow(collections, ctx.args.username);
  const profileName = String(ctx.args.profile ?? "").trim().toLowerCase();
  if (!profileName) {
    throw new Error("profile is required");
  }

  const profile = await getProfileByName(collections, profileName);
  if (!profile) {
    throw new Error(`profile not found: ${profileName}`);
  }
  if (profile.status !== "active") {
    throw new Error(`profile is not active: ${profileName}`);
  }

  const now = new Date();
  await replaceProfileManagedAcls({
    collections,
    username: user.username,
    profile,
  });

  await collections.users.updateOne(
    { _id: user._id },
    {
      $set: {
        profile: profile.name,
        updated_at: now,
        updated_by: discordTag,
      },
    },
  );

  return `MQTT account ${user.username} is now assigned to profile ${profile.name}.`;
}

function normalizeProfileName(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) {
    throw new Error("profile is required");
  }
  return normalized;
}

async function getProfileList({ robot, ctx }) {
  const collections = await getMqttCollections();
  const profiles = await listProfiles(collections);

  return buildProfileListEmbed(profiles);
}

async function getProfileShow({ robot, ctx }) {
  const collections = await getMqttCollections();
  const profileName = normalizeProfileName(ctx.args.profile);
  const profile = await getProfileByName(collections, profileName);
  if (!profile) {
    throw new Error(`profile not found: ${profileName}`);
  }

  return buildProfileShowEmbed(profile);
}

async function applyProfileTemplate({ robot, ctx }) {
  const collections = await getMqttCollections();
  const profileName = normalizeProfileName(ctx.args.profile);
  const profile = await getProfileByName(collections, profileName);
  if (!profile) {
    throw new Error(`profile not found: ${profileName}`);
  }
  if (profile.status !== "active") {
    throw new Error(`profile is not active: ${profileName}`);
  }

  const { matchedUsers } = await reapplyProfileToAssignedUsers({
    collections,
    profile,
  });

  return `Reapplied profile ${profile.name} to ${matchedUsers} MQTT account${matchedUsers === 1 ? "" : "s"}.`;
}

function buildAuditMetadata(commandId, ctx, result, error) {
  const args = ctx?.args ?? {};

  return {
    target_username: args.username ?? result?.username ?? null,
    target_profile: args.profile ?? result?.profileName ?? null,
    delivery: typeof result === "string" && result.includes("DM")
      ? "discord-dm"
      : null,
    failure_kind: error?.message === "you are not allowed to run this command"
      ? "authorization"
      : null,
    command_id: commandId,
  };
}

function wrapHandler(commandId, handler, {
  auditEvent = recordMqttAuditEvent,
  auditUpdate = updateMqttAuditEvent,
} = {}) {
  return async (ctx) => {
    const auditId = await auditEvent({
      commandId,
      phase: "attempted",
      ctx,
      args: ctx?.args ?? {},
      metadata: buildAuditMetadata(commandId, ctx, null, null),
    });

    try {
      const result = await handler(ctx);
      await auditUpdate({
        commandId,
        auditId,
        phase: "succeeded",
        result: summarizeCommandResult(result),
        metadata: buildAuditMetadata(commandId, ctx, result, null),
      });
      return result;
    } catch (error) {
      await auditUpdate({
        commandId,
        auditId,
        phase: error.message === "you are not allowed to run this command" ? "denied" : "failed",
        error,
        metadata: buildAuditMetadata(commandId, ctx, null, error),
      });
      return `mqtt command failed: ${error.message}`;
    }
  };
}

export function registerMqttCommands(robot, {
  auditEvent = recordMqttAuditEvent,
  auditUpdate = updateMqttAuditEvent,
  auditBridge = installMqttAuditBridge,
} = {}) {
  installDiscordRolePermissionProvider(robot);
  auditBridge(robot, { recordEvent: auditEvent });
  verifyAdminGuildOnReady(robot);

  robot.commands.register({
    id: "mqtt.request",
    description: "Request a new MQTT account",
    aliases: [
      "mqtt request",
      "request mqtt",
    ],
    args: {
      username: { type: "string", required: true },
    },
    confirm: "never",
    examples: [
      "mqtt.request username:lonewolf",
      "mqtt.request --username lonewolf",
    ],
    handler: wrapHandler("mqtt.request", async (ctx) => {
      const result = await createAccount({
        robot,
        ctx,
        requestedUsername: ctx.args.username,
      });

      return deliverCredentials({
        robot,
        ctx,
        username: result.username,
        password: result.password,
        profileName: result.profileName,
        action: "created",
        commandName: "mqtt.request",
      });
    }, { auditEvent, auditUpdate }),
  });

  robot.commands.register({
    id: "mqtt.my-account",
    description: "Show your MQTT account details",
    aliases: [
      "mqtt my-account",
      "mqtt account",
      "my mqtt account",
    ],
    confirm: "never",
    examples: [
      "mqtt.my-account",
      "mqtt.my-account --help",
    ],
    handler: wrapHandler("mqtt.my-account", async (ctx) => getMyAccount({ robot, ctx }), { auditEvent, auditUpdate }),
  });

  robot.commands.register({
    id: "mqtt.rotate",
    description: "Rotate your MQTT account password",
    aliases: [
      "mqtt rotate",
      "rotate mqtt password",
    ],
    confirm: "always",
    examples: [
      "mqtt.rotate",
      "mqtt.rotate --help",
    ],
    handler: wrapHandler("mqtt.rotate", async (ctx) => {
      const result = await rotateMyPassword({ robot, ctx });
      return deliverCredentials({
        robot,
        ctx,
        username: result.username,
        password: result.password,
        profileName: result.profileName,
        action: "rotated",
        commandName: "mqtt.rotate",
      });
    }, { auditEvent, auditUpdate }),
  });

  robot.commands.register({
    id: "mqtt.reset",
    description: "Reset a user's MQTT account password",
    aliases: [
      "mqtt reset",
      "reset mqtt password",
    ],
    args: {
      username: { type: "string", required: true },
    },
    confirm: "always",
    permissions: MQTT_ADMIN_PERMISSIONS,
    examples: [
      "mqtt.reset username:jbouse",
      "mqtt.reset --username jbouse",
      "mqtt.reset --help",
    ],
    handler: wrapHandler("mqtt.reset", async (ctx) => resetUserPassword({ robot, ctx }), { auditEvent, auditUpdate }),
  });

  robot.commands.register({
    id: "mqtt.whois",
    description: "Show admin details for an MQTT account",
    aliases: [
      "mqtt whois",
      "whois mqtt",
    ],
    args: {
      username: { type: "string", required: true },
    },
    confirm: "never",
    permissions: MQTT_ADMIN_PERMISSIONS,
    examples: [
      "mqtt.whois username:jbouse",
      "mqtt.whois --username jbouse",
    ],
    handler: wrapHandler("mqtt.whois", async (ctx) => getAccountWhois({ robot, ctx }), { auditEvent, auditUpdate }),
  });

  robot.commands.register({
    id: "mqtt.disable",
    description: "Disable an MQTT account",
    aliases: [
      "mqtt disable",
    ],
    args: {
      username: { type: "string", required: true },
    },
    confirm: "always",
    permissions: MQTT_ADMIN_PERMISSIONS,
    examples: [
      "mqtt.disable username:jbouse",
      "mqtt.disable --username jbouse",
    ],
    handler: wrapHandler("mqtt.disable", async (ctx) => updateAccountStatus({ robot, ctx, status: "disabled" }), { auditEvent, auditUpdate }),
  });

  robot.commands.register({
    id: "mqtt.enable",
    description: "Enable an MQTT account",
    aliases: [
      "mqtt enable",
    ],
    args: {
      username: { type: "string", required: true },
    },
    confirm: "always",
    permissions: MQTT_ADMIN_PERMISSIONS,
    examples: [
      "mqtt.enable username:jbouse",
      "mqtt.enable --username jbouse",
    ],
    handler: wrapHandler("mqtt.enable", async (ctx) => updateAccountStatus({ robot, ctx, status: "active" }), { auditEvent, auditUpdate }),
  });

  robot.commands.register({
    id: "mqtt.profile.set",
    description: "Assign an MQTT account to a different profile",
    aliases: [
      "mqtt profile set",
    ],
    args: {
      username: { type: "string", required: true },
      profile: { type: "string", required: true },
    },
    confirm: "always",
    permissions: MQTT_ADMIN_PERMISSIONS,
    examples: [
      "mqtt.profile.set username:jbouse profile:lonewolf",
      "mqtt.profile.set --username jbouse --profile lonewolf",
    ],
    handler: wrapHandler("mqtt.profile.set", async (ctx) => setUserProfile({ robot, ctx }), { auditEvent, auditUpdate }),
  });

  robot.commands.register({
    id: "mqtt.profile.list",
    description: "List available MQTT profiles",
    aliases: [
      "mqtt profile list",
    ],
    confirm: "never",
    permissions: MQTT_ADMIN_PERMISSIONS,
    examples: [
      "mqtt.profile.list",
      "mqtt.profile.list --help",
    ],
    handler: wrapHandler("mqtt.profile.list", async (ctx) => getProfileList({ robot, ctx }), { auditEvent, auditUpdate }),
  });

  robot.commands.register({
    id: "mqtt.profile.show",
    description: "Show metadata and rules for an MQTT profile",
    aliases: [
      "mqtt profile show",
    ],
    args: {
      profile: { type: "string", required: true },
    },
    confirm: "never",
    permissions: MQTT_ADMIN_PERMISSIONS,
    examples: [
      "mqtt.profile.show profile:default",
      "mqtt.profile.show --profile default",
    ],
    handler: wrapHandler("mqtt.profile.show", async (ctx) => getProfileShow({ robot, ctx }), { auditEvent, auditUpdate }),
  });

  robot.commands.register({
    id: "mqtt.profile.apply",
    description: "Reapply a profile template to all users assigned to that profile",
    aliases: [
      "mqtt profile apply",
    ],
    args: {
      profile: { type: "string", required: true },
    },
    confirm: "always",
    permissions: MQTT_ADMIN_PERMISSIONS,
    examples: [
      "mqtt.profile.apply profile:default",
      "mqtt.profile.apply --profile default",
    ],
    handler: wrapHandler("mqtt.profile.apply", async (ctx) => applyProfileTemplate({ robot, ctx }), { auditEvent, auditUpdate }),
  });
}

export default (robot) => {
  registerMqttCommands(robot);
};
