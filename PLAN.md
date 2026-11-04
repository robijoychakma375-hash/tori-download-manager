# Plan — Gate 10.5.3.2: Fix Missing Media Selection Popup

## Milestone Objective
Restore full reliability, visibility, and interaction of the floating Media Selection Popup (`.tori-pn`) across desktop and browser extension:
1. Fix root cause of missing popup / premature "Unavailable" pill tag:
   - Eliminate false navigation events triggered by video playback/buffering (`durationchange`, `loadedmetadata`, `loadstart`) on unchanged media IDs.
   - Canonicalize media identity URLs to strip tracking and timestamp parameters (`&t=`, `&ab_channel=`, `#`), making video identity strictly dependent on `videoId`.
   - Prevent `RESOLVE_MEDIA` responses from being dropped as stale due to spurious generation bumps.
   - Ensure the pill displays "Media" or "Resolving…" on initial load, never flashing "Unavailable" in red prematurely.
2. Restore Floating Media Selection Popup:
   - Ensure clicking `.tori-pill` opens the floating panel (`.tori-pn.on`) with Video and Audio Only tabs.
   - Proactively resolve media on supported platforms (YouTube, Facebook, Instagram, Vimeo) and immediately populate genuine resolutions, codecs, and sizes.
   - Show clean "Resolving media formats…" spinner if opened while resolving.
   - Show descriptive error notice with "Retry resolution" button if resolution fails; never allow the popup to disappear merely because resolution is pending.
   - Synchronously render the panel DOM upon creation so no blank or zero-sized frames occur.
3. Protect UI Interaction & Prevent Clipping:
   - Anchor `.tori-mp` to the player container (`videoEl.closest('.html5-video-player') || ...`) with `z-index: 2147483640` to guarantee visibility above all YouTube chrome overlays.
   - Stop click propagation on pill and panel to prevent YouTube player pause/resume interception.
   - Fit panel within player bounds and support clean scrolling (`.tori-fl`) without clipping.
4. Correct Automated Verification Assertions:
   - Closed panel: 0 visible panels (`.tori-pn.on`) is valid; 1 overlay container (`.tori-mp`).
   - Open panel: exactly 1 visible media selection panel (`.tori-pn.on`).
   - Duplicate overlay regression: more than 1 visible panel or overlay fails test.
   - Panel positioning: within player container bounds and accessible at standard 100% zoom and 125% DPI zoom.
   - Formats check: genuine video resolutions (e.g. 1080p, 720p), audio-only tab, codecs, and sizes.
   - Dynamic video switching: client-side SPA navigation from Video A to Video B updates title and formats without reload.
   - Screenshots: capture expanded media popup (`design/edge_media_popup_expanded.png`).
5. Quality Gates & Deliverables:
   - Complete `scripts/verify_gate10_5_3_2.js` automation against real Microsoft Edge via CDP.
   - Run `cargo fmt`, `cargo clippy`, `cargo test`, `npm run build`, `node -c`.
   - Produce `GATE10_5_3_2_MEDIA_POPUP_FIX_REPORT.md` and commit cleanly to git.
