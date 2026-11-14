# TORI Download Manager — Gate 27.8: Final MKV Classification Fix & Full Transfer Verification Report

**Date:** 2026-11-14  
**Project Root:** `F:/TORI/final tori download manager`  
**Git Branch:** `fix/gate27-runtime-fixes`  
**Base Checkpoint:** `checkpoint-gate27_7-verified` / `checkpoint-pre-gate27_8` (`d6e286f`)  
**Desktop Release Candidate:** `v1.0.5-rc` (rebuilt & re-signed after Gate 27.8 backend fixes)  
**Browser Companion Release Candidate:** `v1.0.7` (Chromium ZIP & Mozilla-signed Firefox XPI unchanged)  
**Overall Verdict:** **GO — RELEASE CANDIDATES VERIFIED (LOCAL STAGING ONLY; NOT YET PUBLISHED)**

---

## 1. Executive Verdict

All Gate 27.8 root causes are resolved cleanly in Rust without modifying `extension/` JS/manifest files or altering the Mozilla-signed Firefox `v1.0.7` XPI (`b082c8f2f4c8b4ed035fab77d9569622737defb3e02279f20073d3404dda4fa0`). Rebuilt Desktop `v1.0.5-rc` binaries, the NSIS installer, and the `.sig` updater signature passed all automated unit, integration, API, real-browser, real `2.30 GiB` transfer, and Gate 27.7 regression suites with **zero failures, zero timeouts, and zero skipped checks**:

| Verification Suite | Scope | Observed Result |
|---|---|---|
| `cargo test --workspace --no-fail-fast` | Full Rust workspace (`tdm-core`: `203`, `tdm-native-host`: `29`, `tdm-cli`: `0`, `src-tauri`: `0`, incl. `updater_cryptography_tests` `5/5`, `gate27_8_mkv_classification_tests` `5/5`, `gate27_8_api_classification_tests` `1/1`, `gate26_1_large_file_and_handoff_tests` `4/4`, `gate27_5_large_mkv_capture_tests` `9/9`, `host_tests` `8/8`) | **232 / 232 PASS** (`0 failed`, `0 ignored`) |
| `node scripts/verify_gate27_8_large_mkv_and_classification.js` | Rebuilt `v1.0.5-rc` silent NSIS install, Desktop UI startup, real `2.30 GiB` (`2,469,606,195` B) MKV pause/resume + SHA-256 verification, Chrome `v1.0.7` 5-endpoint classification matrix, Edge `v1.0.7` & Mozilla-signed Firefox `v1.0.7` XPI `Content-Disposition` MKV routing, Mix rejection, Playlist open, Audio->Video sequence | **10 / 10 PASS** |
| `node scripts/verify_gate27_7_release_acceptance.js` | Desktop `v1.0.5-rc` NSIS/Tray/SSE/Playlist/Audio->Video + Chrome 157 `v1.0.7` + Edge `v1.0.7` (`Cosmic_Odyssey_1080p_BluRay.mkv` routed directly into `Video/`) | **18 / 18 PASS** |
| `node scripts/verify_gate27_7_firefox_signed_v107.js` | Signed Firefox `v1.0.7` XPI crypto, permanent install, restart persistence, `Disposition_Firefox_Test.mkv` (`6,291,456` B), Playlist, Audio->Video | **16 / 16 PASS** |
| `node scripts/verify_overlay_drag_fix.js` | Floating overlay click/drag/clamping/Shadow DOM verification across Edge (`13`), Chrome (`13`), and Firefox (`13`) | **39 / 39 PASS** |

---

## 2. Root Causes Identified & Resolved

