# TORI Download Manager v1.0.1 — Milestone Plan: Gate 18.1
## Isolated Manual User Acceptance Preparation

### Objectives
1. Verify and repair the Release Candidate package in `release/v1.0.1-rc/` to ensure all 6 runtime binaries (`tori-download-manager.exe`, `tdm-native-host.exe`, `tdm-cli.exe`, `ffmpeg.exe`, `ffprobe.exe`, `yt-dlp.exe`) and the browser extension package are co-located in `bin/` and `extension/` with verified SHA-256 hashes.
2. Strictly protect installed stable TORI v1.0.0 (`C:\Program Files\Tori Download Manager`) and production AppData (`%APPDATA%\tori-download-manager`), ensuring zero overwrites, registry changes, or database modifications.
3. Establish a 100% isolated QA runtime environment (`qa_manual_env`) with dedicated SQLite database (`tdm_storage.sqlite`), isolated port (`19600`), isolated IPC pipe (`\\.\pipe\tori-qa-manual-ipc`), isolated download folder, and isolated WebView2 user data profile.
4. Prepare easy-to-use native launch scripts (`launch_isolated_desktop_rc.bat` / `.ps1` and `launch_isolated_edge_browser.bat` / `.ps1`).
5. Verify isolated runtime behavior programmatically via `scripts/verify_isolated_qa_environment.js`.
6. Deliver a comprehensive 20-item user acceptance checklist and defect reporting form in `TORI_V1_0_1_MANUAL_ACCEPTANCE_CHECKLIST.md`.
7. Deliver full engineering handoff report `GATE18_1_MANUAL_ACCEPTANCE_PREPARATION_REPORT.md` and await physical user testing.

---

### Specific Measurable Milestones

#### Milestone 1: Verify & Complete Release Candidate Package (Task 1) — COMPLETED
- [x] Inspected `release/v1.0.1-rc/`.
- [x] Staged missing sidecars into `release/v1.0.1-rc/bin/`:
  - `ffmpeg.exe` (145,858,048 B | `b9989f24e63be74e72aa45fec10a114ce660b562e4303d5f296f4fc8ba7cc896`)
  - `ffprobe.exe` (145,645,568 B | `73842bee6f270e85b2ab6fc3cfa715f614f16ad16700f5de6a9c1a2865cacf00`)
  - `yt-dlp.exe` (17,840,399 B | `66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a`)
- [x] Staged unpacked extension directory alongside packaged `.zip` for direct browser sideloading.
- [x] Regenerated `SHA256SUMS.txt` and `RC_MANIFEST.json` reflecting all 6 staged binaries.

#### Milestone 2: Protect Stable TORI v1.0.0 (Task 2) — COMPLETED
- [x] Verified `C:\Program Files\Tori Download Manager` is untouched.
- [x] Verified `%APPDATA%\tori-download-manager\tdm_storage.sqlite` was not modified (timestamp verified before and after tests).
- [x] Maintained production registry key `HKLM:\Software\Microsoft\Edge\NativeMessagingHosts\org.toridm.nativehost` intact.

#### Milestone 3: Prepare & Verify Isolated QA Environment (Task 3) — COMPLETED
- [x] Determined isolation mechanisms supported in codebase:
  - `TORI_DATA_DIR` -> `qa_manual_env\data` (governs SQLite DB and engine logs)
  - `TORI_IPC_PIPE` -> `\\.\pipe\tori-qa-manual-ipc` (governs Named Pipe single-instance check)
  - `WEBVIEW2_USER_DATA_FOLDER` -> `qa_manual_env\webview2_profile` (governs WebView2 browser data)
  - Pre-seeded `app_settings` in SQLite -> `port: 19600`, `dir: qa_manual_env\downloads`, `key: tori_manual_qa_token_20261109`
- [x] Automated verification script `scripts/verify_isolated_qa_environment.js` passed:
  - Ping on port 19600 -> 200 OK
  - Authenticated status -> 200 OK
  - Sidecar discovery -> ffmpeg, ffprobe, yt-dlp available
  - Production AppData DB -> 0 byte changes, 0 timestamp modification.

#### Milestone 4: Native Desktop & Browser Launch Scripts (Tasks 4 & 5) — COMPLETED
- [x] Created `launch_isolated_desktop_rc.bat` and `launch_isolated_desktop_rc.ps1`.
- [x] Created `launch_isolated_edge_browser.bat` and `launch_isolated_edge_browser.ps1` with temporary `--user-data-dir`.
- [x] Confirmed zero console prompt flashing during desktop launch.

#### Milestone 5: Manual Acceptance Checklist & Feedback Form (Tasks 6 & 7) — COMPLETED
- [x] Authored 20-item checklist in `TORI_V1_0_1_MANUAL_ACCEPTANCE_CHECKLIST.md`.
- [x] Created structured Defect Report template for user feedback.

#### Milestone 6: Final Handoff & Boundary Enforcement (Task 8) — COMPLETED
- [x] Delivered `GATE18_1_MANUAL_ACCEPTANCE_PREPARATION_REPORT.md`.
- [x] Updated `IMPLEMENTATION_STATUS.md`.
- [x] Maintained strict boundaries: No sandbox, no installer rebuild, no git tag, no remote push, no version bump.
- [x] Stopped cleanly to await user's manual test results.
