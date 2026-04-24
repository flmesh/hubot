import test from "node:test";
import assert from "node:assert/strict";

import {
  default as installDiscordContactCache,
  rememberDiscordContact,
  warmDiscordDmChannels,
} from "../scripts/discord-contact-cache.js";

function createBrain(initial = null) {
  let value = initial;
  let saved = 0;

  return {
    get() {
      return value;
    },
    set(_key, nextValue) {
      value = nextValue;
      return this;
    },
    save() {
      saved += 1;
    },
    value() {
      return value;
    },
    saved() {
      return saved;
    },
  };
}

function createRobot({ brain = createBrain(), fetchedUsers = new Map() } = {}) {
  return {
    brain,
    logger: {
      debug() {},
      info() {},
      warn() {},
    },
    adapter: {
      client: {
        users: {
          async fetch(userId) {
            const user = fetchedUsers.get(String(userId));
            if (!user) {
              throw new Error("not found");
            }

            return user;
          },
        },
      },
    },
  };
}

test("rememberDiscordContact stores non-bot Discord users in the brain", () => {
  const brain = createBrain();
  const robot = createRobot({ brain });

  const stored = rememberDiscordContact(robot, {
    author: {
      id: "505598218306977793",
      username: "jbouse",
      globalName: "Jeremy",
    },
  }, 1776814028424);

  assert.equal(stored, true);
  assert.deepEqual(brain.value().contacts["505598218306977793"], {
    id: "505598218306977793",
    username: "jbouse",
    globalName: "Jeremy",
    lastSeenAt: 1776814028424,
  });
  assert.equal(brain.saved(), 1);
});

test("rememberDiscordContact ignores bot authors", () => {
  const brain = createBrain();
  const robot = createRobot({ brain });

  const stored = rememberDiscordContact(robot, {
    author: {
      id: "bot-user",
      username: "nerfbot",
      bot: true,
    },
  });

  assert.equal(stored, false);
  assert.equal(brain.value(), null);
});

test("warmDiscordDmChannels opens DMs for remembered users and prunes stale contacts", async () => {
  const now = 1776814028424;
  const freshDmCalls = [];
  const staleDmCalls = [];
  const brain = createBrain({
    contacts: {
      fresh: {
        id: "fresh",
        username: "fresh",
        globalName: null,
        lastSeenAt: now,
      },
      stale: {
        id: "stale",
        username: "stale",
        globalName: null,
        lastSeenAt: now - (181 * 24 * 60 * 60 * 1000),
      },
    },
  });
  const fetchedUsers = new Map([
    ["fresh", {
      async createDM() {
        freshDmCalls.push("fresh");
      },
    }],
    ["stale", {
      async createDM() {
        staleDmCalls.push("stale");
      },
    }],
  ]);
  const robot = createRobot({ brain, fetchedUsers });

  const result = await warmDiscordDmChannels(robot, now);

  assert.deepEqual(result, { attempted: 1, warmed: 1, failed: 0 });
  assert.deepEqual(freshDmCalls, ["fresh"]);
  assert.deepEqual(staleDmCalls, []);
  assert.deepEqual(Object.keys(brain.value().contacts), ["fresh"]);
});

test("install warms after brain load when Discord client is already ready", async () => {
  const dmCalls = [];
  const events = new Map();
  const brain = createBrain({
    contacts: {
      fresh: {
        id: "fresh",
        username: "fresh",
        globalName: null,
        lastSeenAt: Date.now(),
      },
    },
  });
  brain.on = (eventName, handler) => {
    events.set(eventName, handler);
  };

  const robot = createRobot({ brain });
  robot.adapter.client = {
    isReady() {
      return true;
    },
    on() {},
    once() {},
    users: {
      async fetch(userId) {
        assert.equal(userId, "fresh");
        return {
          async createDM() {
            dmCalls.push(userId);
          },
        };
      },
    },
  };

  installDiscordContactCache(robot);
  assert.deepEqual(dmCalls, []);

  await events.get("loaded")();
  assert.deepEqual(dmCalls, ["fresh"]);
});
