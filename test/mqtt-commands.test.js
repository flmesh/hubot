import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { clearMqttCollectionsOverrideForTests, setMqttCollectionsOverrideForTests } from "../scripts/lib/mqtt-db.js";
import { registerMqttCommands } from "../scripts/mqtt.js";

function createCommandRegistry() {
  const emitter = new EventEmitter();
  const registered = new Map();
  emitter.register = (spec) => {
    registered.set(spec.id, spec);
    return spec;
  };
  emitter.pendingProposals = new Map();
  emitter.registered = registered;
  return emitter;
}

function createRobot() {
  const dmMessages = [];
  const fetchedUserDmMessages = [];

  return {
    dmMessages,
    fetchedUserDmMessages,
    logger: {
      info() {},
      warn() {},
    },
    adapter: {
      client: {
        users: {
          async fetch() {
            return {
              async send(text) {
                fetchedUserDmMessages.push(text);
              },
            };
          },
        },
      },
    },
    commands: createCommandRegistry(),
  };
}

function createContext({
  args = {},
  guildId = "929659839196561419",
  roleNames = [],
  userId = "505598218306977793",
  username = "kq4afy.radio",
  globalName = "Jeremy",
  dmMessages = [],
} = {}) {
  return {
    args,
    context: {
      room: guildId ? "929659840899473426" : "1490487701319974912",
      message: {
        user: {
          id: userId,
          name: username,
          message: {
            guildId,
            channelId: guildId ? "929659840899473426" : "1490487701319974912",
            author: {
              id: userId,
              username,
              discriminator: "0",
              globalName,
              async send(text) {
                dmMessages.push(text);
              },
            },
            member: guildId ? {
              roles: roleNames.map((name, index) => ({
                id: String(index + 1),
                name,
              })),
            } : null,
          },
        },
      },
    },
  };
}

function createCollections() {
  const state = {
    users: [],
    profiles: [
      {
        name: "default",
        status: "active",
        is_default: true,
        rules: [
          { permission: "deny", action: "all", topics: ["msh/US/FL/LWS/#"] },
          { permission: "allow", action: "all", topics: ["msh/US/FL/#"] },
        ],
      },
      {
        name: "lonewolf",
        status: "active",
        is_default: false,
        rules: [
          { permission: "allow", action: "all", topics: ["msh/US/FL/LWS/#"] },
        ],
      },
    ],
    mqttAcl: [],
    requests: [],
    usernamePolicy: [
      {
        _id: "default",
        pattern: "^[a-z][a-z0-9_-]{2,23}$",
        min_length: 3,
        max_length: 24,
        reserved_usernames: [],
        banned_substrings: ["bridge"],
      },
    ],
    mqttAudit: [],
  };

  function matches(document, filter) {
    return Object.entries(filter).every(([key, value]) => document?.[key] === value);
  }

  return {
    state,
    users: {
      async findOne(filter) {
        return state.users.find((entry) => matches(entry, filter)) ?? null;
      },
      async insertOne(document) {
        const stored = { ...document, _id: document._id ?? `${state.users.length + 1}` };
        state.users.push(stored);
        return { insertedId: stored._id };
      },
      async updateOne(filter, update) {
        const doc = state.users.find((entry) => matches(entry, filter));
        if (!doc) {
          return { matchedCount: 0, modifiedCount: 0 };
        }
        Object.assign(doc, update.$set ?? {});
        return { matchedCount: 1, modifiedCount: 1 };
      },
      async deleteOne(filter) {
        const index = state.users.findIndex((entry) => matches(entry, filter));
        if (index >= 0) {
          state.users.splice(index, 1);
        }
      },
    },
    profiles: {
      async findOne(filter) {
        return state.profiles.find((entry) => matches(entry, filter)) ?? null;
      },
    },
    mqttAcl: {
      async insertMany(documents) {
        state.mqttAcl.push(...documents);
      },
      async deleteMany(filter) {
        state.mqttAcl = state.mqttAcl.filter((entry) => !matches(entry, filter));
      },
    },
    requests: {
      async findOne(filter) {
        return state.requests.find((entry) => matches(entry, filter)) ?? null;
      },
      async insertOne(document) {
        state.requests.push(document);
      },
    },
    usernamePolicy: {
      async findOne(filter) {
        return state.usernamePolicy.find((entry) => matches(entry, filter)) ?? null;
      },
    },
    mqttAudit: {
      async insertOne(document) {
        state.mqttAudit.push(document);
      },
    },
  };
}

function setup() {
  const robot = createRobot();
  const collections = createCollections();
  process.env.MQTT_ADMIN_ROLE_NAMES = "Mesh Admin";
  setMqttCollectionsOverrideForTests(async () => collections);
  registerMqttCommands(robot);
  return {
    robot,
    collections,
    commands: robot.commands.registered,
  };
}

test.afterEach(() => {
  clearMqttCollectionsOverrideForTests();
  delete process.env.MQTT_ADMIN_ROLE_NAMES;
});

