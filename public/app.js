const $ = (id) => document.getElementById(id);

const state = {
  status: null,
  sourceTab: 'upload', // upload | youtube
  mediaFile: null,
  mediaIsVideo: false,
  mediaDuration: 0,
  mediaObjectUrl: null,
  mediaDims: null, // { w, h } once the browser knows them
  fit: localStorage.getItem('wa_fit') === 'fill' ? 'fill' : 'fit',
  audioFile: null,
  soundMode: 'video', // video | upload | mute
  deliveryMode: 'relay', // relay | self
  currentJob: null,
  pairPollTimer: null,
  yt: {
    info: null, // { id, title, duration, thumbnail, uploader }
    url: '',
    startSec: 0,
    soundMode: 'video', // video | upload | mute
    audioFile: null,
  },
};

let stepsQueued = false;
function show(el, visible) {
  el.classList.toggle('hidden', !visible);
  if (!stepsQueued) {
    stepsQueued = true;
    queueMicrotask(() => {
      stepsQueued = false;
      updateSteps();
    });
  }
}

const isShown = (id) => !$(id).classList.contains('hidden');

// Source → Look → Send spine, derived from what is on screen.
function updateSteps() {
  let current = 1;
  if (isShown('result-card')) current = 3;
  else if (
    isShown('progress-card') ||
    (state.sourceTab === 'upload' && isShown('tune-panel')) ||
    (state.sourceTab === 'youtube' && isShown('yt-loaded'))
  ) current = 2;
  document.querySelectorAll('#steps .step').forEach((li) => {
    const n = Number(li.dataset.step);
    li.classList.toggle('done', n < current);
    li.classList.toggle('current', n === current);
    if (n === current) li.setAttribute('aria-current', 'step');
    else li.removeAttribute('aria-current');
  });
  // YouTube empty state: only before a video is loaded (doesn't go through show() to avoid a loop)
  $('yt-empty').classList.toggle('hidden', isShown('yt-loaded'));
}

