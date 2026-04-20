import { MongoClient } from "mongodb";

let clientPromise;
let collectionsOverride = null;

function getMongoDbNameFromEnv() {
  return process.env.MONGO_DB_NAME?.trim() || "mqtt";
}

function buildMongoUrlFromParts() {
  const host = process.env.MONGO_HOST?.trim();
  const port = process.env.MONGO_PORT?.trim() || "27017";
  const dbName = getMongoDbNameFromEnv();
  const authSource = process.env.MONGO_AUTH_SOURCE?.trim() || dbName;
  const username = process.env.MONGO_USERNAME?.trim();
  const password = process.env.MONGO_PASSWORD ?? "";

  if (!host) {
    throw new Error("MONGO_HOST is not configured");
  }

  if (!username) {
    throw new Error("MONGO_USERNAME is not configured");
  }

  const encodedUsername = encodeURIComponent(username);
  const encodedPassword = encodeURIComponent(password);
  return `mongodb://${encodedUsername}:${encodedPassword}@${host}:${port}/${dbName}?authSource=${encodeURIComponent(authSource)}`;
}

function getMongoUrl() {
  const mongoUrl = process.env.MONGO_URL?.trim() || buildMongoUrlFromParts();

  try {
    new URL(mongoUrl);
  } catch (error) {
    throw new Error(`MONGO_URL is invalid: ${error.message}. If the username or password contains reserved URL characters like /, :, @, ?, or #, percent-encode them.`);
  }

  return mongoUrl;
}

export function getMongoDbName() {
  return getMongoDbNameFromEnv();
}

export async function getMongoClient() {
  if (!clientPromise) {
    clientPromise = MongoClient.connect(getMongoUrl());
  }

  return clientPromise;
}

export async function getMqttDb() {
  const client = await getMongoClient();
  return client.db(getMongoDbName());
}

export async function getMqttCollections() {
  if (typeof collectionsOverride === "function") {
    return collectionsOverride();
  }

  const db = await getMqttDb();
  return {
    db,
    users: db.collection("users"),
    profiles: db.collection("profiles"),
    mqttAcl: db.collection("mqtt_acl"),
    mqttAudit: db.collection("mqtt_audit"),
    requests: db.collection("requests"),
    usernamePolicy: db.collection("username_policy"),
  };
}

export function setMqttCollectionsOverrideForTests(provider) {
  collectionsOverride = provider;
}

export function clearMqttCollectionsOverrideForTests() {
  collectionsOverride = null;
}
