# TASK — turn this CLI into a web app: upload a video → sound sticker → into WhatsApp

Read `TASK-RESEARCH.md` first, then `make.mjs` and `README.md`. Do the research part it asks for
(what field carries the audio today, whether a linked device is avoidable, iOS specifics), write
`RESEARCH.md`, and then **implement the web app below**. Ship it running; no test suite, no CI,
no review pass. One smoke script is required (see "Definition of done").

## Product

Anyone opens the URL on a phone or laptop, uploads a short video (or GIF/image, with optional
separate audio), previews the resulting **sound sticker**, and gets it into WhatsApp on their own
phone — then it lives in their sticker tray. Must work for Android **and** iOS.

Hard truth from the research pass: audio only survives in a sticker sent by a **linked WhatsApp
client** (the third-party sticker-pack import path is image-only). So the app has two delivery
modes:

1. **Relay (default for friends).** The server owns one WhatsApp account (a spare number, shared
   with an unrelated Splitwise bot that runs on another machine — that is fine, WhatsApp allows up
   to 4 linked devices and each socket is its own device entry). A friend types their phone number
   and receives the sticker from that number in their own chat with it. No setup for them.
   - The relay session must be paired **fresh** from this machine (its own creds under `data/relay/`).
     Never copy another app's auth dir — two sockets sharing one device identity fight each other.
   - The relay socket must register **no** incoming-message handlers beyond creds/connection: it
     never replies, never marks read, never downloads media. It only sends.
2. **Pair-your-own (fallback, and the honest path).** A friend links their own WhatsApp to the site
   (QR or 8-digit pairing code, one linked-device slot, ~20s), and the sticker is sent to their
   "Message yourself" chat. Session lives server-side per browser session.

After receiving, the UI tells them: long-press the sticker → **Add to favourites**, then send it
from the sticker tray anywhere. Include that card in the UI.

## Stack (keep it boring and buildable)

- Node 26 is installed. Express + `multer` (or busboy) for uploads, plain ES modules, **no build
  step**, vanilla HTML/CSS/JS frontend (mobile-first, dark, thumb-friendly). Deps wanted:
  `baileys@^7`, `express`, `multer`, `qrcode`, `node-webpmux`, `pino`, `dotenv`. Use the **system
  ffmpeg** (`ffmpeg`/`ffprobe` on PATH, v9 with `libwebp_anim` + `libopus`); fall back to
  `ffmpeg-static` only if not found. Do not add a bundler, framework, or DB.
- Directory layout:
  ```
  server.js            entry point, express wiring, static + api
  lib/sticker.js       port of make.mjs pipeline: probe → audio (ogg/opus mono 48k ≤10s) → animated
                       512×512 webp ≤500KB (quality ladder) → EXIF sound-sha256
  lib/jobs.js          in-memory job store + worker queue + TTL cleanup (1h) on data/jobs/<id>/
  lib/wa.js            baileys helpers: connect(authDir), patchStickerProto(), sendSoundSticker()
  lib/sessions.js      per-session (cookie sid) auth dirs + socket cache under data/sessions/<sid>/
  lib/relay.js         the single server-owned session under data/relay/ + pairing state machine
  public/index.html|app.js|style.css
  scripts/smoke.sh     see below
  data/                gitignored: jobs/, sessions/, relay/
  ```
- Config via `.env` (with `.env.example`): `PORT` (default 8080), `APP_PASSCODE` (optional gate for
  friends; cookie remembers it), `RELAY_ENABLED` (default on), `ADMIN_TOKEN` (protects `/admin` relay
  pairing), `MAX_UPLOAD_MB` (default 100), `PUBLIC_BASE_URL` (for links/shares).

## API

- `POST /api/jobs` — multipart: `media` (video/gif/image), optional `audio`, `start` (sec),
  `duration` (cap 6 for animation, audio ≤10), `mute` (bool → plain sticker, no audio), `audioVolume`.
  Returns `{id}` immediately; processing is async.
- `GET /api/jobs/:id` — `{status: queued|processing|done|error, error?, sizes, audioSeconds, thumb}`
- `GET /api/jobs/:id/sticker.webp` / `/audio.ogg` / `/preview.mp4`(optional) — outputs, with caching
  headers and range support not needed. `?download=1` → attachment.
- `POST /api/jobs/:id/send` — `{mode: "relay"|"self", phone?}` where `phone` is digits w/ country
  code. Returns `{ok, sentTo}` or a clear error (`relay_not_paired`, `not_a_whatsapp_number`, …).
- `GET /api/status` — `{relay: {paired, me}, self: {paired, me}, limits}`
- Self-pairing: `POST /api/pair/start` `{phone?}` → `{qr}` (data URL) and/or `{code}` (8-digit);
  `GET /api/pair/status`.
- Admin relay pairing: `GET /admin?token=…` page that shows relay QR/code and pairing state
  (`POST /api/relay/pair/start`, `GET /api/relay/pair/status`).

## Processing rules (from make.mjs, keep the proven numbers)

- Audio: first audio stream (or the uploaded audio), `-ss start`, `-t 10`, mono, 48 kHz,
  `libopus -b:a 64k`, OGG container, metadata stripped. No audio stream + not muted → error
  `no_audio_track` with a UI hint to upload an audio file.
- Sticker: video → `-ss start -t 6 fps ladder, scale 512:512 aspect-fit, transparent pad,
  libwebp_anim -loop 0`, quality/fps ladder until ≤500 KB. Image → 2-frame animated WebP (the
  original's trick, because libwebp_anim collapses identical frames).
- EXIF: same JSON as `make.mjs` with `sound-sha256` = base64(sha256(ogg bytes)); keep the pack
  name/publisher sensible ("Sound Sticker Studio").
- Send: patch proto for the audio field; `prepareWAMessageMedia` for sticker + audio in parallel;
  `generateWAMessageFromContent` → wait for key sync → `relayMessage`; keep the socket up long
  enough for the phone to fetch media; report the message id. Same shape as `make.mjs` lines
  208–231, driven by a persistent socket instead of a one-shot process.

## UI (mobile-first, single page)

1. Passcode screen if `APP_PASSCODE` set.
2. Upload: big drop/tap zone, then video preview with a **start-time slider** (0 → duration−6s) and
   a 1–6s length slider, a "sound from video / upload audio / no sound" choice, volume.
3. Build → progress → **sticker preview** that animates, an audio play button, size readout,
   "tweak & rebuild".
4. Deliver: two big buttons — "Send to my WhatsApp" (relay: asks for number once, remembers it in
   `localStorage`; self: pairs first) and "Download files". Then the favourites instructions card.
5. Footer: link count is irrelevant; show a tiny "runs on my own server" note. No cookies/analytics.

Show real errors, never a fake success. If the relay is not paired, the relay button is disabled
with "server's WhatsApp isn't linked yet".

## Definition of done

- `npm install && node server.js` serves the app on `:8080` with no build step.
- `bash scripts/smoke.sh` generates a synthetic 8s test clip with ffmpeg, POSTs it through the real
  API, polls the job, and prints the resulting `.webp`/`.ogg` byte sizes and the audio duration —
  both under the limits, sticker ≤500 KB. Run it yourself and paste the output into `RESEARCH.md`'s
  end or a `NOTES.md`.
- The sticker previews correctly in a browser (animated, transparent background).
- Send paths are wired but cannot be tested without a paired phone — make that state explicit in the
  UI and in `NOTES.md` ("not verified: actual send, needs a linked device").
- Commit nothing; leave the working tree clean of junk. Do **not** commit `data/`, `.env`, or
  `node_modules`.
