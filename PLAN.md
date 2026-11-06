# TORI Download Manager v2.0 — Milestone Plan: Gate 13.1
## Post-Migration Stability, Recovery & Performance

### Objective
Prepare TORI for a reliable Windows release. Eliminate proven reliability, portability, and performance problems from project migration and dependency resolution while preserving 100% of existing functionality and the approved UI.

---

### Specific Measurable Next Milestones

#### Milestone 1: Migration Path Decoupling & Registration Fix
- [ ] Update `ui/src/components/DownloadToast.tsx` to replace hardcoded `C:\Users\ritud` mock paths with portable paths.
- [ ] Update `scripts/diagnose_env.ps1` to use `$env:USERPROFILE` and `$env:LOCALAPPDATA` dynamically.
- [ ] Update `scripts/verify_gate12_9_2_browser_e2e.js` to dynamically locate `ffprobe.exe` via PATH, local appdata, or winget.
- [ ] Register `tdm-native-host.exe` from `F:\TORI\final tori download manager\target\release\tdm-native-host.exe` so `%APPDATA%\tori-download-manager\com.tori.download_manager.json` points to the active `F:` drive executable.

#### Milestone 2: Portable Tauri Resource Discovery for External Binaries
- [ ] Extend `find_ffmpeg()` and `find_ffprobe()` in `crates/tdm-core/src/hls/muxer.rs` to search `resources/` and `resources/bin/` relative to `current_exe()`.
- [ ] Extend `find_yt_dlp()` in `crates/tdm-core/src/resolver/discovery.rs` to search `resources/` and `resources/bin/` relative to `current_exe()`.
- [ ] Verify discovery passes unit and integration tests.

#### Milestone 3: Duplicate Download Prevention Across Extension & Backend
- [ ] In `extension/popup/popup.js`, disable the download button immediately on click (`btn.disabled = true`) to prevent double-click / rapid spam.
- [ ] In `crates/tdm-native-host/src/server.rs` (`handle_create_media_download`), add duplicate check against active jobs in SQLite (matching URL, non-cancelled/failed) returning `already_exists`.

#### Milestone 4: Comprehensive Verification & Production Build
- [ ] Run `cargo check --workspace` and `cargo clippy --workspace --all-targets -- -D warnings`.
- [ ] Run `cargo test -p tdm-core` (unit & integration suites).
- [ ] Run `cargo test -p tdm-native-host` (host & server suites).
- [ ] Build release executable: `cargo tauri build --no-bundle`.
- [ ] Run `scripts/verify_production_release.ps1` to verify standalone launch without Vite, custom-protocol embedded assets, and CDP health.
- [ ] Measure RAM, CPU, startup time, and throughput metrics.
- [ ] Produce `GATE13_1_STABILITY_AND_MIGRATION_REPORT.md` documenting all findings and results.
