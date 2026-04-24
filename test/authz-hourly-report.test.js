import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { EmbedBuilder } from "discord.js";

import installAuthzHourlyReport from "../scripts/authz-hourly-report.js";

function createCommandRegistry() {
  const emitter = new EventEmitter();
  const registered = new Map();
  emitter.register = (spec) => {
    registered.set(spec.id, spec);
    return spec;
  };
  emitter.registered = registered;
  return emitter;
}

function createRobot() {
  const channelMessages = [];

  return {
    channelMessages,
    logger: {
      error() {},
      info() {},
      warn() {},
    },
    adapter: {
      client: {
        channels: {
          async fetch(channelId) {
            assert.equal(channelId, "929659840899473426");
            return {
              async send(message) {
                channelMessages.push(message);
              },
            };
          },
        },
      },
    },
    commands: createCommandRegistry(),
  };
}

function createContext({ guildId = null } = {}) {
  return {
    context: {
      message: {
        user: {
          message: {
            guildId,
          },
        },
      },
    },
  };
}

function installWithMocks(robot) {
  const previousEnv = {
    HUBOT_AUTHZ_REPORT_ENABLED: process.env.HUBOT_AUTHZ_REPORT_ENABLED,
    HUBOT_AUTHZ_REPORT_CHANNEL_ID: process.env.HUBOT_AUTHZ_REPORT_CHANNEL_ID,
    HUBOT_AUTHZ_REPORT_SEND_EMPTY: process.env.HUBOT_AUTHZ_REPORT_SEND_EMPTY,
    LOKI_URL: process.env.LOKI_URL,
  };
  const previousFetch = global.fetch;
  const previousSetTimeout = global.setTimeout;
  const previousClearTimeout = global.clearTimeout;

  process.env.HUBOT_AUTHZ_REPORT_ENABLED = "true";
  process.env.HUBOT_AUTHZ_REPORT_CHANNEL_ID = "929659840899473426";
  delete process.env.HUBOT_AUTHZ_REPORT_SEND_EMPTY;
  process.env.LOKI_URL = "http://loki.example";

  global.fetch = async () => ({
    ok: true,
    async json() {
      return {
        status: "success",
        data: {
          resultType: "vector",
          result: [
            {
              metric: {
                topic: "msh/US/FL/LWS/2/json",
                username: "jbouse",
              },
              value: [1776816502, "3"],
            },
          ],
        },
      };
    },
  });
  global.setTimeout = () => ({ mocked: true });
  global.clearTimeout = () => {};

  installAuthzHourlyReport(robot);

  return () => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    global.fetch = previousFetch;
    global.setTimeout = previousSetTimeout;
    global.clearTimeout = previousClearTimeout;
  };
}

test("authz.report.now returns report embed directly when invoked from DM", async () => {
  const robot = createRobot();
  const restore = installWithMocks(robot);

  try {
    const reply = await robot.commands.registered.get("authz.report.now").handler(createContext({ guildId: null }));

    assert.ok(reply instanceof EmbedBuilder);
    assert.equal(robot.channelMessages.length, 0);
    assert.equal(reply.toJSON().title, "MQTT Authorization Denial Summary");
  } finally {
    restore();
  }
});

test("authz.report.now still posts to configured channel when invoked from a guild", async () => {
  const robot = createRobot();
  const restore = installWithMocks(robot);

  try {
    const reply = await robot.commands.registered.get("authz.report.now").handler(createContext({
      guildId: "929659839196561419",
    }));

    assert.equal(reply, "Triggered authz.report run.");
    assert.equal(robot.channelMessages.length, 1);
    assert.ok(robot.channelMessages[0].embeds[0] instanceof EmbedBuilder);
  } finally {
    restore();
  }
});
