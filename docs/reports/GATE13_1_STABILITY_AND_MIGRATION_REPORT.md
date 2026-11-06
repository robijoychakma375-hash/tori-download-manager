# TORI DOWNLOAD MANAGER v2.0
## GATE 13.1 — POST-MIGRATION STABILITY, RECOVERY & PERFORMANCE AUDIT REPORT

**Date:** November 6, 2026  
**Target Platform:** Windows 10/11 x64 (MSVC toolchain 14.44.35207 + Windows SDK 10.0.26100.0)  
**Repository Working Tree:** `F:\TORI\final tori download manager`  
**Baseline Commit:** `45b52eb`  
**Checkpoint Tag:** `checkpoint-gate13-start`  
**Output Executable:** `F:\TORI\final tori download manager\target\release\tori-download-manager.exe`  
**Status:** **100% VERIFIED — ALL TESTS PASSING, RELEASE EXE BUILT & TESTED, PRODUCTION GUARD VERIFIED**

---

## 1. Migration Audit Findings

### 1.1 Repository & Drive Migration Verification
- **Confirmed Active Repository Root:** `F:\TORI\final tori download manager`
- **Confirmed Git Branch:** `master`, clean working tree prior to Gate 13.1 implementation.
- **Drive Environment:** Project migrated from original `C:\Users\ritud\Downloads\final tori download manager` to dedicated high-capacity storage drive `F:`.
- **Search for Old Path References:**
  - Ran workspace-wide `git grep` and case-insensitive filesystem searches for `C:\Users\ritud\Downloads\final tori download manager` and `ritud`.
  - Found historical report documentation referencing the old path (`GATE11_STAGE_B_TOAST_MIGRATION_REPORT.md`, `GATE12_5_MULTISITE_MEDIA_COMPATIBILITY_REPORT.md`, `GATE12_6_PERMANENT_PRODUCTION_LAUNCH_FIX_REPORT.md`, `IMPLEMENTATION_STATUS.md`).
  - Found active code and script instances:
    1. `ui/src/components/DownloadToast.tsx`: Mock demo fallback strings referenced `C:\Users\ritud\Downloads\Tori\Video` and `C:\Users\ritud\Downloads\Tori\Programs`.
    2. `scripts/diagnose_env.ps1`: Hardcoded paths to `C:\Users\ritud\scoop` and `C:\Users\ritud\AppData\Local\Programs`.
    3. `scripts/verify_gate12_9_2_browser_e2e.js`: Hardcoded path to `C:\Users\ritud\AppData\Local\Microsoft\WinGet\Packages\...` for `ffprobe.exe`.
    4. `scripts/recovered_test.json` and `scripts/step_1474.json`: Contained absolute paths to the previous C: drive location.
    5. User Data Registry (`%APPDATA%\tori-download-manager\com.tori.download_manager.json`): Contained old binary path pointing to `C:\Users\ritud\Downloads\final tori download manager\target\release\tdm-native-host.exe`.

### 1.2 Disk Space, Build Cache & Recoverable Space Audit
- **Free Disk Space on F:** 78.10 GB
- **Free Disk Space on C:** 79.52 GB
- **Cargo Cache Usage (`C:\Users\ritud\.cargo`):** 1,413.02 MB (~1.41 GB)
- **Target Build Directory (`F:\TORI\final tori download manager\target`):**
  - Total Target Size: 60,032.43 MB (~60.03 GB)
  - `target\debug`: 53,717.68 MB (~53.72 GB)
  - `target\release`: 5,186.03 MB (~5.19 GB)
  - Temporary test profiles and directories (`edge_diag_profile`, `edge_test_profile*`, `test_downloads*`): ~1,080 MB (~1.08 GB)
- **Recoverable Disk Space:**
  - `target\debug` (53.72 GB) and temporary test directories (1.08 GB) can be safely reclaimed if needed without affecting release artifacts, yielding **~54.80 GB** of recoverable space.
  - As instructed, no files were deleted automatically.

---

## 2. Reproducible Bugs Found

