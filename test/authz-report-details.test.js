import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { EmbedBuilder } from "discord.js";

import installAuthzReportDetails from "../scripts/authz-report-details.js";

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
  const dmMessages = [];

  return {
    dmMessages,
    logger: {
      error() {},
      info() {},
      warn() {},
    },
    commands: createCommandRegistry(),
    adapter: {
      client: {},
    },
    createAuthor() {
      return {
        async send(message) {
          dmMessages.push(message);
        },
      };
    },
  };
}

function createContext({ robot, guildId = null, args = {} }) {
  return {
    args,
    context: {
      message: {
        user: {
          message: {
            guildId,
            author: robot.createAuthor(),
          },
        },
      },
    },
  };
}

function installWithMocks(robot, { result, onFetch } = {}) {
  const previousEnv = {
    HUBOT_AUTHZ_REPORT_LOOKBACK_MINUTES: process.env.HUBOT_AUTHZ_REPORT_LOOKBACK_MINUTES,
    LOKI_URL: process.env.LOKI_URL,
  };
  const previousFetch = global.fetch;

  process.env.HUBOT_AUTHZ_REPORT_LOOKBACK_MINUTES = "60";
  process.env.LOKI_URL = "http://loki.example";

  global.fetch = async (url) => {
    if (onFetch) {
      onFetch(url);
    }

    return {
      ok: true,
      async json() {
        return {
          status: "success",
          data: {
            resultType: "vector",
            result: result ?? [
              {
                metric: {
                  clientid: "MeshtasticPythonMqttProxy-a1b2c3d4",
                  username: "jbouse",
                  topic: "msh/US/FL/LWS/2/json",
                },
                value: [1776816502, "3"],
              },
              {
                metric: {
                  clientid: "!deadbeef",
                  username: "other",
                  topic: "msh/US/FL/test",
                },
                value: [1776816502, "1"],
              },
            ],
          },
        };
      },
    };
  };

  installAuthzReportDetails(robot);

  return () => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    global.fetch = previousFetch;
  };
}

test("authz.report.details returns embed with clientid+topic pairs in DM", async () => {
  const robot = createRobot();
  const restore = installWithMocks(robot);

  try {
    const reply = await robot.commands.registered.get("authz.report.details").handler(createContext({
      robot,
      guildId: null,
      args: {},
    }));

    assert.ok(reply instanceof EmbedBuilder);
    const json = reply.toJSON();
    assert.equal(json.title, "MQTT AUTHZ Denial Details");
    assert.match(json.description ?? "", /all clients/);
    const topPairs = json.fields.find((field) => field.name.includes("clientid+topic pairs"))?.value ?? "";
    assert.match(topPairs, /MeshtasticPythonMqttProxy-a1b2c3d4/);
    assert.match(topPairs, /msh\/US\/FL\/LWS\/2\/json/);
    assert.equal(topPairs.includes("jbouse"), false);
  } finally {
    restore();
  }
});

test("authz.report.details applies optional clientid filter to the Loki query", async () => {
  const robot = createRobot();
  let capturedQuery = null;
  const restore = installWithMocks(robot, {
    onFetch(url) {
      const parsed = new URL(url);
      capturedQuery = parsed.searchParams.get("query");
    },
  });

  try {
    const reply = await robot.commands.registered.get("authz.report.details").handler(createContext({
      robot,
      guildId: null,
      args: {
        clientid: "!deadbeef",
      },
    }));

    assert.ok(reply instanceof EmbedBuilder);
    const json = reply.toJSON();
    assert.match(json.description ?? "", /client !deadbeef/);
    const clientField = json.fields.find((field) => field.name === "Client")?.value ?? "";
    assert.equal(clientField, "!deadbeef");
    const usernameField = json.fields.find((field) => field.name === "Username")?.value ?? "";
    assert.match(usernameField, /other|jbouse/);
    const topicsField = json.fields.find((field) => String(field.name).startsWith("Topics"))?.value ?? "";
    assert.equal(topicsField.includes("msh/US/FL/test"), true);
    assert.equal(capturedQuery.includes('| clientid="!deadbeef"'), true);
  } finally {
    restore();
  }
});

test("authz.report.details sends results via DM when invoked from a guild", async () => {
  const robot = createRobot();
  const restore = installWithMocks(robot);

  try {
    const reply = await robot.commands.registered.get("authz.report.details").handler(createContext({
      robot,
      guildId: "929659839196561419",
      args: {},
    }));

    assert.equal(reply, "I sent the authz.report.details results to you in a DM.");
    assert.equal(robot.dmMessages.length, 1);
    assert.ok(robot.dmMessages[0].embeds?.[0] instanceof EmbedBuilder);
  } finally {
    restore();
  }
});