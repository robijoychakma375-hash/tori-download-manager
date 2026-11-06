# TORI Download Manager v2.0 — Milestone Plan: Gate 13.2
## Self-Contained Windows NSIS Installer

### Objective
Create a reliable, professional Windows NSIS installer that packages TORI Download Manager v2.0 with all required companion binaries and external dependencies, running self-contained on a clean Windows 10/11 x64 machine without requiring Rust, Node.js, Python, WinGet, or separately installed FFmpeg.

---

### Specific Measurable Next Milestones

#### Milestone 1: Dependency & Licensing Audit for Standalone Packaging
- [x] Audit existing system binaries (`ffmpeg.exe`, `ffprobe.exe`, `yt-dlp.exe`) in WinGet packages directory.
- [x] Create staging directory `resources/bin/` and copy verified binaries alongside companion executables (`tdm-native-host.exe`, `tdm-cli.exe`).
- [x] Audit licensing requirements (FFmpeg GPL v3 / LGPL, yt-dlp Unlicense, Rust MIT/Apache-2.0) and create `resources/LICENSE-THIRD-PARTY.txt`.

#### Milestone 2: Tauri v2 NSIS Packaging Configuration & Branded Metadata
- [x] Update `src-tauri/tauri.conf.json` with product version `2.0.0`, official icons, and `bundle.resources` mapping to include `resources/bin/*` and third-party license notices.
- [x] Configure NSIS installer branding: Start Menu shortcut, desktop shortcut option, official TORI Torii-gate icon.

#### Milestone 3: Native Messaging Post-Install Registration & Uninstall Hooks
- [x] Verify and update `src-tauri/nsis/hooks.nsh` to invoke `tdm-native-host.exe --register` at `$INSTDIR\resources\bin\tdm-native-host.exe` (or `$INSTDIR\resources\tdm-native-host.exe`) so `%APPDATA%\tori-download-manager\com.tori.download_manager.json` points to the real installed binary.
- [x] Verify clean uninstallation hook removes Native Messaging host manifest and HKCU registry keys for Chrome and Edge while preserving user SQLite database and downloaded media.

#### Milestone 4: NSIS Installer Build & Clean Windows Verification
- [x] Build release installer via `cargo tauri build --bundles nsis`.
- [x] Inspect generated NSIS installer in `target/release/bundle/nsis/` (filename, size, SHA-256).
- [x] Test clean Windows environment compatibility: simulate zero-PATH environment (`PATH` cleared of WinGet and dev tools) and verify discovery of bundled `ffmpeg`, `ffprobe`, `yt-dlp`.
- [x] Run regression suite: `cargo check --workspace`, `cargo test --workspace`, production release guard `verify_production_release.ps1`.

#### Milestone 5: Final Engineering Report & Status Update
- [x] Create `docs/reports/GATE13_2_NSIS_INSTALLER_REPORT.md` documenting inventory, licensing, hashes, and verification.
- [x] Update `IMPLEMENTATION_STATUS.md`.

---

# TORI Download Manager v2.0 — Milestone Plan: Gate 13.2.1
## Final Installer Quality Assurance & Dependency Provenance Audit

### Objective
Perform an exhaustive, forensic release-quality audit of the TORI Download Manager v2.0 self-contained NSIS installer before public release or Gate 13.3. Verify packaged binary identity, resolve FFmpeg provenance and licensing obligations, validate installed runtime execution under scrubbed system PATH, verify browser integration and uninstallation data preservation.

### Milestones
- [x] **Milestone 1: Verify packaged binary identity & forensic hash resolution**
  - Confirmed 3-byte Tauri NSIS bundle patching mechanism (`BUNDLE_TYPE_VAR_UNK` -> `BUNDLE_TYPE_VAR_NSS`) at offset `0x15152a2`.
  - Confirmed `FileVersion: 2.0.0` and `ProductVersion: 2.0.0` on installed binary.
  - Resolved clerical table transcription in Gate 13.2 report.
