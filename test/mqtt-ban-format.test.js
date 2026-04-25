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

test("buildBanListEmbed renders one field per ban with full client ID as name", () => {
  const bans = [
    { as: "clientid", who: "bad-client", until: UNIX_TS },
    { as: "clientid", who: "MeshtasticAndroidMqttProxy-!fa204061", until: null },
  ];
  const embed = buildBanListEmbed({ bans, meta: { count: 2, page: 1, limit: 20 } });
  const json = embed.toJSON();
  assert.equal(json.fields.length, 2);
  assert.equal(json.fields[0].name, "bad-client");
  assert.ok(json.fields[0].value.includes(`<t:${UNIX_TS}:f>`), "first field should have Discord timestamp");
  assert.equal(json.fields[1].name, "MeshtasticAndroidMqttProxy-!fa204061");
  assert.ok(json.fields[1].value.includes("permanent"), "second field should show permanent");
});

test("buildBanListEmbed renders 'permanent' when until is null", () => {
  const bans = [{ as: "clientid", who: "bad-client", until: null }];
  const embed = buildBanListEmbed({ bans, meta: { count: 1, page: 1, limit: 20 } });
  const json = embed.toJSON();
  assert.ok(json.fields[0].value.includes("permanent"));
});

test("buildBanListEmbed renders 'permanent' when until is 'infinity'", () => {
  const bans = [{ as: "clientid", who: "bad-client", until: "infinity" }];
  const embed = buildBanListEmbed({ bans, meta: { count: 1, page: 1, limit: 20 } });
  const json = embed.toJSON();
  assert.ok(json.fields[0].value.includes("permanent"));
});

test("buildBanListEmbed handles until as an ISO string", () => {
  const bans = [{ as: "clientid", who: "bad-client", until: "2026-05-02T05:03:56.000Z" }];
  const embed = buildBanListEmbed({ bans, meta: { count: 1, page: 1, limit: 20 } });
  const json = embed.toJSON();
  assert.ok(json.fields[0].value.includes(`<t:${UNIX_TS}:f>`), `expected Discord timestamp in: ${json.fields[0].value}`);
});

test("buildBanListEmbed shows full client ID without truncation", () => {
  const longWho = "MeshtasticAndroidMqttProxy-!fa204061verylongextra";
  const bans = [{ as: "clientid", who: longWho, until: UNIX_TS }];
  const embed = buildBanListEmbed({ bans, meta: { count: 1, page: 1, limit: 20 } });
  const json = embed.toJSON();
  assert.equal(json.fields[0].name, longWho, "full ID should be the field name, untruncated");
});

test("buildBanListEmbed omits footer when all results fit on one page", () => {
  const bans = [{ as: "clientid", who: "bad-client", until: UNIX_TS }];
  const embed = buildBanListEmbed({ bans, meta: { count: 1, page: 1, limit: 20 } });
  const json = embed.toJSON();
  assert.equal(json.footer, undefined, "no footer expected for single-page result");
});

test("buildBanListEmbed shows footer when count exceeds limit", () => {
  const bans = [{ as: "clientid", who: "bad-client", until: UNIX_TS }];
  const embed = buildBanListEmbed({ bans, meta: { count: 25, page: 1, limit: 20 } });
  const json = embed.toJSON();
  assert.ok(json.footer?.text?.includes("25"), `expected total count in footer: ${json.footer?.text}`);
});

test("buildBanListEmbed shows footer on page > 1", () => {
  const bans = [{ as: "clientid", who: "bad-client", until: UNIX_TS }];
  const embed = buildBanListEmbed({ bans, meta: { count: 5, page: 2, limit: 10 } });
  const json = embed.toJSON();
  assert.ok(json.footer?.text?.includes("Page 2"), `expected page 2 in footer: ${json.footer?.text}`);
});

test("buildBanListEmbed caps at 25 fields (Discord embed limit)", () => {
  const bans = Array.from({ length: 30 }, (_, i) => ({ as: "clientid", who: `client-${i}`, until: UNIX_TS }));
  const embed = buildBanListEmbed({ bans, meta: { count: 30, page: 1, limit: 30 } });
  const json = embed.toJSON();
  assert.ok(json.fields.length <= 25, `expected at most 25 fields, got ${json.fields.length}`);
});
