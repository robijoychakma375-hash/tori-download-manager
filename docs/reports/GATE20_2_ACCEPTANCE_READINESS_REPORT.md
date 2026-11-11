# TORI Download Manager v1.0.1
## Gate 20.2 — Physical Acceptance Preparation & Safe Integration Validation Report

**Project Root:** `F:\TORI\final tori download manager`  
**Execution Timestamp:** 2026-11-11T15:10:00+06:00  
**Current Git Branch:** `dev/v1.0.1`  
**Current HEAD Commit:** `3c15d48ccc4cb86081d0f8a9445dba24a22d2e3f` (`chore(gate20.1): synchronize separate-PC QA kit and document validation`)  
**Published Release Tag:** `v1.0.1` (Strictly anchored to commit `48d083d1b42b9c7edf76202abde599e6beb87b2e`)  
**Production Endpoints:** GitHub Releases (`v1.0.1`) · Cloudflare Pages (`https://toridownload.xyz`) · Auto-Updater Feed (`latest.json` isolated)  
**QA Package:** `release/TORI_v1.0.1_Separate_PC_QA_Kit.zip` (SHA-256: `84c57ae88f2f514ec203f9dba84ea9287500785a71a2690aeec639d5d7c8960f`)  

---

### Executive Summary

Gate 20.2 successfully finalized all technical preparations for physical Windows acceptance testing of **TORI Download Manager v1.0.1**.

All distribution assets, companion browser extensions, and standalone QA packages were confirmed bit-for-bit identical with the published release baseline. A total of **84 automated Rust unit and integration tests** were executed across core downloading, queue recovery, scheduling, adaptive chunking, and native host IPC with a **100% pass rate (0 failures)**. In addition, browser extension manifests, Mozilla AMO cryptographic signatures, and safety auditing scripts passed with zero warnings.

To maintain absolute safety on the primary development workstation, no binaries were installed or uninstalled, and no host registry keys were mutated. A comprehensive 12-scenario physical testing checklist has been established for the human operator. All physical hardware test scenarios are truthfully and conservatively classified as **NOT TESTED** pending manual execution on a secondary Windows 10/11 x64 machine.

---

## 1. Phase 1 — Release Baseline & Cryptographic Parity Audit

The working tree was verified clean on branch `dev/v1.0.1`. Cryptographic checksums of all release assets in `release/v1.0.1-final/` and `release/separate-pc-qa-kit/` were verified against official production manifests:

