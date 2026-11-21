# TORI Download Manager — Gate 31.4 Report
## Replace Legacy Download Toast with IDM Progress Window

- **Date:** 2026-11-21
- **Branch:** `fix/gate27-runtime-fixes`
- **Public Baselines Preserved Untouched:** Desktop `v1.0.5` (`91f883a`), Browser Companion `v1.0.10` (`28fae57`)
- **Prepared Local Patch Release Candidate:** Desktop `v1.0.6` (`release/v1.0.6-rc/`, local unpublished)
- **Overall Verification Status:** **`PASS` (Zero failures across all acceptance & regression suites)**

---

## 1. Root Cause Analysis (Phase 1)

Runtime forensic inspection of the running host process, Windows Registry, `%APPDATA%\tori-download-manager\logs\lifecycle.log`, `%APPDATA%\tori-download-manager\tdm_storage.sqlite`, the public GitHub `v1.0.5` release assets, and the current source tree established **one primary operational/installer root cause** explaining why the old dark floating toast appeared on the project owner's machine, plus **four genuine code-level defects in Desktop `v1.0.5`** that warranted a `v1.0.6` Desktop patch RC.

### 1.1 Primary Cause of Legacy Dark Floating Toast on the Owner's Machine

1. **Stale `v1.0.4` binary was actually running (`PID 18396`), not `v1.0.5`:**
   - The active process `PID 18396` was `C:\Users\ritud\AppData\Local\TORI Download Manager\tori-download-manager.exe` with PE `ProductVersion = 1.0.4` (built `2026-11-12 22:47:38`, `30,163,456` B, SHA-256 `dd1faf8aba7fe1d8ffc2ee36b8fd5c899b6cbed3e139d0fbd6aa2b5ed2d4cf56`).
   - Binary inspection confirmed this `v1.0.4` executable embeds pre-Gate 29.1/29.2 frontend assets (`assets/index-Bmc6aRYX.js`, `assets/index-DJJfyW7V.css`) and legacy `"progress_toast"` / `"TORI Download - "` window logic (zero Gate 29.2 commands: no `get_download_status_details`, `set_download_speed_limit`, `set_download_completion_options`, or `progress-restore-full`).
   - Live isolated execution of this exact binary (`00_before_legacy_v104_dark_toast.png`) reproduced the dark floating pill toast with circular SVG progress ring (`legacyToast: true, isIdm: false`).
