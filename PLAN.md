# TORI Download Manager v1.0.1 — Milestone Plan: Gate 18.8
## Fresh Installer, GitHub Pre-release & Website Preparation

### Objectives
1. Verify HEAD commit `b55d75a` and ensure full regression pass of Gate 18.7.1 Close-to-Tray bug fixes.
2. Build a fresh Windows x64 NSIS installer (`TORI Download Manager_1.0.1_x64-setup.exe`) from the latest verified source; sign with Ed25519 updater key; generate manifest and SHA256 checksums.
3. Validate and preserve existing Mozilla-signed Firefox extension v1.0.2 (`520424ff38ddb1bf84152e7fd3c9bf4678ce6af1542995a6d4b58c4dc4fbb8d0`) and Chromium/Edge extension v1.0.2.
4. Conduct comprehensive licensing audit of bundled FFmpeg/FFprobe GPLv3 binaries, ensure full GPLv3 text and corresponding source code availability requirements are fulfilled.
5. Prepare GitHub pre-release draft for tag `v1.0.1` pointing to the verified commit, with all final assets and truthful Authenticode reporting (`NotSigned`).
6. Prepare update to the official TORI website (`C:\Users\ritud\Downloads\tori-website`) adding Pre-release v1.0.1 download options, Firefox XPI v1.0.2, and preserving stable v1.0.0. Do not deploy before approval.
7. Detail post-publication verification plan and single-PC safe installation protocol without touching installed stable v1.0.0.
8. Deliver formal engineering report `GATE18_8_PRE_RELEASE_AND_WEBSITE_PREPARATION_REPORT.md`.

---

### Specific Measurable Milestones

#### Milestone 1: Baseline & Regression Verification (Phase 1)
- [x] Verify Git HEAD at `b55d75a` and clean working tree.
- [x] Run `cargo fmt --all -- --check` (0 diffs).
- [x] Run `cargo clippy --workspace --all-targets -j 2 -- -D warnings` (0 warnings).
- [x] Run `cargo test --workspace -j 2` (100% pass across all crates).
- [x] Run `node scripts/verify_gate18_7_1_tray_and_background.js` (24/24 PASS).

#### Milestone 2: Fresh Windows Installer Build & Updater Signing (Phase 2)
- [ ] Build React UI production bundle via `npm run build --prefix ui`.
- [ ] Compile release companion binaries: `tdm-native-host.exe` and `tdm-cli.exe` and sync to `resources/bin/`.
- [ ] Execute `cargo tauri build --bundles nsis` to generate fresh x64 installer.
- [ ] Sign installer with official Ed25519 updater key (`cargo tauri signer sign`).
- [ ] Generate `SHA256SUMS.txt`, `RELEASE_MANIFEST.json`, `RELEASE_NOTES.md`, and `INSTALLATION_AND_UPGRADE_NOTES.md`.
- [ ] Audit installer PE headers and Authenticode status (truthfully reported).

#### Milestone 3: Signed Browser Extension Validation (Phase 3)
- [ ] Revalidate Mozilla-signed Firefox XPI v1.0.2 SHA256 (`520424ff38ddb1bf84152e7fd3c9bf4678ce6af1542995a6d4b58c4dc4fbb8d0`).
- [ ] Revalidate Chromium/Edge extension v1.0.2 ZIP SHA256 (`788bbb16f38356109a8ea529809e9acc708f0c97dbfac939dca68cdc0bd11805`).
- [ ] Ensure zero modification or unauthorized renaming.

#### Milestone 4: Licensing Audit & GPLv3 Compliance (Phase 4)
- [ ] Inspect FFmpeg/FFprobe build configuration (`--enable-gpl --enable-version3`).
- [ ] Ensure full GNU GPLv3 license text is bundled and staged.
- [ ] Provide exact source code download instructions for commit `089a48eb36`.
- [ ] Audit dependency licenses (librqbit Apache-2.0, yt-dlp Unlicense, TORI MIT/Apache-2.0) and verify mere aggregation compliance.

#### Milestone 5: GitHub Pre-release Preparation (Phase 5)
- [ ] Verify `git remote -v`, tags, and absence of conflicting `v1.0.1` tag.
- [ ] Verify GitHub authentication, permissions, and prepare draft release manifest and assets.
- [ ] Stage all release files in `release/v1.0.1-final/`.
- [ ] Present release URL and assets for approval without premature publication.

#### Milestone 6: Website Preparation (Phase 6)
- [ ] Locate official website project at `C:\Users\ritud\Downloads\tori-website`.
- [ ] Prepare `index.html` updates: Pre-release v1.0.1 section, Firefox XPI link, Edge ZIP link, checksums, while preserving stable v1.0.0.
- [ ] Verify build output and Cloudflare Pages compatibility.
- [ ] Hold deployment pending user publication authorization.

#### Milestone 7: Post-Publication Test Plan & Single-PC Safety (Phases 7 & 8)
- [ ] Author post-publication download verification script and procedure.
- [ ] Document single-PC safe installation protocol, registry keys, AppData locations, and file associations without executing modifications.
- [ ] Deliver comprehensive report `GATE18_8_PRE_RELEASE_AND_WEBSITE_PREPARATION_REPORT.md`.