- [x] **Milestone 2: Resolve FFmpeg provenance and licensing obligations**
  - Traced exact source: Windows Package Manager package `yt-dlp.FFmpeg` (`https://github.com/yt-dlp/FFmpeg-Builds` autobuild fork of BtbN with `--prefix=/ffbuild/prefix`).
  - Resolved erroneous Gyan.dev narrative reference.
  - Updated `resources/LICENSE-THIRD-PARTY.txt` with exact upstream and build recipe repository links under GNU GPLv3.
- [x] **Milestone 3: Verify actual installed runtime dependencies under scrubbed PATH**
  - Executed tests using installed sandbox directory `target/qa_install_test` under `PATH = C:\Windows\system32;C:\Windows;C:\Windows\System32\Wbem`.
  - Verified `yt-dlp.exe`, `ffmpeg.exe`, `ffprobe.exe`, and `tdm-cli.exe` execute cleanly without external PATH dependencies.
  - Tested synthetic video encoding, remuxing, and stream validation via installed FFmpeg/FFprobe.
  - Downloaded and verified public MDN `flower.mp4` via installed CLI.
- [x] **Milestone 4: Verify browser integration & Native Messaging**
  - Verified `%APPDATA%\tori-download-manager\com.tori.download_manager.json` dynamically points to installed host binary.
  - Verified Chrome and Edge HKCU registry keys.
  - Verified bidirectional Native Messaging IPC (`ping` -> `pong`, `pair`).
- [x] **Milestone 5: Verify uninstaller & user data preservation**
  - Verified `$INSTDIR\uninstall.exe /S` removes installed program files, registry keys, and host manifest.
  - Verified `%APPDATA%\tori-download-manager\tdm_storage.sqlite` and `thumbnails/` are strictly preserved.
- [x] **Milestone 6: Regression Verification & QA Report Delivery**
  - Rebuilt final NSIS installer with updated CLI and third-party notices (`116,488,233 bytes`, SHA-256 `6E1D8B0A...`).
  - Passed 15/15 installer QA tests, 139/139 workspace tests, 15/15 release guard checks, 15/15 browser E2E assertions.
  - Created `docs/reports/GATE13_2_1_INSTALLER_QA_REPORT.md`.

---

# TORI Download Manager v2.0 — Milestone Plan: Gate 13.3
## Crash Diagnosis, System Tray & Background Downloads

### Objective
Resolve the root cause of unexpected TORI application exits, implement a resilient Windows System Tray using the official TORI icon with Close-to-Tray behavior enabled by default, decouple background download execution and the 127.0.0.1:6800 desktop API from WebView2 window visibility, and verify uninterrupted background download completion from both the desktop UI and browser extension.

---

### Specific Measurable Next Milestones

#### Milestone 1: Application Lifecycle Diagnosis & Root Cause Analysis
- [x] Implement bounded, rotating lifecycle diagnostics logger in `%APPDATA%\tori-download-manager\logs\lifecycle.log` with token/URL redaction.
- [x] Audit Tauri v2 window and process lifecycle: trace `window_close`, `CloseRequested`, `ExitRequested`, Rust panics, and single-instance handoff.
- [x] Empirically prove whether unexpected closes are graceful exits, crashes, window destruction without process holding, or external kills.

#### Milestone 2: Windows System Tray & Close-to-Tray Implementation
- [x] Add `tray-icon` feature to `tauri` in `src-tauri/Cargo.toml`.
- [x] Build Windows System Tray in `src-tauri/src/lib.rs` with official Torii-gate icon (`src-tauri/icons/icon.ico`).
- [x] Implement Tray menu: Open TORI, Active Downloads, Pause All, Resume All, Exit TORI.
- [x] Add tray left-click handler to unminimize, show, and focus the existing main window.
- [x] Intercept main window `CloseRequested` and `window_close` command to hide the main window to tray instead of destroying it when "Close to Tray" is enabled (default `true`).
- [x] Persist "Close to Tray" setting in SQLite `app_settings` (`close_to_tray: true`).
- [x] Implement safe explicit Exit with active download confirmation and clean shutdown.

