import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { installMqttAuditBridge, recordMqttAuditEvent } from "../scripts/lib/mqtt-audit.js";

function buildContext() {
  return {
    args: { username: "jbouse" },
    context: {
      room: "929659840899473426",
      message: {
        user: {
          id: "505598218306977793",
          name: "kq4afy.radio",
          message: {
            guildId: "929659839196561419",
            channelId: "929659840899473426",
            author: {
              id: "505598218306977793",
              username: "kq4afy.radio",
              discriminator: "0",
              globalName: "Jeremy",
            },
          },
        },
      },
    },
  };
}

test("recordMqttAuditEvent writes an audit document", async () => {
  const inserted = [];
  const robot = {
    logger: {
      info() {},
      warn() {},
    },
  };

  await recordMqttAuditEvent({
    robot,
    commandId: "mqtt.request",
    phase: "attempted",
    ctx: buildContext(),
    args: { username: "jbouse" },
    collections: {
      mqttAudit: {
        async insertOne(document) {
          inserted.push(document);
        },
      },
    },
  });

  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].command_id, "mqtt.request");
  assert.equal(inserted[0].phase, "attempted");
  assert.equal(inserted[0].actor.discord_user_id, "505598218306977793");
  assert.equal(inserted[0].location.guild_id, "929659839196561419");
  assert.deepEqual(inserted[0].args, { username: "jbouse" });
});

test("installMqttAuditBridge records confirm workflow phases", async () => {
  const events = [];
  const commands = new EventEmitter();
  commands.pendingProposals = new Map();

  const robot = {
    commands,
    logger: {
      info() {},
      warn() {},
    },
  };

  installMqttAuditBridge(robot, {
    recordEvent: async (event) => {
      events.push(event);
    },
  });

  const pendingContext = buildContext();
  commands.pendingProposals.set("abc123", {
    args: { username: "jbouse" },
    context: pendingContext.context,
  });

  commands.emit("commands:proposal_created", {
    commandId: "mqtt.disable",
    confirmationKey: "abc123",
  });
  await new Promise((resolve) => setImmediate(resolve));

  commands.emit("commands:proposal_confirmed", {
    commandId: "mqtt.disable",
    confirmationKey: "abc123",
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    events.map((event) => event.phase),
    ["confirm_requested", "confirmed"],
  );
  assert.equal(events[0].args.username, "jbouse");
});
