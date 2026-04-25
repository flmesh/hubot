import { EmbedBuilder } from "discord.js";
import { formatProfileRuleAsEmqxSpec } from "./mqtt-rule-templates.js";

const MQTT_EMBED_COLOR = 0x1f6feb;
const SENSITIVE_RESULT = Symbol.for("hubot.mqtt.sensitive_result");

function isoOrUnknown(value, fallback = "unknown") {
  return value ? new Date(value).toISOString() : fallback;
}

function compactRule(rule) {
  return formatProfileRuleAsEmqxSpec(rule);
}

function formatDiscordOwner(user) {
  const userId = String(user.discord_user_id ?? "").trim();
  const tag = String(user.discord_tag ?? "").trim();

  if (userId) {
    return `<@${userId}>`;
  }

  return tag || "unknown";
}

export function buildMyAccountEmbed(user) {
  return new EmbedBuilder()
    .setColor(MQTT_EMBED_COLOR)
    .setTitle("MQTT Account")
    .addFields(
      { name: "Username", value: user.username ?? "unknown", inline: true },
      { name: "Status", value: user.status ?? "unknown", inline: true },
      { name: "Profile", value: user.profile ?? "unset", inline: true },
      { name: "Created", value: isoOrUnknown(user.created_at), inline: false },
    );
}

export function buildWhoisEmbed(user) {
  return new EmbedBuilder()
    .setColor(MQTT_EMBED_COLOR)
    .setTitle(`MQTT Account: ${user.username ?? "unknown"}`)
    .addFields(
      { name: "Status", value: user.status ?? "unknown", inline: true },
      { name: "Profile", value: user.profile ?? "unset", inline: true },
      { name: "Owner", value: formatDiscordOwner(user), inline: false },
      { name: "Created", value: isoOrUnknown(user.created_at), inline: true },
      { name: "Updated", value: isoOrUnknown(user.updated_at, "never"), inline: true },
    );
}

export function buildCredentialEmbed({ username, password, profileName, action }) {
  const embed = new EmbedBuilder()
    .setColor(MQTT_EMBED_COLOR)
    .setTitle(`MQTT Account ${action}`)
    .addFields(
      { name: "Username", value: username ?? "unknown", inline: true },
      { name: "Password", value: password ?? "unknown", inline: false },
      { name: "Profile", value: profileName ?? "unset", inline: true },
    )
    .setFooter({ text: "Keep this password private." });

  Object.defineProperty(embed, SENSITIVE_RESULT, {
    value: "credential_delivery",
  });

  return embed;
}

export function buildProfileListEmbed(profiles) {
  const description = profiles.length === 0
    ? "No MQTT profiles are configured."
    : profiles.map((profile) => {
      const flags = [
        profile.is_default ? "default" : null,
        profile.status ?? "unknown",
      ].filter(Boolean).join(", ");
      const ruleCount = Array.isArray(profile.rules) ? profile.rules.length : 0;
      const summary = profile.description ? `\n${profile.description}` : "";
      return `**${profile.name}** [${flags}] (${ruleCount} rule${ruleCount === 1 ? "" : "s"})${summary}`;
    }).join("\n\n");

  return new EmbedBuilder()
    .setColor(MQTT_EMBED_COLOR)
    .setTitle("MQTT Profiles")
    .setDescription(description);
}

export function buildProfileShowEmbed(profile) {
  const ruleLines = Array.isArray(profile.rules) && profile.rules.length > 0
    ? profile.rules.map((rule, index) => `${index + 1}. ${compactRule(rule)}`).join("\n")
    : "(no rules)";

  const embed = new EmbedBuilder()
    .setColor(MQTT_EMBED_COLOR)
    .setTitle(`MQTT Profile: ${profile.name ?? "unknown"}`)
    .addFields(
      { name: "Status", value: profile.status ?? "unknown", inline: true },
      { name: "Default", value: profile.is_default ? "yes" : "no", inline: true },
      { name: "Created", value: isoOrUnknown(profile.created_at), inline: true },
      { name: "Updated", value: isoOrUnknown(profile.updated_at, "never"), inline: true },
      { name: "Rules", value: ruleLines, inline: false },
    );

  if (profile.description) {
    embed.setDescription(profile.description);
  }

  return embed;
}

