import { execFile, spawn } from 'node:child_process';
import { accessSync, constants as fsConstants } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const ALLOWED_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
]);

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const MAX_DURATION_SEC = 3 * 3600; // 3 hours
const MAX_SECTION_SPAN_SEC = 11;
const INFO_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const DOWNLOAD_TIMEOUT_MS = 180 * 1000; // 180 seconds
const INFO_TIMEOUT_MS = 45 * 1000;

const infoCache = new Map();
let cachedAvailability = null;

function makeError(message, code) {
  const err = new Error(message);
  err.code = code;
  err.errorCode = code;
  return err;
}

function getLocalBinDir() {
  return join(homedir(), '.local', 'bin');
}

function envWithLocalBin() {
  const localBin = getLocalBinDir();
  const currentPath = process.env.PATH || '';
  const parts = currentPath.split(':').filter(Boolean);
  const pathVal = parts[0] === localBin ? currentPath : [localBin, ...parts.filter((p) => p !== localBin)].join(':');
  return { ...process.env, PATH: pathVal };
}

function isExecutable(filePath) {
  try {
    accessSync(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveYtdlpBin() {
  const envBin = (process.env.YTDLP_BIN || '').trim();
  if (envBin) return envBin;
  const localYtdlp = join(getLocalBinDir(), 'yt-dlp');
  if (isExecutable(localYtdlp)) return localYtdlp;
  return 'yt-dlp';
}

export async function ytdlpAvailable() {
  if (cachedAvailability) return cachedAvailability;
  const bin = resolveYtdlpBin();
  try {
    const { stdout } = await execFileAsync(bin, ['--version'], {
      env: envWithLocalBin(),
      timeout: 10_000,
    });
    const version = String(stdout || '').trim().split('\n')[0] || null;
    cachedAvailability = { available: true, version, bin };
  } catch {
    cachedAvailability = { available: false, version: null, bin };
  }
  return cachedAvailability;
}

/**
 * Strict YouTube URL parser + SSRF guard.
 * Accepts youtube.com/watch?v=, youtu.be/, /shorts/, /live/, m.youtube.com, music.youtube.com.
 */
export function parseYouTubeUrl(rawUrl) {
  const trimmed = String(rawUrl || '').trim();
  if (!trimmed) {
    throw makeError('Paste a YouTube link first.', 'not_a_youtube_url');
  }

  let candidate = trimmed;
  if (!/^https?:\/\//i.test(candidate)) {
    if (/^(www\.|m\.|music\.)?(youtube\.com|youtu\.be)\//i.test(candidate)) {
      candidate = `https://${candidate}`;
    } else {
      throw makeError('That does not look like a YouTube URL.', 'not_a_youtube_url');
    }
  }

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw makeError('That does not look like a valid YouTube URL.', 'not_a_youtube_url');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw makeError('Only http/https YouTube URLs are supported.', 'not_a_youtube_url');
  }

  const host = parsed.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) {
    throw makeError('Only YouTube links (youtube.com or youtu.be) are supported.', 'not_a_youtube_url');
  }

  let id = null;
  const segs = parsed.pathname.split('/').filter(Boolean);

  if (host === 'youtu.be') {
    id = segs[0] || null;
  } else if (parsed.pathname === '/watch') {
    id = parsed.searchParams.get('v');
  } else if (segs.length >= 2 && ['shorts', 'live', 'embed'].includes(segs[0])) {
    id = segs[1];
  }

  if (!id || !VIDEO_ID_RE.test(id)) {
    throw makeError('Could not find a YouTube video ID in that link.', 'not_a_youtube_url');
  }

  return {
    id,
    canonicalUrl: `https://www.youtube.com/watch?v=${id}`,
  };
}

function extractHumanError(stderrLines) {
  const lines = stderrLines
    .map((l) => l.trim())
    .filter(Boolean);
  const errLine = [...lines].reverse().find((l) => /^ERROR:/i.test(l)) || lines[lines.length - 1] || '';
  if (!errLine) return '';
  return errLine
    .replace(/^ERROR:\s*/i, '')
    .replace(/^\[youtube[^\]]*\]\s*[A-Za-z0-9_-]{11}:\s*/i, '')
    .replace(/^\[[^\]]+\]\s*/i, '')
    .trim();
}

function classifyYtdlpError(stderrLines, fallbackCode = 'download_failed') {
  const msg = extractHumanError(stderrLines);
  const lower = msg.toLowerCase();
  if (
    lower.includes('unavailable') ||
    lower.includes('private video') ||
    lower.includes('age-restricted') ||
    lower.includes('sign in to confirm') ||
    lower.includes('members-only') ||
    lower.includes('removed') ||
    lower.includes('copyright') ||
    lower.includes('not available') ||
    lower.includes('premiere')
  ) {
    return makeError(msg || 'This YouTube video is unavailable.', 'video_unavailable');
  }
  if (lower.includes('live event') || lower.includes('is live')) {
    return makeError(msg || 'Live streams are not supported.', 'live_not_supported');
  }
  return makeError(msg || 'Failed to fetch YouTube video.', fallbackCode);
}

export function getCachedInfo(id) {
  const entry = infoCache.get(id);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    infoCache.delete(id);
    return null;
  }
  return entry.data;
}

