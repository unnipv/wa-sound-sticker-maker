import { randomBytes } from 'node:crypto';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { buildSticker } from './sticker.js';
import { downloadSection, getCachedInfo } from './youtube.js';

const JOB_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_CONCURRENCY = 2;

export function createJobStore(jobsRootDir) {
  const jobs = new Map();
  const queue = [];
  let running = 0;

  async function init() {
    await mkdir(jobsRootDir, { recursive: true });
    // Clean any leftover job folders older than TTL on startup
    await sweepDisk();
    const timer = setInterval(() => {
      sweep().catch(() => {});
    }, 5 * 60 * 1000);
    timer.unref?.();
  }

  async function sweepDisk() {
    const now = Date.now();
    const entries = await readdir(jobsRootDir).catch(() => []);
    for (const name of entries) {
      if (jobs.has(name)) continue;
      const full = join(jobsRootDir, name);
      const st = await stat(full).catch(() => null);
      if (st && now - st.mtimeMs > JOB_TTL_MS) {
        await rm(full, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  async function sweep() {
    const now = Date.now();
    for (const [id, job] of jobs.entries()) {
      if (now - job.updatedAt > JOB_TTL_MS && job.status !== 'processing') {
        jobs.delete(id);
        await rm(job.dir, { recursive: true, force: true }).catch(() => {});
      }
    }
    await sweepDisk();
  }

  function pump() {
    while (running < MAX_CONCURRENCY && queue.length > 0) {
      const id = queue.shift();
      const job = jobs.get(id);
      if (!job || job.status !== 'queued') continue;
      running++;
      processJob(job).finally(() => {
        running--;
        pump();
      });
    }
  }

  async function processJob(job) {
    job.status = 'processing';
    job.updatedAt = Date.now();
    let downloadedPath = null;
    try {
      let res;
      if (job.input.source === 'youtube') {
        job.stage = 'fetching';
        job.updatedAt = Date.now();
        if (!job.videoTitle && job.input.youtubeId) {
          const cached = getCachedInfo(job.input.youtubeId);
          if (cached?.title) job.videoTitle = cached.title;
        }
        const span = Math.min(11, Math.max(1, job.input.mute || job.input.audioPath ? job.input.duration + 1 : 11));
        downloadedPath = await downloadSection({
          url: job.input.youtubeUrl,
          jobDir: job.dir,
          start: job.input.start,
          span,
        });
        job.stage = 'encoding';
        job.updatedAt = Date.now();
        res = await buildSticker({
          mediaPath: downloadedPath,
          mediaName: basename(downloadedPath),
          audioPath: job.input.audioPath,
          start: 0,
          duration: job.input.duration,
          mute: job.input.mute,
          audioVolume: job.input.audioVolume,
          fit: job.input.fit,
          outDir: job.dir,
        });
      } else {
        job.stage = 'encoding';
        job.updatedAt = Date.now();
        res = await buildSticker({
          mediaPath: job.input.mediaPath,
          mediaName: job.input.mediaName,
          audioPath: job.input.audioPath,
          start: job.input.start,
          duration: job.input.duration,
          mute: job.input.mute,
          audioVolume: job.input.audioVolume,
          fit: job.input.fit,
          outDir: job.dir,
        });
      }
      job.result = res;
      job.status = 'done';
      job.stage = null;
      job.updatedAt = Date.now();
    } catch (err) {
      job.status = 'error';
      job.stage = null;
      job.error = err.message || 'Processing failed';
      job.errorCode = err.code || 'processing_failed';
      job.updatedAt = Date.now();
    } finally {
      // Remove raw uploaded/downloaded input files once processing finishes to save disk space
      if (job.input.mediaPath) await rm(job.input.mediaPath, { force: true }).catch(() => {});
      if (job.input.audioPath) await rm(job.input.audioPath, { force: true }).catch(() => {});
      if (downloadedPath) await rm(downloadedPath, { force: true }).catch(() => {});
    }
  }

  async function enqueue(input) {
    const id = randomBytes(9).toString('hex');
    const dir = join(jobsRootDir, id);
    await mkdir(dir, { recursive: true });
    const now = Date.now();
    const job = {
      id,
      dir,
      status: 'queued',
      stage: null,
      createdAt: now,
      updatedAt: now,
      input,
      videoTitle: input.videoTitle || null,
      result: null,
      error: null,
      errorCode: null,
    };
    jobs.set(id, job);
    queue.push(id);
    pump();
    return job;
  }

  function get(id) {
    return jobs.get(id) || null;
  }

  function serialize(job) {
    const base = {
      id: job.id,
      status: job.status,
      stage: job.stage,
      source: job.input.source || 'upload',
      fit: job.input.fit === 'fill' ? 'fill' : 'fit',
      createdAt: job.createdAt,
    };
    if (job.input.source === 'youtube') {
      base.sourceUrl = job.input.youtubeUrl;
      base.videoTitle = job.videoTitle || null;
      base.sectionStart = job.input.start;
      base.sectionLength = job.input.duration;
    }
    if (job.status === 'error') {
      base.error = job.error;
      base.errorCode = job.errorCode;
    }
    if (job.status === 'done' && job.result) {
      base.sizes = {
        stickerBytes: job.result.stickerBytes,
        audioBytes: job.result.audioBytes,
      };
      base.audioSeconds = job.result.audioSeconds;
      base.animSeconds = job.result.animSeconds;
      base.hasAudio = job.result.hasAudio;
      base.fps = job.result.fps;
      base.quality = job.result.quality;
      base.thumb = `/api/jobs/${job.id}/sticker.webp`;
      base.stickerUrl = `/api/jobs/${job.id}/sticker.webp`;
      base.audioUrl = job.result.hasAudio ? `/api/jobs/${job.id}/audio.ogg` : null;
    }
    return base;
  }

  return { init, enqueue, get, serialize };
}
