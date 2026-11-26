import { createHash } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';
import webpmux from 'node-webpmux';

const execFileAsync = promisify(execFile);

export const MAX_AUDIO_SEC = 10;
export const MAX_ANIM_SEC = 6;
export const MAX_STICKER_BYTES = 500 * 1024;

const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi', '.3gp', '.gif']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.bmp', '.webp', '.tif', '.tiff', '.heic', '.heif']);

let resolvedFfmpeg = null;
let resolvedFfprobe = null;

function commandExists(cmd) {
  try {
    execFileSync(cmd, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export async function getFfmpegBin() {
  if (resolvedFfmpeg) return resolvedFfmpeg;
  if (commandExists('ffmpeg')) {
    resolvedFfmpeg = 'ffmpeg';
    return resolvedFfmpeg;
  }
  const mod = await import('ffmpeg-static');
  if (mod.default) {
    resolvedFfmpeg = mod.default;
    return resolvedFfmpeg;
  }
  throw new Error('ffmpeg not found on PATH and ffmpeg-static unavailable');
}

export function getFfprobeBin() {
  if (resolvedFfprobe !== null) return resolvedFfprobe;
  resolvedFfprobe = commandExists('ffprobe') ? 'ffprobe' : '';
  return resolvedFfprobe;
}

async function runFfmpeg(args) {
  const bin = await getFfmpegBin();
  try {
    return await execFileAsync(bin, ['-hide_banner', '-y', ...args], { maxBuffer: 64 << 20 });
  } catch (e) {
    const tail = e.stderr ? e.stderr.trim().split('\n').slice(-5).join(' ') : e.message;
    const err = new Error(`ffmpeg failed: ${tail}`);
    err.stderr = e.stderr;
    throw err;
  }
}

export async function probeMedia(file) {
  const ffprobe = getFfprobeBin();
  if (ffprobe) {
    try {
      const { stdout } = await execFileAsync(
        ffprobe,
        ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', file],
        { maxBuffer: 16 << 20 },
      );
      const data = JSON.parse(stdout);
      const streams = data.streams || [];
      const v = streams.find((s) => s.codec_type === 'video');
      const a = streams.find((s) => s.codec_type === 'audio');
      const duration = Number(data.format?.duration) || Number(v?.duration) || Number(a?.duration) || 0;
      const nbFrames = Number(v?.nb_frames) || 0;
      return {
        duration: Number.isFinite(duration) ? duration : 0,
        hasVideo: Boolean(v),
        hasAudio: Boolean(a),
        width: Number(v?.width) || 0,
        height: Number(v?.height) || 0,
        nbFrames,
      };
    } catch {
      // fall through to ffmpeg stderr parse
    }
  }
  const bin = await getFfmpegBin();
  const r = await execFileAsync(bin, ['-hide_banner', '-i', file]).catch((e) => e);
  const stderr = r.stderr ?? '';
  const m = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(stderr);
  const duration = m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : 0;
  return {
    duration,
    hasVideo: /Stream #\d+:\d+.*Video:/i.test(stderr),
    hasAudio: /Stream #\d+:\d+.*Audio:/i.test(stderr),
    width: 0,
    height: 0,
    nbFrames: 0,
  };
}

async function durationOf(file) {
  const info = await probeMedia(file);
  return info.duration;
}

async function makeAudio(src, start, outDir, volume = 1) {
  const out = join(outDir, 'audio.ogg');
  const args = [
    '-ss', String(Math.max(0, start)),
    '-i', src,
    '-map', '0:a:0',
    '-t', String(MAX_AUDIO_SEC),
    '-vn',
    '-map_metadata', '-1',
    '-avoid_negative_ts', 'make_zero',
  ];
  const vol = Number(volume);
  if (Number.isFinite(vol) && vol > 0 && Math.abs(vol - 1) > 0.01) {
    args.push('-af', `volume=${Math.min(3, Math.max(0.05, vol)).toFixed(2)}`);
  }
  args.push('-c:a', 'libopus', '-b:a', '64k', '-ac', '1', '-ar', '48000', '-f', 'ogg', out);

  try {
    await runFfmpeg(args);
  } catch (e) {
    if (/matches no streams|does not contain any stream/i.test(e.message)) {
      const err = new Error('No audio track found in media. Upload a separate audio file or choose "No sound".');
      err.code = 'no_audio_track';
      throw err;
    }
    throw e;
  }

  const data = await readFile(out);
  const rawSeconds = await durationOf(out);
  const seconds = Math.max(1, Math.min(MAX_AUDIO_SEC, Math.round(rawSeconds || 1)));
  const sha256 = createHash('sha256').update(data).digest('base64');
  return { path: out, data, bytes: data.length, seconds, rawSeconds, sha256 };
}

// fit: whole frame, aspect-fitted with transparent bars. fill: cover the square and centre-crop.
const SCALE_FIT =
  'scale=512:512:force_original_aspect_ratio=decrease,format=rgba,' +
  'pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000';
const SCALE_FILL = 'scale=512:512:force_original_aspect_ratio=increase,crop=512:512,format=rgba';

async function makeWebp(src, start, animDuration, isVideo, outDir, fit = 'fit') {
  const out = join(outDir, 'sticker-raw.webp');
  const budget = MAX_STICKER_BYTES - 512; // reserve headroom for EXIF metadata chunk
  const scale = fit === 'fill' ? SCALE_FILL : SCALE_FIT;

  if (!isVideo) {
    // Always produce a 2-frame animated WebP (confirmed shape for sound stickers across Android & iOS).
    for (const q of [90, 75, 60, 45]) {
      await runFfmpeg(['-i', src, '-vf', scale, '-frames:v', '1', '-c:v', 'libwebp', '-q:v', String(q), out]);
      const still = new webpmux.Image();
      await still.load(out);
      const frames = [
        await webpmux.Image.generateFrame({ img: still, delay: 1000 }),
        await webpmux.Image.generateFrame({ img: still, delay: 1000 }),
      ];
      const buf = await webpmux.Image.save(null, {
        width: 512,
        height: 512,
        frames,
        loops: 0,
        bgColor: [0, 0, 0, 0],
        blend: false,
        dispose: true,
      });
      if (buf.length <= budget) {
        console.log(`sticker: 512x512 ${fit} fps=1 q=${q} bytes=${buf.length}`);
        return { data: buf, fps: 1, quality: q };
      }
    }
    const err = new Error('Could not get the sticker under 500 KB.');
    err.code = 'sticker_too_large';
    throw err;
  }

  const dur = Math.min(MAX_ANIM_SEC, Math.max(0.5, Number(animDuration) || MAX_ANIM_SEC));
  const encodeVideo = async (fps, q) => {
    await runFfmpeg([
      '-ss', String(Math.max(0, start)),
      '-t', String(dur),
      '-i', src,
      '-vf', `hqdn3d=2:1:3:2,fps=${fps},${scale}`,
      '-an',
      '-c:v', 'libwebp_anim',
      '-lossless', '0',
      '-q:v', String(q),
      '-compression_level', '6',
      '-preset', 'photo',
      '-loop', '0',
      out,
    ]);
    return readFile(out);
  };

  let bestOverall = null;
  for (const fps of [15, 12, 10, 8, 6]) {
    let lo = 40;
    let hi = 82;
    let bestForFps = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const buf = await encodeVideo(fps, mid);
      if (buf.length <= budget) {
        bestForFps = { data: buf, fps, quality: mid };
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (bestForFps) {
      if (bestForFps.quality >= 55) {
        console.log(`sticker: 512x512 ${fit} fps=${bestForFps.fps} q=${bestForFps.quality} bytes=${bestForFps.data.length}`);
        return bestForFps;
      }
      if (!bestOverall || bestForFps.quality > bestOverall.quality) {
        bestOverall = bestForFps;
      }
    }
  }
  if (bestOverall) {
    console.log(`sticker: 512x512 ${fit} fps=${bestOverall.fps} q=${bestOverall.quality} bytes=${bestOverall.data.length}`);
    return bestOverall;
  }

  for (const [fps, q] of [[5, 30], [5, 20], [4, 15]]) {
    const buf = await encodeVideo(fps, q);
    if (buf.length <= budget) {
      console.log(`sticker: 512x512 ${fit} fps=${fps} q=${q} bytes=${buf.length}`);
      return { data: buf, fps, quality: q };
    }
  }

  const err = new Error('Could not compress the sticker under 500 KB. Try a shorter duration.');
  err.code = 'sticker_too_large';
  throw err;
}

async function withExif(webp, soundSha256) {
  const payload = {
    'sticker-pack-id': 'sound-sticker-studio',
    'sticker-pack-name': 'Sound Sticker Studio',
    'sticker-pack-publisher': 'Sound Sticker Studio',
    emojis: soundSha256 ? ['🔊'] : ['✨'],
  };
  if (soundSha256) payload['sound-sha256'] = soundSha256;

  const json = Buffer.from(JSON.stringify(payload));
  const head = Buffer.from([
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57,
    0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00,
  ]);
  const exif = Buffer.concat([head, json]);
  exif.writeUIntLE(json.length, 14, 4);

  const img = new webpmux.Image();
  await img.load(webp);
  img.exif = exif;
  return img.save(null);
}

/**
 * Full pipeline: probe -> optional OGG/Opus audio -> 512x512 animated WebP <=500KB -> EXIF injection.
 */
export async function buildSticker({
  mediaPath,
  mediaName = '',
  audioPath = null,
  start = 0,
  duration = MAX_ANIM_SEC,
  mute = false,
  audioVolume = 1,
  fit = 'fit',
  outDir,
}) {
  const framing = fit === 'fill' ? 'fill' : 'fit';
  const ext = extname(mediaName || mediaPath).toLowerCase();
  const info = await probeMedia(mediaPath);
  let isVideo = VIDEO_EXT.has(ext);
  if (!isVideo && !IMAGE_EXT.has(ext)) {
    isVideo = info.hasVideo && (info.duration > 0.2 || info.nbFrames > 1);
  }
  if (ext === '.webp' && (info.duration > 0.2 || info.nbFrames > 1)) {
    isVideo = true;
  }

  const startSec = Math.max(0, Number(start) || 0);
  const animSec = Math.min(MAX_ANIM_SEC, Math.max(1, Number(duration) || MAX_ANIM_SEC));

  let audio = null;
  if (!mute) {
    const audioSrc = audioPath || mediaPath;
    const audioStart = audioPath ? 0 : startSec;
    if (!audioPath && !info.hasAudio) {
      const err = new Error('No audio track found in media. Upload a separate audio file or choose "No sound".');
      err.code = 'no_audio_track';
      throw err;
    }
    audio = await makeAudio(audioSrc, audioStart, outDir, audioVolume);
  }

  const rawWebp = await makeWebp(mediaPath, startSec, animSec, isVideo, outDir, framing);
  const finalWebp = await withExif(rawWebp.data, audio?.sha256 ?? null);
  const stickerPath = join(outDir, 'sticker.webp');
  await writeFile(stickerPath, finalWebp);

  return {
    stickerPath,
    audioPath: audio?.path ?? null,
    stickerBytes: finalWebp.length,
    audioBytes: audio?.bytes ?? 0,
    audioSeconds: audio?.seconds ?? 0,
    animSeconds: isVideo ? Math.min(animSec, info.duration > 0 ? Math.max(1, info.duration - startSec) : animSec) : 2,
    fps: rawWebp.fps,
    quality: rawWebp.quality,
    fit: framing,
    isAnimated: true,
    hasAudio: Boolean(audio),
    soundSha256: audio?.sha256 ?? null,
  };
}
