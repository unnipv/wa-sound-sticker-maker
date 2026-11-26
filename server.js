import 'dotenv/config';
import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import { MAX_ANIM_SEC, MAX_AUDIO_SEC, MAX_STICKER_BYTES, getFfmpegBin } from './lib/sticker.js';
import { createJobStore } from './lib/jobs.js';
import { createRelayManager } from './lib/relay.js';
import { createSessionStore, parseCookies } from './lib/sessions.js';
import { getInfo, parseYouTubeUrl, ytdlpAvailable } from './lib/youtube.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const APP_PASSCODE = (process.env.APP_PASSCODE || '').trim();
const RELAY_ENABLED = !['0', 'false', 'no', 'off'].includes(String(process.env.RELAY_ENABLED ?? 'true').toLowerCase());
const ADMIN_TOKEN = (process.env.ADMIN_TOKEN || '').trim();
const MAX_UPLOAD_MB = Math.max(5, Number(process.env.MAX_UPLOAD_MB || 100));
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');

const DATA_DIR = resolve(__dirname, 'data');
const JOBS_DIR = join(DATA_DIR, 'jobs');
const UPLOADS_DIR = join(DATA_DIR, 'uploads');
const SESSIONS_DIR = join(DATA_DIR, 'sessions');
const RELAY_DIR = join(DATA_DIR, 'relay');
const PUBLIC_DIR = resolve(__dirname, 'public');

await mkdir(UPLOADS_DIR, { recursive: true });
await mkdir(SESSIONS_DIR, { recursive: true });

const jobs = createJobStore(JOBS_DIR);
await jobs.init();

const relay = createRelayManager({ authDir: RELAY_DIR, enabled: RELAY_ENABLED });
await relay.init();

const sessions = createSessionStore(SESSIONS_DIR);

function hashSecret(val) {
  return createHash('sha256').update(`wa-sticker:${val}`).digest('hex');
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ba.length !== bb.length || ba.length === 0) return false;
  return timingSafeEqual(ba, bb);
}

function isPasscodeAuthenticated(req) {
  if (!APP_PASSCODE) return true;
  const cookies = parseCookies(req.headers.cookie);
  return safeEqual(cookies.passcode_tok, hashSecret(APP_PASSCODE));
}

function requirePasscode(req, res, next) {
  if (isPasscodeAuthenticated(req)) return next();
  res.status(401).json({ ok: false, error: 'Passcode required', errorCode: 'passcode_required' });
}

function isAdminAuthorized(req) {
  if (!ADMIN_TOKEN) return false;
  const tok = req.query.token || req.headers['x-admin-token'] || '';
  return safeEqual(tok, ADMIN_TOKEN);
}

