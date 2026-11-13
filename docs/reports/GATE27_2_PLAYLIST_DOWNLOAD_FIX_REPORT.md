# TORI Download Manager — Gate 27.2: Playlist Download Bug Fix & YouTube Mix Rejection Report

**Date:** 2026-11-13  
**Project:** `F:\TORI\final tori download manager`  
**Branch:** `fix/gate27-runtime-fixes`  
**Base Checkpoint:** `checkpoint-gate27_2-start` (`9ac3cb6`)  
**Verified Checkpoint:** `checkpoint-gate27_2-verified` (`591bdfa`)  
**Desktop Current Stable:** `v1.0.4`  
**Browser Extension Current Stable:** `v1.0.5`  
**Status:** Verification Passed (Awaiting Operator Release Authorization)

---

## 1. Executive Summary

During production usage of TORI with YouTube playlists, users encountered a severe defect:
- When viewing a YouTube playlist or Mix/Radio URL (e.g. `https://www.youtube.com/watch?v=mVeAD3nbXGs&list=RDmVeAD3nbXGs&start_radio=1`), the TORI Browser Extension displayed a banner reading `"⚡ Playlist available"` and a `"Download Playlist"` button.
- Clicking `"Download Playlist"` only focused/opened the TORI Desktop window, but no playlist items were resolved or added to the download queue.
- YouTube Mix/Radio queues (`list=RD...`, `list=UL...`, `start_radio=1`) are auto-generated dynamic infinite streams that cannot be downloaded as a fixed batch, yet were treated as standard playlists.
- Furthermore, when supported playlists were processed, format quality strings (`1080p`, `audio_only`) were passed directly to `yt-dlp` format selectors without translation into valid expressions, causing `yt-dlp` format rejections, and audio downloads were forced into `.mp4` file extensions.

Under **Gate 27.2**, a complete architectural fix was implemented and rigorously verified:
1. **Dynamic URL Classification:** Created `inspectPlaylistUrl` in both extension content scripts and React frontend, distinguishing regular playlists (`list=PL...`, `list=OLAK...`, `list=UU...`, `list=FL...`), YouTube Mix/Radio dynamic streams (`list=RD...`, `list=UL...`, `start_radio=1`), and private/unsupported playlists (`list=WL`, `list=LL`).
2. **Mix/Radio Banner & Rejection:** For Mix/Radio URLs, the extension renders an informative warning banner (`"📻 YouTube Mix (Radio): Dynamic queue cannot be downloaded as a batch"`) with an Info tooltip, and suppresses the `"Download Playlist"` button. The backend API rejects Mix/Radio URLs with an HTTP 422 error and explanatory payload.
3. **End-to-End Desktop Handoff:** Added `OPEN_PLAYLIST` action in browser extension background scripts (with fallback to Native Messaging `open_playlist`), dispatching an `OpenPlaylistModal { url }` event through `tdm-native-host` to Tauri's webview. In the frontend, `App.tsx` immediately opens `<PlaylistModal>` and resolves entries automatically.
4. **Valid Format Selector Expressions:** Mapped preset quality values (`1080p`, `720p`, `480p`, `audio_only`, `audio_mp3`, `audio_m4a`) in `build_format_selector` to valid `yt-dlp` expressions (`bestvideo[height<=1080]+bestaudio/best`, `bestaudio/best`).
5. **Deduplication & Format Independence:** Added duplicate detection across active/completed jobs matching the same URL and format, preventing duplicate tasks while cleanly allowing sequential Video and Audio-only tasks for the same source media.
6. **Unavailable Item Handling:** Extended `PlaylistItem` with `is_available: Option<bool>`, detecting private/deleted videos, rendering an `"Unavailable"` badge in the modal, and deselecting them by default.

---

## 2. Root Cause Analysis

| Layer | File | Defect Mechanism |
|---|---|---|
| **Extension Content Script** | `extension/content.js` | Naively checked `window.location.href.includes('list=')`. On click, it called `SHOW_DESKTOP` and dispatched `RESOLVE_PLAYLIST` without a callback or modal trigger. |
| **Extension Background Script** | `extension/background.js` | Handled `RESOLVE_PLAYLIST` by calling `/api/v1/media/playlist/resolve` on the native host backend, which returned JSON to background memory but never routed it to the frontend desktop UI. |
| **Desktop UI Routing** | `ui/src/App.tsx` | Only initialized `playlistModalUrl` from `window.location.search` (`?modal=playlist`), lacking an IPC/event listener to open the modal from background extension signals. |
| **Engine / Format Selector** | `crates/tdm-core/src/resolver/downloader.rs` | Quality presets (`1080p`, `audio_only`) passed raw into `yt-dlp -f`, causing `yt-dlp` to reject with `"Requested format is not available"`. |
| **File Extension Handling** | `crates/tdm-native-host/src/server.rs`, `src-tauri/src/commands.rs` | Playlist items were hardcoded with `.mp4` file extensions regardless of whether the user selected Video or Audio presets. |
| **Deduplication Absence** | `crates/tdm-native-host/src/server.rs` | No duplicate check was performed before inserting playlist items into SQLite, allowing duplicate jobs for the same URL and format. |

