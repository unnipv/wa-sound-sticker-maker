import { mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import pino from 'pino';
import QRCode from 'qrcode';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  prepareWAMessageMedia,
  generateWAMessageFromContent,
  jidNormalizedUser,
  proto,
} from 'baileys';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const silentLogger = pino({ level: 'silent' });

let cachedVersion = null;
async function getBaileysVersion() {
  if (cachedVersion) return cachedVersion;
  try {
    const { version } = await fetchLatestBaileysVersion();
    cachedVersion = version;
    return version;
  } catch {
    return undefined;
  }
}

/**
 * Runtime proto patch for WhatsApp sound stickers (Nov 2026):
 * - StickerMessage fields: 24 (premium=0), 25 (emojis, optional), 26 (AudioMessage)
 * - Message field 134 (audioStickerMessage: FutureProofMessage { 1: Message { 26: StickerMessage } })
 * Set WA_SOUND_WIRE_FORMAT=26 to fall back to bare top-level StickerMessage.audioMessage (legacy).
 */
export function patchStickerProto() {
  const M = proto.Message;
  const SM = M.StickerMessage;
  const AM = M.AudioMessage;
  if (SM.__soundPatched) return;
  SM.__soundPatched = true;

  const origStickerEncode = SM.encode;
  SM.encode = function (m, w) {
    const writer = origStickerEncode.call(this, m, w);
    if (m?.audioMessage) {
      writer.uint32((24 << 3) | 0).int32(m.premium ?? 0);
      if (m.emojis) writer.uint32((25 << 3) | 2).string(m.emojis);
      AM.encode(m.audioMessage, writer.uint32((26 << 3) | 2).fork()).ldelim();
    }
    return writer;
  };

  const origStickerFrom = SM.fromObject;
  SM.fromObject = function (o) {
    const msg = origStickerFrom.call(this, o);
    if (o?.audioMessage) msg.audioMessage = AM.fromObject(o.audioMessage);
    if (o?.emojis != null) msg.emojis = o.emojis;
    if (o?.premium != null) msg.premium = o.premium;
    return msg;
  };

  const origMsgEncode = M.encode;
  M.encode = function (m, w) {
    if (m?.stickerMessage?.audioMessage && process.env.WA_SOUND_WIRE_FORMAT !== '26') {
      const { stickerMessage, ...rest } = m;
      const writer = origMsgEncode.call(this, rest, w);
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

export function normalizePhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) {
    const err = new Error('Enter a valid phone number with country code (digits only, e.g. 919876543210).');
    err.code = 'invalid_phone';
    throw err;
  }
  return digits;
}

/**
 * Persistent WhatsApp socket manager for a single authDir (used by both relay and per-user sessions).
 * When sendOnly=true (relay), registers no incoming-message handlers beyond creds/connection/receipts.
 */
export function createSocketManager({ authDir, label = 'wa', sendOnly = true }) {
  patchStickerProto();

  let sock = null;
  let connecting = false;
  let openedAt = 0;
  let reconnectTimer = null;
  const sentCache = new Map();
  const receipts = new Map();

  let state = {
    connection: 'disconnected', // disconnected | connecting | qr | open
    paired: false,
    me: null,
    qr: null,
    code: null,
    lastError: null,
  };

  function rememberSent(id, message) {
    sentCache.set(id, message);
    if (sentCache.size > 200) {
      const oldest = sentCache.keys().next().value;
      sentCache.delete(oldest);
    }
  }

  function hasCreds() {
    return existsSync(join(authDir, 'creds.json'));
  }

  function getStatus() {
    return {
      ...state,
      hasCreds: hasCreds(),
    };
  }

  function clearReconnect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  async function stopSocket() {
    clearReconnect();
    const cur = sock;
    sock = null;
    if (cur) {
      try {
        cur.ev.removeAllListeners();
        cur.end(undefined);
      } catch {}
    }
  }

  async function connect({ force = false } = {}) {
    if (!force && sock && (state.connection === 'open' || state.connection === 'qr' || connecting)) {
      return getStatus();
    }
    connecting = true;
    await stopSocket();
    state = {
      ...state,
      connection: 'connecting',
      paired: false,
      qr: null,
      lastError: null,
    };

    await mkdir(authDir, { recursive: true });
    const { state: authState, saveCreds } = await useMultiFileAuthState(authDir);
    const version = await getBaileysVersion();

    const s = makeWASocket({
      version,
      auth: authState,
      logger: silentLogger,
      browser: ['Sound Sticker Studio', 'Chrome', '14.0'],
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      getMessage: async (key) => sentCache.get(key.id),
    });
    sock = s;

    s.ev.on('creds.update', saveCreds);

    // Track delivery receipts for sent messages (no replies, no read receipts, no media downloads)
    s.ev.on('messages.update', (updates) => {
      for (const u of updates) {
        if (u?.key?.id && u.update?.status != null && sentCache.has(u.key.id)) {
          receipts.set(u.key.id, u.update.status);
        }
      }
    });

    s.ev.on('connection.update', async (update) => {
      if (sock !== s) return;
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          const qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320, errorCorrectionLevel: 'M' });
          state = { ...state, connection: 'qr', paired: false, qr: qrDataUrl, lastError: null };
        } catch {
          state = { ...state, connection: 'qr', paired: false, qr: null };
        }
      }

      if (connection === 'open') {
        openedAt = Date.now();
        const jid = s.user?.id ? jidNormalizedUser(s.user.id) : null;
        state = {
          connection: 'open',
          paired: true,
          me: jid ? { jid, phone: jid.split('@')[0], name: s.user?.name || null } : null,
          qr: null,
          code: null,
          lastError: null,
        };
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        sock = null;
        connecting = false;

        if (loggedOut) {
          state = {
            connection: 'disconnected',
            paired: false,
            me: null,
            qr: null,
            code: null,
            lastError: 'WhatsApp session was logged out. Please link again.',
          };
          await rm(authDir, { recursive: true, force: true }).catch(() => {});
          return;
        }

        const shouldReconnect =
          statusCode === DisconnectReason.restartRequired ||
          (hasCreds() && statusCode !== DisconnectReason.connectionReplaced);

        state = {
          ...state,
          connection: 'disconnected',
          paired: false,
          qr: null,
          lastError: shouldReconnect
            ? `Reconnecting after disconnect (${statusCode ?? 'network'})...`
            : `Disconnected (${statusCode ?? 'unknown'})`,
        };

        if (shouldReconnect) {
          clearReconnect();
          reconnectTimer = setTimeout(() => {
            connect().catch(() => {});
          }, statusCode === DisconnectReason.restartRequired ? 1000 : 3000);
          reconnectTimer.unref?.();
        }
      }
    });

    connecting = false;
    // Wait briefly for initial QR or open if connecting fresh
    return getStatus();
  }

  async function startPairing({ phone } = {}) {
    if (state.paired && sock) return getStatus();
    await connect({ force: !sock });

    if (phone) {
      const digits = normalizePhone(phone);
      // Wait up to 4s for socket to initialize before requesting pairing code
      const deadline = Date.now() + 4000;
      while (!sock && Date.now() < deadline) await sleep(150);
      await sleep(600);
      if (!sock?.requestPairingCode) {
        const err = new Error('Socket not ready for pairing code. Try again.');
        err.code = 'pairing_unavailable';
        throw err;
      }
      const rawCode = await sock.requestPairingCode(digits);
      const formatted = String(rawCode).replace(/(.{4})/g, '$1-').replace(/-$/, '');
      state = { ...state, code: formatted, qr: null, lastError: null };
      return getStatus();
    }

    // Wait up to 6s for a QR code or immediate open
    const deadline = Date.now() + 6000;
    while (!state.qr && !state.paired && Date.now() < deadline) {
      await sleep(200);
    }
    return getStatus();
  }

  async function logout() {
    clearReconnect();
    const cur = sock;
    sock = null;
    connecting = false;
    if (cur) {
      try { await cur.logout(); } catch {}
      try { cur.end(undefined); } catch {}
    }
    await rm(authDir, { recursive: true, force: true }).catch(() => {});
    state = {
      connection: 'disconnected',
      paired: false,
      me: null,
      qr: null,
      code: null,
      lastError: null,
    };
    return getStatus();
  }

  async function sendSoundSticker({ toPhone = null, webpBuf, audioBuf = null, audioSeconds = 0 }) {
    if (!sock || !state.paired) {
      const err = new Error(label === 'relay' ? 'Server relay WhatsApp is not paired yet.' : 'Link your WhatsApp first.');
      err.code = label === 'relay' ? 'relay_not_paired' : 'self_not_paired';
      throw err;
    }

    let jid;
    if (toPhone) {
      const digits = normalizePhone(toPhone);
      if (typeof sock.onWhatsApp === 'function') {
        const [check] = await sock.onWhatsApp(digits).catch(() => [null]);
        if (check && check.exists === false) {
          const err = new Error(`+${digits} does not appear to be registered on WhatsApp.`);
          err.code = 'not_a_whatsapp_number';
          throw err;
        }
        jid = check?.jid || `${digits}@s.whatsapp.net`;
      } else {
        jid = `${digits}@s.whatsapp.net`;
      }
    } else {
      jid = jidNormalizedUser(sock.user.id);
    }

    // If socket just opened, give WhatsApp a few seconds to finish initial key sync
    const sinceOpen = Date.now() - openedAt;
    if (sinceOpen < 5000) {
      await sleep(5000 - sinceOpen);
    }

    const upload = sock.waUploadToServer;
    const [s, a] = await Promise.all([
      prepareWAMessageMedia({ sticker: webpBuf, isAnimated: true }, { upload }),
      audioBuf
        ? prepareWAMessageMedia(
            { audio: audioBuf, mimetype: 'audio/ogg; codecs=opus', seconds: Math.max(1, Math.round(audioSeconds || 1)), ptt: false },
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
    rememberSent(msg.key.id, msg.message);
    await sock.relayMessage(jid, msg.message, { messageId: msg.key.id });

    // Wait briefly (up to 2s) for initial server ack if available; socket remains open persistently
    const ackDeadline = Date.now() + 2000;
    while (!receipts.has(msg.key.id) && Date.now() < ackDeadline) {
      await sleep(150);
    }

    return {
      ok: true,
      messageId: msg.key.id,
      sentTo: jid.split('@')[0],
      jid,
      status: receipts.get(msg.key.id) ?? 'sent',
      hasAudio: Boolean(audioBuf),
    };
  }

  return {
    connect,
    startPairing,
    logout,
    getStatus,
    hasCreds,
    sendSoundSticker,
    stopSocket,
  };
}
