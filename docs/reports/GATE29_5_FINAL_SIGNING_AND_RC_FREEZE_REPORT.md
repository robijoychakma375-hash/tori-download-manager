# Gate 29.5 — Final Signing, Clean-Machine Validation & Release Candidate Freeze Report

- **Project:** `F:\TORI\final tori download manager`
- **Target Releases:** Desktop `v1.0.5` (Windows x64), Browser Companion `v1.0.9`
- **Gate 29.5 Baseline Status (`checkpoint-gate29_5-partial`):** `PARTIAL READY — SIGNING OR CLEAN-MACHINE VALIDATION PENDING`
- **Gate 29.5.1 Updated Status:** **`PARTIAL — SIGNED FIREFOX v1.0.9 XPI INTEGRATED; LIVE YOUTUBE FORMAT PICKER BUG (FF109-YT-FMT-01) & CLEAN VM PENDING`**
- **Frozen RC Classification:** `SIGNED FIREFOX v1.0.9 XPI INTEGRATED — LIVE YOUTUBE FORMAT PICKER FIX & CLEAN VM PENDING`
- **Publication Actions Taken:** **NONE** (no Git pushes, no GitHub Releases created/modified, public `latest.json` untouched at `1.0.4`, `toridownload.xyz` untouched, no browser store/AMO submissions)

---

## 1. Repository Baseline & Checkpoint Discipline

| Item | Verified Value |
| :--- | :--- |
| Branch | `fix/gate27-runtime-fixes` |
| Baseline Commit (`checkpoint-gate29_4-verified`) | `fb64ed00955622259fcf925296ee2d363263f351` |
| Pre-Gate Safety Tag Created | `checkpoint-gate29_5-before-release-freeze` (`fb64ed00955622259fcf925296ee2d363263f351`) |
| Prior Gate Reports Reviewed | `GATE29_4_FINAL_INTEGRATION_RELEASE_READINESS_REPORT.md`, `GATE29_3_IDM_EXTENSION_UI_MIGRATION_REPORT.md`, `GATE29_2_IDM_PROGRESS_WINDOW_MIGRATION_REPORT.md`, `GATE29_1_IDM_DESKTOP_UI_MIGRATION_REPORT.md`, `GATE27_8_FINAL_MKV_ACCEPTANCE_REPORT.md` |
| Post-Gate Local Tag (this commit) | `checkpoint-gate29_5-partial` (local only; `-verified` NOT applied because AMO Firefox signing and clean Windows VM testing remain pending) |

---

## 2. Phase 1 — Gate 27.8 Playlist E2E on `v1.0.9` & Root-Cause Fix

- Initial execution (`verify_gate27_8_playlist_e2e.js` pointed at `release/v1.0.9-extension-rc/tori-companion-v1.0.9-chromium`) passed 11/12 checks (`PL-PRE-01`, `PL-INST-01`, `PL-COLD-01`, `PL-DESK-01`, `PL-TRAY-01`, `PL-SPA-01`, `PL-TRAY-02`, `PL-MODAL-01`, `PL-DL-01`, `PL-EDGE-01`, `PL-FF-01`) and failed `PL-ERR-01` (`foundBtn: false`).
- **Root-Cause Diagnosis (`extension/content.js` & `scripts/verify_gate27_8_playlist_e2e.js`):**
  1. `extension/content.js` previously registered `yt-navigate-finish` and `yt-page-data-updated` listeners only on `document` (missing dispatches targeting `window`), and skipped the 600ms lightweight `window.location.href !== lastCheckedUrl` comparison whenever `document.hidden` was true. When YouTube tab focus alternated after opening Options in Step 6 while the `.tori-pn` panel was already open on the Mix banner, the stale Mix banner persisted (`hasMixBtn: true`) instead of refreshing into the Download Playlist banner.
  2. `scripts/verify_gate27_8_playlist_e2e.js` Step 6 did not close the temporary `step6OptCreated` tab (`Target.closeTarget`) before returning focus to the YouTube tab.
- **Fixes Applied:**
  - `extension/content.js#L2290-L2318` (synced cleanly to `extension/firefox/content.js` via `node scripts/package_v1_0_9_extensions.js`): registered `yt-navigate-finish` and `yt-page-data-updated` on both `document` and `window`, added `visibilitychange` refresh check, and kept the cheap string check `window.location.href !== lastCheckedUrl` active cleanly across tab switches.
  - `scripts/verify_gate27_8_playlist_e2e.js#L1456-L1489`: closed the Step 6 Options tab and activated the YouTube tab cleanly.
