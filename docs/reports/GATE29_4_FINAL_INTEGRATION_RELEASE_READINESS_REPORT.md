# TORI Download Manager — Gate 29.4 Final Integration, Production Regression & Release Readiness Report

**Assessment Decision:** `READY FOR OPERATOR REVIEW`  
**Date:** 2026-11-16  
**Workspace:** `F:\TORI\final tori download manager`  
**Branch / Baseline:** `fix/gate27-runtime-fixes` (pre-Gate 29.4 checkpoint tag: `checkpoint-gate29_4-before-final-integration` @ `56a385d23e74d067114566aa1a4bf2c0ccb26f38`)  
**Target Release Candidates:**
- **TORI Download Manager Desktop (Windows x64):** `v1.0.5` RC
- **TORI Browser Companion Extension (`Chrome`, `Edge`, `Firefox`):** `v1.0.9` RC
- **Preserved Signed Fallback Firefox Add-on:** `v1.0.7` (`a70ed17e183648a9bcf4-1.0.7.xpi`, Mozilla-signed)

---

## 1. Executive Summary & Readiness Decision

TORI Download Manager `v1.0.5` Desktop RC and TORI Browser Companion `v1.0.9` RC completed full integration, clean installation, database upgrade migration, download engine recovery, live multi-resolution YouTube capture & playability, cross-browser integration (`Chrome`, `Edge`, `Firefox`), IDM desktop/progress/extension UI verification, sustained concurrency memory profiling, security/packaging audit, and Firefox signing readiness checks.

