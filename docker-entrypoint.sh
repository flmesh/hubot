#!/bin/sh
# docker-entrypoint.sh – validate required environment variables before
# starting Hubot, so the container fails fast with a clear error message.

set -e

if [ -z "${HUBOT_DISCORD_TOKEN}" ]; then
  echo "ERROR: HUBOT_DISCORD_TOKEN is not set. Aborting." >&2
  exit 1
fi

exec node_modules/.bin/hubot \
  --adapter discord \
  --name "${HUBOT_NAME:-hubot}"
