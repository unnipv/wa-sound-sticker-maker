# RESEARCH — Delivering WhatsApp Sound Stickers from a Web App

## Verdict Table

| # | Question | Answer | Confidence | Evidence |
|---|---|---|---|---|
| 1 | **Wire format today (Nov 2026)** | Sound stickers use **`Message.audioStickerMessage` (field 134, `FutureProofMessage`)** wrapping `Message { stickerMessage (26): StickerMessage { ..., premium (24)=0, emojis (25, opt), audioMessage (26): AudioMessage } }`, with stanza `<enc mediatype="sticker">`. `baileys@7.0.0-rc14` WAProto stops at field 114 and `StickerMessage` stops at field 23 (no field 26 or 134). `baron-baileys-v2` was unpublished on npm (2026-06-30). Runtime encode-patching both `StickerMessage.encode` (fields 24/25/26) and `Message.encode` (wrap in 134→1→26) matches real Nov-2026 clients. | **High** | [Baileys #2932](https://github.com/WhiskeySockets/Baileys/issues/2932) (wire captures 2026-11-24/25, tested on 2.26.46.76); [7ucg/WA_STICKERS.md](https://raw.githubusercontent.com/7ucg/whatsapp-docs/main/WA_STICKERS.md) §2–3; `baileys@7.0.0-rc14` `WAProto/WAProto.proto` lines 2150–2165, 3481–3505; `npm view baron-baileys-v2` (E404 unpublished). |
| 2 | **Is a linked-device session avoidable?** | **No.** To deliver a sound sticker from a web app into a user's WhatsApp, a linked WhatsApp client session is required. Third-party sticker-pack import (`ENABLE_STICKER_PACK` / `SEND_STICKER` + `ContentProvider`) is strictly image-only (`image/webp`, 512×512, ≤500 KB animated / ≤100 KB static). Sharing a raw `.webp` sends a file/image without audio. The native sound-sticker editor (rolling out in Android beta 2.26.47.1 and iOS TestFlight) creates stickers locally from phone gallery/audio but has no external pack/URL import API. Official WhatsApp Cloud/Business API has no sound-sticker message type. **User-facing truth:** *"To include sound, WhatsApp requires delivery from a linked WhatsApp client — either via this server's relay number or by linking your own WhatsApp (~20s)."* | **High** | [7ucg/WA_STICKERS.md](https://raw.githubusercontent.com/7ucg/whatsapp-docs/main/WA_STICKERS.md) §7.1–7.4; WABetaInfo Android 2.26.47.1 & iOS TestFlight reports; Meta Cloud API docs (sticker payload only supports WebP media ID/URL). |
| 3 | **Pairing UX in a browser** | Both **QR** (`connection.update` `qr` → `qrcode.toDataURL`) and **8-digit pairing code** (`sock.requestPairingCode(digits)` after short socket handshake delay) work headlessly per user. Persist each user's creds in an isolated directory `data/sessions/<sid>/` keyed by an `HttpOnly` cookie `sid` (`useMultiFileAuthState`). WhatsApp allows max **4 linked devices** per account. Mitigate ban/rate-limit risk with `markOnlineOnConnect: false`, `syncFullHistory: false`, no unsolicited bulk sends, no incoming-message auto-replies on the relay socket, and backoff on `429`/`restartRequired`. | **High** | [touchzada/soundsticker](https://github.com/touchzada/soundsticker) `lib/whatsapp.mjs`; `baileys@7.0.0-rc14` `requestPairingCode`; WhatsApp multi-device 4-device cap. |
| 4 | **iOS specifics** | iOS renders sound stickers sent over the same multi-device proto when the client build supports sound stickers (iOS beta / Nov 2026+). Key interoperability rules: always send as **animated WebP** (`isAnimated: true`, `isLottie: false`, 2-frame muxed WebP for still images), set `stickerSentTs: Date.now()`, use exact `mimetype: 'audio/ogg; codecs=opus'` (plain `audio/ogg` silently fails to play), strip video/cover-art streams (`-vn -map 0:a:0`) so OGG contains only Opus, and set integer `seconds` ≥ 1. | **Medium-High** | [Baileys #2932 comment](https://github.com/WhiskeySockets/Baileys/issues/2932#issuecomment-7151541575); `make.mjs` lines 93–115, 214–217; WABetaInfo / 9to5Mac iOS rollout coverage. |
| 5 | **Media constraints & EXIF** | Sticker: 512×512 animated WebP, transparent padding, `-loop 0`, ≤6 s animation, **≤500 KB** (quality/fps ladder). Audio: OGG/Opus mono 48 kHz 64 kbps (`-vn -map 0:a:0 -map_metadata -1`), ≤10 s (clients accept up to ~20 s / ~1 MB, but 10 s is safe and matches `make.mjs`). EXIF JSON with `"sound-sha256": base64(sha256(rawOggBytes))` is still recommended for compatibility with both field-26 and field-134 builds. | **High** | `make.mjs` lines 37–39, 74–145; [Baileys #2932 comments](https://github.com/WhiskeySockets/Baileys/issues/2932#issuecomment-7147889617). |
| 6 | **Practical sending** | Upload sticker and audio in parallel via `prepareWAMessageMedia` (`mimetype: 'audio/ogg; codecs=opus'`, `seconds`, `ptt: false` or unset — real captures show `ptt` unset). Use `generateWAMessageFromContent` + `relayMessage`. Cache sent message in `getMessage` store for retry decryption. On a freshly opened socket, allow brief key-sync settle time; on a persistent server socket (relay/session), keep the socket alive after send and listen on `messages.update` for delivery receipts (`sent`/`delivered`). | **High** | `make.mjs` lines 208–231; [Baileys #2932](https://github.com/WhiskeySockets/Baileys/issues/2932#issuecomment-7147889617); `baileys@7.0.0-rc14` `messages-send.js`. |

---

## Recommended Architecture

```
Browser (mobile-first SPA)
  │  POST /api/jobs (multipart: media, optional audio, start, duration, mute, audioVolume)
  ▼
Express Server (Node 26, ESM, no build step)
  ├── lib/jobs.js       in-memory queue + disk workspace data/jobs/<id>/ (1h TTL cleanup)
  ├── lib/sticker.js    system ffmpeg/ffprobe -> sound.ogg (Opus mono 48k <=10s)
  │                     + sticker.webp (512x512 animated <=500KB + EXIF sound-sha256)
  ├── lib/wa.js         Baileys v7 socket factory + patchStickerProto() (field 134 + field 26)
  │                     + sendSoundSticker() with getMessage cache & receipt tracking
  ├── lib/relay.js      single server-owned linked device in data/relay/ (send-only, no reply handlers)
  └── lib/sessions.js   per-browser-cookie (sid) linked device in data/sessions/<sid>/ (QR or 8-digit code)
```

**Delivery modes:**
1. **Relay (default):** Server holds one spare WhatsApp account in `data/relay/` (paired via `/admin?token=…`). User enters their phone number once (saved in `localStorage`) and receives the sound sticker directly.
2. **Pair-your-own (fallback):** User links their own WhatsApp via QR or 8-digit pairing code; sticker is sent to their own `"Message yourself"` JID (`jidNormalizedUser(sock.user.id)`).

---

## Exact Proto Patch & Send Snippet

Patch both `StickerMessage` (fields 24, 25, 26) and `Message.encode` (wrap sound stickers in field 134 `audioStickerMessage` `FutureProofMessage` → field 1 `message` → field 26 `stickerMessage`). Keeping `stickerMessage` on the JS object ensures Baileys' `messages-send.js` still emits `<enc mediatype="sticker">`.

```js
import { proto, prepareWAMessageMedia, generateWAMessageFromContent } from 'baileys';

export function patchStickerProto() {
  const M = proto.Message;
  const SM = M.StickerMessage;
  const AM = M.AudioMessage;
  if (SM.__soundPatched) return;
  SM.__soundPatched = true;

  const origStickerEncode = SM.encode;
  SM.encode = function (m, w) {
    const writer = origStickerEncode.call(this, m, w);
    if (m.audioMessage) {
      writer.uint32((24 << 3) | 0).int32(m.premium ?? 0);
      if (m.emojis) writer.uint32((25 << 3) | 2).string(m.emojis);
      AM.encode(m.audioMessage, writer.uint32((26 << 3) | 2).fork()).ldelim();
    }
    return writer;
  };

  const origStickerFrom = SM.fromObject;
  SM.fromObject = function (o) {
    const msg = origStickerFrom.call(this, o);
    if (o.audioMessage) msg.audioMessage = AM.fromObject(o.audioMessage);
    if (o.emojis != null) msg.emojis = o.emojis;
    if (o.premium != null) msg.premium = o.premium;
    return msg;
  };

  const origMsgEncode = M.encode;
  M.encode = function (m, w) {
    if (m?.stickerMessage?.audioMessage && process.env.WA_SOUND_WIRE_FORMAT !== '26') {
      const { stickerMessage, ...rest } = m;
      const writer = origMsgEncode.call(this, rest, w);
      // Field 134 (audioStickerMessage: FutureProofMessage) -> field 1 (message) -> field 26 (stickerMessage)
      const fp = writer.uint32((134 << 3) | 2).fork();
      const inner = fp.uint32((1 << 3) | 2).fork();
      SM.encode(stickerMessage, inner.uint32((26 << 3) | 2).fork()).ldelim();
      inner.ldelim();
      fp.ldelim();
      return writer;
    }
    return origMsgEncode.call(this, m, w);
  };
}
```

**Send flow:**
```js
const upload = sock.waUploadToServer;
const [s, a] = await Promise.all([
  prepareWAMessageMedia({ sticker: webpBuf, isAnimated: true }, { upload }),
  audioBuf
    ? prepareWAMessageMedia(
        { audio: audioBuf, mimetype: 'audio/ogg; codecs=opus', seconds: audioSeconds, ptt: false },
        { upload },
      )
    : Promise.resolve(null),
]);
const stickerMessage = {
  ...s.stickerMessage,
  isAnimated: true,
  isLottie: false,
  stickerSentTs: Date.now(),
  ...(a?.audioMessage ? { audioMessage: a.audioMessage, premium: 0, emojis: '🔊' } : {}),
};
const msg = generateWAMessageFromContent(jid, { stickerMessage }, { userJid: sock.user.id });
sentCache.set(msg.key.id, msg.message);
await sock.relayMessage(jid, msg.message, { messageId: msg.key.id });
```

---

## Risks

- **Account ban / ToS:** Baileys is an unofficial WhatsApp Web client. Use a spare number for the relay, keep volume low, set `markOnlineOnConnect: false` / `syncFullHistory: false`, never attach auto-reply/read-receipt handlers to the relay, and never share one auth folder between two machines.
- **Version gates (Android & iOS):** Recipients on older WhatsApp builds without sound-sticker support will either see a silent sticker (field 26) or an unsupported/empty message placeholder (field 134 `FutureProofMessage` fallback). Keep WhatsApp updated (Android ≥2.26.46 / Nov-2026 iOS).
- **4-device limit:** Each linked session consumes 1 of the user's 4 companion-device slots; provide a clear unlink/logout flow and never loop `requestPairingCode` rapidly (risks `429 rate-overlimit`).

---

## Reference Repos Worth Copying From

- `vinay0x/wa-sound-sticker-maker` (`make.mjs`, this repo): proven ffmpeg quality/fps ladder, 2-frame static-to-animated WebP mux trick, EXIF `sound-sha256` writer, parallel `prepareWAMessageMedia`.
- `touchzada/soundsticker` (`lib/whatsapp.mjs`, `lib/convert.mjs`, `server.mjs`): clean Express + multer local server, QR data URL + 8-digit pairing code state machine, `plogme` Baileys fork reference.
- `7ucg/whatsapp-docs` (`WA_STICKERS.md`): authoritative Android 2.26.41.6 proto field numbers and third-party pack constraints.
- `@boruto_vk7/stickengine` (`dist/esm/util.js`): fallback RIFF EXIF injection patterns (not needed when `node-webpmux` is available).
