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

## Image quality

Updated `makeWebp()` in `lib/sticker.js` to denoise video before scaling (`hqdn3d=2:1:3:2,fps=<fps>,<scale>`), encode with `-compression_level 6 -preset photo`, and replace the coarse quality ladder with a budget-maximizing binary search over `q ∈ [40, 82]` across `fps ∈ [15, 12, 10, 8, 6]` (accepting the first fps reaching `q ≥ 55`, otherwise keeping the highest `q`, with `[5,30] [5,20] [4,15]` fallback rungs and a 512 B EXIF headroom reserve so final output never exceeds 512,000 B).

### `bash scripts/smoke.sh` (passed)

```text
[smoke] Generating synthetic 8s video + audio clip with ffmpeg...
[smoke] Starting server on http://127.0.0.1:18080...
[smoke] POST http://127.0.0.1:18080/api/jobs...
[smoke] Created job: 69e05680a431a41e3e
[smoke] Results:
  sticker.webp : 175168 bytes (limit: 512000)
  audio.ogg    : 69225 bytes
  audio dur    : 7.013000 s (reported: 7 s, limit: 10 s)
  EXIF sha256  : verified (J0Gu5VhWTkNazUQn...)
[smoke] PASS
```

### `bash scripts/smoke-youtube.sh` (passed)

```text
[smoke-yt] Starting server on http://127.0.0.1:18081...
[smoke-yt] POST http://127.0.0.1:18081/api/yt/info (https://www.youtube.com/watch?v=jNQXAC9IVRw)...
[smoke-yt] Info: jNQXAC9IVRw | Me at the zoo | 19s | jawed
[smoke-yt] POST http://127.0.0.1:18081/api/jobs (source=youtube, start=2, duration=6)...
[smoke-yt] Created job: 6c3121ecc49373aca5
[smoke-yt] Results:
  videoTitle   : Me at the zoo
  sticker.webp : 510888 bytes (limit: 512000)
  audio.ogg    : 81495 bytes
  audio dur    : 10.013000 s (reported: 10 s, limit: 10 s)
  EXIF sha256  : verified (sY9k5IFxeAESz900...)
[smoke-yt] PASS
```

### Scratch-port verification (`PORT=18090`, `RELAY_ENABLED=false`)

1. **Big Buck Bunny (`aqz-KE-bpKQ`, start 66 s, duration 6 s)** — improved from `fps=15, q=55, 440,476 B` to `fps=15, q=63, 505,952 B` (raw `505,708 B`, 98.8% of 512,000 B budget):

```json
{
  "ok": true,
  "id": "be85c5ea92b3466233",
  "status": "done",
  "stage": null,
  "source": "youtube",
  "createdAt": 1795701121916,
  "sourceUrl": "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
  "videoTitle": null,
  "sectionStart": 66,
  "sectionLength": 6,
  "sizes": {
    "stickerBytes": 505952,
    "audioBytes": 79458
  },
  "audioSeconds": 10,
  "animSeconds": 6,
  "hasAudio": true,
  "fps": 15,
  "quality": 63,
  "thumb": "/api/jobs/be85c5ea92b3466233/sticker.webp",
  "stickerUrl": "/api/jobs/be85c5ea92b3466233/sticker.webp",
  "audioUrl": "/api/jobs/be85c5ea92b3466233/audio.ogg"
}
```

2. **Image upload (800×600 PNG, mute)** — 2-frame animated WebP still path unchanged (`frames=2`, `fps=1`, `quality=90`, `23,472 B` ≤ 500 KB):

```json
{
  "ok": true,
  "id": "32ad35454f81b98a51",
  "status": "done",
  "stage": null,
  "source": "upload",
  "createdAt": 1795701143262,
  "sizes": {
    "stickerBytes": 23472,
    "audioBytes": 0
  },
  "audioSeconds": 0,
  "animSeconds": 2,
  "hasAudio": false,
  "fps": 1,
  "quality": 90,
  "thumb": "/api/jobs/32ad35454f81b98a51/sticker.webp",
  "stickerUrl": "/api/jobs/32ad35454f81b98a51/sticker.webp",
  "audioUrl": null
}
```

Server log lines:

```text
sticker: 512x512 fps=15 q=63 bytes=505708
sticker: 512x512 fps=1 q=90 bytes=23292
```

## Trim editor (TASK-TRIM)

