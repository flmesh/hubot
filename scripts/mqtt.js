import { deliverDirectMessageToUserId, deliverPossiblyViaDm } from "./dm-delivery.js";
import { buildPasswordMaterial } from "./lib/mqtt-auth.js";
import { installMqttAuditBridge, recordMqttAuditEvent } from "./lib/mqtt-audit.js";
import { getMqttCollections } from "./lib/mqtt-db.js";
import { ensureAdminRole } from "./lib/mqtt-perms.js";
import { validateUsernamePolicy } from "./lib/mqtt-policy.js";
import {
  buildAclDocuments,
  getDefaultProfile,
  getProfileByName,
  listProfiles,
  reapplyProfileToAssignedUsers,
  replaceProfileManagedAcls,
} from "./lib/mqtt-profiles.js";

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

function formatCredentialReply({ username, password, profileName, action }) {
  return [
    `MQTT account ${action}.`,
    "",
    `Username: ${username}`,
    `Password: ${password}`,
    `Profile: ${profileName}`,
    "",
    "Keep this password private.",
  ].join("\n");
}

async function deliverCredentials({ robot, ctx, username, password, profileName, action, commandName }) {
  const text = formatCredentialReply({ username, password, profileName, action });
  return deliverPossiblyViaDm({
    robot,
    ctx,
    text,
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

async function getMyAccount(ctx) {
  const { userId } = getDiscordIdentity(ctx);
  if (!userId) {
    throw new Error("could not determine your Discord identity");
  }

  const collections = await getMqttCollections();
  const user = await collections.users.findOne({ discord_user_id: userId });
  if (!user) {
    throw new Error("you do not have an MQTT account");
  }

  return [
    `Username: ${user.username}`,
    `Status: ${user.status ?? "unknown"}`,
    `Profile: ${user.profile ?? "unset"}`,
    `Created: ${user.created_at ? new Date(user.created_at).toISOString() : "unknown"}`,
  ].join("\n");
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

async function getAccountWhois({ ctx }) {
  ensureAdminRole(ctx);
  const collections = await getMqttCollections();
  const user = await getUserByUsernameOrThrow(collections, ctx.args.username);

  return [
    `Username: ${user.username}`,
    `Status: ${user.status ?? "unknown"}`,
    `Profile: ${user.profile ?? "unset"}`,
    `Discord User ID: ${user.discord_user_id ?? "unknown"}`,
    `Discord Tag: ${user.discord_tag ?? "unknown"}`,
    `Created: ${user.created_at ? new Date(user.created_at).toISOString() : "unknown"}`,
    `Updated: ${user.updated_at ? new Date(user.updated_at).toISOString() : "never"}`,
  ].join("\n");
}

async function updateAccountStatus({ robot, ctx, status }) {
  ensureAdminRole(ctx);
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

async function setUserProfile({ robot, ctx }) {
  ensureAdminRole(ctx);
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

function formatProfileRules(rules) {
  if (!Array.isArray(rules) || rules.length === 0) {
    return "  (no rules)";
  }

  return rules.map((rule, index) => {
    const topics = Array.isArray(rule.topics) && rule.topics.length > 0
      ? rule.topics.join(", ")
      : "(none)";
    return `  ${index + 1}. ${rule.permission} ${rule.action} ${topics}`;
  }).join("\n");
}

async function getProfileList({ ctx }) {
  ensureAdminRole(ctx);
  const collections = await getMqttCollections();
  const profiles = await listProfiles(collections);

  if (profiles.length === 0) {
    return "No MQTT profiles are configured.";
  }

  return [
    "MQTT profiles:",
    "",
    ...profiles.map((profile) => {
      const flags = [
        profile.is_default ? "default" : null,
        profile.status ?? "unknown",
      ].filter(Boolean).join(", ");
      const summary = profile.description ? ` - ${profile.description}` : "";
      const ruleCount = Array.isArray(profile.rules) ? profile.rules.length : 0;
      return `- ${profile.name} [${flags}] (${ruleCount} rule${ruleCount === 1 ? "" : "s"})${summary}`;
    }),
  ].join("\n");
}

async function getProfileShow({ ctx }) {
  ensureAdminRole(ctx);
  const collections = await getMqttCollections();
  const profileName = normalizeProfileName(ctx.args.profile);
  const profile = await getProfileByName(collections, profileName);
  if (!profile) {
    throw new Error(`profile not found: ${profileName}`);
  }

  return [
    `Name: ${profile.name}`,
    `Status: ${profile.status ?? "unknown"}`,
    `Default: ${profile.is_default ? "yes" : "no"}`,
    `Description: ${profile.description ?? ""}`,
    `Created: ${profile.created_at ? new Date(profile.created_at).toISOString() : "unknown"}`,
    `Updated: ${profile.updated_at ? new Date(profile.updated_at).toISOString() : "unknown"}`,
    "Rules:",
    formatProfileRules(profile.rules),
  ].join("\n");
}

async function applyProfileTemplate({ ctx }) {
  ensureAdminRole(ctx);
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

function wrapHandler(commandId, handler, { auditEvent = recordMqttAuditEvent } = {}) {
  return async (ctx) => {
    await auditEvent({
      commandId,
      phase: "attempted",
      ctx,
      args: ctx?.args ?? {},
      metadata: buildAuditMetadata(commandId, ctx, null, null),
    });

    try {
      const result = await handler(ctx);
      await auditEvent({
        commandId,
        phase: "succeeded",
        ctx,
        args: ctx?.args ?? {},
        result: typeof result === "string" ? { reply_preview: result.slice(0, 250) } : null,
        metadata: buildAuditMetadata(commandId, ctx, result, null),
      });
      return result;
    } catch (error) {
      await auditEvent({
        commandId,
        phase: error.message === "you are not allowed to run this command" ? "denied" : "failed",
        ctx,
        args: ctx?.args ?? {},
        error,
        metadata: buildAuditMetadata(commandId, ctx, null, error),
      });
      return `mqtt command failed: ${error.message}`;
    }
  };
}

export function registerMqttCommands(robot, {
  auditEvent = recordMqttAuditEvent,
  auditBridge = installMqttAuditBridge,
} = {}) {
  auditBridge(robot, { recordEvent: auditEvent });

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
    }, { auditEvent }),
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
    handler: wrapHandler("mqtt.my-account", async (ctx) => getMyAccount(ctx), { auditEvent }),
  });

  robot.commands.register({
    id: "mqtt.rotate",
    description: "Rotate your MQTT account password, or rotate another user's account if you are an admin",
    aliases: [
      "mqtt rotate",
      "rotate mqtt password",
    ],
    args: {
      username: { type: "string", required: false },
    },
    confirm: "always",
    examples: [
      "mqtt.rotate",
      "mqtt.rotate username:jbouse",
      "mqtt.rotate --username jbouse",
      "mqtt.rotate --help",
    ],
    handler: wrapHandler("mqtt.rotate", async (ctx) => {
      if (ctx.args.username) {
        ensureAdminRole(ctx);
        const result = await rotateUserPassword({
          robot,
          ctx,
          targetUsername: ctx.args.username,
        });

        try {
          await deliverDirectMessageToUserId({
            robot,
            userId: result.discordUserId,
            text: formatCredentialReply({
              username: result.username,
              password: result.password,
              profileName: result.profileName,
              action: "rotated",
            }),
            commandName: "mqtt.rotate",
          });

          return `Password rotated for ${result.username}. I sent the new credentials to the account owner via DM.`;
        } catch (error) {
          robot.logger.warn(`mqtt.rotate owner DM delivery failed for ${result.username}: ${error.message}`);
          return `Password rotated for ${result.username}, but I could not DM the account owner. Follow up manually.`;
        }
      }

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
    }, { auditEvent }),
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
    examples: [
      "mqtt.whois username:jbouse",
      "mqtt.whois --username jbouse",
    ],
    handler: wrapHandler("mqtt.whois", async (ctx) => getAccountWhois({ ctx }), { auditEvent }),
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
    examples: [
      "mqtt.disable username:jbouse",
      "mqtt.disable --username jbouse",
    ],
    handler: wrapHandler("mqtt.disable", async (ctx) => updateAccountStatus({ robot, ctx, status: "disabled" }), { auditEvent }),
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
    examples: [
      "mqtt.enable username:jbouse",
      "mqtt.enable --username jbouse",
    ],
    handler: wrapHandler("mqtt.enable", async (ctx) => updateAccountStatus({ robot, ctx, status: "active" }), { auditEvent }),
  });

  robot.commands.register({
    id: "mqtt.set-profile",
    description: "Assign an MQTT account to a different profile",
    aliases: [
      "mqtt set-profile",
    ],
    args: {
      username: { type: "string", required: true },
      profile: { type: "string", required: true },
    },
    confirm: "always",
    examples: [
      "mqtt.set-profile username:jbouse profile:lonewolf",
      "mqtt.set-profile --username jbouse --profile lonewolf",
    ],
    handler: wrapHandler("mqtt.set-profile", async (ctx) => setUserProfile({ robot, ctx }), { auditEvent }),
  });

  robot.commands.register({
    id: "mqtt.profile-list",
    description: "List available MQTT profiles",
    aliases: [
      "mqtt profile list",
    ],
    confirm: "never",
    examples: [
      "mqtt.profile-list",
      "mqtt.profile-list --help",
    ],
    handler: wrapHandler("mqtt.profile-list", async (ctx) => getProfileList({ ctx }), { auditEvent }),
  });

  robot.commands.register({
    id: "mqtt.profile-show",
    description: "Show metadata and rules for an MQTT profile",
    aliases: [
      "mqtt profile show",
    ],
    args: {
      profile: { type: "string", required: true },
    },
    confirm: "never",
    examples: [
      "mqtt.profile-show profile:default",
      "mqtt.profile-show --profile default",
    ],
    handler: wrapHandler("mqtt.profile-show", async (ctx) => getProfileShow({ ctx }), { auditEvent }),
  });

  robot.commands.register({
    id: "mqtt.profile-apply",
    description: "Reapply a profile template to all users assigned to that profile",
    aliases: [
      "mqtt profile apply",
    ],
    args: {
      profile: { type: "string", required: true },
    },
    confirm: "always",
    examples: [
      "mqtt.profile-apply profile:default",
      "mqtt.profile-apply --profile default",
    ],
    handler: wrapHandler("mqtt.profile-apply", async (ctx) => applyProfileTemplate({ ctx }), { auditEvent }),
  });
}

export default (robot) => {
  registerMqttCommands(robot);
};
