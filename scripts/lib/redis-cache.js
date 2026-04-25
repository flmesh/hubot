const DEFAULT_REDIS_URL = "redis://localhost:6379";
const cacheStates = new Map();

function getCacheState(cacheName) {
  if (!cacheStates.has(cacheName)) {
    cacheStates.set(cacheName, {
      clientPromise: null,
      unavailable: false,
      warningLogged: false,
    });
  }

  return cacheStates.get(cacheName);
}

async function getRedisClient({ robot, cacheName, redisUrl, logPrefix }) {
  const state = getCacheState(cacheName);
  if (state.unavailable) {
    return null;
  }

  if (!state.clientPromise) {
    state.clientPromise = import("redis")
      .then(({ createClient }) => {
        const client = createClient({ url: redisUrl || DEFAULT_REDIS_URL });
        client.on("error", (error) => {
          if (!state.warningLogged) {
            state.warningLogged = true;
            robot.logger.warn(`${logPrefix} redis cache unavailable: ${error.message}`);
          }
        });
        return client.connect().then(() => client);
      })
      .catch((error) => {
        state.unavailable = true;
        robot.logger.warn(`${logPrefix} redis cache disabled: ${error.message}`);
        return null;
      });
  }

  try {
    return await state.clientPromise;
  } catch (error) {
    state.unavailable = true;
    robot.logger.warn(`${logPrefix} redis cache disabled: ${error.message}`);
    return null;
  }
}

export async function readCachedText({
  robot,
  cacheName,
  redisUrl,
  key,
  ttlSeconds,
  logPrefix,
}) {
  if (ttlSeconds <= 0) {
    return null;
  }

  const client = await getRedisClient({ robot, cacheName, redisUrl, logPrefix });
  if (!client) {
    return null;
  }

  try {
    return await client.get(key);
  } catch (error) {
    robot.logger.warn(`${logPrefix} redis cache read failed: ${error.message}`);
    return null;
  }
}

export async function writeCachedText({
  robot,
  cacheName,
  redisUrl,
  key,
  ttlSeconds,
  text,
  logPrefix,
}) {
  if (ttlSeconds <= 0) {
    return;
  }

  const client = await getRedisClient({ robot, cacheName, redisUrl, logPrefix });
  if (!client) {
    return;
  }

  try {
    await client.set(key, text, { EX: ttlSeconds });
  } catch (error) {
    robot.logger.warn(`${logPrefix} redis cache write failed: ${error.message}`);
  }
}