| Component | Target File | Byte Size | Expected SHA-256 Checksum | Verified Checksum | Parity Status |
|---|---|---|---|---|:---:|
| **NSIS Installer** | `TORI Download Manager_1.0.1_x64-setup.exe` | 117,044,352 B | `dfd87d3800556d9c4cc41cb3dcbd1fbe14c2bb51586655196df52330ba34e41b` | `dfd87d3800556d9c4cc41cb3dcbd1fbe14c2bb51586655196df52330ba34e41b` | **PASS (Exact Match)** |
| **Minisign Sig** | `TORI Download Manager_1.0.1_x64-setup.exe.sig` | 436 B | `e1401deef5483ab9a3c459bc79f69aa63bb4159a3124b8a4bda413bf5c0a50f1` | `e1401deef5483ab9a3c459bc79f69aa63bb4159a3124b8a4bda413bf5c0a50f1` | **PASS (Exact Match)** |
| **Firefox XPI** | `tori-download-manager-firefox-v1.0.2.xpi` | 86,743 B | `520424ff38ddb1bf84152e7fd3c9bf4678ce6af1542995a6d4b58c4dc4fbb8d0` | `520424ff38ddb1bf84152e7fd3c9bf4678ce6af1542995a6d4b58c4dc4fbb8d0` | **PASS (Exact Match)** |
| **Chromium ZIP** | `tori-download-manager-extension-v1.0.2.zip` | 71,971 B | `788bbb16f38356109a8ea529809e9acc708f0c97dbfac939dca68cdc0bd11805` | `788bbb16f38356109a8ea529809e9acc708f0c97dbfac939dca68cdc0bd11805` | **PASS (Exact Match)** |
| **Firefox ZIP** | `tori-download-manager-firefox-v1.0.2.zip` | 72,284 B | `a4bcce6f041df4529979deb8f54f84342362732aa456c0390f1b85baf367b848` | `a4bcce6f041df4529979deb8f54f84342362732aa456c0390f1b85baf367b848` | **PASS (Exact Match)** |
| **MIT License** | `LICENSE` | 1,465 B | `55460ef099ce57e32d422427a7a24cd1e09aec677606289e396c2c17d625a598` | `55460ef099ce57e32d422427a7a24cd1e09aec677606289e396c2c17d625a598` | **PASS (Exact Match)** |
| **3P Notices** | `LICENSE-THIRD-PARTY.txt` | 4,421 B | `4f05486cb940a151e9b010ff3d033b7fb06370c665d174eb5d54d48433eb6035` | `4f05486cb940a151e9b010ff3d033b7fb06370c665d174eb5d54d48433eb6035` | **PASS (Exact Match)** |
| **GNU GPLv3** | `LICENSE-GPLv3.txt` | 35,147 B | `8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903` | `8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903` | **PASS (Exact Match)** |
| **QA ZIP Kit** | `TORI_v1.0.1_Separate_PC_QA_Kit.zip` | 117,243,294 B | `84c57ae88f2f514ec203f9dba84ea9287500785a71a2690aeec639d5d7c8960f` | `84c57ae88f2f514ec203f9dba84ea9287500785a71a2690aeec639d5d7c8960f` | **PASS (Exact Match)** |

---

## 2. Phase 2 — Physical QA Execution Guide & Acceptance Checklist

This guide is designed for the operator testing on a clean, secondary Windows 10 (21H2+) or Windows 11 x64 machine.

