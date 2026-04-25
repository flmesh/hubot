import test from "node:test";
import assert from "node:assert/strict";

import {
  buildBanEmbed,
  buildUnbanEmbed,
  buildBanListEmbed,
} from "../scripts/lib/mqtt-discord-format.js";

const UNIX_TS = 1777698236; // 2026-05-02T05:03:56.000Z

test("buildBanEmbed renders correctly for a unix timestamp until", () => {
  const embed = buildBanEmbed({ as: "clientid", who: "bad-client", days: 7, until: UNIX_TS });
  const json = embed.toJSON();
  assert.equal(json.title, "MQTT Client Banned");
  const expires = json.fields.find((f) => f.name === "Expires");
  assert.ok(expires, "Expires field should exist");
  assert.equal(expires.value, "2026-05-02T05:03:56.000Z");
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

test("buildBanListEmbed renders bans with unix timestamp until", () => {
  const bans = [{ as: "clientid", who: "bad-client", until: UNIX_TS }];
  const embed = buildBanListEmbed({ bans, meta: { count: 1, page: 1, limit: 20 } });
  const json = embed.toJSON();
  assert.ok(json.description.includes("bad-client"));
  assert.ok(json.description.includes("2026-05-02T05:03:56.000Z"), `expected ISO date in: ${json.description}`);
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
  assert.ok(json.description.includes("2026-05-02T05:03:56.000Z"), `expected ISO date in: ${json.description}`);
});

test("buildBanListEmbed includes pagination fields", () => {
  const bans = [{ as: "clientid", who: "bad-client", until: UNIX_TS }];
  const embed = buildBanListEmbed({ bans, meta: { count: 5, page: 2, limit: 10 } });
  const json = embed.toJSON();
  assert.ok(json.fields.some((f) => f.name === "Showing" && f.value === "1 of 5"));
  assert.ok(json.fields.some((f) => f.name === "Page" && f.value === "2"));
  assert.ok(json.fields.some((f) => f.name === "Page Size" && f.value === "10"));
});
