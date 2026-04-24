export function escapeLogqlString(value) {
  return String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
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
  const lokiBaseUrl = process.env.LOKI_URL || "http://loki:3100";

  const params = new URLSearchParams({
    query,
    start: String(startNs),
    end: String(endNs),
    limit: String(limit),
    direction: "BACKWARD",
  });

  const headers = {};
  if (process.env.LOKI_USERNAME && process.env.LOKI_PASSWORD) {
    const token = Buffer.from(`${process.env.LOKI_USERNAME}:${process.env.LOKI_PASSWORD}`).toString("base64");
    headers.Authorization = `Basic ${token}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

  try {
    const response = await fetch(`${lokiBaseUrl}/loki/api/v1/query_range?${params.toString()}`, {
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