function setPressed(selector, attr, value) {
  document.querySelectorAll(selector).forEach((btn) => {
    const on = btn.dataset[attr] === value;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

// Filled track for range sliders (WebKit has no ::-moz-range-progress equivalent)
function paintRange(el) {
  const min = Number(el.min) || 0;
  const max = Number(el.max) || 0;
  const pct = max > min ? ((Number(el.value) - min) / (max - min)) * 100 : 0;
  el.style.setProperty('--pct', `${Math.max(0, Math.min(100, pct))}%`);
}
function paintAllRanges() {
  document.querySelectorAll('input[type="range"]').forEach(paintRange);
}
document.addEventListener('input', (e) => {
  if (e.target instanceof HTMLInputElement && e.target.type === 'range') paintRange(e.target);
});

// ---------------------------------------------------------------------------
// Trim editor — one component for both sources. Playback goes through an
// adapter: { caps, getTime(), isPlaying(), seek(t, {pause}), play(), pause() }.
//   caps.play     our play/pause controls can drive it
//   caps.preview  true = looped preview, 'once' = one-shot (plain embed)
//   caps.shield   cover the media with our click layer (hides YouTube's chrome)
//   caps.surface  it paints a picture (otherwise the poster stays up)
// ---------------------------------------------------------------------------

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const tenth = (v) => Math.round(v * 10) / 10;
const floorTenth = (v) => Math.floor(v * 10 + 1e-6) / 10;

// 0:34.2 (decimals=1) or 7:34 (decimals=0); h:mm:ss when needed
function formatClock(sec, decimals = 1) {
  const s = Math.max(0, Number(sec) || 0);
  const tenths = decimals ? Math.round(s * 10) : Math.floor(s) * 10;
  const whole = Math.floor(tenths / 10);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const pad2 = (n) => String(n).padStart(2, '0');
  const base = h > 0 ? `${h}:${pad2(m)}:${pad2(whole % 60)}` : `${m}:${pad2(whole % 60)}`;
  return decimals ? `${base}.${tenths % 10}` : base;
}

const NO_PLAYBACK = Object.freeze({
  caps: { play: false, preview: false, shield: false, surface: false },
  getTime: () => 0,
  isPlaying: () => false,
  seek() {},
  play() {},
  pause() {},
});

function createTrimEditor({ mount, frame, idPrefix, field = null, readout = null, poster = null, minLen = 1, maxLen = 6, onChange = () => {} }) {
  const frag = $('trim-editor-tpl').content.cloneNode(true);
  const root = frag.querySelector('[data-te="root"]');
  const overlay = frag.querySelector('[data-te="overlay"]');
  const q = (name, scope = root) => scope.querySelector(`[data-te="${name}"]`);
  const el = {
    play: q('play'),
    clock: q('clock'),
    timeline: q('timeline'),
    track: q('track'),
    dimL: q('dim-l'),
    dimR: q('dim-r'),
    band: q('band'),
    playhead: q('playhead'),
    bandTime: q('band-time'),
    bandRange: q('band-range'),
    bandLen: q('band-len'),
    setStart: q('set-start'),
    preview: q('preview'),
    fieldLabel: q('field-label'),
    readout: q('readout'),
    startOut: q('field'),
    shield: q('shield', overlay),
    bigplay: q('bigplay', overlay),
    status: q('status', overlay),
    note: q('note', overlay),
  };

  root.querySelectorAll('[data-te="nudge"]').forEach((btn) => {
    const d = Number(btn.dataset.delta);
    if (idPrefix && d === -5) btn.id = `${idPrefix}-nudge-back`;
    if (idPrefix && d === 5) btn.id = `${idPrefix}-nudge-fwd`;
    btn.addEventListener('click', () => nudge(d));
  });
  if (field) {
    el.startOut.replaceWith(field);
    el.startOut = null;
    el.fieldLabel.htmlFor = field.id;
  }
  if (readout) {
    el.readout.replaceWith(readout);
    el.readout = readout;
  }
  mount.appendChild(root);
  frame.appendChild(overlay);

  const s = {
    dur: 0,
    start: 0,
    len: maxLen,
    playhead: 0,
    adapter: NO_PLAYBACK,
    previewing: false,
    drag: null,
    raf: 0,
    scrubbed: false, // paused on a frame the user picked — keep the big button out of the way
    started: false, // first play/seek happened (poster can go)
    loopSeekAt: 0,
    idleSince: 0,
  };

  const lenMax = () => (s.dur > 0 ? Math.max(0.1, floorTenth(Math.min(maxLen, s.dur))) : maxLen);
  const lenMin = () => Math.min(minLen, lenMax());
  const pct = (t) => (s.dur > 0 ? clamp((t / s.dur) * 100, 0, 100) : 0);

  function normalize(start, len) {
    const l = clamp(tenth(len), lenMin(), lenMax());
    const st = clamp(tenth(start), 0, Math.max(0, floorTenth(s.dur - l)));
    return [tenth(st), tenth(l)];
  }

  const getSelection = () => ({ start: s.start, len: s.len, end: tenth(s.start + s.len) });

  function setSelection(start, len = s.len, { seek = false, emit = false, seekTo = 'start' } = {}) {
    [s.start, s.len] = normalize(Number.isFinite(start) ? start : 0, Number.isFinite(len) ? len : s.len);
    if (seek) userSeek(seekTo === 'end' ? s.start + s.len : s.start);
    else render();
    if (emit) onChange(getSelection());
  }

  // A seek the user asked for: stop any playback and hold on that frame.
  function userSeek(t) {
    s.previewing = false;
    s.playhead = clamp(t, 0, s.dur || 0);
    s.scrubbed = true;
    s.started = true;
    s.adapter.seek(s.playhead, { pause: true });
    render();
  }

  function nudge(delta) {
    setSelection(s.start + delta, s.len, { seek: true, emit: true });
  }

  function togglePlay() {
    const a = s.adapter;
    if (!a.caps.play) return;
    if (a.isPlaying()) {
      s.previewing = false;
      a.pause();
    } else {
      s.scrubbed = false;
      s.started = true;
      if (s.playhead >= s.dur - 0.05) {
        s.playhead = 0;
        a.seek(0, { pause: false });
      }
      a.play();
    }
    s.idleSince = performance.now();
    wake();
  }

  function togglePreview() {
    const a = s.adapter;
    if (!a.caps.preview) return;
    if (s.previewing) {
      s.previewing = false;
      a.pause();
      render();
      return;
    }
    s.scrubbed = false;
    s.started = true;
    const { start, end } = getSelection();
    s.playhead = start;
    if (a.caps.preview === 'once') {
      a.previewRange(start, end);
      render();
      return;
    }
    s.previewing = true;
    s.loopSeekAt = performance.now();
    s.idleSince = s.loopSeekAt;
    a.seek(start, { pause: false });
    a.play();
    wake();
  }

  function pause() {
    s.previewing = false;
    if (s.adapter.isPlaying()) s.adapter.pause();
    render();
  }

  // Playback loop: only runs while something is playing / previewing.
  function wake() {
    if (s.raf) return;
    s.raf = requestAnimationFrame(step);
  }
  function step() {
    s.raf = 0;
    const a = s.adapter;
    const playing = a.isPlaying();
    const now = performance.now();
    if (!s.drag && (playing || s.previewing)) {
      if (playing) {
        s.playhead = a.getTime();
        s.idleSince = now;
      }
      if (s.previewing && now - s.loopSeekAt > 350) {
        const { start, end } = getSelection();
        const pastEnd = s.playhead >= end - 0.03;
        const ended = !playing && now - s.loopSeekAt > 1000 && a.getTime() >= Math.min(end, s.dur) - 0.3;
        if (pastEnd || ended || (playing && s.playhead < start - 0.5)) {
          // Loop while the toggle stays on
          s.loopSeekAt = now;
          s.playhead = start;
          a.seek(start, { pause: false });
          a.play();
        } else if (!playing && now - s.idleSince > 4000) {
          s.previewing = false; // stalled or paused from outside
        }
      }
    }
    render();
    if (playing || s.previewing) s.raf = requestAnimationFrame(step);
  }

  function render() {
    const a = s.adapter;
    const caps = a.caps;
    const playing = a.isPlaying();
    const { start, len, end } = getSelection();

    el.band.style.left = `${pct(start)}%`;
    el.band.style.width = `max(4px, ${pct(len)}%)`;
    el.dimL.style.width = `${pct(start)}%`;
    el.dimR.style.left = `${pct(end)}%`;
    el.playhead.style.left = `${pct(s.playhead)}%`;

    el.clock.textContent = `${formatClock(s.playhead)} / ${formatClock(s.dur, 0)}`;
    el.bandRange.textContent = `${formatClock(start)} → ${formatClock(end)}`;
    el.bandLen.textContent = `${len.toFixed(1)}s`;
    if (el.readout) el.readout.textContent = `${formatClock(start)} – ${formatClock(end)}`;
    if (el.startOut) el.startOut.textContent = formatClock(start);

    el.band.setAttribute('aria-valuemax', String(Math.max(0, floorTenth(s.dur - len))));
    el.band.setAttribute('aria-valuenow', String(start));
    el.band.setAttribute('aria-valuetext', `${formatClock(start)} to ${formatClock(end)}, ${len.toFixed(1)} seconds`);

    root.classList.toggle('can-play', caps.play);
    root.classList.toggle('is-playing', playing);
    root.classList.toggle('is-previewing', s.previewing);
    el.play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    el.preview.setAttribute('aria-pressed', String(s.previewing));
    el.preview.disabled = !caps.preview || !(s.dur > 0);
    el.setStart.disabled = !(s.dur > 0);

    overlay.classList.toggle('has-shield', caps.shield);
    el.bigplay.classList.toggle('hidden', !(caps.play && !playing && !s.drag && !s.scrubbed));
    if (poster) poster.classList.toggle('hidden', caps.surface && (!caps.play || s.started));

    // Frame time under the band, kept inside the timeline
    const tw = el.track.clientWidth;
    if (tw > 0) {
      const center = el.track.offsetLeft + (tw * pct(start + len / 2)) / 100;
      const lw = el.bandTime.offsetWidth;
      const W = el.timeline.clientWidth;
      el.bandTime.style.left = `${clamp(center - lw / 2, 0, Math.max(0, W - lw))}px`;
    }
  }

  // --- Timeline dragging ----------------------------------------------------
  const timeAt = (clientX) => {
    const r = el.track.getBoundingClientRect();
    return r.width > 0 ? clamp((clientX - r.left) / r.width, 0, 1) * s.dur : 0;
  };

  function applyDrag(clientX) {
    const d = s.drag;
    const t = timeAt(clientX);
    if (d.mode === 'move') {
      setSelection(t - d.grab, s.len);
      userSeek(s.start);
    } else if (d.mode === 'resize-l') {
      const st = clamp(tenth(t - d.grab), Math.max(0, d.end - lenMax()), d.end - lenMin());
      setSelection(st, d.end - st);
      userSeek(s.start);
    } else if (d.mode === 'resize-r') {
      setSelection(s.start, t - d.grabEnd - s.start);
      userSeek(s.start + s.len);
    } else {
      userSeek(t);
      return;
    }
    onChange(getSelection());
  }

  el.timeline.addEventListener('pointerdown', (e) => {
    if ((e.pointerType === 'mouse' && e.button !== 0) || !(s.dur > 0)) return;
    e.preventDefault();
    const part = e.target.closest('[data-te]')?.dataset.te;
    const mode = part === 'handle-l' ? 'resize-l' : part === 'handle-r' ? 'resize-r' : part === 'band' ? 'move' : 'scrub';
    const t = timeAt(e.clientX);
    // grab offsets: the edge/band moves with the pointer instead of jumping to it
    s.drag = { mode, id: e.pointerId, grab: t - s.start, grabEnd: t - (s.start + s.len), end: tenth(s.start + s.len) };
    el.timeline.setPointerCapture(e.pointerId);
    root.classList.add('is-dragging');
    root.dataset.drag = mode;
    el.band.focus({ preventScroll: true });
    if (mode === 'scrub') userSeek(t);
    else userSeek(mode === 'resize-r' ? s.start + s.len : s.start); // show the frame being picked right away
  });
  el.timeline.addEventListener('pointermove', (e) => {
    if (s.drag && e.pointerId === s.drag.id) applyDrag(e.clientX);
  });
  const endDrag = (e) => {
    if (!s.drag || e.pointerId !== s.drag.id) return;
    s.drag = null;
    root.classList.remove('is-dragging');
    delete root.dataset.drag;
    onChange(getSelection());
    render();
  };
  el.timeline.addEventListener('pointerup', endDrag);
  el.timeline.addEventListener('pointercancel', endDrag);
  el.timeline.addEventListener('lostpointercapture', endDrag);

  // Keyboard: ←/→ 0.1 s, Shift 1 s (band start) whenever focus is inside the editor
  const onKey = (e) => {
    if (e.target instanceof HTMLInputElement || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    nudge((e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 1 : 0.1));
  };
  root.addEventListener('keydown', onKey);
  overlay.addEventListener('keydown', onKey);

  el.play.addEventListener('click', togglePlay);
  el.bigplay.addEventListener('click', togglePlay);
  el.shield.addEventListener('click', togglePlay);
  el.preview.addEventListener('click', togglePreview);
  el.setStart.addEventListener('click', () => {
    setSelection(s.playhead, s.len, { emit: true });
  });

  new ResizeObserver(() => render()).observe(root);

  return {
    getSelection,
    setSelection,
    pause,
    get playhead() {
      return s.playhead;
    },
    setDuration(d) {
      s.dur = Math.max(0, Number(d) || 0);
      s.playhead = clamp(s.playhead, 0, s.dur);
      [s.start, s.len] = normalize(s.start, s.len);
      render();
    },
    setAdapter(adapter) {
      if (s.adapter !== adapter && s.adapter.isPlaying()) s.adapter.pause();
      s.adapter = adapter || NO_PLAYBACK;
      if (s.adapter !== NO_PLAYBACK) s.adapter.onState = wake;
      s.previewing = false;
      s.scrubbed = false;
      s.started = false;
      s.playhead = 0;
      render();
    },
    setStatus(text) {
      el.status.textContent = text || '';
      el.status.classList.toggle('hidden', !text);
    },
    setNote(text) {
      el.note.textContent = text || '';
      el.note.classList.toggle('hidden', !text);
    },
  };
}

// <video> adapter — one per element, reused across files
function videoAdapter(video) {
  let pending = null;
  const a = {
    caps: { play: true, preview: true, shield: true, surface: true },
    onState: null,
    getTime: () => video.currentTime || 0,
    isPlaying: () => !video.paused && !video.ended,
    seek(t, { pause = true } = {}) {
      if (pause && !video.paused) video.pause();
      if (video.readyState < 1 || video.seeking) {
        pending = t; // latest wins; applied on 'seeked'/'loadedmetadata'
        return;
      }
      video.currentTime = t;
    },
    play() {
      video.play().catch(() => a.onState?.());
    },
    pause() {
      video.pause();
    },
  };
  const flush = () => {
    if (pending != null && !video.seeking && video.readyState >= 1) {
      const t = pending;
      pending = null;
      video.currentTime = t;
    }
    a.onState?.();
  };
  video.addEventListener('seeked', flush);
  video.addEventListener('loadedmetadata', flush);
  ['play', 'pause', 'ended', 'playing'].forEach((ev) => video.addEventListener(ev, () => a.onState?.()));
  return a;
}

// YouTube IFrame Player API adapter
function ytApiAdapter(player) {
  const PLAYING = 1;
  const BUFFERING = 3;
  let holdPause = false; // seekTo() on a cued video starts playback — swallow that
  let lastSeek = 0;
  let trailing = null;
  let target = 0;
  const a = {
    caps: { play: true, preview: true, shield: true, surface: true },
    onState: null,
    getTime() {
      try {
        return holdPause ? target : player.getCurrentTime() || 0;
      } catch {
        return target;
      }
    },
    isPlaying() {
      if (holdPause) return false;
      const st = player.getPlayerState?.();
      return st === PLAYING || st === BUFFERING;
    },
    seek(t, { pause = true } = {}) {
      target = t;
      if (pause && !holdPause) {
        holdPause = true;
        player.mute?.();
        player.pauseVideo?.();
      } else if (!pause) {
        holdPause = false;
      }
      const run = () => {
        trailing = null;
        lastSeek = performance.now();
        player.seekTo?.(target, true);
        if (holdPause) player.pauseVideo?.();
      };
      const wait = 120 - (performance.now() - lastSeek); // throttle network seeks while dragging
      if (wait <= 0) run();
      else if (!trailing) trailing = setTimeout(run, wait);
    },
    play() {
      holdPause = false;
      player.unMute?.();
      player.playVideo?.();
    },
    pause() {
      player.pauseVideo?.();
    },
    handleState(st) {
      if (holdPause && st === PLAYING) player.pauseVideo?.();
      a.onState?.();
    },
  };
  return a;
}

// Plain-embed fallback (no IFrame API): the timeline still moves the embed via ?start=
function ytEmbedAdapter(iframe, videoId) {
  let t = 0;
  let timer = null;
  let lastStart = null;
  const load = (params) => {
    const qs = new URLSearchParams({ playsinline: '1', rel: '0', ...params });
    iframe.src = `https://www.youtube.com/embed/${encodeURIComponent(videoId)}?${qs}`;
  };
  load({ start: '0' });
  lastStart = 0;
  return {
    caps: { play: false, preview: 'once', shield: false, surface: true },
    onState: null,
    getTime: () => t,
    isPlaying: () => false,
    seek(sec) {
      t = sec;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const f = Math.floor(t);
        if (f === lastStart) return;
        lastStart = f;
        load({ start: String(f) });
      }, 450);
    },
    previewRange(from, to) {
      clearTimeout(timer);
      lastStart = null;
      load({ start: String(Math.floor(from)), end: String(Math.ceil(to)), autoplay: '1' });
    },
    play() {},
    pause() {},
  };
}

// Lazy IFrame API loader — resolves YT or null after ~8 s
let ytApiPromise = null;
function loadYtApi(timeoutMs = 8000) {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (!ytApiPromise) {
    ytApiPromise = new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        prev?.();
        clearTimeout(timer);
        resolve(window.YT);
      };
      const script = document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api';
      script.async = true;
      script.onerror = () => {
        clearTimeout(timer);
        resolve(null);
      };
      document.head.appendChild(script);
    });
  }
  return ytApiPromise.then((yt) => yt || (window.YT?.Player ? window.YT : null));
}

