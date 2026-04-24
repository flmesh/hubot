// Discord contact cache for DM channel warm-up.
//
// Description:
//   Remembers Discord users the bot has seen and reopens their DM channels
//   after restart so direct-message commands work without a guild nudge.
//
// Commands:
//   None

const CACHE_KEY = "discord.contacts.v1";
const DEFAULT_MAX_CONTACTS = 500;
const DEFAULT_TTL_DAYS = 180;

function parsePositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function getConfig() {
  return {
    enabled: String(process.env.HUBOT_DISCORD_DM_WARMUP ?? "true").toLowerCase() !== "false",
    maxContacts: parsePositiveInt(process.env.HUBOT_DISCORD_CONTACT_CACHE_MAX, DEFAULT_MAX_CONTACTS),
    ttlMs: parsePositiveInt(process.env.HUBOT_DISCORD_CONTACT_CACHE_TTL_DAYS, DEFAULT_TTL_DAYS) * 24 * 60 * 60 * 1000,
  };
}

function getCache(robot) {
  const existing = robot.brain.get(CACHE_KEY);
  if (existing && typeof existing === "object" && existing.contacts && typeof existing.contacts === "object") {
    return existing;
  }

  return { contacts: {} };
}

function saveCache(robot, cache) {
  robot.brain.set(CACHE_KEY, cache);
  robot.brain.save();
}

function pruneContacts(cache, config, now = Date.now()) {
  const cutoff = now - config.ttlMs;
  const contacts = Object.values(cache.contacts)
    .filter((contact) => contact?.id && Number(contact.lastSeenAt) >= cutoff)
    .sort((a, b) => Number(b.lastSeenAt) - Number(a.lastSeenAt))
    .slice(0, config.maxContacts);

  cache.contacts = Object.fromEntries(contacts.map((contact) => [String(contact.id), contact]));
  return cache;
}

export function rememberDiscordContact(robot, message, now = Date.now()) {
  const author = message?.author;
  if (!author?.id || author.bot) {
    return false;
  }

  const config = getConfig();
  if (!config.enabled) {
    return false;
  }

  const cache = pruneContacts(getCache(robot), config, now);
  cache.contacts[String(author.id)] = {
    id: String(author.id),
    username: author.username ?? null,
    globalName: author.globalName ?? author.displayName ?? null,
    lastSeenAt: now,
  };

  saveCache(robot, pruneContacts(cache, config, now));
  return true;
}

export async function warmDiscordDmChannels(robot, now = Date.now()) {
  const config = getConfig();
  const client = robot?.adapter?.client;
  if (!config.enabled || !client?.users?.fetch) {
    return { attempted: 0, warmed: 0, failed: 0 };
  }

  const cache = pruneContacts(getCache(robot), config, now);
  const contacts = Object.values(cache.contacts);
  let warmed = 0;
  let failed = 0;

  for (const contact of contacts) {
    try {
      const user = await client.users.fetch(String(contact.id));
      await user?.createDM?.();
      warmed += 1;
    } catch (error) {
      failed += 1;
      robot.logger.debug?.(`discord DM warm-up failed for ${contact.id}: ${error.message}`);
    }
  }

  saveCache(robot, cache);
  return { attempted: contacts.length, warmed, failed };
}

export default (robot) => {
  const client = robot.adapter?.client;
  if (!client?.on || !client?.once) {
    robot.logger.warn("discord contact cache skipped: Discord client is unavailable");
    return;
  }

  client.on("messageCreate", (message) => {
    rememberDiscordContact(robot, message);
  });

  let ready = false;
  let brainConnected = false;
  let warmed = false;

  const maybeWarm = async () => {
    if (warmed || !ready || !brainConnected) {
      return;
    }

    warmed = true;
    const result = await warmDiscordDmChannels(robot);
    robot.logger.info(`Discord DM warm-up complete: ${result.warmed}/${result.attempted} warmed, ${result.failed} failed`);
  };

  const markReady = () => {
    ready = true;
    maybeWarm();
  };

  client.once("clientReady", markReady);
  client.once("ready", markReady);
  if (typeof client.isReady === "function" ? client.isReady() : client.readyAt) {
    markReady();
  }

  robot.brain.on("connected", () => {
    brainConnected = true;
    return maybeWarm();
  });

  robot.brain.on("loaded", () => {
    brainConnected = true;
    return maybeWarm();
  });
};
