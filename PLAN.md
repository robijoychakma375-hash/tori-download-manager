# TORI Download Manager v1.0.1 — Milestone Plan: Gate 18.3F & Gate 18.3F.1
## Production Firefox Extension & Real Interactive Acceptance

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