// Turn raw server/ffmpeg errors into something a person can act on.
function friendlyError(err) {
  if (err instanceof ApiNetworkError) {
    return "Couldn't reach the server. Check your connection and try again.";
  }
  if (err instanceof TypeError || err instanceof ReferenceError || err instanceof RangeError || err instanceof SyntaxError) {
    // a bug on our side, not something the server said — don't dress it up as one
    console.error(err);
    return 'Something went wrong on this page. Please try again.';
  }
  const msg = String(err?.message || '').trim();
  if (/^ffmpeg failed/i.test(msg)) {
    return "We couldn't decode that file. It may be damaged or in an unusual format — try exporting it as MP4 or PNG and upload again.";
  }
  if (!msg) return 'Something went wrong while building the sticker. Please try again.';
  return /[.!?]$/.test(msg) ? msg : `${msg}.`;
}

// Fit / Fill framing (shared by both tabs, remembered)
const FAR_FROM_SQUARE = (w, h) => {
  if (!(w > 0 && h > 0)) return false;
  const r = w / h;
  return r > 1.35 || r < 0.74;
};

function setFit(mode) {
  state.fit = mode === 'fill' ? 'fill' : 'fit';
  localStorage.setItem('wa_fit', state.fit);
  setPressed('[data-fit]', 'fit', state.fit);
  setPressed('[data-yt-fit]', 'ytFit', state.fit);
}