#### Milestone 3: Desktop API & Background Download Decoupling
- [x] Ensure Axum server on port 6800 and Named Pipe IPC continue uninterrupted when main window is hidden.
- [x] Verify browser extension remains connected and does not report "Could not connect to TORI Desktop".
- [x] Verify independent download Toast window (`progress_toast`) opens and updates while main window is hidden.
- [x] Verify Toast interactive controls (Pause, Resume, Cancel) function in background.

#### Milestone 4: Real Background Download Acceptance Verification
- [x] Start real HTTP download, close main window to tray, verify continuous background progress and file completion.
- [x] Enqueue download from browser extension while main window is hidden, verify job creation and completion.
- [x] Restore main window and verify both jobs in SQLite and filesystem.
- [x] Validate completed files via `ffprobe.exe`.

#### Milestone 5: Regression Suite & Final Deliverable
- [x] Run `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`.
- [x] Run `npm --prefix ui run build` and `cargo tauri build --no-bundle`.
- [x] Run production release guard `scripts/verify_production_release.ps1`.
- [x] Measure and document main TORI process and WebView2 RAM usage in background.
- [x] Deliver `docs/reports/GATE13_3_CRASH_TRAY_BACKGROUND_REPORT.md` and commit.

---

# TORI Download Manager v2.0 — Milestone Plan: Gate 13.3.1
## Final System Tray & Background Lifecycle Verification

### Objective
Verify and stress-test the complete application lifecycle across all edge cases: Close-to-Tray ON vs OFF (orphan process prevention), setting persistence across restarts, floating Download Toast visibility and controls (Pause/Resume/Cancel) while hidden, tray menu actions, authenticated desktop API reachability, panic/crash differentiation, and NSIS installer currency audit.

---

### Specific Measurable Next Milestones

#### Milestone 1: Close-to-Tray ON vs OFF & Orphan Process Prevention
- [x] Test `closeToTray = false`: clicking X closes window, `prevent_exit()` is NOT called, and TORI terminates completely with exit code 0 leaving zero orphan processes.
- [x] Test `closeToTray = true`: clicking X hides window, `prevent_exit()` is called, and background tasks remain alive.
- [x] Verify `closeToTray` setting survives application restart and is restored from SQLite `app_settings`.

#### Milestone 2: Independent Toast Lifecycle & Background Controls
- [x] Start real download with main window hidden; verify Download Toast appears and updates real-time metrics.
- [x] Test Pause, Resume, and Cancel from Toast while main window is hidden.
- [x] Verify closing Toast does not terminate TORI.

#### Milestone 3: Tray Menu Controls & Exit Behavior
- [x] Verify `Open TORI` restores, unminimizes, and focuses main window.
- [x] Verify `Pause All` and `Resume All` update active/paused downloads in backend.
- [x] Verify `Exit TORI` without active downloads exits immediately.
- [x] Verify `Exit TORI` with active downloads presents warning dialog, pauses downloads upon confirmation, and exits cleanly.

#### Milestone 4: Desktop API Reachability & Lifecycle Log Audit
- [x] Verify `127.0.0.1:6800` remains reachable and authenticated via token while main window is hidden.
- [x] Review lifecycle log `%APPDATA%\tori-download-manager\logs\lifecycle.log` to confirm proper event sequence and zero unhandled panics or crashes.

#### Milestone 5: NSIS Installer Packaging Currency Audit
- [x] Inspect existing NSIS installer in `target/release/bundle/nsis/` against current release binary hashes (`6DD6E67C...`).
- [x] Report currency status and package new NSIS installer containing verified Gate 13.3.1 binaries.