### A. Overflow — reproduced, fixed, measured

**Before** (old `.yt-preview-grid`, headless Chromium, `jNQXAC9IVRw` loaded): at ≥720 px the two-up grid
put the 16:9 `.yt-embed-wrap` in a `1fr` column, but the row was stretched to the thumbnail card's height and
`aspect-ratio` derived the width *from that height* → `div.yt-embed-wrap` ended **75.6 px past the card's
right edge** at both 768 and 1280 px (embed 322×180 drawn at x=391..713 in a card ending at 638). ≤400 px
collapsed to one column, which is why phones looked fine.

**After**: one full-width `.player-frame` (`width:100%; max-width:100%; aspect-ratio:16/9; overflow:hidden;
contain:layout paint`), every child (`iframe`/`video`/poster/overlay) `position:absolute; inset:0;
width/height:100%`, meta line underneath. Timeline handles hang off the band but live inside `.tl`'s
horizontal padding, so they can't leave the card either.

Assertion: for every descendant of `#editor-card` with a box, `rect.right <= card.rect.right + 1`, and
`document.body.scrollWidth <= innerWidth`. Measured three states per width — YouTube with band at 0:00,
YouTube with the band pinned to the far right end (worst case for the right handle), and the Upload tab with a
12 s clip loaded and its band at the end:

| width | state | card.right | max(desc.right − card.right) | body.scrollWidth / innerWidth | 16:9 player box | result |
|---|---|---|---|---|---|---|
| 360 | YT, band at start | 348 | −1 | 360 / 360 | 28..332 (304×170) | PASS |
| 360 | YT, band at end | 348 | −1 | 360 / 360 | 28..332 (304×170) | PASS |
| 360 | Upload, band at end | 348 | −1 | 360 / 360 | — | PASS |
| 390 | YT, band at start | 378 | −1 | 390 / 390 | 28..362 (334×187) | PASS |
| 390 | YT, band at end | 378 | −1 | 390 / 390 | 28..362 (334×187) | PASS |
| 390 | Upload, band at end | 378 | −1 | 390 / 390 | — | PASS |
| 768 | YT, band at start | 638 | −25 | 768 / 768 | 156..612 (456×256) | PASS |
| 768 | YT, band at end | 638 | −25 | 768 / 768 | 156..612 (456×256) | PASS |
| 768 | Upload, band at end | 638 | −25 | 768 / 768 | — | PASS |
| 1280 | YT, band at start | 894 | −25 | 1280 / 1280 | 412..868 (456×256) | PASS |
| 1280 | YT, band at end | 894 | −25 | 1280 / 1280 | 412..868 (456×256) | PASS |
| 1280 | Upload, band at end | 894 | −25 | 1280 / 1280 | — | PASS |

