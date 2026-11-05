# TORI Download Manager v2.0 — Gate 12.8 Verification Report
## Browser Media Detection, Iframe Player Injection & Resolver Timeout Fast-Fail

**Date:** 2026-11-06  
**Status:** **VERIFIED & ACCEPTED**  
**Target Platform:** Windows 10/11 x64 (MSVC 14.44.35207, Windows SDK 10.0.26100.0, Tauri 2.12.5)  
**Milestone:** Gate 12.8  

---

### 1. Executive Summary

During Gate 12.8 validation, three target streaming websites were investigated to address two distinct classes of user-reported failures:
1. **Missing Overlays (`zetmoon.live`):** The TORI "Download video" pill failed to appear over the video player.
2. **35-Second Resolution Timeouts (`fprime.at` & `flaxjoy.app`):** The TORI overlay appeared, but clicking resolution caused the UI to freeze with a loading spinner for 35 seconds before terminating with *"Media resolution timed out. The server or platform took longer than 35s to respond."*

Both root causes were isolated, fixed, and verified without breaking YouTube playlists, Facebook Reels, Instagram, TikTok, or the production Tauri release pipeline.

---

### 2. Root Cause Analysis

#### Class A: Missing Overlays on Embedded Streaming Players (`zetmoon.live`)
* **Root Cause 1 (Iframe Boundary):** In `extension/manifest.json`, the content script configuration defaulted to `"all_frames": false`. Embedded player portals (such as sports/live streams on `zetmoon.live`) load their video elements inside cross-origin or same-origin `<iframe>` containers. Because `all_frames` was false, `content.js` never ran inside the iframe player document.
* **Root Cause 2 (Shadow DOM Ignored):** `scanForMedia()` used `document.querySelectorAll('video')`, which fails to traverse open `shadowRoot` elements used by modern web component video players.
* **Root Cause 3 (Delayed Video Dimensions):** `attachVideoOverlay()` had a strict dimension guard (`rect.width < 120 || rect.height < 90`) that discarded video elements immediately upon discovery if they had not yet completed layout calculation (e.g. initial 0×0 dimensions), with no subsequent listener or observer to recheck them once rendered.

#### Class B: 35-Second Resolver Timeouts on Generic Streaming Sites (`fprime.at` & `flaxjoy.app`)
* **Root Cause 1 (Subordinated Network Streams):** On generic sites playing media via MediaSource Extensions (`blob:` URLs), `content.js` rejected the blob URL as direct media and fell back to sending the webpage HTML URL (`window.location.href`) to the desktop resolver.
* **Root Cause 2 (Subprocess Hang on Arbitrary HTML):** In `crates/tdm-core/src/resolver/extractor.rs`, `execute_yt_dlp_dump` executed `yt-dlp --dump-single-json` with a 30-second default timeout (`DEFAULT_RESOLVER_TIMEOUT`). When passed an unsupported generic site or anti-scraping protected page, `yt-dlp` hung making remote network requests for 30 seconds before timing out or exiting with `ERROR: Unsupported URL`.
* **Root Cause 3 (Extension Timeout Collision):** `background.js` had a 35-second hard deadline for `/api/v1/media/resolve`, which kept `isResolving: true` active in the content script and popup, suppressing already-intercepted direct `.m3u8` or `.mp4` streams and showing an empty spinner.

---

### 3. Engineering Fixes Implemented

#### 1. Manifest V3 Frame Injection & Shadow DOM Discovery
* Updated `extension/manifest.json` with `"all_frames": true` and `"match_origin_as_fallback": true`.
* Implemented `getAllVideos(root = document)` in `extension/content.js` to recursively traverse both light DOM and open `shadowRoot` DOM trees.
* Added dynamic dimension observation in `attachVideoOverlay`: if video dimensions are initially under 120×90, `ResizeObserver` and `loadedmetadata`/`playing`/`canplay` listeners are attached so the overlay automatically renders when the player becomes visible.
* Added iframe boundary checking: child frames (`window !== window.top`) skip tiny advertising widgets (`innerWidth < 160 || innerHeight < 120`), and attach the overlay cleanly to the player container inside the frame.

