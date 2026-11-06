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

---

# TORI Download Manager v2.0 — Milestone Plan: Gate 13.4.1
## Final Memory and Connection Safety Verification

### Objective
Perform a rigorous, empirical release-readiness verification covering WebView2 and process tree memory behavior (working set, private bytes, commit size, paging, UI restoration latency), authoritative port discovery and security validation, media MIME type and stream classification accuracy, and verification of the NSIS-installed application package.

---

### Specific Measurable Milestones

#### Milestone 1: WebView2 Memory Trimming Forensic Audit & Policy Optimization
- [x] Measure complete process tree memory (TORI parent + WebView2 children) across all states: Private Bytes, Working Set, Commit Size.
- [x] Profile page faults (soft vs hard faults) and UI restoration latency (ms to restore and render after tray minimization).
- [x] Test 30 consecutive hide/restore cycles; verify zero cumulative Private Bytes leaks, no paging thrashing, and stable CPU.
- [x] Add safe rate-limiting/cooldown to memory trimming (4-second debounce) so rapid window toggles or toast updates never trigger excessive page fault thrashing.
- [x] Strictly restrict child process discovery to TORI's own process tree (verify no foreign Edge or WebView2 instances are affected).
- [x] Honestly document that Working Set reduction reclaims physical resident RAM while Commit Size and Private Bytes represent virtual allocation.

#### Milestone 2: Authoritative Port Auto-Discovery & Engine Identity Verification
- [x] Ensure extension port sweep (6800–6803) strictly validates authoritative engine identity (`name: "TORI Download Manager"`, `version`, `port`, `authenticated: true`).
- [x] Prevent silent connection to unrelated services or rogue localhost ports.
- [x] Guarantee localhost-only binding and anti-DNS-rebinding protection.
- [x] Validate proper reconnect behavior and token persistence after TORI restarts.
- [x] Ensure no duplicate download jobs or cross-instance crosstalk.

#### Milestone 3: Generic Media Stream Validation & MIME Discrimination
- [x] Enforce strict MIME type and extension validation in `crates/tdm-core/src/resolver/pipeline.rs`:
  - Require valid video MIME (`video/*`) or audio MIME (`audio/*`) or streaming manifest MIME (`application/x-mpegurl`, `application/dash+xml`) or recognized media extension (`.mp4`, `.webm`, `.mkv`, `.m4v`, `.mov`, `.mp3`, `.m4a`, `.aac`, `.flac`, `.wav`, `.ogg`, `.opus`, `.m3u8`, `.mpd`).
  - Reject non-media responses (`text/html`, `text/vtt`, `application/pdf`, `image/*`, `application/zip`, etc.) from being presented as confirmed video downloads.
- [x] In HTML candidate scraping, discriminate `<track>` (subtitles) and `<iframe>` (embed documents): do not push subtitles or iframe documents as direct video download streams; route iframe src to platform extractor if it is a supported video embed (e.g. YouTube/Vimeo embed), otherwise skip.
- [x] Preserve SSRF validation and access restriction safeguards.

#### Milestone 4: NSIS Installed Application End-to-End Verification
- [x] Silently install latest NSIS package (`target/release/bundle/nsis/TORI Download Manager_2.0.0_x64-setup.exe`) to isolated staging folder.
- [x] Test installed application execution under scrubbed system PATH:
  - Background downloads persistence while main window is hidden.
  - System tray restoration and menu actions.
  - Toast Dismiss (`.cx`) vs Cancel Download in drawer.
  - Browser extension connection, pairing, and reconnect after app restart.
  - SQLite download history integrity and clean shutdown.
- [x] Verify clean uninstallation preserves user SQLite data.

#### Milestone 5: Full Regression Suite, Deliverables & Comprehensive Report
- [x] Run `cargo fmt --all -- --check`.
- [x] Run `cargo clippy --workspace --all-targets -- -D warnings`.
- [x] Run `cargo test --workspace` and `cargo test -p tdm-native-host`.
- [x] Run `npm --prefix ui run build` and `powershell -ExecutionPolicy Bypass -File scripts\verify_production_release.ps1`.
- [x] Package final updated NSIS installer if any binaries were modified.
- [x] Deliver `docs/reports/GATE13_4_1_RELEASE_RELIABILITY_AUDIT.md`.

