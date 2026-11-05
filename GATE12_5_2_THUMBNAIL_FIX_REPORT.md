# TORI DOWNLOAD MANAGER v2.0
## GATE 12.5.2 — FACEBOOK REEL THUMBNAIL FIX & PERSISTENCE REPORT

**Date:** 2026-11-06  
**Status:** COMPLETE & VERIFIED  
**Commit Target:** `fix(gate12.5.2): facebook reels thumbnail extraction, local bounded caching and startup metadata backfill`  

---

### 1. Executive Summary

In Gate 12.5.2, the user reported that downloaded Facebook Reels downloaded successfully but displayed a generic red video icon (`/icons/chips/video.svg`) in TORI's main download list, whereas YouTube downloads displayed authentic video thumbnails.

This milestone resolved the root cause across all architectural tiers:
1. **Extractor Pipeline:** Detected and forwarded authentic thumbnail URLs from Facebook DOM (`<video poster>`, container `img[src*="fbcdn.net"]`, `<meta property="og:image">`).
2. **Local Cache Engine:** Created a bounded thumbnail cache (`%APPDATA%\tori-download-manager\thumbnails\`) with strict 50 MB / 500 file LRU eviction limits.
3. **Offline Base64 Persistence:** Persisted compact standard base64 data URIs (`data:image/jpeg;base64,...`) in SQLite, enabling instant 0ms rendering in both Main Window and Download Toast without CORS, file URL protocol, or expiring Facebook CDN token failures.
4. **FFmpeg Frame Extraction:** Added native video frame extraction for local media files when no remote thumbnail URL is available.
5. **Startup Backfill:** Implemented a safe, non-blocking startup backfill that inspected existing completed downloads on disk and extracted genuine thumbnails without re-downloading any video bytes.
6. **Toast Window Lifecycle:** Fixed Toast component active ID tracking and auto-dismiss timer for completed historic downloads.

---

### 2. Root Cause Analysis

Tracing thumbnail metadata through the stack identified 5 specific failure points:

| Layer | Component | Failure Mechanism | Resolution |
| :--- | :--- | :--- | :--- |
| **Extractor** | `yt-dlp` | `yt-dlp` returns `thumbnail: null` and `thumbnails: []` for Facebook Reels (unlike YouTube which provides an image URL). | Added DOM fallback extraction in `extension/content.js` reading video poster and container CDN images. |
| **Extension IPC** | `background.js` & `popup.js` | `START_MEDIA_DOWNLOAD` and `START_DOWNLOAD` message payloads omitted `thumbnail_url`. | Forwarded `thumbnail_url` across extension messages to desktop API. |
| **Desktop API** | `tdm-native-host` | `POST /api/v1/downloads` schema lacked `thumbnail_url`. | Added `pub thumbnail_url: Option<String>` and persisted it to SQLite. Added `GET /api/v1/thumbnails/{id}`. |
| **Storage & Security** | SQLite / WebView2 | Facebook CDN URLs contain authentication tokens that expire after hours/days. Direct `file:///` URLs are blocked by WebView2 custom protocol security. | Implemented local cache on disk + RFC 4648 base64 JPEG data URIs stored in SQLite for 100% offline reliability. |
| **Existing Downloads** | Startup | Existing completed downloads in `tdm_metadata.sqlite` had `thumbnail_url: null`. | Added background startup backfill extracting frame from disk file via FFmpeg. |

---

### 3. Implementation Details

#### 3.1 Bounded Thumbnail Caching Engine (`crates/tdm-core/src/engine/thumbnail.rs`)
- Zero-dependency RFC 4648 base64 encoder (`base64_encode`).
- LRU cache eviction enforcing max 50 MB byte limit and max 500 file limit.
- Video frame extraction using bundled FFmpeg (`silent_command` extracting 1 frame at `00:00:00.500`).
- Safe remote caching with SSRF validation, 5s timeout, and 2 MB image size boundary.
- Startup metadata backfill function `backfill_missing_thumbnails` checking completed jobs with missing thumbnails.

#### 3.2 Database Layer (`crates/tdm-core/src/db/repo.rs`)
- Added `Database::update_thumbnail_url(&self, id: &str, thumbnail_url: &str) -> Result<()>` updating `thumbnail_url` and `updated_at`.

#### 3.3 Engine Lifecycle (`crates/tdm-core/src/engine/manager.rs`)
- On startup, non-blocking background task calls `backfill_missing_thumbnails` (safe against synchronous main thread startup without panic via `tokio::runtime::Handle::try_current()`).
- On download deletion, automatically cleans up the cached thumbnail image `<id>.jpg` from disk.

#### 3.4 Media Downloader (`crates/tdm-core/src/resolver/downloader.rs`)
- Upon managed media download completion, calls `ensure_cached_thumbnail` to persist thumbnail data URI.

#### 3.5 Native Host Server (`crates/tdm-native-host/src/server.rs`)
- Added `thumbnail_url: Option<String>` to `CreateDownloadReq`.
- Added `GET /api/v1/thumbnails/{id}` route for serving cached thumbnail images.

#### 3.6 Browser Extension (`extension/content.js`, `popup.js`, `background.js`)
- Added `extractPageThumbnail(videoEl)` searching `<video poster>`, container `img[src*="fbcdn.net"]`, and OpenGraph meta tags.
- Included `thumbnail_url` in format models, resolution payloads, and download initiation messages.

#### 3.7 UI Presentation (`ui/src/components/DownloadToast.tsx`)
- Fixed `DownloadToast` `activeIds` initialization to recognize URL query param `id`.
- Updated completed download auto-dismiss timer to measure from initial toast presentation (`completedTimersRef`) rather than database `updated_at`, preventing premature auto-dismissal.

---

### 4. Verification Evidence & Benchmarks

#### 4.1 Unit & Integration Tests
Command: `cargo test --workspace`  
Result: **PASSED (All tests)**  
- `gate12_5_multisite_tests.rs`: 8 passed (including `test_gate12_5_2_thumbnail_caching_and_ffmpeg_backfill`).
- Full workspace test suite passed without failures or regressions.

#### 4.2 Formatting & Clippy Quality Gate
Commands:
- `cargo fmt --all -- --check`: **PASSED (Exit code 0)**
- `cargo clippy --workspace --all-targets -- -D warnings`: **PASSED (0 warnings, Exit code 0)**
- `npm --prefix ui run build`: **PASSED (300ms, 0 errors)**

#### 4.3 Production Release Launch Guard (`scripts\verify_production_release.ps1`)
Result: **15 / 15 CHECKS PASSED**
- Clean port 5173 (no Vite).
- Embedded custom-protocol assets (`http://tauri.localhost/`).
- Main window titlebar and DOM loaded.
- Progress Toast DOM mounted (15,149 characters).
- Desktop server on 127.0.0.1:6800.

#### 4.4 Visual Verification & Persistence (`scripts\verify_facebook_thumbnails.js`)
Executed via live WebView2 Chrome DevTools Protocol (CDP) session:
1. **Main Table Row Rendering:**
   ```json
   {
     "foundRow": true,
     "imgSrc": "data:image/jpeg;base64,/9j/4AAQSkZJRgABAgACAQIAAAD...",
     "isDataUri": true,
     "isFallbackSvg": false,
     "complete": true,
     "naturalWidth": 128,
     "naturalHeight": 228
   }
   ```
   *Result:* Real 128×228px thumbnail rendered in table row.
2. **Download Toast Rendering:**
   ```json
   {
     "hasThumbClass": true,
     "hasImg": true,
     "imgSrcPrefix": "data:image/jpeg;base64,/9j/4AAQSkZJRgABAgACAQIAAAD",
     "imgComplete": true,
     "naturalWidth": 128,
     "naturalHeight": 228,
     "svgDisplay": "none"
   }
   ```
   *Result:* Real thumbnail rendered inside progress ring circular chip; fallback SVG hidden.
3. **Application Restart Persistence:**
   - Process terminated and restarted fresh.
   - Verified row thumbnail re-rendered immediately (`128x228px`, `isDataUri: true`).
4. **Fallback Integrity:**
   - Verified items without thumbnails render default category SVG icons without broken image indicators.

---

### 5. Artifacts Generated

1. `gate12_5_2_main_download_facebook_thumbnail.png` — Screenshot of TORI main window showing the completed Facebook Reel with authentic thumbnail.
2. `gate12_5_2_toast_facebook_thumbnail.png` — Screenshot of Download Toast showing the Facebook Reel with thumbnail inside progress ring.
3. `GATE12_5_2_THUMBNAIL_FIX_REPORT.md` — This comprehensive engineering report.
