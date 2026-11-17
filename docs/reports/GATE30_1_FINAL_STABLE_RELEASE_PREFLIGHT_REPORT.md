# TORI Download Manager — Gate 30.1 Final Stable Release Preflight & Go/No-Go Acceptance Report

- **Date:** 2026-11-18
- **Target Releases:**
  - **Desktop:** TORI Download Manager `v1.0.5` (Windows x64 NSIS)
  - **Browser Companion:** `v1.0.9` (Chrome `157.0.8103.79`, Microsoft Edge `157.0.4341.60`, Mozilla Firefox `160.0` signed XPI)
- **Final Classification:** **`CONDITIONAL GO — DOCUMENTED LIMITATIONS`**
- **Publication Status:** **NOT PERFORMED** (read-only public checks only; no pushes, no GitHub Release changes, no live `latest.json` changes, no Cloudflare Pages deploy)

---

## 1. Executive Summary

Gate 30.1 audited the complete TORI Download Manager `v1.0.5` Desktop release candidate and `v1.0.9` Browser Companion release candidate across source parity, Rust workspace unit/integration tests (`250/250`), intermittent YouTube Playlist timeout diagnosis, binary/packager inspection, Tauri updater cryptography, Mozilla-signed Firefox XPI runtime verification, Chrome/Edge/Firefox E2E integration, performance benchmarks, security & local-API hardening, OEM SQLite/registry preservation, GitHub/website dry-run staging, and rollback readiness.

After fixing a test-harness YouTube SPA reload synchronization race in `scripts/verify_gate29_4_final_integration.js` (`L1472-1510`) with **zero modifications to production Rust/UI/extension source code or frozen binaries**, **every single automated test, linter, build, live browser E2E suite (3 consecutive Final Integration runs + 5 consecutive Playlist E2E runs), and updater preflight check passed 100%**.

