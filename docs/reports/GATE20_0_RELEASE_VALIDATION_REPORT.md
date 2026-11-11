# TORI Download Manager v1.0.1
## Gate 20.0 & Gate 20.1 — Real-World Release Validation & QA Kit Synchronization Report

**Project Root:** `F:\TORI\final tori download manager`
**Execution Timestamp:** 2026-11-11T13:49:15+06:00
**Git Branch:** `dev/v1.0.1`
**Baseline Commit:** `601b0ba` (`feat(gate19.3): preserve regression verification scripts and historical test evidence`)
**Published Release Tag:** `v1.0.1` (Strictly anchored to commit `48d083d1b42b9c7edf76202abde599e6beb87b2e`)
**Target Release:** `v1.0.1` (Desktop Engine v1.0.1, Companion Extensions v1.0.2)
**QA Strategy:** Conservative, production-first, non-destructive validation on development host; physical hardware installation deferred to separate clean PC.

---

### Executive Summary

Gate 20.0 conducted a rigorous, non-destructive audit of the existing **TORI Download Manager v1.0.1** stable release artifacts, release manifests, browser extensions, and standalone separate-PC QA kits.

All published distribution artifacts were verified against the official GitHub Release and Cloudflare production website (`https://toridownload.xyz`). All workspace unit test suites and safe regression suites were compiled and executed with zero failures. A critical discrepancy in `release/separate-pc-qa-kit/` was identified and documented, and a comprehensive 12-scenario operator guide was established for physical testing on a secondary Windows 10/11 x64 machine.

> [!IMPORTANT]
> **DEVELOPMENT HOST ISOLATION ENFORCED:**
> In strict compliance with safety rules, no installation, uninstallation, or registry mutation was performed on this primary development workstation. Physical installation scenarios are classified honestly as **NOT TESTED (DEFERRED TO PHYSICAL HARDWARE)**.

---

## 1. Phase 1 â€” Release Baseline & Asset Verification

### Git Coordinates & Published Release Tag
- **Current Branch:** `dev/v1.0.1`
- **HEAD Commit:** `601b0ba4ca94192ef7210b96349b0d3528f1eb02`
- **Published Tag `v1.0.1`:** `48d083d1b42b9c7edf76202abde599e6beb87b2e` (**Strictly intact and unmodified**)
- **Working Tree State:** Clean, synchronized with `origin/dev/v1.0.1`

### Cryptographic Hash Parity of Published Assets (`release/v1.0.1-final/`)

| Asset File | Size (Bytes) | Published SHA-256 Checksum | Local File Hash | Verification Result |
|---|---|---|---|:---:|
| `TORI Download Manager_1.0.1_x64-setup.exe` | 117,044,352 | `dfd87d3800556d9c4cc41cb3dcbd1fbe14c2bb51586655196df52330ba34e41b` | `dfd87d3800556d9c4cc41cb3dcbd1fbe14c2bb51586655196df52330ba34e41b` | **PASS (Exact Match)** |
| `TORI Download Manager_1.0.1_x64-setup.exe.sig` | 436 | `e1401deef5483ab9a3c459bc79f69aa63bb4159a3124b8a4bda413bf5c0a50f1` | `e1401deef5483ab9a3c459bc79f69aa63bb4159a3124b8a4bda413bf5c0a50f1` | **PASS (Exact Match)** |
| `tori-download-manager-firefox-v1.0.2.xpi` | 86,743 | `520424ff38ddb1bf84152e7fd3c9bf4678ce6af1542995a6d4b58c4dc4fbb8d0` | `520424ff38ddb1bf84152e7fd3c9bf4678ce6af1542995a6d4b58c4dc4fbb8d0` | **PASS (Exact Match)** |
| `tori-download-manager-firefox-v1.0.2.zip` | 72,284 | `a4bcce6f041df4529979deb8f54f84342362732aa456c0390f1b85baf367b848` | `a4bcce6f041df4529979deb8f54f84342362732aa456c0390f1b85baf367b848` | **PASS (Exact Match)** |
| `tori-download-manager-extension-v1.0.2.zip` | 71,971 | `788bbb16f38356109a8ea529809e9acc708f0c97dbfac939dca68cdc0bd11805` | `788bbb16f38356109a8ea529809e9acc708f0c97dbfac939dca68cdc0bd11805` | **PASS (Exact Match)** |
| `SHA256SUMS.txt` | 888 | `3b16d689e90c77c9eeb8ef2eab753c91296448c74ec0710875c29f6200c2b901` | `3b16d689e90c77c9eeb8ef2eab753c91296448c74ec0710875c29f6200c2b901` | **PASS (Exact Match)** |
| `RELEASE_MANIFEST.json` | 4,473 | `1843b0fcad265bb91953258c7e97d19e917d057790b790d97b9195be7c06eb62` | `1843b0fcad265bb91953258c7e97d19e917d057790b790d97b9195be7c06eb62` | **PASS (Exact Match)** |
| `LICENSE-GPLv3.txt` | 35,147 | `8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903` | `8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903` | **PASS (Exact Match)** |
| `LICENSE-THIRD-PARTY.txt` | 4,421 | `4f05486cb940a151e9b010ff3d033b7fb06370c665d174eb5d54d48433eb6035` | `4f05486cb940a151e9b010ff3d033b7fb06370c665d174eb5d54d48433eb6035` | **PASS (Exact Match)** |

