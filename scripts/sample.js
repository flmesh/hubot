// Sample Hubot script - a good starting point for your own commands.
// Drop additional scripts in this directory and Hubot will load them
// automatically at startup.
//
// Commands:
//   hubot ping           - Replies with PONG
//   hubot info           - Shows runtime configuration info as an embed
//   hubot where am i     - Shows the current guild and channel name

import { EmbedBuilder } from "discord.js";
import packageMetadata from "../package.json" with { type: "json" };

const INFO_COLOR = 0x2563eb;

export function buildInfoEmbed(robot) {
  return new EmbedBuilder()
    .setColor(INFO_COLOR)
    .setTitle(`${robot.name} Runtime Info`)
    .addFields(
      { name: "Name", value: String(robot.name ?? "unknown"), inline: true },
      { name: "Version", value: String(packageMetadata.version), inline: true },
      { name: "Adapter", value: String(robot.adapterName ?? "unknown"), inline: true },
      { name: "Node", value: process.version, inline: true },
      { name: "Uptime", value: `${Math.floor(process.uptime())}s`, inline: true },
    )
    .setTimestamp(new Date());
}

export default (robot) => {
  // Respond to "<botname> ping" in any channel the bot can read.
  robot.respond(/ping$/i, (msg) => {
    msg.reply("PONG");
  });

  // Show non-sensitive runtime information, useful for diagnosing deployments.
  robot.respond(/info$/i, (msg) => {
    msg.reply(buildInfoEmbed(robot));
  });

  // Verify that the bot can see the current channel / guild.
  robot.respond(/where am i\??$/i, (msg) => {
    const raw = msg.message.user?.message ?? msg.message.rawMessage;
    const inDm = !raw?.guildId;
    if (inDm) {
      const user =
        raw?.author?.globalName ?? raw?.author?.username ?? "unknown user";
      msg.reply(`I'm in **DM with ${user}**`);
      return;
    }

    const channel =
      raw?.channel?.name ?? raw?.channelId ?? msg.message.room ?? "unknown";
    const guild =
      raw?.guild?.name ?? raw?.guildId ?? "unknown guild";
    msg.reply(`I'm in **${guild}** › **#${channel}**`);
  });
};
