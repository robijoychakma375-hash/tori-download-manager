# TORI Download Manager v1.0.1 — Final Release Checklist

**Target Release:** v1.0.1  
**Candidate Directory:** `release/v1.0.1-firefox-final-candidate/`  
**Git Branch:** `dev/v1.0.1`  
**Commit:** `68ef38e`  

---

## 1. Pre-Release Verification Checklist

| Item | Category | Requirement | Verification Method | Status |
|---|---|---|---|---|
| **1.1** | Source Tree | Clean working tree on `dev/v1.0.1` | `git status` | **PASS** |
| **1.2** | Code Quality | Zero warnings across all targets | `cargo clippy --workspace --all-targets -j 2 -- -D warnings` | **PASS** |
| **1.3** | Formatting | Conforms strictly to Rustfmt | `cargo fmt --all -- --check` | **PASS** |
| **1.4** | Core Engine Tests | 100% test pass rate | `cargo test --workspace -j 2` (208 passed, 0 failed) | **PASS** |
| **1.5** | Frontend Build | Clean Vite / React bundle | `npm run build --prefix ui` (clean, 315ms) | **PASS** |
| **1.6** | Installer Build | Fresh 117MB NSIS installer | `cargo tauri build --bundles nsis` | **PASS** |
| **1.7** | Updater Signature | Minisign Ed25519 signature valid | `cargo test --test updater_cryptography_tests` (5/5 PASS) | **PASS** |
| **1.8** | Edge Non-Regression | Live CDP browser testing | `node scripts/verify_gate18_3f2_edge_regression.js` (12/12 PASS) | **PASS** |
| **1.9** | Firefox Integration | Automated cross-browser tests | `node scripts/verify_firefox_integration.js` (14/14 PASS) | **PASS** |
| **1.10** | Firefox GUI & Download | Live Marionette bitstream test | `node scripts/verify_gate18_3f1_live_firefox.js` (20/20 PASS) | **PASS** |
| **1.11** | Mozilla Linter | Zero errors in Firefox MV3 package | `npx web-ext lint --source-dir extension/firefox` (0 errors) | **PASS** |
| **1.12** | Release Safety | Zero tokens, debug databases, stray PDBs | `node scripts/audit_release_safety.js` (8/8 PASS) | **PASS** |
| **1.13** | License Attributions | MIT, Third-Party (FFmpeg GPLv3, yt-dlp) | Staged in `release/v1.0.1-firefox-final-candidate/` | **PASS** |
| **1.14** | Package Integrity | All SHA256 checksums match | Verified against `SHA256SUMS.txt` | **PASS** |

---

## 2. Separate PC Physical QA Checklist

Execute on an authorized separate Windows 10/11 machine using `scripts/verify_separate_pc_installation.ps1`:

- [ ] **Step 1:** Copy `release/v1.0.1-firefox-final-candidate/TORI Download Manager_1.0.1_x64-setup.exe` to test PC.
- [ ] **Step 2:** Execute installer and complete wizard.
- [ ] **Step 3:** Run `.\verify_separate_pc_installation.ps1` to test:
  - [ ] Desktop launches & engine listens on 127.0.0.1:6800 (`INST-01`)
  - [ ] `HKCU\Software\Mozilla\NativeMessagingHosts\com.tori.download_manager` exists (`INST-02`)
  - [ ] Manifest resolves to real JSON file (`INST-03`)
  - [ ] Manifest points to real `tdm-native-host.exe` (`INST-04`)
  - [ ] `allowed_extensions` contains `tori-download-manager@toridm.org` (`INST-05`)
  - [ ] Native host responds to stdio ping (`INST-06`)
  - [ ] Native host pairing handshake returns token (`INST-07`)
  - [ ] Media download completes via installed engine (`INST-08`)
  - [ ] Edge and Chrome registry keys exist (`INST-09`)
- [ ] **Step 4:** Uninstall TORI from Windows Apps & Features.
- [ ] **Step 5:** Run `.\verify_separate_pc_installation.ps1 -PostUninstall` to verify:
  - [ ] Registry keys removed cleanly
  - [ ] Host manifests removed
  - [ ] User SQLite database preserved (`INST-10`)

---

## 3. Store Submission & Signing Procedure (Awaiting User Decision)

### 3.1 Mozilla Add-ons (AMO) Signing
- **Target ZIP:** `release/v1.0.1-firefox-final-candidate/tori-download-manager-firefox-v1.0.1.zip`
- **Method A (CLI via `web-ext`):**
  ```bash
  npx web-ext sign \
    --source-dir extension/firefox \
    --api-key="$AMO_JWT_ISSUER" \
    --api-secret="$AMO_JWT_SECRET" \
    --channel=unlisted \
    --artifacts-dir=release/v1.0.1-firefox-signed/
  ```
- **Method B (Web Portal):**
  1. Navigate to [addons.mozilla.org/developers/addon/submit/distribution](https://addons.mozilla.org/developers/addon/submit/distribution).
  2. Select "On your own" (Unlisted / Self-distribution).
  3. Upload the candidate ZIP.
  4. Download the signed `.xpi` once review finishes.

### 3.2 Microsoft Edge Add-ons Submission
- **Target ZIP:** `release/v1.0.1-firefox-final-candidate/tori-download-manager-extension-v1.0.1.zip`
- **Portal:** [partner.microsoft.com/dashboard/microsoftedge](https://partner.microsoft.com/dashboard/microsoftedge)
- Upload package, fill store listing, submit for automated certification.

### 3.3 Chrome Web Store Submission
- **Target ZIP:** `release/v1.0.1-firefox-final-candidate/tori-download-manager-extension-v1.0.1.zip`
- **Portal:** [chrome.google.com/webstore/devconsole](https://chrome.google.com/webstore/devconsole)
- Upload package, update store listing, submit for review.

### 3.4 Windows Authenticode Code Signing (EV Certificate)
- Before public distribution to general Windows users, sign:
  - `TORI Download Manager_1.0.1_x64-setup.exe`
  - `tori-download-manager.exe`
  using an Extended Validation (EV) certificate via Azure Trusted Signing or Hardware Token (`signtool.exe sign /tr http://timestamp.digicert.com /td sha256 /fd sha256 ...`).
