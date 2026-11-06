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