During Gate 29.4 verification, two concrete integration issues were identified and resolved prior to final sign-off:
1. **Uncommitted `options.js` readiness attribute drift & package resync (`Chrome`/`Firefox`):** Resynced shared files via [package_v1_0_9_extensions.js](file:///F:/TORI/final%20tori%20download%20manager/scripts/package_v1_0_9_extensions.js) and updated [verify_gate29_3_idm_extension_ui.js](file:///F:/TORI/final%20tori%20download%20manager/scripts/verify_gate29_3_idm_extension_ui.js#L1099-L1149) to synchronize Chromium and Firefox `v1.0.9` options scripts cleanly without modifying operator intent.
2. **YouTube muxed `.webm.mkv` `target_path` SQLite desynchronization (`tdm-core`):** Fixed [repo.rs](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/src/db/repo.rs#L84-L98) and [downloader.rs](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/src/resolver/downloader.rs#L270-L286) so `yt-dlp` double-extension muxed outputs (e.g. `.webm.mkv` -> `.mkv`) normalize safely without clobbering existing files and update `downloads.filename` / `downloads.target_path` in SQLite before marking `Completed`. Rebuilt `v1.0.5` binaries and signed NSIS installer and re-ran the full verification matrix after the final source edit.

All automated Rust, frontend, lint, UI, E2E, `2.30 GiB` MKV, and Gate 29.4 integration test suites passed **after** the final code edit (`0` failures, `0` timeouts). No releases, updater manifests, website files, Mozilla AMO submissions, or store uploads were published. **Decision: `READY FOR OPERATOR REVIEW`.**

---

## 2. Repository Baseline & Pre-Gate Safety Checks

- Confirmed working branch `fix/gate27-runtime-fixes` and created local safety tag `checkpoint-gate29_4-before-final-integration` at `56a385d`.
- Preserved Mozilla-signed Firefox `v1.0.7` XPI (`release/v1.0.7-extension-rc/a70ed17e183648a9bcf4-1.0.7.xpi`, `90,326` bytes) byte-for-byte throughout all runs (`SHA-256: b082c8f2f4c8b4ed035fab77d9569622737defb3e02279f20073d3404dda4fa0`).
- All QA runs used isolated `TORI_DATA_DIR`, `TDM_DOWNLOAD_DIR`, `TORI_IPC_PIPE`, `WEBVIEW2_USER_DATA_FOLDER`, temporary browser user data directories, and dedicated localhost ports (`19910–19977`, Firefox Marionette `2831–2836`).
- Post-run hygiene check restored OEM `TORI Download Manager` (`1.0.4`) HKCU Uninstall registry entries, Start Menu shortcut, HKCU Native Messaging manifests via `C:\Users\ritud\AppData\Local\TORI Download Manager\bin\tdm-native-host.exe --register`, relaunched OEM minimized, and deleted temporary `target/gate*_qa` test directories.

---

## 3. Release Candidate Version & Contract Consistency Matrix

### Version Metadata Parity
| Component | File / Artifact | Observed Version / ID | Status |
|---|---|---|---|
| Rust Workspace / Crates | [Cargo.toml](file:///F:/TORI/final%20tori%20download%20manager/Cargo.toml) | `1.0.5` | Verified |
| Tauri App Config | [tauri.conf.json](file:///F:/TORI/final%20tori%20download%20manager/src-tauri/tauri.conf.json) | `1.0.5` (`com.tori.downloadmanager`) | Verified |
| Desktop React UI | [package.json](file:///F:/TORI/final%20tori%20download%20manager/ui/package.json) | `1.0.5` | Verified |
| Chromium Extension | [extension/manifest.json](file:///F:/TORI/final%20tori%20download%20manager/extension/manifest.json) | `1.0.9` | Verified |
| Firefox Extension | [extension/firefox/manifest.json](file:///F:/TORI/final%20tori%20download%20manager/extension/firefox/manifest.json) | `1.0.9` (`tori-download-manager@toridm.org`, `strict_min_version: 142.0`) | Verified |
| Local Bridge HTTP API | [server.rs](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-native-host/src/server.rs#L21-L23) | `2.0.0` (Default Port `6800`) | Verified |

### Shared Extension File Parity
Verified byte-level equality across all 10 shared Chromium/Firefox source files via [package_v1_0_9_extensions.js](file:///F:/TORI/final%20tori%20download%20manager/scripts/package_v1_0_9_extensions.js) (`background.js`, `content.js`, `content.css`, `popup/popup.html`, `popup/popup.css`, `popup/popup.js`, `options/options.html`, `options/options.css`, `options/options.js`, `shared/tokens.css`), differing only in browser-required `manifest.json` keys.

### Protocol & Command Surface Parity
- **Native Messaging Actions (`tdm-native-host` <-> `extension/background.js`):** `ping`, `pair`, `show_window`, `open_playlist`, `hide_window`, `open_progress`, download creation & health queries (`host_tests`: `8/8` passed; live E2E `[T10-NATIVE]` passed).
- **Local HTTP/SSE Routes (`server.rs:1585-1654`):** `/api/v1/ping`, `/api/v1/status`, `/api/v1/pair`, `/api/v1/pair/status`, `/api/v1/downloads`, `/api/v1/downloads/{id}[/pause|/resume|/cancel|/retry|/reschedule|/delete|/progress]`, `/api/v1/window/show`, `/api/v1/window/hide`, `/api/v1/events`, `/api/v1/media/status`, `/api/v1/media/resolve`, `/api/v1/media/download`, `/api/v1/media/playlist/resolve`, `/api/v1/media/playlist/enqueue`, `/api/v1/media/playlist/open`, `/api/v1/thumbnails/{id}`.
- **Note on `/api/v1/downloads/{id}/delete`:** Intentionally sets `delete_file = false` (`server.rs:1399`) so remote HTTP clients remove queue entries without deleting local disk files; disk file deletion is exposed only to the Desktop Tauri command `delete_download(id, delete_files)` (`src-tauri/src/commands.rs:276`).
- **Tauri IPC Commands (`src-tauri/src/lib.rs:350-403`):** Verified active bindings across `ui/src/`, including Gate 29.2 progress window commands (`get_download_status_details`, `set_download_speed_limit`, `set_download_completion_options`, `get_download_completion_options`, `open_progress_window`, `update_toast_bounds`, `hide_toast_window`, `save_toast_position`, `save_toast_size`, `get_toast_size`) and Gate 27.8 playlist handoff commands (`frontend_ready`, `take_pending_playlist_requests`, `acknowledge_playlist_modal`).

---

## 4. Final Staged Release Artifacts & Checksums

### Desktop `v1.0.5` RC ([release/v1.0.5-rc/](file:///F:/TORI/final%20tori%20download%20manager/release/v1.0.5-rc))
| Artifact | Size (Bytes) | SHA-256 |
|---|---|---|
| `TORI Download Manager_1.0.5_x64-setup.exe` | `117,703,556` | `400920b52e947ce6f53cf0f811e6f30f096af7aa4d2f9696aaeca33daef2b152` |
| `TORI Download Manager_1.0.5_x64-setup.exe.sig` | `436` | `9006174cb759472d3f2bd252fcba0c430edff49117a36fb5e62a444a2332b7e9` |
| `tori-download-manager.exe` | `30,560,256` | `b1735698571d635036cac7f7d4785d9e387cef76c30cefe662fbf569aed3c29c` |
| `tdm-native-host.exe` | `19,259,904` | `4e99fb3c7a9023b2d1e91d9784b185dce9d834a43345b18d77493e9f71230563` |
| `tdm-cli.exe` | `17,038,336` | `2954cb87520fd7afa8e38b712ee0c588f5c6d3a88bca69065dce741b77708657` |
| `SHA256SUMS.txt` | `484` | `38f5b4633daeed6eb19df61ead68aa17e84c973ef7fef34f5e1f2e1241d9df6d` |

> **Bundled Runtime Dependencies (`resources/bin/` == installed `bin/`):** `ffmpeg.exe` (`b9989f24...`), `ffprobe.exe` (`73842bee...`), `yt-dlp.exe` (`66674953...`), `tdm-cli.exe` (`2954cb87...`), and `tdm-native-host.exe` (`4e99fb3c...`) verified byte-identical after silent NSIS install. Tauri's NSIS bundler injects NSIS bundle metadata into the installed copy of `tori-download-manager.exe` (`6a043f5f...`, ProductVersion `1.0.5`), consistent with standard Tauri v2 NSIS packaging.

### Extension `v1.0.9` RC ([release/v1.0.9-extension-rc/](file:///F:/TORI/final%20tori%20download%20manager/release/v1.0.9-extension-rc)) & Preserved Signed `v1.0.7` XPI
| Artifact | Size (Bytes) | SHA-256 |
|---|---|---|
| `tori-companion-v1.0.9-chromium.zip` | `85,008` | `e7c82b8b90a98855610e349751a72a542f12e13c6e30c11005482e6824946519` |
| `tori-companion-v1.0.9-firefox.zip` | `85,760` | `7ab28734a756e280a6193e26a48c25963b322732d08934d37b80951fc06b49a2` |
| `a70ed17e183648a9bcf4-1.0.7.xpi` (preserved) | `90,326` | `b082c8f2f4c8b4ed035fab77d9569622737defb3e02279f20073d3404dda4fa0` |

---

## 5. Clean Installation, Upgrade & Data Preservation Results

### Phase 2 — Clean Installation (Isolated Host Profile)
- **`G294-INST-01` (`PASS`):** Silent NSIS install (`/S /D=target\gate29_4_qa\clean_install`) deployed ProductVersion `1.0.5`, matching all 5 `bin/` resource hashes against `resources/bin/`, creating `uninstall.exe`, and executing `NSIS_HOOK_POSTINSTALL` to register `com.tori.download_manager.json` in HKCU.
- **`G294-INST-02` (`PASS`):** First boot with empty `TORI_DATA_DIR` initialized all SQLite tables (`schema_migrations`, `downloads`, `download_chunks`, `engine_settings`, `format_metadata_cache`), rendered UI version `1.0.5` without white flash (`bg=rgb(35, 35, 38)`), and spawned `0` console windows (`cmd.exe`/`powershell.exe`/`conhost.exe`).
- **`G294-INST-03` (`PASS`):** Tray hide/restore and explicit `exit_app` completed cleanly (`exitedCleanly=true`).
- **Scope Boundary:** Verified on an isolated profile directory on the development Windows 11 x64 host; execution on a separate clean Windows VM was not performed (`NOT TESTED` on separate hardware).

### Phase 3 — Upgrade & Data Preservation Migration
- **`G294-UPG-01` (`PASS`):** Seeded a pre-`v1.0.5` SQLite schema (omitting `priority`, `thumbnail_url`, `referer`, `user_agent`, `scheduled_at`), custom settings (`dark`/`ocean`, `maxa=3`), pairing token (`tori_upg_preserved_token_12345`), historical completed job, and paused 2-chunk 4 MiB download with a `1,048,576`-byte `.tdm-part` on disk. Upgrading to `v1.0.5` migrated all missing columns cleanly via [schema.rs](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/src/db/schema.rs#L73-L86) and preserved settings, token, history, and paused byte count (`1,048,576`).
- **`G294-UPG-02` (`PASS`):** Resuming the pre-existing paused job requested HTTP `Range` slices starting from `1048576` and `2097152` without restarting from byte `0` (excluding the initial `0-0` probe), completing to `4,194,304` bytes with matching SHA-256.

---

## 6. Download Engine, Video/Playlist, Cross-Browser & UI Verification

### Download Engine & Recovery ([verify_gate29_4_final_integration.js](file:///F:/TORI/final%20tori%20download%20manager/scripts/verify_gate29_4_final_integration.js), [verify_gate27_8_large_mkv_and_classification.js](file:///F:/TORI/final%20tori%20download%20manager/scripts/verify_gate27_8_large_mkv_and_classification.js))
- **Error & Rejection Handling (`G294-ENG-ERR` `PASS`):** Unauthenticated POST rejected (`401`), invalid `javascript:` URL rejected (`400`), 404 probe rejected (`500`), and mid-transfer HTTP 404 transitioned cleanly to `failed` with `"Server returned error status: 404"`.
- **Classification, Chunked Stream & HTTP 500 Retry (`G294-ENG-HTTP` `PASS`):** ZIP routed to `Compressed/`, unknown-size chunked stream without `Content-Length` completed in `Other/` with exact SHA-256, and simulated HTTP `500` failures recovered to exact SHA-256.
- **Process Crash Recovery (`G294-ENG-CRASH` `PASS`):** Hard `taskkill /F /T` mid-transfer at `5,767,168 / 16,777,216` bytes preserved `.tdm-part`; restart reconciled state to `paused` (`4,390,912` persisted chunk bytes), and resume completed with exact 16 MiB SHA-256.
- **Concurrency Cap, Cancel & Delete from Disk (`G294-ENG-CONC` `PASS`):** 4 queued 3 MiB jobs respected `maxa=3` (`peakConcurrentJobs=3`), cancelled job #4 cleanly, and `delete_download(..., deleteFiles: true)` deleted job #3 from DB and disk.
- **Combined Global + Per-Download Speed Limiter (`G294-ENG-LIM` `PASS`):** Enabled global `400 KiB/s` cap plus per-job `204,800 B/s` limit on a 1.2 MiB transfer; throttled cleanly in `6,300 ms` without deadlock and passed SHA-256.
- **>2 GiB Transfer (`G278-2G-PAUSE`, `G278-2G-E2E` `PASS`):** `2,469,606,195`-byte (`2.30 GiB`) non-aligned MKV via Chrome paused (`72,089,600` bytes, `.tdm-part` retained in `Video/`), resumed to completion in `7.03s`, matched deterministic SHA-256 (`a71c0f55c37c5fad01fb0abc08d783b662921b1afe9f95d18cf1f771d7efe746`), updated Desktop UI/DB, and left zero duplicate jobs.

### Live YouTube, Playlist & Cross-Browser Integration
- **`G294-YT-RES` (`PASS`):** Downloaded real YouTube `360p` (`.mkv`), `720p` (`.mkv`), `1080p` (`vp9+m4a` muxed cleanly to `WING IT! - Blender Open Movie (2).mkv` with **zero `.webm.mkv` suffix**), and `Audio-only` (`.m4a` -> `Music/`) on `v1.0.5` + Chrome `v1.0.9`. Verified `fs.existsSync(job.target_path)` directly against SQLite and verified video/audio codecs, resolution heights (`>=360`, `>=720`, `>=1080`), and positive duration (`>30s`) with `ffprobe.exe`.
- **Cross-Browser Parity (`Chrome`, `Edge`, `Firefox`):**
  - Chrome `v1.0.9`: Verified popup 5 states (`POP-5STATES`), site exclusions (`T14-SITES`), theme/options persistence (`T15-THEME`, `T16-OPTS`), MKV/large MKV/MP4 capture (`T01`–`T03`), rapid 3x click dedup (`T17-RAPID`), SPA navigation without duplicate overlays (`T18-SPA`), Native Messaging (`T10-NATIVE`), HTTP fallback (`T11`), and restart recovery (`T12`).
  - Microsoft Edge `v1.0.9`: Verified IDM format picker (`EDGE-UI`), smooth non-sticky overlay dragging (`T13-DRAG`), and `v1.0.7` `Content-Disposition` MKV -> `Video/` classification (`EDGE-CLS-01`).
  - Mozilla Firefox `v1.0.9` & `v1.0.7` XPI: Verified `v1.0.9` ZIP format picker + download (`FF-E2E`), `v1.0.9` extensionless `Content-Disposition` MKV capture (`G294-FF-MKV`), live YouTube `PlaylistModal` launch & playable playlist item download (`G294-FF-PLAYLIST`), and preserved `v1.0.7` XPI regression (`FF-CLS-01`, `FF-REG-01`).

### Desktop Main Window & Download Progress Window ([verify_gate29_1_idm_desktop_ui.js](file:///F:/TORI/final%20tori%20download%20manager/scripts/verify_gate29_1_idm_desktop_ui.js), [verify_gate29_2_idm_progress_window.js](file:///F:/TORI/final%20tori%20download%20manager/scripts/verify_gate29_2_idm_progress_window.js))
- Verified IDM layout (`32px` Windows chrome, MenuBar, Toolbar, hierarchical Sidebar tree, 6-column table, Light/Dark + Accent live switching & SQLite restart persistence, `800x540` min-viewport zero horizontal overflow, `<=45` DOM rows across 1,200-row virtualized list).
- Verified independent Download Progress Popup (`460x365` full layout, `38px` compact mode + restore toggle, `<=1 Hz` title/DOM throttling, real segment bars, Pause/Resume/Failed/Retry/Completed `Close`/`Open`/`Open folder`, Always-on-Top toggle, Main Window minimize independence, duplicate popup suppression, multiple popups + background completion when closed, per-job limiter, and `close_on_complete` / `notify_on_complete`).
- Visually inspected regenerated Light Main Window, Light Downloading Progress Popup, and Extension `v1.0.9` Options Connection screenshots.

---

## 7. Performance, Stability & Sustained Load Metrics

| Benchmark | Measured Metric | Result |
|---|---|---|
| Idle Main Window (`Gate 29.1` `PERF-IDLE`) | `WorkingSet=371.49 MB`, `Private=196.32 MB`, `Procs=7`, `blurCount=0` | `PASS` |
| Active Throttled Main Table (`Gate 29.1` `PERF-THROTTLE`) | `mutations/3.2s=5`, `activeWs=375.7 MB`, `cpuSec=2.391s` | `PASS` |
| 1,200-Row Virtualized Table (`Gate 29.1` `PERF-VIRT`) | `renderedTop=22`, `renderedMid=27`, `virtWsMb=366` | `PASS` |
| Independent Progress Popup Delta (`Gate 29.2` `PERF-OPEN-STATS`) | `idleWs=364.6 MB -> openWs=468.9 MB` (`+104.3 MB`, `procs 7->8`), `titleUpdates/3.1s=3` | `PASS` |
| Sustained 6x16 MiB Transfers (`Gate 29.4` `G294-STAB-LOAD`) | `preWs=459.73 MB`, `duringWs=460.79 MB`, `postWs=461.23 MB` (`+1.5 MB` net delta), `postPriv=305.96 MB`, `wv2=6`, `console=0` | `PASS` |

---

## 8. Security, Packaging & NSIS Audit

- **Local HTTP/SSE Security ([server.rs](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-native-host/src/server.rs#L172-L384), `1656–1676`):**
  - Listener binds strictly to `127.0.0.1` (`port`, fallback `6801–6803, 0`).
  - `security_middleware` enforces strict `Host` allowlist (`127.0.0.1`, `localhost`) for DNS rebinding defense and strict `Origin` validation (allowlisted Chromium extension IDs, 36-char Firefox UUIDs, and exact Tauri origins; websites rejected with `403`).
  - Authenticated mutating/listing endpoints require `X-Tori-Token`, `Authorization: Bearer`, or SSE query token. Unauthenticated `handle_get_thumbnail` strictly filters `id` to ASCII alphanumeric + `-` and reads only `.jpg` under thumbnail cache (`NOT FOUND` otherwise). Verified by `server_tests` (`7/7` passed).
- **SSRF, Path Traversal, Filename & Header Sanitization:**
  - Destination validation (`validate_destination_path` in [manager.rs](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/src/engine/manager.rs#L669-L689)) rejects NUL/control characters and `..` parent traversal.
  - Filename sanitizer (`sanitize_filename` in [probe.rs](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/src/engine/probe.rs#L559-L605)) strips Windows illegal characters, reserved device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1..9`, `LPT1..9`), trailing dots, and UTF-8 char-boundary truncation.
  - Referer & User-Agent sanitizers ([referer.rs](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/src/engine/referer.rs#L16-L82), [user_agent.rs](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/src/engine/user_agent.rs#L16-L36)) strip credentials/query/fragment, block HTTPS->HTTP downgrade, and reject CRLF/control chars.
  - `open_external_url` ([commands.rs](file:///F:/TORI/final%20tori%20download%20manager/src-tauri/src/commands.rs#L436-L456)) accepts only `http://`/`https://` URLs via direct `rundll32 url.dll,FileProtocolHandler` argv (no shell invocation).
  - Extension & UI permissions follow declared usage (`downloads`, `nativeMessaging`, `webRequest`, `storage`, `tabs`, `activeTab`); Tauri `tauri.conf.json` keeps default WebView2 bundled asset origin (`"csp": null` — recommended optional hardening for a future minor release, not a functional blocker).
- **NSIS Installer Hooks ([hooks.nsh](file:///F:/TORI/final%20tori%20download%20manager/src-tauri/nsis/hooks.nsh#L1-L56)):**
  - `NSIS_HOOK_POSTINSTALL` runs `tdm-native-host.exe --register` to register HKCU Native Messaging hosts.
  - `NSIS_HOOK_PREUNINSTALL` / `NSIS_HOOK_POSTUNINSTALL` clean up HKCU Chrome/Edge/Mozilla NativeMessagingHosts entries and host manifest JSONs while explicitly preserving `%APPDATA%\tori-download-manager\tdm_storage.sqlite` and user downloads.
- **Cryptography & Updater Verification:** `updater_cryptography_tests` (`5/5` passed) verified Ed25519 signature validation over `TORI Download Manager_1.0.5_x64-setup.exe` with `.sig` and strict rejection of tampered payloads/corrupted signatures. Note `TORI Download Manager_1.0.5_x64-setup.exe` is unsigned by Windows Authenticode (expected for RC; EV code-signing deferred to public distribution).

---

## 9. Firefox `v1.0.9` Signing Readiness Review

- **Manifest & Packaging Inspection (`release/v1.0.9-extension-rc/tori-companion-v1.0.9-firefox.zip`):**
  - Validated `42` entries, POSIX forward slashes only (`0` backslashes), no pre-existing `META-INF/*` signature files (ready for AMO upload), `manifest_version: 3`, `version: "1.0.9"`, `browser_specific_settings.gecko.id: "tori-download-manager@toridm.org"`, `strict_min_version: "142.0"`, and `data_collection_permissions.required: ["none"]`.
- **`web-ext lint` Audit & Warning Classification (`0` errors, `7` warnings, `0` notices):**
  - `background.js:1801–1802` (`2` warnings `UNSUPPORTED_API` for `downloads.onDeterminingFilename`): Expected cross-browser guard; Chromium uses `onDeterminingFilename`, Firefox uses `webRequest`.
  - `content.js:709, 836, 1749` & `popup/popup.js:386, 438` (`5` warnings `UNSAFE_VAR_ASSIGNMENT` on `innerHTML`): Inspected all 5 sinks directly — every dynamic string (`title`, `subInfo`, `activeTab`, `dlBtnText`, `toast` text, `filename`, resolution label) is passed through `escapeHtml(...)` or derives strictly from fixed internal SVG path constants (`P.*`) and numeric/boolean formatters. Static AMO linter flags template-literal `innerHTML` patterns generically; not an XSS vulnerability, though migrating those 5 sites to DOM node builders (`createElement`/`textContent`) would silence the linter warning in a future release.
- **Action Required Before Mozilla Distribution:** Operator manual upload/signing via Mozilla AMO (`web-ext sign`) using AMO credentials. Preserved signed `v1.0.7` XPI remains untouched and functional for fallback/regression testing.

---

## 10. Post-Edit Automated Test Matrix

Every check below executed cleanly **after** the final source edits in `tdm-core`, `extension/`, and `scripts/`:

| Suite / Command | Scope | Result | Notes |
|---|---|---|---|
| `cargo test --workspace --no-fail-fast` | All 37 Rust test binaries (`tdm-core`, `tdm-native-host`, `src-tauri`, `tdm-cli`) | `PASS` (`239 passed, 0 failed, 0 ignored`) | Includes new `test_locate_actual_output_file_normalizes_double_extension_safely` |
| `npm --prefix ui run lint` | React/TypeScript frontend `oxlint` | `PASS` (`0 errors, 7 warnings`) | Pre-existing React Compiler hook/effect advisory warnings only |
| `npm --prefix ui run build` | `tsc -b && vite build` | `PASS` | Production bundle built cleanly (`dist/assets/`) |
| `node --check extension/**/*.js` | All 8 Chromium & Firefox extension JS files | `PASS` | Zero syntax errors |
| `npx --no-install web-ext lint` | Built `tori-companion-v1.0.9-firefox.zip` | `PASS` (`0 errors, 7 warnings, 0 notices`) | Warnings classified & verified safe in Section 9 |
| `node scripts/verify_gate29_1_idm_desktop_ui.js` | Gate 29.1 Desktop IDM UI, 1,200-row virtualization, dark/light/accent persistence, tray & memory | `PASS` (`20 PASS, 0 FAIL`) | OEM DB SHA-256 unchanged |
| `node scripts/verify_gate29_2_idm_progress_window.js` | Gate 29.2 Progress Window full/compact layout, `<=1 Hz` updates, AOT, per-job speed limit, completion opts, fail/retry | `PASS` (`17 PASS, 0 FAIL`) | OEM DB SHA-256 unchanged |
| `node scripts/verify_gate29_3_idm_extension_ui.js` | Gate 29.3 Cross-browser Chrome + Edge + Firefox `v1.0.9` UI, YouTube quality/audio/SPA/Playlist/tray, MKV, drag, fallback/recovery | `PASS` (`23 PASS, 0 FAIL, 0 TIMEOUT, 0 NOT TESTED`) | Verified `T06-YT-VID` `dbPath === diskPath` (`WING IT! - Blender Open Movie.mkv`); signed `v1.0.7` XPI & OEM DB unchanged |
| `node scripts/verify_gate27_8_large_mkv_and_classification.js` | Gate 27.8 Rebuilt NSIS silent install, `2.30 GiB` (`2,469,606,195 B`) MKV pause/resume & SHA-256, Chrome/Edge/Firefox `v1.0.7` classification | `PASS` (`10 PASS, 0 FAIL, 0 TIMEOUT, 0 NOT TESTED`) | Exact `2.30 GiB` SHA-256 match in `7.03s` |
| `node scripts/verify_gate29_4_final_integration.js` | Gate 29.4 Clean NSIS install & fresh boot, pre-`v1.0.5` DB upgrade & `.tdm-part` resume, 401/400/404/500 recovery, process-kill crash recovery, concurrency cap & disk delete, global+per-job throttle, live YouTube `360p`/`720p`/`1080p`/Audio `ffprobe` + synced paths, Firefox `v1.0.9` MKV & playlist item download, `6x16 MiB` sustained load stability | `PASS` (`17 PASS, 0 FAIL, 0 TIMEOUT, 0 NOT TESTED`) | OEM DB & signed `v1.0.7` XPI SHA-256 unchanged |
| Clean Windows VM hardware test | Completely separate physical/VM machine install without prior Edge/WebView2 caches | `NOT TESTED` | Tested instead via isolated profile (`/S /D=`, fresh `TORI_DATA_DIR`, fresh `WEBVIEW2_USER_DATA_FOLDER`, fresh browser profiles) |

---

## 11. Publication & Operator Next Steps

1. Review Desktop `v1.0.5` RC artifacts in [release/v1.0.5-rc/](file:///F:/TORI/final%20tori%20download%20manager/release/v1.0.5-rc) and Browser Companion `v1.0.9` RC packages in [release/v1.0.9-extension-rc/](file:///F:/TORI/final%20tori%20download%20manager/release/v1.0.9-extension-rc).
2. *(Optional for production distribution)* Authenticode-sign Windows binaries/installer if distributing publicly under EV code signing.
3. Upload `release/v1.0.9-extension-rc/tori-companion-v1.0.9-firefox.zip` to Mozilla Add-ons (`AMO`) to obtain the signed Firefox `v1.0.9` XPI, then run `scripts/inspect_signed_xpi.js` / integration check on the signed XPI.
4. Submit `release/v1.0.9-extension-rc/tori-companion-v1.0.9-chromium.zip` to Chrome Web Store and Microsoft Edge Add-ons when authorized.
5. Publish Desktop `v1.0.5` release assets and update production updater `latest.json` & website downloads only when explicitly authorized.
