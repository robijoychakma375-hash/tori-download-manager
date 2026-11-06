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
