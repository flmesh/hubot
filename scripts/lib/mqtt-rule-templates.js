const SIMPLE_ACTIONS = new Set(["publish", "subscribe", "all"]);
const TOPIC_MATCHES = new Set(["filter", "eq"]);

function isObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function renderTemplateString(value, bindings) {
  return String(value).replaceAll("${username}", String(bindings.username));
}

function normalizeWho(who) {
  if (!who) {
    return { username: "${username}" };
  }

  if (!isObject(who)) {
    throw new Error("profile rule who selector must be an object");
  }

  const normalized = {};
  for (const key of ["username", "clientid", "ipaddress"]) {
    if (who[key] !== undefined && who[key] !== null && who[key] !== "") {
      normalized[key] = String(who[key]);
    }
  }

  if (Object.keys(normalized).length === 0) {
    normalized.username = "${username}";
  }

  return normalized;
}

function normalizeAction(action) {
  if (typeof action === "string") {
    const normalized = action.trim().toLowerCase();
    if (!SIMPLE_ACTIONS.has(normalized)) {
      throw new Error(`unsupported profile action: ${action}`);
    }
    return { type: normalized };
  }

  if (!isObject(action)) {
    throw new Error("profile rule action must be a string or object");
  }

  const type = String(action.type ?? "").trim().toLowerCase();
  if (!SIMPLE_ACTIONS.has(type)) {
    throw new Error(`unsupported profile action type: ${action.type ?? "unknown"}`);
  }

  const normalized = { type };
  if (action.qos !== undefined) {
    normalized.qos = Array.isArray(action.qos)
      ? action.qos.map((value) => Number(value))
      : Number(action.qos);
  }
  if (action.retain !== undefined) {
    normalized.retain = action.retain;
  }
  return normalized;
}

function normalizeTopic(topic) {
  if (typeof topic === "string") {
    return { match: "filter", value: topic };
  }

  if (!isObject(topic)) {
    throw new Error("profile rule topics must be strings or objects");
  }

  const match = String(topic.match ?? "filter").trim().toLowerCase();
  if (!TOPIC_MATCHES.has(match)) {
    throw new Error(`unsupported topic match type: ${topic.match ?? "unknown"}`);
  }

  const value = String(topic.value ?? "").trim();
  if (!value) {
    throw new Error("profile rule topic value is required");
  }

  return { match, value };
}

export function normalizeProfileRule(rule) {
  if (!isObject(rule)) {
    throw new Error("profile rule must be an object");
  }

  const permission = String(rule.permission ?? "").trim().toLowerCase();
  if (permission !== "allow" && permission !== "deny") {
    throw new Error(`unsupported profile permission: ${rule.permission ?? "unknown"}`);
  }

  const topics = Array.isArray(rule.topics)
    ? rule.topics.map(normalizeTopic)
    : [];

  if (topics.length === 0) {
    throw new Error("profile rule must define at least one topic");
  }

  return {
    permission,
    who: normalizeWho(rule.who),
    action: normalizeAction(rule.action),
    topics,
  };
}

function normalizeQos(qos) {
  const allowed = new Set([0, 1, 2]);
  if (Array.isArray(qos)) {
    const values = qos.map((value) => Number(value));
    if (values.some((value) => !allowed.has(value))) {
      throw new Error("profile rule qos must be 0, 1, 2, or an array of those values");
    }
    return values;
  }

  const value = Number(qos);
  if (!allowed.has(value)) {
    throw new Error("profile rule qos must be 0, 1, 2, or an array of those values");
  }
  return value;
}

function normalizeRetain(retain) {
  if (retain === true || retain === false) {
    return retain;
  }
  if (retain === 0 || retain === 1) {
    return retain;
  }
  throw new Error("profile rule retain must be true, false, 0, or 1");
}