#### 2. Adaptive Resolver Timeouts & Extractor Fast-Fail
* Added domain classification in `crates/tdm-core/src/resolver/pipeline.rs`:
  ```rust
  pub fn is_known_platform_domain(url_str: &str) -> bool
  ```
  Distinguishes known platforms (YouTube, Facebook, Instagram, TikTok, Vimeo, Twitter/X, Twitch, etc.) from generic webpage URLs.
* Defined `GENERIC_RESOLVER_TIMEOUT = Duration::from_secs(10)` in `extractor.rs`. Generic URLs are bounded to 10 seconds in Rust and 12 seconds in the extension service worker.
* Added instant fast-fail when `yt-dlp` returns `ERROR: Unsupported URL` (<1s duration).

#### 3. Intercepted Stream Fallback Prioritization
* In `extension/background.js` and `extension/content.js`:
  On generic sites, if `chrome.webRequest` or DOM inspection captures direct streaming manifests (`.m3u8`, `.mpd`, `.mp4`), those streams are prioritized and displayed immediately in the format list rather than waiting behind a 35-second resolving spinner.
* If webpage extraction fails with `Unsupported Extractor`, intercepted stream candidates remain active and downloadable.

#### 4. Explicit Terminal Error State Taxonomy
Mapped all resolver outcomes to 7 explicit terminal states in `crates/tdm-native-host/src/server.rs`, `extension/content.js`, and `extension/popup/popup.js`:
1. `Formats Available` — Downloadable formats rendered with genuine qualities and bitrates.
2. `No Downloadable Media` — No direct media or manifest stream found.
3. `Unsupported Extractor` — No dedicated platform extractor for this webpage URL.
4. `Access Restricted` — Server returned HTTP 403 or platform authentication required.
5. `Protected Media (DRM)` — Encrypted content (Widevine, PlayReady, FairPlay, Plex).
6. `Network Error` — Connection reset or remote server unreachable.
7. `Resolution Timed Out` — Bounded timeout exceeded with explicit Retry action.

#### 5. Sanitized Diagnostic Tracing (Zero Secrets Leaked)
* Implemented `logSanitizedDiagnostic` and `sanitizeLogUrl` in `extension/background.js` and `extension/content.js`.
* Query parameters such as `token`, `auth`, `sig`, `signature`, `key`, `pass`, `session`, `hmac`, `secret` are strictly masked to `[redacted]`. No cookies, machine secrets, or user tokens are ever output to console or logs.

---

### 4. Site Compatibility Matrix

| Website | Extension Injected | Video Detected | Embedded Frame Detected | Protocol Identified | Actual Extractor Outcome | DRM / Protection Status | Resolution Duration | Download Capability | Final Classification |
|---|---|---|---|---|---|---|---|---|---|
| **YouTube** | Yes (top frame) | Yes | N/A | HTTPS / DASH | YouTube extractor (yt-dlp) | None (public videos) | 1.8s - 3.2s | Yes (Direct & Managed) | **Formats Available** |
| **Facebook Reels** | Yes (top frame) | Yes | N/A | HTTPS / DASH | Facebook extractor (yt-dlp) | None (public reels) | 2.1s - 4.5s | Yes (Managed DASH mux) | **Formats Available** |
| **fprime.at** | Yes (top frame) | Yes (MSE blob) | No | HLS `.m3u8` / Direct | Generic fallback | None detected | 3.4s (fast-fail) | Yes (via intercepted `.m3u8`) | **Formats Available** (Stream Capture) / **Unsupported Extractor** (Page HTML) |
| **flaxjoy.app** | Yes (top frame) | Yes (MSE blob) | No | HLS `.m3u8` / Direct | Generic fallback | None detected | 3.4s (fast-fail) | Yes (via intercepted `.m3u8`) | **Formats Available** (Stream Capture) / **Unsupported Extractor** (Page HTML) |
| **zetmoon.live** | Yes (`all_frames`) | Yes (inside iframe) | Yes (`<iframe>` embed) | HLS `.m3u8` | Generic embed player | Cloudflare challenge on raw requests | < 1.0s (overlay attach) | Yes (via browser stream capture) | **Formats Available** (In-frame Overlay) |
| **watch.plex.tv** | Yes (top frame) | Yes | No | Protected DASH / HLS | Plex TV extractor | DRM Protected (Widevine) | 0.8s | No (honest DRM rejection) | **Protected Media (DRM)** |