#### Milestone 6: Regression Verification & Final QA Report
- [x] Run `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`.
- [x] Run `verify_production_release.ps1` and dedicated Gate 13.3.1 QA harness.
- [x] Deliver `docs/reports/GATE13_3_1_FINAL_LIFECYCLE_QA.md` and commit.

---

# TORI Download Manager v2.0 — Milestone Plan: Gate 13.4
## Extension Connection, WebView2 Performance & Media Reliability

### Objective
Resolve remaining extension connection, memory efficiency, generic media discovery, and toast interaction issues before preparing TORI Download Manager v2.0 for its first public GitHub release. Maintain 100% fidelity to `design/tori-final/` design tokens, architecture, and production stability.

---

### Specific Measurable Milestones

#### Milestone 1: Extension Connection Reliability & Auto-Recovery
- [x] Diagnose and eliminate root causes of `"Could not connect to TORI Desktop at 127.0.0.1:6800"`:
  - Add candidate port auto-discovery (6800-6803) in `callDesktopApi` when preferred port fails.
  - Fix MV3 service worker cold-start: ensure `extSettings` is loaded from `chrome.storage.local` before outbound requests dispatch.
  - Implement auto-pairing on first request if key is absent or invalidated.
  - Add Native Messaging desktop auto-launch on media resolution when desktop is offline.
  - Verify seamless communication while TORI is hidden in the Windows System Tray.
- [x] Test Native Messaging host registration, installed binary paths, and registry keys for Chrome & Edge.

#### Milestone 2: Download Toast Button Semantics Decoupling
- [x] Audit and decouple Toast Dismiss (`.cx` button) from Cancel Download in `ui/src/components/DownloadToast.tsx`.
- [x] Ensure clicking `.cx` dismisses the floating toast card/window while the active download continues running in the background.
- [x] Provide explicit "Cancel Download" action in the expanded card drawer with user confirmation.
- [x] Verify existing design tokens, typography, and SVG assets in `design/tori-final/` are strictly preserved.

#### Milestone 3: Generic Media Resolver & Stream Interception Reliability
- [x] Ensure yt-dlp extractor failures on generic webpages do not suppress valid DOM, network, or HTML candidates.
- [x] Enhance `orchestrator.rs` and `pipeline.rs`: probe candidates via HTTP HEAD/GET and manifest inspectors instead of immediately invoking yt-dlp on raw stream URLs.
- [x] Add `<iframe>` embed player discovery to HTML candidate extraction.
- [x] Verify detection and downloading of HLS `.m3u8`, DASH `.mpd`, direct MP4/WebM, audio, and subtitle streams.

#### Milestone 4: WebView2 & Process Memory Profile & Optimization
- [x] Benchmark memory across 7 defined states: Startup, Idle Main, Hidden to Tray, Toast Visible, 1 Active Download, 4 Active Downloads, 10 Repeated Hide/Restore cycles.
- [x] Profile `tori-download-manager.exe` and `msedgewebview2` processes (Working Set & Private Bytes).
- [x] Implement memory trimming on tray minimization (`SetProcessWorkingSetSize` Windows API working set trimming).
- [x] Audit and optimize React intervals, subscriptions, and hidden window activity.
- [x] Document reproducible before and after memory benchmarks.

#### Milestone 5: Full Regression, NSIS Packaging & Release Report
- [x] Run `cargo fmt --all -- --check`.
- [x] Run `cargo clippy --workspace --all-targets -- -D warnings`.
- [x] Run `cargo test --workspace`.
- [x] Run `npm --prefix ui run build` and `cargo tauri build --no-bundle`.
- [x] Run `powershell -ExecutionPolicy Bypass -File scripts\verify_production_release.ps1`.
- [x] Execute comprehensive automated test harness for Gate 13.4 (`scripts/verify_gate13_4_qa.js`: 12/12 PASS).
- [x] Package final NSIS installer via `cargo tauri build --bundles nsis`.
- [x] Produce `docs/reports/GATE13_4_CONNECTION_MEMORY_MEDIA_REPORT.md` and commit to Git.