### Environment Preparation
1. Copy `release/TORI_v1.0.1_Separate_PC_QA_Kit.zip` to the test PC (e.g., `C:\TORI_QA\`).
2. Extract the archive.
3. Open PowerShell or Command Prompt in the extracted folder and run `.\verify_checksums.ps1` (or double-click `verify_checksums.bat`).
4. Ensure all 4 release artifacts return green `[PASS]` output before proceeding.

### 12-Scenario Physical Acceptance Matrix

| Scenario ID | Test Scenario | Operational Steps | Expected Outcome | Status |
|---|---|---|---|:---:|
| **SCN-01** | **Fresh Installation** | Double-click `TORI Download Manager_1.0.1_x64-setup.exe`. On Windows SmartScreen, click *More info* -> *Run anyway*. Complete NSIS setup wizard choosing default path. Run `test_fresh_install.ps1`. | Setup completes without errors. Program directory created in `%LOCALAPPDATA%\Programs\TORI Download Manager`. All 5 sidecars (`ffmpeg.exe`, `ffprobe.exe`, `yt-dlp.exe`, `tdm-native-host.exe`, `tdm-cli.exe`) present. HKCU Native Messaging registry keys created. `test_fresh_install.ps1` reports 9/9 PASS. | **NOT TESTED** |
| **SCN-02** | **First Launch** | Launch TORI Download Manager from Start Menu. Open About modal. Open Task Manager and check process memory and child processes. | UI renders cleanly with zero visual artifacts. About dialog displays version `1.0.1`. Main engine process Working Set RAM is well under 75 MB. Zero orphaned helper processes. | **NOT TESTED** |
| **SCN-03** | **Firefox Native Messaging** | Open Firefox. Go to `about:addons` -> Install Add-on From File -> select `tori-download-manager-firefox-v1.0.2.xpi`. Click Add. Inspect toolbar popup. Run `test_browser_integration.ps1`. | Firefox verifies authentic Mozilla AMO signature without warning. Toolbar icon displays `Connected · 127.0.0.1:6800`. Stdio native messaging host communicates bidirectionally. | **NOT TESTED** |
| **SCN-04** | **Chrome / Edge Integration** | Unzip `tori-download-manager-extension-v1.0.2.zip`. Open `edge://extensions` (or `chrome://extensions`). Enable *Developer mode*, click *Load unpacked*, and select extension folder. Inspect toolbar popup. | Extension loads without manifest errors. Toolbar popup displays `Connected · 127.0.0.1:6800`. Local API fallback functions cleanly over HTTP port 6800. | **NOT TESTED** |
| **SCN-05** | **HTTP/HTTPS Downloading** | In browser, click a direct download link (e.g., ISO, ZIP, EXE) or click `+ Add Download` in TORI and paste `https://proof.ovh.net/files/10Mb.dat`. Start download. | TORI intercepts or accepts the URL. Multi-chunk download executes with real-time speed, ETA, and progress chunk visualization. Completed file is byte-exact with valid SHA-256. | **NOT TESTED** |
| **SCN-06** | **Pause and Resume** | Start downloading a larger test file (`https://proof.ovh.net/files/100Mb.dat`). At ~30%, click Pause. Wait 10 seconds, then click Resume. | Download halts immediately on Pause; socket I/O terminates. On Resume, download continues seamlessly from exact byte offset without restarting from 0% or corrupting chunks. | **NOT TESTED** |
| **SCN-07** | **Scheduler Operation** | Click `+ Add Download`, paste a URL, check *Schedule for later*, and choose a time 2 minutes in future. Observe table. Wait for scheduled time. | Table displays `Scheduled` badge with formatted local execution time. At the exact target time, engine automatically admits job to active queue and starts downloading. | **NOT TESTED** |
| **SCN-08** | **System Tray Behavior** | While a download is actively transferring, click main window Close (X) button. Inspect Notification Area. Right-click Tray icon. Select Exit. | Window minimizes/hides to System Tray; download continues without interruption. Tray context menu provides Show, Hide, Pause All, Resume All, Exit. Exit prompts confirmation before closing. | **NOT TESTED** |
| **SCN-09** | **Persistence & Crash Recovery** | Start a download. Forcibly terminate `tori-download-manager.exe` using Task Manager (`End Task`). Relaunch TORI from desktop shortcut. Click Resume. | Application launches cleanly. SQLite WAL reconciles database; interrupted download recovers to `Paused` state with retained progress. Clicking Resume completes download successfully. | **NOT TESTED** |
| **SCN-10** | **HLS/DASH Media Download** | In Firefox or Edge, open a non-DRM streaming video (e.g. Vimeo). Observe floating download pill. Click pill, choose quality rendition, and download. | Media detector identifies HLS/DASH stream and extracts master playlist. Segments are downloaded in parallel and remuxed via bundled FFmpeg into a playable MP4 file. | **NOT TESTED** |
| **SCN-11** | **Application Uninstallation** | Close TORI. Open Windows Settings -> Apps -> Installed apps -> TORI Download Manager -> Uninstall. Run `test_uninstall.ps1`. | Uninstaller runs and removes `%LOCALAPPDATA%\Programs\TORI Download Manager`. Native Messaging registry keys in `HKCU\Software\...` are deleted. `test_uninstall.ps1` reports PASS. | **NOT TESTED** |
| **SCN-12** | **User-Data Preservation** | Inspect `%APPDATA%\tori-download-manager\` and `%USERPROFILE%\Downloads\`. | User SQLite database (`tdm_storage.sqlite`) is preserved. Downloaded files in user's Downloads directory remain completely untouched. | **NOT TESTED** |

---

## 3. Phase 3 — Safe Automated Integration Validation Results

A comprehensive battery of non-destructive unit and integration tests was compiled and executed directly against workspace crates and scripts on the development host:

### Summary of Executed Test Suites

| Test Category | Target Suite / Tool | Test File / Command | Tests | Passed | Failed | Status |
|---|---|---|:---:|:---:|:---:|:---:|
| **IPC & Protocol** | `tdm-native-host` | `cargo test -p tdm-native-host --test host_tests` | 7 | 7 | 0 | **PASS** |
| **Local HTTP API** | `tdm-native-host` | `cargo test -p tdm-native-host --test server_tests` | 7 | 7 | 0 | **PASS** |
| **Referer Support** | `tdm-native-host` | `cargo test -p tdm-native-host --test referer_tests` | 1 | 1 | 0 | **PASS** |
| **User-Agent Logic** | `tdm-native-host` | `cargo test -p tdm-native-host --test user_agent_tests` | 1 | 1 | 0 | **PASS** |
| **Scheduler Engine** | `tdm-core` | `cargo test -p tdm-core --test gate17_4_2_scheduler_tests` | 10 | 10 | 0 | **PASS** |
| **Queue & Recovery** | `tdm-core` | `cargo test -p tdm-core --test gate17_4_queue_recovery_tests` | 9 | 9 | 0 | **PASS** |
| **Adaptive Chunking** | `tdm-core` | `cargo test -p tdm-core --test gate2_adaptive_tests` | 8 | 8 | 0 | **PASS** |
| **Folder & Category** | `tdm-core` | `cargo test -p tdm-core --test gate12_7_folder_and_category_tests` | 2 | 2 | 0 | **PASS** |
| **Updater Security** | `tdm-core` | `cargo test -p tdm-core --test updater_cryptography_tests` | 5 | 5 | 0 | **PASS** |
| **HLS Stream Mux** | `tdm-core` | `cargo test -p tdm-core --test gate4_hls_tests` | 9 | 9 | 0 | **PASS** |
| **DASH Stream Mux** | `tdm-core` | `cargo test -p tdm-core --test gate5_dash_tests` | 9 | 9 | 0 | **PASS** |
| **Protocol Matrix** | `tdm-core` | `cargo test -p tdm-core --test gate8_protocol_matrix_tests` | 8 | 8 | 0 | **PASS** |
| **Format Cache** | `tdm-core` | `cargo test -p tdm-core --test gate15_1_format_cache_tests` | 8 | 8 | 0 | **PASS** |
| **Version Synchrony**| Scripts | `node scripts/verify_baseline_versions.js` | 4 | 4 | 0 | **PASS** |
| **Extension Packages**| Scripts | `node scripts/verify_zip_manifests.js` | 8 | 8 | 0 | **PASS** |
| **AMO Signatures** | Scripts | `node scripts/verify_signed_xpi.js` | 4 | 4 | 0 | **PASS** |
| **Safety & Credential**| Scripts | `node scripts/verify_safety_check.js` | 3 | 3 | 0 | **PASS** |
| **Installer PE Audit** | Scripts | `node scripts/verify_gate18_2_installer.js` | 5 | 5 | 0 | **PASS** |
| **TOTAL** | — | — | **108** | **108** | **0** | **100% PASS** |

### Key Technical Verification Findings
1. **Queue Recovery Under Crash:** Confirmed that interrupted jobs detect changed ETags, missing part files, and server range support fallbacks, recovering cleanly into safe states without corrupting destination storage.
2. **Scheduler Integrity:** Confirmed that scheduled jobs survive simulated process restarts, respect concurrency limits, and execute at due time without duplicate queue admission.
3. **Native Host Protocol Security:** Stdio host enforces URL validation, origin matching, and rejects invalid command formats. Local HTTP server strictly validates Origin headers, rejects unauthorized DNS rebinding hosts, and enforces token pairing.
4. **HLS/DASH Streaming:** Verified AES-128 stream decryption, segment byte-range parsing, and proper error handling on DRM-encrypted content.
5. **Updater Cryptographic Safeguards:** Ed25519 signature verification strictly rejects altered binaries, tampered signatures, or mismatched public keys.

---

## 4. Known Limitations

1. **Windows Authenticode Unsigned (Developer Certificate Deferred):**
   - The installer is not signed with a commercial EV certificate ($400+/year). Windows SmartScreen will display an "Unknown Publisher" prompt on initial launch.
   - *Operator Instruction:* Click **More info** -> **Run anyway**.
2. **DRM Encrypted Streams Intentionally Unsupported:**
   - Widevine, PlayReady, and FairPlay encrypted video streams cannot and will not be decrypted by TORI. The engine deterministically rejects DRM streams with a clear unsupported error.
3. **Third-Party Video Platform Scraper Volatility:**
   - YouTube, Instagram, and TikTok scrapers rely on upstream `yt-dlp`. If a platform makes breaking frontend changes, an updated `yt-dlp` binary must be placed into `resources/bin/`.
4. **Developer Workstation State Preservation:**
   - TORI is not installed in the Windows registry or Program Files of the primary development machine to prevent polluting dev environment state.

---

## 5. Remaining Release Risks & Mitigation Strategy

| Risk Description | Potential Impact | Severity | Mitigation Strategy |
|---|---|:---:|---|
| **Clean Machine Missing Runtimes** | Missing VC++ or WebView2 runtimes on older Windows 10 machines. | Medium | NSIS installer checks for WebView2 Evergreen runtime and prompts installation if missing. Modern Windows 10 (21H2+) and Windows 11 bundle WebView2 natively. |
| **Unsolicited Auto-Updates** | Prematurely updating existing v1.0.0 users to v1.0.1 before physical QA is complete. | High | **Strictly Mitigated:** `latest.json` is not published to v1.0.1 release assets. The v1.0.0 feed remains pinned to `1.0.0`. Auto-updates remain disabled until explicit user sign-off. |
| **Browser Extension Permissions** | Chromium Web Store or Edge Add-ons rejection due to broad permissions. | Low | Extensions use Manifest V3 with least-privilege permissions (`nativeMessaging`, `downloads`, `webRequest`, `storage`, `<all_urls>`). |

---

## 6. Evidence Required for Final Physical Acceptance

To achieve official final sign-off and transition to production auto-update enablement, the human operator must execute the 12-scenario protocol on the physical test PC and collect the following artifacts:

1. **Checksum Verification Log:** Console output of `verify_checksums.ps1` confirming 4/4 `[PASS]`.
2. **Fresh Installation Log:** Console output of `test_fresh_install.ps1` confirming 9/9 `[PASS]`.
3. **Browser Integration Log:** Console output of `test_browser_integration.ps1` confirming Native Messaging and HTTP API connectivity in Firefox and Edge.
4. **Uninstallation Log:** Console output of `test_uninstall.ps1` confirming clean removal of program folders and registry keys with preservation of `tdm_storage.sqlite`.
5. **UI Screenshots (3 recommended):**
   - Main window showing completed test download with speed/chunk graph.
   - Firefox and Edge extension popup displaying `Connected · 127.0.0.1:6800`.
   - Windows System Tray showing TORI icon and context menu.
6. **Completed Checklist:** Signed and dated `QA_ACCEPTANCE_CHECKLIST.md` from the QA kit.

---

### Final Readiness Verdict

- **Codebase & Binaries:** 100% Verified, Clean, and Stable.
- **Automated Validation:** 108/108 Tests Passed (100%).
- **QA Kit Packaging:** Synchronized and Verified (`TORI_v1.0.1_Separate_PC_QA_Kit.zip`).
- **Physical Hardware Acceptance:** **READY FOR OPERATOR EXECUTION (CURRENTLY NOT TESTED)**.
- **Auto-Update Activation:** **ON HOLD PENDING PHYSICAL ACCEPTANCE EVIDENCE**.

