# TASK — small follow-up: fix the send-screen semantics (copy + two confusing controls)

Scope is deliberately tiny. Only touch copy and the marked controls; no redesign, no new files,
no layout rework, don't touch the backend, don't restart the systemd service, don't commit.

A design review of the live page flagged exactly these:

1. **Delivery chooser is the weakest thing on the screen.** "Server relay" / "Pair my own" mean
   nothing to a friend. Rename and explain with plain words, keeping the same element ids and the
   same two modes:
   - relay → something like **"Send from this server"** with a sub-line: *"Arrives from our own
     WhatsApp number — nothing to set up."*
   - self → **"Use my own WhatsApp"** with a sub-line: *"Link your number once by scanning a code;
     the sticker lands in your own chat."*
   - Rewrite the lead-in paragraph (“Sound only survives when a linked WhatsApp client sends it…")
     into one human sentence: WhatsApp only plays sticker sound when a phone/WhatsApp sends it, so
     pick a sender.
   - Make the selected state clearly visible, and when the phone field is shown, its label must say
     what it's for ("Your number — includes the country code") and the placeholder should show one
     format only.
2. **Duplicate/ambiguous play control.** The sticker preview has a "Tap to play" overlay pill *and*
   a separate "Play sound" button. Keep one clear control: a single play/pause button outside the
   artwork that reflects state (Play sound / Stop), and remove the overlay text from the artwork.
3. **Jargon in the preview metadata.** "499 KB of 500 KB · Fill · 6s sound · 57 KB" → human and
   ordered: e.g. `6s · 499 KB` and, only when Fill is active, a quiet `cropped to square` chip.
   Drop the near-limit number anxiety.
4. "Tweak & rebuild" → "Adjust sticker" (same id/handler).
5. Make the footer line less stranded: keep it, but stop it being invisible dead space — a single
   quiet line right under the card is fine.

Verify: both smoke scripts still pass, `document.querySelectorAll('[id]')` count unchanged or
greater, no horizontal scroll at 390 px, and the send buttons still carry their original ids so the
existing handlers work. Report the id list you checked.
