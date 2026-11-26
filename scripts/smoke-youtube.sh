#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${SMOKE_YT_PORT:-18081}"
BASE_URL="http://127.0.0.1:${PORT}"
YT_URL="${SMOKE_YT_URL:-https://www.youtube.com/watch?v=jNQXAC9IVRw}"
TMP_DIR="$(mktemp -d)"
SERVER_PID=""

cleanup() {
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

echo "[smoke-yt] Starting server on ${BASE_URL}..."
PORT="$PORT" RELAY_ENABLED="false" APP_PASSCODE="" node "$ROOT_DIR/server.js" >"$TMP_DIR/server.log" 2>&1 &
SERVER_PID=$!

for _ in $(seq 1 30); do
  if curl -sf "${BASE_URL}/api/status" >/dev/null 2>&1; then
    break
  fi
  sleep 0.3
done

STATUS_JSON="$(curl -sf "${BASE_URL}/api/status" || true)"
if [[ -z "$STATUS_JSON" ]]; then
  echo "[smoke-yt] Server failed to start. Log:"
  cat "$TMP_DIR/server.log"
  exit 1
fi

YT_AVAIL="$(node -e "console.log(Boolean(JSON.parse(process.argv[1]).youtube?.available))" "$STATUS_JSON")"
if [[ "$YT_AVAIL" != "true" ]]; then
  echo "[smoke-yt] FAIL: /api/status reports youtube.available != true: ${STATUS_JSON}"
  exit 1
fi

echo "[smoke-yt] POST ${BASE_URL}/api/yt/info (${YT_URL})..."
INFO_JSON="$(curl -sf -X POST "${BASE_URL}/api/yt/info" \
  -H 'Content-Type: application/json' \
  -d "{\"url\":\"${YT_URL}\"}")"
node -e "
  const d = JSON.parse(process.argv[1]);
  if (!d.ok || !d.id || !d.title || !(d.duration > 0)) {
    console.error('[smoke-yt] FAIL: invalid info response:', d);
    process.exit(1);
  }
  console.log('[smoke-yt] Info:', d.id, '|', d.title, '|', d.duration + 's', '|', d.uploader);
" "$INFO_JSON"

echo "[smoke-yt] POST ${BASE_URL}/api/jobs (source=youtube, start=2, duration=6)..."
CREATE_RES="$(curl -sf -X POST "${BASE_URL}/api/jobs" \
  -H 'Content-Type: application/json' \
  -d "{\"source\":\"youtube\",\"youtubeUrl\":\"${YT_URL}\",\"start\":2,\"duration\":6,\"mute\":false,\"audioVolume\":1}")"

JOB_ID="$(node -e "const d = JSON.parse(process.argv[1]); if (!d.id) process.exit(1); console.log(d.id);" "$CREATE_RES")"
echo "[smoke-yt] Created job: ${JOB_ID}"

JOB_JSON=""
for _ in $(seq 1 180); do
  JOB_JSON="$(curl -sf "${BASE_URL}/api/jobs/${JOB_ID}")"
  STATUS="$(node -e "console.log(JSON.parse(process.argv[1]).status)" "$JOB_JSON")"
  if [[ "$STATUS" == "done" ]]; then
    break
  fi
  if [[ "$STATUS" == "error" ]]; then
    echo "[smoke-yt] Job failed: ${JOB_JSON}"
    exit 1
  fi
  sleep 0.5
done

STATUS="$(node -e "console.log(JSON.parse(process.argv[1]).status)" "$JOB_JSON")"
if [[ "$STATUS" != "done" ]]; then
  echo "[smoke-yt] Job timed out: ${JOB_JSON}"
  exit 1
fi

curl -sf "${BASE_URL}/api/jobs/${JOB_ID}/sticker.webp" -o "$TMP_DIR/sticker.webp"
curl -sf "${BASE_URL}/api/jobs/${JOB_ID}/audio.ogg" -o "$TMP_DIR/audio.ogg"

WEBP_BYTES="$(wc -c < "$TMP_DIR/sticker.webp")"
OGG_BYTES="$(wc -c < "$TMP_DIR/audio.ogg")"
AUDIO_DUR="$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$TMP_DIR/audio.ogg")"
AUDIO_SEC="$(node -e "console.log(JSON.parse(process.argv[1]).audioSeconds)" "$JOB_JSON")"
VIDEO_TITLE="$(node -e "console.log(JSON.parse(process.argv[1]).videoTitle || '')" "$JOB_JSON")"

echo "[smoke-yt] Results:"
echo "  videoTitle   : ${VIDEO_TITLE}"
echo "  sticker.webp : ${WEBP_BYTES} bytes (limit: 512000)"
echo "  audio.ogg    : ${OGG_BYTES} bytes"
echo "  audio dur    : ${AUDIO_DUR} s (reported: ${AUDIO_SEC} s, limit: 10 s)"

if (( WEBP_BYTES <= 0 || WEBP_BYTES > 512000 )); then
  echo "[smoke-yt] FAIL: sticker.webp size out of bounds (${WEBP_BYTES})"
  exit 1
fi
if (( OGG_BYTES <= 0 )); then
  echo "[smoke-yt] FAIL: audio.ogg is empty"
  exit 1
fi
node -e "const d = Number(process.argv[1]); if (!(d > 0 && d <= 10.2)) { console.error('FAIL: audio duration out of bounds:', d); process.exit(1); }" "$AUDIO_DUR"

node -e "
import('node:fs').then(async ({ readFileSync }) => {
  const { createHash } = await import('node:crypto');
  const webp = readFileSync(process.argv[1]);
  const ogg = readFileSync(process.argv[2]);
  const expected = createHash('sha256').update(ogg).digest('base64');
  if (!webp.includes(Buffer.from(expected))) {
    console.error('FAIL: EXIF sound-sha256 mismatch');
    process.exit(1);
  }
  console.log('  EXIF sha256  : verified (' + expected.slice(0, 16) + '...)');
});
" "$TMP_DIR/sticker.webp" "$TMP_DIR/audio.ogg"

echo "[smoke-yt] PASS"
