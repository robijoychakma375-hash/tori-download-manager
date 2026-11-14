# TORI Download Manager — Gate 27.7: Firefox v1.0.7 Signed XPI Integration & Final Release Acceptance Report

**Date:** 2026-11-14  
**Project Root:** `F:/TORI/final tori download manager`  
**Git Branch:** `fix/gate27-runtime-fixes`  
**Base Checkpoint:** `checkpoint-gate27_6-verified` (`a4db34f`)  
**Desktop Release Candidate:** `v1.0.5-rc`  
**Browser Companion Release Candidate:** `v1.0.7-rc` (Chrome, Edge, Firefox)  
**Overall Release Readiness Verdict:** **GO — STAGED RELEASE CANDIDATES ACCEPTED (NOT YET PUBLISHED)**

---

## 1. Executive Verdict

All **Gate 27.7** verification suites completed with **zero failures, zero timeouts, and zero skipped checks**:

| Verification Suite | Scope | Result |
|---|---|---|
| `cargo test --workspace --lib` | `tdm-core` (47) + `tdm-native-host` (10) unit tests | **57/57 PASS** |
| `cargo test -p tdm-core --test gate27_5_large_mkv_capture_tests --test gate26_1_large_file_and_handoff_tests` | 64-bit offsets, sparse gaps, MKV probe, CD/Unicode/Redirect handling | **13/13 PASS** (4 + 9) |
| `node scripts/verify_gate27_7_firefox_signed_v107.js` | Signed Firefox `v1.0.7` XPI crypto, permanent install, restart, E2E MKV/MP4/CD/Audio->Video/Playlist | **16/16 PASS** |
| `node scripts/verify_gate27_7_release_acceptance.js` | Desktop `v1.0.5-rc` NSIS/Tray/SSE/Playlist/Audio->Video + Chrome 157 `v1.0.7` + Edge `v1.0.7` + Resilience | **18/18 PASS** |
| `node scripts/verify_overlay_drag_fix.js` | Floating overlay click/drag/clamping/Shadow DOM across Edge, Chrome, Firefox | **39/39 PASS** (13 per browser) |

**Total Automated Checks Executed & Passed in Final State:** **143 / 143 PASS** (`0 FAIL`, `0 TIMEOUT`, `0 NOT TESTED`).

Desktop `v1.0.5-rc` binaries/installer/updater `.sig`, Chromium `v1.0.7` ZIP, unsigned Firefox `v1.0.7` ZIP, and previously signed Firefox `v1.0.6` XPIs remain bit-for-bit preserved. Production user database, native messaging registration, and Downloads directory remain clean and unpolluted.

---

## 2. Firefox `v1.0.7` Signed XPI Verification

