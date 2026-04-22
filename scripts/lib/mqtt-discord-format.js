import { EmbedBuilder } from "discord.js";
import { formatProfileRuleAsEmqxSpec } from "./mqtt-rule-templates.js";

const MQTT_EMBED_COLOR = 0x1f6feb;

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
      { name: "Updated", value: isoOrUnknown(profile.updated_at), inline: true },
      { name: "Rules", value: ruleLines, inline: false },
    );

  if (profile.description) {
    embed.setDescription(profile.description);
  }

  return embed;
}

export function summarizeCommandResult(result) {
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