function updateFitHints() {
  const d = state.mediaDims;
  show($('fit-hint'), Boolean(d && FAR_FROM_SQUARE(d.w, d.h)));
  const info = state.yt.info;
  show($('yt-fit-hint'), Boolean(info && FAR_FROM_SQUARE(info.width, info.height)));
}

document.querySelectorAll('[data-fit]').forEach((btn) => {
  btn.addEventListener('click', () => setFit(btn.dataset.fit));
});
document.querySelectorAll('[data-yt-fit]').forEach((btn) => {
  btn.addEventListener('click', () => setFit(btn.dataset.ytFit));
});

// Progress: Upload/Fetch → Encode → Ready
function setProgressStage(stage, firstLabel) {
  if (firstLabel) $('stage-fetch-label').textContent = firstLabel;
  const order = ['fetch', 'encode', 'done'];
  const idx = order.indexOf(stage);
  document.querySelectorAll('#stage-track li').forEach((li) => {
    const i = order.indexOf(li.dataset.stage);
    li.classList.toggle('done', i < idx);
    li.classList.toggle('current', i === idx);
  });
}

function setError(el, msg) {
  if (!msg) {
    el.textContent = '';
    show(el, false);
  } else {
    el.textContent = msg;
    show(el, true);
  }
}

// Errors from our own API: ApiNetworkError = the request never got an answer,
// ApiError = the server answered with a failure. Anything else is a page bug.
class ApiError extends Error {}
class ApiNetworkError extends ApiError {}

async function api(url, opts = {}) {
  let res;
  try {
    res = await fetch(url, opts);
  } catch (cause) {
    if (cause?.name === 'AbortError') throw cause;
    throw new ApiNetworkError(`Request to ${url} failed`, { cause });
  }
  const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!res.ok || data.ok === false) {
    const err = new ApiError(data.error || `Request failed (${res.status})`);
    err.code = data.errorCode || null;
    err.status = res.status;
    throw err;
  }
  return data;
}

async function refreshStatus() {
  try {
    const st = await api('/api/status');
    state.status = st;
    $('max-mb').textContent = st.limits?.maxUploadMb ?? 100;

    if (st.passcodeRequired && !st.authenticated) {
      show($('passcode-card'), true);
      show($('studio'), false);
      $('status-pill').textContent = 'Locked';
      $('status-pill').className = 'pill pill-muted';
      return;
    }

    show($('passcode-card'), false);
    show($('studio'), true);
    renderConnectionStatus();
    renderYouTubeAvailability();
  } catch (err) {
    $('status-pill').textContent = 'Offline';
    $('status-pill').className = 'pill pill-muted';
  }
}

function renderConnectionStatus() {
  const st = state.status;
  if (!st) return;

  const relayPaired = Boolean(st.relay?.enabled && st.relay?.paired);
  const selfPaired = Boolean(st.self?.paired);

  const pill = $('status-pill');
  if (relayPaired || selfPaired) {
    pill.textContent = relayPaired ? 'Relay ready' : 'WhatsApp linked';
    pill.className = 'pill pill-ok';
  } else {
    pill.textContent = 'Not linked';
    pill.className = 'pill pill-muted';
  }

  // Relay send button state
  const relayBtn = $('send-relay-btn');
  if (!st.relay?.enabled) {
    relayBtn.disabled = true;
    relayBtn.textContent = 'Server relay is disabled';
  } else if (!relayPaired) {
    relayBtn.disabled = true;
    relayBtn.textContent = "Server's WhatsApp isn't linked yet";
  } else {
    relayBtn.disabled = false;
    relayBtn.textContent = 'Send to my WhatsApp';
  }

  // Self pair state
  show($('self-unpaired'), !selfPaired);
  show($('self-paired'), selfPaired);
  if (selfPaired) {
    $('self-me').textContent = st.self?.me?.phone ? `+${st.self.me.phone}` : 'your WhatsApp';
    stopPairPolling();
  }
}

// Passcode form
$('passcode-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  setError($('passcode-error'), '');
  try {
    await api('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode: $('passcode-input').value }),
    });
    $('passcode-input').value = '';
    await refreshStatus();
  } catch (err) {
    setError($('passcode-error'), err.message);
  }
});

// Media dropzone
const dropzone = $('dropzone');
const mediaInput = $('media-input');

dropzone.addEventListener('click', () => mediaInput.click());
dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    mediaInput.click();
  }
});
dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('dragover');
});
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('dragover');
  if (e.dataTransfer.files?.[0]) handleMediaFile(e.dataTransfer.files[0]);
});
mediaInput.addEventListener('change', () => {
  if (mediaInput.files?.[0]) handleMediaFile(mediaInput.files[0]);
});
$('change-media-btn').addEventListener('click', () => mediaInput.click());