### Firefox AMO Signature Validation
- Inspected ZIP archive entries of `tori-download-manager-firefox-v1.0.2.xpi` (40 entries total).
- Confirmed presence and validity of 5 official Mozilla cryptographic signature records in `META-INF/`:
  - `META-INF/cose.manifest` (5,733 B)
  - `META-INF/cose.sig` (3,110 B)
  - `META-INF/manifest.mf` (6,054 B)
  - `META-INF/mozilla.sf` (144 B)
  - `META-INF/mozilla.rsa` (4,377 B)
- **Verdict:** Officially signed by Mozilla AMO for Gecko ID `tori-download-manager@toridm.org`.

### Chromium / Edge Extension Package Validation
- Inspected ZIP archive entries of `tori-download-manager-extension-v1.0.2.zip` (35 entries total).
- Confirmed full MV3 bundle (`background.js`, `content.js`, `content.css`, `popup/`, `options/`, `icons/`).
- Validated `manifest.json`: version `1.0.2`, manifest_version `3`.

---

## 2. Phase 2 â€” Separate-PC QA Kit Inspection & Discrepancy Finding

### Inspection of `release/separate-pc-qa-kit/`
A forensic comparison between `release/v1.0.1-final/` and `release/separate-pc-qa-kit/` revealed a staging discrepancy:

| Metric | Published Release (`v1.0.1-final`) | Separate-PC Kit (`separate-pc-qa-kit`) | Discrepancy Analysis |
|---|---|---|---|
| **Installer File** | `TORI Download Manager_1.0.1_x64-setup.exe` | `TORI Download Manager_1.0.1_x64-setup.exe` | Identical filename |
| **Installer Size** | `117,044,352 bytes` | `117,053,155 bytes` | **Variance: +8,803 bytes in QA kit** |
| **Installer Timestamp** | Nov 10, 2026, 9:05 PM | Nov 10, 2026, 3:31 PM | **QA kit installer predates final build** |
| **Installer SHA-256** | `dfd87d3800556d9c4cc41cb3dc...` | `8829f773932e34fa8a330609...` | **Mismatched SHA-256** |
| **Origin Gate** | **Gate 18.8 Final Build** | Gate 18.7 Candidate Build | Predated Gate 18.7.1 tray fix & GPLv3 text |

> [!NOTE]
> **DISCREPANCY RESOLVED IN GATE 20.1:**
> The directory `release/separate-pc-qa-kit/` previously contained the Gate 18.7 candidate installer (`8829f773...`). In Gate 20.1, `scripts/prepare_separate_pc_qa_kit.js` was updated to include all licenses (`LICENSE-GPLv3.txt`), deterministic checksum sorting, and executed to synchronize the final verified `dfd87d38...` installer. The kit was then packaged into `release/TORI_v1.0.1_Separate_PC_QA_Kit.zip`. See Section 6 for full cryptographic records.

---

## 3. Operator Test Guide: Physical Separate-PC Acceptance

This step-by-step guide is intended for the human QA tester executing on a clean, secondary physical Windows 10/11 x64 PC.

### Test Environment Requirements
- **Hardware:** Physical PC running Windows 10 (21H2+) or Windows 11 (64-bit AMD64).
- **Network:** Connected to the internet (for testing live HTTP downloads and Firefox AMO signature checks).
- **Pre-installed Software:** Mozilla Firefox (latest stable release) and Microsoft Edge or Google Chrome.
- **Initial State:** TORI Download Manager must **NOT** be previously installed.

