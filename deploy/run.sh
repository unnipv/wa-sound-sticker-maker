#!/usr/bin/env bash
# Run the sticker web app + a Cloudflare quick tunnel, and telegram the fresh URL
# every time this script starts (i.e. on every service start/restart).
# If either the app or the tunnel dies, this exits non-zero so systemd restarts
# the pair -- which re-sends the new link.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
ROOT="$PWD"
RUN="$ROOT/.run"
mkdir -p "$RUN" "$ROOT/data"

PORT="${PORT:-8080}"
CF="${CLOUDFLARED_BIN:-$HOME/.local/bin/cloudflared}"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
APP_PID=""; TUNNEL_PID=""

cleanup() {
  [ -n "$TUNNEL_PID" ] && kill "$TUNNEL_PID" 2>/dev/null
  [ -n "$APP_PID" ] && kill "$APP_PID" 2>/dev/null
  wait 2>/dev/null
}
trap cleanup EXIT INT TERM

notify() { bash deploy/notify-telegram.sh "$1" || true; }

# --- app ------------------------------------------------------------------
echo "[run] $(date -Is) starting app on :$PORT"
"$NODE_BIN" server.js >> "$RUN/app.log" 2>&1 &
APP_PID=$!

app_up=""
for _ in $(seq 1 90); do
  kill -0 "$APP_PID" 2>/dev/null || break
  if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/api/status" >/dev/null 2>&1; then app_up=1; break; fi
  sleep 1
done
if [ -z "$app_up" ]; then
  echo "[run] app did not come up; log tail:"
  tail -n 30 "$RUN/app.log"
  notify "⚠️ sticker studio: the app crashed on start (port $PORT). Check .run/app.log on omarchy."
  exit 1
fi
echo "[run] app is up"

# --- tunnel ---------------------------------------------------------------
find_url() {
  grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$RUN/tunnel.log" 2>/dev/null | head -1
}

start_tunnel() {
  : > "$RUN/tunnel.log"
  "$CF" tunnel --no-autoupdate --url "http://127.0.0.1:$PORT" >> "$RUN/tunnel.log" 2>&1 &
  TUNNEL_PID=$!
  local url=""
  for _ in $(seq 1 60); do
    url=$(find_url); [ -n "$url" ] && break
    kill -0 "$TUNNEL_PID" 2>/dev/null || break
    sleep 1
  done
  echo "$url"
}

URL=""
if [ -x "$CF" ]; then
  # Cloudflare rate-limits quick-tunnel provisioning (HTTP 429 "Tunnelstore request
  # failed"), so back off instead of hammering it: 8 tries with growing delays (~6 min).
  delay=5
  for attempt in $(seq 1 8); do
    URL=$(start_tunnel)
    [ -n "$URL" ] && break
    if grep -q "429" "$RUN/tunnel.log" 2>/dev/null; then
      echo "[run] cloudflared rate-limited (429) on attempt $attempt; waiting ${delay}s"
    else
      echo "[run] tunnel attempt $attempt produced no URL; waiting ${delay}s"
    fi
    kill "$TUNNEL_PID" 2>/dev/null
    sleep "$delay"
    delay=$(( delay * 2 )); [ "$delay" -gt 120 ] && delay=120
  done
else
  echo "[run] cloudflared missing at $CF"
fi

STAMP=$(date '+%d %b, %H:%M %Z')
if [ -n "$URL" ]; then
  LIVE=""
  for _ in $(seq 1 30); do
    curl -fsS --max-time 5 "$URL/api/status" >/dev/null 2>&1 && { LIVE="$URL"; break; }
    sleep 2
  done
  if [ -n "$LIVE" ]; then
    echo "$LIVE" > "$RUN/url"
    echo "[run] public URL: $LIVE"
    notify "🎬 Sticker studio is live — $STAMP
$LIVE
Upload a video → get a WhatsApp sound sticker on your phone. This link changes whenever the server restarts."
  else
    echo "$URL" > "$RUN/url"
    echo "[run] URL $URL not answering from outside yet"
    notify "🎬 Sticker studio restarted — $STAMP
$URL
(Not reachable from outside yet; give it a minute.)"
  fi
else
  echo "http://127.0.0.1:$PORT" > "$RUN/url"
  LAN=$(ip -4 addr show scope global 2>/dev/null | grep -oE 'inet 192\.168\.[0-9.]+' | awk '{print $2}' | head -1)
  notify "⚠️ Sticker studio restarted — $STAMP — Cloudflare will not give us a public link right now (it rate-limits quick tunnels; retried 8 times).
Local only: http://127.0.0.1:$PORT${LAN:+
Same Wi-Fi: http://$LAN:$PORT}
I'll send a fresh public link on the next restart that succeeds."
fi

# --- supervise ------------------------------------------------------------
if [ -n "$TUNNEL_PID" ]; then
  wait -n "$APP_PID" "$TUNNEL_PID"
  echo "[run] a child exited (app=$APP_PID tunnel=$TUNNEL_PID); exiting so systemd restarts the pair"
  exit 1
fi
wait "$APP_PID"
exit 1
