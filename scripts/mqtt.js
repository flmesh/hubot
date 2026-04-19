import { deliverDirectMessageToUserId, deliverPossiblyViaDm } from "./dm-delivery.js";
import { buildPasswordMaterial } from "./lib/mqtt-auth.js";
import { getMqttCollections } from "./lib/mqtt-db.js";
import { ensureAdminRole } from "./lib/mqtt-perms.js";
import { validateUsernamePolicy } from "./lib/mqtt-policy.js";
import {
  buildAclDocuments,
  getDefaultProfile,
  getProfileByName,
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

  robot.logger.info(`mqtt.request provisioned username=${username} discord_user_id=${userId} profile=${profile.name}`);
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

  robot.logger.info(`mqtt.rotate rotated username=${user.username} discord_user_id=${userId}`);
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

  robot.logger.info(`mqtt.admin status=${status} username=${user.username} by=${discordTag}`);
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

  robot.logger.info(`mqtt.admin rotate username=${user.username} by=${discordTag}`);
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

  robot.logger.info(`mqtt.admin set-profile username=${user.username} profile=${profile.name} by=${discordTag}`);
  return `MQTT account ${user.username} is now assigned to profile ${profile.name}.`;
}

function wrapHandler(handler) {
  return async (ctx) => {
    try {
      return await handler(ctx);
    } catch (error) {
      return `mqtt command failed: ${error.message}`;
    }
  };
}

export default (robot) => {
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
    handler: wrapHandler(async (ctx) => {
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
    }),
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
    handler: wrapHandler(async (ctx) => getMyAccount(ctx)),
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
    handler: wrapHandler(async (ctx) => {
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
    }),
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
    handler: wrapHandler(async (ctx) => getAccountWhois({ ctx })),
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
    handler: wrapHandler(async (ctx) => updateAccountStatus({ robot, ctx, status: "disabled" })),
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
    handler: wrapHandler(async (ctx) => updateAccountStatus({ robot, ctx, status: "active" })),
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
    handler: wrapHandler(async (ctx) => setUserProfile({ robot, ctx })),
  });
};
