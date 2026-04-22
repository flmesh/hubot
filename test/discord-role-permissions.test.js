import test from "node:test";
import assert from "node:assert/strict";

import {
  createDiscordRolePermissionProvider,
  installDiscordRolePermissionProvider,
} from "../scripts/lib/discord-role-permissions.js";

function createContext({ guildId = "929659839196561419", roleIds = [], userId = "505598218306977793" } = {}) {
  return {
    message: {
      user: {
        id: userId,
        message: {
          guildId,
          author: {
            id: userId,
          },
          member: guildId ? {
            roles: roleIds.map((id) => ({ id: String(id) })),
          } : null,
        },
      },
    },
  };
}

function createRobot() {
  const fetchedGuildMembers = new Map();

  return {
    fetchedGuildMembers,
    adapter: {
      client: {
        guilds: {
          async fetch(guildId) {
            assert.equal(guildId, "929659839196561419");
            return {
              members: {
                async fetch(userId) {
                  return fetchedGuildMembers.get(String(userId)) ?? null;
                },
              },
            };
          },
        },
      },
    },
    commands: {},
  };
}

test.afterEach(() => {
  delete process.env.MQTT_ADMIN_GUILD_ID;
  delete process.env.MQTT_ADMIN_ROLE_IDS;
  delete process.env.HUBOT_DISCORD_PERMISSION_GUILD_ID;
});

test("Discord role permission provider resolves env role IDs for guild messages", async () => {
  process.env.MQTT_ADMIN_GUILD_ID = "929659839196561419";
  process.env.MQTT_ADMIN_ROLE_IDS = "1,2";
  const provider = createDiscordRolePermissionProvider(createRobot());

  assert.equal(await provider.hasRole(null, ["env:MQTT_ADMIN_ROLE_IDS"], createContext({ roleIds: ["2"] })), true);
  assert.equal(await provider.hasRole(null, ["env:MQTT_ADMIN_ROLE_IDS"], createContext({ roleIds: ["3"] })), false);
});

test("Discord role permission provider fetches configured guild membership for DMs", async () => {
  process.env.MQTT_ADMIN_GUILD_ID = "929659839196561419";
  process.env.MQTT_ADMIN_ROLE_IDS = "1";
  const robot = createRobot();
  robot.fetchedGuildMembers.set("505598218306977793", {
    roles: {
      cache: new Map([["1", { id: "1" }]]),
    },
  });
  const provider = createDiscordRolePermissionProvider(robot);

  assert.equal(await provider.hasRole(null, ["env:MQTT_ADMIN_ROLE_IDS"], createContext({ guildId: null })), true);
});

test("installDiscordRolePermissionProvider installs provider once", () => {
  const robot = createRobot();

  const first = installDiscordRolePermissionProvider(robot);
  const second = installDiscordRolePermissionProvider(robot);

  assert.equal(first, second);
  assert.equal(robot.commands.permissionProvider, first);
});