export function materializeProfileRule({ rule, username, profileName }) {
  const normalized = normalizeProfileRule(rule);

  const renderedUsername = normalized.who.username
    ? renderTemplateString(normalized.who.username, { username })
    : username;
  if (!renderedUsername) {
    throw new Error("profile rule produced an empty username selector");
  }

  const renderedTopics = normalized.topics.map((topic) => {
    if (topic.match !== "filter") {
      throw new Error(`topic match type ${topic.match} is not supported by the current MongoDB ACL materializer`);
    }
    return renderTemplateString(topic.value, { username });
  });

  const document = {
    username: renderedUsername,
    permission: normalized.permission,
    action: normalized.action.type,
    topics: renderedTopics,
    source_profile: profileName,
    managed_by: "hubot-profile",
  };

  for (const selectorField of ["clientid", "ipaddress"]) {
    if (normalized.who[selectorField]) {
      document[selectorField] = renderTemplateString(normalized.who[selectorField], { username });
    }
  }

  if (normalized.action.qos !== undefined) {
    document.qos = normalizeQos(normalized.action.qos);
  }
  if (normalized.action.retain !== undefined) {
    document.retain = normalizeRetain(normalized.action.retain);
  }

  return document;
}

export function formatProfileRule(rule) {
  const normalized = normalizeProfileRule(rule);

  const selectorParts = [];
  if (normalized.who.username && normalized.who.username !== "${username}") {
    selectorParts.push(`username=${normalized.who.username}`);
  }
  if (normalized.who.clientid) {
    selectorParts.push(`clientid=${normalized.who.clientid}`);
  }
  if (normalized.who.ipaddress) {
    selectorParts.push(`ipaddress=${normalized.who.ipaddress}`);
  }

  const actionParts = [normalized.action.type];
  if (normalized.action.qos !== undefined) {
    const qos = Array.isArray(normalized.action.qos)
      ? normalized.action.qos.join(",")
      : normalized.action.qos;
    actionParts.push(`qos=${qos}`);
  }
  if (normalized.action.retain !== undefined) {
    actionParts.push(`retain=${normalized.action.retain}`);
  }

  const topics = normalized.topics.map((topic) => topic.match === "eq"
    ? `eq ${topic.value}`
    : topic.value).join(", ");

  const selectors = selectorParts.length > 0 ? ` [${selectorParts.join(", ")}]` : "";
  return `${normalized.permission}${selectors} ${actionParts.join(" ")} ${topics}`;
}

function emqxWhoSpec(who) {
  const selectorEntries = [];

  if (who.username) {
    selectorEntries.push(`{user, "${who.username}"}`);
  }
  if (who.clientid) {
    selectorEntries.push(`{clientid, "${who.clientid}"}`);
  }
  if (who.ipaddress) {
    selectorEntries.push(`{ipaddr, "${who.ipaddress}"}`);
  }

  if (selectorEntries.length === 0) {
    return "all";
  }

  if (selectorEntries.length === 1) {
    return selectorEntries[0];
  }

  return `{'and', [${selectorEntries.join(", ")}]}`;
}

function emqxActionSpec(action) {
  if (action.qos === undefined && action.retain === undefined) {
    return action.type;
  }

  const qualifiers = [];
  if (action.qos !== undefined) {
    const qosValue = Array.isArray(action.qos)
      ? `[${action.qos.join(",")}]`
      : String(action.qos);
    qualifiers.push(`{qos, ${qosValue}}`);
  }
  if (action.retain !== undefined) {
    qualifiers.push(`{retain, ${String(action.retain)}}`);
  }

  return `{${action.type}, [${qualifiers.join(", ")}]}`;
}

function emqxTopicSpec(topic) {
  if (topic.match === "eq") {
    return `{eq, "${topic.value}"}`;
  }
  return `"${topic.value}"`;
}

export function formatProfileRuleAsEmqxSpec(rule) {
  const normalized = normalizeProfileRule(rule);
  const topics = normalized.topics.map(emqxTopicSpec).join(", ");
  return `{${normalized.permission}, ${emqxWhoSpec(normalized.who)}, ${emqxActionSpec(normalized.action)}, [${topics}]}.`;
}
