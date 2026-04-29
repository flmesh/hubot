import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { EmbedBuilder } from "discord.js";

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
  const fetchedGuildMembers = new Map();

  return {
    dmMessages,
    fetchedUserDmMessages,
    fetchedGuildMembers,
    logger: {
      info() {},
      warn() {},
    },
    adapter: {
      client: {
        once() {},
        guilds: {
          async fetch() {
            return {
              id: "929659839196561419",
              name: "Test Guild",
              members: {
                async fetch(userId) {
                  return fetchedGuildMembers.get(String(userId)) ?? null;
                },
              },
            };
          },
        },
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
  roleIds = [],
  userId = "505598218306977793",
  username = "kq4afy.radio",
  globalName = "Jeremy",
  dmMessages = [],
  dmError = null,
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
              async send(message) {
                if (dmError) {
                  throw dmError;
                }
                dmMessages.push(message);
              },
            },
            member: guildId ? {
              roles: roleIds.map((id) => ({ id: String(id) })),
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
          {
            permission: "deny",
            who: { username: "${username}" },
            action: { type: "all" },
            topics: [{ match: "filter", value: "msh/US/FL/LWS/#" }],
          },
          {
            permission: "allow",
            who: { username: "${username}" },
            action: { type: "all" },
            topics: [{ match: "filter", value: "msh/US/FL/#" }],
          },
        ],
      },
      {
        name: "lonewolf",
        status: "active",
        is_default: false,
        rules: [
          {
            permission: "allow",
            who: { username: "${username}" },
            action: { type: "all" },
            topics: [{ match: "filter", value: "msh/US/FL/LWS/#" }],
          },
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

  function buildCursor(documents) {
    return {
      sort(sortSpec) {
        const [[field, direction]] = Object.entries(sortSpec);
        const multiplier = direction >= 0 ? 1 : -1;
        const sorted = [...documents].sort((left, right) => {
          if (left?.[field] === right?.[field]) {
            return 0;
          }
          return left?.[field] > right?.[field] ? multiplier : -multiplier;
        });
        return buildCursor(sorted);
      },
      async toArray() {
        return [...documents];
      },
    };
  }

  return {
    state,
    profiles: {
      async findOne(filter) {
        return state.profiles.find((entry) => matches(entry, filter)) ?? null;
      },
      find(filter = {}) {
        return buildCursor(state.profiles.filter((entry) => matches(entry, filter)));
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
      async deleteOne(filter) {
        const index = state.requests.findIndex((entry) => matches(entry, filter));
        if (index >= 0) {
          state.requests.splice(index, 1);
        }
      },
    },
    usernamePolicy: {
      async findOne(filter) {
        return state.usernamePolicy.find((entry) => matches(entry, filter)) ?? null;
      },
    },
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
      find(filter = {}) {
        return buildCursor(state.users.filter((entry) => matches(entry, filter)));
      },
    },
    mqttAudit: {
      async insertOne(document) {
        const stored = { ...document, _id: document._id ?? `${state.mqttAudit.length + 1}` };
        state.mqttAudit.push(stored);
        return { insertedId: stored._id };
      },
      async updateOne(filter, update) {
        const doc = state.mqttAudit.find((entry) => matches(entry, filter));
        if (!doc) {
          return { matchedCount: 0, modifiedCount: 0 };
        }
        Object.assign(doc, update.$set ?? {});
        return { matchedCount: 1, modifiedCount: 1 };
      },
    },
  };
}

function setup() {
  const robot = createRobot();
  const collections = createCollections();
  process.env.MQTT_ADMIN_ROLE_IDS = "1";
  process.env.MQTT_ADMIN_GUILD_ID = "929659839196561419";
  setMqttCollectionsOverrideForTests(async () => collections);
  registerMqttCommands(robot);
  return {
    robot,
    collections,
    commands: robot.commands.registered,
  };
}

const MQTT_ADMIN_COMMAND_IDS = [
  "mqtt.reset",
  "mqtt.whois",
  "mqtt.disable",
  "mqtt.enable",
  "mqtt.profile.set",
  "mqtt.profile.list",
  "mqtt.profile.show",
  "mqtt.profile.apply",
];

test.afterEach(() => {
  clearMqttCollectionsOverrideForTests();
  delete process.env.MQTT_ADMIN_ROLE_IDS;
  delete process.env.MQTT_ADMIN_GUILD_ID;
  delete process.env.EMQX_API_URL;
  delete process.env.EMQX_API_KEY;
  delete process.env.EMQX_API_SECRET;
});

test("MQTT admin commands declare command-bus role permissions", () => {
  const { robot, commands } = setup();

  assert.ok(robot.commands.permissionProvider?.hasRole);
  for (const commandId of MQTT_ADMIN_COMMAND_IDS) {
    assert.deepEqual(commands.get(commandId).permissions, {
      roles: ["env:MQTT_ADMIN_ROLE_IDS"],
    });
  }

  assert.equal(commands.get("mqtt.request").permissions, undefined);
  assert.equal(commands.get("mqtt.my-account").permissions, undefined);
  assert.equal(commands.get("mqtt.rotate").permissions, undefined);
});

test("mqtt.request provisions an account, applies the default profile, and DMs credentials", async () => {
  const { robot, collections, commands } = setup();
  const ctx = createContext({
    args: { username: "jbouse" },
    guildId: null,
    dmMessages: robot.dmMessages,
  });

  const reply = await commands.get("mqtt.request").handler(ctx);

  assert.ok(reply instanceof EmbedBuilder);
  const embed = reply.toJSON();
  assert.equal(embed.title, "MQTT Account created");
  assert.equal(embed.fields.find((field) => field.name === "Username")?.value, "jbouse");
  assert.ok(embed.fields.find((field) => field.name === "Password")?.value);
  assert.equal(collections.state.users.length, 1);
  assert.equal(collections.state.users[0].username, "jbouse");
  assert.equal(collections.state.users[0].profile, "default");
  assert.equal(collections.state.requests.length, 1);
  assert.equal(collections.state.requests[0].status, "approved");
  assert.equal(collections.state.mqttAcl.length, 2);
  assert.equal(collections.state.mqttAudit.length, 1);
  assert.equal(collections.state.mqttAudit[0].phase, "succeeded");
  assert.deepEqual(collections.state.mqttAudit[0].result, { kind: "credential_delivery" });
  assert.doesNotMatch(JSON.stringify(collections.state.mqttAudit[0]), /Password/i);
  assert.ok(collections.state.mqttAudit[0].completed_at);
});

test("mqtt.request rolls back the account when credential DM delivery fails", async () => {
  const { robot, collections, commands } = setup();
  const ctx = createContext({
    args: { username: "holmebrian" },
    dmMessages: robot.dmMessages,
    dmError: new Error("Cannot send messages to this user due to having no mutual guilds"),
  });

  const reply = await commands.get("mqtt.request").handler(ctx);

  assert.equal(
    reply,
    "mqtt command failed: couldn't send credentials by DM, so no MQTT account was created. Please enable DMs from server members or message me directly, then retry",
  );
  assert.equal(collections.state.users.length, 0);
  assert.equal(collections.state.requests.length, 0);
  assert.equal(collections.state.mqttAcl.length, 0);
  assert.equal(collections.state.mqttAudit.length, 1);
  assert.equal(collections.state.mqttAudit[0].phase, "failed");
  assert.match(collections.state.mqttAudit[0].error.message, /couldn't send credentials by DM/);
});

test("mqtt.my-account reports when the caller has no account", async () => {
  const { commands } = setup();
  const ctx = createContext({ guildId: null });

  const reply = await commands.get("mqtt.my-account").handler(ctx);

  assert.equal(reply, "mqtt command failed: you do not have an MQTT account");
});

test("mqtt.my-account returns an embed for an existing account", async () => {
  const { collections, commands } = setup();
  collections.state.users.push({
    _id: "1",
    username: "jbouse",
    profile: "default",
    status: "active",
    discord_user_id: "505598218306977793",
    created_at: new Date("2026-04-19T00:00:00.000Z"),
  });

  const reply = await commands.get("mqtt.my-account").handler(createContext({ guildId: null }));

  assert.ok(reply instanceof EmbedBuilder);
  const embed = reply.toJSON();
  assert.equal(embed.title, "MQTT Account");
  assert.equal(embed.fields.find((field) => field.name === "Username")?.value, "jbouse");
  assert.ok(embed.timestamp);
});

test("mqtt.my-account includes active MQTT client connections", async () => {
  const previousFetch = global.fetch;
  process.env.EMQX_API_URL = "http://emqx:18083";
  process.env.EMQX_API_KEY = "testkey";
  process.env.EMQX_API_SECRET = "testsecret";
  global.fetch = async (url, options) => ({
    ok: true,
    status: 200,
    async json() {
      return {
        data: [
          {
            clientid: "MeshtasticAndroidMqttProxy-!deadbeef",
            username: "jbouse",
            connected: true,
            connected_at: "2026-04-29T12:00:00.000+00:00",
          },
        ],
        meta: { count: 1, page: 1, limit: 10 },
      };
    },
  });

  try {
    const { collections, commands } = setup();
    collections.state.users.push({
      _id: "1",
      username: "jbouse",
      profile: "default",
      status: "active",
      discord_user_id: "505598218306977793",
      created_at: new Date("2026-04-19T00:00:00.000Z"),
    });

    const reply = await commands.get("mqtt.my-account").handler(createContext({ guildId: null }));

    assert.ok(reply instanceof EmbedBuilder);
    const embed = reply.toJSON();
    const connections = embed.fields.find((field) => field.name === "Active Connections")?.value ?? "";
    assert.match(connections, /1 active/);
    assert.match(connections, /MeshtasticAndroidMqttProxy-!deadbeef/);
    assert.match(connections, /<t:1777464000:f>/);
  } finally {
    global.fetch = previousFetch;
  }
});

test("mqtt.my-account DMs account details when invoked in a server", async () => {
  const { robot, collections, commands } = setup();
  collections.state.users.push({
    _id: "1",
    username: "jbouse",
    profile: "default",
    status: "active",
    discord_user_id: "505598218306977793",
    created_at: new Date("2026-04-19T00:00:00.000Z"),
  });

  const reply = await commands.get("mqtt.my-account").handler(createContext({
    dmMessages: robot.dmMessages,
  }));

  assert.equal(reply, "I sent the mqtt.my-account results to you in a DM.");
  assert.equal(robot.dmMessages.length, 1);
  assert.equal(robot.dmMessages[0].embeds.length, 1);
  assert.equal(robot.dmMessages[0].embeds[0].toJSON().title, "MQTT Account");
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

  assert.ok(reply instanceof EmbedBuilder);
  const embed = reply.toJSON();
  assert.equal(embed.title, "MQTT Account rotated");
  assert.equal(embed.fields.find((field) => field.name === "Username")?.value, "jbouse");
  assert.ok(embed.fields.find((field) => field.name === "Password")?.value);
  assert.deepEqual(collections.state.mqttAudit[0].result, { kind: "credential_delivery" });
  assert.doesNotMatch(JSON.stringify(collections.state.mqttAudit[0]), /Password/i);
  assert.ok(collections.state.users[0].password_hash);
  assert.ok(collections.state.users[0].salt);
});

test("mqtt.reset is admin-only and DMs the account owner on success", async () => {
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

  const command = commands.get("mqtt.reset");
  const deniedCtx = createContext({
    args: { username: "jbouse" },
    roleIds: [],
  });
  assert.equal(await robot.commands.permissionProvider.hasRole(
    deniedCtx.context.message.user,
    command.permissions.roles,
    deniedCtx.context,
  ), false);

  const allowedReply = await command.handler(createContext({
    args: { username: "jbouse" },
    roleIds: ["1"],
  }));
  assert.equal(
    allowedReply,
    "Password reset for jbouse. I sent the new credentials to the account owner via DM.",
  );
  assert.equal(robot.fetchedUserDmMessages.length, 1);
  assert.equal(robot.fetchedUserDmMessages[0].embeds.length, 1);
  assert.equal(robot.fetchedUserDmMessages[0].embeds[0].toJSON().title, "MQTT Account rotated");
});

test("mqtt.whois DMs account details when invoked by an admin in a server", async () => {
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

  const reply = await commands.get("mqtt.whois").handler(createContext({
    args: { username: "jbouse" },
    roleIds: ["1"],
    dmMessages: robot.dmMessages,
  }));

  assert.equal(reply, "I sent the mqtt.whois results to you in a DM.");
  assert.equal(robot.dmMessages.length, 1);
  assert.equal(robot.dmMessages[0].embeds.length, 1);
  const embed = robot.dmMessages[0].embeds[0].toJSON();
  assert.equal(embed.title, "MQTT Account: jbouse");
  assert.equal(embed.fields.find((field) => field.name === "Owner")?.value, "<@600>");
  assert.ok(embed.timestamp);
});

test("mqtt.whois includes active MQTT client connections for admins", async () => {
  const previousFetch = global.fetch;
  process.env.EMQX_API_URL = "http://emqx:18083";
  process.env.EMQX_API_KEY = "testkey";
  process.env.EMQX_API_SECRET = "testsecret";
  global.fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        data: [
          {
            clientid: "MeshtasticPythonMqttProxy-!cafebabe",
            username: "jbouse",
            connected: true,
            connected_at: "2026-04-29T14:26:52.012+00:00",
          },
        ],
        meta: { count: 1, page: 1, limit: 10 },
      };
    },
  });

  try {
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
      guildId: null,
      roleIds: ["1"],
    }));

    assert.ok(reply instanceof EmbedBuilder);
    const embed = reply.toJSON();
    const connections = embed.fields.find((field) => field.name === "Active Connections")?.value ?? "";
    assert.match(connections, /1 active/);
    assert.match(connections, /MeshtasticPythonMqttProxy-!cafebabe/);
    assert.match(connections, /<t:1777472812:f>/);
  } finally {
    global.fetch = previousFetch;
  }
});

