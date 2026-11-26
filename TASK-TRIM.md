# TASK — rebuild the YouTube preview as a real trim editor (and fix the overflow)

Two complaints from the owner, both real:

1. **The YouTube preview bursts out of the card.** In their screenshot the thumbnail card
   (left) and the 16:9 embed (right) are side by side, and the embed renders far wider than its
   column, overlapping the thumbnail and spilling past the card's right edge. Reproduce, measure,
   and make it structurally impossible.
2. **Trimming is guesswork.** You cannot scrub, you cannot see the frame you are choosing, and
   ±5s is the only control. Every online trimmer lets you drag a selection window over a timeline
   and watch the frame move under it. Build that.

Scope: `public/index.html`, `public/style.css`, `public/app.js` (+ only what is needed elsewhere).
No npm dependencies. Keep every existing element id that `app.js`/server rely on, keep the job
payload identical (`source`, `youtubeUrl`, `start`, `duration`, `fit`, `mute`, `audioVolume`), do not
restart `wa-sticker-web.service`, do not commit.

## A. Kill the overflow

- Replace the two-up `.yt-preview-grid` (thumbnail card | embed) with **one full-width player
  panel**: the 16:9 player on top, a compact meta line under it (title · uploader · duration).
  No side-by-side grid, no second thumbnail.
- The panel is `width:100%`, `max-width:100%`, `aspect-ratio:16/9`, `overflow:hidden`, and the
  `iframe`/`video` inside is `position:absolute; inset:0; width:100%; height:100%`. Nothing inside
  may exceed the card.
- Prove it: at 360, 390, 768 and 1280 px wide, assert every descendant of the source card has
  `rect.right <= card.rect.right + 1` and `document.body.scrollWidth <= innerWidth`, and paste the
  measured numbers in `NOTES.md`. (Headless Chromium here kills the tab when a real YouTube iframe
  loads — block `*youtube.com/embed*` and `*ytimg.com*` with `Network.setBlockedURLs` while
  measuring geometry; the boxes are still laid out.)

## B. A trim editor that shows you the frame

Use the **YouTube IFrame Player API** (`https://www.youtube.com/iframe_api`, `playerVars`:
`playsinline:1, controls:0, modestbranding:1, rel:0, disablekb:1, origin=<location.origin>`), loaded
lazily only on the YouTube tab. Fall back gracefully: if the API fails to load in ~8 s, keep the
plain embed (current behaviour) and the timeline still works by reloading the embed with `?start=`.

Layout, top to bottom, inside the panel:

1. **Player** with our own controls — never YouTube's chrome:
   - big centre play/pause button over the poster/first frame,
   - bottom bar: play/pause, `0:34.2 / 7:34`, and a **full-width timeline** for the whole video.
2. **Timeline** (the important part):
   - Track spans the full duration; the selected window is a green band `[start, start+length]`
     with the rest dimmed.
   - Drag the band to move it, drag either edge to resize (length clamped 1.0–6.0 s, snapped to
     0.1 s), click elsewhere on the track to jump the playhead there.
   - While dragging, the player **seeks and pauses on that frame** — you literally see the frame
     you are picking. Releasing leaves the playhead there.
   - A thin playhead line shows the current position; it updates during playback.
   - Show the frame time under the band (`0:34.2 → 0:40.2`) and keep the existing readout element.
3. **Controls row** under the timeline:
   - `Set start here` (takes the playhead position as the band start),
   - `Preview selection` toggle: seeks to band start, plays, and pauses itself at band end, looping
     if the toggle stays on,
   - nudge buttons ±1s and ±5s (band start), keyboard ←/→ = 0.1 s and Shift+←/→ = 1 s when the
     editor has focus.
4. Keep the existing `#yt-start-input` text field working (it stays the source of truth for the
   value; the timeline writes into it) so the job payload and any existing handler logic survive.

## C. Same treatment for uploaded videos

The upload tab already has a `<video>` preview and a start slider. Bring it to the same model:
a timeline with a draggable selection band over the full clip, seek-and-pause while dragging,
`Set start here`, and a `Preview selection` loop. Reuse one component for both (a `<video>`-backed
adapter and a YouTube-IFrame-backed adapter); do not fork the code.

## D. Honest failure states

- If `/api/yt/info` reports the video as unavailable, say so plainly: "YouTube won't serve this
  video to our server — it may be region-locked, age-restricted or a live stream." (The owner hit
  this with `jkYTx3IeSfc`.)
- If the player errors (embedding disabled), show the meta + timeline anyway and note that playback
  preview is unavailable, so trimming still works from the numbers.

## Definition of done

- Both smoke scripts pass.
- Geometry assertions from A pass and are logged in `NOTES.md`.
- Drive it in a headless browser: fetch `jNQXAC9IVRw`, drag the band to ~0:03, press Build, and
  confirm the job payload used `start≈3`, `duration` = band length. Report the values you saw.
- Mobile-first: thumb-sized controls, no horizontal scroll at 360 px, the editor usable one-handed.
