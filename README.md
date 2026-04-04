# hubot-discord

> Hubot chatbot connected to Discord, containerised with Docker and published to GitHub Container Registry (GHCR) via GitHub Actions.

---

## Table of contents

1. [Prerequisites](#prerequisites)
2. [Create a Discord bot token](#create-a-discord-bot-token)
3. [Environment variables](#environment-variables)
4. [Run locally with Docker](#run-locally-with-docker)
5. [Build locally](#build-locally)
6. [GitHub Actions publish flow](#github-actions-publish-flow)
7. [GHCR image naming convention](#ghcr-image-naming-convention)
8. [Extending Hubot with additional scripts](#extending-hubot-with-additional-scripts)

---

## Prerequisites

| Tool | Version |
|------|---------|
| Docker | 24+ |
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
|----------|----------|---------|-------------|
| `HUBOT_DISCORD_TOKEN` | **yes** | — | Discord bot token |
| `HUBOT_NAME` | no | `hubot` | The name the bot responds to |
| `HUBOT_OWNER` | no | — | Owner name shown in help |
| `HUBOT_DESCRIPTION` | no | — | Bot description shown in help |
| `HUBOT_LOG_LEVEL` | no | `info` | Log verbosity: `debug` \| `info` \| `warning` \| `error` |

> **Security note:** Never commit your `.env` file. It is listed in `.gitignore`.

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
|---------|-------|--------------|
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
  robot.respond(/hello$/i, (msg) => {
    msg.reply("Hello there!");
  });
};
```

3. Rebuild the Docker image (or restart `npm start` locally) – Hubot loads all files in `scripts/` automatically.

For reusable community scripts, install them via npm and list them in `external-scripts.json`.