The release is classified **`CONDITIONAL GO — DOCUMENTED LIMITATIONS`** rather than unconditional `GO` solely because of two known, explicitly documented environment/release-engineering limitations (neither caused by a functional or code defect):
1. **Windows Authenticode PE code-signing is `NotSigned` / `UNSIGNED`** (Windows SmartScreen / UAC "Unknown publisher" warning applies; Tauri Ed25519 updater cryptographic signing is present and valid).
2. **Clean Windows VM installation/upgrade/uninstall validation is `NOT TESTED`** (`0` virtual machines configured on the host; substituted via isolated host x64 test profiles and directories without altering the operator's production OEM installation).

---

## 2. Git Branch and Commit

| Item | Value |
|---|---|
| Repository Root | `F:\TORI\final tori download manager` |
| Active Branch | `fix/gate27-runtime-fixes` |
| Audited Baseline Commit (`HEAD` at start) | `7e0f928e9ac1a99b7b6c350e5aaca73ddc6cc898` |
| Baseline Verified Tag | `checkpoint-gate29_5_2-verified` -> `7e0f928e9ac1a99b7b6c350e5aaca73ddc6cc898` |
| Pre-Audit Safety Tag | `checkpoint-gate30_1-before-release-audit` -> `7e0f928e9ac1a99b7b6c350e5aaca73ddc6cc898` |
| Gate 30.1 Permitted Local Changes | `scripts/verify_gate29_4_final_integration.js` (`+56/-18` test sync fix), `docs/reports/screenshots/` (14 regenerated E2E screenshots), `docs/reports/GATE30_1_FINAL_STABLE_RELEASE_PREFLIGHT_REPORT.md` |
| Production Source / Frozen Binary Edits in Gate 30.1 | **None (`0` changes)** to `crates/`, `src-tauri/`, `ui/`, `extension/`, or `release/` |
| Gate 30.1 Verified Local Tag | `checkpoint-gate30_1-preflight-verified` (local only; not pushed) |

---

## 3. Verified Baseline

Before executing Gate 30.1 tests:
- Confirmed clean working tree on branch `fix/gate27-runtime-fixes` at `7e0f928e9ac1a99b7b6c350e5aaca73ddc6cc898`.
- Confirmed `checkpoint-gate29_5_2-verified` resolves to `7e0f928e9ac1a99b7b6c350e5aaca73ddc6cc898`.
- Created local safety tag `checkpoint-gate30_1-before-release-audit` and preserved all prior checkpoints.
- Reviewed all seven predecessor reports: `GATE27_8_FINAL_MKV_ACCEPTANCE_REPORT.md`, `GATE29_1_IDM_DESKTOP_UI_MIGRATION_REPORT.md`, `GATE29_2_IDM_PROGRESS_WINDOW_MIGRATION_REPORT.md`, `GATE29_3_IDM_EXTENSION_UI_MIGRATION_REPORT.md`, `GATE29_4_FINAL_INTEGRATION_RELEASE_READINESS_REPORT.md`, `GATE29_5_FINAL_SIGNING_AND_RC_FREEZE_REPORT.md`, and `GATE29_5_2_YOUTUBE_RESOLVER_TIMEOUT_FIX_REPORT.md`.
- Verified **3-way byte-for-byte parity (`match3=True`)** across `release/v1.0.5-gate29_5_2-rc/`, `release/v1.0.5-rc/`, and `release/v1.0.5-v1.0.9-final-rc/Desktop/`.

---

## 4. Rust Test Count Reconciliation

### Discrepancy Under Investigation
- **Gate 29.5** reported **`240 passed, 0 failed`**.
- **Gate 29.5.2** reported **`238 passed, 0 failed`** despite adding **`10`** new resolver tests in `crates/tdm-core/tests/gate29_5_2_resolver_priority_tests.rs`.

### Reproducible Inventory Findings
Using `cargo test --workspace -- --list`, Git history inspection (`git ls-tree` / `git diff`), and `cargo test --workspace --no-fail-fast`:

| Checkpoint | Actual Test Count Discovered | Explanation |
|---|---|---|
| Gate 29.4 | `239` | Full workspace unit + integration + doc tests |
| Gate 29.5 | `240` | Added `1` test (`test_v105_release_candidate_signature_cryptographic_verification`) in `updater_cryptography_tests.rs` |
| Gate 29.5.2 & Gate 30.1 | **`250`** | Added `10` tests in `crates/tdm-core/tests/gate29_5_2_resolver_priority_tests.rs` (`240 + 10 = 250`) |

- **Tests removed:** `0`
- **Tests renamed:** `0`
- **Tests replaced:** `0`
- **Cargo `#[ignore]`d tests:** `0`
- **Excluded workspace targets:** `0`
- **Actual root cause of `"238"` string in Gate 29.5.2 report:** Strictly a manual arithmetic addition error while summing the **33 non-empty test targets** (`38` total `test result:` summary lines including empty binary unit-test stubs and `2` doc-tests) in the Gate 29.5.2 markdown report. Cargo compiled, discovered, and executed all **`250`** tests.
- **Note on internal `[SKIP]` guards:** Within `updater_cryptography_tests.rs`, `4` legacy `1.0.0` artifact checks intentionally return early with an internal `[SKIP]` message when the legacy `1.0.0` setup binary is not present on disk (while `test_v105_release_candidate_signature_cryptographic_verification` executes against the active `1.0.5` RC artifact).
- **Note on live-network variance observed on first Gate 30.1 run:** During the first concurrent `cargo test --workspace --no-fail-fast`, `249 passed, 1 failed` occurred solely in `speed_audit_tests::test_audit_managed_media_vs_ytdlp_baseline` (`+46.8%` delta: `Direct yt-dlp 7.62s` vs `TORI Managed 11.18s` on a `7.98 MB` fetch due to transient YouTube CDN throughput contention under concurrent test execution). Isolated `speed_audit_tests` passed `3/3` (`7.07s` vs `7.29s`, `+3.1%` overhead), and full `cargo test --workspace --no-fail-fast` passed **`250 passed, 0 failed, 0 ignored`** across all 38 summary lines.

---

## 5. Intermittent Playlist Investigation (`ff-playlist-modal` Timeout)

### Reproduction
- **5 consecutive standalone Playlist E2E runs (`node scripts/verify_gate27_8_playlist_e2e.js`):**
  - Run 1: `12/12 PASS` (`65.46s`)
  - Run 2: `12/12 PASS` (`66.89s`)
  - Run 3: `12/12 PASS` (`62.08s`)
  - Run 4: `12/12 PASS` (`62.46s`)
  - Run 5: `12/12 PASS` (`66.11s`)
  - **Total: 5/5 PASS (`60/60`)**
- **3 consecutive unmodified Final Integration runs (`node scripts/verify_gate29_4_final_integration.js`):**
  - Run 1: `17/17 PASS` (`152.35s`)
  - Run 2: `17/17 PASS` (`152.95s`)
  - Run 3: **Reproduced** `waitForContext(ff-playlist-modal) timed out` (`166.64s`)

### Exact Root Cause
Instrumented WebDriver/Tauri diagnostics captured the exact race red-handed:
1. `verify_gate29_4_final_integration.js:1473` previously navigated via `window.location.href = WATCH_PLAYLIST_URL`, polled every `500ms` until `hasOpenBtn: true` (`diagIters: 5`, `diagAfterReadyMs: 3880`, on `&list=PL6B3937A5D230E335&index=3`), and then sent a separate `WebDriver:ExecuteScript` call `document.querySelector('.tori-mp [data-act="open-playlist"]')?.click()`.
2. In the ~`20ms` window between the poll succeeding and the separate click call arriving, YouTube performed its SPA client-side reload to `&index=2&themeRefresh=1`, tearing down and replacing the watch-page DOM (`clickSnap: null`, Firefox extension toast `null`, Desktop `mSnap.hasModal: false`).
3. Because the harness used optional chaining (`?.click()`), the missed click failed silently and `waitForContext(..., 'ff-playlist-modal')` idled for `35s` until timing out.

### Root Cause Classification
- **Category B (Test Synchronization Issue) + Category C (Browser / YouTube SPA Reload Timing Variation)**.
- **Zero application defect:** Once triggered deterministically, `#playlist-modal` mounted in **`3–17 ms`** and playlist entries resolved in **`3,037–4,226 ms`**.

### Fix & Verification
Fixed strictly in the test script `scripts/verify_gate29_4_final_integration.js` (`L1472-1510`):
1. Navigate explicitly via `mar.send('WebDriver:Navigate', { url: WATCH_PLAYLIST_URL }, 30000)`.
2. Wait until `document.readyState === 'complete' && snap.hasOpenBtn` with `location.href` stable across consecutive checks for `>= 900ms`.
3. Perform the `.click()` atomically in the same stability-verified script evaluation and fail loudly if `{ clicked: true }` is false (removing silent `?.click()`).
4. Aligned `waitForContext(..., 'ff-playlist-modal')` timeout to `45000ms` (matching `verify_gate29_5_1`).

**Post-fix Final Integration validation (`3/3` consecutive runs PASSED, `17/17` each = `51/51`):**
- Run 1: `17/17 PASS` (`162.69s`)
- Run 2: `17/17 PASS` (`152.63s`)
- Run 3: `17/17 PASS` (`154.13s`)

Confirmed end-to-end across runs: playlist detection, modal open, item resolution & loading, item selection, handoff via Native Messaging / HTTP fallback, Desktop cold launch, system-tray restore, real video/audio merge completion, valid `.mp4`/`.mkv` output verified with `ffprobe`, and zero duplicate download jobs.

---

## 6. Desktop Release Artifact Audit

Audited `release/v1.0.5-v1.0.9-final-rc/`:
- **Target Version / Arch:** `1.0.5` / Windows x64 (`ProductVersion=1.0.5`, `FileVersion=1.0.5` on `TORI Download Manager_1.0.5_x64-setup.exe` and `tori-download-manager.exe`).
- **NSIS Installer:** `TORI Download Manager_1.0.5_x64-setup.exe` (`117,783,770` B) matches `release/v1.0.5-gate29_5_2-rc/` and `release/v1.0.5-rc/` byte-for-byte.
- **Bundled Sidecars Verified Present & Hash-Checked:**
  - `ffmpeg.exe` (`N-126374-g089a48eb36-20260831`, `145,858,048` B)
  - `ffprobe.exe` (`N-126374-g089a48eb36-20260831`, `145,645,568` B)
  - `yt-dlp.exe` (`2026.08.19 on Python 3.10.11`, `17,840,399` B)
- **Gate 29.5.2 Fix Binary Verification:** Inspected binary strings in both `tori-download-manager.exe` and `tdm-native-host.exe`; confirmed compiled Gate 29.5.2 resolver markers (`Media resolution completed via platform pipeline`, `platform_overall_deadline`, and `Evicting incomplete/incompatible entry`) are present in both executables.
- **Licenses & Metadata Verified:** `LICENSE`, `LICENSE-APACHE`, `LICENSE-MIT`, `LICENSE-GPLv3.txt`, `LICENSE-THIRD-PARTY.txt`, `SHA256SUMS.txt` (all 16 entries verified against disk hashes), `RELEASE_NOTES_v1.0.5_v1.0.9.md`, and `latest.v1.0.5.draft.json`.
- **Stale Binaries / Debug Artifacts:** Zero found.

---

## 7. Firefox Signed XPI Verification

- **Artifact:** `release/v1.0.5-v1.0.9-final-rc/Extensions/a70ed17e183648a9bcf4-1.0.9.xpi` (`101,231` B)
- **SHA-256:** `d4e8d6e585ba6dfaf841eb6b37f2ee27beae1cec55badbbe0dd12960ad5943ec` (verified unchanged)
- **Previous Preserved Signed XPI (`v1.0.7`):** `release/v1.0.7-extension-rc/a70ed17e183648a9bcf4-1.0.7.xpi` (`90,326` B, SHA-256 `b082c8f2f4c8b4ed035fab77d9569622737defb3e02279f20073d3404dda4fa0`, unchanged)
- **Manifest & Signature Verification:**
  - Browser Tested: **`Mozilla Firefox 160.0`** (isolated QA profile)
  - Policy: `xpinstall.signatures.required = true`
  - Verification State: `SIGNEDSTATE_SIGNED = 2` (Mozilla `META-INF` PKCS7/signature files intact)
  - Manifest Version: `1.0.9`, Gecko ID: `tori-download-manager@toridm.org`
- **Functional E2E Verification (`verify_gate29_5_1_firefox_signed_v1_0_9.js` — `10 PASS, 0 FAIL, 0 TIMEOUT`, `42.23s`):**
  - Permanent extension install & activation under signature enforcement
  - Native Messaging & HTTP fallback handoff
  - Desktop live connection state, Popup, Options, and Video Overlay
  - HTML5 Format Picker & YouTube Format Picker (`FF109-YT-FMT-01` resolved in `11,575 ms`, `12` format rows — zero timeout recurrence)
  - Video & audio-only format selection + real 480p `.mkv` download verified via `profile_ff109_yt_resolve.js` (`11,803,755` B, `ffprobeOk=true`)
  - Playlist detection, handoff, actual completion & `ffprobe` validation
  - YouTube Mix/Radio rejection banner + HTTP `422`

---

## 8. Chrome and Edge Verification

- **Exact Browser Versions Tested:**
  - **Google Chrome:** `157.0.8103.79`
  - **Microsoft Edge:** `157.0.4341.60`
- **Verification Coverage (`verify_gate29_3_idm_extension_ui.js` — `23 PASS, 0 FAIL, 0 TIMEOUT` in `125.43s`; `verify_gate29_4_final_integration.js` — `3/3 x 17 PASS`):**
  - Browser Companion `v1.0.9` Chromium package (`tori-companion-v1.0.9-chromium.zip`, MV3 manifest `1.0.9`)
  - Unpacked extension installation, Native Messaging host connectivity, HTTP fallback, connected/disconnected state badge, reconnect
  - Capture toggle, floating video download overlay, Format Picker, YouTube quality selection, playlist detection
  - Direct MP4 and large MKV (`2.30 GiB`) interception, single Desktop job creation (no duplicates), real download completion, IDM dark/light theme & settings persistence across restarts

---

## 9. Complete Regression Matrix

Every required check executed against the final preflight codebase and frozen RC binaries (`NOT TESTED` and failures reported transparently):

| Suite / Check | Result | Pass / Fail / Timeout | Key Verified Details |
|---|---|---|---|
| `cargo test --workspace --no-fail-fast` | **PASS** | `250 PASS / 0 FAIL / 0 IGNORED` | All 33 non-empty test targets (38 summary lines; initial concurrent run hit 1 network-variance delta in `speed_audit_tests`, then `3/3` solo and `250/250` full rerun passed) |
| Updater Cryptography Tests (`updater_cryptography_tests`) | **PASS** | `6 PASS / 0 FAIL` | Verifies v1.0.5 Ed25519 sig, tamper rejection, `latest.v1.0.5.draft.json` parity (`4` legacy `1.0.0` tests return early `[SKIP]` when `1.0.0` binary is absent) |
| Gate 29.5.2 Resolver Priority Tests | **PASS** | `10 PASS / 0 FAIL` | Included inside `250` workspace tests |
| `npm --prefix ui run build` | **PASS** | `PASS` | 46 modules built cleanly in `278 ms`, `0` errors |
| `npm --prefix ui run lint` | **PASS** | `PASS` | `oxlint` `0` errors (`7` pre-existing React warnings) |
| Extension JS syntax check (`node --check`) | **PASS** | `8 PASS / 0 FAIL` | All 8 JS files valid |
| `npx web-ext lint` (Firefox `1.0.9` ZIP) | **PASS** | `PASS` | `0` errors, `0` notices (`7` pre-existing warnings) |
| Gate 27.8 Playlist E2E (`verify_gate27_8_playlist_e2e.js`) | **PASS** | `5/5` runs (`12/12` each = `60 PASS`) | `65.46s`, `66.89s`, `62.08s`, `62.46s`, `66.11s`; cold launch, tray restore, `ffprobe`, zero dupes |
| Gate 27.8 Large MKV (`verify_gate27_8_large_mkv_and_classification.js`) | **PASS** | `10 PASS / 0 FAIL / 0 TIMEOUT` | `50.63s`; `2,469,606,195` B (`2.30 GiB`) MKV paused at `81,788,928` B, resumed in `6.11s`, SHA-256 `a71c0f55c37c5fad01fb0abc08d783b662921b1afe9f95d18cf1f771d7efe746` |
| Gate 29.1 Desktop UI (`verify_gate29_1_idm_desktop_ui.js`) | **PASS** | `20 PASS / 0 FAIL` | `19.04s`; IDM layout, virtualized `1,200` rows, settings persistence, SQLite `target_path` |
| Gate 29.2 Progress Window (`verify_gate29_2_idm_progress_window.js`) | **PASS** | `17 PASS / 0 FAIL` | `38.21s`; independent progress window lifecycle, pause/resume, speed limit, completion |
| Gate 29.3 Extension UI (`verify_gate29_3_idm_extension_ui.js`) | **PASS** | `23 PASS / 0 FAIL / 0 TIMEOUT` | `125.43s`; Chrome `157`, Edge `157`, Firefox `160` popup/options/overlay/sync |
| Gate 29.4 Final Integration (`verify_gate29_4_final_integration.js`) | **PASS** | `3/3` runs (`17/17` each = `51 PASS`) | `162.69s`, `152.63s`, `154.13s` post-fix; retry, crash recovery, merge, tray, MKV, playlist, picker |
| Gate 29.5.1 Signed Firefox (`verify_gate29_5_1_firefox_signed_v1_0_9.js`) | **PASS** | `10 PASS / 0 FAIL / 0 TIMEOUT` | `42.23s`; signed `1.0.9` XPI under `xpinstall.signatures.required=true`, `FF109-YT-FMT-01` `11,575 ms` |
| Live Resolver Benchmark (`profile_ff109_yt_resolve.js`) | **PASS** | `PASS` | `61.01s`; real 480p `.mkv` `11,803,755` B downloaded, `ffprobeOk=true` |
| Mock Auto-Updater Preflight (`preflight_mock_updater.js`) | **PASS** | `PASS` | `1.0.4->1.0.5` upgrade, `1.0.5` noop, `1.0.6` rejected, Ed25519 sig & streamed SHA-256 match |
| Clean Windows VM Validation | **NOT TESTED** | `NOT TESTED` | Host Hyper-V `vmms` has `0` configured VMs; no VirtualBox/VMware/QEMU |

---

## 10. Performance Results

| Metric | Gate 30.1 Measured | Gate 29.5.2 Reference | Notes |
|---|---|---|---|
| Firefox Extension `RESOLVE_MEDIA` RPC | `19 ms` | — | Live Firefox `160.0` signed `v1.0.9` XPI |
| Firefox Full Format Picker UI Ready (`FF109-YT-FMT-01`) | `11,575 ms` (12 rows) | `10,947 ms` (pre-fix `37,908 ms`) | Preserves Gate 29.5.2 fix (~3.3x faster than pre-fix) |
| Backend Cold Resolution (WITH 8 candidates) | `4,712 ms` | `4,194 ms` | ~8x faster than Gate 29.5 pre-fix `37,908 ms` |
| Backend Cache Hit (WITH candidates) | `7 ms` | `5 ms` | Instant sub-10ms cache response |
| Backend Empty Cold / Empty Cache Hit | `4,399 ms` / `5 ms` | — | Consistent pipeline deadline behavior |
| Idle Desktop RAM & Process Count | `375.18 MB` WS / `197.61 MB` Private / `7` procs | — | From Gate 29.1 suite |
| Active Download RAM / CPU / DOM | `381.41 MB` WS / `1.938s` CPU / `4` mutations per `3.2s` | — | Low DOM churn |
| Virtualized `1,200`-row List RAM & DOM | `362.64 MB` WS / `22` top / `27` mid rows | — | Constant DOM node footprint |
| Progress Window Incremental Overhead | Base `369 MB` WS (`7` procs, `2.25s` CPU) -> `470.5 MB` WS (`+101.5 MB`, `8` procs, `3.359s` CPU) | — | Title throttled `3` updates / `3.1s` (`<= 1 Hz`) |

---

## 11. Security & Data Preservation Findings

- **Credentials / Private Keys / Tracked Secrets:** `0` `.key`, `.pwd`, `.pfx`, `.p12`, `.pem`, or `.sqlite` files in tracked Git paths. Private updater keys never accessed or printed.
- **Extension Archive & XPI Audit:** Deep scan of `tori-companion-v1.0.9-chromium.zip`, `tori-companion-v1.0.9-firefox.zip`, and signed `a70ed17e183648a9bcf4-1.0.9.xpi` returned `suspicious_files=[]` and `code_hits=[]`.
- **Debug Executables:** Zero debug-only executables in release archives.
- **Local HTTP / Native Messaging Server (`crates/tdm-native-host/src/server.rs`):**
  - Binds strictly to `127.0.0.1` (`is_valid_host` accepts `127.0.0.1` and `localhost`).
  - Validates `Origin`: allows extension IDs `jfnfgmcbgapcpieaonbaolgebjaejcdm` & `bflchfddfgkfglmjapohkjmldepflkbe` (`chrome-extension://` / `edge-extension://`), 36-char UUID `moz-extension://`, and exact Tauri origins; external websites receive `403`.
  - Requires per-install auth token (`X-Tori-Token` / `Bearer`).
- **URL, SSRF & Path Safety:**
  - `open_external_url` (`src-tauri/src/commands.rs`) enforces `http://`/`https://` via `rundll32 url.dll,FileProtocolHandler`.
  - `sanitize_filename` strips forbidden filesystem characters and Windows reserved device names (`CON`..`LPT9`).
- **NSIS Uninstall Data Safety (`src-tauri/nsis/hooks.nsh`):** Uninstall removes registry/Native Messaging manifests cleanly while preserving `%APPDATA%\tori-download-manager\tdm_storage.sqlite` and user downloaded files.
- **OEM Production Data Integrity Verified Unchanged:**
  - `%APPDATA%\tori-download-manager\tdm_storage.sqlite`: SHA-256 `64550dfaa93aaa2d8b700640c802cde0c09275aa8f804cbb0f74a18fe8521daa`, `downloads = 33`, `PRAGMA integrity_check = ok`, `has_token = True`.
  - HKCU Chrome/Edge/Mozilla `NativeMessagingHosts` registry entries intact.
  - Preserved signed XPIs (`v1.0.7` and `v1.0.9`) untouched.
- **Advisory Non-Blocking Finding:** `src-tauri/tauri.conf.json` has `app.security.csp: null` (default WebView2 bundled asset origin; recommend explicit CSP in a future hardening update).

---

## 12. Installer Signature Verification

It is critical to distinguish **Tauri Auto-Updater Signing** from **Windows Authenticode PE Signing**:

| Mechanism | Status | Evidence |
|---|---|---|
| **Tauri Updater Ed25519 Signature** | **VERIFIED / VALID** | `TORI Download Manager_1.0.5_x64-setup.exe.sig` (`436` B, SHA-256 `d43c0a98b5965cb8415be5062ced9abdbf10da58bf556751f0ff6eb92410e959`) passed `updater_cryptography_tests` (`6/6`), including payload tamper rejection, signature tamper rejection, and `trusted comment: timestamp:1794933070\tfile:TORI Download Manager_1.0.5_x64-setup.exe`. |
| **Windows Authenticode PE Signature** | **`NotSigned` / `UNSIGNED`** | Checked on `TORI Download Manager_1.0.5_x64-setup.exe`, `tori-download-manager.exe`, `tdm-native-host.exe`, and `tdm-cli.exe`. **No Microsoft / EV / OV Authenticode certificate is applied.** End users downloading the installer from the web will see a Windows SmartScreen / UAC "Unknown publisher" warning until Authenticode signing is added. |

---

## 13. Final Verified SHA-256 Checksums

All 16 entries in `release/v1.0.5-v1.0.9-final-rc/Metadata/SHA256SUMS.txt` match disk hashes 100%, plus preserved historical artifacts:

| Artifact | Size (Bytes) | SHA-256 |
|---|---|---|
| `Desktop/TORI Download Manager_1.0.5_x64-setup.exe` | `117,783,770` | `cab4156fc85a42ce74d5d4292e2976223ba14ad4c8e7d5bbfea533e4ca72f3cb` |
| `Desktop/TORI Download Manager_1.0.5_x64-setup.exe.sig` | `436` | `d43c0a98b5965cb8415be5062ced9abdbf10da58bf556751f0ff6eb92410e959` |
| `Desktop/tori-download-manager.exe` | `30,723,072` | `629ebc63afe94a1240a4bc79802502c188bfbf6b8d0f24e0005e350f4a5f0f4a` |
| `Desktop/tdm-native-host.exe` | `19,385,856` | `0c660aaacb1f2adfc43d2d29188f13317e2cac81bae117644cbfd9743a500d71` |
| `Desktop/tdm-cli.exe` | `17,055,232` | `66673df965830fbded2d5e6e456a104ad7725fddfdbe62fec513a699e55e52e1` |
| `Desktop/ffmpeg.exe` | `145,858,048` | `b9989f24e63be74e72aa45fec10a114ce660b562e4303d5f296f4fc8ba7cc896` |
| `Desktop/ffprobe.exe` | `145,645,568` | `73842bee6f270e85b2ab6fc3cfa715f614f16ad16700f5de6a9c1a2865cacf00` |
| `Desktop/yt-dlp.exe` | `17,840,399` | `66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a` |
| `Extensions/a70ed17e183648a9bcf4-1.0.9.xpi` (Mozilla-signed) | `101,231` | `d4e8d6e585ba6dfaf841eb6b37f2ee27beae1cec55badbbe0dd12960ad5943ec` |
| `Extensions/tori-companion-v1.0.9-chromium.zip` | — | `dbc345b513795506c30c8300683d99fe1bd4b14d14c012663808bf7a406089ac` |
| `Extensions/tori-companion-v1.0.9-firefox.zip` (unsigned AMO source) | — | `b3846844094aa15ee1a7fef16022399550bafbba9d46c915d5beb2c2d02632d` |
| `Desktop/LICENSE` | — | `55460ef099ce57e32d422427a7a24cd1e09aec677606289e396c2c17d625a598` |
| `Desktop/LICENSE-APACHE` | — | `20fe7b00e904ed690e3b9fd6073784d3fc428141dbd10b81c01fd143d0797f58` |
| `Desktop/LICENSE-MIT` | — | `dffcef788fe594963f082966daa3b969c7c4f633e612d8f88ee8a3033c4a5144` |
| `Desktop/LICENSE-GPLv3.txt` | — | `8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903` |
| `Desktop/LICENSE-THIRD-PARTY.txt` | — | `4f05486cb940a151e9b010ff3d033b7fb06370c665d174eb5d54d48433eb6035` |
| **Preserved `v1.0.7` Signed XPI** (`release/v1.0.7-extension-rc/a70ed17e183648a9bcf4-1.0.7.xpi`) | `90,326` | `b082c8f2f4c8b4ed035fab77d9569622737defb3e02279f20073d3404dda4fa0` |
| **OEM SQLite DB** (`%APPDATA%\tori-download-manager\tdm_storage.sqlite`) | — | `64550dfaa93aaa2d8b700640c802cde0c09275aa8f804cbb0f74a18fe8521daa` |

---

## 14. Current Public GitHub Release (Read-Only Inventory)

- **Repository:** `robijoychakma375-hash/tori-download-manager`
- **Current Latest Stable Desktop Release:** `v1.0.4` (published `2026-11-12T19:21:11Z`)
- **Existing Public Tags:** `v1.0.4`, `v1.0.3`, `v1.0.2`, `v1.0.1`, `v1.0.0`, `extension-v1.0.5`, `extension-v1.0.4`
- **Installer Naming Convention:** GitHub converts spaces in `TORI Download Manager_1.0.4_x64-setup.exe` to dots in asset download URLs (`TORI.Download.Manager_1.0.4_x64-setup.exe`).
- **Live `latest.json`:** Currently serves `"version": "1.0.4"`.
- **Current Public Extension Release (`extension-v1.0.5`, `2026-11-12T06:21:58Z`):** Hosts `tori-download-manager-extension-v1.0.5.zip` and `tori-download-manager-firefox-v1.0.5.xpi`.
- **Status:** Completely untouched during Gate 30.1.

---

## 15. Proposed `v1.0.5` & Companion `v1.0.9` GitHub Release Assets

Recommended public release payload (unsigned Firefox source ZIP `tori-companion-v1.0.9-firefox.zip` is **excluded** as an end-user Firefox installer — only the Mozilla-signed XPI is recommended for users):

### Desktop (`v1.0.5`)
- `TORI Download Manager_1.0.5_x64-setup.exe` (GitHub URL asset: `TORI.Download.Manager_1.0.5_x64-setup.exe`)
- `TORI Download Manager_1.0.5_x64-setup.exe.sig`
- `tori-download-manager.exe`
- `tdm-native-host.exe`
- `tdm-cli.exe`

### Browser Companion (`v1.0.9`)
- `tori-companion-v1.0.9-chromium.zip` (Chrome & Edge)
- `a70ed17e183648a9bcf4-1.0.9.xpi` (or copy matching historical alias `tori-download-manager-firefox-v1.0.9.xpi`, **Mozilla-signed only**)

### Metadata
- `SHA256SUMS.txt`
- `RELEASE_NOTES_v1.0.5_v1.0.9.md`
- `RELEASE_MANIFEST.json`
- `latest.json` (promoted from verified `Metadata/latest.v1.0.5.draft.json`)

---

## 16. Draft Auto-Updater Metadata (`latest.v1.0.5.draft.json`)

Tested `release/v1.0.5-v1.0.9-final-rc/Metadata/latest.v1.0.5.draft.json` against an isolated local HTTP mock server (`preflight_mock_updater.js`):
- `upgradeFrom_1_0_4 = true` (offers `v1.0.5`)
- `noopAt_1_0_5 = true` (no update on `1.0.5`)
- `rejectHigher_1_0_6 = true` (rejects downgrade)
- `sigMatchWin64 = true`, `sigMatchNsis = true`
- Streamed all `117,783,770` bytes from mock `/installer.exe` -> `matchesDiskSha = true`
- Signature trusted comment: `trusted comment: timestamp:1794933070\tfile:TORI Download Manager_1.0.5_x64-setup.exe`
- Asset URL convention matches GitHub dot-normalized filename (`TORI.Download.Manager_1.0.5_x64-setup.exe`). **Not published.**

---

## 17. Website Update Plan (`toridownload.xyz`)

- **Local Repo:** `C:\Users\ritud\Downloads\tori-website` (commit `a569761`, clean Git status; untouched in Gate 30.1).
- **Live Site Status:** Serves `v1.0.4` Desktop and `extension-v1.0.5` (`/assets/tori-download-manager-firefox-v1.0.5.xpi` with `_headers` setting `Content-Type: application/x-xpinstall`).
- **Build Observation:** Cloudflare Pages build script runs `mkdir -p public && cp index.html robots.txt sitemap.xml _headers public/ && cp -R assets public/assets`. Gitignored local `public/index.html` currently lags at `v1.0.3` while root `index.html` is `v1.0.4`.
- **Gate 30.2 Website Changes Required:**
  1. Copy signed `a70ed17e183648a9bcf4-1.0.9.xpi` into `assets/tori-download-manager-firefox-v1.0.9.xpi` while preserving `v1.0.3`–`v1.0.5` assets.
  2. Add explicit `Content-Type: application/x-xpinstall` header entries in `_headers` for `/assets/tori-download-manager-firefox-v1.0.9.xpi` and `/tori-download-manager-firefox-v1.0.9.xpi`.
  3. Update `index.html`: download buttons & hrefs, version badges (`v1.0.5` Desktop, `v1.0.9` Companion), installer size (`112.3 MB`), Chromium ZIP + signed Firefox XPI links, JSON-LD `softwareVersion`, SHA-256 verification values (`cab4156fc85a42ce74d5d4292e2976223ba14ad4c8e7d5bbfea533e4ca72f3cb` / `d4e8d6e585ba6dfaf841eb6b37f2ee27beae1cec55badbbe0dd12960ad5943ec`), release notes, and Changelog.
  4. Update `sitemap.xml` `<lastmod>`.
  5. Rebuild `public/` cleanly prior to Cloudflare Pages deployment.

---

## 18. Rollback Strategy

**Core Guarantee:** Never delete previous public GitHub releases (`v1.0.4`, `v1.0.3`, `extension-v1.0.5`, etc.) or user data. In-place NSIS installs and rollbacks preserve `%APPDATA%\tori-download-manager\tdm_storage.sqlite`, user settings, download history, and partial/completed files.

1. **Incorrect Installer Uploaded (`v1.0.5`):** Immediately revert live `latest.json` to `v1.0.4` to halt auto-updates; replace/re-tag pre-release asset or issue hotfix `v1.0.5.1`/`v1.0.6` with regenerated `.sig` and `SHA256SUMS.txt`. Never remove `v1.0.4`.
2. **Broken `latest.json`:** Restore the pre-Gate-30.2 `v1.0.4` `latest.json` snapshot verbatim and re-verify `1.0.4` asset URL and Ed25519 signature.
3. **Failed Live Auto-Update (`1.0.4 -> 1.0.5`):** Point `latest.json` back to `v1.0.4` immediately; instruct impacted users to close TORI and run `TORI Download Manager_1.0.4_x64-setup.exe` over the existing install (preserves `tdm_storage.sqlite` and downloads).
4. **Browser Extension Incompatibility (`v1.0.9`):** Keep `extension-v1.0.5` and preserved signed XPIs (`v1.0.7` / `v1.0.5`) intact on GitHub; restore website extension links to `extension-v1.0.5` and issue `v1.0.10` hotfix if store submission is live.
5. **Signed Firefox XPI (`v1.0.9`) Issue:** Revert `toridownload.xyz` Firefox XPI download target to `/assets/tori-download-manager-firefox-v1.0.5.xpi` (or signed `v1.0.7`), keeping `application/x-xpinstall` MIME headers active; never switch users to an unsigned Firefox ZIP.
6. **Website Link / Deploy Mismatch:** Run `git revert` on `C:\Users\ritud\Downloads\tori-website` (back to `a569761`), rebuild `public/`, redeploy Cloudflare Pages, and verify HTTP `200`, `Content-Type`, and checksums.
7. **Missing GitHub Release Asset:** Do not promote `latest.json` or deploy `toridownload.xyz` until every file in `SHA256SUMS.txt` downloads cleanly from GitHub with matching hash; if discovered post-cutover, revert `latest.json` and `toridownload.xyz` to `v1.0.4` until the asset is restored.

---

## 19. Known Limitations

1. **No Windows Authenticode PE Signature:** `NotSigned` -> SmartScreen / UAC "Unknown publisher" warning occurs on clean Windows systems until OV/EV Authenticode signing is performed.
2. **No Clean Windows VM Run:** Host had `0` VMs available; validated via isolated Windows x64 test profiles/dirs instead.
3. **Chrome Web Store / Edge Add-ons Submission Pending:** `tori-companion-v1.0.9-chromium.zip` was verified locally unpacked in Chrome `157` & Edge `157` (Mozilla AMO signing is already complete for `1.0.9`).
4. **CSP Config Advisory:** `src-tauri/tauri.conf.json` has `app.security.csp = null`.

---

## 20. Clean Windows VM Validation Status

- **Status:** **`NOT TESTED`**
- **Environment Check Result:** Windows Hyper-V service (`vmms`) is running with **`0`** virtual machines configured, and VirtualBox/VMware/QEMU are not installed on the host. Clean-machine install/upgrade/uninstall testing in an isolated Windows 10/11 VM should be performed before or during staging in Gate 30.2 if operator policy requires it prior to flipping public `latest.json`.

---

## 21. Remaining Release Blockers

- **Code / Test / Packaging / Security Blockers:** **`0` (None)**.
- **Documented Accepted Limitations under `CONDITIONAL GO`:**
  1. Unsigned Windows Authenticode PE executables/installer.
  2. Clean Windows VM validation `NOT TESTED`.

---

## 22. Exact Gate 30.2 Publication Sequence

Execute strictly in order only after explicit operator authorization:
1. **Create Draft GitHub Release `v1.0.5`** (and companion tag `extension-v1.0.9` or bundled assets as decided) and upload all frozen artifacts (`TORI Download Manager_1.0.5_x64-setup.exe`, `.sig`, standalone EXEs, `tori-companion-v1.0.9-chromium.zip`, signed `a70ed17e183648a9bcf4-1.0.9.xpi`, `SHA256SUMS.txt`, `RELEASE_NOTES_v1.0.5_v1.0.9.md`, `RELEASE_MANIFEST.json`) **before** activating `latest.json`.
2. **Verify Uploaded Asset URLs & Hashes:** Confirm `TORI.Download.Manager_1.0.5_x64-setup.exe` and all assets download with HTTP `200` and exact `SHA256SUMS.txt` hashes.
3. **Publish Release & `latest.json`:** Promote release from draft and publish `latest.json` (matching verified `latest.v1.0.5.draft.json`), then smoke-test an in-app `v1.0.4 -> v1.0.5` auto-update.
4. **Update & Deploy Website (`toridownload.xyz`):** Apply website plan (`index.html`, `assets/tori-download-manager-firefox-v1.0.9.xpi`, `_headers`, `sitemap.xml`, rebuild `public/`), deploy to Cloudflare Pages, and verify live download links, `application/x-xpinstall` MIME header, and checksums.
5. **Store Submissions (if applicable):** Submit `tori-companion-v1.0.9-chromium.zip` to Chrome Web Store and Microsoft Edge Add-ons (Firefox AMO `v1.0.9` XPI is already signed).

---

## 23. Final Release Decision

**`CONDITIONAL GO — DOCUMENTED LIMITATIONS`**

TORI Download Manager Desktop `v1.0.5` and Browser Companion `v1.0.9` have cleared all automated, cryptographic, regression, performance, security, and preflight release gates with zero code defects remaining. Publication remains held (`NOT PERFORMED`) pending explicit operator authorization for Gate 30.2 acknowledging the unsigned Windows Authenticode status and the untested clean Windows VM state.
