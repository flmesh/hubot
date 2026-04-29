import test from "node:test";
import assert from "node:assert/strict";

import {
  banClient,
  unbanClient,
  listBans,
  listActiveClientsForUsername,
  getDefaultBanDays,
} from "../scripts/lib/mqtt-emqx-api.js";

const EMQX_API_URL = "http://emqx:18083";
const EMQX_API_KEY = "testkey";
const EMQX_API_SECRET = "testsecret";

function withEmqxEnv(fn) {
  const original = {
    EMQX_API_URL: process.env.EMQX_API_URL,
    EMQX_API_KEY: process.env.EMQX_API_KEY,
    EMQX_API_SECRET: process.env.EMQX_API_SECRET,
    EMQX_BAN_DEFAULT_DAYS: process.env.EMQX_BAN_DEFAULT_DAYS,
  };

  process.env.EMQX_API_URL = EMQX_API_URL;
  process.env.EMQX_API_KEY = EMQX_API_KEY;
  process.env.EMQX_API_SECRET = EMQX_API_SECRET;
  delete process.env.EMQX_BAN_DEFAULT_DAYS;

  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function buildFetchOk(status, body) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  });
}

function buildFetchNoContent() {
  return async () => ({
    ok: true,
    status: 204,
    async json() {
      return null;
    },
  });
}

function buildFetchError(status, body) {
  return async () => ({
    ok: false,
    status,
    async json() {
      return body;
    },
  });
}

function captureFetch(impl) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return impl(url, options);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

test("getDefaultBanDays returns 7 when EMQX_BAN_DEFAULT_DAYS is not set", () => {
  const original = process.env.EMQX_BAN_DEFAULT_DAYS;
  delete process.env.EMQX_BAN_DEFAULT_DAYS;
  try {
    assert.equal(getDefaultBanDays(), 7);
  } finally {
    if (original !== undefined) {
      process.env.EMQX_BAN_DEFAULT_DAYS = original;
    }
  }
});

test("getDefaultBanDays returns configured value from EMQX_BAN_DEFAULT_DAYS", () => {
  const original = process.env.EMQX_BAN_DEFAULT_DAYS;
  process.env.EMQX_BAN_DEFAULT_DAYS = "14";
  try {
    assert.equal(getDefaultBanDays(), 14);
  } finally {
    if (original !== undefined) {
      process.env.EMQX_BAN_DEFAULT_DAYS = original;
    } else {
      delete process.env.EMQX_BAN_DEFAULT_DAYS;
    }
  }
});

test("banClient sends POST to /api/v5/banned with correct body", async () => {
  await withEmqxEnv(async () => {
    const fetchImpl = captureFetch(buildFetchNoContent());

    const now = Math.floor(Date.now() / 1000);
    const result = await banClient({
      as: "clientid",
      who: "test-client-001",
      reason: "testing",
      days: 7,
      fetchImpl,
    });

    assert.equal(fetchImpl.calls.length, 1);
    const [call] = fetchImpl.calls;
    assert.equal(call.url, `${EMQX_API_URL}/api/v5/banned`);
    assert.equal(call.options.method, "POST");

    const authHeader = call.options.headers.Authorization;
    const expectedToken = Buffer.from(`${EMQX_API_KEY}:${EMQX_API_SECRET}`).toString("base64");
    assert.equal(authHeader, `Basic ${expectedToken}`);

    const body = JSON.parse(call.options.body);
    assert.equal(body.as, "clientid");
    assert.equal(body.who, "test-client-001");
    assert.equal(body.reason, "testing");
    assert.ok(body.until >= now + 7 * 86400 - 2, "until should be ~7 days from now");
    assert.ok(body.until <= now + 7 * 86400 + 2, "until should be ~7 days from now");

    assert.equal(result.as, "clientid");
    assert.equal(result.who, "test-client-001");
    assert.equal(result.days, 7);
  });
});

test("banClient uses default ban days when days is not specified", async () => {
  await withEmqxEnv(async () => {
    const fetchImpl = captureFetch(buildFetchNoContent());
    const now = Math.floor(Date.now() / 1000);

    const result = await banClient({
      as: "clientid",
      who: "test-client-002",
      fetchImpl,
    });

    const body = JSON.parse(fetchImpl.calls[0].options.body);
    assert.ok(body.until >= now + 7 * 86400 - 2);
    assert.equal(result.days, 7);
  });
});

test("banClient generates default reason when none is provided", async () => {
  await withEmqxEnv(async () => {
    const fetchImpl = captureFetch(buildFetchNoContent());

    const result = await banClient({
      as: "clientid",
      who: "test-client-003",
      days: 3,
      fetchImpl,
    });

    const body = JSON.parse(fetchImpl.calls[0].options.body);
    assert.ok(body.reason.includes("3 days"), `expected reason to mention 3 days, got: ${body.reason}`);
    assert.equal(result.reason, body.reason);
  });
});

test("banClient throws when EMQX API returns an error", async () => {
  await withEmqxEnv(async () => {
    const fetchImpl = captureFetch(buildFetchError(400, { message: "already banned" }));

    await assert.rejects(
      () => banClient({ as: "clientid", who: "test-client-004", fetchImpl }),
      /already banned/,
    );
  });
});

test("banClient throws when as is missing", async () => {
  await withEmqxEnv(async () => {
    await assert.rejects(
      () => banClient({ who: "test-client", fetchImpl: buildFetchNoContent() }),
      /as is required/,
    );
  });
});

