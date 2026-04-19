import { deliverPossiblyViaDm } from "./dm-delivery.js";
import { buildPasswordMaterial } from "./lib/mqtt-auth.js";
import { getMqttCollections } from "./lib/mqtt-db.js";
import { validateUsernamePolicy } from "./lib/mqtt-policy.js";
import { buildAclDocuments, getDefaultProfile } from "./lib/mqtt-profiles.js";

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
    handler: wrapHandler(async (ctx) => {
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
};
