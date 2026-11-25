#!/usr/bin/env node
// Make a WhatsApp sound sticker (sticker + embedded audio) and send it to yourself.
// Usage:
//   node make.mjs <image|gif|video> [--audio <file>] [--start <sec>] [--to <phone digits>] [--dry]
// First run prints a QR: WhatsApp > Settings > Linked devices > Link a device.
// Then open "Message yourself", long-press the sticker > Add to favourites, and reuse it anywhere.

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';
import webpmux from 'node-webpmux';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  prepareWAMessageMedia,
  generateWAMessageFromContent,
  jidNormalizedUser,
  proto,
} from 'baileys';

const run = promisify(execFile);
for (const k of ['info', 'warn', 'log']) {
  const orig = console[k].bind(console);
  console[k] = (...a) => (typeof a[0] === 'string' && /session|prekey bundle/i.test(a[0]) ? undefined : orig(...a));
}
const sent = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_AUDIO = 10;
const MAX_ANIM = 6;
const MAX_BYTES = 500 * 1024;
const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.gif']);

function parseArgs(argv) {
  const out = { media: null, audio: null, start: 0, to: null, dry: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--audio') out.audio = argv[++i];
    else if (a === '--start') out.start = Number(argv[++i]) || 0;
    else if (a === '--to') out.to = argv[++i].replace(/\D/g, '');
    else if (a === '--dry') out.dry = true;
    else if (!out.media) out.media = a;
  }
  if (!out.media) {
    console.log('Usage: node make.mjs <image|gif|video> [--audio <file>] [--start <sec>] [--to <phone>] [--dry]');
    process.exit(1);
  }
  return out;
}

async function ffmpeg(args) {
  try {
    return await run(ffmpegPath, ['-hide_banner', '-y', ...args], { maxBuffer: 64 << 20 });
  } catch (e) {
    e.message = `ffmpeg failed: ${e.stderr?.split('\n').slice(-4).join(' ') ?? e.message}`;
    throw e;
  }
}

async function durationOf(file) {
  const r = await run(ffmpegPath, ['-hide_banner', '-i', file]).catch((e) => e);
  const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(r.stderr ?? '');
  return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : 0;
}

async function makeAudio(src, start, dir) {
  const out = join(dir, 'sound.ogg');
  try {
    await ffmpeg([
      '-ss', String(start), '-i', src, '-map', '0:a:0', '-t', String(MAX_AUDIO), '-vn',
      '-map_metadata', '-1', '-avoid_negative_ts', 'make_zero',
      '-c:a', 'libopus', '-b:a', '64k', '-ac', '1', '-ar', '48000', '-f', 'ogg', out,
    ]);
  } catch (e) {
    if (/matches no streams|does not contain any stream/.test(e.message)) {
      throw new Error('No audio track found. Pass one with --audio <file>.');
    }
    throw e;
  }
  const data = await readFile(out);
  const seconds = Math.max(1, Math.round(await durationOf(out)));
  return { data, seconds, sha256: createHash('sha256').update(data).digest('base64') };
}

// Always an animated WebP: that is the shape confirmed working on real devices.
async function makeWebp(src, start, isVideo, dir) {
  const out = join(dir, 'sticker.webp');
  const scale =
    'scale=512:512:force_original_aspect_ratio=decrease,format=rgba,' +
    'pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000';
  if (!isVideo) {
    // libwebp_anim collapses identical frames, so mux a 2-frame loop of the still by hand.
    for (const q of [90, 75, 60]) {
      await ffmpeg(['-i', src, '-vf', scale, '-frames:v', '1', '-c:v', 'libwebp', '-q:v', String(q), out]);
      const still = new webpmux.Image();
      await still.load(out);
      const frames = [
        await webpmux.Image.generateFrame({ img: still, delay: 1000 }),
        await webpmux.Image.generateFrame({ img: still, delay: 1000 }),
      ];
      const buf = await webpmux.Image.save(null, {
        width: 512, height: 512, frames, loops: 0, bgColor: [0, 0, 0, 0], blend: false, dispose: true,
      });
      if (buf.length <= MAX_BYTES) return buf;
    }
    throw new Error('Could not get the sticker under 500 KB.');
  }
  const ladder = [[15, 70], [12, 55], [10, 45], [8, 35], [6, 25]];
  for (const [fps, q] of ladder) {
    await ffmpeg([
      '-ss', String(start), '-t', String(MAX_ANIM), '-i', src, '-vf', `fps=${fps},${scale}`, '-an',
      '-c:v', 'libwebp_anim', '-lossless', '0', '-q:v', String(q), '-compression_level', '6', '-loop', '0', out,
    ]);
    const buf = await readFile(out);
    if (buf.length <= MAX_BYTES) return buf;
  }
  throw new Error('Could not get the sticker under 500 KB. Try a shorter clip (--start) or smaller source.');
}