test("banClient throws when who is missing", async () => {
  await withEmqxEnv(async () => {
    await assert.rejects(
      () => banClient({ as: "clientid", fetchImpl: buildFetchNoContent() }),
      /who is required/,
    );
  });
});

test("unbanClient sends DELETE to correct path", async () => {
  await withEmqxEnv(async () => {
    const fetchImpl = captureFetch(buildFetchNoContent());

    await unbanClient({ as: "clientid", who: "test-client-005", fetchImpl });

    assert.equal(fetchImpl.calls.length, 1);
    const [call] = fetchImpl.calls;
    assert.equal(call.url, `${EMQX_API_URL}/api/v5/banned/clientid/test-client-005`);
    assert.equal(call.options.method, "DELETE");
  });
});

test("unbanClient encodes special characters in who", async () => {
  await withEmqxEnv(async () => {
    const fetchImpl = captureFetch(buildFetchNoContent());

    await unbanClient({ as: "clientid", who: "client/with/slashes", fetchImpl });

    const [call] = fetchImpl.calls;
    assert.equal(call.url, `${EMQX_API_URL}/api/v5/banned/clientid/client%2Fwith%2Fslashes`);
  });
});

test("unbanClient throws when as is missing", async () => {
  await withEmqxEnv(async () => {
    await assert.rejects(
      () => unbanClient({ who: "test-client", fetchImpl: buildFetchNoContent() }),
      /as is required/,
    );
  });
});

test("listBans returns data and meta from EMQX API", async () => {
  await withEmqxEnv(async () => {
    const fakeBans = [
      { as: "clientid", who: "bad-client", until: 9999999999, reason: "test" },
    ];
    const fakeMeta = { count: 1, page: 1, limit: 20 };
    const fetchImpl = captureFetch(buildFetchOk(200, { data: fakeBans, meta: fakeMeta }));

    const result = await listBans({ page: 1, limit: 20, fetchImpl });

    assert.deepEqual(result.data, fakeBans);
    assert.deepEqual(result.meta, fakeMeta);

    const [call] = fetchImpl.calls;
    assert.ok(call.url.includes("/api/v5/banned"), "URL should include /api/v5/banned");
    assert.ok(call.url.includes("page=1"), "URL should include page param");
    assert.ok(call.url.includes("limit=20"), "URL should include limit param");
    assert.equal(call.options.method, "GET");
  });
});

test("listBans returns empty data array on empty response", async () => {
  await withEmqxEnv(async () => {
    const fetchImpl = captureFetch(buildFetchOk(200, { data: [], meta: { count: 0, page: 1, limit: 20 } }));

    const result = await listBans({ fetchImpl });

    assert.deepEqual(result.data, []);
    assert.equal(result.meta.count, 0);
  });
});

test("listActiveClientsForUsername queries connected clients by username", async () => {
  await withEmqxEnv(async () => {
    const clients = [
      {
        clientid: "MeshtasticAndroidMqttProxy-!deadbeef",
        username: "jbouse",
        connected: true,
        connected_at: "2026-04-29T12:00:00.000+00:00",
      },
    ];
    const meta = { count: 1, page: 1, limit: 10 };
    const fetchImpl = captureFetch(buildFetchOk(200, { data: clients, meta }));

    const result = await listActiveClientsForUsername({ username: "jbouse", fetchImpl });

    assert.deepEqual(result.data, clients);
    assert.deepEqual(result.meta, meta);

    const [call] = fetchImpl.calls;
    assert.ok(call.url.includes("/api/v5/clients"), "URL should include /api/v5/clients");
    assert.ok(call.url.includes("username=jbouse"), "URL should include username filter");
    assert.ok(call.url.includes("conn_state=connected"), "URL should include connected-state filter");
    assert.ok(call.url.includes("limit=10"), "URL should include limit param");
    assert.equal(call.options.method, "GET");
  });
});

test("listActiveClientsForUsername requires username", async () => {
  await withEmqxEnv(async () => {
    await assert.rejects(
      () => listActiveClientsForUsername({ username: "", fetchImpl: buildFetchOk(200, {}) }),
      /username is required/,
    );
  });
});

test("banClient throws when EMQX_API_URL is not configured", async () => {
  const original = process.env.EMQX_API_URL;
  delete process.env.EMQX_API_URL;
  try {
    await assert.rejects(
      () => banClient({ as: "clientid", who: "test", fetchImpl: buildFetchNoContent() }),
      /EMQX_API_URL is not configured/,
    );
  } finally {
    if (original !== undefined) {
      process.env.EMQX_API_URL = original;
    }
  }
});

test("banClient throws when EMQX_API_KEY is not configured", async () => {
  const originalUrl = process.env.EMQX_API_URL;
  const originalKey = process.env.EMQX_API_KEY;
  process.env.EMQX_API_URL = EMQX_API_URL;
  delete process.env.EMQX_API_KEY;
  try {
    await assert.rejects(
      () => banClient({ as: "clientid", who: "test", fetchImpl: buildFetchNoContent() }),
      /EMQX_API_KEY is not configured/,
    );
  } finally {
    if (originalUrl !== undefined) process.env.EMQX_API_URL = originalUrl;
    else delete process.env.EMQX_API_URL;
    if (originalKey !== undefined) process.env.EMQX_API_KEY = originalKey;
  }
});
