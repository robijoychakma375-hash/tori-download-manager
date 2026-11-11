# TORI Download Manager v1.0.1 â€” Milestone Plan & Execution Roadmap

**Target Version:** v1.0.1 (Desktop Engine v1.0.1, Companion Extensions v1.0.2)
**Branch:** `dev/v1.0.1`
**Current Milestone:** Gate 19.3 â€” Documentation Recovery & Repository Reconciliation

---

## 1. Historical Completed Milestones

### Gate 18.8: Fresh Installer, GPLv3 Licensing, Release Draft & Website Staging
- [x] Verify Git HEAD at `b55d75a` and clean working tree.
- [x] Run `cargo fmt --all -- --check` (0 diffs).
- [x] Run `cargo clippy --workspace --all-targets -j 2 -- -D warnings` (0 warnings).
- [x] Run `cargo test --workspace -j 2` (100% pass across all crates).
- [x] Run `node scripts/verify_gate18_7_1_tray_and_background.js` (24/24 PASS).
- [x] Build React UI production bundle via `npm run build --prefix ui` (clean, 315ms).
- [x] Compile release companion binaries: `tdm-native-host.exe` and `tdm-cli.exe` and sync to `resources/bin/`.
- [x] Execute `cargo tauri build --bundles nsis` to generate fresh x64 installer (`117,044,352` bytes, SHA256: `dfd87d3800556d9c4cc41cb3dcbd1fbe14c2bb51586655196df52330ba34e41b`).
- [x] Sign installer with official Ed25519 updater key (`cargo tauri signer sign`).
- [x] Generate `SHA256SUMS.txt`, `RELEASE_MANIFEST.json`, `RELEASE_NOTES.md`, and `INSTALLATION_AND_UPGRADE_NOTES.md`.
- [x] Audit installer PE headers and Authenticode status (truthfully reported as unsigned).
- [x] Revalidate Mozilla-signed Firefox XPI v1.0.2 SHA256 (`520424ff38ddb1bf84152e7fd3c9bf4678ce6af1542995a6d4b58c4dc4fbb8d0`).
- [x] Revalidate Chromium/Edge extension v1.0.2 ZIP SHA256 (`788bbb16f38356109a8ea529809e9acc708f0c97dbfac939dca68cdc0bd11805`).
- [x] Stage complete GNU GPLv3 license text in `resources/LICENSE-GPLv3.txt` and third-party notices.
- [x] Prepare GitHub release draft for commit `48d083d` with all 10 verified distribution assets.
- [x] Prepare website pre-release banner in `C:\Users\ritud\Downloads\tori-website\index.html`.

### Gate 18.9: Public Pre-Release Publication & Initial Download Verification
- [x] Publish GitHub pre-release `v1.0.1` (`releaseId: 440552231`, `prerelease: true`).
- [x] Deploy website pre-release banner to Cloudflare Pages (`https://toridownload.xyz`).
- [x] Execute `scripts/verify_post_publication_downloads.js` (**34/34 PASS, 100%**).
- [x] Verify roundtrip SHA-256 for all 10 release assets from GitHub CDN.

### Gate 19.1: Release Promotion & Website Stable Transition Scripts
- [x] Author and stage `scripts/prepare_website_stable_v1_0_1.js` for updating website index.html.
- [x] Author and stage `scripts/promote_v1_0_1_to_stable.js` with Git Credential Manager authentication.
- [x] Commit automation orchestrators under `55a5273`.

### Gate 19.2: Official Stable Release Promotion & Deployment Verification
- [x] Promote GitHub Release ID `440552231` to Latest Stable (`draft: false`, `prerelease: false`, `make_latest: true`).
- [x] Deploy stable website update to Cloudflare Pages (`https://toridownload.xyz`).
- [x] Execute `scripts/verify_gate19_2_stable_deployment.js` (**29/29 PASS, 100%**).
- [x] Verify bitstream match for installer (`dfd87d38...`), Firefox XPI (`520424ff...`), Chromium ZIP (`788bbb16...`).
- [x] Verify auto-updater safeguard (`latest.json` absent on v1.0.1, v1.0.0 feed pinned to 1.0.0).
- [x] Commit verification results in `f033765`.