(−1 at phone widths is the sticky `.action-bar`, which deliberately bleeds to the card's inner border.)
`Network.setBlockedURLs` for `*youtube.com/embed*` / `*ytimg.com*` was set as instructed, but it does not
reach the out-of-process YouTube iframe in this Chromium (155) — the real embed loaded and the tab did **not**
crash, so the boxes above are with the real player in place. Thumbnails were blocked.

### B/C. One `createTrimEditor()` + three adapters (`public/app.js`)

- Markup lives once in `<template id="trim-editor-tpl">`; each source clones it. Adapters:
  `videoAdapter(<video>)` (upload), `ytApiAdapter(YT.Player)` (IFrame API, `playsinline:1, controls:0,
  modestbranding:1, rel:0, disablekb:1, origin`), `ytEmbedAdapter(iframe)` (API didn't load within 8 s →
  plain embed with YouTube's own controls, timeline reloads `?start=`, Preview reloads `?start&end&autoplay`).
- IFrame API is injected lazily the first time the YouTube tab is opened.
- `#yt-start-input` still holds the start (timeline writes into it, typing moves the band); band length writes
  `#yt-duration-slider` / `#duration-slider` (step now 0.1). Upload start is written to the (now hidden)
  `#start-slider`. Job payloads unchanged.

### Headless drive (Chromium 155, 390 px)

- **Fetch `jNQXAC9IVRw`, drag the band body from its centre +3 s, press Build** → readouts `0:03.0 → 0:09.0`,
  input `0:03`; captured job payload `source=youtube, youtubeUrl=…jNQXAC9IVRw, start=3, duration=6,
  mute=false, audioVolume=1, fit=fit`; job completed (`499 KB`, "From YouTube: Me at the zoo").
- **Live seek on the real `YT.Player`** (instance methods spied): the 0→3 s drag produced
  `mute() pauseVideo() seekTo(0.0) pauseVideo() seekTo(0.3) … seekTo(2.4) pauseVideo() seekTo(3.0) pauseVideo()`
  (throttled to ~120 ms, last seek lands on the final value). Preview: `seekTo(3.0) unMute() playVideo()`.
  Shift+← → `seekTo(2.0)`, input `0:02`. Typing `0:07.5` → `seekTo(7.5)`, band `0:07.5 → 0:13.5`.
  Left-handle drag +2.8 s from start 2.5 → `start=5.3, duration=3.2` in the payload.
  Caveat: headless Chromium can't decode YouTube's stream, so the *picture* at the seeked frame was only
  verifiable as the player sitting paused at 0:03 with that moment's caption showing — check on a phone.
- **Upload (12 s testsrc clip)**: band drag +4 s → `video.currentTime=4, paused`, start `4`; right handle −2 s →
  `currentTime=8.4` (end frame shown), length `4.4`; →→→ + Shift+→ → start `5.3`; click track @1 s → playhead 1,
  band unchanged; *Set start here* → start `1`; *Preview selection* sampled every 0.5 s:
  `1.45 1.95 2.45 2.95 3.45 3.95 4.46 4.96 1.03 1.53 … 5.04 1.09` (loops inside 1.0–5.4); toggle off → paused.
  Payload after 3× Shift+→: `start=3, duration=6`.

### D. Failure states (verified)

- `jkYTx3IeSfc` → `/api/yt/info` `422 video_unavailable` → UI: "YouTube won't serve this video to our server —
  it may be region-locked, age-restricted or a live stream."
- Player `onError(150)` (simulated) → poster + meta + timeline stay; note: "This video's owner doesn't allow
  playback outside YouTube, so there's no live preview. Trimming still works from the numbers — the sticker is
  cut at exactly these times."; play/preview hidden/disabled, nudges/keys/typing still drive the numbers.
- IFrame API blocked → plain embed `…/embed/jNQXAC9IVRw?playsinline=1&rel=0&start=0`; typing `0:07.4` →
  `start=7`; Preview → `start=7&end=14&autoplay=1`.

### Smoke

- `bash scripts/smoke.sh` — PASS (sticker 175,168 B, audio 7.01 s, EXIF sha256 verified)
- `bash scripts/smoke-youtube.sh` — PASS (sticker 510,888 B, audio 10.01 s, EXIF sha256 verified)

## Audio length matches selection (TASK-AUDIO)

Updated `makeAudio(src, start, outDir, volume, maxSeconds)` in `lib/sticker.js` so `-t` is capped at `min(maxSeconds, MAX_AUDIO_SEC)` instead of always cutting `MAX_AUDIO_SEC` (10 s). `buildSticker()` computes `audioLimit = Math.min(MAX_AUDIO_SEC, animSec)` and passes it for both embedded media audio and separately uploaded audio files. Updated UI result metadata to show `<anim>s sticker · <audio>s sound` (one decimal) and added `"Sound is cut to the same window."` under `Animation length`.

### `bash scripts/smoke.sh` (passed)

```text
[smoke] Generating synthetic 8s video + audio clip with ffmpeg...
[smoke] Starting server on http://127.0.0.1:18080...
[smoke] POST http://127.0.0.1:18080/api/jobs...
[smoke] Created job: 6204e2ccd85225d558
[smoke] Results:
  sticker.webp : 175168 bytes (limit: 512000)
  audio.ogg    : 58767 bytes
  audio dur    : 6.013000 s (reported: 6 s, limit: 10 s)
  EXIF sha256  : verified (l2mj2abskPL1ZdXN...)
[smoke] PASS
```

### `bash scripts/smoke-youtube.sh` (passed)

```text
[smoke-yt] Starting server on http://127.0.0.1:18081...
[smoke-yt] POST http://127.0.0.1:18081/api/yt/info (https://www.youtube.com/watch?v=jNQXAC9IVRw)...
[smoke-yt] Info: jNQXAC9IVRw | Me at the zoo | 19s | jawed
[smoke-yt] POST http://127.0.0.1:18081/api/jobs (source=youtube, start=2, duration=6)...
[smoke-yt] Created job: 40ebde975e310fd6d2
[smoke-yt] Results:
  videoTitle   : Me at the zoo
  sticker.webp : 510888 bytes (limit: 512000)
  audio.ogg    : 48860 bytes
  audio dur    : 6.013000 s (reported: 6 s, limit: 10 s)
  EXIF sha256  : verified (yn297zhCXTsFhRhj...)
[smoke-yt] PASS
```

### Scratch-port verification (`PORT=18097`, `RELAY_ENABLED=false`)

Summary of the three measured `audio.ogg` durations:

| Case | Selection | `ffprobe` audio duration | Job `audioSeconds` / `animSeconds` | Sticker WebP frames / duration |
|---|---|---|---|---|
| YouTube `aqz-KE-bpKQ` (`start=600`, `duration=2`) | 2 s | `2.013000 s` (17,164 B) | `2` / `2` | `16` frames @ 8 fps (`2000 ms`, 510,574 B) |
| YouTube `aqz-KE-bpKQ` (`start=600`, `duration=6`) | 6 s | `6.013000 s` (49,718 B) | `6` / `6` | `24` frames @ 4 fps (`6000 ms`, 400,890 B) |
| Uploaded 8 s clip (`start=1`, `duration=2`) | 2 s | `2.013000 s` (18,685 B) | `2` / `2` | `30` frames @ 15 fps (`1999 ms`, 60,552 B) |

Raw `ffprobe` & job output:

```text
--- yt_2s ---
JOB_JSON: {"ok":true,"id":"6de55045b53b838f08","status":"done","stage":null,"source":"youtube","fit":"fit","createdAt":1795709587271,"sourceUrl":"https://www.youtube.com/watch?v=aqz-KE-bpKQ","videoTitle":null,"sectionStart":600,"sectionLength":2,"sizes":{"stickerBytes":510574,"audioBytes":17164},"audioSeconds":2,"animSeconds":2,"hasAudio":true,"fps":8,"quality":57,"thumb":"/api/jobs/6de55045b53b838f08/sticker.webp","stickerUrl":"/api/jobs/6de55045b53b838f08/sticker.webp","audioUrl":"/api/jobs/6de55045b53b838f08/audio.ogg"}
FFPROBE_AUDIO:
codec_name=opus
sample_rate=48000
channels=1
duration=2.013000
duration=2.013000
size=17164
WEBP_INFO: frames=16 totalMs=2000 bytes=510574

--- yt_6s ---
JOB_JSON: {"ok":true,"id":"5b506b9aec1d4f3d4c","status":"done","stage":null,"source":"youtube","fit":"fit","createdAt":1795709613108,"sourceUrl":"https://www.youtube.com/watch?v=aqz-KE-bpKQ","videoTitle":null,"sectionStart":600,"sectionLength":6,"sizes":{"stickerBytes":400890,"audioBytes":49718},"audioSeconds":6,"animSeconds":6,"hasAudio":true,"fps":4,"quality":15,"thumb":"/api/jobs/5b506b9aec1d4f3d4c/sticker.webp","stickerUrl":"/api/jobs/5b506b9aec1d4f3d4c/sticker.webp","audioUrl":"/api/jobs/5b506b9aec1d4f3d4c/audio.ogg"}
FFPROBE_AUDIO:
codec_name=opus
sample_rate=48000
channels=1
duration=6.013000
duration=6.013000
size=49718
WEBP_INFO: frames=24 totalMs=6000 bytes=400890

--- upload_8s_pick_2s ---
JOB_JSON: {"ok":true,"id":"2e0bcc7755ed2b2beb","status":"done","stage":null,"source":"upload","fit":"fit","createdAt":1795709666268,"sizes":{"stickerBytes":60552,"audioBytes":18685},"audioSeconds":2,"animSeconds":2,"hasAudio":true,"fps":15,"quality":82,"thumb":"/api/jobs/2e0bcc7755ed2b2beb/sticker.webp","stickerUrl":"/api/jobs/2e0bcc7755ed2b2beb/sticker.webp","audioUrl":"/api/jobs/2e0bcc7755ed2b2beb/audio.ogg"}
FFPROBE_AUDIO:
codec_name=opus
sample_rate=48000
channels=1
duration=2.013000
duration=2.013000
size=18685
WEBP_INFO: frames=30 totalMs=1999 bytes=60552
```