const BAN_WHO_MAX_LEN = 32;

function truncateWho(who) {
  const s = String(who ?? "");
  return s.length > BAN_WHO_MAX_LEN ? `${s.slice(0, BAN_WHO_MAX_LEN - 1)}…` : s;
}

function parseBanUntilUnix(until) {
  if (!until || until === "infinity") {
    return null; // permanent
  }

  if (typeof until === "number" && Number.isFinite(until)) {
    return until;
  }

  const asNum = Number(until);
  if (Number.isFinite(asNum)) {
    return asNum;
  }

  // ISO string or similar — convert to unix seconds
  try {
    const ms = new Date(String(until)).getTime();
    return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
  } catch {
    return null;
  }
}

function formatBanUntil(until) {
  const unix = parseBanUntilUnix(until);
  if (unix === null) {
    return "permanent";
  }

  // Discord native timestamp: renders in the reader's local timezone
  return `<t:${unix}:f>`;
}

export function buildBanEmbed({ as, who, days, until }) {
  return new EmbedBuilder()
    .setColor(0xef4444)
    .setTitle("MQTT Client Banned")
    .addFields(
      { name: "Type", value: as, inline: true },
      { name: "Identity", value: who, inline: true },
      { name: "Duration", value: `${days} day${days === 1 ? "" : "s"}`, inline: true },
      { name: "Expires", value: formatBanUntil(until), inline: false },
    );
}

export function buildUnbanEmbed({ as, who }) {
  return new EmbedBuilder()
    .setColor(0x22c55e)
    .setTitle("MQTT Ban Removed")
    .addFields(
      { name: "Type", value: as, inline: true },
      { name: "Identity", value: who, inline: true },
    );
}

export function buildBanListEmbed({ bans, meta }) {
  const count = meta?.count ?? bans.length;
  const page = meta?.page ?? 1;
  const limit = meta?.limit ?? bans.length;

  if (bans.length === 0) {
    return new EmbedBuilder()
      .setColor(0x6b7280)
      .setTitle("MQTT Active Bans")
      .setDescription("No active bans.");
  }

  const lines = bans.map((ban, index) => {
    const who = truncateWho(ban.who);
    const until = formatBanUntil(ban.until);
    return `${index + 1}. \`${who}\` (${ban.as}) — ${until}`;
  });

  let value = "";
  for (const line of lines) {
    if (`${value}${line}\n`.length > 1000) {
      break;
    }
    value += `${line}\n`;
  }

  const embed = new EmbedBuilder()
    .setColor(0xf97316)
    .setTitle("MQTT Active Bans")
    .setDescription(value.trim());

  // Only show pagination metadata when there are multiple pages or a non-default page
  const hasMultiplePages = count > limit || page > 1;
  if (hasMultiplePages) {
    embed.addFields(
      { name: "Showing", value: `${bans.length} of ${count}`, inline: true },
      { name: "Page", value: String(page), inline: true },
      { name: "Page Size", value: String(limit), inline: true },
    );
  }

  return embed;
}

export function summarizeCommandResult(result) {
  if (result?.[SENSITIVE_RESULT]) {
    return {
      kind: result[SENSITIVE_RESULT],
    };
  }

  if (typeof result === "string") {
    return {
      kind: "text",
      reply_preview: result.slice(0, 250),
    };
  }

  if (result && typeof result.toJSON === "function") {
    const json = result.toJSON();
    return {
      kind: "embed",
      title: json.title ?? null,
      description_preview: typeof json.description === "string"
        ? json.description.slice(0, 250)
        : null,
    };
  }

  return {
    kind: typeof result,
  };
}