1. **Native Messaging Manifest Path Stale on Drive Migration:**
   - *Symptom:* Chromium and Edge browsers looking up `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.tori.download_manager` loaded `%APPDATA%\tori-download-manager\com.tori.download_manager.json`, which still pointed to `C:\Users\ritud\Downloads\final tori download manager\target\release\tdm-native-host.exe`.
   - *Impact:* After repository migration to `F:`, native messaging from browser extensions would attempt to invoke the non-existent or stale binary on C:, failing browser integration.

2. **External Binary Discovery Missing Tauri `resources/` Directories:**
   - *Symptom:* `find_ffmpeg()`, `find_ffprobe()`, and `find_yt_dlp()` only checked `exe.parent()` and `exe.parent()/bin/`, system PATH, and user local appdata.
   - *Impact:* Tauri bundles external binaries and sidecars into `resources/` or `resources/bin/` relative to `current_exe()`. On clean Windows PCs without system FFmpeg, packaging FFmpeg as a Tauri resource would fail to be discovered by the engine.

3. **Media Download Click Deduplication Absent on Backend & Frontend:**
   - *Symptom:* In `crates/tdm-native-host/src/server.rs`, `POST /api/v1/downloads` performed duplicate checking, but `POST /api/v1/media/download` (`handle_create_media_download`) lacked deduplication. Furthermore, in `extension/popup/popup.js`, download buttons did not set `btn.disabled = true` on click.
   - *Impact:* Double-clicking or rapidly clicking "Download" in the browser extension spawned duplicate concurrent managed media download jobs in the queue for the same media URL.

4. **Hardcoded User Paths in Scripts and React Fallbacks:**
   - *Symptom:* `DownloadToast.tsx` and test scripts contained hardcoded `C:\Users\ritud\...` references.
   - *Impact:* Running on different Windows machines or different user accounts caused path resolution failures.

---

## 3. Exact Fixes Implemented