---

## 2. Completed Milestones: Gates 19.3 – 21.1

### Gate 19.3 — Documentation Recovery, Reconciliation & Regression Script Preservation
- [x] Author `docs/reports/GATE19_2_STABLE_RELEASE_AND_DEPLOYMENT_REPORT.md` (29/29 PASS verified).
- [x] Reconcile `IMPLEMENTATION_STATUS.md`, `PLAN.md`, `CHANGELOG.md`, and release notes.
- [x] Audit 56 untracked files and sanitize machine-specific regression paths in test scripts.
- [x] Preserve valuable regression scripts under `feat(gate19.3): preserve regression verification scripts` (`601b0ba`).

### Gate 20.0 – 20.2 — Release Validation, QA Kit Synchronization & Acceptance Readiness
- [x] Verify release baseline and tag `v1.0.1` immutability at `48d083d`.
- [x] Synchronize separate-PC QA kit with verified installer `dfd87d38...` and update checksums.
- [x] Author `docs/reports/GATE20_2_ACCEPTANCE_READINESS_REPORT.md` detailing 10-step physical testing checklist.
- [x] Commit and push changes to `origin/dev/v1.0.1` (`eb05aff`).

### Gate 21.0 — v1.0.2 Version Synchronization, Production Build & Draft Release Preparation
- [x] Branch `release/v1.0.2` from `eb05aff`.
- [x] Synchronize desktop metadata to 1.0.2 across Cargo.toml, tauri.conf.json, and package.json.
- [x] Compile React UI and companion binaries (`tdm-native-host.exe`, `tdm-cli.exe`).
- [x] Build Windows x64 NSIS installer (`117,073,652` B, SHA256: `1ab7f345...`) and sign with Ed25519 updater key.
- [x] Execute 93 automated tests across native host, core engine, queue recovery, media, and cryptography (93/93 PASS).
- [x] Stage 10 distribution assets in `release/v1.0.2-final/` and create private GitHub Draft Release ID `441473140`.

### Gate 21.1 — Official v1.0.2 Stable Release Publication & Website Deployment
- [x] Execute 56 critical preflights verifying hashes, tag immutability, and asset readiness (56/56 PASS).
- [x] Promote GitHub Draft Release ID `441473140` to Latest Stable (`draft: false`, `prerelease: false`, `make_latest: true`).
- [x] Update `toridownload.xyz` in `tori-website-private` (commit `7b53d7e`); promote v1.0.2 downloads, remove candidate wording, correct licensing to GPLv3 / MIT, and preserve older releases.
- [x] Verify live Cloudflare Pages deployment and bitstream SHA-256 parity from GitHub CDN.
- [x] Confirm auto-updater feed isolation (`latest.json` absent on v1.0.2).

---

## 3. Future Roadmap: Gate 22 — Post-Release Operations & Physical Hardware Acceptance

### Objectives
1. **Physical Separate PC Acceptance (Hardware Station)**
   - [ ] Transfer `release/separate-pc-qa-kit/` to an isolated Windows 10/11 physical test machine.
   - [ ] Execute `verify_checksums.ps1` and verify all package hashes.
   - [ ] Run `test_fresh_install.ps1`, `test_browser_integration.ps1`, `test_upgrade.ps1`, and `test_uninstall.ps1`.
   - [ ] Record physical acceptance in `QA_ACCEPTANCE_CHECKLIST.md`.
2. **Controlled Auto-Updater Activation (Post-Physical QA)**
   - [ ] Author `latest.json` for v1.0.2 referencing installer `117,073,652` bytes, Ed25519 signature, and release notes.
   - [ ] Upload `latest.json` to GitHub Release v1.0.2 to activate in-app update notifications for existing users once physical acceptance is signed off.
3. **Store Submissions**
   - [ ] Package and submit Chromium extension v1.0.2 to the Chrome Web Store.
   - [ ] Submit companion extension to the Microsoft Edge Add-ons Catalog.
