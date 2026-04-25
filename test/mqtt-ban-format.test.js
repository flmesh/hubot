import test from "node:test";
import assert from "node:assert/strict";

import {
  buildBanEmbed,
  buildUnbanEmbed,
  buildBanListEmbed,
} from "../scripts/lib/mqtt-discord-format.js";

const UNIX_TS = 1777698236; // 2026-05-02T05:03:56.000Z

test("buildBanEmbed renders a Discord timestamp for a unix until", () => {
  const embed = buildBanEmbed({ as: "clientid", who: "bad-client", days: 7, until: UNIX_TS });
  const json = embed.toJSON();
  assert.equal(json.title, "MQTT Client Banned");
  const expires = json.fields.find((f) => f.name === "Expires");
  assert.ok(expires, "Expires field should exist");
  assert.equal(expires.value, `<t:${UNIX_TS}:f>`);
});

test("buildBanEmbed renders 'permanent' for null until", () => {
  const embed = buildBanEmbed({ as: "clientid", who: "bad-client", days: 7, until: null });
  const json = embed.toJSON();
  const expires = json.fields.find((f) => f.name === "Expires");
  assert.equal(expires.value, "permanent");
});

test("buildBanEmbed renders singular day label", () => {
  const embed = buildBanEmbed({ as: "clientid", who: "bad-client", days: 1, until: UNIX_TS });
  const json = embed.toJSON();
  const duration = json.fields.find((f) => f.name === "Duration");
  assert.equal(duration.value, "1 day");
});

test("buildUnbanEmbed renders correctly", () => {
  const embed = buildUnbanEmbed({ as: "clientid", who: "bad-client" });
  const json = embed.toJSON();
  assert.equal(json.title, "MQTT Ban Removed");
  assert.ok(json.fields.some((f) => f.name === "Identity" && f.value === "bad-client"));
});

test("buildBanListEmbed returns 'No active bans' when empty", () => {
  const embed = buildBanListEmbed({ bans: [], meta: { count: 0, page: 1, limit: 20 } });
  const json = embed.toJSON();
  assert.equal(json.title, "MQTT Active Bans");
  assert.equal(json.description, "No active bans.");
});

test("buildBanListEmbed renders bans with Discord timestamp", () => {
  const bans = [{ as: "clientid", who: "bad-client", until: UNIX_TS }];
  const embed = buildBanListEmbed({ bans, meta: { count: 1, page: 1, limit: 20 } });
  const json = embed.toJSON();
  assert.ok(json.description.includes("bad-client"));
  assert.ok(json.description.includes(`<t:${UNIX_TS}:f>`), `expected Discord timestamp in: ${json.description}`);
});

test("buildBanListEmbed renders 'permanent' when until is null", () => {
  const bans = [{ as: "clientid", who: "bad-client", until: null }];
  const embed = buildBanListEmbed({ bans, meta: { count: 1, page: 1, limit: 20 } });
  const json = embed.toJSON();
  assert.ok(json.description.includes("permanent"), `expected 'permanent' in: ${json.description}`);
});

test("buildBanListEmbed renders 'permanent' when until is 'infinity'", () => {
  const bans = [{ as: "clientid", who: "bad-client", until: "infinity" }];
  const embed = buildBanListEmbed({ bans, meta: { count: 1, page: 1, limit: 20 } });
  const json = embed.toJSON();
  assert.ok(json.description.includes("permanent"), `expected 'permanent' in: ${json.description}`);
});

test("buildBanListEmbed handles until as an ISO string", () => {
  const bans = [{ as: "clientid", who: "bad-client", until: "2026-05-02T05:03:56.000Z" }];
  const embed = buildBanListEmbed({ bans, meta: { count: 1, page: 1, limit: 20 } });
  const json = embed.toJSON();
  assert.ok(json.description.includes(`<t:${UNIX_TS}:f>`), `expected Discord timestamp in: ${json.description}`);
});

test("buildBanListEmbed truncates long client IDs", () => {
  const longWho = "MeshtasticAndroidMqttProxy-!fa204061verylongextra";
  const bans = [{ as: "clientid", who: longWho, until: UNIX_TS }];
  const embed = buildBanListEmbed({ bans, meta: { count: 1, page: 1, limit: 20 } });
  const json = embed.toJSON();
  assert.ok(!json.description.includes(longWho), "full long ID should not appear");
  assert.ok(json.description.includes("…"), "truncated ID should end with ellipsis");
});

test("buildBanListEmbed omits pagination fields when all results fit on one page", () => {
  const bans = [{ as: "clientid", who: "bad-client", until: UNIX_TS }];
  const embed = buildBanListEmbed({ bans, meta: { count: 1, page: 1, limit: 20 } });
  const json = embed.toJSON();
  assert.equal(json.fields?.length ?? 0, 0, "no pagination fields expected for single-page result");
});

test("buildBanListEmbed includes pagination fields when count exceeds limit", () => {
  const bans = [{ as: "clientid", who: "bad-client", until: UNIX_TS }];
  const embed = buildBanListEmbed({ bans, meta: { count: 25, page: 1, limit: 20 } });
  const json = embed.toJSON();
  assert.ok(json.fields.some((f) => f.name === "Showing" && f.value === "1 of 25"));
  assert.ok(json.fields.some((f) => f.name === "Page" && f.value === "1"));
  assert.ok(json.fields.some((f) => f.name === "Page Size" && f.value === "20"));
});

test("buildBanListEmbed includes pagination fields on page > 1", () => {
  const bans = [{ as: "clientid", who: "bad-client", until: UNIX_TS }];
  const embed = buildBanListEmbed({ bans, meta: { count: 5, page: 2, limit: 10 } });
  const json = embed.toJSON();
  assert.ok(json.fields.some((f) => f.name === "Page" && f.value === "2"));
});