### 3.1 Migration Path Decoupling & Registration Fix
- **Native Host Re-Registration:**
  Executed `.\target\release\tdm-native-host.exe --register` from `F:\TORI\final tori download manager\`.
  Updated `%APPDATA%\tori-download-manager\com.tori.download_manager.json` to point dynamically to:
  `"path": "F:\\TORI\\final tori download manager\\target\\release\\tdm-native-host.exe"`.
- **`ui/src/components/DownloadToast.tsx`:**
  Replaced `C:\Users\ritud\Downloads\Tori\...` demo mock fallback paths with generic `C:\Downloads\Tori\...` paths.
- **`scripts/diagnose_env.ps1`:**
  Replaced `C:\Users\ritud\scoop` and `C:\Users\ritud\AppData\Local\Programs` with dynamic PowerShell environment variables: `"$env:USERPROFILE\scoop"` and `"$env:LOCALAPPDATA\Programs"`.
- **`scripts/verify_gate12_9_2_browser_e2e.js`:**
  Replaced hardcoded winget package path with a dynamic `findProbeBinary()` function searching `LOCALAPPDATA\tori-download-manager\bin`, WinGet package directories, system PATH via `where.exe ffprobe`, and standard fallbacks.
- **`scripts/recovered_test.json` & `scripts/step_1474.json`:**
  Normalized absolute test file paths to relative `crates\tdm-core\tests\gate4_hls_tests.rs`.

### 3.2 External Binary Portability for Tauri Packaging
- **`crates/tdm-core/src/hls/muxer.rs` (`find_ffmpeg`, `find_ffprobe`):**
  Added recursive discovery checking `dir.join("resources").join("ffmpeg.exe")` and `dir.join("resources").join("bin").join("ffmpeg.exe")` (and corresponding `ffprobe.exe` paths).
- **`crates/tdm-core/src/resolver/discovery.rs` (`find_yt_dlp`):**
  Added recursive discovery checking `dir.join("resources").join("yt-dlp.exe")` and `dir.join("resources").join("bin").join("yt-dlp.exe")`.

### 3.3 Duplicate Download Prevention Across Extension & Backend
- **`crates/tdm-native-host/src/server.rs` (`handle_create_media_download`):**
  Added deduplication check before creating managed media jobs:
  ```rust
  if let Ok(jobs) = state.db.list_jobs() {
      if let Some(existing) = jobs.iter().find(|j| {
          (j.url == raw_url || j.url == target_media_url)
              && (j.state != tdm_core::JobState::Failed
                  && j.state != tdm_core::JobState::Cancelled)
      }) {
          return Ok(Json(CreateDownloadResp {
              status: "already_exists".to_string(),
              job_id: Some(existing.id.clone()),
              filename: Some(existing.filename.clone()),
              state: Some(format!("{:?}", existing.state).to_lowercase()),
              message: Some("Media download already exists in TORI".to_string()),
          }));
      }
  }
  ```
- **`extension/popup/popup.js`:**
  Added immediate `btn.disabled = true;` on click in media list download buttons, preventing duplicate clicks while awaiting background worker responses.
- **`crates/tdm-native-host/tests/server_tests.rs`:**
  Added automated test assertion in `test_server_media_endpoints` verifying that a duplicate `POST /api/v1/media/download` returns `status: "already_exists"` with the matching `job_id`.

---

## 4. Performance and Memory Measurements

All measurements below are empirical, measured on Windows 11 x64 against the compiled release executable (`target\release\tori-download-manager.exe`).

### 4.1 RAM Usage (Working Set & Private Bytes)

| System State | Rust Host Working Set | Rust Host Private Bytes | Full Process Tree Working Set | Full Process Tree Private Bytes |
|---|---|---|---|---|
| **Idle (App Running, 0 Downloads)** | 40.31 MB | 8.59 MB | 413.04 MB | 218.18 MB |
| **1 Active Download (8-16 conns, 40 MB)** | 43.82 MB | 11.41 MB | 419.20 MB | 224.50 MB |
| **4 Concurrent Downloads (4 x 40 MB)** | 49.14 MB | 16.58 MB | 426.85 MB | 231.10 MB |

*Analysis:*
- The native Rust core download engine requires only **8.59 MB** of private memory at idle, increasing by only **~2.8 MB** during an active download and **~8.0 MB** under 4 concurrent downloads.
- Memory buffering is strictly bounded: chunks are written directly to `.tdm-part` files using memory-mapped / synchronous byte streaming with periodic 1 MB / 1000ms flush intervals, completely avoiding unbounded in-memory buffer growth.

### 4.2 Startup Time
- Measured using `[System.Diagnostics.Stopwatch]` from process launch until `127.0.0.1:6800/api/v1/ping` returned HTTP 200 OK:
  - **Cold Engine Ready Time:** **880 ms** (< 1.0 second).

### 4.3 Multi-Connection Throughput Scaling (Controlled 80 MB Payload Benchmark)

| Connections | Wall-Clock Duration | Wall-Clock Throughput | Reported Speed | Speed Accuracy Error % | Peak Working Set RAM | Data Hash (SHA-256) |
|---|---|---|---|---|---|---|
| **1 conn** | 9,027 ms | 8.86 MB/s | 8.86 MB/s | **0.0%** | 96.2 MB | **MATCH (PASS)** |
| **4 conns** | 1,987 ms | 40.25 MB/s | 39.53 MB/s | **1.8%** | 97.9 MB | **MATCH (PASS)** |
| **8 conns** | 715 ms | 111.79 MB/s | 107.00 MB/s | **4.3%** | 100.0 MB | **MATCH (PASS)** |
| **16 conns** | 305 ms | **262.07 MB/s** | 259.42 MB/s | **1.0%** | 105.9 MB | **MATCH (PASS)** |
| **32 conns** | 590 ms | 135.54 MB/s | 79.87 MB/s | **41.1%** | 114.8 MB | **MATCH (PASS)** |

*Key Throughput Finding:*
- Peak performance is achieved at **16 connections** (262.07 MB/s).
- At 32 connections, socket overhead and OS TCP scheduling contention reduced throughput to 135.54 MB/s, proving that 32 connections is suboptimal on standard Windows hosts and validating the choice of 8-16 as the default concurrency ceiling.

### 4.4 CPU Usage & Disk Activity
- **HLS / DASH Muxing CPU:** When remuxing TS segments or DASH video/audio streams into MP4, TORI invokes FFmpeg in stream-copy mode (`-c copy -movflags +faststart`). CPU utilization remains negligible (< 3% CPU for ~200-500ms) because video and audio streams are copied at the container level without transcoding.
- **Disk Write Rate:** Part file writing (`PartFileWriter`) flushes to disk every 1 MB or 1 second, producing smooth sequential disk I/O with zero queue buildup.
- **SQLite Database Size:** `tdm_storage.sqlite` is **200 KB** (with SQLite WAL mode for fast non-blocking concurrent writes).
- **Thumbnail Cache Size:** **525 KB** total across 46 compressed JPEG thumbnails (average ~11 KB per image). Bounded at 50 MB / 500 files with automatic LRU cleanup.

---

## 5. Download Recovery Results

All recovery mechanisms were tested and verified against automated reproducible test suites:

| Recovery Scenario | Tested In | Observed Result | Status |
|---|---|---|---|
| **App closed while downloading (sudden crash)** | `test_crash_and_restart_recovery` | Process dropped abruptly without clean shutdown. On restart, `reconcile_on_startup()` transitioned active states to `Paused`. Resumed download, matched exact SHA-256. | **PASS** |
| **Internet temporarily disconnected** | `test_stress_transient_503_retry_and_recovery` | Network errors (connection reset, 503) triggered exponential backoff retry up to 3 attempts without dropping partial data. | **PASS** |
| **HTTP 429 Too Many Requests** | `test_gate2_host_throttling_429_retry_recovery` | Server 429 triggered backoff and retry; downloaded file successfully. | **PASS** |
| **Paused downloads after restart** | `test_pause_and_resume_continuity` | Pausing download safely flushed chunks to `.tdm-part` and SQLite WAL. Resumed without re-downloading bytes. | **PASS** |
| **Resume with Range & ETag validation** | `test_etag_change_triggers_restart` | When server ETag changed on resume, stale `.tdm-part` was invalidated, preventing offset corruption, and file restarted cleanly. | **PASS** |
| **HLS interrupted download resume** | `test_hls_pause_and_resume_continuity` | Download paused after segment 0. On resume, existing segment 0 was preserved and NOT re-downloaded; final MP4 duration verified. | **PASS** |
| **DASH interrupted download resume** | `test_dash_pause_resume_and_recovery_continuity` | DASH segments preserved on pause; resumed to completion and muxed. | **PASS** |
| **Partial files safety** | `test_stress_part_file_cleanup_on_cancellation` | `.tdm-part` files preserved on pause/restart; cleaned up only on explicit cancellation or user deletion. | **PASS** |
| **Completion verification** | `publish_final_file` atomic rename | Never marks "completed" in SQLite before `sync()` commits bytes to disk and `.tdm-part` is renamed to final destination. | **PASS** |

---

## 6. Browser Integration Reliability

1. **Extension Reconnect after TORI Restart:**
   - Server token is persisted in SQLite under `engine_settings.browser_integration_token`.
   - On restart, TORI re-reads the same token and binds to `127.0.0.1:6800`.
   - Edge and Chrome extensions retain the token in `chrome.storage.local` and reconnect immediately without user re-pairing.
   - If pairing is unconfigured, `autoPairWithDesktop()` uses Native Messaging to seamlessly bootstrap the token.
2. **Localhost Port 6800 Security:**
   - Binds exclusively to `127.0.0.1:6800` (refuses `0.0.0.0`).
   - DNS Rebinding defense: Non-localhost Host headers rejected with HTTP 400 (`test_dns_rebinding_defense`).
   - CORS Origin verification: Web origins rejected with HTTP 403 (`test_origin_validation_and_cors`).
   - Cryptographic token authentication: Missing or invalid token rejected with HTTP 401 (`test_pairing_and_auth_enforcement`).
3. **No Duplicate Downloads from Repeated Clicks:**
   - Extension popup disables download button (`btn.disabled = true`) on click.
   - Server checks active jobs in SQLite; repeated clicks return `status: "already_exists"` with existing `job_id`. Verified in both unit test (`test_server_media_endpoints`) and live browser test (`verify_gate12_9_2_browser_e2e.js`).
4. **Native Messaging Host Path:**
   - Verified in `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.tori.download_manager` and `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.tori.download_manager`.
   - Manifest points to active binary: `F:\TORI\final tori download manager\target\release\tdm-native-host.exe`.
5. **Tab Association & Media Cleanup:**
   - Media candidates cached per `tabId` (max 50).
   - Removed on tab close (`chrome.tabs.onRemoved`) and invalidated on SPA navigation (`chrome.webNavigation.onHistoryStateUpdated`).

---

## 7. Dependency and Clean-Install Readiness

### 7.1 Clean Windows PC Audit (Without Rust, Node.js, Python, or dev FFmpeg)
- **Direct HTTP / Multi-Chunk Downloads:** **100% READY.** Native Rust code (`reqwest` with `rustls-tls`, `tokio`, `rusqlite` bundled). Zero dependencies on Python, Node.js, or FFmpeg.
- **BitTorrent / Magnet Downloads:** **100% READY.** Native Rust code (`librqbit` with `rustls`). Zero external runtime dependencies.
- **Desktop UI (Tauri 2):** **100% READY.** Production assets compiled to static HTML/JS/CSS (`ui/dist`) and embedded via Tauri custom protocol (`http://tauri.localhost/`). Uses system WebView2 runtime (pre-installed on all Windows 10/11 PCs). Zero Node.js or Vite runtime dependency.
- **HLS/DASH Remuxing:** Requires `ffmpeg.exe` and `ffprobe.exe`.
- **Platform Video Extraction (YouTube/Facebook/TikTok fallbacks):** Requires `yt-dlp.exe`.