function handleMediaFile(file) {
  if (state.mediaObjectUrl) URL.revokeObjectURL(state.mediaObjectUrl);
  state.mediaFile = file;
  state.mediaObjectUrl = URL.createObjectURL(file);
  state.mediaDuration = 0;
  state.mediaDims = null;
  updateFitHints();
  setError($('build-error'), '');

  const isVideo = file.type.startsWith('video/') || /\.(mp4|mov|m4v|webm|mkv|avi|3gp)$/i.test(file.name);
  state.mediaIsVideo = isVideo;

  show(dropzone, false);
  show($('tune-panel'), true);
  show($('result-card'), false);
  $('file-name').textContent = `${file.name} (${(file.size / (1024 * 1024)).toFixed(1)} MB)`;

  const vid = $('video-preview');
  const img = $('image-preview');
  const frame = $('upload-frame');
  const setFrameRatio = (w, h) => {
    // Square for portrait, up to 16:9 for landscape; media is letterboxed inside
    if (w > 0 && h > 0) frame.style.setProperty('--ar', String(clamp(w / h, 1, 16 / 9)));
  };

  upEditor.setAdapter(null);
  upEditor.setDuration(0);
  if (isVideo) {
    show(img, false);
    img.removeAttribute('src');
    show(vid, true);
    show($('video-controls'), true);
    vid.src = state.mediaObjectUrl;
    vid.onloadedmetadata = () => {
      const dur = Number.isFinite(vid.duration) ? vid.duration : 0;
      state.mediaDuration = dur;
      state.mediaDims = { w: vid.videoWidth, h: vid.videoHeight };
      setFrameRatio(vid.videoWidth, vid.videoHeight);
      updateFitHints();
      const slider = $('duration-slider');
      slider.max = String(Math.max(1, Math.min(6, floorTenth(dur))));
      $('start-slider').max = String(Math.max(0, floorTenth(dur)));
      upEditor.setDuration(dur);
      upEditor.setAdapter(uploadPlayback);
      upEditor.setSelection(0, Number(slider.value) || 6, { emit: true });
      if (vid.currentTime === 0) vid.currentTime = 0.01; // paint the first frame on mobile Safari
    };
    setSoundMode('video');
  } else {
    show(vid, false);
    vid.removeAttribute('src');
    vid.load();
    show($('video-controls'), false);
    show(img, true);
    img.onload = () => {
      state.mediaDims = { w: img.naturalWidth, h: img.naturalHeight };
      setFrameRatio(img.naturalWidth, img.naturalHeight);
      updateFitHints();
    };
    img.src = state.mediaObjectUrl;
    // Images/GIFs have no audio track — default to upload audio so user gets a hint right away
    setSoundMode('upload');
  }
}

function setLengthUi(sliderId, labelId, len) {
  const slider = $(sliderId);
  slider.value = String(len);
  $(labelId).textContent = `${len.toFixed(1)}s`;
  paintRange(slider);
}

const upEditor = createTrimEditor({
  mount: $('upload-trim'),
  frame: $('upload-frame'),
  idPrefix: 'up',
  readout: $('start-val'),
  onChange: ({ start, len }) => {
    $('start-slider').value = String(start);
    setLengthUi('duration-slider', 'duration-val', len);
  },
});
const uploadPlayback = videoAdapter($('video-preview'));

$('duration-slider').addEventListener('input', () => {
  const val = Number($('duration-slider').value) || 6;
  upEditor.setSelection(upEditor.getSelection().start, val, { emit: true });
});

$('volume-slider').addEventListener('input', () => {
  const v = Number($('volume-slider').value) || 1;
  $('volume-val').textContent = `${Math.round(v * 100)}%`;
});

// Sound mode segmented control
function setSoundMode(mode) {
  state.soundMode = mode;
  setPressed('[data-sound]', 'sound', mode);
  show($('audio-upload-box'), mode === 'upload');
  show($('volume-box'), mode !== 'mute');
}

document.querySelectorAll('[data-sound]').forEach((btn) => {
  btn.addEventListener('click', () => setSoundMode(btn.dataset.sound));
});

$('audio-input').addEventListener('change', () => {
  const f = $('audio-input').files?.[0] || null;
  state.audioFile = f;
  $('audio-file-label').textContent = f ? `${f.name} (${(f.size / 1024).toFixed(0)} KB)` : 'Choose audio file (MP3, WAV, M4A, OGG)';
});

// Build button
$('build-btn').addEventListener('click', async () => {
  if (!state.mediaFile) return;
  setError($('build-error'), '');
  if (state.soundMode === 'upload' && !state.audioFile) {
    setError($('build-error'), 'Choose an audio file, or switch to "From video" / "No sound".');
    return;
  }

  const fd = new FormData();
  fd.append('media', state.mediaFile);
  if (state.soundMode === 'upload' && state.audioFile) {
    fd.append('audio', state.audioFile);
  }
  upEditor.pause();
  fd.append('start', $('start-slider').value || '0');
  fd.append('duration', $('duration-slider').value || '6');
  fd.append('mute', state.soundMode === 'mute' ? 'true' : 'false');
  fd.append('audioVolume', $('volume-slider').value || '1');
  fd.append('fit', state.fit);

  show($('editor-card'), false);
  show($('result-card'), false);
  show($('progress-card'), true);
  setProgressStage('fetch', 'Upload');
  $('progress-title').textContent = 'Uploading…';
  $('progress-sub').textContent = `${state.mediaFile.name} · ${(state.mediaFile.size / (1024 * 1024)).toFixed(1)} MB`;

  try {
    const created = await api('/api/jobs', { method: 'POST', body: fd });
    setProgressStage('encode');
    $('progress-title').textContent = 'Encoding sticker…';
    const job = await pollJob(created.id);
    state.currentJob = job;
    renderResult(job);
  } catch (err) {
    show($('progress-card'), false);
    show($('editor-card'), true);
    if (err.code === 'no_audio_track') {
      setError($('build-error'), 'This file has no audio track. Switch to "Upload audio" to add a sound, or "No sound" for a silent sticker.');
      setSoundMode('upload');
    } else {
      setError($('build-error'), friendlyError(err));
    }
  }
});

// ---------------------------------------------------------------------------
// Source tabs & YouTube link flow
// ---------------------------------------------------------------------------

function setSourceTab(tab) {
  state.sourceTab = tab;
  document.querySelectorAll('[data-source-tab]').forEach((btn) => {
    const active = btn.dataset.sourceTab === tab;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  show($('upload-tab-panel'), tab === 'upload');
  show($('youtube-tab-panel'), tab === 'youtube');
  if (tab === 'youtube') {
    upEditor.pause();
    loadYtApi(); // lazy: only fetched once the YouTube tab is opened
  } else {
    ytEditor.pause();
  }
}

document.querySelectorAll('[data-source-tab]').forEach((btn) => {
  btn.addEventListener('click', () => setSourceTab(btn.dataset.sourceTab));
});

function renderYouTubeAvailability() {
  const avail = state.status?.youtube?.available !== false;
  show($('yt-unavailable-note'), !avail);
  $('yt-fetch-btn').disabled = !avail;
}

function formatTimestamp(sec) {
  const tenths = Math.round(Math.max(0, Number(sec) || 0) * 10);
  const whole = Math.floor(tenths / 10);
  const frac = tenths % 10;
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const rem = whole % 60;
  const pad2 = (n) => String(n).padStart(2, '0');
  const base = h > 0 ? `${h}:${pad2(m)}:${pad2(rem)}` : `${m}:${pad2(rem)}`;
  return frac > 0 ? `${base}.${frac}` : base;
}

function parseTimestamp(text) {
  const raw = String(text || '').trim();
  if (!raw) return 0;
  if (/^\d+(\.\d+)?$/.test(raw)) {
    return Number(raw);
  }
  const parts = raw.split(':').map((p) => p.trim());
  if (parts.length === 2 && parts.every((p) => /^\d+(\.\d+)?$/.test(p))) {
    return Number(parts[0]) * 60 + Number(parts[1]);
  }
  if (parts.length === 3 && parts.every((p) => /^\d+(\.\d+)?$/.test(p))) {
    return Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]);
  }
  return NaN;
}

