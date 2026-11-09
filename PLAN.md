# TORI Download Manager v1.0.1 — Milestone Plan: Gate 18.3F, Gate 18.3F.1 & Gate 18.3F.2
## Production Firefox Extension, Real Interactive Acceptance & Fresh NSIS Installer Build

### Objectives
1. Develop and verify a fully functional Mozilla Firefox desktop extension (`extension/firefox/`).
2. Conform strictly to Firefox Manifest V3 specifications (event pages, Gecko-specific metadata, explicit data collection declarations).
3. Ensure 100% media detection and feature parity with existing Chromium/Edge extension without modifying underlying Rust download engine.
4. Implement Firefox Native Messaging support under `HKCU\Software\Mozilla\NativeMessagingHosts\com.tori.download_manager`.
5. Implement Local API origin validation for standard 36-character `moz-extension://<uuid>` origins with random token authentication.
6. Package a production-ready, signing-ready Firefox release candidate in `release/v1.0.1-firefox-candidate/`.
7. Verify zero regressions in Edge/Chromium extension, Rust workspace test suite (208 tests), clippy, and code formatting.
8. Deliver formal engineering acceptance report `GATE18_3F_FIREFOX_EXTENSION_REPORT.md`.
9. **Gate 18.3F.1:** Real interactive Mozilla Firefox `159.0.1.0` GUI verification, HTML5 video overlay injection, options pairing, popup inspection, end-to-end media download, byte-perfect SHA256 integrity, FFprobe bitstream validation, and formal report `GATE18_3F_1_FIREFOX_LIVE_ACCEPTANCE_REPORT.md`.
10. **Gate 18.3F.2:** Complete Firefox Native Messaging audit and NSIS installer registration hooks, verify Edge non-regression suite (12/12 PASS), reconcile repository versions to 1.0.1 (API 2.0.0), compile fresh release binaries, build fresh Windows x64 NSIS installer (`117,018,417 bytes`), sign with Ed25519 updater key (5/5 PASS), lint Firefox extension with `web-ext lint` (0 errors), stage final release package in `release/v1.0.1-firefox-final-candidate/`, and deliver formal report `GATE18_3F_2_FIREFOX_NATIVE_INSTALLER_REPORT.md`.

---

### Specific Measurable Milestones

#### Milestone 1: Firefox Manifest V3 & Code Synchronization — COMPLETED
- [x] Authored `extension/firefox/manifest.json` with Gecko ID `tori-download-manager@toridm.org`, `strict_min_version: "142.0"`, `background.scripts: ["background.js"]`, and `data_collection_permissions: { required: ["none"] }`.
- [x] Synchronized shared frontend logic, content scripts, DOM overlays, popup UI, options UI, and high-res icons into `extension/firefox/`.
- [x] Updated `extension/background.js` to whitelist `about:` and `moz-extension:` schemes and permit Firefox internal callers.
- [x] Executed official Mozilla `web-ext lint` with **0 errors and 0 warnings**.

#### Milestone 2: Native Host & Local API Origin Security — COMPLETED
- [x] Updated `crates/tdm-native-host/src/registry.rs` with `DEFAULT_FIREFOX_EXTENSION_ID`, `get_firefox_manifest_path()`, and registry handling under `HKCU\Software\Mozilla\NativeMessagingHosts\com.tori.download_manager`.
- [x] Updated `crates/tdm-native-host/src/server.rs` to authorize valid 36-char UUID `moz-extension://` origins with strict hex/hyphen validation.
- [x] Added Rust unit test `test_is_allowed_origin_firefox` (10/10 native host tests passing).
- [x] Updated NSIS installer hooks in `src-tauri/nsis/hooks.nsh` to register and remove Mozilla NativeMessagingHosts on Windows install/uninstall.

