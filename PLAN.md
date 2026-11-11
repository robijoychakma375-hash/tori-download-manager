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

## 2. Active Milestone: Gate 19.3 â€” Documentation Recovery & Repository Reconciliation

### Objectives
1. **Phase 1: Recover Missing Gate 19.2 Report**
   - [x] Author `docs/reports/GATE19_2_STABLE_RELEASE_AND_DEPLOYMENT_REPORT.md` documenting:
     - 29/29 automated verification pass evidence.
     - Release asset SHA-256 table matching GitHub bitstreams.
     - Website deployment and Cloudflare Pages status.
     - Auto-updater isolation verification.
     - Explicit dual evidence model distinguishing historical verification from current live verification.
2. **Phase 2: Documentation Reconciliation**
   - [x] Update `IMPLEMENTATION_STATUS.md` with Gates 18.4â€“19.2.
   - [x] Update `PLAN.md` with comprehensive completion records and Gate 19.3 roadmap.
   - [x] Harmonize root `RELEASE_NOTES.md` and `CHANGELOG.md` with v1.0.1 release notes.
3. **Phase 3: Untracked File Review & Categorization**
   - [x] Review all 56 untracked files without deleting or moving any file.
   - [x] Classify files into regression scripts, benchmark artifacts, temporary logs, graphics, and manual review items.
   - [x] Formulate proposal for tracking valuable regression scripts vs. ignoring transient benchmark outputs.
4. **Phase 4: Branch Synchronization Assessment**
   - [x] Audit differences between `dev/v1.0.1` and `master`.
   - [x] Assess risks and outline exact intended fast-forward procedure for `master`.
   - [x] Enforce tag immutability: guarantee published tag `v1.0.1` remains attached to commit `48d083d`.

---

## 3. Future Roadmap: Gate 20.0 â€” Post-Release Operations & Separate PC Acceptance

### Objectives
1. **Physical Separate PC Acceptance (Hardware Station)**
   - [ ] Transfer `release/separate-pc-qa-kit/` to an isolated Windows 10/11 physical test machine.
   - [ ] Execute `verify_checksums.ps1` and verify all package hashes.
   - [ ] Run `test_fresh_install.ps1`, `test_browser_integration.ps1`, `test_upgrade.ps1`, and `test_uninstall.ps1`.
   - [ ] Record physical acceptance in `QA_ACCEPTANCE_CHECKLIST.md`.
2. **Controlled Auto-Updater Activation (Post-Physical QA)**
   - [ ] Author `latest.json` for v1.0.1 referencing installer `117,044,352` bytes, Ed25519 signature, and release notes.
   - [ ] Upload `latest.json` to GitHub Release v1.0.1 to activate in-app update notifications for existing v1.0.0 users.
3. **Store Submissions**
   - [ ] Package and submit Chromium extension v1.0.2 to the Chrome Web Store.
   - [ ] Submit companion extension to the Microsoft Edge Add-ons Catalog.