---

# TORI Download Manager v1.0.0 — Milestone Plan: Gate 13.5
## About Page, GitHub Integration & Signed Auto-Updater

### Objective
Prepare TORI Download Manager for its first public GitHub v1.0.0 release by establishing verified application identity and release metadata, aligning application versions to v1.0.0 without breaking existing user data, enriching the About page matching `design/tori-final/` with dynamic versioning and license notices, configuring the official Tauri v2 signed updater with secure out-of-repo keys, implementing a user-controlled in-app update experience with active download safety guards, and preparing validated GitHub Releases metadata generator scripts.

---

### Specific Measurable Next Milestones

#### Milestone 1: Project Identity, Version Alignment & Remote Verification
- [ ] Audit Git remote, tags, publisher metadata, and website configuration.
- [ ] Reconcile version from 2.0.0 to 1.0.0 across all components:
  - `Cargo.toml` (`[workspace.package] version = "1.0.0"`)
  - `src-tauri/tauri.conf.json` (`"version": "1.0.0"`)
  - `ui/package.json` (`"version": "1.0.0"`)
  - `extension/manifest.json` (`"version": "1.0.0"`)
- [ ] Verify that no public v2.0.0 distribution or updater migration exists or breaks.
- [ ] Strictly preserve application identifiers (`com.tori.downloadmanager`), AppData paths (`%APPDATA%\tori-download-manager`), and SQLite storage.
- [ ] Report verified repository URL/owner or report user-supplied values needed.

#### Milestone 2: About Page Improvements & Design Token Preservation
- [x] Connect dynamic version retrieval in UI using Tauri app API (`getVersion()`), eliminating hardcoded version text.
- [x] Display complete application metadata:
  - Official TORI Torii-gate logo
  - Product Name: "TORI Download Manager"
  - Dynamic Version: "v1.0.0"
  - Developer / Publisher: "TORI Download Manager Team"
  - Official GitHub repository & website links
  - Open data folder action
  - Third-party licenses viewer displaying `LICENSE-THIRD-PARTY.txt`
  - Release notes / changelog viewer
- [x] Support external URL opening via safe desktop opener command or plugin.
- [x] Maintain 100% fidelity to `design/tori-final/` tokens, styling, accent themes, and dark/light modes.

#### Milestone 3: Official Tauri v2 Signed Auto-Updater Configuration
- [x] Add `tauri-plugin-updater = "2"` to `src-tauri/Cargo.toml` and `@tauri-apps/plugin-updater` to `ui/package.json`.
- [x] Register updater plugin in `src-tauri/src/lib.rs` and configure permissions in `src-tauri/capabilities/default.json`.
- [x] Securely generate dedicated Ed25519 signing key outside the repository (`%USERPROFILE%\.tori-keys\tori-updater.key`).
- [x] NEVER embed private key in repo, binaries, or reports; document secure key backup requirements.
- [x] Embed public key in `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`).
- [x] Configure `bundle.createUpdaterArtifacts = true` in `src-tauri/tauri.conf.json`.
- [x] Configure update endpoints pointing to GitHub Releases `latest.json` or configurable endpoint.

#### Milestone 4: In-App Update Experience & Download Safety Guard
- [x] Implement update check & install workflow in `ui/src/components/SettingsModal.tsx` and background service:
  - Manual "Check for Updates" button in About tab.
  - Optional periodic background check (24-hour interval) persisted in settings.
  - Explicit states: Idle, Checking, Up to Date, Update Available, Downloading, Ready to Install, Error.
  - Display available version, release date, and release notes.
  - User controls: "Download & Install", "Remind Me Later", and "View on GitHub".
  - Download progress tracking (`downloaded / totalBytes`).
  - Active Download Safety Guard: Check active download queue; refuse immediate restart while downloads are in `Downloading` state; warn user to pause or complete active downloads.
  - Preserve SQLite database, partial downloads (`.tdm-part`), and settings across updates.
  - Graceful fallback for offline mode or network errors without blocking application startup.