const ytEditor = createTrimEditor({
  mount: $('yt-trim'),
  frame: $('yt-frame'),
  idPrefix: 'yt',
  field: $('yt-start-input'),
  readout: $('yt-range-val'),
  poster: $('yt-thumb'),
  onChange: ({ start, len }) => {
    state.yt.startSec = start;
    // the text field is the source of truth for `start`; the timeline writes into it
    if (document.activeElement !== $('yt-start-input')) $('yt-start-input').value = formatTimestamp(start);
    setLengthUi('yt-duration-slider', 'yt-duration-val', len);
  },
});

function setYtStart(sec, { updateInput = true, seek = true } = {}) {
  ytEditor.setSelection(Number.isFinite(sec) ? sec : 0, Number($('yt-duration-slider').value) || 6, { seek });
  state.yt.startSec = ytEditor.getSelection().start;
  if (updateInput) $('yt-start-input').value = formatTimestamp(state.yt.startSec);
}

// --- Player lifecycle -------------------------------------------------------
let ytPlayer = null;
let ytMountToken = 0;

const YT_NO_PREVIEW = 'Trimming still works from the numbers — the sticker is cut at exactly these times.';

function ytPlaybackUnavailable(reason) {
  ytEditor.setAdapter(null);
  ytEditor.setStatus(null);
  ytEditor.setNote(`${reason} ${YT_NO_PREVIEW}`);
}

function destroyYtPlayer() {
  try {
    ytPlayer?.destroy();
  } catch {}
  ytPlayer = null;
  $('yt-player-slot').replaceChildren();
}

async function mountYtPlayer(info) {
  const token = ++ytMountToken;
  destroyYtPlayer();
  ytEditor.setAdapter(null);
  ytEditor.setNote(null);
  ytEditor.setStatus('Loading player…');

  let YTns = null;
  try {
    YTns = await loadYtApi();
  } catch (err) {
    console.warn('[yt] IFrame API failed to load, using plain embed', err);
  }
  if (token !== ytMountToken) return;
  if (!YTns || typeof YTns.Player !== 'function') {
    mountYtEmbed(info);
    return;
  }
  try {
    mountYtApiPlayer(YTns, info, token);
  } catch (err) {
    console.warn('[yt] IFrame API player setup failed, using plain embed', err);
    if (token !== ytMountToken) return;
    destroyYtPlayer();
    mountYtEmbed(info);
  }
}

// API unavailable: plain embed (YouTube's own controls), timeline reloads it at ?start=
function mountYtEmbed(info) {
  const slot = $('yt-player-slot');
  slot.replaceChildren();
  try {
    const iframe = document.createElement('iframe');
    iframe.id = 'yt-embed';
    iframe.title = 'YouTube clip preview';
    iframe.allow = 'encrypted-media; picture-in-picture';
    iframe.referrerPolicy = 'strict-origin-when-cross-origin';
    iframe.allowFullscreen = true;
    slot.appendChild(iframe);
    ytEditor.setStatus(null);
    ytEditor.setAdapter(ytEmbedAdapter(iframe, info.id));
  } catch (err) {
    console.warn('[yt] plain embed failed too', err);
    ytPlaybackUnavailable("The YouTube player couldn't be set up, so there's no live preview.");
  }
}

function mountYtApiPlayer(YTns, info, token) {
  const slot = $('yt-player-slot');
  const host = document.createElement('div');
  host.id = 'yt-embed'; // the API swaps this for its iframe, keeping the id
  slot.appendChild(host);
  let adapter = null;
  const readyTimer = setTimeout(() => {
    if (token === ytMountToken && !adapter) ytPlaybackUnavailable("The YouTube player didn't load, so there's no live preview.");
  }, 12000);
  ytPlayer = new YTns.Player(host, {
    width: '100%',
    height: '100%',
    videoId: info.id,
    playerVars: {
      playsinline: 1,
      controls: 0,
      modestbranding: 1,
      rel: 0,
      disablekb: 1,
      fs: 0,
      iv_load_policy: 3,
      origin: location.origin,
    },
    events: {
      onReady: () => {
        if (token !== ytMountToken) return;
        clearTimeout(readyTimer);
        try {
          adapter = ytApiAdapter(ytPlayer);
          ytEditor.setStatus(null);
          ytEditor.setNote(null);
          const { start } = ytEditor.getSelection();
          ytEditor.setAdapter(adapter);
          if (start > 0) ytEditor.setSelection(start, undefined, { seek: true });
        } catch (err) {
          console.warn('[yt] player ready handling failed, using plain embed', err);
          adapter = NO_PLAYBACK;
          destroyYtPlayer();
          mountYtEmbed(info);
        }
      },
      onStateChange: (e) => {
        if (token === ytMountToken) adapter?.handleState(e.data);
      },
      onError: (e) => {
        if (token !== ytMountToken) return;
        clearTimeout(readyTimer);
        adapter = adapter || NO_PLAYBACK;
        const embedBlocked = e.data === 101 || e.data === 150 || e.data === 153;
        ytPlaybackUnavailable(
          embedBlocked
            ? "This video's owner doesn't allow playback outside YouTube, so there's no live preview."
            : "YouTube won't play this video here, so there's no live preview.",
        );
      },
    },
  });
}

function setYtSoundMode(mode) {
  state.yt.soundMode = mode;
  setPressed('[data-yt-sound]', 'ytSound', mode);
  show($('yt-audio-upload-box'), mode === 'upload');
  show($('yt-volume-box'), mode !== 'mute');
}

document.querySelectorAll('[data-yt-sound]').forEach((btn) => {
  btn.addEventListener('click', () => setYtSoundMode(btn.dataset.ytSound));
});

$('yt-audio-input').addEventListener('change', () => {
  const f = $('yt-audio-input').files?.[0] || null;
  state.yt.audioFile = f;
  $('yt-audio-file-label').textContent = f ? `${f.name} (${(f.size / 1024).toFixed(0)} KB)` : 'Choose audio file (MP3, WAV, M4A, OGG)';
});

