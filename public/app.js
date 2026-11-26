const $ = (id) => document.getElementById(id);

const state = {
  status: null,
  sourceTab: 'upload', // upload | youtube
  mediaFile: null,
  mediaIsVideo: false,
  mediaDuration: 0,
  mediaObjectUrl: null,
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
    embedTimer: null,
    lastEmbedStart: null,
  },
};

function show(el, visible) {
  el.classList.toggle('hidden', !visible);
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

async function api(url, opts = {}) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!res.ok || data.ok === false) {
    const err = new Error(data.error || `Request failed (${res.status})`);
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
  setError($('build-error'), '');

  const isVideo = file.type.startsWith('video/') || /\.(mp4|mov|m4v|webm|mkv|avi|3gp)$/i.test(file.name);
  state.mediaIsVideo = isVideo;

  show(dropzone, false);
  show($('tune-panel'), true);
  show($('result-card'), false);
  $('file-name').textContent = `${file.name} (${(file.size / (1024 * 1024)).toFixed(1)} MB)`;

  const vid = $('video-preview');
  const img = $('image-preview');

  if (isVideo) {
    show(img, false);
    show(vid, true);
    show($('video-controls'), true);
    vid.src = state.mediaObjectUrl;
    vid.onloadedmetadata = () => {
      const dur = Number.isFinite(vid.duration) ? vid.duration : 0;
      state.mediaDuration = dur;
      updateStartSliderBounds();
    };
    setSoundMode('video');
  } else {
    show(vid, false);
    vid.removeAttribute('src');
    show($('video-controls'), false);
    show(img, true);
    img.src = state.mediaObjectUrl;
    // Images/GIFs have no audio track — default to upload audio so user gets a hint right away
    setSoundMode('upload');
  }
}

function updateStartSliderBounds() {
  const len = Number($('duration-slider').value) || 6;
  const maxStart = Math.max(0, Number((state.mediaDuration - Math.min(len, state.mediaDuration)).toFixed(1)));
  const slider = $('start-slider');
  slider.max = String(maxStart);
  if (Number(slider.value) > maxStart) slider.value = String(maxStart);
  $('start-val').textContent = `${Number(slider.value).toFixed(1)}s`;
}

$('start-slider').addEventListener('input', () => {
  const val = Number($('start-slider').value) || 0;
  $('start-val').textContent = `${val.toFixed(1)}s`;
  const vid = $('video-preview');
  if (state.mediaIsVideo && vid.readyState >= 1) {
    vid.currentTime = val;
  }
});

$('duration-slider').addEventListener('input', () => {
  const val = Number($('duration-slider').value) || 6;
  $('duration-val').textContent = `${val.toFixed(1)}s`;
  updateStartSliderBounds();
});

$('volume-slider').addEventListener('input', () => {
  const v = Number($('volume-slider').value) || 1;
  $('volume-val').textContent = `${Math.round(v * 100)}%`;
});

// Sound mode segmented control
function setSoundMode(mode) {
  state.soundMode = mode;
  document.querySelectorAll('[data-sound]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.sound === mode);
  });
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
  fd.append('start', $('start-slider').value || '0');
  fd.append('duration', $('duration-slider').value || '6');
  fd.append('mute', state.soundMode === 'mute' ? 'true' : 'false');
  fd.append('audioVolume', $('volume-slider').value || '1');

  show($('editor-card'), false);
  show($('result-card'), false);
  show($('progress-card'), true);
  $('progress-title').textContent = 'Uploading…';
  $('progress-sub').textContent = '512×512 animated WebP (≤500 KB) + Opus audio';

  try {
    const created = await api('/api/jobs', { method: 'POST', body: fd });
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
      setError($('build-error'), err.message);
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
  const s = Math.max(0, Number(sec) || 0);
  const whole = Math.floor(s);
  const frac = Math.round((s - whole) * 10);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const rem = whole % 60;
  const pad2 = (n) => String(n).padStart(2, '0');
  const base = h > 0 ? `${h}:${pad2(m)}:${pad2(rem)}` : `${m}:${pad2(rem)}`;
  return frac > 0 && frac < 10 ? `${base}.${frac}` : base;
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

function getYtMaxStart() {
  const dur = state.yt.info?.duration || 0;
  const len = Number($('yt-duration-slider').value) || 6;
  return Math.max(0, Number((dur - Math.min(len, dur)).toFixed(1)));
}

function updateYtRangeReadout() {
  const start = state.yt.startSec;
  const len = Number($('yt-duration-slider').value) || 6;
  const dur = state.yt.info?.duration || 0;
  const end = Math.min(dur || start + len, start + len);
  $('yt-range-val').textContent = `${formatTimestamp(start)} – ${formatTimestamp(end)}`;
}

function scheduleYtEmbedUpdate(immediate = false) {
  if (!state.yt.info?.id) return;
  const floorStart = Math.floor(state.yt.startSec);
  if (state.yt.embedTimer) {
    clearTimeout(state.yt.embedTimer);
    state.yt.embedTimer = null;
  }
  const apply = () => {
    if (!state.yt.info?.id) return;
    if (state.yt.lastEmbedStart === floorStart && $('yt-embed').src) return;
    state.yt.lastEmbedStart = floorStart;
    $('yt-embed').src = `https://www.youtube.com/embed/${encodeURIComponent(state.yt.info.id)}?start=${floorStart}`;
  };
  if (immediate) {
    apply();
  } else {
    state.yt.embedTimer = setTimeout(apply, 450);
  }
}

function setYtStart(sec, { updateInput = true, immediateEmbed = false } = {}) {
  const maxStart = getYtMaxStart();
  const clamped = Math.max(0, Math.min(maxStart, Number.isFinite(sec) ? sec : 0));
  state.yt.startSec = Number(clamped.toFixed(1));
  if (updateInput) {
    $('yt-start-input').value = formatTimestamp(state.yt.startSec);
  }
  updateYtRangeReadout();
  scheduleYtEmbedUpdate(immediateEmbed);
}

function setYtSoundMode(mode) {
  state.yt.soundMode = mode;
  document.querySelectorAll('[data-yt-sound]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.ytSound === mode);
  });
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
  $('yt-duration-val').textContent = `${val.toFixed(1)}s`;
  setYtStart(state.yt.startSec, { updateInput: true, immediateEmbed: false });
});