#### Milestone 3: Firefox Packaging & Verification Suite — COMPLETED
- [x] Authored build script `scripts/build_firefox_extension.js` and packaged `tori-download-manager-firefox-v1.0.1.zip` (69,285 bytes) in `release/v1.0.1-firefox-candidate/`.
- [x] Generated `SHA256SUMS.txt`, manifest copy, and comprehensive `README.md` with AMO signing and sideloading instructions.
- [x] Authored automated verification harness `scripts/verify_firefox_integration.js` covering 14 discrete integration scenarios.
- [x] Executed verification harness with **14/14 PASS (100% success rate)** including real headless Firefox `159.0.1.0` process execution.

#### Milestone 4: Workspace Quality & Regression Verification — COMPLETED
- [x] Verified code formatting: `cargo fmt --all -- --check` (0 diffs).
- [x] Verified clippy: `cargo clippy --workspace --all-targets -j 2 -- -D warnings` (0 warnings/errors).
- [x] Verified test suite: `cargo test --workspace -j 2` (**208 passed; 0 failed**).
- [x] Verified UI build: `npm run build --prefix ui` (clean, 346ms).
- [x] Verified release binary smoke test: `node scripts/smoke_test_release.js` (PASS).
- [x] Verified Edge/Chromium real browser non-regression via CDP (PASS).
- [x] Authored and delivered `GATE18_3F_FIREFOX_EXTENSION_REPORT.md`.

#### Milestone 5: Gate 18.3F.1 Real Interactive GUI & Download Acceptance — COMPLETED
- [x] Fresh release binaries rebuilt containing commit `dd9f14b`: `target/release/tori-download-manager.exe` and `target/release/tdm-native-host.exe`.
- [x] Stable installed TORI v1.0.0 (`C:\Program Files\Tori Download Manager`) confirmed untouched.
- [x] Marionette automation harness implemented: temporary add-on installation of `tori-download-manager@toridm.org` into live Mozilla Firefox `159.0.1.0`.
- [x] Floating video overlays (`data-tori-attached="true"`, `.tori-mp`) injected on multiple HTML5 videos.
- [x] Options tab paired with isolated Local API (port 19800) using random auth token; status verified `authenticated: true`.
- [x] Popup tab inspected: direct MP4 and WebM candidates displayed; streaming transport fragments (`.ts`) suppressed.
- [x] Real media download triggered from Firefox extension (`ffb4ecdd-a0f1-4462-a214-8108d0bd5d9b`).
- [x] Download completed to disk: `1,535,349` bytes.
- [x] SHA256 matches fixture byte-for-byte: `DDD9B6D4A24FAAA25837EBC645AC34088797D3504D64DA455023EA3AB833A1DF`.
- [x] FFprobe validation: H.264 video stream, 1280x720, duration 15.000000s.
- [x] Real screenshots captured and saved to artifact directory:
  - `screenshots/firefox_gui_multivideo.png`
  - `screenshots/firefox_options_paired.png`
  - `screenshots/firefox_popup_media_list.png`
- [x] Native Messaging investigated in-browser: observed error `"No such native application com.tori.download_manager"` confirms strict HKCU registry discovery requirement.
- [x] Local API acceptance separated from Native Messaging acceptance.
- [x] Exact HKCU registry change specification, backup, and restore commands documented for user authorization.
- [x] AMO signing-ready ZIP staged: `release/v1.0.1-firefox-candidate/tori-download-manager-firefox-v1.0.1.zip` (69,646 bytes, 0 web-ext errors).
- [x] Authored and delivered `GATE18_3F_1_FIREFOX_LIVE_ACCEPTANCE_REPORT.md` (20/20 PASS, 100.0%).

