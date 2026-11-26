# TASK — Fit/Fill framing toggle + one restrained UI polish pass

One pass. The app is running at `~/Projects/wa-sticker-web` (Express + vanilla ES modules, no build
step, mobile-first dark UI). Read `NOTES.md` and `TASK.md` first. **Do not restart
`wa-sticker-web.service`** (its URL is handed out to people; the orchestrator restarts it) and do not
change the audio path, the EXIF writer, the WhatsApp wire format, or `lib/wa.js`.

## 1. Fit / Fill framing (the actual feature)

Today every source is aspect-fitted into 512×512 with transparent padding, so a 16:9 clip only fills
512×288 of the sticker and looks small and soft. Add a framing choice:

- `fit` (current behaviour, default): whole frame, transparent bars.
- `fill`: scale to cover the square and centre-crop — `scale=512:512:force_original_aspect_ratio=increase,crop=512:512,format=rgba`
  (video keeps `hqdn3d=2:1:3:2,fps=<fps>,` in front of it). Images use the same crop for the 2-frame still.

Wiring:
- `buildSticker({ …, fit = 'fit' })` in `lib/sticker.js`, applied to both the video path and the
  image path; anything that is not exactly `fill` means `fit`.
- `POST /api/jobs` accepts a `fit` form field on **both** sources (upload and `source=youtube`);
  validate it, pass it through, and echo it back in the job JSON (`fit: 'fit'|'fill'`).
- UI: a small segmented control "Fit / Fill" in both tabs next to the length slider, default Fit,
  remembered in `localStorage`. When the chosen source's aspect ratio is far from square
  (ratio > 1.35 or < 0.74) show a one-line hint under it: "Fill crops the edges to make a
  full-size sticker." Compute the ratio from the video/image dimensions the page already knows (for
  YouTube use the `info` payload; if unknown, just skip the hint).

## 2. UI polish — sit down and make it look designed, but stay restrained

It currently reads like a developer's form. One pass, no frameworks, no new npm packages, vanilla
CSS in `public/style.css` and the existing DOM in `public/index.html` / `public/app.js`.
**Keep every existing element id, API call and behaviour** — this is a visual/UX layer on top.

Worth doing (pick what genuinely improves it, don't gold-plate):
- Clear 3-step spine: **Source → Look → Send**, with the current step visibly marked; the page
  should read as a flow, not a pile of cards.
- Type + spacing scale: one heading size per level, consistent radii/paddings, tighter vertical
  rhythm. Sticker preview gets room; the favourites instructions collapse into a small
  "How do I keep it?" disclosure instead of a wall of text.
- Preview area: show the sticker on a subtle checkerboard (it has transparency) sized to a phone
  bubble, with the size readout as quiet metadata instead of a headline.
- Controls: proper focus-visible rings, hover/active states, disabled styling that still looks
  intentional, 44 px minimum tap targets, native-feeling range sliders, segmented controls for
  Fit/Fill and sound source.
- States: a real empty state, a progress state with the stage name, an error state that reads like
  a sentence, and a success state that tells the user the next tap on their phone.
- Mobile: everything usable at 390 px wide with no horizontal scroll; primary action reachable
  without hunting.
- Accessibility: labels tied to inputs, aria-pressed on segmented buttons, aria-live on the status
  region, visible reduced-motion-respecting transitions only.
- Keep the passcode gate and admin page consistent with the new styling (admin page is secondary —
  don't spend long on it).

## Definition of done

- `bash scripts/smoke.sh` and `bash scripts/smoke-youtube.sh` still PASS.
- On a scratch port (`PORT=18095 node server.js`, relay can stay enabled — it's already paired,
  don't send anything): POST the same job twice with `fit=fit` and `fit=fill` for
  `https://www.youtube.com/watch?v=aqz-KE-bpKQ` start 66 duration 6, and print both job JSONs plus
  the sticker byte sizes. The `fill` sticker should have no transparent letterbox bars (verify by
  decoding a frame and checking the left/right or top/bottom edge pixels are opaque — a tiny ffmpeg
  one-liner is fine).
- Check the page at 390 px and 1280 px viewport widths for layout sanity; report what you actually
  measured (e.g. `document.body.scrollWidth` equals `innerWidth`, and the primary button rect).
- Do not commit or push; leave the working tree for the orchestrator to review.