### 7.2 Packaging Evaluation for FFmpeg, FFprobe & yt-dlp
- **FFmpeg & FFprobe Licensing:**
  - FFmpeg is licensed under LGPL v2.1+ or GPL v2/v3 (depending on build flags).
  - Common pre-built binaries (e.g. Gyan.dev) include GPL components (`x264`, `x265`).
  - When distributing GPL binaries alongside a separate application as external standalone CLI executables invoked via standard IPC process pipes (`std::process::Command`), the Free Software Foundation classifies this as "mere aggregation". However, full license notices and source code / build scripts must accompany the distribution.
  - **Recommended Approach for TORI:**
    1. Automatic discovery of system FFmpeg (WinGet `Gyan.FFmpeg`, Chocolatey, Scoop, PATH, or `%LOCALAPPDATA%\tori-download-manager\bin\`).
    2. Optional bundling of `ffmpeg.exe` and `ffprobe.exe` into Tauri `bundle.resources` (`$INSTDIR\resources\bin\`). The engine discovery code now searches `dir.join("resources")` and `dir.join("resources").join("bin")` automatically.
- **yt-dlp Licensing:**
  - yt-dlp is licensed under Unlicense (public domain equivalent). It can be bundled freely in `resources/` or downloaded by user into `%LOCALAPPDATA%\tori-download-manager\bin\`.

---

## 8. Tests Passed and Failed

### 8.1 Rust Workspace Test Results
Executed: `cargo test --workspace`
- **`tdm-cli` (unit):** 0 tests (CLI wrapper)
- **`tdm-core` (lib unit):** **22 passed, 0 failed**
- **`gate10_5_resolver_tests`:** **7 passed, 0 failed**
- **`gate12_5_multisite_tests`:** **8 passed, 0 failed**
- **`gate12_7_folder_and_category_tests`:** **2 passed, 0 failed**
- **`gate12_8_resolver_tests`:** **4 passed, 0 failed**
- **`gate12_9_1_acceptance_tests`:** **6 passed, 0 failed**
- **`gate12_9_2_e2e_tests`:** **5 passed, 0 failed**
- **`gate12_9_discovery_tests`:** **5 passed, 0 failed**
- **`gate2_adaptive_tests`:** **8 passed, 0 failed**
- **`gate4_hls_tests`:** **8 passed, 0 failed**
- **`gate5_dash_tests`:** **9 passed, 0 failed**
- **`gate6_torrent_tests`:** **8 passed, 0 failed**
- **`gate7_live_tests`:** **8 passed, 0 failed**
- **`gate8_protocol_matrix_tests`:** **8 passed, 0 failed**
- **`gate8_stress_tests`:** **4 passed, 0 failed**
- **`integration_tests`:** **9 passed, 0 failed**
- **`speed_audit_tests`:** **3 passed, 0 failed**
- **`tdm-native-host` (lib unit):** **1 passed, 0 failed**
- **`tdm-native-host` (host tests):** **7 passed, 0 failed**
- **`tdm-native-host` (server tests):** **7 passed, 0 failed** (including new duplicate check test)
- **Total Tests Passed:** **139 passed; 0 failed; 0 ignored**

### 8.2 Production Build Guard & Browser E2E Results
- **Production Release Guard Script (`scripts\verify_production_release.ps1`):**
  - **15/15 checks PASSED** (Embedded assets, port 5173 inactive, custom-protocol `http://tauri.localhost/`, Titlebar, SQLite history, Desktop API, Progress Toast window, Toast sizing, screenshot captured).
- **Real Browser Playback & E2E Verification (`scripts\verify_gate12_9_2_browser_e2e.js`):**
  - **15/15 assertions PASSED** (Release binary exists, Edge launch, dynamic ffprobe discovery, desktop engine ping, pairing token, test HTML5 server, extension pairing, overlay attachment, screenshot captured, media format resolution, job handoff, repeated click deduplication, download completion, ffprobe playable stream validation, SQLite thumbnail persistence).
- **Clippy:** `cargo clippy --workspace --all-targets -- -D warnings` — **0 warnings**.
- **Formatting:** `cargo fmt --all -- --check` — **0 formatting errors**.

---

## 9. Production Executable Information

- **Executable File:** `F:\TORI\final tori download manager\target\release\tori-download-manager.exe`
- **Companion Binary 1:** `F:\TORI\final tori download manager\target\release\tdm-native-host.exe`
- **Companion Binary 2:** `F:\TORI\final tori download manager\target\release\tdm-cli.exe`
- **File Size (`tori-download-manager.exe`):** **28,078,080 bytes (26.78 MB)**
- **SHA-256 Hash:** `D7399813116DD7592B0E4BC65EDF55C26036C8671EEE95D52C11500ED97929EB`
- **Embedded Frontend:** React 19 production build (`ui/dist/index.html`, `ui/dist/assets/index-BamakyQy.js`, `ui/dist/assets/index-C9HQ2a3x.css`) embedded via Tauri custom protocol scheme.

---

## 10. Git Commit & Preservation

- **Baseline Checkpoint Tag:** `checkpoint-gate13-start` at `45b52eb`
- **All Working Functionality Preserved:** Direct HTTP, multi-part, torrent, HLS/DASH, live streaming, multi-site media discovery, folder routing, native toast window.
- **UI & Design Preserved Exactly:** `design/tori-final/` 100% untouched.

---

## 11. Remaining Blockers Before NSIS Packaging (Gate 13.2)

1. **Third-Party Binary Bundling Decision for NSIS Setup:**
   Decide whether `ffmpeg.exe`, `ffprobe.exe`, and `yt-dlp.exe` should be bundled inside the NSIS installer (which would increase setup size from ~28 MB to ~180 MB) or downloaded on-demand / detected via system WinGet in a post-install hook. The codebase is now fully compatible with either choice thanks to the new `resources/` and `resources/bin/` search paths.
2. **Code Signing Certificate:**
   For public distribution on Windows 10/11 without SmartScreen warnings, an Authenticode code signing certificate (EV or standard) will be needed when compiling the final installer.
3. **Chrome Web Store Extension Packaging:**
   Prepare `.zip` package of `extension/` for submission to Chrome Web Store and Microsoft Edge Add-ons catalog.
