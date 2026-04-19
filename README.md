# hubot-discord

> Hubot chatbot connected to Discord, containerised with Docker and published to GitHub Container Registry (GHCR) via GitHub Actions.

---

## Table of contents

1. [Prerequisites](#prerequisites)
2. [Create a Discord bot token](#create-a-discord-bot-token)
3. [Environment variables](#environment-variables)
4. [Run locally with Docker Compose](#run-locally-with-docker-compose)
5. [Run locally with Docker](#run-locally-with-docker)
6. [Build locally](#build-locally)
7. [GitHub Actions publish flow](#github-actions-publish-flow)
8. [GHCR image naming convention](#ghcr-image-naming-convention)
9. [Extending Hubot with additional scripts](#extending-hubot-with-additional-scripts)

---

## Prerequisites

| Tool | Version |
| ---- | ------- |
| Docker | 24+ |
| Docker Compose | v2+ |
| Node.js (local dev only) | 22 LTS |
| npm | 9+ |
| A Discord application & bot | — |

---

## Create a Discord bot token

1. Go to <https://discord.com/developers/applications> and click **New Application**.
2. Give it a name, then open the **Bot** tab.
3. Click **Add Bot** → **Yes, do it!**.
4. Under **Privileged Gateway Intents** enable **Message Content Intent** (required for reading message content).
5. Click **Reset Token** and copy the token – this becomes `HUBOT_DISCORD_TOKEN`.
6. Use **OAuth2 → URL Generator** (scopes: `bot`; permissions: `Send Messages`, `Read Message History`) to generate an invite link, then invite the bot to your server.

---

## Environment variables

Copy `.env.example` to `.env` and fill in the values:

```bash
cp .env.example .env
```

| Variable | Required | Default | Description |
| -------- | -------- | ------- | ----------- |
| `HUBOT_DISCORD_TOKEN` | **yes** | — | Discord bot token |
| `HUBOT_NAME` | no | `hubot` | The name the bot responds to |
| `HUBOT_OWNER` | no | — | Owner name shown in help |
| `HUBOT_DESCRIPTION` | no | — | Bot description shown in help |
| `HUBOT_LOG_LEVEL` | no | `info` | Log verbosity: `debug` \| `info` \| `warning` \| `error` |
| `REDIS_URL` | no | `redis://localhost:6379` | Redis connection URL used by `hubot-redis-brain` |
| `LOKI_URL` | no | `http://host.docker.internal:3100` | Loki base URL used by `hubot node logs` |
| `LOKI_USERNAME` | no | — | Optional Loki basic auth username |
| `LOKI_PASSWORD` | no | — | Optional Loki basic auth password |
| `NODE_LOGS_CACHE_TTL_SECONDS` | no | `30` | Redis cache TTL for `node.logs` replies; set `0` to disable |
| `MONGO_HOST` | no | `host.docker.internal` | MongoDB host used when `MONGO_URL` is not set |
| `MONGO_PORT` | no | `27017` | MongoDB port used when `MONGO_URL` is not set |
| `MONGO_USERNAME` | no | — | MongoDB username used when `MONGO_URL` is not set |
| `MONGO_PASSWORD` | no | — | MongoDB password used when `MONGO_URL` is not set |
| `MONGO_AUTH_SOURCE` | no | `mqtt` | MongoDB auth source used when `MONGO_URL` is not set |
| `MONGO_URL` | no | — | Optional full MongoDB connection string override for the `mqtt` account commands |
| `MONGO_DB_NAME` | no | `mqtt` | MongoDB database name used by the `mqtt` account commands |
| `MQTT_ADMIN_ROLE_IDS` | no | — | Comma-separated Discord role IDs allowed to run MQTT admin commands |
| `MQTT_ADMIN_ROLE_NAMES` | no | — | Comma-separated Discord role names allowed to run MQTT admin commands |

> **Security note:** Never commit your `.env` file. It is listed in `.gitignore`.

---

## Run locally with Docker Compose

A `docker-compose.yml` is provided for local testing. It builds the image and
passes your `.env` file into the container automatically:

```bash
# Copy the example env file and fill in your token
cp .env.example .env

# Build and start (foreground – useful for watching logs)
docker compose up --build

# Build and start detached
docker compose up --build -d
docker compose logs -f

# Tear down
docker compose down
```

---

## Run locally with Docker

```bash
# Build the image
docker build -t hubot-discord .

# Run with environment variables from your .env file
docker run --rm --env-file .env hubot-discord
```

---

## Build locally

```bash
# Install dependencies
npm install

# Start the bot (reads variables from the shell environment)
export HUBOT_DISCORD_TOKEN=your-token-here
npm start

# Start with verbose logging
npm run dev
```

---

## GitHub Actions publish flow

The workflow at `.github/workflows/docker-publish.yml` runs on:

| Trigger | Build | Push to GHCR |
| ------- | ----- | ------------ |
| Pull request targeting `main` | ✅ | ❌ |
| Push to `main` | ✅ | ✅ |
| Push of a `v*` tag | ✅ | ✅ |

Authentication uses the automatic `GITHUB_TOKEN` — no extra secrets are required.

### Enable package write permission (first-time setup)

If the first push to GHCR fails with a `403`, go to:

> **Settings → Actions → General → Workflow permissions**

and set it to **Read and write permissions**, then re-run the workflow.

---

## GHCR image naming convention

```
ghcr.io/flmesh/hubot:latest          # tracks main
ghcr.io/flmesh/hubot:sha-<shortsha>  # every pushed commit
ghcr.io/flmesh/hubot:1.2.3           # semver release (v1.2.3 tag)
ghcr.io/flmesh/hubot:1.2
ghcr.io/flmesh/hubot:1
```

---

## Extending Hubot with additional scripts

1. Add a `.js` (ES module) file to the `scripts/` directory.
2. Export a default function that receives the `robot` instance:

```js
export default (robot) => {
  robot.commands.register({
    id: "hello",
    description: "Say hello",
    confirm: "never",
    handler: async () => "Hello there!",
  });
};
```

3. Rebuild the Docker image (or restart `npm start` locally) – Hubot loads all files in `scripts/` automatically.

For reusable community scripts, install them via npm and list them in `external-scripts.json`.

## Built-In Node Logs Command

This repository includes a built-in command that queries Loki for EMQX log
entries for a single client ID.

Supported command form:

```text
hubot node.logs clientid:<clientid> [minutes:<n>] [limit:<n>]
```

Behavior:

- Input is an 8-character lowercase hexadecimal node ID. It can be passed as
  `a1b2c3d4` or `!a1b2c3d4`.
- The command searches EMQX entries that match approved client ID patterns, and
  then refines results to entries that resolve to the provided node ID.
- If `minutes` is omitted, it defaults to `15`.
- `limit` is optional and capped server-side to avoid oversized chat messages.
- Returned fields are fixed to: timestamp, level, clientid, action, topic, and
  msg.
- Replies are cached in Redis for `30` seconds by default to reduce repeated
  Loki queries. Set `NODE_LOGS_CACHE_TTL_SECONDS=0` to disable caching.
- Command help is available with `@hubot node.logs --help`.

> **Adapter note:** The Discord adapter is loaded by its full npm package name
> `@hubot-friends/hubot-discord`. Do **not** use the short alias `discord` – Hubot
> will fail to resolve the module.

## Built-In MQTT Account Commands

This repository includes an initial MongoDB-backed MQTT account workflow for
EMQX.

Supported command forms:

```text
hubot mqtt.request username:<username>
hubot mqtt.my-account
hubot mqtt.rotate
hubot mqtt.whois username:<username>
hubot mqtt.disable username:<username>
hubot mqtt.enable username:<username>
hubot mqtt.set-profile username:<username> profile:<profile>
```

Behavior:

- `mqtt.request` validates the requested username against `username_policy`,
  loads the current default profile, provisions the account in MongoDB, and
  sends the generated password by DM.
- `mqtt.my-account` shows the caller's current MQTT username, status, profile,
  and creation time.
- `mqtt.rotate` rotates the caller's password and sends the new password by DM.
  When invoked with `username:<username>`, it becomes an admin-only rotation
  path for another user's account and attempts to DM the new password to the
  account owner.
- `mqtt.whois`, `mqtt.disable`, `mqtt.enable`, and `mqtt.set-profile` are
  admin-only and require the caller to hold a configured
  Discord role from `MQTT_ADMIN_ROLE_IDS` or `MQTT_ADMIN_ROLE_NAMES`.
- The commands can either use `MONGO_URL` directly or construct a connection
  string from `MONGO_HOST`, `MONGO_PORT`, `MONGO_USERNAME`, `MONGO_PASSWORD`,
  `MONGO_AUTH_SOURCE`, and `MONGO_DB_NAME`.
- The discrete settings are the recommended path because Hubot safely encodes
  the MongoDB username and password when building the URI.