### 2.1 Pre-Probe Folder Classification Misrouting Extensionless / `Content-Disposition` MKVs into `Other/`
- **Root Cause:** Previously, [tdm-native-host/src/server.rs](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-native-host/src/server.rs), [tdm-native-host/src/lib.rs](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-native-host/src/lib.rs), and [src-tauri/src/commands.rs](file:///F:/TORI/final%20tori%20download%20manager/src-tauri/src/commands.rs) called `DownloadManager::resolve_destination_folder` *before* `DownloadManager` probed HTTP headers. URLs without a `.mkv` extension (e.g., `/cd_blob`, signed redirect tokens, or UTF-8 `filename*=` endpoints) had not yet resolved their `Content-Disposition` filename or redirect target, causing category folders to lock onto `Other/` instead of `Video/`.
- **Fix:**
  - Updated [tdm-native-host/src/server.rs](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-native-host/src/server.rs), [tdm-native-host/src/lib.rs](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-native-host/src/lib.rs), and [src-tauri/src/commands.rs](file:///F:/TORI/final%20tori%20download%20manager/src-tauri/src/commands.rs) to validate explicit destination paths with `DownloadManager::validate_destination_path` (returning `EngineError::InvalidDestination`) and delegate standard HTTP downloads to `create_or_coalesce_download_to_destination` / `create_download_to_destination`.
  - Refactored [crates/tdm-core/src/engine/manager.rs](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/src/engine/manager.rs) (`DestinationTarget`, `create_or_coalesce_download_inner`, `create_download_inner`, `choose_http_filename`, `classify_category_with_content_type`, `resolve_destination_folder_with_content_type`) to run HTTP probing (`probe_url_with_options`) *first*, determine the final sanitized HTTP filename, and then resolve `Video/`, `Music/`, `Documents/`, `Compressed/`, `Programs/`, or `Other/` using:
    1. Resolved filename extension first (respecting explicit non-default custom `destination` overrides unchanged);
    2. Safe `Content-Type` fallback (`video/*`, `application/x-matroska`, `application/matroska`, etc.) only when no meaningful extension exists, explicitly rejecting generic binary/text streams (`application/octet-stream`, `binary/octet-stream`, `application/unknown`, `text/plain`), so opaque binary blobs stay in `Other/`.
  - Hardened RFC 6266 / RFC 5987 header parsing in [crates/tdm-core/src/engine/probe.rs](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/src/engine/probe.rs) (`ProbeResult::content_type`, `split_header_params`, `unescape_quoted_header_value`, `extract_safe_header_filename_candidate`, `decode_rfc5987_ext_value`, `parse_content_disposition_filename`) so `filename*=` takes precedence over `filename=`, traversal/control/drive prefixes are stripped safely, and [crates/tdm-core/src/resolver/pipeline.rs](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/src/resolver/pipeline.rs) reuses `parse_content_disposition_filename`.

### 2.2 Cross-Browser `handoff_id` Collision (`browser_dl_1`)
- **Root Cause:** Discovered during Gate 27.8 multi-browser E2E testing: fresh isolated profiles in Chrome, Edge, and Firefox each begin native browser download IDs at `browser_dl_1`. `DownloadManager::create_or_coalesce_download_inner` in [crates/tdm-core/src/engine/manager.rs](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/src/engine/manager.rs) previously keyed `recent_handoffs` and `in_flight_creations` solely by `handoff_id` without binding the URL, causing later Edge/Firefox `browser_dl_1` requests to coalesce onto Chrome's earlier `browser_dl_1` job (`real_large_2_3gb.mkv`).
- **Fix:** Scoped `recent_handoffs` and `in_flight_creations` handoff lookup keys in `create_or_coalesce_download_inner` (`crates/tdm-core/src/engine/manager.rs:901-1039`) by both `handoff_id` and `trimmed_url` and guarded lookup with `existing.url.trim() == trimmed_url`, while keeping true duplicate same-URL native/API coalescing intact (verified by `host_tests::test_concurrent_in_flight_handoff_coalescing`, `gate26_1_large_file_and_handoff_tests`, and `test_gate27_8_handoff_id_scoped_per_url_across_browsers`).

---

## 3. Genuine Large-File (`2.30 GiB`) Transfer & Classification Evidence

Executed via [scripts/verify_gate27_8_large_mkv_and_classification.js](file:///F:/TORI/final%20tori%20download%20manager/scripts/verify_gate27_8_large_mkv_and_classification.js) against the freshly built `v1.0.5-rc` Desktop installer + UI + Chromium/Edge `v1.0.7` unpacked extension + Mozilla-signed Firefox `v1.0.7` XPI (`10/10 PASS`):

### 3.1 Real `2.30 GiB` MKV End-to-End Transfer (`G278-2G-PAUSE` & `G278-2G-E2E`)
- **Payload Size:** `2,469,606,195` bytes (`2.30 GiB`) deterministic seeded Matroska-header stream with exact target SHA-256 `a71c0f55c37c5fad01fb0abc08d783b662921b1afe9f95d18cf1f771d7efe746`.
- **Capture & Interception:** Captured from Chrome; native browser download interrupted cleanly (`chrInterrupted=true`); zero duplicate tasks (`zeroDup=true`).
- **Mid-Transfer Pause / Resume Continuity:** Paused mid-flight at `downloadedBytes=91,226,112` bytes with pre-allocated `.tdm-part` (`partBytes=2,469,606,195`) persisted inside `Video/`, then resumed cleanly to completion.
- **Final Disk / UI / DB Verification:**
  - Completed file bytes on disk: `2,469,606,195 / 2,469,606,195` bytes inside `Video/`
  - Streamed SHA-256 verification on completed disk file: **MATCH** (`shaMatch=true`, `a71c0f55c37c5fad01fb0abc08d783b662921b1afe9f95d18cf1f771d7efe746`)
  - Transfer duration: `elapsed=6.32s`
  - UI & persistence: `uiFilename=true`, `uiCompleted=true`, `dbState=completed`

### 3.2 Real-Browser MKV Classification & Regression Results
- **Chrome `v1.0.7` (`CHR-CLS-01`, `5/5` verified):**
  - `/cd_blob` (`Content-Disposition: attachment; filename="Example_Movie.mkv"`) -> `Video/`
  - `/unicode_cd` (RFC 5987 `UTF-8''Priority%20Film%20%E5%A4%A7%E5%9E%8B.mkv`) -> `Video/`
  - `/redir_start` (302 redirect -> signed token URL resolving `Signed_Gate27_8.mkv`) -> `Video/`
  - `/normal.mp4` (`Normal_Regression.mp4`) -> `Video/`
  - `/unknown_blob` (generic `application/octet-stream`, no video evidence) -> `Other/`
- **Microsoft Edge `v1.0.7` (`EDGE-CLS-01`):** `Edge_CD_Movie.mkv` intercepted via `/edge_cd`, routed to `Video/`, SHA-256 verified, zero duplicates.
- **Mozilla-Signed Firefox `v1.0.7` XPI (`FF-CLS-01`, `FF-REG-01`):** `Firefox_Disposition_Movie.mkv` intercepted via `/firefox_cd`, routed to `Video/`, SHA-256 verified, zero duplicates; YouTube `list=` Mix rejection, `Download Playlist` handoff, and `Audio-only` -> `Video` sequence verified.

---

## 4. Modified & Created Files

### Source & Test Files Modified/Added
- [crates/tdm-core/src/engine/manager.rs](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/src/engine/manager.rs) — post-probe classification/folder resolution, `DestinationTarget`, `choose_http_filename`, `classify_category_with_content_type`, `validate_destination_path`, URL-scoped `(handoff_id, trimmed_url)` coalescing keys
- [crates/tdm-core/src/engine/probe.rs](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/src/engine/probe.rs) — `ProbeResult::content_type`, RFC 6266 / RFC 5987 `parse_content_disposition_filename` & header safety helpers
- [crates/tdm-core/src/engine/mod.rs](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/src/engine/mod.rs) — re-exports of header filename helpers
- [crates/tdm-core/src/error.rs](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/src/error.rs) — `EngineError::InvalidDestination`
- [crates/tdm-core/src/resolver/pipeline.rs](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/src/resolver/pipeline.rs) — shared `parse_content_disposition_filename` reuse
- [crates/tdm-native-host/src/lib.rs](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-native-host/src/lib.rs) — post-probe `create_or_coalesce_download_to_destination` wiring + destination validation
- [crates/tdm-native-host/src/server.rs](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-native-host/src/server.rs) — post-probe `/downloads` creation wiring + destination validation
- [src-tauri/src/commands.rs](file:///F:/TORI/final%20tori%20download%20manager/src-tauri/src/commands.rs) — `create_download` post-probe routing for HTTP downloads + destination validation
- [crates/tdm-core/tests/gate27_8_mkv_classification_tests.rs](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/tests/gate27_8_mkv_classification_tests.rs) — 5 unit/integration tests covering RFC 6266, Content-Type safety, post-probe routing, MKV pause/resume, and cross-browser `handoff_id` URL scoping
- [crates/tdm-native-host/tests/gate27_8_api_classification_tests.rs](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-native-host/tests/gate27_8_api_classification_tests.rs) — HTTP `/downloads` API post-probe classification test
- [scripts/verify_gate27_7_release_acceptance.js](file:///F:/TORI/final%20tori%20download%20manager/scripts/verify_gate27_7_release_acceptance.js) — updated expected folder for `/cd_blob` `Cosmic_Odyssey_1080p_BluRay.mkv` from `Other` to `Video`
- [scripts/verify_gate27_8_large_mkv_and_classification.js](file:///F:/TORI/final%20tori%20download%20manager/scripts/verify_gate27_8_large_mkv_and_classification.js) — full real-browser + `2.30 GiB` transfer acceptance harness

**Unmodified Assets Confirmed:** `extension/` JS/HTML/CSS/manifests, `latest.json`, `v1.0.6` extension artifacts in `release/v1.0.5-rc/extensions/`, signed Firefox `v1.0.7` XPI, pre-Gate 27.8 checkpoint backup, and website docs remain completely unchanged.

---

## 5. Release Candidate Artifact Checksums & Preservation

### Desktop `v1.0.5-rc` (`release/v1.0.5-rc/`)
Updated [release/v1.0.5-rc/SHA256SUMS.txt](file:///F:/TORI/final%20tori%20download%20manager/release/v1.0.5-rc/SHA256SUMS.txt) (`476` B, SHA-256 `83497071ef51128d9adb77f29b2b7e37cae985d73ac7870001f624507324855c`):

| File | Size (Bytes) | SHA-256 |
|---|---|---|
| `TORI Download Manager_1.0.5_x64-setup.exe` | `117,611,195` | `ca10ee28b686485c07400c606b4c35f23d0b8906b4cd73c724fb81c92f945bf9` |
| `TORI Download Manager_1.0.5_x64-setup.exe.sig` | `436` | `e675788e0bd433f0fa71f75392325a55cfd13d3765d87f62cea7321d9a1d2b0e` |
| `tori-download-manager.exe` | `30,216,192` | `59c0b39c43c27c43cbadc95af82a98df1438895d0229082ac6d9374c76d9e77e` |
| `tdm-native-host.exe` | `19,096,576` | `95bb8ed4a9460e4f8fc41d1f32923f3a2f5ab8c67eed676275c5c6318e2923c8` |
| `tdm-cli.exe` | `17,004,544` | `cd438cef208d352a40f36f38acbb7fe0ed66f19909210e35815ae9670ff26d0e` |

- Updater signature cryptographic verification (`cargo test -p tdm-core --test updater_cryptography_tests`): **5 / 5 PASS** after the final rebuild.
- Pre-Gate 27.8 checkpoint backup preserved intact under `release/checkpoints/v1.0.5-rc-pre-gate27_8/` (`TORI Download Manager_1.0.5_x64-setup.exe` `117,568,384` B `609d74ad8999893de70e835efb28ec6c45a38550c1114ef3e51a8a98164b8256`).
- Preserved `v1.0.6` extension assets in `release/v1.0.5-rc/extensions/` (`a70ed17e183648a9bcf4-1.0.6.xpi` `88,878` B, SHA-256 `96a63c6be3eaf8488fbbd299ed2f07c8ef1e20b09128b8d0841a463026236038`).

### Browser Companion `v1.0.7` (`release/v1.0.7-extension-rc/`)
| File | Size (Bytes) | SHA-256 |
|---|---|---|
| `a70ed17e183648a9bcf4-1.0.7.xpi` | `90,326` | `b082c8f2f4c8b4ed035fab77d9569622737defb3e02279f20073d3404dda4fa0` |
| `tori-download-manager-firefox-v1.0.7.xpi` | `90,326` | `b082c8f2f4c8b4ed035fab77d9569622737defb3e02279f20073d3404dda4fa0` |
| `tori-companion-v1.0.7-chromium.zip` | `75,407` | `db491f9811709020d69b70dfdf41d61100dd7603c71d97f0cc1f6167cda70940` |
| `tori-companion-v1.0.7-firefox.zip` | `75,720` | `a68350aa4f453e9e2b6bcb38d879bb8ab429c2d4808766423d65ff24a4df3204` |

---

## 6. Environment Hygiene & Publication Boundary

- **OEM Native Messaging Restored:** Re-ran `%LOCALAPPDATA%\TORI Download Manager\bin\tdm-native-host.exe --register`; Chrome, Edge, and Firefox `HKCU\...\NativeMessagingHosts\com.tori.download_manager` keys point cleanly to OEM `AppData\Local\TORI Download Manager\bin\tdm-native-host.exe`.
- **Production User Data Intact:** `%APPDATA%\tori-download-manager\tdm_storage.sqlite` verified intact (`1,331,200` bytes, `19` real rows, `0` localhost/test rows); user `Downloads` verified clean of QA artifacts; temporary QA folders and headless browser/test processes cleaned (`0` orphans).
- **Publication Status:** No GitHub release published, no tags or commits pushed, `latest.json` and website download URLs left untouched. Staged artifacts are ready for operator sign-off and production publication.
