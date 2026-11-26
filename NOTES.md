# NOTES — Verification & Runbook

## Running the App

```bash
cp .env.example .env   # edit ADMIN_TOKEN (and optional APP_PASSCODE)
npm install
node server.js
```

Open `http://localhost:8080` (or expose via `cloudflared tunnel --url http://localhost:8080`).
To pair the server's relay WhatsApp account (a spare number), open `http://localhost:8080/admin?token=<ADMIN_TOKEN>` and scan the QR code or use an 8-digit pairing code.

## Verification

### `bash scripts/smoke.sh` (passed)

```text
[smoke] Generating synthetic 8s video + audio clip with ffmpeg...
[smoke] Starting server on http://127.0.0.1:18080...
[smoke] POST http://127.0.0.1:18080/api/jobs...
[smoke] Created job: 95f9e714fdd7b2ec13
[smoke] Results:
  sticker.webp : 135052 bytes (limit: 512000)
  audio.ogg    : 69225 bytes
  audio dur    : 7.013000 s (reported: 7 s, limit: 10 s)
  EXIF sha256  : verified (EtEviVkR4kNbnPgT...)
[smoke] PASS
```

### Protobuf wire-format check (passed)

```text
[proto-check] Field 134 wrapper + StickerMessage.26 AudioMessage encoded cleanly (74 bytes)
```

### Not verified

- **Not verified: actual send, needs a linked device.** Both delivery modes (`relay` via `data/relay/` and `self` via per-session `data/sessions/<sid>/`) and the `patchStickerProto()` field-134/field-26 encoder are wired end-to-end, but live delivery to an Android/iOS WhatsApp account could not be exercised without a paired phone. When the relay is unpaired, the UI explicitly disables the relay send button with `"Server's WhatsApp isn't linked yet"`.

## YouTube source

- `lib/youtube.js` resolves `process.env.YTDLP_BIN` first, then `~/.local/bin/yt-dlp`, then `yt-dlp` on `PATH` (with `~/.local/bin` prepended so `deno` is also found for YouTube JS challenges).
- Every `yt-dlp` invocation passes `--force-ipv4` because IPv6 is broken on this host and hangs after `"Downloading webpage"`.
- URLs are strictly validated against YouTube hosts (`youtube.com`, `youtu.be`, `m.youtube.com`, `music.youtube.com`) and canonicalized to `https://www.youtube.com/watch?v=<id>` as an SSRF guard.

### `bash scripts/smoke-youtube.sh` (passed)

```text
[smoke-yt] Starting server on http://127.0.0.1:18081...
[smoke-yt] POST http://127.0.0.1:18081/api/yt/info (https://www.youtube.com/watch?v=jNQXAC9IVRw)...
[smoke-yt] Info: jNQXAC9IVRw | Me at the zoo | 19s | jawed
[smoke-yt] POST http://127.0.0.1:18081/api/jobs (source=youtube, start=2, duration=6)...
[smoke-yt] Created job: 72e478fb938f776fd0
[smoke-yt] Results:
  videoTitle   : Me at the zoo
  sticker.webp : 488368 bytes (limit: 512000)
  audio.ogg    : 81495 bytes
  audio dur    : 10.013000 s (reported: 10 s, limit: 10 s)
  EXIF sha256  : verified (3x3dD4Q+zxKyYvH4...)
[smoke-yt] PASS
```

### Browser verification (headless Chromium, 390×844 mobile viewport)

- Invalid URL (`https://example.com/not-youtube`): showed inline error `"Only YouTube links (youtube.com or youtu.be) are supported."` with no `alert()`.
- Fetched `https://www.youtube.com/watch?v=jNQXAC9IVRw`: rendered `"Me at the zoo"`, uploader `"jawed"`, duration `0:19`, thumbnail, and embedded player `https://www.youtube.com/embed/jNQXAC9IVRw?start=0`.
- Set start to `0:03` (blur): normalized to `0:03`, range readout `0:03 – 0:09`, embed `src` updated to `https://www.youtube.com/embed/jNQXAC9IVRw?start=3`.
- Built clip: progress showed `"Fetching clip… (0:03–0:09)"` → encoding → preview rendered `512×512` WebP sticker (`Sticker: 475 KB / 500 KB`), audio (`Audio: 10s (80 KB)`), and `"From YouTube: Me at the zoo"`.
