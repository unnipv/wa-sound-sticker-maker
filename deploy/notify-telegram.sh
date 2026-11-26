#!/usr/bin/env bash
# Send a message to the user's Telegram chat. Token/chat come from ~/.hermes/.env
# (TELEGRAM_BOT_TOKEN / TELEGRAM_HOME_CHANNEL) or from the environment.
set -uo pipefail

ENV_FILE="${HERMES_ENV_FILE:-$HOME/.hermes/.env}"
TOKEN="${TELEGRAM_BOT_TOKEN:-}"
CHAT="${TELEGRAM_HOME_CHANNEL:-}"

if [ -z "$TOKEN" ] || [ -z "$CHAT" ]; then
  if [ -f "$ENV_FILE" ]; then
    # shellcheck disable=SC1090
    set -a; . "$ENV_FILE"; set +a
    TOKEN="${TELEGRAM_BOT_TOKEN:-}"
    CHAT="${TELEGRAM_HOME_CHANNEL:-}"
  fi
fi

MSG="${1:-}"
[ -z "$MSG" ] && { echo "usage: $0 <message>" >&2; exit 2; }
[ -z "$TOKEN" ] && { echo "no TELEGRAM_BOT_TOKEN" >&2; exit 3; }
[ -z "$CHAT" ] && { echo "no TELEGRAM_HOME_CHANNEL" >&2; exit 3; }

resp=$(curl -sS --max-time 20 -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
  -d "chat_id=${CHAT}" \
  --data-urlencode "text=${MSG}" \
  -d "disable_web_page_preview=false" 2>&1) || { echo "curl failed: $resp" >&2; exit 4; }

case "$resp" in
  *'"ok":true'*) echo "telegram: sent" ; exit 0 ;;
  *) echo "telegram: failed: $resp" >&2 ; exit 5 ;;
esac
