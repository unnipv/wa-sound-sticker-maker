# RESEARCH brief — deliver WhatsApp sound stickers from a web app to a phone

You are the research worker. Read this file, do the research, write `RESEARCH.md` at the
repo root. **Do not implement code in this pass. Research + findings + recommendation only.**
No tests, no reviews. Web research + reading installed packages is encouraged; clone/read
reference repos into `/tmp/research/` (never into this repo).

## Context

This repo is a fork of `vinay0x/wa-sound-sticker-maker` (read `make.mjs` and `README.md`):
a Node CLI that builds a WhatsApp **sound sticker** — a 512×512 animated WebP (≤500 KB) whose
EXIF carries `sound-sha256`, plus a mono 48 kHz OGG/Opus clip (≤10 s) — then sends it through
Baileys as a `StickerMessage` with an embedded `AudioMessage` patched onto **field 26**
(`SM.encode` override). The user links their own phone by QR; the sticker lands in
"Message yourself"; they long-press → favourites.

## Goal of the project (why we are researching)

Ship a **web app** (hosted on a Linux box, exposed via a Cloudflare quick tunnel) where anyone
can upload a video/GIF/image (+ optional separate audio or none), tune the sticker, and get the
finished sound sticker **into WhatsApp on their own phone** — usable afterwards from the sticker
tray. It must work for **both Android and iOS** users. No per-user CLI, no per-user `auth/`
folder in a terminal.

## Questions to answer with evidence (cite URLs, repo files, or package code)

1. **Wire format, current as of today.** Which field carries the audio on a sticker today —
   `StickerMessage.audioMessage` (field 26) or the newer top-level `Message.audioStickerMessage`
   (field 134 `FutureProofMessage` wrapper)? Read:
   - `https://github.com/WhiskeySockets/Baileys/issues/2932` (reported 2026-11-24: sound stickers
     arrive as an empty message; field 134 dropped by WAProto)
   - `https://raw.githubusercontent.com/7ucg/whatsapp-docs/main/WA_STICKERS.md`
     (sections 1–3, 7; RE report of WhatsApp 2.26.41.6)
   - Reference implementations to diff against: `touchzada/soundsticker` (local web UI + Baileys),
     `@boruto_vk7/stickengine`, `baron-baileys-v2` proto, and any newer fork of the original.
   - Does the current Baileys version on npm (`baileys` 7.x rc) already ship field 26 and/or 134?
     Check the actual installed/`npm view` proto, not blog posts.
   Verdict needed: **exactly what bytes we must send so a Nov-2026 WhatsApp Android AND iOS client
   plays the audio**, and whether the original repo's approach still works.
2. **Is a linked-device session avoidable?** Verify whether any non-session path can deliver a
   *sound* sticker to a phone:
   - third-party sticker-pack import (`com.whatsapp.intent.action.ENABLE_STICKER_PACK` +
     content provider — image-only, 512×512 WebP ≤500 KB; confirm audio is impossible),
   - sharing a `.webp` into WhatsApp (does it become a sticker? does any audio survive?),
   - the new native sound-sticker editor (Android 2.26.47.1) — can it import an external audio
     file or a prebuilt sticker, and does iOS have it yet?
   - Cloud/Business API sticker support.
   Verdict needed: a one-line truth statement we can show users ("to get audio, WhatsApp needs a
   linked device — here's the 20-second pairing").
3. **Pairing UX in a browser.** Baileys pairing-code flow vs QR: which works headlessly on a
   server for many independent users, how to persist each user's creds safely (cookie-scoped
   session id, file per session), reconnect handling, how many linked devices a user can have,
   failure/ban risk mitigation (markOnlineOnConnect false, no history sync, low send volume).
4. **iOS specifics.** Does an iOS client render a Baileys-sent sound sticker identically? Anything
   about `isAnimated`, `isLottie`, `stickerSentTs`, mimetype, or `seconds` that iOS is pickier about?
   Any known reports of iOS dropping the audio?
5. **Media constraints to encode in the app**: sticker 512×512 animated WebP ≤500 KB, audio Opus
   mono 48 kHz ≤10 s (voice-note style), animation ≤6 s, loop. Any newer limit (e.g. longer audio,
   different container) in the 2026 builds? Is `sound-sha256` in EXIF still required, and is the
   hash base64 of the raw OGG bytes (per `make.mjs`)?
6. **Practical sending**: seconds field, `ptt`, `mimetype: 'audio/ogg; codecs=opus'`, waiting for
   key sync before `relayMessage`, how long the socket must stay up for the phone to fetch media,
   and what a server-side "send and confirm" loop looks like (receipt via `messages.update`).

## Deliverable: `RESEARCH.md`

- **Verdict table**: one row per question, `answer | confidence | evidence link`.
- **Recommended architecture** for the web app: upload → process (ffmpeg) → send path, with the
  session model spelled out (per-user pairing vs anything better you found).
- **Exact proto patch / send snippet** that the implementation pass should use, written so it can
  be pasted straight in (field 26 vs 134, encode override or `baron-baileys-v2`).
- **Risks**: ban surface, iOS/Android version gates, what happens for a friend whose WhatsApp is
  too old to render sound stickers.
- **Reference repos worth copying from**, with file paths.

Keep it under ~200 lines. Plain markdown, no fluff.