#### Milestone 5: GitHub Release Metadata Generation & Release Assets
- [x] Create `CHANGELOG.md` and `RELEASE_NOTES.md` for v1.0.0.
- [x] Implement `scripts/generate_release_metadata.js`:
  - Parses built NSIS installer (`TORI Download Manager_1.0.0_x64-setup.exe`) and detached `.sig` signature.
  - Formats valid Tauri v2 `latest.json`.
  - Generates `SHA256SUMS.txt` for all release deliverables.
- [x] Compile release binaries, Windows NSIS installer, and updater artifacts.
- [x] Create comprehensive automated test harness `scripts/verify_gate13_5_qa.js`:
  - Validates `latest.json` format, signatures, version ordering, download lock safety, and UI states.
- [x] Run full workspace test suite (`cargo fmt`, `cargo clippy`, `cargo test --workspace`, release guard).
- [x] Produce `docs/reports/GATE13_5_RELEASE_PREPARATION_REPORT.md` and commit to Git.

---

# TORI Download Manager v1.0.0 — Milestone Plan: Gate 13.5.1
## Signed Updater End-to-End Verification

### Objective
Verify that the official Tauri v2 signed updater can safely, reliably, and cryptographically upgrade a real installed Windows application before any public release on GitHub, strictly verifying identity, key safety, update installation, process relaunch, and data/state preservation without publishing publicly.

### Specific Measurable Next Milestones

#### Milestone 1: Release Identity & Ownership Audit
- [x] Audit Git remote, repository ownership, GitHub Releases endpoint, developer/publisher display name, official website URL, About page links, and release metadata.
- [x] Confirm absence of placeholder identities and document all verified fields (Website link hidden, GitHub repo/releases/issues linked).

#### Milestone 2: Updater Artifacts & Cryptographic Verification Audit
- [x] Verify `bundle.createUpdaterArtifacts: true` against installed Tauri v2 CLI and bundler.
- [x] Verify NSIS installer identity, detached `.sig` signature, and embedded public key in `tauri.conf.json`.
- [x] Verify `latest.json` format, schema, `windows-x86_64` target, download URL formatting, and strict signature contents vs SHA-256 discrimination.

#### Milestone 3: Signing Key Safety & Operational Security
- [x] Verify private key (`tori-updater.key`) is stored strictly outside the repository at `%USERPROFILE%\.tori-keys\`.
- [x] Verify zero private keys, passwords, or secrets are tracked in Git, git history, logs, or reports.
- [x] Verify Ed25519 Minisign signing and verification roundtrip with existing public key.
- [x] Prepare secure key backup and disaster recovery instructions without exposing key material.

#### Milestone 4: Real Windows Update End-to-End Test (Sandbox Execution)
- [x] Install production v1.0.0 NSIS build into an isolated test directory (`target/sandbox_install_v100`).
- [x] Verify installed directory structure (main binary, companion executables, licenses).
- [x] Verify installed binary version metadata (`FileVersion` = `1.0.0`, `ProductVersion` = `1.0.0`).
- [x] Seed SQLite storage and in-progress `.tdm-part` transfer files.
- [x] Apply simulated in-place silent update (`/UPDATE /S /D=...`).
- [x] Verify SQLite database, settings, completed downloads, and `.tdm-part` resumables are 100% preserved.
- [x] Verify browser extension and Native Messaging host remain functional.
- [x] Verify clean sandbox uninstall via uninstaller.

#### Milestone 5: Failure, Rejection & Safety Guard Tests
- [x] Test invalid signature rejection: Corrupt signature in manifest; verify updater strictly rejects and halts update (verified via `crates/tdm-core/tests/updater_cryptography_tests.rs`).
- [x] Test tampered binary payload: Single bit flipped causes cryptographic signature verification to fail immediately.
- [x] Test missing update metadata / malformed JSON handling.
- [x] Test broken download URL (HTTP 404 / 500) and network offline handling.
- [x] Test active download safety guard: Update installation blocked while active downloads are running (`installUpdateSafe`).
- [x] Test same-version and older-version response handling (no false update loops).

#### Milestone 6: Final Release Candidate Restoration & Gate 13.5.1 Report
- [x] Restore source tree version to `1.0.0` with clean git status.
- [x] Verify final v1.0.0 NSIS installer, `.sig` signature, `latest.json`, `SHA256SUMS.txt`, and extension ZIP.
- [x] Run full test suites (`cargo fmt`, `cargo clippy`, `cargo test --workspace`, release guard `verify_production_release.ps1`).
- [x] Produce `docs/reports/GATE13_5_1_UPDATER_E2E_VERIFICATION.md` and commit to Git.

---

# TORI Download Manager v1.0.0 — Milestone Plan: Gate 13.6
## Final Release Candidate & Distribution Readiness

### Objective
Perform the final, exhaustive release-readiness verification before publishing TORI Download Manager v1.0.0 on GitHub. Audit artifact integrity, GitHub repository configuration, real installed application lifecycle, genuine Tauri updater-driven upgrade execution, prepare the final staged distribution package, and issue an explicit release recommendation without pushing tags or public releases.

### Specific Measurable Next Milestones

#### Milestone 1: Release Artifact Integrity Audit
- [x] Verify production executable matches current committed source.
- [x] Verify NSIS installer packages the latest About page and hidden Website link.
- [x] Verify application and extension versions are 1.0.0 across all manifests.
- [x] Verify exact SHA-256 for all release deliverables.
- [x] Verify Ed25519 Minisign signature against exact installer bytes (cryptographic verification, not just timestamp).
- [x] Verify `latest.json` platform metadata and matching signature.
- [x] Verify all bundled companion binaries are present in installer payload.
- [x] Verify absence of stale development paths or temporary debug files.

#### Milestone 2: GitHub Repository Ownership & Availability Audit
- [x] Inspect configured GitHub remote and URLs (no remote configured).
- [x] Probe actual availability of `https://github.com/tori-download-manager/tori-download-manager` (HTTP 404).
- [x] Document verified ownership vs unconfirmed repository status as a critical release blocker.
- [x] Ensure zero fake or substituted remotes.

