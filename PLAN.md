# TORI Download Manager — Gate 12.8 Execution Plan
## Fix Browser Media Detection, Iframe Support, and Resolver Timeouts

### Milestone Objective
Deliver a verified, production-quality fix for Gate 12.8:
1. Fix missing overlays on embedded players and sites like `zetmoon.live` via `all_frames`, `match_origin_as_fallback`, Shadow DOM traversal, and dynamic dimension observation (`ResizeObserver`/`loadedmetadata`).
2. Resolve the 35-second resolution timeout on generic streaming sites like `fprime.at` and `flaxjoy.app` by fast-failing unsupported webpage URLs, reducing generic timeouts, prioritizing intercepted network streams (`.m3u8`, `.mpd`, `.mp4`), and preventing UI spinner lockup.
3. Ensure every media resolution request reaches a clean, explicit terminal state (`Formats Available`, `No Downloadable Media`, `Unsupported Extractor`, `Access Restricted`, `Protected Media`, `Network Error`, `Resolution Timed Out`).
4. Implement sanitized diagnostic tracing across extension content, background service worker, and desktop resolver.
5. Create an automated test suite `scripts/verify_gate12_8.js` and Rust tests verifying iframe detection, timeout fast-fail, terminal states, and regression protection for YouTube, Facebook Reels, and playlists.

---

### Phase 1: Manifest & Content Script Frame and Shadow DOM Detection
- In `extension/manifest.json`:
  - Enable `"all_frames": true` and `"match_origin_as_fallback": true` for `content_scripts`.
- In `extension/content.js`:
  - Implement `getAllVideos(root = document)` to recursively discover `<video>` elements inside open `shadowRoot` trees.
  - Implement dynamic dimension observation for videos starting at 0x0: attach `ResizeObserver` and `loadedmetadata`/`playing` listeners so the overlay attaches as soon as the video is rendered.
  - In child frames (`window !== window.top`):
    - Skip tiny/ad iframes (dimensions < 200×150).
    - Scope overlay cleanly inside the frame player container.
    - Prevent duplicate overlays.

---

### Phase 2: Resolver Fast-Fail & Error Taxonomy
- In `crates/tdm-core/src/resolver/extractor.rs`:
  - Fast-fail when `yt-dlp` returns `ERROR: Unsupported URL`: return `EngineError::Other("No supported media extractor found for this webpage URL.")` immediately without delay.
  - Differentiate timeouts for known video platforms (30s) vs generic webpage URLs (10s) to avoid 30s hangs on unsupported sites.
  - Ensure process kill on drop and graceful cancellation.
- In `crates/tdm-core/src/resolver/pipeline.rs`:
  - Identify known platform domains (`youtube.com`, `facebook.com`, `instagram.com`, `tiktok.com`, `twitter.com`, `x.com`, `vimeo.com`, `dailymotion.com`, `reddit.com`, `twitch.tv`, `soundcloud.com`).
  - For non-platform URLs, apply the tighter 10s extraction timeout.
  - Map errors to structured terminal error categories (`unsupported_extractor`, `protected_media`, `access_restricted`, `network_error`, `timed_out`, `no_downloadable_media`).
- In `crates/tdm-native-host/src/server.rs`:
  - Return structured error responses with `error_category` and sanitized diagnostic metadata.

---

### Phase 3: Stream Interception & Fallback Prioritization
- In `extension/background.js`:
  - When `RESOLVE_MEDIA` is called for a generic site:
    - Check if tab already has captured stream candidates (`.m3u8`, `.mpd`, `.mp4`).
    - If captured stream exists, resolve the direct stream manifest/URL instead of the generic HTML page!
    - Apply bounded 12s timeout for generic sites instead of 35s.
  - Implement sanitized diagnostic logging: Request ID, Page URL (origin + pathname only, no credentials/tokens), detection method, timestamps, extractor outcome, error category.
- In `extension/content.js`:
  - Display captured tab media streams immediately if available; do not lock the panel in `isResolving` spinner when candidates already exist.
  - If resolution fails with `Unsupported Extractor` or `No Downloadable Media`, and tab media has captured streams, present those captured streams cleanly.
  - Enforce bounded 12s timeout for generic page resolution.

---

### Phase 4: Terminal Error States & Popup Integration
- In `extension/content.js` and `extension/popup/popup.js`:
  - Guarantee terminal UI state for every request:
    - `Formats Available`
    - `No Downloadable Media`
    - `Unsupported Extractor`
    - `Access Restricted`
    - `Protected Media`
    - `Network Error`
    - `Resolution Timed Out`
  - Invalidate in-flight promises on page navigation / URL changes.
  - Preserve exact approved visual design of the popup and overlay cards.

---

### Phase 5: Verification & Acceptance Tests
- Add unit/integration tests in `crates/tdm-core/tests/gate12_8_resolver_tests.rs`:
  - Fast-fail on unsupported webpage URLs (< 1s).
  - Timeout enforcement on non-platform URLs (bounded 10s).
  - Direct media probe (.mp4, .m3u8) regression tests.
  - Error categorization tests.
- Create automated script `scripts/verify_gate12_8.js`:
  - Test HTML5 video with Shadow DOM.
  - Test iframe player injection and overlay attachment.
  - Test direct HLS stream resolution.
  - Test generic site resolution fast-fail (returns in < 2s without 35s hang).
  - Verify YouTube and Facebook Reels compatibility.
- Build and verify:
  - `cargo fmt --all -- --check`
  - `cargo clippy --workspace --all-targets -- -D warnings`
  - `cargo test --workspace`
  - `npm --prefix ui run build`
  - Production release check: `powershell -ExecutionPolicy Bypass -File scripts\verify_production_release.ps1`
- Generate `GATE12_8_EXTENSION_MEDIA_COMPATIBILITY_REPORT.md`.
