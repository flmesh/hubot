import test from "node:test";
import assert from "node:assert/strict";

import {
  formatProfileRule,
  formatProfileRuleAsEmqxSpec,
  materializeProfileRule,
  normalizeProfileRule,
} from "../scripts/lib/mqtt-rule-templates.js";

test("normalizeProfileRule converts legacy rules into the richer template shape", () => {
  const normalized = normalizeProfileRule({
    permission: "allow",
    action: "all",
    topics: ["msh/US/FL/#"],
  });

  assert.deepEqual(normalized, {
    permission: "allow",
    who: { username: "${username}" },
    action: { type: "all" },
    topics: [{ match: "filter", value: "msh/US/FL/#" }],
  });
});

test("materializeProfileRule flattens a richer template into an EMQX MongoDB ACL document", () => {
  const document = materializeProfileRule({
    username: "jbouse",
    profileName: "default",
    rule: {
      permission: "deny",
      who: {
        username: "${username}",
        clientid: "radio-${username}",
        ipaddress: "127.0.0.1",
      },
      action: {
        type: "publish",
        qos: [0, 1],
        retain: false,
      },
      topics: [
        { match: "filter", value: "msh/US/FL/LWS/#" },
      ],
    },
  });

  assert.deepEqual(document, {
    username: "jbouse",
    clientid: "radio-jbouse",
    ipaddress: "127.0.0.1",
    permission: "deny",
    action: "publish",
    qos: [0, 1],
    retain: false,
    topics: ["msh/US/FL/LWS/#"],
    source_profile: "default",
    managed_by: "hubot-profile",
  });
});

test("materializeProfileRule rejects unsupported eq topic matches for the current Mongo materializer", () => {
  assert.throws(() => materializeProfileRule({
    username: "jbouse",
    profileName: "default",
    rule: {
      permission: "allow",
      who: { username: "${username}" },
      action: { type: "all" },
      topics: [{ match: "eq", value: "msh/US/FL/control" }],
    },
  }), /topic match type eq is not supported/);
});

test("formatProfileRule includes selectors and action qualifiers when present", () => {
  const formatted = formatProfileRule({
    permission: "allow",
    who: {
      username: "${username}",
      clientid: "radio-${username}",
    },
    action: {
      type: "subscribe",
      qos: 1,
    },
    topics: [{ match: "filter", value: "msh/US/FL/#" }],
  });

  assert.equal(formatted, "allow [clientid=radio-${username}] subscribe qos=1 msh/US/FL/#");
});

test("formatProfileRuleAsEmqxSpec renders the rule in EMQX ACL syntax", () => {
  const formatted = formatProfileRuleAsEmqxSpec({
    permission: "deny",
    who: {
      username: "${username}",
      clientid: "radio-${username}",
    },
    action: {
      type: "publish",
      qos: 1,
      retain: false,
    },
    topics: [
      { match: "filter", value: "msh/US/FL/#" },
      { match: "eq", value: "msh/US/FL/control" },
    ],
  });

  assert.equal(
    formatted,
    '{deny, {\'and\', [{user, "${username}"}, {clientid, "radio-${username}"}]}, {publish, [{qos, 1}, {retain, false}]}, ["msh/US/FL/#", {eq, "msh/US/FL/control"}]}.',
  );
});