async function withExif(webp, soundSha256) {
  const json = Buffer.from(JSON.stringify({
    'sticker-pack-id': 'wa-sound-sticker-maker',
    'sticker-pack-name': 'Sound stickers',
    'sticker-pack-publisher': 'wa-sound-sticker-maker',
    emojis: ['🔊'],
    'sound-sha256': soundSha256,
  }));
  const head = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57,
    0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00]);
  const exif = Buffer.concat([head, json]);
  exif.writeUIntLE(json.length, 14, 4);
  const img = new webpmux.Image();
  await img.load(webp);
  img.exif = exif;
  return img.save(null);
}

// Baileys' bundled proto has no field 26 (AudioMessage) on StickerMessage yet; add it at runtime.
export function patchStickerProto() {
  const SM = proto.Message.StickerMessage;
  const AM = proto.Message.AudioMessage;
  if (SM.__soundPatched) return;
  SM.__soundPatched = true;
  const enc = SM.encode;
  SM.encode = function (m, w) {
    const writer = enc.call(this, m, w);
    if (m.audioMessage) AM.encode(m.audioMessage, writer.uint32((26 << 3) | 2).fork()).ldelim();
    return writer;
  };
  const from = SM.fromObject;
  SM.fromObject = function (o) {
    const msg = from.call(this, o);
    if (o.audioMessage) msg.audioMessage = AM.fromObject(o.audioMessage);
    return msg;
  };
}

async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState(new URL('./auth', import.meta.url).pathname);
  const { version } = await fetchLatestBaileysVersion();
  return new Promise((resolve, reject) => {
    const start = () => {
      const sock = makeWASocket({
        version, auth: state, logger: process.env.WA_DEBUG ? pino({ level: 'debug' }, pino.destination('./debug.log')) : pino({ level: 'silent' }),
        browser: ['Mac OS', 'Chrome', '14.0'], markOnlineOnConnect: false, syncFullHistory: false,
        getMessage: async (key) => sent.get(key.id),
      });
      sock.ev.on('creds.update', saveCreds);
      sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
        if (qr) {
          console.log('\nScan in WhatsApp > Settings > Linked devices > Link a device:\n');
          qrcode.generate(qr, { small: true });
        }
        if (connection === 'open') resolve(sock);
        if (connection === 'close') {
          const code = lastDisconnect?.error?.output?.statusCode;
          if (code === DisconnectReason.loggedOut) reject(new Error('Logged out. Delete ./auth and re-link.'));
          else start();
        }
      });
    };
    start();
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const isVideo = VIDEO_EXT.has(extname(opts.media).toLowerCase());
  const dir = await mkdtemp(join(tmpdir(), 'wass-'));
  try {
    const audio = await makeAudio(opts.audio ?? opts.media, opts.audio ? 0 : opts.start, dir);
    const webp = await withExif(await makeWebp(opts.media, opts.start, isVideo, dir), audio.sha256);
    await writeFile(new URL('./last-sticker.webp', import.meta.url), webp);
    await writeFile(new URL('./last-sound.ogg', import.meta.url), audio.data);
    console.log(`Built sticker ${(webp.length / 1024).toFixed(0)} KB + audio ${audio.seconds}s`);
    if (opts.dry) return;

    patchStickerProto();
    const sock = await connect();
    const jid = opts.to ? `${opts.to}@s.whatsapp.net` : jidNormalizedUser(sock.user.id);
    const upload = sock.waUploadToServer;
    const [s, a] = await Promise.all([
      prepareWAMessageMedia({ sticker: webp, isAnimated: true }, { upload }),
      prepareWAMessageMedia({ audio: audio.data, mimetype: 'audio/ogg; codecs=opus', seconds: audio.seconds }, { upload }),
    ]);
    const stickerMessage = { ...s.stickerMessage, isAnimated: true, isLottie: false, stickerSentTs: Date.now(), audioMessage: a.audioMessage };
    const msg = generateWAMessageFromContent(jid, { stickerMessage }, { userJid: sock.user.id });
    sent.set(msg.key.id, msg.message);
    console.log('Linked. Letting WhatsApp finish syncing keys (10s)...');
    await sleep(10000);
    await sock.relayMessage(jid, msg.message, { messageId: msg.key.id });
    console.log(`Sent sound sticker (id ${msg.key.id}).`);
    console.log('Staying online 60s so your phone can fetch it. Keep WhatsApp open on your phone.');
    sock.ev.on('messages.update', (ups) => {
      for (const u of ups) if (u.key.id === msg.key.id && u.update.status) console.log(`  status: ${['error', 'pending', 'sent', 'delivered', 'read', 'played'][u.update.status] ?? u.update.status}`);
    });
    await sleep(60000);
    sock.end(undefined);
    console.log('Done.');
    process.exit(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(process.env.WA_DEBUG ? e.stack ?? e : e.message, e?.data ?? ''); process.exit(1); });
