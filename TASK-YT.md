# TASK — add "YouTube link" as an input source (paste URL + pick a timestamp)

The web app is built and running. Read `TASK.md` and `NOTES.md` first for the existing shape;
do not change the upload path. This task adds one more source: a YouTube URL, trimmed by
timestamp in our own UI.

## Verified environment facts (do not re-litigate)

- `yt-dlp` lives at `~/.local/bin/yt-dlp` (2026.11.23) and `deno` at `~/.local/bin/deno`
  (needed by yt-dlp for YouTube's JS challenges). `/usr/sbin/yt-dlp` is old — prefer
  `process.env.YTDLP_BIN`, then `yt-dlp` on PATH with `~/.local/bin` prepended.
- **IPv6 is broken on this host.** Every yt-dlp call MUST pass `--force-ipv4`, otherwise it
  hangs after "Downloading webpage" (verified: same command with `--force-ipv4` succeeds).
- Working extraction command (verified, 8 s section from a real video):
  ```
  yt-dlp --force-ipv4 --no-playlist --no-progress --newline \
    -f "bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[height<=720]/b" \
    --download-sections "*START-END" --force-keyframes-at-cuts \
    -o "<jobdir>/source.%(ext)s" "https://www.youtube.com/watch?v=<id>"
  ```
  Result was a section-trimmed h264+aac mp4 whose ffprobe duration was exactly the requested
  span. `yt-dlp -J --force-ipv4 --no-playlist <url>` gives `title`, `duration`, `thumbnail`,
  `id`, `uploader`, `is_live`.
- Metadata fetch on this host takes a few seconds; the download of a ≤11 s section is ~1–3 s.

## Backend

1. New `lib/youtube.js`:
   - `parseYouTubeUrl(url)` → `{id}` for `youtube.com/watch?v=`, `youtu.be/`, `/shorts/`,
     `/live/`, `m.youtube.com`, `music.youtube.com`; reject anything else with
     `errorCode: 'not_a_youtube_url'` (this is also the SSRF guard — never fetch arbitrary hosts).
   - `getInfo(url)` → normalized `{id, title, duration, thumbnail, uploader, isLive}`;
     in-memory cache ~5 min keyed by id. Reject `isLive` and `duration > 3 h` with clear codes.
   - `downloadSection({url, jobDir, start, span})` → runs the command above with
     `--download-sections "*start-start+span"`, `span = min(11, ...)` (audio needs ≤10 s,
     animation ≤6 s; 11 s gives a safety tail), `--max-filesize 80M`, a hard 180 s timeout
     (`AbortController`/`child_process` kill), returns the produced file path.
     Stream stderr into a ring buffer so failures can be reported as a trimmed, human line
     (e.g. "This video is age-restricted" / "Sign in to confirm you're not a bot").
   - `ytdlpAvailable()` → boolean + version, surfaced in `/api/status` as `youtube: {available}`.
2. `POST /api/yt/info` `{url}` → `{ok, id, title, duration, thumbnail, uploader}`.
   Passcode-gated like the rest.
3. `POST /api/jobs` gains a second shape: `source=youtube` + `youtubeUrl`, `start` (seconds,
   may be fractional), `duration` (1–6), `mute`, `audioVolume`. Same job/queue/TTL machinery:
   the job downloads the section to `data/jobs/<id>/source.mp4`, then runs the **existing**
   sticker pipeline on that file with `start = 0` (the section is already trimmed) — do not
   re-trim inside the pipeline, and keep `audio`/`start` semantics identical for the upload path.
   `GET /api/jobs/:id` should report `stage: 'fetching'|'encoding'` so the UI can say what it is
   doing, and `sourceUrl`/`videoTitle` for the preview card.
4. Errors must carry machine codes that the UI renders: `not_a_youtube_url`, `video_unavailable`,
   `video_too_long`, `live_not_supported`, `yt_dlp_missing`, `download_failed`, `no_audio_track`.
5. `.env.example` + `.env`: `YTDLP_BIN` (optional), and mention `--force-ipv4` in `NOTES.md`.

## Frontend

- Add a two-tab source picker at the top of the upload card: **Upload a file** | **YouTube link**
  (keep the existing drag/drop exactly as it is under tab 1).
- YouTube tab: URL field + "Fetch" button → on success show the thumbnail, title, uploader,
  duration, and enable the trim controls; on failure show the server's message inline (no alert()).
- Trim UI: a start-time field that accepts `mm:ss`, `h:mm:ss` or plain seconds (normalize on blur),
  −5s / +5s nudge buttons, "use current time" is not possible — skip it; clamp to
  `duration - length`. Length slider 1–6 s. Sound source choice (from video / upload audio /
  no sound) and volume, same as the upload path.
- Small embedded player for checking the timestamp: `<iframe src="https://www.youtube.com/embed/<id>?start=<start>" ...>`
  rendered next to the thumbnail; it must not autoplay and must not block the rest of the UI.
  Rebuild the `src` when the start time changes (debounced) so the user can eyeball the cut point.
- While a YouTube job runs, show "Fetching clip…" with the section range, then the normal
  encoding state. Everything after the job is created is shared with the upload path.
- Keep it mobile-first: tabs are thumb sized, the URL field is `type=url` + `inputmode=url`,
  and the whole flow still fits one screen scroll.

## Definition of done

- `bash scripts/smoke.sh` still passes (upload path untouched).
- New `scripts/smoke-youtube.sh`: uses `https://www.youtube.com/watch?v=jNQXAC9IVRw` (verified
  reachable here), start 2 s, length 6 s, posts through the real API, polls the job, then prints
  sticker bytes / audio seconds and asserts the sticker is ≤500 KB. Run it and paste the output
  into `NOTES.md` under a "YouTube source" heading.
- Also run through the browser yourself: fetch info for that URL, set start `0:03`, build, and
  confirm the preview renders. Report the numbers you saw in `NOTES.md`.
- No new npm dependency if `yt-dlp` + ffmpeg already cover it. No tests, no CI.
- Leave `data/`, `.env`, `node_modules` out of git.