#### Milestone 3: Real Installed Application Acceptance Testing
- [x] Silently install the packaged NSIS installer into an isolated test location.
- [x] Test application launch, window creation, and custom titlebar under scrubbed PATH.
- [x] Test System Tray persistence and background download decoupling.
- [x] Test Native Progress Toast window and interactive controls.
- [x] Test Browser extension connectivity and desktop API on port 6800.
- [x] Test direct HTTP multi-connection download and MD5/SHA256 integrity (33/33 tests passed in `verify_gate13_6_installed_app.js`).
- [x] Test managed media resolution with bundled FFmpeg, FFprobe, and yt-dlp.
- [x] Test SQLite download queue persistence across restarts.
- [x] Test uninstaller execution and user data preservation.

#### Milestone 4: Genuine Tauri Auto-Updater Driven Upgrade Verification
- [x] Review prior updater verification: confirm distinction between mock simulation vs live Tauri `update.downloadAndInstall()`.
- [x] Document that in-app update against live remote server is unverified due to HTTP 404 on GitHub repository (explicit release blocker).
- [x] Confirmed local Minisign verification, active download blocking, and offline resilience.

#### Milestone 5: Final Distribution Package Staging
- [x] Prepare clean distribution directory `release/v1.0.0/` containing:
  - `TORI Download Manager_1.0.0_x64-setup.exe`
  - `TORI Download Manager_1.0.0_x64-setup.exe.sig`
  - `latest.json`
  - `tori-download-manager-extension-v1.0.0.zip`
  - `SHA256SUMS.txt`
  - `RELEASE_NOTES.md`
  - `CHANGELOG.md`
  - `LICENSE-THIRD-PARTY.txt`
  - `INSTALL.md` (Installation and checksum verification instructions)
- [x] Verify all release metadata uses verified production URLs.

#### Milestone 6: Final Report & Release Recommendation
- [x] Create `docs/reports/GATE13_6_FINAL_RELEASE_READINESS_REPORT.md`.
- [x] Record exact files, hashes, repository status, updater acceptance, limitations, and Git commit.
- [x] Issue an explicit NOT READY recommendation for public publication (blocked on GitHub repository creation).

---