function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) {
    return res.status(503).json({ ok: false, error: 'ADMIN_TOKEN is not configured on the server.' });
  }
  if (!isAdminAuthorized(req)) {
    return res.status(403).json({ ok: false, error: 'Invalid admin token.' });
  }
  next();
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
    filename: (_req, file, cb) => {
      const ext = extname(file.originalname || '').replace(/[^a-zA-Z0-9.]/g, '').slice(0, 10);
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 10)}${ext}`);
    },
  }),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
});

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(express.static(PUBLIC_DIR));

// Auth / Passcode endpoints
app.post('/api/auth', (req, res) => {
  if (!APP_PASSCODE) return res.json({ ok: true, authenticated: true });
  const supplied = String(req.body?.passcode || '').trim();
  if (!safeEqual(supplied, APP_PASSCODE)) {
    return res.status(401).json({ ok: false, error: 'Wrong passcode.' });
  }
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.append('Set-Cookie', `passcode_tok=${hashSecret(APP_PASSCODE)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}${secure}`);
  res.json({ ok: true, authenticated: true });
});

// Status endpoint (always accessible so frontend knows whether passcode screen is needed)
app.get('/api/status', async (req, res) => {
  const authenticated = isPasscodeAuthenticated(req);
  const sid = sessions.ensureSid(req, res);
  const selfSt = authenticated ? sessions.getStatus(sid) : { paired: false, connection: 'disconnected', me: null };
  const yt = await ytdlpAvailable();
  res.json({
    ok: true,
    passcodeRequired: Boolean(APP_PASSCODE),
    authenticated,
    publicBaseUrl: PUBLIC_BASE_URL || null,
    relay: relay.getPublicStatus(),
    self: {
      paired: selfSt.paired,
      connection: selfSt.connection,
      me: selfSt.me ? { phone: selfSt.me.phone, name: selfSt.me.name } : null,
    },
    youtube: {
      available: yt.available,
      version: yt.version,
    },
    limits: {
      maxUploadMb: MAX_UPLOAD_MB,
      maxAnimSec: MAX_ANIM_SEC,
      maxAudioSec: MAX_AUDIO_SEC,
      maxStickerBytes: MAX_STICKER_BYTES,
    },
  });
});

// YouTube metadata lookup
app.post('/api/yt/info', requirePasscode, async (req, res) => {
  try {
    const info = await getInfo(req.body?.url);
    res.json({
      ok: true,
      id: info.id,
      title: info.title,
      duration: info.duration,
      thumbnail: info.thumbnail,
      uploader: info.uploader,
      width: info.width ?? null,
      height: info.height ?? null,
    });
  } catch (err) {
    const code = err.code || 'video_unavailable';
    const status = code === 'yt_dlp_missing'
      ? 503
      : ['not_a_youtube_url', 'video_too_long', 'live_not_supported'].includes(code)
        ? 400
        : 422;
    res.status(status).json({ ok: false, error: err.message, errorCode: code });
  }
});

// Jobs API
app.post(
  '/api/jobs',
  requirePasscode,
  upload.fields([
    { name: 'media', maxCount: 1 },
    { name: 'audio', maxCount: 1 },
  ]),
  async (req, res) => {
    const source = String(req.body?.source || 'upload').toLowerCase();
    const audio = req.files?.audio?.[0];
    const start = Math.max(0, Number(req.body?.start) || 0);
    const duration = Math.min(MAX_ANIM_SEC, Math.max(1, Number(req.body?.duration) || MAX_ANIM_SEC));
    const mute = ['1', 'true', 'yes', 'on'].includes(String(req.body?.mute || '').toLowerCase());
    const audioVolume = Math.min(3, Math.max(0.05, Number(req.body?.audioVolume) || 1));
    const fitRaw = String(req.body?.fit ?? '').trim().toLowerCase();
    if (fitRaw && fitRaw !== 'fit' && fitRaw !== 'fill') {
      for (const f of [audio, req.files?.media?.[0]]) {
        if (f?.path) rm(f.path, { force: true }).catch(() => {});
      }
      return res.status(400).json({ ok: false, error: 'Framing must be "fit" or "fill".', errorCode: 'invalid_fit' });
    }
    const fit = fitRaw === 'fill' ? 'fill' : 'fit';

    if (source === 'youtube') {
      const cleanupAudio = () => {
        if (audio?.path) rm(audio.path, { force: true }).catch(() => {});
      };
      let parsed;
      try {
        parsed = parseYouTubeUrl(req.body?.youtubeUrl);
      } catch (err) {
        cleanupAudio();
        return res.status(400).json({ ok: false, error: err.message, errorCode: err.code || 'not_a_youtube_url' });
      }
      const yt = await ytdlpAvailable();
      if (!yt.available) {
        cleanupAudio();
        return res.status(503).json({ ok: false, error: 'yt-dlp is not installed on the server.', errorCode: 'yt_dlp_missing' });
      }

      const videoTitle = req.body?.videoTitle ? String(req.body.videoTitle).trim().slice(0, 200) : null;
      const job = await jobs.enqueue({
        source: 'youtube',
        youtubeUrl: parsed.canonicalUrl,
        youtubeId: parsed.id,
        videoTitle,
        audioPath: audio?.path || null,
        start,
        duration,
        mute,
        audioVolume,
        fit,
      });
      return res.status(202).json({ ok: true, id: job.id, status: job.status });
    }

    const media = req.files?.media?.[0];
    if (!media) {
      if (audio?.path) rm(audio.path, { force: true }).catch(() => {});
      return res.status(400).json({ ok: false, error: 'Please upload a video, GIF, or image.', errorCode: 'missing_media' });
    }

    const job = await jobs.enqueue({
      source: 'upload',
      mediaPath: media.path,
      mediaName: media.originalname,
      audioPath: audio?.path || null,
      start,
      duration,
      mute,
      audioVolume,
      fit,
    });
    res.status(202).json({ ok: true, id: job.id, status: job.status });
  },
);

app.get('/api/jobs/:id', requirePasscode, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: 'Job not found or expired.', errorCode: 'job_not_found' });
  res.json({ ok: true, ...jobs.serialize(job) });
});

app.get('/api/jobs/:id/sticker.webp', requirePasscode, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== 'done' || !job.result?.stickerPath || !existsSync(job.result.stickerPath)) {
    return res.status(404).json({ ok: false, error: 'Sticker not ready.' });
  }
  res.setHeader('Content-Type', 'image/webp');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  if (req.query.download === '1') {
    res.setHeader('Content-Disposition', 'attachment; filename="sound-sticker.webp"');
  }
  res.sendFile(job.result.stickerPath);
});

app.get('/api/jobs/:id/audio.ogg', requirePasscode, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== 'done' || !job.result?.audioPath || !existsSync(job.result.audioPath)) {
    return res.status(404).json({ ok: false, error: 'Audio not available.' });
  }
  res.setHeader('Content-Type', 'audio/ogg; codecs=opus');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  if (req.query.download === '1') {
    res.setHeader('Content-Disposition', 'attachment; filename="sound-sticker.ogg"');
  }
  res.sendFile(job.result.audioPath);
});

app.post('/api/jobs/:id/send', requirePasscode, async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== 'done' || !job.result) {
    return res.status(404).json({ ok: false, error: 'Build the sticker first before sending.', errorCode: 'job_not_ready' });
  }
  const mode = req.body?.mode === 'self' ? 'self' : 'relay';
  const phone = req.body?.phone ? String(req.body.phone).trim() : '';

  try {
    const webpBuf = await readFile(job.result.stickerPath);
    const audioBuf = job.result.audioPath ? await readFile(job.result.audioPath) : null;

    if (mode === 'relay') {
      const result = await relay.send({
        phone,
        webpBuf,
        audioBuf,
        audioSeconds: job.result.audioSeconds,
      });
      return res.json(result);
    }

    const sid = sessions.ensureSid(req, res);
    const result = await sessions.sendToSelf(sid, {
      webpBuf,
      audioBuf,
      audioSeconds: job.result.audioSeconds,
    });
    return res.json(result);
  } catch (err) {
    const status = ['relay_not_paired', 'self_not_paired', 'relay_disabled'].includes(err.code)
      ? 503
      : ['invalid_phone', 'phone_required', 'not_a_whatsapp_number'].includes(err.code)
        ? 400
        : 500;
    res.status(status).json({ ok: false, error: err.message, errorCode: err.code || 'send_failed' });
  }
});

// Self-pairing API
app.post('/api/pair/start', requirePasscode, async (req, res) => {
  try {
    const sid = sessions.ensureSid(req, res);
    const phone = req.body?.phone ? String(req.body.phone).trim() : undefined;
    const st = await sessions.startPairing(sid, { phone });
    res.json({ ok: true, ...st });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message, errorCode: err.code || 'pair_failed' });
  }
});

app.get('/api/pair/status', requirePasscode, (req, res) => {
  const sid = sessions.ensureSid(req, res);
  res.json({ ok: true, ...sessions.getStatus(sid) });
});

app.post('/api/pair/logout', requirePasscode, async (req, res) => {
  const sid = sessions.ensureSid(req, res);
  const st = await sessions.logout(sid);
  res.json({ ok: true, ...st });
});

// Admin relay pairing page & API
app.get('/admin', (req, res) => {
  if (!ADMIN_TOKEN) {
    return res.status(503).send('<h1>ADMIN_TOKEN is not set in .env</h1>');
  }
  if (!isAdminAuthorized(req)) {
    return res.status(403).send('<h1>403 Forbidden — pass ?token=...</h1>');
  }
  res.sendFile(join(PUBLIC_DIR, 'admin.html'));
});

app.get('/api/relay/pair/status', requireAdmin, (_req, res) => {
  res.json({ ok: true, ...relay.getStatus() });
});

app.post('/api/relay/pair/start', requireAdmin, async (req, res) => {
  try {
    const phone = req.body?.phone ? String(req.body.phone).trim() : undefined;
    const st = await relay.startPairing({ phone });
    res.json({ ok: true, ...st });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message, errorCode: err.code || 'relay_pair_failed' });
  }
});

app.post('/api/relay/logout', requireAdmin, async (_req, res) => {
  const st = await relay.logout();
  res.json({ ok: true, ...st });
});

// Multer & generic error handler
app.use((err, _req, res, _next) => {
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ ok: false, error: `File exceeds the ${MAX_UPLOAD_MB} MB upload limit.`, errorCode: 'file_too_large' });
  }
  res.status(500).json({ ok: false, error: err?.message || 'Unexpected server error.' });
});

const ffmpegBin = await getFfmpegBin().catch((e) => `MISSING (${e.message})`);
const ytInfo = await ytdlpAvailable();
app.listen(PORT, () => {
  console.log(`Sound Sticker Studio running on http://localhost:${PORT}`);
  console.log(`  ffmpeg: ${ffmpegBin} | yt-dlp: ${ytInfo.available ? `${ytInfo.bin} (${ytInfo.version})` : 'missing'} | relay: ${RELAY_ENABLED ? 'enabled' : 'disabled'} | passcode: ${APP_PASSCODE ? 'on' : 'off'}`);
});
