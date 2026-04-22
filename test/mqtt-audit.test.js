import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { installMqttAuditBridge, recordMqttAuditEvent, updateMqttAuditEvent } from "../scripts/lib/mqtt-audit.js";

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

test("recordMqttAuditEvent writes an audit document and returns the inserted id", async () => {
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
          return { insertedId: "audit-1" };
        },
      },
    },
  });

  const auditId = await recordMqttAuditEvent({
    robot,
    commandId: "mqtt.rotate",
    phase: "attempted",
    ctx: buildContext(),
    args: {},
    collections: {
      mqttAudit: {
        async insertOne() {
          return { insertedId: "audit-2" };
        },
      },
    },
  });

  assert.equal(auditId, "audit-2");
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].command_id, "mqtt.request");
  assert.equal(inserted[0].phase, "attempted");
  assert.equal(inserted[0].actor.discord_user_id, "505598218306977793");
  assert.equal(inserted[0].location.guild_id, "929659839196561419");
  assert.deepEqual(inserted[0].args, { username: "jbouse" });
});

test("updateMqttAuditEvent updates an existing audit document", async () => {
  const updates = [];
  const robot = {
    logger: {
      info() {},
      warn() {},
    },
  };

  const auditId = await updateMqttAuditEvent({
    robot,
    auditId: "audit-1",
    commandId: "mqtt.request",
    phase: "succeeded",
    result: { username: "jbouse" },
    metadata: { delivery: "discord-dm" },
    collections: {
      mqttAudit: {
        async updateOne(filter, update) {
          updates.push({ filter, update });
          return { matchedCount: 1, modifiedCount: 1 };
        },
      },
    },
  });

  assert.equal(auditId, "audit-1");
  assert.deepEqual(updates[0].filter, { _id: "audit-1" });
  assert.equal(updates[0].update.$set.phase, "succeeded");
  assert.deepEqual(updates[0].update.$set.result, { username: "jbouse" });
  assert.equal(updates[0].update.$set.metadata.delivery, "discord-dm");
  assert.ok(updates[0].update.$set.completed_at instanceof Date);
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
