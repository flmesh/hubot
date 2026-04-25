import { escapeLogqlString, queryLokiVector as querySharedLokiVector } from "./loki-query.js";

export const AUTHZ_ADMIN_PERMISSIONS = {
  roles: ["env:MQTT_ADMIN_ROLE_IDS"],
};

export const DEFAULT_AUTHZ_LOOKBACK_MINUTES = 60;
const AUTHZ_DENIAL_MSG_REGEX = "authorization_permission_denied|cannot_publish_to_topic_due_to_not_authorized";

export function parsePositiveInt(raw, fieldName) {
  if (!/^\d+$/.test(String(raw ?? ""))) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
  return parsed;
}

export function buildAuthzSummaryQuery(lookbackMinutes) {
  return [
    "sum by (topic, username) (",
    "count_over_time(",
    "{compose_service=\"emqx\", tag=\"AUTHZ\"}",
    "| json",
    `| msg=~\"${AUTHZ_DENIAL_MSG_REGEX}\"`,
    "| topic!=\"\"",
    "| username!=\"\"",
    `[${lookbackMinutes}m]`,
    ")",
    ")",
  ].join(" ");
}

export function buildAuthzDetailsQuery({ lookbackMinutes, clientId }) {
  const filters = [
    '{compose_service="emqx", tag="AUTHZ"}',
    "| json",
    `| msg=~"${AUTHZ_DENIAL_MSG_REGEX}"`,
    '| topic!=""',
    '| username!=""',
    '| clientid!=""',
  ];

  if (clientId) {
    filters.push(`| clientid="${escapeLogqlString(clientId)}"`);
  }

  return [
    "sum by (clientid, username, topic) (",
    "count_over_time(",
    ...filters,
    `[${lookbackMinutes}m]`,
    ")",
    ")",
  ].join(" ");
}

export function parseAuthzSummaryRows(payload) {
  if (payload?.status !== "success" || payload?.data?.resultType !== "vector") {
    return [];
  }

  const rows = [];
  for (const item of payload.data.result ?? []) {
    const topic = String(item?.metric?.topic ?? "").trim();
    const username = String(item?.metric?.username ?? "").trim();
    const count = Number(item?.value?.[1] ?? 0);

    if (!topic || !username || !Number.isFinite(count) || count <= 0) {
      continue;
    }

    rows.push({ topic, username, count });
  }

  rows.sort((left, right) => right.count - left.count);
  return rows;
}

export function parseAuthzDetailsRows(payload) {
  if (payload?.status !== "success" || payload?.data?.resultType !== "vector") {
    return [];
  }

  const rows = [];
  for (const item of payload.data.result ?? []) {
    const clientId = String(item?.metric?.clientid ?? "").trim();
    const username = String(item?.metric?.username ?? "").trim();
    const topic = String(item?.metric?.topic ?? "").trim();
    const count = Number(item?.value?.[1] ?? 0);

    if (!clientId || !username || !topic || !Number.isFinite(count) || count <= 0) {
      continue;
    }

    rows.push({ clientId, username, topic, count });
  }

  rows.sort((left, right) => right.count - left.count
    || left.clientId.localeCompare(right.clientId)
    || left.username.localeCompare(right.username)
    || left.topic.localeCompare(right.topic));
  return rows;
}

export async function queryLokiVector({ robot, query, requestTimeoutMs, logPrefix }) {
  return querySharedLokiVector({
    robot,
    query,
    requestTimeoutMs,
    logPrefix,
  });
}