// Shared DM delivery helpers for command responses.
//
// Description:
//   Send detailed command results to Discord DMs when commands are invoked in a
//   server channel.
//
// Commands:
//   None

function isDirectMessage(rawMessage) {
  return rawMessage?.guildId == null;
}

const DISCORD_MESSAGE_LIMIT = 2000;

function splitLongLine(line, limit) {
  const parts = [];
  let remaining = line;

  while (remaining.length > limit) {
    parts.push(remaining.slice(0, limit));
    remaining = remaining.slice(limit);
  }

  if (remaining.length > 0) {
    parts.push(remaining);
  }

  return parts;
}

function splitMessageForDiscord(text) {
  if (text.length <= DISCORD_MESSAGE_LIMIT) {
    return [text];
  }

  const lines = text.split("\n");
  const parts = [];
  let currentLines = [];
  let currentLength = 0;
  let activeFence = null;

  const reservedSuffixLength = () => (activeFence ? 4 : 0);
  const projectedLengthWith = (line) => {
    const lineLength = currentLines.length === 0
      ? line.length
      : line.length + 1;
    return currentLength + lineLength + reservedSuffixLength();
  };

  const pushCurrentPart = () => {
    if (currentLines.length === 0) {
      return;
    }

    const outputLines = [...currentLines];
    if (activeFence) {
      outputLines.push("```");
    }

    parts.push(outputLines.join("\n"));
    currentLines = [];
    currentLength = 0;

    if (activeFence) {
      currentLines.push(activeFence);
      currentLength = activeFence.length;
    }
  };

  for (const line of lines) {
    const lineParts = line.length > DISCORD_MESSAGE_LIMIT
      ? splitLongLine(line, DISCORD_MESSAGE_LIMIT)
      : [line];

    for (const linePart of lineParts) {
      if (projectedLengthWith(linePart) > DISCORD_MESSAGE_LIMIT) {
        pushCurrentPart();
      }

      if (projectedLengthWith(linePart) > DISCORD_MESSAGE_LIMIT) {
        parts.push(linePart);
        continue;
      }

      currentLines.push(linePart);
      currentLength += currentLines.length === 1 ? linePart.length : linePart.length + 1;

      if (/^```/.test(linePart)) {
        activeFence = activeFence ? null : linePart;
      }
    }
  }

  pushCurrentPart();
  return parts;
}

export function installDiscordMessageSplitter(robot) {
  if (!robot?.adapter) {
    return;
  }

  robot.adapter.breakUpMessage = (text) => splitMessageForDiscord(String(text ?? ""));
}

async function sendDirectMessage(robot, rawMessage, text) {
  const parts = splitMessageForDiscord(text);

  for (const part of parts) {
    await rawMessage.author.send(part);
  }
}

async function sendDirectEmbed(rawMessage, embed) {
  await rawMessage.author.send({ embeds: [embed] });
}

async function sendDirectMessageToUser(user, text) {
  const parts = splitMessageForDiscord(text);

  for (const part of parts) {
    await user.send(part);
  }
}

export async function deliverDirectMessageToUserId({ robot, userId, text, commandName }) {
  if (!userId) {
    throw new Error(`${commandName} DM delivery failed: missing Discord user ID`);
  }

  const client = robot?.adapter?.client;
  if (!client?.users?.fetch) {
    throw new Error(`${commandName} DM delivery failed: Discord client is unavailable`);
  }

  const user = await client.users.fetch(String(userId));
  await sendDirectMessageToUser(user, text);
}

export async function deliverPossiblyViaDm({ robot, ctx, text, commandName }) {
  const rawMessage = ctx?.context?.message?.user?.message;
  if (!rawMessage || isDirectMessage(rawMessage)) {
    return text;
  }

  try {
    await sendDirectMessage(robot, rawMessage, text);
    return `I sent the ${commandName} results to you in a DM.`;
  } catch (error) {
    robot.logger.warn(`${commandName} DM delivery failed: ${error.message}`);
    return `I couldn't send you a DM for ${commandName}. Please enable DMs from server members or message me directly.`;
  }
}

export async function deliverEmbedPossiblyViaDm({ robot, ctx, embed, commandName }) {
  const rawMessage = ctx?.context?.message?.user?.message;
  if (!rawMessage || isDirectMessage(rawMessage)) {
    return embed;
  }

  try {
    await sendDirectEmbed(rawMessage, embed);
    return `I sent the ${commandName} results to you in a DM.`;
  } catch (error) {
    robot.logger.warn(`${commandName} DM delivery failed: ${error.message}`);
    return `I couldn't send you a DM for ${commandName}. Please enable DMs from server members or message me directly.`;
  }
}

export default (robot) => {
  installDiscordMessageSplitter(robot);
};
