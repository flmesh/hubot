// Temporary Discord event debugging.
//
// Description:
//   Logs raw Discord message events when HUBOT_DISCORD_DEBUG_EVENTS is enabled.
//
// Commands:
//   None

export default (robot) => {
  if (!process.env.HUBOT_DISCORD_DEBUG_EVENTS) {
    return;
  }

  const client = robot.adapter?.client;
  if (!client) {
    robot.logger.warn("discord debug enabled but adapter client is unavailable");
    return;
  }

  client.on("messageCreate", (message) => {
    robot.logger.debug({
      msg: "discord messageCreate",
      guildId: message.guildId ?? null,
      channelId: message.channelId ?? null,
      authorId: message.author?.id ?? null,
      authorName: message.author?.username ?? null,
      isBot: Boolean(message.author?.bot),
      content: message.content ?? "",
    });
  });

  client.on("messageUpdate", (_oldMessage, newMessage) => {
    robot.logger.debug({
      msg: "discord messageUpdate",
      guildId: newMessage.guildId ?? null,
      channelId: newMessage.channelId ?? null,
      authorId: newMessage.author?.id ?? null,
      authorName: newMessage.author?.username ?? null,
      isBot: Boolean(newMessage.author?.bot),
      content: newMessage.content ?? "",
    });
  });

  robot.logger.debug("discord debug event hooks attached");
};