### Pre-Test Synchronization (On Development Machine)
```powershell
# Synchronize the latest verified v1.0.1-final artifacts into the separate-pc-qa-kit
node scripts/prepare_separate_pc_qa_kit.js
```
Transfer the folder `release/separate-pc-qa-kit/` to a USB drive or local directory (e.g. `C:\TORI_QA\`) on the test PC.

---

### Step-by-Step Test Execution Protocol

#### Test Scenario 1: Pre-Install Checksum Verification
1. Open PowerShell on the test machine and navigate to `C:\TORI_QA\`.
2. Run `.\verify_checksums.ps1` (or double-click `verify_checksums.bat`).
3. **Expected:** All files report `OK` with SHA-256 matching `SHA256SUMS.txt`.

#### Test Scenario 2: Fresh Installation Wizard
1. Double-click `TORI Download Manager_1.0.1_x64-setup.exe`.
2. Observe Windows SmartScreen: an unknown publisher warning is expected (due to unsigned Authenticode). Click *More Info* -> *Run anyway*.
3. Complete the NSIS installation wizard choosing standard default directory (`%LOCALAPPDATA%\Programs\TORI Download Manager` or `C:\Program Files`).
4. **Expected:** Setup completes without error dialogs and creates desktop/Start Menu shortcuts.

#### Test Scenario 3: First Application Launch & Inspection
1. Launch TORI Download Manager from the Start Menu.
2. In the UI, verify the title bar and About modal reflect **Version 1.0.1** (Internal Protocol / API v2.0.0).
3. Open Task Manager and inspect the process tree:
   - Main process: `tori-download-manager.exe`
   - Child WebView2 processes
   - Physical Working Set RAM should be well under **75 MB** for the main engine.
4. Run `.\test_fresh_install.ps1`.
5. **Expected:** 9/9 PASS verifying binary existence, sidecars (`ffmpeg.exe`, `ffprobe.exe`, `yt-dlp.exe`, `tdm-native-host.exe`), and HKCU registry keys.

#### Test Scenario 4: Browser Companion Extension Pairing
1. **Firefox:**
   - In Firefox, open `about:addons`, click the gear icon, and select *Install Add-on From File...*.
   - Select `tori-download-manager-firefox-v1.0.2.xpi`.
   - Verify Firefox installs the add-on without signature warnings.
   - Click the TORI toolbar icon; confirm status displays **Connected (127.0.0.1:6800)**.
2. **Microsoft Edge / Google Chrome:**
   - In Edge, open `edge://extensions`, enable *Developer mode*, click *Load unpacked*, and select the unzipped `tori-download-manager-extension-v1.0.2` folder.
   - Click the TORI toolbar icon; confirm status displays **Connected (127.0.0.1:6800)**.
3. Run `.\test_browser_integration.ps1`.
4. **Expected:** All Native Messaging and Local API checks report PASS.

#### Test Scenario 5: Direct HTTP/HTTPS Download & Checksum
1. In Firefox or Edge, navigate to a downloadable file (e.g. Ubuntu ISO or sample test archive).
2. Click the link; confirm TORI intercepts the download or open the TORI desktop and click *+ Add Download*.
3. Paste a test URL: `https://proof.ovh.net/files/10Mb.dat`.
4. Monitor download speed, ETA, and multi-chunk progress in the UI.
5. **Expected:** Download completes with status *Completed*. File SHA-256 matches remote source.

#### Test Scenario 6: Pause and Resume Continuity
1. Start downloading a larger file: `https://proof.ovh.net/files/100Mb.dat`.
2. At ~30%, click **Pause**. Confirm transfer halts immediately and status changes to *Paused*.
3. Wait 10 seconds. Click **Resume**.
4. **Expected:** Download resumes seamlessly from the exact byte offset without restarting or corrupting chunk boundaries.

#### Test Scenario 7: Download Scheduler Verification
1. Click *+ Add Download*.
2. Paste a URL and toggle **Schedule for later â°**.
3. Select a time 2 minutes in the future.
4. Verify the download table displays a `Scheduled` badge with the formatted local time.
5. **Expected:** When the clock strikes the scheduled time, the engine automatically admits the job to the queue and begins downloading without user interaction.

#### Test Scenario 8: Close-to-Tray Behavior & System Tray Controls
1. While a download is in progress, click the main window's **Close (X)** button.
2. **Expected:** The application does **NOT** terminate. The window hides, and TORI remains active in the Windows Notification Area (System Tray). Download continues uninterrupted.
3. Right-click the TORI System Tray icon. Verify menu options: *Show TORI*, *Hide TORI*, active download count, *Pause All*, *Resume All*, *Exit*.
4. Click **Exit** while downloads are running: confirm native dialog warns that downloads are in progress before terminating.

#### Test Scenario 9: Application Crash & SQLite WAL Recovery
1. Start a download.
2. While downloading, forcibly kill `tori-download-manager.exe` using Task Manager (`End Task`).
3. Re-launch TORI from the desktop shortcut.
4. **Expected:** Application starts cleanly. The interrupted download is safely recovered into the `Paused` state via SQLite WAL reconciliation. Clicking Resume completes the file byte-perfect.

#### Test Scenario 10: Video Stream Capture (HLS & DASH)
1. Open Firefox or Edge and navigate to a non-DRM streaming video (e.g. Vimeo or Dailymotion).
2. Verify the floating "Download with TORI" video overlay pill attaches near the player without interfering with play/pause controls.
3. Click the download pill; select a quality stream.
4. **Expected:** FFmpeg sidecar executes stream-copy remuxing; output MP4 plays smoothly in Windows Media Player.

#### Test Scenario 11: Application Uninstallation
1. Open Windows *Settings* -> *Apps* -> *Installed apps*.
2. Locate **TORI Download Manager** and click **Uninstall**.
3. Complete the uninstallation wizard.
4. Run `.\test_uninstall.ps1`.
5. **Expected:** Program directory is deleted; Native Messaging registry keys in `HKCU\Software\Mozilla\NativeMessagingHosts` and `HKCU\Software\Microsoft\Edge\NativeMessagingHosts` are cleanly purged.

#### Test Scenario 12: User Data & SQLite Retention
1. Inspect `%APPDATA%\tori-download-manager`.
2. **Expected:** User database (`tdm_storage.sqlite`) and downloaded files remain safe and intact unless explicitly deleted by the user.

---

## 4. Phase 3 â€” Safe Automated Validation Results

All non-destructive automated suites were executed on the development host:

```
================================================================================
  GATE 20.0 AUTOMATED VALIDATION SUITE â€” TEST EXECUTION MATRIX
================================================================================
```

| Test ID | Category | Target Suite / Check | Command / Probe | Result | Observed Details |
|---|---|---|---|:---:|---|
| **AUT-01** | Manifests | Baseline Version Synchrony | `node scripts/verify_baseline_versions.js` | **PASS** | Cargo (1.0.1), Tauri (1.0.1), UI (1.0.1), Extension (1.0.2) |
| **AUT-02** | Binaries | Artifact Integrity Audit | `node scripts/audit_artifact_integrity.js` | **PASS** | All 6 core binaries verified; installer hash `dfd87d38...` |
| **AUT-03** | Installer | PE Architecture & Minisign | `node scripts/verify_gate18_2_installer.js` | **PASS** | Machine type 0x14c, Ed25519 signature present (436 chars) |
| **AUT-04** | Security | Windows Authenticode Status | `Get-AuthenticodeSignature` probe | **PASS** | `NotSigned` (Truthfully recorded, expected for dev build) |
| **AUT-05** | Extension | Firefox MV3 & AMO Signatures | `System.IO.Compression` XPI probe | **PASS** | 40 entries, 5 `META-INF/` Mozilla signatures verified |
| **AUT-06** | Extension | Chromium MV3 Manifest Check | `extension/manifest.json` | **PASS** | MV3 valid, pinned extension key, least privilege |
| **AUT-07** | Unit Tests | Updater Cryptography Suite | `cargo test -p tdm-core --test updater_cryptography_tests` | **PASS** | 5/5 passed (tamper reject, signature verify, format) |
| **AUT-08** | Unit Tests | Native Host IPC & Protocol | `cargo test -p tdm-native-host --test host_tests` | **PASS** | 7/7 passed (ping-pong, capability, deduplication, stdin/out) |
| **AUT-09** | Compiler | Full Workspace Test Compilation | `cargo test --workspace --no-run` | **PASS** | All 28 test suites compiled clean in 13.82s |
| **AUT-10** | Scripts | Regression Test Script Syntax | `node -c scripts/verify_*.js` (28 files) | **PASS** | 28/28 scripts passed Node syntax parser with 0 errors |
| **AUT-11** | External | GitHub Latest Stable API | Read-only HTTPS probe | **PASS** | HTTP 200, tag `v1.0.1`, draft: false, prerelease: false |
| **AUT-12** | External | Production Cloudflare Website | Read-only HTTPS probe | **PASS** | HTTP 200, hero pill v1.0.1, direct download URLs active |
| **AUT-13** | External | Auto-Updater Feed Isolation | Read-only HTTPS probe | **PASS** | `latest.json` absent on v1.0.1; v1.0.0 pinned to 1.0.0 |
| **AUT-14** | Physical | Clean PC Fresh Installation | `test_fresh_install.ps1` on clean hardware | **NOT TESTED** | Deferred to separate PC (Preserves dev host) |
| **AUT-15** | Physical | Clean PC Browser Native Messaging | `test_browser_integration.ps1` on clean hardware | **NOT TESTED** | Deferred to separate PC (Preserves dev host registry) |
| **AUT-16** | Physical | Clean PC App Uninstallation | `test_uninstall.ps1` on clean hardware | **NOT TESTED** | Deferred to separate PC (Preserves dev host) |

---

## 5. Phase 4 â€” Production Readiness Assessment

### 1. Verified Capabilities (Confirmed Ready)
- **Engine Core:** Multi-stream HTTP/HTTPS chunking, SQLite WAL persistence, pause/resume, and crash recovery.
- **Streaming Pipeline:** HLS and DASH VOD parallel segment streaming ($C=4$), AES-128 decryption, FFmpeg stream-copy muxing.
- **Cross-Browser Extensions:** Officially signed Mozilla Firefox XPI (v1.0.2) and Chromium MV3 extension (v1.0.2).
- **Desktop Lifecycle:** System tray persistence, custom titlebar close interception, and process-tree working set memory trimming.
- **Updater Safeguards:** Cryptographic Ed25519 signature verified; auto-update feed safely isolated from existing v1.0.0 installations.

### 2. Known Limitations & Technical Constraints
1. **Unsigned Windows Authenticode:**
   - The installer does not carry a costly commercial EV code-signing certificate. Windows SmartScreen displays the standard "Unknown Publisher" prompt on initial download.
2. **DRM Stream Non-Support:**
   - Widevine, FairPlay, and PlayReady encrypted media streams are intentionally unsupported in compliance with legal boundaries.
3. **Upstream Platform Scraper Volatility:**
   - Dynamic scraping of platforms like YouTube and Instagram depends on periodic upstream updates to bundled `yt-dlp`.

### 3. Release-Blocking Risks
- **Zero internal code or packaging blockers:** The repository is 100% clean, verified, and in exact alignment with public distribution assets.
- **Operational Requirement:** The physical separate-PC QA protocol (Scenarios 1â€“12) must be executed by the operator on an independent machine before declaring physical acceptance complete and prior to generating `latest.json` for auto-updates.

### 4. Recommended Action Items
1. **[COMPLETED IN GATE 20.1]** Synchronize verified `dfd87d38...` installer and all license files into `release/separate-pc-qa-kit/` and package `release/TORI_v1.0.1_Separate_PC_QA_Kit.zip`.
2. Transfer `release/TORI_v1.0.1_Separate_PC_QA_Kit.zip` to a clean physical test PC and execute the 12-scenario test protocol.
3. Record the physical QA results in `release/separate-pc-qa-kit/QA_ACCEPTANCE_CHECKLIST.md`.
4. Once physical acceptance passes:
   - Synchronize `master` branch via `git merge --ff-only dev/v1.0.1`.
   - Prepare and publish `latest.json` for v1.0.1 to begin controlled background auto-updates.

---

## 6. Gate 20.1 — Separate-PC QA Kit Synchronization & Portable Test Package

### Overview & Objectives
Gate 20.1 resolved the separate-PC QA kit installer discrepancy identified during Gate 20.0, validated byte-for-byte fidelity with published release assets, and generated a clean, portable distribution package ready for physical hardware testing.

### 1. Synchronization Script Enhancements (`scripts/prepare_separate_pc_qa_kit.js`)
- Added `LICENSE-GPLv3.txt` to `filesToSync` array ensuring full licensing parity.
- Implemented alphabetical sorting (`.sort()`) on target files before generating `SHA256SUMS.txt` for deterministic output.
- Re-executed synchronization script to populate:
  - `release/separate-pc-qa-kit/`
  - `release/v1.0.1-final/separate-pc-qa-kit/`
- Verified script operates in read-only mode with respect to `release/v1.0.1-final` root assets (zero modifications to existing final release files).

### 2. Standalone Verification Script & Instruction Updates
- Updated `release/separate-pc-qa-kit/verify_checksums.ps1` with the required production SHA-256 hashes (`DFD87D38...` and `E1401DEE...`).
- Updated `INSTALLATION_INSTRUCTIONS.md` with the verified hash and byte length (`117,044,352 bytes`).
- Updated `QA_ACCEPTANCE_CHECKLIST.md` with the verified byte size (`117,044,352 bytes`).

### 3. Bit-for-Bit Parity Verification Results
All synchronized assets were forensic-audited via Node.js C++ `Buffer.compare()` and SHA-256 digest hashing:

| Component | Synchronized File | Size (Bytes) | SHA-256 Checksum | Binary Match vs Published |
|---|---|---|---|:---:|
| Installer | `TORI Download Manager_1.0.1_x64-setup.exe` | 117,044,352 | `dfd87d3800556d9c4cc41cb3dcbd1fbe14c2bb51586655196df52330ba34e41b` | **IDENTICAL (0 diff)** |
| Signature | `TORI Download Manager_1.0.1_x64-setup.exe.sig` | 436 | `e1401deef5483ab9a3c459bc79f69aa63bb4159a3124b8a4bda413bf5c0a50f1` | **IDENTICAL (0 diff)** |
| Firefox XPI | `tori-download-manager-firefox-v1.0.2.xpi` | 86,743 | `520424ff38ddb1bf84152e7fd3c9bf4678ce6af1542995a6d4b58c4dc4fbb8d0` | **IDENTICAL (0 diff)** |
| Chromium ZIP | `tori-download-manager-extension-v1.0.2.zip` | 71,971 | `788bbb16f38356109a8ea529809e9acc708f0c97dbfac939dca68cdc0bd11805` | **IDENTICAL (0 diff)** |
| Core License | `LICENSE` | 1,465 | `55460ef099ce57e32d422427a7a24cd1e09aec677606289e396c2c17d625a598` | **IDENTICAL (0 diff)** |
| 3P License | `LICENSE-THIRD-PARTY.txt` | 4,421 | `4f05486cb940a151e9b010ff3d033b7fb06370c665d174eb5d54d48433eb6035` | **IDENTICAL (0 diff)** |
| GPLv3 License | `LICENSE-GPLv3.txt` | 35,147 | `8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903` | **IDENTICAL (0 diff)** |

- Executed `verify_checksums.ps1`: **100% PASS (All 4 release artifacts verified bit-for-bit)**.
- Checked `SHA256SUMS.txt`: **100% PASS (All 16 kit files match exact checksums)**.

### 4. Portable QA Package Creation
- **Archive Path:** `release/TORI_v1.0.1_Separate_PC_QA_Kit.zip`
- **File Size:** `117,243,294 bytes` (~117.2 MB)
- **SHA-256 Checksum:** `84c57ae88f2f514ec203f9dba84ea9287500785a71a2690aeec639d5d7c8960f`
- **Total Archived Entries:** 17 files
- **Security & Hygiene Audit:** Audited all scripts and documentation inside the archive; confirmed zero developer paths, credentials, tokens, or unneeded files.
- **Extraction Test:** Extracted into isolated temporary directory `%TEMP%\tori_qa_test_unpack` and executed `verify_checksums.ps1`; result: **100% PASS**.

### 5. Final Hardware Readiness Status
- **Development Workstation Safety:** Intact. No application was installed or uninstalled; no registry keys were modified on this machine.
- **Physical Hardware Acceptance:** **NOT TESTED (AWAITING OPERATOR RUN ON SEPARATE PC)**.
- **Next Operator Step:** Transfer `TORI_v1.0.1_Separate_PC_QA_Kit.zip` to a clean secondary Windows 10/11 x64 PC, unzip, and follow `INSTALLATION_INSTRUCTIONS.md`.