#### Milestone 6: Gate 18.3F.2 Firefox Native Messaging Closure & Fresh NSIS Installer Build — COMPLETED
- [x] Audited Native Host registry registration and NSIS hooks (`src-tauri/nsis/hooks.nsh`) for Chrome, Edge, and Firefox.
- [x] Audited dual Native Messaging manifests: `com.tori.download_manager.json` and `com.tori.download_manager.firefox.json`.
- [x] Confirmed development host registry safety: no unapproved registry writes executed on primary machine.
- [x] Verified Firefox functional fallback to Local API when Native Messaging host is not registered in system registry.
- [x] Executed Microsoft Edge live browser non-regression suite (`scripts/verify_gate18_3f2_edge_regression.js`) via CDP: **12/12 PASS (100.0%)** covering MV3 integrity, isolated engine pairing on port 19700, stdio framing handshake, popup media detection, tab isolation, download handoff, deduplication (`already_exists`), 1.5MB download completion, byte-perfect SHA256 match, and disconnection/reconnection.
- [x] Reconciled versions across repository: `Cargo.toml` (`1.0.1`), `src-tauri/tauri.conf.json` (`1.0.1`), `ui/package.json` (`1.0.1`), `extension/manifest.json` (`1.0.1`), `extension/firefox/manifest.json` (`1.0.1`), and clarified options page text to `Version 1.0.1 (API v2.0.0)`.
- [x] Passed full workspace verification: `cargo fmt --all -- --check` (0 diffs), `cargo clippy --workspace --all-targets -j 2 -- -D warnings` (0 warnings), `cargo test --workspace -j 2` (**208 passed; 0 failed** across 28 suites), React UI build (315ms).
- [x] Fresh release binaries compiled (`cargo build --release --workspace -j 2`) and updated in `resources/bin/` (`tdm-native-host.exe`, `tdm-cli.exe`).
- [x] Built fresh Windows x64 NSIS installer: `target/release/bundle/nsis/TORI Download Manager_1.0.1_x64-setup.exe` (**117,018,417 bytes**).
- [x] Cryptographically signed installer with updater key: `TORI Download Manager_1.0.1_x64-setup.exe.sig` (436 bytes), verified via `updater_cryptography_tests` (**5 passed; 0 failed**).
- [x] Packaged AMO signing-ready Firefox candidate ZIP: `release/v1.0.1-firefox-candidate/tori-download-manager-firefox-v1.0.1.zip` (**0 web-ext errors**).
- [x] Staged complete final candidate package in `release/v1.0.1-firefox-final-candidate/` with `FINAL_CANDIDATE_MANIFEST.json`, `INSTALLATION_AND_UPGRADE_NOTES.md`, and `SHA256SUMS.txt`.
- [x] Authored and delivered formal engineering report `GATE18_3F_2_FIREFOX_NATIVE_INSTALLER_REPORT.md`.

#### Milestone 7: Gate 18.3F.3 Final Release Blocker Closure — COMPLETED
- [x] Verified package completeness and exact cryptographic hash match (100% byte-for-byte SHA256) across all 9 assets in `release/v1.0.1-firefox-final-candidate/`.
- [x] Verified Firefox AMO signing readiness: Gecko ID `tori-download-manager@toridm.org`, MV3 manifest validity (`web-ext lint` 0 errors, 0 warnings), unlisted distribution eligibility, and exact `web-ext sign` procedure.
- [x] Prepared automated Separate Windows PC Installation Acceptance Harness in both PowerShell (`verify_separate_pc_installation.ps1`) and Node.js (`verify_separate_pc_installation.js`) covering all 10 installation/uninstall acceptance criteria.
- [x] Kept separate PC installation scenarios classified as NOT TESTED in strict compliance with safety rules prohibiting unauthorized primary host registry modification or sandbox usage.
- [x] Executed full Release Safety & Credential Audit (`audit_release_safety.js`) with **8/8 PASS (100.0%)**: zero leaked secrets, zero debug databases/PDBs, licenses verified, version parity verified, crypto distinction verified.
- [x] Updated third-party attribution in `resources/LICENSE-THIRD-PARTY.txt` to v1.0.1 and included Tokio, Tauri, and Rust runtime libraries.
- [x] Authored formal release notes `TORI_V1_0_1_RELEASE_NOTES.md` and pre-release verification checklist `TORI_V1_0_1_FINAL_RELEASE_CHECKLIST.md`.
- [x] Authored and delivered formal engineering acceptance report `GATE18_3F_3_RELEASE_BLOCKER_REPORT.md`.
- [x] Stopped cleanly awaiting separate user decision for external signing and physical testing.