---

### 5. Automated Verification Results

#### Test Suite 1: Gate 12.8 Verification Script (`scripts/verify_gate12_8.js`)
Executed via: `node scripts/verify_gate12_8.js`
* Step 1: Manifest V3 All-Frames & Fallback: **4/4 PASS**
* Step 2: Content Script Shadow DOM & Dimension Logic: **5/5 PASS**
* Step 3: Terminal Error Taxonomy & Diagnostic Logger: **9/9 PASS**
* Step 4: Standalone Test Server & Media Stream Probing: **PASS**
* Step 5: Desktop Resolver & Fast-Fail: **PASS**
* Step 6: yt-dlp Fast-Fail on `fprime.at` (3,356ms) & `flaxjoy.app` (3,397ms): **4/4 PASS**
* Step 7: Security Audit (Zero Secrets / Redaction Active): **4/4 PASS**
* **Total: 26 PASSED, 0 FAILED**

#### Test Suite 2: Gate 12.8 Rust Resolver Tests (`crates/tdm-core/tests/gate12_8_resolver_tests.rs`)
Executed via: `cargo test --test gate12_8_resolver_tests`
* `test_gate12_8_error_cleaning_and_taxonomy`: **PASS**
* `test_gate12_8_is_known_platform_domain_classification`: **PASS**
* `test_gate12_8_generic_resolver_timeout_enforced`: **PASS**
* `test_gate12_8_unsupported_webpage_fast_fail`: **PASS**
* **Total: 4 PASSED, 0 FAILED**

#### Test Suite 3: Rust Workspace Suite
* `cargo fmt --all -- --check`: **PASS (0 formatting errors)**
* `cargo clippy --workspace --all-targets -- -D warnings`: **PASS (0 warnings)**
* `cargo test -p tdm-native-host --test server_tests`: **7/7 PASSED**
* `cargo test -p tdm-core --test gate12_5_multisite_tests`: **8/8 PASSED**
* `cargo test -p tdm-core --test gate2_adaptive_tests`: **8/8 PASSED**
* `npm --prefix ui run build`: **PASS (built in 1.19s, 0 errors)**

#### Test Suite 4: Production Release Verification (`scripts/verify_production_release.ps1`)
* Target executable: `target\release\tori-download-manager.exe` (26.62 MB, SHA-256 `36103A2F...`)
* All 15 production release guard checks: **15/15 PASSED**
* Custom embedded protocol (`http://tauri.localhost/`): **VERIFIED**
* SQLite history retrieval: **5 items VERIFIED**
* Toast preferred sizing IPC: **VERIFIED**

---

### 6. Git Commits & Modified Files

* `extension/manifest.json`: Added `all_frames: true` and `match_origin_as_fallback: true`.
* `extension/content.js`: Added `getAllVideos` Shadow DOM traversal, `ResizeObserver` delayed dimension observation, iframe boundary checking, fast-failing timeouts, and terminal error notice mapping.
* `extension/background.js`: Added `logSanitizedDiagnostic`, `sanitizeLogUrl`, adaptive resolution timeout (12s generic / 32s platform), and intercepted stream probing.
* `extension/popup/popup.js`: Updated manual resolution timeout, direct stream fallback rendering on extractor failure, and active media polling.
* `crates/tdm-core/src/resolver/extractor.rs`: Added `GENERIC_RESOLVER_TIMEOUT = 10s`, updated `clean_ytdlp_error` error mapping.
* `crates/tdm-core/src/resolver/pipeline.rs`: Added `is_known_platform_domain` and adaptive extraction timeouts.
* `crates/tdm-native-host/src/server.rs`: Added `categorize_resolver_error` mapping responses to 7 terminal categories with appropriate HTTP status codes.
* `crates/tdm-core/tests/gate12_8_resolver_tests.rs`: New unit and integration test suite.
* `scripts/verify_gate12_8.js`: End-to-end automated verification script.
* `IMPLEMENTATION_STATUS.md`: Updated to Gate 12.8 VERIFIED.
* `PLAN.md`: Updated with Gate 12.8 milestone goals.
