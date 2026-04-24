export function escapeLogqlString(value) {
  return String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function buildLokiHeaders() {
  const headers = {};
  if (process.env.LOKI_USERNAME && process.env.LOKI_PASSWORD) {
    const token = Buffer.from(`${process.env.LOKI_USERNAME}:${process.env.LOKI_PASSWORD}`).toString("base64");
    headers.Authorization = `Basic ${token}`;
  }

  return headers;
}

async function queryLokiJson({ robot, path, params, requestTimeoutMs, logPrefix }) {
  const lokiBaseUrl = process.env.LOKI_URL || "http://loki:3100";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

  try {
    const response = await fetch(`${lokiBaseUrl}${path}?${params.toString()}`, {
      method: "GET",
      headers: buildLokiHeaders(),
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

export function parseLokiRangeLines(payload) {
  if (payload?.status !== "success" || !payload?.data?.result) {
    return [];
  }

  const lines = [];
  for (const stream of payload.data.result) {
    for (const value of stream.values ?? []) {
      lines.push({ tsNanos: value[0], line: value[1] });
    }
  }

  return lines;
}

export async function queryLokiRange({
  robot,
  query,
  startNs,
  endNs,
  limit,
  requestTimeoutMs,
  logPrefix,
}) {
  const params = new URLSearchParams({
    query,
    start: String(startNs),
    end: String(endNs),
    limit: String(limit),
    direction: "BACKWARD",
  });

  return queryLokiJson({
    robot,
    path: "/loki/api/v1/query_range",
    params,
    requestTimeoutMs,
    logPrefix,
  });
}

export async function queryLokiVector({
  robot,
  query,
  timeNs,
  requestTimeoutMs,
  logPrefix,
}) {
  const params = new URLSearchParams({
    query,
    time: String(timeNs ?? Date.now() * 1_000_000),
  });

  return queryLokiJson({
    robot,
    path: "/loki/api/v1/query",
    params,
    requestTimeoutMs,
    logPrefix,
  });
}