test("mqtt.whois allows admin checks from DM by fetching configured guild membership", async () => {
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
  robot.fetchedGuildMembers.set("505598218306977793", {
    roles: {
      cache: new Map([["1", { id: "1" }]]),
    },
  });

  const ctx = createContext({
    args: { username: "jbouse" },
    guildId: null,
  });
  const command = commands.get("mqtt.whois");

  assert.equal(await robot.commands.permissionProvider.hasRole(
    ctx.context.message.user,
    command.permissions.roles,
    ctx.context,
  ), true);

  const reply = await command.handler(ctx);

  assert.ok(reply instanceof EmbedBuilder);
  const embed = reply.toJSON();
  assert.equal(embed.title, "MQTT Account: jbouse");
  assert.equal(embed.fields.find((field) => field.name === "Owner")?.value, "<@600>");
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
    roleIds: ["1"],
  }));
  assert.equal(disableReply, "MQTT account jbouse is now disabled.");
  assert.equal(collections.state.users[0].status, "disabled");

  const enableReply = await commands.get("mqtt.enable").handler(createContext({
    args: { username: "jbouse" },
    roleIds: ["1"],
  }));
  assert.equal(enableReply, "MQTT account jbouse is now active.");
  assert.equal(collections.state.users[0].status, "active");
});