export async function getInfo(url) {
  const { id, canonicalUrl } = parseYouTubeUrl(url);
  const cached = getCachedInfo(id);
  if (cached) return cached;

  const avail = await ytdlpAvailable();
  if (!avail.available) {
    throw makeError('yt-dlp is not installed on the server.', 'yt_dlp_missing');
  }

  let stdout = '';
  try {
    const res = await execFileAsync(
      avail.bin,
      ['-J', '--force-ipv4', '--no-playlist', '--no-warnings', canonicalUrl],
      {
        env: envWithLocalBin(),
        timeout: INFO_TIMEOUT_MS,
        maxBuffer: 32 << 20,
      },
    );
    stdout = res.stdout;
  } catch (err) {
    if (err.code === 'ENOENT') {
      cachedAvailability = { available: false, version: null, bin: avail.bin };
      throw makeError('yt-dlp is not installed on the server.', 'yt_dlp_missing');
    }
    if (err.killed || err.signal === 'SIGTERM') {
      throw makeError('Timed out fetching video info from YouTube.', 'video_unavailable');
    }
    const lines = String(err.stderr || err.message || '').split('\n');
    throw classifyYtdlpError(lines, 'video_unavailable');
  }

  let raw;
  try {
    raw = JSON.parse(stdout);
  } catch {
    throw makeError('Received invalid metadata from YouTube.', 'video_unavailable');
  }

  const isLive = Boolean(raw.is_live || raw.live_status === 'is_live' || raw.live_status === 'is_upcoming');
  if (isLive) {
    throw makeError('Live streams and upcoming premieres are not supported.', 'live_not_supported');
  }

  const duration = Number(raw.duration) || 0;
  if (duration > MAX_DURATION_SEC) {
    throw makeError('Videos longer than 3 hours are not supported.', 'video_too_long');
  }
  if (duration <= 0) {
    throw makeError('Could not determine video duration.', 'video_unavailable');
  }

  let thumbnail = raw.thumbnail || null;
  if (!thumbnail && Array.isArray(raw.thumbnails) && raw.thumbnails.length > 0) {
    thumbnail = raw.thumbnails[raw.thumbnails.length - 1]?.url || null;
  }

  const info = {
    id: raw.id || id,
    title: String(raw.title || 'Untitled video'),
    duration,
    thumbnail,
    uploader: String(raw.uploader || raw.channel || ''),
    isLive: false,
  };

  infoCache.set(id, { data: info, expiresAt: Date.now() + INFO_CACHE_TTL_MS });
  return info;
}

function fmtSec(n) {
  const fixed = Number(n.toFixed(3));
  return String(fixed);
}

/**
 * Download a trimmed section of a YouTube video into jobDir/source.<ext>.
 */
export async function downloadSection({ url, jobDir, start = 0, span = MAX_SECTION_SPAN_SEC }) {
  const { canonicalUrl } = parseYouTubeUrl(url);
  const avail = await ytdlpAvailable();
  if (!avail.available) {
    throw makeError('yt-dlp is not installed on the server.', 'yt_dlp_missing');
  }

  const startSec = Math.max(0, Number(start) || 0);
  const spanSec = Math.min(MAX_SECTION_SPAN_SEC, Math.max(1, Number(span) || MAX_SECTION_SPAN_SEC));
  const endSec = startSec + spanSec;

  const args = [
    '--force-ipv4',
    '--no-playlist',
    '--no-progress',
    '--newline',
    '--max-filesize', '80M',
    '-f', 'bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[height<=720]/b',
    '--download-sections', `*${fmtSec(startSec)}-${fmtSec(endSec)}`,
    '--force-keyframes-at-cuts',
    '--merge-output-format', 'mp4',
    '-o', join(jobDir, 'source.%(ext)s'),
    canonicalUrl,
  ];

  const RING_MAX = 40;
  const stderrRing = [];
  let stderrPartial = '';
  let timedOut = false;

  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(avail.bin, args, {
      env: envWithLocalBin(),
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
      }, 2000).unref?.();
    }, DOWNLOAD_TIMEOUT_MS);

    child.stderr.on('data', (chunk) => {
      stderrPartial += chunk.toString('utf8');
      const parts = stderrPartial.split(/\r?\n/);
      stderrPartial = parts.pop() || '';
      for (const line of parts) {
        if (!line.trim()) continue;
        stderrRing.push(line);
        if (stderrRing.length > RING_MAX) stderrRing.shift();
      }
    });

    child.on('error', (err) => {
      clearTimeout(killTimer);
      if (err.code === 'ENOENT') {
        cachedAvailability = { available: false, version: null, bin: avail.bin };
        return rejectPromise(makeError('yt-dlp is not installed on the server.', 'yt_dlp_missing'));
      }
      rejectPromise(makeError(`Download failed: ${err.message}`, 'download_failed'));
    });

    child.on('close', (code) => {
      clearTimeout(killTimer);
      if (stderrPartial.trim()) {
        stderrRing.push(stderrPartial.trim());
        if (stderrRing.length > RING_MAX) stderrRing.shift();
      }
      if (timedOut) {
        return rejectPromise(makeError('YouTube download timed out after 3 minutes.', 'download_failed'));
      }
      if (code !== 0) {
        return rejectPromise(classifyYtdlpError(stderrRing, 'download_failed'));
      }
      resolvePromise();
    });
  });

  const files = await readdir(jobDir);
  const produced = files.find((f) => /^source\.[^.]+$/.test(f) && !f.endsWith('.part') && !f.endsWith('.ytdl'));
  if (!produced) {
    throw makeError('YouTube download produced no media file (may exceed 80 MB limit).', 'download_failed');
  }
  return join(jobDir, produced);
}
