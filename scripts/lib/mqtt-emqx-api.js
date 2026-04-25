const DEFAULT_BAN_DAYS = 7;
const REQUEST_TIMEOUT_MS = 10000;

function getEmqxConfig() {
  const url = String(process.env.EMQX_API_URL ?? "").trim();
  const apiKey = String(process.env.EMQX_API_KEY ?? "").trim();
  const apiSecret = process.env.EMQX_API_SECRET ?? "";

  if (!url) {
    throw new Error("EMQX_API_URL is not configured");
  }

  if (!apiKey) {
    throw new Error("EMQX_API_KEY is not configured");
  }

  return { url, apiKey, apiSecret };
}

function buildEmqxHeaders(apiKey, apiSecret) {
  const token = Buffer.from(`${apiKey}:${apiSecret}`).toString("base64");
  return {
    Authorization: `Basic ${token}`,
    "Content-Type": "application/json",
  };
}

async function emqxRequest({ method, path, body, timeoutMs = REQUEST_TIMEOUT_MS, fetchImpl = fetch }) {
  const { url, apiKey, apiSecret } = getEmqxConfig();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(`${url}${path}`, {
      method,
      headers: buildEmqxHeaders(apiKey, apiSecret),
      body: body != null ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    if (response.status === 204) {
      return null;
    }

    const json = await response.json();

    if (!response.ok) {
      const message = json?.message ?? json?.reason ?? `HTTP ${response.status}`;
      throw new Error(`EMQX API error: ${message}`);
    }

    return json;
  } finally {
    clearTimeout(timeout);
  }
}

export function getDefaultBanDays() {
  const configured = parseInt(process.env.EMQX_BAN_DEFAULT_DAYS ?? "", 10);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_BAN_DAYS;
}

export async function banClient({ as, who, reason, days, fetchImpl } = {}) {
  if (!as) {
    throw new Error("as is required (clientid, username, or peerhost)");
  }
  if (!who) {
    throw new Error("who is required");
  }

  const daysToUse = days ?? getDefaultBanDays();
  const until = Math.floor(Date.now() / 1000) + daysToUse * 86400;
  const resolvedReason = reason ?? `Banned by hubot for ${daysToUse} day${daysToUse === 1 ? "" : "s"}`;

  await emqxRequest({
    method: "POST",
    path: "/api/v5/banned",
    body: { as, who, until, reason: resolvedReason },
    fetchImpl,
  });

  return { as, who, until, days: daysToUse, reason: resolvedReason };
}

export async function unbanClient({ as, who, fetchImpl } = {}) {
  if (!as) {
    throw new Error("as is required (clientid, username, or peerhost)");
  }
  if (!who) {
    throw new Error("who is required");
  }

  await emqxRequest({
    method: "DELETE",
    path: `/api/v5/banned/${encodeURIComponent(as)}/${encodeURIComponent(who)}`,
    fetchImpl,
  });
}

export async function listBans({ page = 1, limit = 20, fetchImpl } = {}) {
  const params = new URLSearchParams({
    page: String(page),
    limit: String(limit),
  });

  const json = await emqxRequest({
    method: "GET",
    path: `/api/v5/banned?${params.toString()}`,
    fetchImpl,
  });

  return {
    data: Array.isArray(json?.data) ? json.data : [],
    meta: json?.meta ?? { count: 0, page, limit },
  };
}