$('yt-start-input').addEventListener('input', () => {
  const parsed = parseTimestamp($('yt-start-input').value);
  if (Number.isFinite(parsed)) {
    setYtStart(parsed, { updateInput: false, immediateEmbed: false });
  }
});

$('yt-start-input').addEventListener('blur', () => {
  const parsed = parseTimestamp($('yt-start-input').value);
  setYtStart(Number.isFinite(parsed) ? parsed : state.yt.startSec, { updateInput: true, immediateEmbed: false });
});

$('yt-start-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    $('yt-start-input').blur();
  }
});

$('yt-nudge-back').addEventListener('click', () => {
  setYtStart(state.yt.startSec - 5, { updateInput: true, immediateEmbed: false });
});

$('yt-nudge-fwd').addEventListener('click', () => {
  setYtStart(state.yt.startSec + 5, { updateInput: true, immediateEmbed: false });
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
    state.yt.lastEmbedStart = null;

    $('yt-thumb').src = info.thumbnail || '';
    $('yt-title').textContent = info.title || 'Untitled video';
    $('yt-uploader').textContent = info.uploader || 'YouTube';
    $('yt-duration').textContent = formatTimestamp(info.duration);

    const maxLen = Math.min(6, Math.max(1, Math.floor(info.duration * 2) / 2 || 6));
    const durSlider = $('yt-duration-slider');
    durSlider.max = String(maxLen);
    if (Number(durSlider.value) > maxLen) durSlider.value = String(maxLen);
    $('yt-duration-val').textContent = `${Number(durSlider.value).toFixed(1)}s`;

    show($('yt-loaded'), true);
    show($('result-card'), false);
    setYtStart(0, { updateInput: true, immediateEmbed: true });
    setYtSoundMode('video');
  } catch (err) {
    show($('yt-loaded'), false);
    state.yt.info = null;
    setError($('yt-error'), err.message);
  } finally {
    btn.textContent = 'Fetch';
    renderYouTubeAvailability();
  }
});

$('yt-build-btn').addEventListener('click', async () => {
  if (!state.yt.info) return;
  setError($('yt-build-error'), '');

  // Normalize start input in case user clicked Build without blurring
  const parsedStart = parseTimestamp($('yt-start-input').value);
  setYtStart(Number.isFinite(parsedStart) ? parsedStart : state.yt.startSec, { updateInput: true, immediateEmbed: false });

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
  if (state.yt.soundMode === 'upload' && state.yt.audioFile) {
    fd.append('audio', state.yt.audioFile);
  }

  show($('editor-card'), false);
  show($('result-card'), false);
  show($('progress-card'), true);
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
      setError($('yt-build-error'), err.message);
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
      $('progress-title').textContent = `Fetching clip…${range}`;
      $('progress-sub').textContent = ctx.videoTitle || job.videoTitle || 'Downloading trimmed section from YouTube';
    } else {
      $('progress-title').textContent = 'Encoding sticker…';
      $('progress-sub').textContent = '512×512 animated WebP (≤500 KB) + Opus audio';
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
  $('meta-size').textContent = `Sticker: ${kb} KB / 500 KB`;

  const audioEl = $('sticker-audio');
  if (job.hasAudio && job.audioUrl) {
    audioEl.src = `${job.audioUrl}${bust}`;
    $('meta-audio').textContent = `Audio: ${job.audioSeconds}s (${(job.sizes.audioBytes / 1024).toFixed(0)} KB)`;
    show($('play-audio-btn'), true);
    show($('sticker-sound-badge'), true);
  } else {
    audioEl.removeAttribute('src');
    $('meta-audio').textContent = 'Silent sticker';
    show($('play-audio-btn'), false);
    show($('sticker-sound-badge'), false);
  }
}

function playStickerAudio() {
  const audioEl = $('sticker-audio');
  if (!audioEl.src) return;
  audioEl.currentTime = 0;
  audioEl.play().catch(() => {});
}

$('sticker-stage').addEventListener('click', playStickerAudio);
$('play-audio-btn').addEventListener('click', playStickerAudio);

$('tweak-btn').addEventListener('click', () => {
  show($('result-card'), false);
  show($('editor-card'), true);
});

// Delivery mode toggle
function setDeliveryMode(mode) {
  state.deliveryMode = mode;
  document.querySelectorAll('[data-mode]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
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
    $('send-success').textContent = `Sent to ${dest}! Open WhatsApp on your phone and long-press to favourite.`;
    show($('send-success'), true);
  } catch (err) {
    setError($('send-error'), err.message);
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

refreshStatus();
