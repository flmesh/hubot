import test from "node:test";
import assert from "node:assert/strict";
import { EmbedBuilder } from "discord.js";

import packageMetadata from "../package.json" with { type: "json" };
import { buildInfoEmbed } from "../scripts/sample.js";

test("buildInfoEmbed includes runtime info and package version", () => {
  const embed = buildInfoEmbed({
    name: "nerfbot",
    adapterName: "DiscordAdapter",
  });

  assert.ok(embed instanceof EmbedBuilder);

  const json = embed.toJSON();
  assert.equal(json.title, "nerfbot Runtime Info");
  assert.equal(json.fields.find((field) => field.name === "Name")?.value, "nerfbot");
  assert.equal(json.fields.find((field) => field.name === "Version")?.value, packageMetadata.version);
  assert.equal(json.fields.find((field) => field.name === "Adapter")?.value, "DiscordAdapter");
  assert.equal(json.fields.find((field) => field.name === "Node")?.value, process.version);
  assert.match(json.fields.find((field) => field.name === "Uptime")?.value ?? "", /^\d+s$/);
});