The Mozilla-signed Firefox add-on supplied as `a70ed17e183648a9bcf4-1.0.7.xpi` ([media_1794657359083_2c5d761e.xpi](file:///C:/Users/ritud/.gemini/antigravity/brain/4cb6b42b-ac51-4843-b5b6-6960f8030e35/.user_uploaded/media_1794657359083_2c5d761e.xpi)) was verified prior to staging and again after integration into [release/v1.0.7-extension-rc/](file:///F:/TORI/final%20tori%20download%20manager/release/v1.0.7-extension-rc):

- **Exact Size:** `90,326` bytes
- **SHA-256 Checksum:** `b082c8f2f4c8b4ed035fab77d9569622737defb3e02279f20073d3404dda4fa0` (exact match to expected)
- **Archive Structure (`FF-XPI-02`):** `39` ZIP entries, `0` Windows backslashes (`/` POSIX separators only), CRC32 verified across all entries
- **Manifest (`FF-XPI-03`):** `manifest_version: 3`, `version: "1.0.7"`, `browser_specific_settings.gecko.id: "tori-download-manager@toridm.org"`, `strict_min_version: "142.0"`, `data_collection_permissions.required: ["none"]`
- **Mozilla AMO Signature Chain (`FF-XPI-04`):**
  - `META-INF/cose.manifest` (`5,574` B), `META-INF/cose.sig` (`3,110` B), `META-INF/manifest.mf` (`5,895` B), `META-INF/mozilla.sf` (`144` B), `META-INF/mozilla.rsa` (`4,377` B)
  - PKCS#7 verified (`cmsVerify=true, sfMatch=true, digestTree=true, amoChain=true`)
  - Certificate Serial: `1794656778355293076` (`0x18e7e6d4d79d3b94`), `sha384WithRSAEncryption`, RSA-4096, `Extended Key Usage: Code Signing`
  - Issuer: `C=US, O=Mozilla Corporation, OU=Mozilla AMO Production Signing Service, CN=signingca1.addons.mozilla.org`
  - Subject: `CN=tori-download-manager@toridm.org`
  - Validity: `Nov 14 11:46:18 2026 GMT` to `Nov 11 11:46:18 2036 GMT`
- **Source Parity (`FF-XPI-05`):** All `34/34` non-`META-INF/` files match the Gate 27.6 Firefox RC (`33` bit-for-bit identical + semantic `manifest.json` match).
- **Firefox Signature-Enforced Permanent Install & Restart Persistence (`FF-INST-01..03`, `FF-API-01`):**
  - Installed permanently (`temporary: false`) with `xpinstall.signatures.required=true`
  - Active at `version: "1.0.7"`, survived full Firefox restart (`FF-INST-03`), paired & authenticated with `tdm-native-host.exe` (`status: "ok", authenticated: true, version: "2.0.0", port: 19894`).

---

## 3. Real End-to-End MKV & Media Pipeline Test Results

All real browser transfers used isolated `TORI_DATA_DIR`, isolated `USERPROFILE` / download folders, loopback fixture HTTP servers, full disk SHA-256 verification against source byte buffers, and native browser duplicate absence assertions:

| Check ID | Browser | Case / Scenario | Destination Folder / File | Bytes Verified | Native Browser State | Disk SHA-256 & Zero Dup |
|---|---|---|---|---:|---|---|
| `FF-E2E-01` | Firefox | Standard `.mkv` (`Firefox_Pipeline_Test.mkv`) | `Video/Firefox_Pipeline_Test.mkv` | `6,291,456` | `interrupted` | Match, zero dup |
| `FF-E2E-02` | Firefox | Normal `.mp4` (`Normal_Sample.mp4`) | `Video/Normal_Sample.mp4` | `4,194,304` | `interrupted` | Match, zero dup |
| `FF-INST` obs. | Firefox | `Content-Disposition` on `/disposition_blob` (`application/octet-stream`) | `Disposition_Firefox_Test.mkv` *(see Note 6.1)* | `6,291,456` | `interrupted` (`USER_CANCELED`) | Completed (`total_bytes=6291456`) |
| `CHR-MKV-2_9G` | Chrome 157 | Synthetic 2.9 GB MKV header probe (`/synthetic_large_2_9gb.mkv`) | Cancelled cleanly after planning *(see Note 6.2)* | `1,638,401` synthetic HTTP bytes served (`total_bytes=3,113,851,289`, `16` chunks) | Cancelled | Planning + 64-bit bounds verified |
| `CHR-MKV-01 (1)` | Chrome 157 | Standard 24 MiB `.mkv` (`standard_24m.mkv`) | `Video/standard_24m.mkv` | `25,165,824` | `interrupted` | Match, zero dup |
| `CHR-MKV-01 (2)` | Chrome 157 | `Content-Disposition` on `/cd_blob` (`Cosmic_Odyssey_1080p_BluRay.mkv`) | `Other/Cosmic_Odyssey_1080p_BluRay.mkv` *(see Note 6.1)* | `12,582,912` | `interrupted` | Match, zero dup |
| `CHR-MKV-01 (3)` | Chrome 157 | UTF-8 / CJK / spaces filename (`Test Film 大型 映画 (2026).mkv`) | `Video/Test Film 大型 映画 (2026).mkv` | `4,194,304` | `interrupted` | Match, zero dup |
| `CHR-MKV-01 (4)` | Chrome 157 | 302 redirect -> AWS S3 signed query params (`Signed_Transfer_2026.mkv`) | `Video/Signed_Transfer_2026.mkv` | `8,388,608` | `interrupted` | Match, zero dup |
| `CHR-MKV-01 (5)` | Chrome 157 | Normal 6 MiB `.mp4` (`Normal_Film_6m.mp4`) | `Video/Normal_Film_6m.mp4` | `6,291,456` | `interrupted` | Match, zero dup |
| `CHR-RESIL-01` | Chrome 157 | Offline browser fallback (`offline_recovery_2m.mkv`) -> host restart -> auto-recovery (`post_recovery_2m.mkv`) | Browser fallback (`2,097,152` B) + `Video/post_recovery_2m.mkv` (`2,097,152` B) | `2,097,152` | `interrupted` on recover | Match, zero dup (`storedPort=19898`, `hostJob=completed`) |
| `EDGE-MKV-01` | Edge | Standard 10 MiB `.mkv` (`Edge_Standard_10m.mkv`) | `Video/Edge_Standard_10m.mkv` | `10,485,760` | `interrupted` | Match, zero dup |
| `DESK-SSE-02` | Desktop API | 16 MiB `.mkv` pause/resume + SHA-256 (`pause_resume_16m.mkv`) | `Video/pause_resume_16m.mkv` | `16,777,216` (`2f21fb2d...23eb87`) | N/A | Match, `.tdm-part` removed |

---

## 4. Browser Compatibility Matrix (Companion `v1.0.7`)

| Browser | Packaging / Loading Method | Version & API Pairing | MKV / MP4 Capture | Playlist & Mix Rejection | Audio -> Video Sequential | Overlay Drag Suite | Overall |
|---|---|---|---|---|---|---|---|
| **Google Chrome 157** | Unpacked `extension/` (`v1.0.7`) via Interactive Dev Mode + UIA Load Unpacked (`jfnfgmcbgapcpieaonbaolgebjaejcdm`) | `v1.0.7`, `mode=http`, port `19898`, auth OK | **PASS** (5/5 E2E + 2.9 GB probe + Offline/Recover) | **PASS** (`OPEN_PLAYLIST` ok; `RD` Mix error) | **PASS** (distinct jobs) | **13/13 PASS** | **PASS** |
| **Microsoft Edge** | Unpacked `extension/` (`v1.0.7`) via `--load-extension` (`jfnfgmcbgapcpieaonbaolgebjaejcdm`) | `v1.0.7`, authenticated OK | **PASS** (10 MiB MKV SHA-256 verified) | Shared Chromium `background.js` with Chrome | Shared Chromium `background.js` | **13/13 PASS** | **PASS** |
| **Mozilla Firefox** | Permanent Mozilla AMO signed XPI (`a70ed17e183648a9bcf4-1.0.7.xpi`, `xpinstall.signatures.required=true`, ID `tori-download-manager@toridm.org`) | `v1.0.7`, survives restart, `port=19894`, auth OK | **PASS** (MKV + MP4 + Content-Disposition intercepted) | **PASS** (`OPEN_PLAYLIST` ok; shared `background.js`) | **PASS** (`17852953...` & `814855d7...`) | **13/13 PASS** | **PASS** |

*Note:* [extension/background.js](file:///F:/TORI/final%20tori%20download%20manager/extension/background.js) and [extension/firefox/background.js](file:///F:/TORI/final%20tori%20download%20manager/extension/firefox/background.js) are byte-for-bit identical (`74,502` bytes, SHA-256 `ac8232e50a55a133822cebd7bab0762d06b3987b94583d91b2de90efab4f11ff`).

---

## 5. Desktop `v1.0.5-rc` Regression Results (`verify_gate27_7_release_acceptance.js` Part A)

- **`DESK-INST-01` (PASS):** Silent NSIS install (`TORI Download Manager_1.0.5_x64-setup.exe /S /D=...`) installed cleanly into an isolated target directory (`tori-download-manager.exe` verified).
- **`DESK-BOOT-01` (PASS):** Desktop booted with WebView2 CDP and HTTP API on isolated port `19896` with `TORI_DATA_DIR` & unique `TORI_IPC_PIPE`.
- **`DESK-TRAY-01` / `DESK-TRAY-02` (PASS):** Close-to-tray `ON` hid main window while keeping process alive (`alive=true, httpOk=true`), and `tray/show_main_window` restored main window cleanly.
- **`DESK-TRAY-03` (PASS):** Toggling close-to-tray `OFF` persisted `closeToTray=false` in `engine_settings` across full restart and exited cleanly on window close without zombie listeners (`persistedFalse=true, exited=true`).
- **`DESK-SSE-01` / `DESK-SSE-02` (PASS):** Pausing mid-transfer preserved `.tdm-part` (`pausedAt=1196032`), kept final file absent until completion, emitted zero premature `completed` SSE events, then resumed to exact `16,777,216` B SHA-256 (`2f21fb2d75edc8280ed1ae0572acf2a92eb171616d3dd881f3a53a38c623eb87`), deleted `.tdm-part`, and emitted `verifying` (`index 13`) strictly before `completed` (`index 15`).
- **`DESK-PL-01` (PASS):** `/api/v1/media/playlist/resolve` returned HTTP `422` for YouTube Mix URL (`list=RDmVeAD3nbXGs`), while regular playlist `/open` returned `200`.
- **`DESK-AV-01` (PASS):** Sequential Audio-only (`format_id=250`) followed by Video (`format_id=248`) on the same URL produced distinct job UUIDs (`4179443b-36e2-43f5-8f3f-36cda13f1070` vs `0b092678-c01a-404a-9646-4355826e5b8e`).

---

## 6. Failure, Limitation & Recovery Log

### 6.1 Content-Disposition Without Extension Routes to `Other/` (Known Existing Behavior)
During both `CHR-MKV-01` (`/cd_blob` -> `Cosmic_Odyssey_1080p_BluRay.mkv`) and `verify_gate27_7_firefox_signed_v107.js` (`/disposition_blob` -> `Disposition_Firefox_Test.mkv`), extensions intercepted the download, resolved the final `.mkv` filename from `Content-Disposition`, cancelled the browser transfer cleanly, and TORI completed the exact SHA-256 file with zero browser duplicates. However, `resolve_destination_folder` in TORI's engine selected `Other/` rather than `Video/` because the initial URL passed at job creation (`/cd_blob`, `/disposition_blob`) carried no `.mkv` extension before HTTP `Content-Disposition` headers were probed. Documented transparently; URLs ending in `.mkv` (even behind query params or redirects like `Signed_Transfer_2026.mkv`) routed to `Video/` as expected.

### 6.2 Synthetic 2.9 GB Header Test Scope (Not a 2.9 GB Full Transfer)
`CHR-MKV-2_9G` served HTTP `Content-Length: 3113851289` (`2.900 GiB`) so Chrome + TORI's HTTP engine executed real 64-bit probing, planned `16` parallel chunks (`total_bytes=3113851289`), and transferred `1,638,401` synthetic HTTP probe bytes before test cancellation. It validates large-MKV interception, chunk planning, and cancellation without consuming 2.9 GB of disk I/O — it **does not** represent a completed 2.9 GB end-to-end transfer on disk. Large-file 64-bit allocation and `100 MiB` full SHA-256 pause/resume are additionally covered by Rust integration tests (`gate26_1_large_file_and_handoff_tests`).

### 6.3 `CHR-RESIL-01` Initial Failure & Environment Isolation Root-Cause Fix
An earlier run of [verify_gate27_7_release_acceptance.js](file:///F:/TORI/final%20tori%20download%20manager/scripts/verify_gate27_7_release_acceptance.js) passed `17/18` and failed `CHR-RESIL-01` (`recoveredMkvOnDisk=false, hostJob=undefined`) while leaking a test row into production SQLite (`tdm_storage.sqlite`) and `C:/Users/ritud/Downloads/Video/post_recovery_2m.mkv`. Root causes identified and fixed in the test harness:
1. Part A's isolated Desktop instance automatically invoked `tdm-native-host --register` (which reads `%APPDATA%`), temporarily pointing Windows HKCU Native Messaging to `desktop_install`.
2. During Chrome `Load Unpacked` (`autoPairWithDesktop`) and `dl-offline`, Chrome invoked Windows Native Messaging without `TORI_DATA_DIR` or `TORI_DISABLE_AUTO_SPAWN=1`, spawning an unintended Desktop server on port `6800`.
3. `extension/background.js` discovered port `6800` during offline fallback sweep and mutated in-memory `extSettings.port = 6800` without updating `chrome.storage.local`, causing subsequent `chrome.storage.local.set({ tori_settings: { port: 19898, ... } })` (unchanged in storage) not to fire `onChanged`, so `dl-recover` hit port `6800` / native fallback.
4. Instantaneous loopback completion on unthrottled 2 MiB `post_recovery_2m.mkv` raced with asynchronous cancellation.

**Fixes Implemented (strictly in acceptance harness; production extension & Rust binaries unchanged):**
- Restored OEM `C:\Users\ritud\AppData\Local\TORI Download Manager\bin\tdm-native-host.exe --register` both immediately after Part A and inside `cleanupAll()` + uncaught exception handlers.
- Propagated `TORI_DATA_DIR`, `TORI_IPC_PIPE`, `TORI_ALLOW_LOOPBACK=1`, `TORI_DISABLE_AUTO_SPAWN=1`, `TORI_API_PORT`, and `TORI_AUTH_TOKEN` to both Chrome and Edge child processes.
- Scoped an in-memory `chrome.runtime.sendNativeMessage` offline mock strictly inside `CHR-RESIL-01`'s 2-second `dl-offline` window (restoring original `sendNativeMessage` prior to restarting `hostProc`), preventing `tdm-native-host --native` from writing `.tdm-part` into real `%USERPROFILE%/Downloads` while validating true browser offline fallback and unassisted recovery back to port `19898`.
- Added initial `64 KiB` + `250ms` trickle on non-Range fixture responses (excluding `/pause_resume_16m.mkv` and `/offline_recovery_2m.mkv`) to prevent sub-millisecond loopback races.
- Cleaned the earlier leaked test file & `127.0.0.1:19901` SQLite row, ran `PRAGMA wal_checkpoint(TRUNCATE)`, and verified post-run production DB contains `0` localhost rows (`tdm_storage.sqlite`, `1,331,200` bytes).

---

## 7. Final Release Candidate Staging Inventory

### 7.1 Browser Companion `v1.0.7-rc` ([release/v1.0.7-extension-rc/](file:///F:/TORI/final%20tori%20download%20manager/release/v1.0.7-extension-rc))

| Artifact | Size (Bytes) | SHA-256 (lowercase hex) | Status |
|---|---:|---|---|
| [tori-companion-v1.0.7-chromium.zip](file:///F:/TORI/final%20tori%20download%20manager/release/v1.0.7-extension-rc/tori-companion-v1.0.7-chromium.zip) | `75,407` | `db491f9811709020d69b70dfdf41d61100dd7603c71d97f0cc1f6167cda70940` | Preserved unchanged |
| [tori-companion-v1.0.7-firefox.zip](file:///F:/TORI/final%20tori%20download%20manager/release/v1.0.7-extension-rc/tori-companion-v1.0.7-firefox.zip) | `75,720` | `a68350aa4f453e9e2b6bcb38d879bb8ab429c2d4808766423d65ff24a4df3204` | Preserved unsigned source RC |
| [a70ed17e183648a9bcf4-1.0.7.xpi](file:///F:/TORI/final%20tori%20download%20manager/release/v1.0.7-extension-rc/a70ed17e183648a9bcf4-1.0.7.xpi) | `90,326` | `b082c8f2f4c8b4ed035fab77d9569622737defb3e02279f20073d3404dda4fa0` | **Newly Staged (AMO Signed)** |
| [tori-download-manager-firefox-v1.0.7.xpi](file:///F:/TORI/final%20tori%20download%20manager/release/v1.0.7-extension-rc/tori-download-manager-firefox-v1.0.7.xpi) | `90,326` | `b082c8f2f4c8b4ed035fab77d9569622737defb3e02279f20073d3404dda4fa0` | **Newly Staged (Canonical Alias)** |
| [SHA256SUMS.txt](file:///F:/TORI/final%20tori%20download%20manager/release/v1.0.7-extension-rc/SHA256SUMS.txt) | `405` | `63e026eb4103378c61dd1233f5247fcd6c1bdd98d5d4a040a4af175fc9fb5fbb` | Updated |
| [verification_metadata.json](file:///F:/TORI/final%20tori%20download%20manager/release/v1.0.7-extension-rc/verification_metadata.json) | `1,578` | `ef312fdca1e9f2a66be657e69e5797d88e38656e88a06ab6ba41cfe96689faf6` | Updated |

### 7.2 Preserved Desktop `v1.0.5-rc` & Prior `v1.0.6` Assets ([release/v1.0.5-rc/](file:///F:/TORI/final%20tori%20download%20manager/release/v1.0.5-rc))

| Artifact | Size (Bytes) | SHA-256 (lowercase hex) | Status |
|---|---:|---|---|
| [TORI Download Manager_1.0.5_x64-setup.exe](file:///F:/TORI/final%20tori%20download%20manager/release/v1.0.5-rc/TORI%20Download%20Manager_1.0.5_x64-setup.exe) | `117,568,384` | `609d74ad8999893de70e835efb28ec6c45a38550c1114ef3e51a8a98164b8256` | Unchanged |
| [TORI Download Manager_1.0.5_x64-setup.exe.sig](file:///F:/TORI/final%20tori%20download%20manager/release/v1.0.5-rc/TORI%20Download%20Manager_1.0.5_x64-setup.exe.sig) | `436` | `9a1a9a38e6beba4b2dd194572e80d4f8c3a94988d38cf86c04d523e9077caab2` | Unchanged |
| [tori-download-manager.exe](file:///F:/TORI/final%20tori%20download%20manager/release/v1.0.5-rc/tori-download-manager.exe) | `30,191,616` | `783cdeb48dc95f1cac1ae1a06a6c3402441a8dce025a0f4bd8f16e6274885b16` | Unchanged |
| [tdm-native-host.exe](file:///F:/TORI/final%20tori%20download%20manager/release/v1.0.5-rc/tdm-native-host.exe) | `19,066,880` | `7b6f7bc4b1fe1992c0b2f2c34877b87801d8dfb85a1f6e260cb4862fe96f1fa1` | Unchanged |
| [tdm-cli.exe](file:///F:/TORI/final%20tori%20download%20manager/release/v1.0.5-rc/tdm-cli.exe) | `16,958,976` | `79cf8b6f373915bd12e79e8dc58b898000df02edc84f4f9e111074b8449f7369` | Unchanged |
| [a70ed17e183648a9bcf4-1.0.6.xpi](file:///F:/TORI/final%20tori%20download%20manager/release/v1.0.5-rc/extensions/a70ed17e183648a9bcf4-1.0.6.xpi) | `88,878` | `96a63c6be3eaf8488fbbd299ed2f07c8ef1e20b09128b8d0841a463026236038` | Preserved unchanged |
| [tori-download-manager-firefox-v1.0.6.xpi](file:///F:/TORI/final%20tori%20download%20manager/release/v1.0.5-rc/extensions/tori-download-manager-firefox-v1.0.6.xpi) | `88,878` | `96a63c6be3eaf8488fbbd299ed2f07c8ef1e20b09128b8d0841a463026236038` | Preserved unchanged |
| [tori-companion-v1.0.6-chromium.zip](file:///F:/TORI/final%20tori%20download%20manager/release/v1.0.5-rc/extensions/tori-companion-v1.0.6-chromium.zip) | `76,103` | `bc5bc14152ed2570245e2d99b307b3d85011a0e3aff4eb37c497389e26669d4e` | Preserved unchanged |
| [tori-companion-v1.0.6-firefox.zip](file:///F:/TORI/final%20tori%20download%20manager/release/v1.0.5-rc/extensions/tori-companion-v1.0.6-firefox.zip) | `75,720` | `ca99836cba7f9173fa6adbfe4c9108e546211f73e3b72bcdd2e9620656b07075` | Preserved unchanged |

---

## 8. Remaining Non-Publication Boundary Confirmation

All Gate 27.7 publication guardrails remain strictly honored:
- No GitHub release created or edited
- No Git commits or tags pushed to remote origins (`git diff --name-only` shows zero tracked production source modifications)
- `latest.json` updater feeds and website download links untouched
- Desktop `v1.0.5-rc` binaries/installer were not rebuilt or modified
- Chrome Web Store / Edge Add-ons store submissions and GitHub public release promotion remain held for explicit operator execution

---

## 9. Exact File & Artifact Paths

- **Repository Acceptance Report:** [GATE27_7_RELEASE_ACCEPTANCE_REPORT.md](file:///F:/TORI/final%20tori%20download%20manager/docs/reports/GATE27_7_RELEASE_ACCEPTANCE_REPORT.md)
- **Brain Artifact Report:** [GATE27_7_RELEASE_ACCEPTANCE_REPORT.md](file:///C:/Users/ritud/.gemini/antigravity/brain/4cb6b42b-ac51-4843-b5b6-6960f8030e35/GATE27_7_RELEASE_ACCEPTANCE_REPORT.md)
- **Firefox Signed XPI Suite:** [verify_gate27_7_firefox_signed_v107.js](file:///F:/TORI/final%20tori%20download%20manager/scripts/verify_gate27_7_firefox_signed_v107.js) (`16/16 PASS` JSON: [gate27_7_firefox_acceptance_results.json](file:///F:/TORI/final%20tori%20download%20manager/target/gate27_7_firefox_acceptance_results.json))
- **Full Release Acceptance Suite:** [verify_gate27_7_release_acceptance.js](file:///F:/TORI/final%20tori%20download%20manager/scripts/verify_gate27_7_release_acceptance.js) (`18/18 PASS` JSON: [gate27_7_full_acceptance_results.json](file:///F:/TORI/final%20tori%20download%20manager/target/gate27_7_full_acceptance_results.json))
- **Overlay Drag Suite:** [verify_overlay_drag_fix.js](file:///F:/TORI/final%20tori%20download%20manager/scripts/verify_overlay_drag_fix.js) (`39/39 PASS`)
- **Staged Extension RC Directory:** [release/v1.0.7-extension-rc/](file:///F:/TORI/final%20tori%20download%20manager/release/v1.0.7-extension-rc)
- **Staged Desktop RC Directory:** [release/v1.0.5-rc/](file:///F:/TORI/final%20tori%20download%20manager/release/v1.0.5-rc)