# TORI Download Manager v1.0.0 — Milestone Plan: Gate 13.7
## Official GitHub Repository Integration & Final v1.0.0 Packaging

### Objective
Integrate TORI Download Manager with the confirmed GitHub repository (`https://github.com/robijoychakma375-hash/tori-download-manager`), configure the `origin` Git remote, replace all production references to `tori-download-manager/tori-download-manager` with `robijoychakma375-hash/tori-download-manager`, rebuild the production application and self-contained NSIS installer, re-sign release artifacts with the existing Ed25519 Minisign key, verify the suite, and produce the integration report without pushing to GitHub.

### Specific Measurable Next Milestones

#### Milestone 1: Git Remote & Repository Security Audit
- [x] Inspect local Git repository, branch `master`, commit history.
- [x] Configure `origin` remote: `https://github.com/robijoychakma375-hash/tori-download-manager.git`.
- [x] Audit `.gitignore` and tracked files ensuring zero secrets, `.key`, `.pwd`, `.pem`, databases, or local files are tracked (untracked `tdm_metadata.sqlite`, deleted `chunk-stream1-00002.m4s.tmp`, ignored `*.sqlite`, `*.tmp`).
- [x] Review license notices: created root `LICENSE` (MIT) and updated `LICENSE-THIRD-PARTY.txt` (v1.0.0, FFmpeg GPLv3, yt-dlp Unlicense, TORI MIT/Apache-2.0).

#### Milestone 2: Replace Incorrect GitHub URLs
- [x] Update `ui/src/components/SettingsModal.tsx` (Repository, Releases, Issues links updated to `robijoychakma375-hash/tori-download-manager`).
- [x] Update `src-tauri/tauri.conf.json` (`plugins.updater.endpoints` updated to `robijoychakma375-hash/tori-download-manager`).
- [x] Update `scripts/generate_release_metadata.js` (`owner = 'robijoychakma375-hash'`).
- [x] Verified `README.md`, `RELEASE_NOTES.md`, and `CHANGELOG.md` are aligned with v1.0.0.
- [x] Update QA and test suites referencing repository URLs (`updater_cryptography_tests.rs`, `verify_gate13_5_qa.js`, `verify_gate13_5_1_updater_e2e.js`).
- [x] Confirm official website link remains safely hidden (`OFFICIAL_WEBSITE_URL: null`).

#### Milestone 3: Rebuild v1.0.0 Production Application & NSIS Installer
- [x] Rebuild React frontend: `npm --prefix ui run build` (clean build in 295ms).
- [x] Rebuild self-contained Windows NSIS installer: `cargo tauri build --bundles nsis` (116.8 MB installer generated).
- [x] Re-sign installer and generate `latest.json` with existing Ed25519 key (`scripts/generate_release_metadata.js`).
- [x] Recalculate `SHA256SUMS.txt` for all release deliverables.
- [x] Restage final distribution bundle into `release/v1.0.0/` (`scripts/stage_release_package.js`).

#### Milestone 4: Verification & Acceptance Suites
- [x] Run Rust workspace tests (`cargo test --workspace` — 146 tests passed, 0 failed).
- [x] Run updater cryptographic verification tests (`cargo test --test updater_cryptography_tests` — 5 tests passed).
- [x] Run Gate 13.5 QA suite (`scripts/verify_gate13_5_qa.js` — 61 tests passed).
- [x] Run Gate 13.5.1 signed updater E2E suite (`scripts/verify_gate13_5_1_updater_e2e.js` — 67 tests passed).
- [x] Run installed application acceptance tests under scrubbed PATH (`scripts/verify_gate13_6_installed_app.js` — 33 tests passed).
- [x] Run production release build guard (`scripts/verify_production_release.ps1` — 15 checks passed).
- [x] Verify that installed executable contains the corrected GitHub URLs.

#### Milestone 5: Gate 13.7 Report & Local Commit
- [x] Create `docs/reports/GATE13_7_GITHUB_INTEGRATION_REPORT.md`.
- [x] Record Git remote, corrected URLs, binary hashes, test results, and status.
- [x] Commit verified changes locally.
- [x] Strictly do NOT push remote, do NOT create GitHub release, do NOT publish.





