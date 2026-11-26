# TASK — audio must match the selected length (bug: sound runs past the selection)

Owner report: *"it is playing more duration of audio than what they are choosing — a friend wanted
28.7 → 30.7 of a video and got 28.7 until the end."*

## Root cause (confirmed in the code)

`makeAudio()` in `lib/sticker.js` always cuts `-t MAX_AUDIO_SEC` (10 s) and ignores the selection.
`buildSticker()` passes only the *animation* length to `makeWebp()`, so a 2.0 s selection becomes a
2.0 s sticker with up to 10 s of audio, and `seconds` in the result is that 10 s value. The UI then
honestly reports "10s sound" next to a 2 s window — exactly what the friend heard.

## Required behaviour

Audio length must equal the user's selection, capped at 10 s:

- `makeAudio(src, start, outDir, volume, maxSeconds)` — `-t` = `min(maxSeconds, MAX_AUDIO_SEC)`.
- In `buildSticker()`, compute `audioLimit = Math.min(MAX_AUDIO_SEC, animSec)` where `animSec` is the
  selection length the job already receives, and pass it in. Same for the separately uploaded audio
  file (a 2 s selection cuts 2 s from that file too); if the source is shorter than the limit the
  output is simply shorter — that is correct, not an error.
- `seconds` returned/`audioSeconds` in the job JSON must be the real cut length, rounded to the
  nearest integer for the wire field but derived from the actual clip (already how it works — just
  make sure it reflects the new limit).
- Do not touch the video/animation path, the fit/fill logic, or the wire format. `MAX_ANIM_SEC` (6)
  and `MAX_AUDIO_SEC` (10) stay as server-side caps.

## UI copy (small)

- Wherever the result row shows the sound length, make it unambiguous that it follows the selection:
  the readout should be like `2.0s sticker · 2.0s sound` (one decimal, from the job's reported
  values) instead of a bare `6s sound`.
- In the Look section, under `Animation length`, add one quiet line: "Sound is cut to the same
  window." Nothing louder than that.

## Verification (do this, paste into NOTES.md)

1. `bash scripts/smoke.sh` and `bash scripts/smoke-youtube.sh` still PASS.
2. On a scratch port (`PORT=18097 node server.js`), run a YouTube job for
   `https://www.youtube.com/watch?v=aqz-KE-bpKQ` with `start=600`, `duration=2`, then probe the
   produced `audio.ogg`: it must be **~2.0 s** (not 10), the sticker's frame count must still match
   a 2 s animation, and the job JSON must report `audioSeconds` ≈ 2. Print `ffprobe` output.
3. Same check with `duration=6` (→ ~6 s) and with an uploaded clip of 8 s choosing 2 s.
4. Report the three audio durations.
