# TASK — sticker image quality: stop the WebP looking blocky/patchy

Owner reported the sticker preview looks "patchy, colours fucked". Reproduced on a real clip.
Fix `makeWebp()` in `lib/sticker.js` only. Do not touch audio, EXIF, the YouTube fetch, or the UI.
**Do not restart `wa-sticker-web.service`** — the owner hands out its URL; the orchestrator restarts it.

## Root cause (measured, not guessed)

The budget is `MAX_STICKER_BYTES = 512000` but the ladder in `makeWebp()` is coarse and wasteful:
`[15,70] [15,55] [12,50] [10,45] [10,35] [8,35] [8,25] [6,30] [6,20] [5,15]` at
`-compression_level 4` with no denoise. On a 1280×720@60 6 s section of Big Buck Bunny
(`aqz-KE-bpKQ`, 66–72 s) it settles on **fps 15, q 55 = 440,476 B** — 14 % of the budget unused,
while the next rung down (q 50) and below (q 45/35/25/15) is where WebP visibly blocks and bands.
Busier clips therefore land at q ≤ 35 and look terrible at 512×512.

Same clip, same filter chain, measured on this machine (ffmpeg 9.0.2):

| variant | bytes |
|---|---|
| fps15 q55 cl4 (current) | 440,476 |
| fps15 q55 cl6 | 430,572 |
| fps15 q55 cl6 preset photo | 430,832 |
| fps15 q55 cl6 photo + `hqdn3d=2:1:3:2` | 425,830 |
| fps15 q60 + dn + cl6 + photo | 467,392 |
| fps15 q62 + dn + cl6 + photo | 500,350 ✅ fits |
| fps15 q63 … | 505,568 |
| fps15 q65 … | 514,886 ✗ over |
| fps12 q70 + dn + cl6 + photo | 498,930 ✅ |
| fps10 q75 + dn + cl6 + photo | 488,538 ✅ |

`-q:v N` and `-quality N` produce byte-identical files, so `-q:v` is correct — keep it.
A 512×512 frame decoded from the q62 file was assessed as clean (no blocking, no ringing),
the q55 file from the current pipeline as blocky/patchy.

## Required change

1. Video filter chain becomes `hqdn3d=2:1:3:2,fps=<fps>,<scale>` (denoise first, then fps, then the
   existing `scale…,format=rgba,pad…` chain). Image path keeps its current chain untouched.
2. Encoder args: `-lossless 0 -q:v <q> -compression_level 6 -preset photo -loop 0` (was cl4, no preset).
3. Replace the fixed ladder with a **budget-maximising search**:
   - For `fps` in `[15, 12, 10, 8, 6]`, binary-search `q` in `[40, 82]` for the largest integer q whose
     output is ≤ `MAX_STICKER_BYTES` (reuse the same temp file; ~7 encodes worst case per fps, stop
     as soon as a fit is found).
   - Accept the first (highest) fps whose winning q is **≥ 55**, and return immediately.
   - Otherwise continue and keep the candidate with the highest q overall (tie → higher fps).
   - If nothing fits at q 40 / 6 fps, fall back to the old aggressive rungs (`[5,30] [5,20] [4,15]`)
     before throwing `sticker_too_large`, so heavy clips still produce a sticker.
   - Never exceed 512000 B; keep returning `{ data, fps, quality }` so `/api/jobs/:id` still reports them.
4. Keep the whole thing bounded: no more than ~40 ffmpeg invocations per job, and log one line per
   accepted encode (`sticker: 512x512 fps=N q=M bytes=…`) so the numbers show up in `.run/app.log`.

## Verification (run these, paste output into NOTES.md)

- `bash scripts/smoke.sh` and `bash scripts/smoke-youtube.sh` still PASS.
- Start the app yourself on a scratch port (e.g. `PORT=18090 node server.js` — **not** the service),
  then POST a YouTube job for `aqz-KE-bpKQ` start 66 duration 6 and assert: `quality >= 58`,
  `sizes.stickerBytes <= 512000`, and bytes above the old 440,476. Print the job JSON.
- POST an image upload job (any PNG/JPG) and confirm the 2-frame still path still returns a sticker
  ≤ 500 KB with `quality` as before.
- Report the final numbers in `NOTES.md` under "Image quality".
