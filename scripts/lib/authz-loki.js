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

function escapeLogqlString(value) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
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
  const lokiBaseUrl = process.env.LOKI_URL || "http://loki:3100";
  const queryTimeNs = Date.now() * 1_000_000;

  const params = new URLSearchParams({
    query,
    time: String(queryTimeNs),
  });

  const headers = {};
  if (process.env.LOKI_USERNAME && process.env.LOKI_PASSWORD) {
    const token = Buffer.from(`${process.env.LOKI_USERNAME}:${process.env.LOKI_PASSWORD}`).toString("base64");
    headers.Authorization = `Basic ${token}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

  try {
    const response = await fetch(`${lokiBaseUrl}/loki/api/v1/query?${params.toString()}`, {
      method: "GET",
      headers,
      signal: controller.signal,
    });

    if (!response.ok) {
      const bodyText = await response.text();
      robot.logger.error(`${logPrefix} Loki query failed: HTTP ${response.status} ${bodyText}`);
      throw new Error(`Loki query failed with HTTP ${response.status}`);
    }

    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}