$('yt-volume-slider').addEventListener('input', () => {
  const v = Number($('yt-volume-slider').value) || 1;
  $('yt-volume-val').textContent = `${Math.round(v * 100)}%`;
});

$('yt-duration-slider').addEventListener('input', () => {
  const val = Number($('yt-duration-slider').value) || 6;
  ytEditor.setSelection(ytEditor.getSelection().start, val, { emit: true });
});

$('yt-start-input').addEventListener('input', () => {
  const parsed = parseTimestamp($('yt-start-input').value);
  if (Number.isFinite(parsed)) {
    setYtStart(parsed, { updateInput: false });
  }
});

$('yt-start-input').addEventListener('blur', () => {
  const parsed = parseTimestamp($('yt-start-input').value);
  setYtStart(Number.isFinite(parsed) ? parsed : state.yt.startSec, { updateInput: true, seek: false });
});

$('yt-start-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    $('yt-start-input').blur();
  }
});

$('yt-fetch-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = $('yt-url-input').value.trim();
  setError($('yt-error'), '');
  setError($('yt-build-error'), '');
  if (!url) {
    setError($('yt-error'), 'Paste a YouTube link first.');
    return;
  }

  const btn = $('yt-fetch-btn');
  btn.disabled = true;
  btn.textContent = 'Fetching…';

  try {
    const info = await api('/api/yt/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    state.yt.info = info;
    state.yt.url = url;

    $('yt-thumb').src = info.thumbnail || '';
    $('yt-title').textContent = info.title || 'Untitled video';
    $('yt-uploader').textContent = info.uploader || 'YouTube';
    $('yt-duration').textContent = formatClock(info.duration, 0);

    const maxLen = Math.min(6, Math.max(1, floorTenth(info.duration) || 6));
    const durSlider = $('yt-duration-slider');
    durSlider.max = String(maxLen);
    if (Number(durSlider.value) > maxLen) durSlider.value = String(maxLen);
    $('yt-duration-val').textContent = `${Number(durSlider.value).toFixed(1)}s`;

    show($('yt-loaded'), true);
    show($('result-card'), false);
    updateFitHints();
    paintAllRanges();
    ytEditor.setDuration(info.duration);
    setYtStart(0, { updateInput: true, seek: false });
    setYtSoundMode('video');
    mountYtPlayer(info).catch((err) => {
      console.warn('[yt] player mount failed, using plain embed', err);
      mountYtEmbed(info);
    });
  } catch (err) {
    show($('yt-loaded'), false);
    state.yt.info = null;
    ytMountToken++;
    destroyYtPlayer();
    updateFitHints();
    setError($('yt-error'), ytFetchError(err));
  } finally {
    btn.textContent = 'Fetch';
    renderYouTubeAvailability();
  }
});

function ytFetchError(err) {
  if (err.code === 'video_unavailable') {
    return "YouTube won't serve this video to our server — it may be region-locked, age-restricted or a live stream.";
  }
  if (err.code === 'live_not_supported') {
    return "That's a live stream — YouTube won't hand us a fixed clip of it. Try again once the stream has ended.";
  }
  return friendlyError(err);
}

$('yt-build-btn').addEventListener('click', async () => {
  if (!state.yt.info) return;
  setError($('yt-build-error'), '');
  ytEditor.pause();

  // Normalize start input in case user clicked Build without blurring
  const parsedStart = parseTimestamp($('yt-start-input').value);
  setYtStart(Number.isFinite(parsedStart) ? parsedStart : state.yt.startSec, { updateInput: true, seek: false });

  if (state.yt.soundMode === 'upload' && !state.yt.audioFile) {
    setError($('yt-build-error'), 'Choose an audio file, or switch to "From video" / "No sound".');
    return;
  }

  const start = state.yt.startSec;
  const duration = Number($('yt-duration-slider').value) || 6;
  const end = Math.min(state.yt.info.duration || start + duration, start + duration);
  const rangeLabel = `${formatTimestamp(start)}–${formatTimestamp(end)}`;

  const fd = new FormData();
  fd.append('source', 'youtube');
  fd.append('youtubeUrl', state.yt.url);
  fd.append('videoTitle', state.yt.info.title || '');
  fd.append('start', String(start));
  fd.append('duration', String(duration));
  fd.append('mute', state.yt.soundMode === 'mute' ? 'true' : 'false');
  fd.append('audioVolume', $('yt-volume-slider').value || '1');
  fd.append('fit', state.fit);
  if (state.yt.soundMode === 'upload' && state.yt.audioFile) {
    fd.append('audio', state.yt.audioFile);
  }

  show($('editor-card'), false);
  show($('result-card'), false);
  show($('progress-card'), true);
  setProgressStage('fetch', 'Fetch');
  $('progress-title').textContent = `Fetching clip… (${rangeLabel})`;
  $('progress-sub').textContent = state.yt.info.title || 'Downloading trimmed section from YouTube';

  try {
    const created = await api('/api/jobs', { method: 'POST', body: fd });
    const job = await pollJob(created.id, { rangeLabel, videoTitle: state.yt.info.title });
    state.currentJob = job;
    renderResult(job);
  } catch (err) {
    show($('progress-card'), false);
    show($('editor-card'), true);
    if (err.code === 'no_audio_track') {
      setError($('yt-build-error'), 'This clip has no audio track. Switch to "Upload audio" to add a sound, or "No sound" for a silent sticker.');
      setYtSoundMode('upload');
    } else {
      setError($('yt-build-error'), friendlyError(err));
    }
  }
});

async function pollJob(id, ctx = {}) {
  for (let i = 0; i < 360; i++) {
    const job = await api(`/api/jobs/${id}`);
    if (job.status === 'done') return job;
    if (job.status === 'error') {
      const err = new Error(job.error || 'Encoding failed');
      err.code = job.errorCode;
      throw err;
    }
    if (job.status === 'queued') {
      $('progress-title').textContent = 'Queued…';
      $('progress-sub').textContent = 'Waiting for an available worker';
    } else if (job.stage === 'fetching') {
      const range = ctx.rangeLabel ? ` (${ctx.rangeLabel})` : '';
      setProgressStage('fetch');
      $('progress-title').textContent = `Fetching clip…${range}`;
      $('progress-sub').textContent = ctx.videoTitle || job.videoTitle || 'Downloading trimmed section from YouTube';
    } else {
      setProgressStage('encode');
      $('progress-title').textContent = 'Encoding sticker…';
      $('progress-sub').textContent = `512×512 animated WebP, ${job.fit === 'fill' ? 'filled' : 'fitted'} · squeezing it under 500 KB`;
    }
    await new Promise((r) => setTimeout(r, 600));
  }
  throw new Error('Encoding timed out. Try a shorter clip.');
}

