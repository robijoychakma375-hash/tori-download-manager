# TORI Download Manager v1.0.1 — Milestone Plan: Gate 18.2
## Fresh NSIS Installer Build & Packaging Verification

### Objectives
1. Record user manual acceptance sign-off (10/10 PASS) in `TORI_V1_0_1_MANUAL_ACCEPTANCE_CHECKLIST.md`.
2. Verify source freeze and clean working tree on `dev/v1.0.1` (commit `7ad667f`).
3. Rebuild frontend (`ui`) and verify fresh production release executables and bundled sidecars (`tori-download-manager.exe`, `tdm-native-host.exe`, `tdm-cli.exe`, `ffmpeg.exe`, `ffprobe.exe`, `yt-dlp.exe`).
4. Generate a fresh Windows x64 NSIS installer using Tauri 2 CLI (`TORI Download Manager_1.0.1_x64-setup.exe`) signed with Ed25519 updater keys.
5. Audit installer Native Messaging registration logic (`src-tauri/nsis/hooks.nsh` and `crates/tdm-native-host/src/registry.rs`), confirming HKCU registry isolation and clean uninstaller logic.
6. Verify installer integrity without executing it (size, PE architecture, SHA-256 hash, embedded payload, commit provenance vs obsolete Nov 8 installer).
7. Execute security & privacy audit (no tokens, DBs, test downloads; document Authenticode signing status honestly as `UNSIGNED`, updater signing as `ED25519 SIGNED`).
8. Run full regression suite (`cargo fmt`, `cargo clippy`, `cargo test`, `npm run build`, and release binary smoke test).
9. Stage installer candidate to `release/v1.0.1-installer-candidate/` with `SHA256SUMS.txt`, build manifest, licenses, and draft notes.
10. Deliver final artifact: `GATE18_2_FRESH_NSIS_INSTALLER_REPORT.md` and stop.

---

### Specific Measurable Milestones

#### Milestone 1: User Acceptance Sign-Off (Task 1) — COMPLETED
- [x] Recorded user 10/10 PASS results in `TORI_V1_0_1_MANUAL_ACCEPTANCE_CHECKLIST.md`.
- [x] Documented zero defect observations.
- [x] Formally transitioned status to `ACCEPTED FOR PACKAGING (GATE 18.2)`.

#### Milestone 2: Source Freeze & Git Audit (Task 2) — COMPLETED
- [x] Verified `dev/v1.0.1` branch and commit `7ad667f`.
- [x] Working tree clean on tracked files; `qa_manual_env/` git-ignored.

#### Milestone 3: Fresh NSIS Packaging & Signing (Tasks 3 & 4) — COMPLETED
- [x] Rebuilt frontend (`npm run build --prefix ui` -> 321ms, clean bundle).
- [x] Packaged NSIS installer via `cargo tauri build --bundles nsis`.
- [x] Installer output: `target/release/bundle/nsis/TORI Download Manager_1.0.1_x64-setup.exe` (116,996,177 bytes).
- [x] Updater signature output: `TORI Download Manager_1.0.1_x64-setup.exe.sig` (436 bytes, valid Minisign Ed25519 signature).

#### Milestone 4: Native Messaging Logic Audit (Task 5) — COMPLETED
- [x] Inspected `hooks.nsh` and `crates/tdm-native-host/src/registry.rs`.
- [x] Confirmed registry writes scoped to `HKCU\Software\Microsoft\Edge\NativeMessagingHosts` and `Google\Chrome`.
- [x] Confirmed uninstaller executes `--unregister` and preserves user download data.
- [x] Formally classified live installed native messaging as `NOT TESTED` (deferred to clean-machine testing).

#### Milestone 5: Installer Integrity & Security Audit (Tasks 6 & 7) — COMPLETED
- [x] Verified file size: 116,996,177 bytes (distinct from 116,846,439 byte Nov 8 obsolete build).
- [x] Calculated SHA-256: `DC00B7058503A5959B5A32083072F87546CE2A9D60C5366E30C6C7798B6B19E8`.
- [x] Verified PE stub: 0x14c packaging x64 AMD64 binaries.
- [x] Authenticode status documented as `UNSIGNED` (NotSigned).
- [x] Confirmed zero leaked databases, keys, credentials, or test folders.

#### Milestone 6: Full Regression Verification (Task 8) — COMPLETED
- [x] `cargo fmt --all -- --check` -> PASS (0 errors).
- [x] `cargo clippy --workspace --all-targets -j 2 -- -D warnings` -> PASS (0 warnings).
- [x] `cargo test --workspace -j 2` -> PASS (105 passed, 0 failed across all crates).
- [x] `npm run build --prefix ui` -> PASS (clean build).
- [x] `scripts/smoke_test_release.js` -> PASS (100% pass on release binary).

#### Milestone 7: Artifact Staging & Documentation (Tasks 9 & 10) — COMPLETED
- [x] Staged all artifacts in `release/v1.0.1-installer-candidate/`:
  - `TORI Download Manager_1.0.1_x64-setup.exe`
  - `TORI Download Manager_1.0.1_x64-setup.exe.sig`
  - `tori-download-manager-extension-v1.0.1.zip`
  - `LICENSE` and `LICENSE-THIRD-PARTY.txt`
  - `SHA256SUMS.txt`
  - `INSTALLER_BUILD_MANIFEST.json`
  - `INSTALLATION_AND_UPGRADE_NOTES.md`
- [x] Authored `GATE18_2_FRESH_NSIS_INSTALLER_REPORT.md`.
- [x] Preserved installed stable TORI v1.0.0 and user AppData untouched.
- [x] Stopped cleanly prior to Gate 18.3.
