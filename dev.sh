#!/usr/bin/env bash
# Starts a cloudflared quick tunnel, then the app with WEBAPP_URL pointing at it.
# The bot re-registers its menu button on every start, so a changed URL needs no manual step.
cd "$(dirname "$0")"
LOG=$(mktemp)
cloudflared tunnel --url http://localhost:${PORT:-3000} --no-autoupdate --protocol http2 >"$LOG" 2>&1 &
TUNNEL=$!
trap 'kill $TUNNEL 2>/dev/null' EXIT
for _ in $(seq 1 60); do
  URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1)
  [ -n "$URL" ] && break
  sleep 1
done
[ -z "$URL" ] && { echo "tunnel failed:"; cat "$LOG"; exit 1; }
echo "Public URL: $URL"
WEBAPP_URL="$URL" node --env-file=.env server.js