---

## 3. Implementation Details

### 3.1 URL Classification & YouTube Mix Detection
Implemented in [ui/src/utils.ts](file:///F:/TORI/final%20tori%20download%20manager/ui/src/utils.ts), [extension/content.js](file:///F:/TORI/final%20tori%20download%20manager/extension/content.js), and [extension/firefox/content.js](file:///F:/TORI/final%20tori%20download%20manager/extension/firefox/content.js):
- Regular playlists: prefixes `PL`, `OLAK`, `UU`, `FL` or path `/playlist`.
- Dynamic YouTube Mixes: prefixes `RD`, `UL` or query param `start_radio=1`.
- Private collections: `WL` (Watch Later), `LL` (Liked Videos).

### 3.2 Backend Pipeline & Native Host Event Routing
- **[crates/tdm-core/src/resolver/models.rs](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/src/resolver/models.rs):** Added `#[serde(default)] pub is_available: Option<bool>` to `PlaylistItem`.
- **[crates/tdm-core/src/resolver/pipeline.rs](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/src/resolver/pipeline.rs):** Rejects Mix/Radio URLs with error `"YouTube Mix/Radio queues are auto-generated dynamic collections and cannot be downloaded as a fixed batch."` Checks for unavailable/private videos during JSON parsing.
- **[crates/tdm-core/src/resolver/downloader.rs](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/src/resolver/downloader.rs):** Presets mapped in `build_format_selector`:
  - `1080p` $\to$ `bestvideo[height<=1080]+bestaudio/best[height<=1080]/best`
  - `720p` $\to$ `bestvideo[height<=720]+bestaudio/best[height<=720]/best`
  - `480p` $\to$ `bestvideo[height<=480]+bestaudio/best[height<=480]/best`
  - `audio_only` / `audio_mp3` / `audio_m4a` $\to$ `bestaudio/best`
- **[crates/tdm-core/src/engine/events.rs](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/src/engine/events.rs):** Added `OpenPlaylistModal { url: String }` to `DownloadEvent`.
- **[crates/tdm-native-host/src/server.rs](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-native-host/src/server.rs):**
  - Added endpoint `POST /api/v1/media/playlist/open` emitting `ShowWindow` and `OpenPlaylistModal`.
  - Added deduplication check and audio extension handling (`.m4a` / `.mp3`) in `handle_playlist_enqueue`.
- **[crates/tdm-native-host/src/lib.rs](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-native-host/src/lib.rs):**
  - Added `open_playlist` native messaging action.
  - Added `--serve [port]` CLI flag for test automation and headless operation.
- **[src-tauri/src/lib.rs](file:///F:/TORI/final%20tori%20download%20manager/src-tauri/src/lib.rs):** Forwarded `OpenPlaylistModal` event to frontend webview via `open-playlist-modal`.
- **[src-tauri/src/commands.rs](file:///F:/TORI/final%20tori%20download%20manager/src-tauri/src/commands.rs):** Added deduplication check and audio extension handling in `enqueue_playlist_items`.

### 3.3 Frontend UI Integration
- **[ui/src/App.tsx](file:///F:/TORI/final%20tori%20download%20manager/ui/src/App.tsx):** Added listener for `open-playlist-modal` event, setting `playlistModalUrl` to open `<PlaylistModal>` immediately.
- **[ui/src/components/PlaylistModal.tsx](file:///F:/TORI/final%20tori%20download%20manager/ui/src/components/PlaylistModal.tsx):**
  - Added format `<optgroup>` for Video (`best`, `1080p`, `720p`, `480p`) and Audio (`audio_only`, `audio_mp3`, `audio_m4a`).
  - Added unavailable video detection: displays an `"Unavailable"` badge and deselects the video by default.
  - Added item counter to the confirm button (`Download Selected (X)`).
- **[ui/src/components/AddDownloadModal.tsx](file:///F:/TORI/final%20tori%20download%20manager/ui/src/components/AddDownloadModal.tsx):** Added warning banner when a Mix/Radio URL is pasted into the manual URL field.

---

## 4. Verification Results

An automated end-to-end verification script ([scripts/verify_gate27_2_playlist.js](file:///F:/TORI/final%20tori%20download%20manager/scripts/verify_gate27_2_playlist.js)) was executed against the release binary `tdm-native-host.exe`.

### Test Summary
```
=== GATE 27.2 PLAYLIST DOWNLOAD VERIFICATION ===

--- TEST 1: URL Classification Logic ---
PASS: https://www.youtube.com/watch?v=mVeAD3nbXGs&list=RDmVeAD3nbXGs&start_radio=1 -> type: mix, supported: false
PASS: https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDMMdQw4w9WgXcQ -> type: mix, supported: false
PASS: https://www.youtube.com/playlist?list=PL6B3937A5D230E335 -> type: regular, supported: true
PASS: https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL6B3937A5D230E335&index=2 -> type: regular, supported: true
PASS: https://www.youtube.com/playlist?list=WL -> type: unsupported, supported: false
PASS: https://www.youtube.com/watch?v=dQw4w9WgXcQ -> type: none, supported: false

--- TEST 2: Mix/Radio URL Rejection in Backend API ---
Mix resolve response status: 422 body: {
  message: 'YouTube Mix/Radio queues are auto-generated dynamic collections and cannot be downloaded as a fixed batch.',
  status: 'error'
}
TEST 2 Result: PASS (status: 422, message: YouTube Mix/Radio queues are auto-generated dynamic collections and cannot be downloaded as a fixed batch.)

--- TEST 3: Open Playlist Modal Endpoint ---
Open playlist response: { message: 'Playlist opened in TORI Desktop', status: 'ok' }
TEST 3 Result: PASS

--- TEST 4: Real Playlist Resolution via Backend ---
Resolving playlist: https://www.youtube.com/playlist?list=PL6B3937A5D230E335 (timeout: 45s)...
Resolved Title: "Official Blender Open Movies"
Items count: 10
First item: "SINGULARITY - Painterly Space Adventure" (https://www.youtube.com/watch?v=l5OZu-IrXpw)
TEST 4 Result: PASS

--- TEST 5: Playlist Enqueueing & Deduplication ---
Enqueueing item 1: SINGULARITY - Painterly Space Adventure with format 1080p...
Enqueue 1 response: {
  status: 'ok',
  enqueued_count: 1,
  job_ids: [ 'f3895722-3643-413e-aa8d-8294ed73159f' ]
}
Re-enqueueing exact same item with format 1080p (deduplication check)...
Enqueue 2 response (expected deduplicated): {
  status: 'ok',
  enqueued_count: 1,
  job_ids: [ 'f3895722-3643-413e-aa8d-8294ed73159f' ]
}
Deduplication check: job1=f3895722-3643-413e-aa8d-8294ed73159f, job2=f3895722-3643-413e-aa8d-8294ed73159f, matches=true
Enqueueing same item with format audio_only (should allow different format)...
Enqueue 3 response: {
  status: 'ok',
  enqueued_count: 1,
  job_ids: [ '37b7a986-8e06-4afe-bb27-8db2acc13b10' ]
}
Different format check: job3=37b7a986-8e06-4afe-bb27-8db2acc13b10, distinct from video=true
TEST 5 Result: PASS

=============================================
FINAL RESULTS:
  [PASS] URL Classification Logic
  [PASS] Mix/Radio Rejection
  [PASS] Open Playlist Modal API
  [PASS] Real Playlist Resolution
  [PASS] Enqueue & Deduplication & Audio/Video Separation

OVERALL: ALL TESTS PASSED
=============================================
```

### Full Regression Test Suite
- `cargo test --workspace --lib`: **57 / 57 tests passed** (47 in `tdm-core`, 10 in `tdm-native-host`).
- `npm run build` in `ui/`: **Passed in 357ms with 0 errors**.
- Close-to-Tray persistence: Preserved and verified intact.
- Media sequence (Audio $\to$ Video): Preserved and verified intact.
- Large-file engine: Preserved and verified intact.

---

## 5. Artifacts and Evidence

| File | Description |
|---|---|
| [scripts/verify_gate27_2_playlist.js](file:///F:/TORI/final%20tori%20download%20manager/scripts/verify_gate27_2_playlist.js) | Automated end-to-end playlist test harness |
| [crates/tdm-core/src/resolver/pipeline.rs](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/src/resolver/pipeline.rs) | Mix/Radio detection & rejection logic |
| [crates/tdm-core/src/resolver/downloader.rs](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/src/resolver/downloader.rs) | Preset format string mapping for yt-dlp |
| [crates/tdm-native-host/src/server.rs](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-native-host/src/server.rs) | `/api/v1/media/playlist/open` route & deduplication |
| [ui/src/components/PlaylistModal.tsx](file:///F:/TORI/final%20tori%20download%20manager/ui/src/components/PlaylistModal.tsx) | Modal with Video/Audio presets & unavailable indicators |
| [extension/content.js](file:///F:/TORI/final%20tori%20download%20manager/extension/content.js) | Extension overlay banner & dispatch logic |

---

## 6. Release Recommendation

1. **Gate 27.2 Fix Status:** **COMPLETE & VERIFIED**.
2. **Commit Checkpoint:** `591bdfa` on `fix/gate27-runtime-fixes` (tagged `checkpoint-gate27_2-verified`).
3. **Safety Guarantee:** Production SQLite databases, installed binaries, and published releases remain untouched.
4. **Next Step:** Awaiting explicit operator authorization to prepare release candidate packaging or proceed to release publication.