2. **Why installing public `v1.0.5` did not replace `v1.0.4`:**
   - During Gate 30.2 QA (`2026-11-18`), a silent NSIS test (`/S /D=%TEMP%\tori_g30_2_install_qa\desktop_install`) wrote the temporary QA directory into `HKCU\Software\tori\TORI Download Manager` (`MANUPRODUCTKEY`) and `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\TORI Download Manager` (`InstallLocation`), and did not restore `HKCU\Software\tori\TORI Download Manager`.
   - When the owner ran the public `v1.0.5` installer on `2026-11-21` at `13:55:34` local (`07:55:34 UTC`):
     1. NSIS `RestorePreviousInstallLocation` read `HKCU\Software\tori\TORI Download Manager` and installed `v1.0.5` into `C:\Users\ritud\AppData\Local\Temp\tori_g30_2_install_qa\desktop_install\`, leaving `v1.0.4` untouched in `%LOCALAPPDATA%\TORI Download Manager\`.
     2. During NSIS extraction (`07:55:28 UTC`), browser Native Messaging (still pointing to `v1.0.4`'s `tdm-native-host.exe` until `POSTINSTALL`) respawned `v1.0.4` (`PID 18396`, `--minimized`), which bound the Named Pipe `\\.\pipe\tori-download-manager-ipc`.
     3. When `v1.0.5` finished installing (`07:55:34 UTC`) and launched (`PID 30864`, `07:55:35 UTC`), its single-instance check connected to `v1.0.4`'s Named Pipe and immediately exited (`SECONDARY_INSTANCE: Active primary instance detected; is_minimized=true; exiting secondary process`).
     4. Twelve seconds later (`07:55:47 UTC`), the owner's YouTube download was served by `PID 18396` (`v1.0.4`), which rendered the old dark floating toast.
3. **User preferences did NOT suppress the new window:**
   - Inspection of `%APPDATA%\tori-download-manager\tdm_storage.sqlite` (`engine_settings.app_settings`) confirmed `"showDownloadPopup": "always"`, `"alwaysOnTop": true`, `"closeToTray": true`, `"theme": "dark"`, `"accent": "rose"`.

### 1.2 Code-Level Defects Identified in Desktop `v1.0.5` Source

| # | Defect | Root Cause in `v1.0.5` Source | Impact |
|---|---|---|---|
| 1 | **Fragmented download progress window triggers** | `DownloadManager::start_job_internal` did not emit `DownloadEvent::OpenProgressWindow`. Only HTTP `/api/v1/downloads` (new jobs), `/api/v1/media/download`, `create_media_download`, and manual `App.tsx:handleAddUrls` opened the window. | Browser Native Messaging `start_download` fallback (`tdm-native-host/src/lib.rs:468`), auto-promoted queued jobs (`manager.rs:2007`), due scheduled jobs (`manager.rs:276`), playlist items (`enqueue_playlist_items`), coalesced queued browser jobs (`server.rs:596`), and resumed/retried jobs never opened the progress window automatically. |
| 2 | **Concurrent duplicate-window creation race** | `open_progress_window_internal` checked `app.get_webview_window(&label)` and called `WebviewWindowBuilder::build()` without a creation lock. | Concurrent triggers for the same job ID could race before WebView registration. |
| 3 | **Legacy HTML overlay fallback & legacy `"progress_toast"` artifacts** | `ui/src/App.tsx` still imported and mounted `<ProgressModal>` on `open_progress_window` failure; `commands.rs` and `capabilities/default.json` retained `"progress_toast"` fallbacks; `SettingsModal.tsx` still read `"Always show floating toast during download"`. | Violated strict single native IDM progress window lifecycle and left misleading legacy toast terminology. |
| 4 | **NSIS upgrade stale-process respawn race** | `src-tauri/nsis/hooks.nsh` registered the new `tdm-native-host.exe` in `NSIS_HOOK_POSTINSTALL` without clearing any stale `tori-download-manager.exe` respawned by the browser during file extraction. | Upgraded binaries could immediately exit as `SECONDARY_INSTANCE` against a pre-upgrade process still holding the Named Pipe. |

---

## 2. Installed-Version & Source Comparison (Phase 5)

| Artifact / Source | Version | Gate 29.2 Included? | Embedded UI Assets | Rust Progress Commands & Window Logic | Size (Bytes) | SHA-256 |
|---|---|---|---|---|---:|---|
| **Gate 29.2 Verified Source** (`checkpoint-gate29_2-verified`, `f38fb44`) | `1.0.5` | **Yes** | `.dl-popup-root` IDM Progress Window | Per-job `progress_<id>`, `get_download_status_details`, `set_download_speed_limit`, `set_download_completion_options` | — | git `f38fb44` |
| **Public Desktop `v1.0.5` Installer** (`GitHub v1.0.5` / `release/v1.0.5-v1.0.9-final-rc/Desktop/TORI Download Manager_1.0.5_x64-setup.exe`) | `1.0.5` | **Yes** | `assets/index-CVJEcYck.js`, `assets/index-Cw3WdOiX.css` (Gate 29.2 IDM UI) | Uses Gate 29.2 `progress_<id>` window creation (same source as `f38fb44` for all progress files) | `117,783,770` | `cab4156fc85a42ce74d5d4292e2976223ba14ad4c8e7d5bbfea533e4ca72f3cb` |
| **Public Desktop `v1.0.5` Binary** (`release/v1.0.5-v1.0.9-final-rc/Desktop/tori-download-manager.exe`) | `1.0.5` | **Yes** | `assets/index-CVJEcYck.js`, `assets/index-Cw3WdOiX.css` | Gate 29.2 `progress_<id>` + speed limiter + completion options | `30,723,072` | `629ebc63afe94a1240a4bc79802502c188bfbf6b8d0f24e0005e350f4a5f0f4a` |
| **QA-Dir Installed `v1.0.5` Binary** (`%TEMP%\tori_g30_2_install_qa\desktop_install\tori-download-manager.exe`) | `1.0.5` | **Yes** | `assets/index-CVJEcYck.js`, `assets/index-Cw3WdOiX.css` | Byte-identical to standalone `v1.0.5` except Tauri's 3-byte `_NSS` bundle tag | `30,723,072` | `f4121f9e4b2b9026e22239c49bd212f67f2a16e188399892f8fed28a84bad46f` |
| **Owner's Running Installed Binary** (`%LOCALAPPDATA%\TORI Download Manager\tori-download-manager.exe`, `PID 18396`) | **`1.0.4`** | **NO** | `assets/index-Bmc6aRYX.js`, `assets/index-DJJfyW7V.css` (**Old dark floating toast**) | Legacy single `"progress_toast"` window (`"TORI Download - "`), no Gate 29.2 commands | `30,163,456` | `dd1faf8aba7fe1d8ffc2ee36b8fd5c899b6cbed3e139d0fbd6aa2b5ed2d4cf56` |
| **New Patched Desktop `v1.0.6` RC Installer** (`release/v1.0.6-rc/TORI Download Manager_1.0.6_x64-setup.exe`, local unpublished) | **`1.0.6`** | **Yes + Gate 31.4 fixes** | `assets/index-D4gHaFZf.js`, `assets/index-Cw3WdOiX.css` (zero legacy `ProgressModal` fallback) | Unified `start_job_internal` trigger, async creation mutex, zero `progress_toast` fallback, NSIS postinstall stale-process guard | `117,776,703` | `8454b90900c6e60624af3555330eaa18ba48351785f056df9039f2d0cd621f9c` |

**Conclusion on Public `v1.0.5`:** Gate 29.2 **was** included in the public Desktop `v1.0.5` installer and production `v1.0.5` binary. However, the owner's active executable in `%LOCALAPPDATA%\TORI Download Manager\` was still `v1.0.4`, AND `v1.0.5` contained real lifecycle/pathway/race/installer defects that are resolved in the new local **`v1.0.6`** Desktop RC.

---

## 3. Changed Files

- **`crates/tdm-core/src/engine/manager.rs`:**
  - Emit `DownloadEvent::OpenProgressWindow { id }` inside `DownloadManager::start_job_internal` immediately when any download enters active execution (`Downloading` / `Probing`), unifying browser HTTP, browser Native Messaging, manual HTTP, manual media, playlist, queued auto-promotion, scheduled admission, resume, and retry onto one trigger.
  - Added `create_managed_media_download_with_all_options_scheduled_and_start(..., auto_queue: bool)` so paused-on-add (`startImmediately = false`) media downloads stay `Paused` without prematurely launching or opening a progress window.
- **`crates/tdm-native-host/src/server.rs`:**
  - Removed duplicate manual `OpenProgressWindow` emissions in `/api/v1/downloads` and `/api/v1/media/download` (now handled uniformly via `start_download` -> `start_job_internal`), while preserving explicit `POST /api/v1/downloads/:id/progress`.
- **`src-tauri/src/commands.rs`:**
  - Added `PROGRESS_WINDOW_CREATE_LOCK` (`tokio::sync::Mutex<()>`) inside `open_progress_window_internal` to guarantee strictly one `progress_<sanitized_id>` window per job even under concurrent triggers.
  - Added structured `[PROGRESS_WINDOW]` (`OPEN` / `REUSE` / `SKIPPED`) lifecycle logging.
  - Added optional `start_immediately: Option<bool>` (default `true`) to `create_download`, and removed redundant `open_progress_window_internal` from `create_media_download`.
  - Removed legacy `"progress_toast"` window fallbacks from `update_toast_bounds` and `hide_toast_window`.
- **`src-tauri/capabilities/default.json` & `src-tauri/gen/schemas/capabilities.json`:**
  - Removed legacy `"progress_toast"` capability target; retained `["main", "progress_*"]`.
- **`ui/src/App.tsx`:**
  - Removed legacy `<ProgressModal>` HTML overlay import, state, and fallback rendering (`handleOpenProgress` strictly opens the native `progress_<id>` window and surfaces a status message on error rather than rendering a fake HTML overlay).
  - Passed `startImmediately` to `create_download` and removed redundant frontend `open_progress_window` / `pause_download` calls.
- **`ui/src/components/SettingsModal.tsx`:**
  - Updated popup preference description copy from `"Always show floating toast during download"` to `"Always show download progress window"` (plus `"Show progress window on start only"` / `"Never show progress window automatically"`), and updated fallback default version to `1.0.6`.
- **`src-tauri/nsis/hooks.nsh`:**
  - Hardened `NSIS_HOOK_POSTINSTALL` to terminate any stale `tori-download-manager.exe` respawned by a browser Native Messaging host during extraction immediately after `--register`.
- **Version Metadata (`1.0.5` -> `1.0.6`):** `Cargo.toml`, `Cargo.lock`, `src-tauri/tauri.conf.json`, `ui/package.json`. (`extension/` untouched at `v1.0.10`; `release/v1.0.5*` untouched.)
- **Tests & Verification Harness:**
  - `crates/tdm-core/tests/gate29_2_progress_backend_tests.rs` (added `test_start_and_queued_promotion_emit_open_progress_window_uniformly`)
  - `crates/tdm-core/tests/updater_cryptography_tests.rs` (preserved `v1.0.5` verification + added `test_v106_release_candidate_signature_cryptographic_verification`)
  - `scripts/verify_gate31_4_toast_replacement.js` (new 10-scenario packaged-app acceptance suite + live Before/After screenshot capture)
  - `scripts/verify_gate29_1_idm_desktop_ui.js` (dynamic Desktop version lookup from `tauri.conf.json`)
  - `scripts/verify_gate29_4_final_integration.js` (dynamic RC version lookup + added `HKCU\Software\tori\TORI Download Manager` backup/restore in OEM state guard)

---

## 4. Before / After Screenshots

All screenshots were captured directly from live WebView2 windows during isolated execution and visually inspected:

| Stage / Scenario | Screenshot | Verified Visual Evidence |
|---|---|---|
| **BEFORE (Stale Installed `v1.0.4`)** | `docs/reports/screenshots/gate31_4/00_before_legacy_v104_dark_toast.png` | Legacy dark floating pill toast (`large-http-file.bin`, pink circular SVG ring, `3.1 of 12.6 MB · 1.57 MB/s`, `6s left`) reproduced directly from `%LOCALAPPDATA%\TORI Download Manager\tori-download-manager.exe` (`v1.0.4`). |
| **AFTER (Packaged `v1.0.6` Light Progress Window)** | `docs/reports/screenshots/gate31_4/02_after_idm_progress_light.png` | Standalone 460px native IDM progress window (`11% large-http-file.bin`), 3 tabs (`Download status`, `Speed limiter`, `Options on completion`), live transfer rate `1.36 MB/s`, `Connections : 2`, 2 segment bars, `Cancel` / `Pause`. |
| **AFTER (Packaged `v1.0.6` Dark Progress Window — Resumed)** | `docs/reports/screenshots/gate31_4/05_after_idm_progress_dark_resumed.png` | Dark + Ocean native IDM progress window (`33% large-http-file.bin`), `4.3 MB ( 33.98 % )`, `1.30 MB/s`, `Connections : 2`, live theme propagation without restart. |
| **AFTER (Paused State)** | `docs/reports/screenshots/gate31_4/04_paused_download_dark.png` | `25% Paused - large-http-file.bin`, muted grey bar & segments, `Connections : 0`, `Cancel` / `Resume`. |
| **AFTER (Small HTTP Completed)** | `docs/reports/screenshots/gate31_4/01_small_http_completed.png` | `Download complete`, green 100% progress bar, `Open containing folder`, `Close` / `Open`. |
| **AFTER (Desktop Main Window — Light & Dark)** | `docs/reports/screenshots/gate31_4/03_desktop_main_window_light.png`<br>`docs/reports/screenshots/gate31_4/06_desktop_main_window_dark.png` | Desktop Main Window synchronized live with active progress (`large-http-file.bin` & completed `small-manual.txt`) in both Light and Dark themes. |
| **AFTER (Browser-Captured MKV)** | `docs/reports/screenshots/gate31_4/07_browser_captured_mkv.png` | Browser-captured `browser-captured-movie.mkv` (`26%`, `1.54 MB/s`, `Connections : 2`) rendered in the exact same IDM progress window. |
| **AFTER (YouTube Video & Audio)** | `docs/reports/screenshots/gate31_4/08_youtube_video_progress.png`<br>`docs/reports/screenshots/gate31_4/09_youtube_audio_progress.png` | Real YouTube video (`341 KB/s`, valid 9.37 MB muxed MKV via `ffprobe`) and YouTube audio (`27%`, `2.14 MB/s`, valid 3.79 MB M4A via `ffprobe`) inside the native IDM progress window. |
| **AFTER (Main Window Hidden in Tray)** | `docs/reports/screenshots/gate31_4/10_tray_hidden_progress_window.png` | Standalone native IDM progress window (`tray-bg.bin`, `Download complete`) running independently while Main Window stayed hidden in system tray (`isVisible === false`). |

---

## 5. Download Lifecycle Verification (Phase 4 — Packaged `v1.0.6` RC)

Executed against the silently installed packaged `release/v1.0.6-rc/TORI Download Manager_1.0.6_x64-setup.exe` (`ProductVersion = 1.0.6`):

| # | Acceptance Scenario | Check ID | Result | Observed Evidence |
|---|---|---|---|---|
| 1 | Small HTTP file (manual add) | `T01-SMALL-HTTP` | **PASS** | Opened 1 IDM progress window (`targets=1`), zero legacy toast, reached `Download complete`, exact SHA-256 on disk. |
| 2 | Large HTTP file (12 MiB multi-range) | `T02-LARGE-HTTP` | **PASS** | Live progress advanced (`11.33%` -> `25.39%`, `1.69 MB/s`, `Connections=2`), closing window mid-transfer did not cancel (`closedMidTransfer=true`), exact SHA-256 on disk. |
| 3 | Browser-captured MKV (+ Native Messaging) | `T03-BROWSER-MKV` | **PASS** | Both HTTP `/api/v1/downloads` (`browser-captured-movie.mkv`, `26%`, exact SHA-256) and Native Messaging `start_download` (`native-msg-capture.bin`) opened unified IDM progress window (`targets=1`, zero legacy toast). |
| 4 | YouTube video (real YouTube URL) | `T04-YT-VIDEO` | **PASS** | Resolved format `605+251+251`, opened 1 IDM progress window, completed to `9,369,786` B valid video+audio MKV (`ffprobe`: `hasVideo=true, hasAudio=true`). |
| 5 | YouTube audio (real YouTube URL) | `T05-YT-AUDIO` | **PASS** | Opened 1 IDM progress window (`27%`, `2.14 MB/s`), completed to `3,792,926` B valid audio file (`ffprobe`: `hasAudio=true`). |
| 6 | Multiple simultaneous + queued promotion | `T06-MULTI-QUEUED`, `T06B-ADD-PAUSED-START` | **PASS** | 3 simultaneous downloads opened 3 independent IDM windows (`1` per job, zero duplicates); queued 4th opened automatically on slot promotion; `startImmediately=false` suppressed premature popup until resumed. |
| 7 | Paused download | `T07-PAUSED` | **PASS** | Pause switched state to `paused`, `Connections : 0`, button to `Resume`, live Dark + Ocean theme applied. |
| 8 | Resumed download | `T08-RESUMED` | **PASS** | Resume continued from paused bytes (`41.21%`, `Connections : 2`) in the same window (`targets=1`). |
| 9 | Completed download | `T09-COMPLETED` | **PASS** | Reopened completed job displayed `Download complete`, `100.00 %`, `Close` / `Open`, `Open containing folder`. |
| 10 | Main window hidden in system tray + pref respect | `T10-TRAY-AND-PREF` | **PASS** | Main window closed to tray (`isVisible=false`), new download opened standalone IDM progress window while main remained hidden (`mainStillHidden=true`, exact SHA-256); `showDownloadPopup="never"` suppressed auto-open (`poppedUnderNever=false`, logged in `lifecycle.log`). |

---

## 6. Test & Regression Results (Phase 6)

| Suite | Command | Result |
|---|---|---|
| **Touched UI Lint** | `npx --prefix ui oxlint ui/src/App.tsx ui/src/components/SettingsModal.tsx ui/src/components/DownloadToast.tsx` | **PASS** (`0 warnings, 0 errors`) |
| **UI Production Build** | `npm --prefix ui run build` | **PASS** (`tsc -b && vite build`, `363.47 kB` JS, legacy `ProgressModal` removed) |
| **Rust Workspace Unit & Integration Tests** | `cargo test --workspace --no-fail-fast` | **PASS** (`38 suites, 251 passed, 0 failed, 0 ignored` + `test_start_and_queued_promotion_emit_open_progress_window_uniformly`) |
| **Gate 30 Updater Cryptography Tests (`v1.0.5` + `v1.0.6`)** | `cargo test --workspace --test updater_cryptography_tests` | **PASS** (`7 passed, 0 failed` — Ed25519 Minisign verification & tamper rejection for both frozen `v1.0.5` and new `v1.0.6` RC) |
| **Gate 31.4 Real Download Acceptance (Packaged `v1.0.6` RC)** | `node scripts/verify_gate31_4_toast_replacement.js` | **PASS** (`PASS=15, FAIL=0`, OEM SQLite SHA-256 unchanged) |
| **Gate 29.2 IDM Progress Window Regression** | `node scripts/verify_gate29_2_idm_progress_window.js` | **PASS** (`PASS=17, FAIL=0` — compact mode `38px`, `<= 1 Hz` cadence, Always-on-Top live toggle, per-job speed limiter `180 KB/s`, completion auto-close + desktop notification) |
| **Gate 29.1 Desktop Main Window & Settings UI Regression** | `node scripts/verify_gate29_1_idm_desktop_ui.js` | **PASS** (`PASS=20, FAIL=0` — `Version 1.0.6` in About tab, `1,200`-row virtualization, Close-to-Tray persistence) |
| **Gate 29.4 Final Integration Regression (`v1.0.6` RC)** | `node scripts/verify_gate29_4_final_integration.js` | **PASS** (`17 PASS, 0 FAIL, 0 TIMEOUT, 0 NOT TESTED` — clean NSIS install, pre-v1.0.5 DB upgrade & `.tdm-part` resume, crash recovery, YouTube 360p/720p/1080p/Audio + playlist, Chrome/Firefox parity, 6x16 MiB load stability) |
| **Gate 30 / 31 Live Public Baseline & Extension Integrity** | `node scripts/verify_gate31_3_live_release.js` | **PASS** (`23 / 23 PASSED (100.0%)` — public GitHub `v1.0.5`, `latest.json`, `toridownload.xyz`, Browser Companion `v1.0.10`, and frozen `release/v1.0.5-v1.0.9-final-rc/` verified 100% untouched) |

---

## 7. Required Desktop Patch Version & Staged Local RC

- **Required Desktop Patch Version:** **`v1.0.6`** (local unpublished RC staged in `release/v1.0.6-rc/`).
- **Browser Companion Version:** **`v1.0.10`** — **no change required** (verified fully compatible with Desktop `v1.0.6`).
- **Staged Local `release/v1.0.6-rc/SHA256SUMS.txt`:**
  ```
  2d8286a091caed95979893a1c2e7941163a8acf417d916d01bf31d6b72f58e76  tdm-cli.exe
  d02da8be8056cd987bd4b5cdca9535a016f60bcb7cbed94fb43d56c042967671  tdm-native-host.exe
  8454b90900c6e60624af3555330eaa18ba48351785f056df9039f2d0cd621f9c  TORI Download Manager_1.0.6_x64-setup.exe
  e134727ca16ffd1cfed3703a69cebd7e34d1705a17747e56a7731f7cdbd7e450  TORI Download Manager_1.0.6_x64-setup.exe.sig
  067739ae7f103e5dec85dad2b58d49509d4646b3d834ea5acc1a476b8cddfd31  tori-download-manager.exe
  ```
- **Operator Local Installation Note:** On the operator's host machine, before installing `v1.0.6` interactively, close the running `v1.0.4` tray process (`%LOCALAPPDATA%\TORI Download Manager\tori-download-manager.exe`) and select `%LOCALAPPDATA%\TORI Download Manager` as the install folder (or remove the stale Gate 30.2 QA registry entry at `HKCU\Software\tori\TORI Download Manager` pointing to `%TEMP%\tori_g30_2_install_qa\desktop_install`) so `v1.0.6` cleanly replaces the stale `v1.0.4` directory.

---

## 8. Remaining Limitations

1. **Windows Authenticode Signing (`NotSigned`):** The `v1.0.6` RC NSIS installer and binaries remain unsigned with a commercial Authenticode PE certificate (Minisign Ed25519 updater signature `.sig` is present and verified).
2. **Independent Clean Windows VM Testing:** Not performed (`NOT TESTED`); isolated host installation directories, profiles, and registry backup/restore were used instead.
3. **Unpublished Local Release Candidate:** Per Gate 31.4 release-freeze rules, nothing has been published to GitHub, `latest.json` has not been modified, the website has not been updated, and the operator's live `%APPDATA%` database and `%LOCALAPPDATA%\TORI Download Manager` directory were left untouched pending operator review.
