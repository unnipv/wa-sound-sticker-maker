# TASK — trim affordances + one real bug (small, surgical)

Follow-up on the trim editor that just shipped. Only these four things; no redesign, no new files,
no backend changes, no service restart, no commit.

1. **Selection handles must be obviously draggable.** Today they are small dark pills that read like
   dividers. Make each handle ~14 px wide × 40 px tall (visual), with 24 px of invisible padding
   around it so a finger can grab it, drawn as a light rounded bar with two grip dots, and give the
   band a "6.0s" chip so the length is readable without doing arithmetic.
2. **Dim outside the selection.** The `.tl-dim` elements exist but read as plain dark track.
   Overlay the unselected stretches with a translucent black (~45 %) so the green window is the
   obvious subject of the control, and keep the track's own background visible through it.
3. **Make the playhead unmistakable** — a 2 px white line with a small triangular cap, above the
   handles in z-order, and let it be dragged too (dragging the playhead moves the head, not the
   band).
4. **Fix a real error-handling bug.** If the YouTube IFrame API is blocked or fails to load
   (test: block `*youtube.com/iframe_api*`, `*youtube.com/embed*`, `*ytimg.com*`), pressing Fetch
   surfaces the *network* message "Couldn't reach the server. Check your connection and try again."
   A `TypeError` thrown anywhere in the player setup lands in `friendlyError()` and is misreported.
   Fix properly: player/setup failures must be caught where they happen (log + fall back to the
   plain-embed adapter), and the "couldn't reach the server" copy must only appear for a genuine
   failed request to our own API — introduce a distinct error type for that in the API helper
   instead of matching `instanceof TypeError` globally.

Verify: both smoke scripts pass; with the YouTube hosts blocked, Fetch still renders the meta +
timeline (fallback adapter) and the error copy shown is accurate; handles measure ≥ 24 px hit area
via `getBoundingClientRect` on the padded element; at 360 px there is still no horizontal scroll and
no element crosses its card boundary. Report the numbers.