test("mqtt.request provisions an account, applies the default profile, and DMs credentials", async () => {
  const { robot, collections, commands } = setup();
  const ctx = createContext({
    args: { username: "jbouse" },
    guildId: null,
    dmMessages: robot.dmMessages,
  });

  const reply = await commands.get("mqtt.request").handler(ctx);

  assert.match(reply, /MQTT account created\./);
  assert.equal(collections.state.users.length, 1);
  assert.equal(collections.state.users[0].username, "jbouse");
  assert.equal(collections.state.users[0].profile, "default");
  assert.equal(collections.state.requests.length, 1);
  assert.equal(collections.state.requests[0].status, "approved");
  assert.equal(collections.state.mqttAcl.length, 2);
  assert.equal(collections.state.mqttAudit.length, 2);
  assert.deepEqual(
    collections.state.mqttAudit.map((entry) => entry.phase),
    ["attempted", "succeeded"],
  );
});

test("mqtt.my-account reports when the caller has no account", async () => {
  const { commands } = setup();
  const ctx = createContext({ guildId: null });

  const reply = await commands.get("mqtt.my-account").handler(ctx);

  assert.equal(reply, "mqtt command failed: you do not have an MQTT account");
});

test("mqtt.rotate rotates the caller password for an active account", async () => {
  const { robot, collections, commands } = setup();
  collections.state.users.push({
    _id: "1",
    username: "jbouse",
    profile: "default",
    status: "active",
    discord_user_id: "505598218306977793",
    created_at: new Date("2026-04-19T00:00:00.000Z"),
  });

  const ctx = createContext({
    guildId: null,
    dmMessages: robot.dmMessages,
  });

  const reply = await commands.get("mqtt.rotate").handler(ctx);

  assert.match(reply, /MQTT account rotated\./);
  assert.ok(collections.state.users[0].password_hash);
  assert.ok(collections.state.users[0].salt);
});

test("mqtt.rotate with username is admin-only and DMs the account owner on success", async () => {
  const { robot, collections, commands } = setup();
  collections.state.users.push({
    _id: "1",
    username: "jbouse",
    profile: "default",
    status: "active",
    discord_user_id: "600",
    discord_tag: "jbouse",
    created_at: new Date("2026-04-19T00:00:00.000Z"),
  });

  const deniedReply = await commands.get("mqtt.rotate").handler(createContext({
    args: { username: "jbouse" },
    roleNames: [],
  }));
  assert.equal(deniedReply, "mqtt command failed: you are not allowed to run this command");

  const allowedReply = await commands.get("mqtt.rotate").handler(createContext({
    args: { username: "jbouse" },
    roleNames: ["Mesh Admin"],
  }));
  assert.equal(
    allowedReply,
    "Password rotated for jbouse. I sent the new credentials to the account owner via DM.",
  );
  assert.equal(robot.fetchedUserDmMessages.length, 1);
});

test("mqtt.whois returns account details for admins", async () => {
  const { collections, commands } = setup();
  collections.state.users.push({
    _id: "1",
    username: "jbouse",
    profile: "default",
    status: "active",
    discord_user_id: "600",
    discord_tag: "jbouse",
    created_at: new Date("2026-04-19T00:00:00.000Z"),
  });

  const reply = await commands.get("mqtt.whois").handler(createContext({
    args: { username: "jbouse" },
    roleNames: ["Mesh Admin"],
  }));

  assert.match(reply, /Username: jbouse/);
  assert.match(reply, /Discord User ID: 600/);
});

test("mqtt.disable and mqtt.enable update account status for admins", async () => {
  const { collections, commands } = setup();
  collections.state.users.push({
    _id: "1",
    username: "jbouse",
    profile: "default",
    status: "active",
    discord_user_id: "600",
    created_at: new Date("2026-04-19T00:00:00.000Z"),
  });

  const disableReply = await commands.get("mqtt.disable").handler(createContext({
    args: { username: "jbouse" },
    roleNames: ["Mesh Admin"],
  }));
  assert.equal(disableReply, "MQTT account jbouse is now disabled.");
  assert.equal(collections.state.users[0].status, "disabled");

  const enableReply = await commands.get("mqtt.enable").handler(createContext({
    args: { username: "jbouse" },
    roleNames: ["Mesh Admin"],
  }));
  assert.equal(enableReply, "MQTT account jbouse is now active.");
  assert.equal(collections.state.users[0].status, "active");
});

test("mqtt.set-profile replaces profile-managed ACLs and updates the stored profile", async () => {
  const { collections, commands } = setup();
  collections.state.users.push({
    _id: "1",
    username: "jbouse",
    profile: "default",
    status: "active",
    discord_user_id: "600",
    created_at: new Date("2026-04-19T00:00:00.000Z"),
  });
  collections.state.mqttAcl.push({
    username: "jbouse",
    permission: "deny",
    action: "all",
    topics: ["msh/US/FL/LWS/#"],
    source_profile: "default",
    managed_by: "hubot-profile",
  });

  const reply = await commands.get("mqtt.set-profile").handler(createContext({
    args: { username: "jbouse", profile: "lonewolf" },
    roleNames: ["Mesh Admin"],
  }));

  assert.equal(reply, "MQTT account jbouse is now assigned to profile lonewolf.");
  assert.equal(collections.state.users[0].profile, "lonewolf");
  assert.equal(collections.state.mqttAcl.length, 1);
  assert.equal(collections.state.mqttAcl[0].source_profile, "lonewolf");
});