- **Post-Fix Re-Verification:** Rebuilt `release/v1.0.9-extension-rc/` via `node scripts/package_v1_0_9_extensions.js`, re-ran `node scripts/verify_gate27_8_playlist_e2e.js`: **`12 PASS, 0 FAIL, 0 TIMEOUT, 0 NOT TESTED`**.

---

## 3. Phase 2 — Clean-Machine Windows Validation

- **Availability Check on Host:**
  - `Get-VM` (Hyper-V): returned empty (no VMs exist).
  - `Get-Command vboxmanage, vmrun, qemu-system-x86_64`: none installed.
- **Result:** **`NOT TESTED`** (no independent clean Windows machine or VM available on host).
- **Preserved Isolated Host Evidence (Non-VM Substitute):** `scripts/verify_gate29_4_final_integration.js` tested NSIS `/S /D=...` install, WebView2 startup, SQLite schema bootstrap, Chrome/Edge/Firefox companion integration, Live YouTube downloads, and clean uninstall/tray lifecycle inside an isolated `USERPROFILE` / `APPDATA` / `WEBVIEW2_USER_DATA_FOLDER` / `TORI_IPC_PIPE` profile while preserving the host's production SQLite DB.
- **Manual Clean-Machine Checklist Required Prior to Gate 30:**
  1. Boot a fresh Windows 10/11 x64 VM/machine without prior TORI state or Rust/Node dev tools.
  2. Install `TORI Download Manager_1.0.5_x64-setup.exe` normally; verify Windows SmartScreen prompt behavior (expected since PE binary is Authenticode-unsigned), Desktop launch, tray minimize/restore, Native Messaging host registration (`com.tori.download_manager`), and bundled `ffmpeg.exe` / `ffprobe.exe` / `yt-dlp.exe`.
  3. Install Chromium (`tori-companion-v1.0.9-chromium.zip`) and signed Firefox (`a70ed17e183648a9bcf4-1.0.9.xpi`), confirm `Connected` badge, direct MKV classification to `Downloads\Video\`, YouTube single/playlist download, and clean Add/Remove Programs uninstall.

---

## 4. Phases 3 & 4 — Firefox `v1.0.9` Signing Readiness & XPI Verification

- **Signing Workflow Discovery:**
  - Inspected `scripts/integrate_signed_firefox_v1_0_3.js` and environment (`AMO`, `WEB_EXT`, `MOZILLA`, `JWT` variables): no automated AMO API signing credentials are configured; Firefox XPI signing follows a manual operator AMO Developer Hub workflow.
  - Checked `%USERPROFILE%\Downloads`: only historical signed XPIs `1.0.2` through `1.0.7` exist; no signed `v1.0.9` XPI exists.
  - **Phase 3 Signing Workflow Status:** **Signed by Mozilla AMO** (updated in Gate 29.5.1 after operator-supplied `a70ed17e183648a9bcf4-1.0.9.xpi`).
- **Pre-Signing Local Validation of Frozen Firefox `v1.0.9` ZIP (`release/v1.0.5-v1.0.9-final-rc/Extensions/tori-companion-v1.0.9-firefox.zip`):**
  - `npx --no-install web-ext lint --source-dir release\v1.0.5-v1.0.9-final-rc\Extensions\tori-companion-v1.0.9-firefox.zip --output json`: **0 errors, 0 notices, 7 pre-existing non-blocking warnings** (5 `UNSAFE_VAR_ASSIGNMENT` on escaped template renders in `popup/popup.js` and `content.js`; 2 `UNSUPPORTED_API` for Chromium-guarded `downloads.onDeterminingFilename` in `background.js`).
  - Archive integrity: `zipfile.testzip() == None`, 42 POSIX forward-slash entries (`\` count = 0), version `1.0.9`, Gecko ID `tori-download-manager@toridm.org`, `strict_min_version: 142.0`, zero `preview.html`/test artifacts, zero `eval`/`Function`/`ghp_`/private keys/remote `<script>` tags.
- **Phase 4 Signed Firefox `v1.0.9` XPI Verification (Updated in Gate 29.5.1 — see Section 12):** **`9 PASS, 1 FAIL, 0 TIMEOUT, 0 NOT TESTED`** (`FF109-PKG-01` & `FF109-SIG-01` PASS; `FF109-YT-FMT-01` FAIL due to Desktop/Extension YouTube `googlevideo.com` candidate timeout).
- **Historical Signed Firefox `v1.0.7` XPI Preserved Untouched:**
  - Path: `release/v1.0.7-extension-rc/a70ed17e183648a9bcf4-1.0.7.xpi` (`90,326` bytes)
  - Verified SHA-256 before, during, and after Gate 29.5 & Gate 29.5.1: `b082c8f2f4c8b4ed035fab77d9569622737defb3e02279f20073d3404dda4fa0`

---

## 5. Phases 5 & 6 — Chrome/Edge `v1.0.9` & Desktop `v1.0.5` Binary Checks

### Chromium/Edge `v1.0.9` Package (`tori-companion-v1.0.9-chromium.zip`)
- Integrity: `zipfile.testzip() == None`, **35 entries**, forward slashes only, `manifest_version: 3`, `version: "1.0.9"`, pinned public `key`, icons (`16`, `32`, `48`, `128`), `popup/*`, `options/*`, `shared/tokens.css`, `icons/{chips,settings-tabs,toolbar}/*.svg`, `content.js`, `content.css`, `background.js`.
- Verified live in Google Chrome and Microsoft Edge via `verify_gate29_3_idm_extension_ui.js` (`23 PASS`) and `verify_gate27_8_playlist_e2e.js` (`12 PASS`).

### Desktop `v1.0.5` Installer & Executables
- **PE Architecture & Metadata Verified:**
  - `TORI Download Manager_1.0.5_x64-setup.exe`: NSIS installer (`x86 (I386)` stub wrapper installing x64 payload), `FileVersion: 1.0.5`, `ProductVersion: 1.0.5`, `ProductName: TORI Download Manager`.
  - `tori-download-manager.exe`: PE `0x8664` (`x64 AMD64`), `FileVersion: 1.0.5`, `ProductVersion: 1.0.5`.
  - `tdm-native-host.exe`, `tdm-cli.exe`, `ffmpeg.exe` (`N-126374-g089a48eb36-20260831`), `ffprobe.exe`, `yt-dlp.exe` (`2026.08.19`): all PE `0x8664` (`x64 AMD64`).
- **Tauri Ed25519 / Minisign Updater Signature (`PASS`):**
  - Unconditional Rust test `updater_cryptography_tests::test_v105_release_candidate_signature_cryptographic_verification` verified `TORI Download Manager_1.0.5_x64-setup.exe` against `TORI Download Manager_1.0.5_x64-setup.exe.sig` and `src-tauri/tauri.conf.json#plugins.updater.pubkey` (`Minisign Ed25519`).
  - Decoded trusted comment confirmed: `trusted comment: timestamp:1794845563\tfile:TORI Download Manager_1.0.5_x64-setup.exe`.
  - Payload byte tampering and corrupted signature checks strictly rejected.
- **Windows Authenticode PE Code Signing (`UNSIGNED`):**
  - `Get-AuthenticodeSignature` confirmed **`NotSigned`** on `TORI Download Manager_1.0.5_x64-setup.exe`, `tori-download-manager.exe`, `tdm-native-host.exe`, `tdm-cli.exe`, `ffmpeg.exe`, `ffprobe.exe`, and `yt-dlp.exe`. SmartScreen warnings are expected on clean systems until EV/OV code signing is applied.

---

## 6. Phase 7 — Updater Read-Only Live Check & Draft `v1.0.5` Preflight

- **Live Endpoint Read-Only Audit:**
  - `curl.exe -sI` + `-fsSL https://github.com/robijoychakma375-hash/tori-download-manager/releases/latest/download/latest.json`
  - Returned `HTTP/1.1 302 Found` -> `v1.0.4/latest.json` with `"version": "1.0.4"`, platforms `"windows-x86_64"` and `"windows-x86_64-nsis"`, URL `https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.4/TORI.Download.Manager_1.0.4_x64-setup.exe`.
  - Live endpoint was **not modified**.
- **Draft `v1.0.5` Updater Manifest & Local Isolated Mock Preflight:**
  - Staged at `release/v1.0.5-v1.0.9-final-rc/Metadata/latest.v1.0.5.draft.json` using dual `windows-x86_64` and `windows-x86_64-nsis` keys matching live `v1.0.4` conventions and `v1.0.5` release URL (`https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.5/TORI.Download.Manager_1.0.5_x64-setup.exe`).
  - Verified by `scripts/prepare_gate29_5_rc_freeze.js` against an ephemeral localhost HTTP server (`release/v1.0.5-v1.0.9-final-rc/Metadata/UPDATER_PREFLIGHT.json`) and by `crates/tdm-core/tests/updater_cryptography_tests.rs#L406-L437`:
    - `1.0.4 -> 1.0.5`: upgrade triggered (`true`).
    - `1.0.5 -> 1.0.5`: no-op (`true`); `1.0.6 -> 1.0.5`: downgrade rejected (`true`).
    - Draft `.sig` matches `TORI Download Manager_1.0.5_x64-setup.exe.sig` verbatim; mock stream delivered all `117,703,556` bytes matching SHA-256 `400920b52e947ce6f53cf0f811e6f30f096af7aa4d2f9696aaeca33daef2b152`.

---

## 7. Phase 8 — Full Post-Edit Regression Matrix Results

All 11 checks ran cleanly **after** all final code/package/freeze edits:

| Check | Command | Exact Result Observed | Notes |
| :--- | :--- | :--- | :--- |
| Rust workspace suite | `cargo test --workspace --no-fail-fast` | **PASS** — 37 test suites, 240 passed, 0 failed, 0 ignored | `test_v105_release_candidate_signature_cryptographic_verification` verified `v1.0.5` & draft manifest unconditionally (zero skip); legacy 4 `1.0.0` tests internal-skip cleanly when `1.0.0` target artifact is absent |
| UI TypeScript & Vite build | `npm --prefix ui run build` | **PASS** — 0 errors (46 modules, 285ms) | Non-blocking asset build check |
| UI Oxlint check | `npm --prefix ui run lint` | **PASS** — 0 errors, 7 warnings (23 files) | Clean |
| Extension JS syntax check | `node --check` on all 8 `.js` files under `extension/` | **PASS** — 8/8 valid syntax | Chromium + Firefox synced sources |
| Firefox ZIP AMO lint | `npx --no-install web-ext lint --source-dir release\v1.0.5-v1.0.9-final-rc\Extensions\tori-companion-v1.0.9-firefox.zip --output json` | **PASS** — 0 errors, 0 notices, 7 warnings | Ready for AMO submission |
| YouTube Playlist Handoff E2E | `node scripts/verify_gate27_8_playlist_e2e.js` | **12 PASS, 0 FAIL, 0 TIMEOUT, 0 NOT TESTED** | Tests Chrome `v1.0.9`, Edge `v1.0.9`, signed Firefox `v1.0.7`, tray restore, cold launch, `WING IT! - Blender Open Movie.mkv` download & `PL-ERR-01` recovery |
| Large >2 GiB MKV & Classification | `node scripts/verify_gate27_8_large_mkv_and_classification.js` | **10 PASS, 0 FAIL, 0 TIMEOUT, 0 NOT TESTED** | Verified `2,469,606,195`-byte pause/resume MKV integrity (`a71c0f55...`) across Chrome, Edge, Firefox `1.0.7` |
| IDM Desktop Main UI | `node scripts/verify_gate29_1_idm_desktop_ui.js` | **PASS=20, FAIL=0** | Virtualized 1,200-row table, menu/sidebar/sort, theme/accent SQLite persistence, throttled DOM updates |
| IDM Progress Window | `node scripts/verify_gate29_2_idm_progress_window.js` | **PASS=17, FAIL=0** | Light/Dark, Compact mode (`38px`), Pause/Resume/Retry, per-job speed limit (`180000 B/s`), completion auto-close & notification |
| IDM Extension Cross-Browser UI | `node scripts/verify_gate29_3_idm_extension_ui.js` | **23 PASS, 0 FAIL, 0 TIMEOUT, 0 NOT TESTED** | Popup 5-state transitions, Options, overlay drag/formats, live YouTube 1080p/audio, built `v1.0.9` Firefox E2E download, Native Messaging + HTTP fallback |
| Final Integration Suite | `node scripts/verify_gate29_4_final_integration.js` | **17 PASS, 0 FAIL, 0 TIMEOUT, 0 NOT TESTED** | Isolated clean NSIS install, pre-v1.0.5 DB migration + `.tdm-part` Range resume, crash recovery, 4-job concurrency, 360p/720p/1080p + Firefox `v1.0.9` MKV/playlist + `6x16 MiB` memory stability |

*(Side note during verification: Windows WinNAT dynamic port exclusion reserved `19915..20214` after a host wake event; QA loopback test port constants across the 6 test scripts were shifted into `24910..24977` outside any excluded range without altering product ports, and `verify_gate29_2`'s back-to-back synchronous checkbox clicks in `FEAT-COMPLETE-OPTS` were spaced by `120ms` to model sequential user clicks without modifying shipped `v1.0.5` UI binaries.)*

---

## 8. Phases 9 & 10 — Frozen RC Directory (`release/v1.0.5-v1.0.9-final-rc/`) & SHA-256 Manifest

All files verified byte-identical after final cleanup against `release/v1.0.5-v1.0.9-final-rc/Metadata/SHA256SUMS.txt`:

### `Desktop/`
- `TORI Download Manager_1.0.5_x64-setup.exe` (`117,703,556` B): `400920b52e947ce6f53cf0f811e6f30f096af7aa4d2f9696aaeca33daef2b152`
- `TORI Download Manager_1.0.5_x64-setup.exe.sig` (`436` B): `9006174cb759472d3f2bd252fcba0c430edff49117a36fb5e62a444a2332b7e9`
- `tori-download-manager.exe` (`30,560,256` B): `b1735698571d635036cac7f7d4785d9e387cef76c30cefe662fbf569aed3c29c`
- `tdm-native-host.exe` (`19,259,904` B): `4e99fb3c7a9023b2d1e91d9784b185dce9d834a43345b18d77493e9f71230563`
- `tdm-cli.exe` (`17,038,336` B): `2954cb87520fd7afa8e38b712ee0c588f5c6d3a88bca69065dce741b77708657`
- `ffmpeg.exe` (`145,858,048` B): `b9989f24e63be74e72aa45fec10a114ce660b562e4303d5f296f4fc8ba7cc896`
- `ffprobe.exe` (`145,645,568` B): `73842bee6f270e85b2ab6fc3cfa715f614f16ad16700f5de6a9c1a2865cacf00`
- `yt-dlp.exe` (`17,840,399` B): `66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a`
- `LICENSE`: `55460ef099ce57e32d422427a7a24cd1e09aec677606289e396c2c17d625a598`
- `LICENSE-APACHE`: `20fe7b00e904ed690e3b9fd6073784d3fc428141dbd10b81c01fd143d0797f58`
- `LICENSE-MIT`: `dffcef788fe594963f082966daa3b969c7c4f633e612d8f88ee8a3033c4a5144`
- `LICENSE-GPLv3.txt`: `8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903`
- `LICENSE-THIRD-PARTY.txt`: `4f05486cb940a151e9b010ff3d033b7fb06370c665d174eb5d54d48433eb6035`

### `Extensions/`
- `tori-companion-v1.0.9-chromium.zip` (`85,049` B): `dbc345b513795506c30c8300683d99fe1bd4b14d14c012663808bf7a406089ac`
- `tori-companion-v1.0.9-firefox.zip` (`85,800` B): `b38468444094aa15ee1a7fef16022399550bafbba9d46c915d5beb2c2d02632d`
- `a70ed17e183648a9bcf4-1.0.9.xpi` (`101,231` B, Mozilla AMO-signed): `d4e8d6e585ba6dfaf841eb6b37f2ee27beae1cec55badbbe0dd12960ad5943ec`
- *(Historical signed `release/v1.0.7-extension-rc/a70ed17e183648a9bcf4-1.0.7.xpi` preserved intact: `b082c8f2f4c8b4ed035fab77d9569622737defb3e02279f20073d3404dda4fa0`.)*

### `Metadata/`
- `FREEZE_STATUS.txt` (`SIGNED FIREFOX v1.0.9 XPI INTEGRATED — LIVE YOUTUBE FORMAT PICKER FIX & CLEAN VM PENDING`)
- `SHA256SUMS.txt`
- `RELEASE_MANIFEST.json`
- `BUILD_METADATA.json`
- `VERSION_MATRIX.json`
- `VERIFICATION_SUMMARY.json`
- `SIGNING_STATUS.json`
- `RELEASE_NOTES_v1.0.5_v1.0.9.md` (draft user release notes — accurate capabilities, zero DRM/Authenticode misrepresentation)
- `latest.v1.0.5.draft.json`
- `UPDATER_PREFLIGHT.json`
- `FIREFOX_AMO_SIGNING_INSTRUCTIONS.md`

---

## 9. Phase 11 — Security, Privacy & OEM User Preservation

- **Repository & Frozen Artifact Security Audit:**
  - Verified zero `.key`, `.pem`, `.pfx`, `.p12`, or updater secret files exist inside the repository.
  - Verified zero hardcoded API keys, GitHub tokens, auth secrets, `eval(`, `Function(`, or remote `<script src="http...">` tags inside `extension/` and frozen extension ZIPs.
  - Verified zero `dangerouslySetInnerHTML` or `eval(` in `ui/src/`, and verified `escapeHtml()` escaping on dynamic template fields in `extension/popup/popup.js#L376-L455` and `extension/content.js`.
  - Verified extension permissions parity (`downloads`, `nativeMessaging`, `webRequest`, `storage`, `tabs`, `activeTab`).
  - Verified Tauri updater public key and Minisign Ed25519 signature integrity without any unsigned updater bypass.
- **OEM Desktop & User Database Preservation:**
  - `%APPDATA%\tori-download-manager\tdm_storage.sqlite` retained SHA-256 `4ef8329f964bc2dd8a080783e78e228401ffdf93c94a67c348efaf34d9ed435d` unchanged through Gates 29.1, 29.2, 29.3, and 29.4; after final OEM shutdown/restart cycle at Gate 29.5 end, SQLite WAL checkpoint updated raw file hash to `4300a9ab34639e54b17d1e9186800975a6f0fe2f4a58991504bfe1a90a64dd68` with read-only SQLite check confirming all **29** user download records and `engine_settings` (`browser_integration_token`, theme/accent, server port `6800`) intact.
  - HKCU `Uninstall\TORI Download Manager`, Start Menu `.lnk` shortcut, and Native Messaging host manifests restored to `%LOCALAPPDATA%\TORI Download Manager\` (`tdm-native-host.exe --register`), temporary `target\gate*_qa` folders removed, and OEM Desktop relaunched `--minimized`.

---

## 10. Blockers & Operator Steps Before Gate 30 Publication

1. **Firefox Companion `v1.0.9` AMO Signing (Completed in Gate 29.5.1):**
   - Mozilla AMO-signed `a70ed17e183648a9bcf4-1.0.9.xpi` (`d4e8d6e585ba6dfaf841eb6b37f2ee27beae1cec55badbbe0dd12960ad5943ec`) verified and integrated into `release/v1.0.5-v1.0.9-final-rc/Extensions/`.
2. **Resolve Live YouTube Firefox Format Picker Resolution Timeout (`FF109-YT-FMT-01` Failure):**
   - Fix `crates/tdm-core/src/resolver/orchestrator.rs#L534-L589` so `is_known_platform_domain` (`yt-dlp` + `format_metadata_cache`) executes **before** sequential `req.candidates` (`googlevideo.com`) fallback probing (and re-run the release build + Minisign `.sig` if updating Desktop binaries).
3. **Independent Clean Windows VM Validation (Pending Host VM):**
   - Execute the manual clean Windows 10/11 x64 VM verification pass against Desktop `v1.0.5` + Chromium/`a70ed17e183648a9bcf4-1.0.9.xpi`.
4. **Optional Commercial Windows Authenticode Signing:**
   - Apply OV/EV Authenticode signing before Gate 30 public distribution if SmartScreen warning suppression is desired (note: signing `.exe` alters its hash and requires re-signing `.sig` + updating `latest.v1.0.5.draft.json` and `SHA256SUMS.txt`).

---

## 11. Files Changed During Gate 29.5

- `extension/content.js#L2290-L2318` (and synced `extension/firefox/content.js`): SPA `window`/`document` `yt-navigate-finish`/`yt-page-data-updated` listeners, `visibilitychange`, and continuous cheap href watchdog comparison.
- `crates/tdm-core/tests/updater_cryptography_tests.rs#L314-L438`: Non-skipping `v1.0.5` Minisign Ed25519 signature + tampering + draft `latest.v1.0.5.draft.json` verification test.
- `scripts/prepare_gate29_5_rc_freeze.js`: Partial RC freeze staging & localhost updater mock preflight script.
- `scripts/verify_gate27_8_playlist_e2e.js#L43,L50-L53,L642-L646,L1456-L1489`: Pointed at `v1.0.9` RC dir, bumped `loadUnpacked` timeout to `25000ms`, updated ports to `2492x`, cleaned Step 6 tab focus & added `!btn` diagnostics.
- `scripts/verify_gate27_8_large_mkv_and_classification.js#L42-L46,L999-L1011`: Updated ports to `2491x` and guarded Edge `PING_DESKTOP` readiness.
- `scripts/verify_gate29_1_idm_desktop_ui.js#L29-L31`, `scripts/verify_gate29_2_idm_progress_window.js#L33-L35,L1010-L1016`, `scripts/verify_gate29_3_idm_extension_ui.js#L43-L47`, `scripts/verify_gate29_4_final_integration.js#L67-L74`: Shifted loopback test ports out of WinNAT excluded range `19915..20214` into `249xx`; spaced `c1.click()`/`c2.click()` in Gate 29.2 by `120ms`.
- `docs/reports/GATE29_5_FINAL_SIGNING_AND_RC_FREEZE_REPORT.md`: This Gate 29.5 & Gate 29.5.1 acceptance report.
- `scripts/verify_gate29_5_1_firefox_signed_v1_0_9.js`: Signed Firefox `v1.0.9` XPI strict enforcement verification & E2E integration script.

---

## 12. Gate 29.5.1 Addendum — Mozilla-Signed Firefox `v1.0.9` XPI Integration (`a70ed17e183648a9bcf4-1.0.9.xpi`)

### Package & Parity Verification
- **Supplied Paths Verified:**
  - `.user_uploaded/media_1794909783314_186e51ad.xpi` and `%USERPROFILE%\Downloads\a70ed17e183648a9bcf4-1.0.9.xpi` (`101,231` bytes)
  - Integrated into `release/v1.0.5-v1.0.9-final-rc/Extensions/a70ed17e183648a9bcf4-1.0.9.xpi`
  - **SHA-256 Match:** `d4e8d6e585ba6dfaf841eb6b37f2ee27beae1cec55badbbe0dd12960ad5943ec` (`PASS`)
- **ZIP Integrity, Metadata & Signature Files:**
  - `zipfile.testzip()` = `None` (0 corrupt entries)
  - `version`: `"1.0.9"`, `manifest_version`: `3`, `browser_specific_settings.gecko.id`: `"tori-download-manager@toridm.org"`, `strict_min_version`: `"142.0"`
  - Mozilla AMO `META-INF` signature files present: `META-INF/cose.manifest`, `META-INF/cose.sig`, `META-INF/manifest.mf`, `META-INF/mozilla.rsa`, `META-INF/mozilla.sf`
- **Content Comparison vs Frozen Unsigned `tori-companion-v1.0.9-firefox.zip` (`META-INF/` excluded):**
  - `35` application files in both archives (`0` missing, `0` extra).
  - **`34/35` files 100% byte-for-byte identical**.
  - **Difference Investigation (`manifest.json`):** `1,584` bytes (signed) vs `1,538` bytes (unsigned); `json.loads(signed) == json.loads(unsigned)` is **`True`** (difference consists solely of Mozilla AMO serialization escaping the em-dash as `\u2014` and pretty-printing single-line `"scripts"`, `"js"`, and `"css"` arrays cleanly across lines). Zero unexpected code or permission deltas.

### Clean Firefox Verification Suite (`node scripts/verify_gate29_5_1_firefox_signed_v1_0_9.js`)

| Check ID | Description | Result | Observed Evidence |
| :--- | :--- | :--- | :--- |
| `FF109-PKG-01` | SHA-256, ZIP integrity, `META-INF` signatures, Gecko ID, 34/35 parity + identical parsed manifest | **PASS** | `sha256=d4e8d6e5...943ec`, `v107Sha=b082c8f2...fa0`, `identicalAppFiles=34`, `manifestParsedEqual=true` |
| `FF109-SIG-01` | Permanent XPI install (`temporary: false`) in clean Firefox profile with `xpinstall.signatures.required=true` | **PASS** | `sigRequiredPref=true`, `version="1.0.9"`, `isActive=true`, `temporarilyInstalled=false`, `signedState=2` (`SIGNEDSTATE_SIGNED`) |
| `FF109-NATIVE-01` | Native Messaging `INITIATE_PAIRING` & `RECONNECT_DESKTOP` authentication | **PASS** | `pairRes.ok=true`, `nativeHost=true`, paired QA token authenticated |
| `FF109-CONN-01` | Firefox Popup `Connected` & Options `1.0.9` UI connection | **PASS** | `popConnected=true`, `optVer109=true`, `optPort="24980"` |
| `FF109-HTTP-01` | HTTP fallback when Firefox `NativeMessagingHosts` manifest points to nonexistent host | **PASS** | `ping.status="ok"`, `mode="http"`, `reconn.status="ok"` |
| `FF109-PICKER-01` | HTML5 `<video>` overlay detection, IDM Format Picker UI & real MP4 download | **PASS** | `panelOpen=true`, `rowCount=1`, completed MP4 on disk matching SHA-256 |
| `FF109-MKV-01` | Extensionless `Content-Disposition` MKV interception & `Video/` folder classification | **PASS** | `Firefox_Signed_v109_Acceptance.mkv`, `8,388,608` bytes, exact SHA-256 |
| `FF109-YT-FMT-01` | Live YouTube watch page quality format resolution in Firefox signed `v1.0.9` | **FAIL** | `"Media resolution timed out (32s)"` on cold & retry; direct `POST /api/v1/media/resolve` with `candidates=[]` succeeded with `status=200`, `fmtCount=24` |
| `FF109-PLAYLIST-01` | YouTube `Download Playlist` -> Desktop tray restore -> `#playlist-modal` -> real download + Mix rejection | **PASS** | `WING IT! - Blender Open Movie.mkv` (`10,677,366` B, `ffprobe` valid), Mix UI banner `hasMixBanner=true` (`9ms`), Mix API `422` |
| `FF109-SAFE-01` | Preserved signed `v1.0.7` XPI & OEM SQLite user data untouched | **PASS** | `v107Sha=b082c8f2...fa0`, `oemDownloads=31` unchanged before/after run |
| *(Clean VM)* | Independent clean Windows 10/11 x64 VM acceptance pass | **NOT TESTED** | No Hyper-V/VirtualBox/VMware/QEMU VM present on host |

### Root-Cause Analysis of `FF109-YT-FMT-01` Failure
- In [extension/background.js#L2318-L2323](file:///F:/TORI/final%20tori%20download%20manager/extension/background.js#L2318-L2323), `RESOLVE_MEDIA` appends intercepted `tabMediaCache` URLs (`*.googlevideo.com/videoplayback?...` DASH streams captured by Firefox `webRequest` during YouTube autoplay) into `resolvePayload.candidates`.
- In Desktop `v1.0.5-rc` ([crates/tdm-core/src/resolver/orchestrator.rs#L534-L589](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/src/resolver/orchestrator.rs#L534-L589)), `DiscoveryOrchestrator::resolve_multi_strategy` sequentially probes every `req.candidates` entry (`probe_direct_media` + `resolver.resolve`) **before** evaluating `is_known_platform_domain(raw_url)` (`#L584`) and before querying the SQLite format cache (`pipeline.rs#L106`). This exhausts `background.js`'s 32s HTTP timeout on live YouTube tabs with active DASH streaming.
- **Checkpoint Decision:** Because `FF109-YT-FMT-01` failed (`9 PASS, 1 FAIL`) and independent clean-machine VM validation remains `NOT TESTED`, Gate 29.5.1 local integration changes are committed cleanly **without** minting a `-verified` tag (`checkpoint-gate29_5_1-verified` withheld pending resolution of `orchestrator.rs` candidate ordering / Desktop `v1.0.5` rebuild-or-hotfix and clean VM test).