test("mqtt.profile.set replaces profile-managed ACLs and updates the stored profile", async () => {
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

  const reply = await commands.get("mqtt.profile.set").handler(createContext({
    args: { username: "jbouse", profile: "lonewolf" },
    roleIds: ["1"],
  }));

  assert.equal(reply, "MQTT account jbouse is now assigned to profile lonewolf.");
  assert.equal(collections.state.users[0].profile, "lonewolf");
  assert.equal(collections.state.mqttAcl.length, 1);
  assert.equal(collections.state.mqttAcl[0].source_profile, "lonewolf");
});

test("mqtt.profile.list shows configured profiles for admins", async () => {
  const { commands } = setup();

  const reply = await commands.get("mqtt.profile.list").handler(createContext({
    roleIds: ["1"],
  }));

  assert.ok(reply instanceof EmbedBuilder);
  const embed = reply.toJSON();
  assert.equal(embed.title, "MQTT Profiles");
  assert.match(embed.description, /default/);
  assert.match(embed.description, /lonewolf/);
});

test("mqtt.profile.show returns metadata and rules for a profile", async () => {
  const { commands } = setup();

  const reply = await commands.get("mqtt.profile.show").handler(createContext({
    args: { profile: "default" },
    roleIds: ["1"],
  }));

  assert.ok(reply instanceof EmbedBuilder);
  const embed = reply.toJSON();
  assert.equal(embed.title, "MQTT Profile: default");
  assert.equal(embed.fields.find((field) => field.name === "Default")?.value, "yes");
  assert.match(embed.fields.find((field) => field.name === "Rules")?.value, /\{deny, \{user, "\$\{username\}"\}, all, \["msh\/US\/FL\/LWS\/#"\]\}\./);
});