function renderResult(job) {
  show($('progress-card'), false);
  show($('result-card'), true);
  setError($('send-error'), '');
  show($('send-success'), false);

  if (job.sourceUrl) {
    const link = $('result-source-link');
    link.href = job.sourceUrl;
    link.textContent = job.videoTitle || job.sourceUrl;
    show($('result-source'), true);
  } else {
    show($('result-source'), false);
  }

  const bust = `?t=${Date.now()}`;
  $('sticker-img').src = `${job.stickerUrl}${bust}`;

  const kb = (job.sizes.stickerBytes / 1024).toFixed(0);
  $('meta-size').textContent = `${kb} KB`;
  show($('meta-crop'), job.fit === 'fill');

  const audioEl = $('sticker-audio');
  if (job.hasAudio && job.audioUrl) {
    audioEl.src = `${job.audioUrl}${bust}`;
    $('meta-audio').textContent = `${job.audioSeconds}s`;
    show($('play-audio-btn'), true);
  } else {
    audioEl.removeAttribute('src');
    $('meta-audio').textContent = 'Silent';
    show($('play-audio-btn'), false);
  }
  audioEl.pause();
  setPlayButton(false);
}

function setPlayButton(playing) {
  const btn = $('play-audio-btn');
  btn.textContent = playing ? '■ Stop' : '▶ Play sound';
  btn.setAttribute('aria-pressed', String(playing));
}

function playStickerAudio() {
  const audioEl = $('sticker-audio');
  if (!audioEl.src) return;
  if (!audioEl.paused) {
    audioEl.pause();
    return;
  }
  audioEl.currentTime = 0;
  audioEl.play().catch(() => setPlayButton(false));
}

$('sticker-audio').addEventListener('play', () => setPlayButton(true));
$('sticker-audio').addEventListener('pause', () => setPlayButton(false));
$('sticker-audio').addEventListener('ended', () => setPlayButton(false));

$('sticker-stage').addEventListener('click', playStickerAudio);
$('play-audio-btn').addEventListener('click', playStickerAudio);

$('tweak-btn').addEventListener('click', () => {
  show($('result-card'), false);
  show($('editor-card'), true);
});

// Delivery mode toggle
function setDeliveryMode(mode) {
  state.deliveryMode = mode;
  setPressed('[data-mode]', 'mode', mode);
  show($('relay-panel'), mode === 'relay');
  show($('self-panel'), mode === 'self');
  setError($('send-error'), '');
  show($('send-success'), false);
}

document.querySelectorAll('[data-mode]').forEach((btn) => {
  btn.addEventListener('click', () => setDeliveryMode(btn.dataset.mode));
});

// Remember phone number in localStorage
const savedPhone = localStorage.getItem('wa_phone') || '';
if (savedPhone) $('phone-input').value = savedPhone;
$('phone-input').addEventListener('input', () => {
  localStorage.setItem('wa_phone', $('phone-input').value.trim());
});

async function sendCurrentSticker(mode) {
  if (!state.currentJob) return;
  setError($('send-error'), '');
  show($('send-success'), false);

  const btn = mode === 'relay' ? $('send-relay-btn') : $('send-self-btn');
  const origText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Sending to WhatsApp…';

  try {
    const body = { mode };
    if (mode === 'relay') {
      const phone = $('phone-input').value.trim();
      if (!phone) throw new Error('Enter your phone number with country code first.');
      localStorage.setItem('wa_phone', phone);
      body.phone = phone;
    }
    const res = await api(`/api/jobs/${state.currentJob.id}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const dest = mode === 'self' ? 'your "Message yourself" chat' : `+${res.sentTo}`;
    $('send-success').textContent = `Sent to ${dest}. Next, on your phone: open that chat in WhatsApp, long-press the sticker and tap Add to favourites.`;
    show($('send-success'), true);
  } catch (err) {
    setError($('send-error'), friendlyError(err));
  } finally {
    btn.textContent = origText;
    renderConnectionStatus();
  }
}

$('send-relay-btn').addEventListener('click', () => sendCurrentSticker('relay'));
$('send-self-btn').addEventListener('click', () => sendCurrentSticker('self'));

// Download files
$('download-btn').addEventListener('click', () => {
  if (!state.currentJob) return;
  const trigger = (url, name) => {
    const a = document.createElement('a');
    a.href = `${url}?download=1`;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };
  trigger(state.currentJob.stickerUrl, 'sound-sticker.webp');
  if (state.currentJob.hasAudio && state.currentJob.audioUrl) {
    setTimeout(() => trigger(state.currentJob.audioUrl, 'sound-sticker.ogg'), 350);
  }
});

// Self pairing (QR + 8-digit code)
$('pair-qr-btn').addEventListener('click', async () => {
  show($('pair-code-form'), false);
  await startSelfPair({});
});

$('pair-code-toggle-btn').addEventListener('click', () => {
  show($('pair-code-form'), true);
  $('pair-phone-input').focus();
});

$('pair-code-btn').addEventListener('click', async () => {
  const phone = $('pair-phone-input').value.trim();
  if (!phone) {
    setError($('send-error'), 'Enter your WhatsApp phone number with country code.');
    return;
  }
  await startSelfPair({ phone });
});

async function startSelfPair({ phone }) {
  setError($('send-error'), '');
  show($('pair-output'), true);
  show($('pair-qr-img'), false);
  show($('pair-code-display'), false);
  $('pair-hint').textContent = 'Connecting to WhatsApp…';

  try {
    const res = await api('/api/pair/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(phone ? { phone } : {}),
    });
    renderPairOutput(res);
    startPairPolling();
  } catch (err) {
    setError($('send-error'), err.message);
    show($('pair-output'), false);
  }
}

function renderPairOutput(st) {
  if (st.paired) {
    stopPairPolling();
    show($('pair-output'), false);
    refreshStatus();
    return;
  }
  if (st.qr) {
    $('pair-qr-img').src = st.qr;
    show($('pair-qr-img'), true);
    show($('pair-code-display'), false);
    $('pair-hint').textContent = 'WhatsApp → Settings → Linked devices → Link a device → scan this QR.';
  } else if (st.code) {
    $('pair-code-display').textContent = st.code;
    show($('pair-code-display'), true);
    show($('pair-qr-img'), false);
    $('pair-hint').textContent = 'WhatsApp → Linked devices → Link a device → Link with phone number instead.';
  } else if (st.lastError) {
    $('pair-hint').textContent = st.lastError;
  }
}

function startPairPolling() {
  stopPairPolling();
  state.pairPollTimer = setInterval(async () => {
    try {
      const st = await api('/api/pair/status');
      renderPairOutput(st);
    } catch {}
  }, 2000);
}

function stopPairPolling() {
  if (state.pairPollTimer) {
    clearInterval(state.pairPollTimer);
    state.pairPollTimer = null;
  }
}

$('self-logout-btn').addEventListener('click', async () => {
  await api('/api/pair/logout', { method: 'POST' }).catch(() => {});
  await refreshStatus();
});

setFit(state.fit);
paintAllRanges();
updateSteps();
refreshStatus();
