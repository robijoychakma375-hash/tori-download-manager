# TORI Download Manager v1.0.1 — Milestone Plan: Gate 18.3F
## Production Firefox Extension & Cross-Browser Integration

### Objectives
1. Develop and verify a fully functional Mozilla Firefox desktop extension (`extension/firefox/`).
2. Conform strictly to Firefox Manifest V3 specifications (event pages, Gecko-specific metadata, explicit data collection declarations).
3. Ensure 100% media detection and feature parity with existing Chromium/Edge extension without modifying underlying Rust download engine.
4. Implement Firefox Native Messaging support under `HKCU\Software\Mozilla\NativeMessagingHosts\com.tori.download_manager`.
5. Implement Local API origin validation for standard 36-character `moz-extension://<uuid>` origins with random token authentication.
6. Package a production-ready, signing-ready Firefox release candidate in `release/v1.0.1-firefox-candidate/`.
7. Verify zero regressions in Edge/Chromium extension, Rust workspace test suite (208 tests), clippy, and code formatting.
8. Deliver formal engineering acceptance report `GATE18_3F_FIREFOX_EXTENSION_REPORT.md`.

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