test("mqtt.profile.apply reapplies the template to all users assigned to the profile", async () => {
  const { collections, commands } = setup();
  collections.state.users.push(
    {
      _id: "1",
      username: "jbouse",
      profile: "default",
      status: "active",
      discord_user_id: "600",
      created_at: new Date("2026-04-19T00:00:00.000Z"),
    },
    {
      _id: "2",
      username: "jsmith",
      profile: "default",
      status: "disabled",
      discord_user_id: "601",
      created_at: new Date("2026-04-19T00:00:00.000Z"),
    },
    {
      _id: "3",
      username: "lonewolf",
      profile: "lonewolf",
      status: "active",
      discord_user_id: "602",
      created_at: new Date("2026-04-19T00:00:00.000Z"),
    },
  );
  collections.state.mqttAcl.push(
    {
      username: "jbouse",
      permission: "allow",
      action: "all",
      topics: ["old/topic/#"],
      source_profile: "default",
      managed_by: "hubot-profile",
    },
    {
      username: "jsmith",
      permission: "allow",
      action: "all",
      topics: ["old/topic/#"],
      source_profile: "default",
      managed_by: "hubot-profile",
    },
    {
      username: "lonewolf",
      permission: "allow",
      action: "all",
      topics: ["msh/US/FL/LWS/#"],
      source_profile: "lonewolf",
      managed_by: "hubot-profile",
    },
  );

  const reply = await commands.get("mqtt.profile.apply").handler(createContext({
    args: { profile: "default" },
    roleIds: ["1"],
  }));

  assert.equal(reply, "Reapplied profile default to 2 MQTT accounts.");
  const defaultAclRows = collections.state.mqttAcl.filter((entry) => entry.source_profile === "default");
  assert.equal(defaultAclRows.length, 4);
  assert.ok(defaultAclRows.every((entry) => ["jbouse", "jsmith"].includes(entry.username)));
  assert.equal(collections.state.mqttAcl.filter((entry) => entry.source_profile === "lonewolf").length, 1);
});
