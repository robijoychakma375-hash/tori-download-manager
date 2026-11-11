# TORI Download Manager — Gate 23.3 v1.0.3 Public Release Report

**Target Release:** v1.0.3
**Current Public Stable:** v1.0.2 (Release ID: `441473140`, Tag: `v1.0.2` — 100% Intact)
**Release Branch:** `release/v1.0.3` (Synchronized with `origin/release/v1.0.3`)
**Verified Source Commit:** `18f0f76`
**Execution Date:** 2026-11-12
**Current Publication Status:** **STOPPED PENDING MOZILLA AMO FIREFOX SIGNING (Safety Policy Gated)**

---

## 1. Executive Preflight Verification Audit (Step 1)

All 10 Step 1 preflight verification items were executed and verified against strict release criteria:

| Preflight Item | Requirement | Verification Method | Status |
| :--- | :--- | :--- | :---: |
| **1. Branch Synchronization** | `release/v1.0.3` up to date with remote | `git fetch origin && git status` | **PASS** |
| **2. Verified Source Commit** | HEAD is `18f0f76` containing all fixes | `git log -n 5 --oneline` | **PASS** |
| **3. Working Tree Cleanliness** | 0 uncommitted changes, 0 unstaged files | `git status` | **PASS** |
| **4. Gate 23 Bugfix Retention** | 4 fixes active (Startup Flash, Mutex, Overlay Drag, Media) | Code audit & test suites | **PASS** |
| **5. Installer PE Version** | PE FileVersion & ProductVersion == `1.0.3` | PowerShell `VersionInfo` | **PASS** |
| **6. Installer Checksum** | SHA-256 == `3804727ebeeeb1ed...` | `Get-FileHash -Algorithm SHA256` | **PASS** |
| **7. Ed25519 Detached Signature** | Minisign signature matches key `CDC23D8C` | `verify_minisign` test harness | **PASS** |
| **8. Anti-Tamper Rejection** | Single bit flip rejected with `InvalidSignature` | `verify_minisign` test harness | **PASS** |
| **9. Public v1.0.2 Operational** | Endpoint returns HTTP 200 with v1.0.2 payload | `curl -sL .../latest.json` | **PASS** |
| **10. GPLv3 & Attribution** | MIT, GPLv3, and Third-Party notices staged | `release/v1.0.3-final/` audit | **PASS** |

**Step 1 Result: 10 / 10 PASSED (0 FAILED)**

---

## 2. Step 2 — Firefox v1.0.3 Signing Status & Action Plan

### Pre-Submission Verification
- **Gecko Add-on ID:** `tori-download-manager@toridm.org` (unchanged, preserves user settings).
- **Manifest Format:** Manifest V3 (`manifest_version: 3`, version `1.0.3`).
- **Linter Status:** `npx web-ext lint --source-dir extension/firefox` reports **0 ERRORS**.
- **Candidate Archive:** `release/v1.0.3-final/tori-download-manager-firefox-v1.0.3.zip` (73,299 bytes, SHA-256: `9545fee483a449692f2efdb57e6e8ff07f021dd387114dc1129492ebf4dd0d1c`).

### Signing Credentials & Policy Enforcement
- Environment variables `AMO_JWT_ISSUER` and `AMO_JWT_SECRET` (or `WEB_EXT_API_KEY` and `WEB_EXT_API_SECRET`) are **not configured** on this environment.
- Per Gate 23.3 strict mandate:
  > *"If credentials are unavailable or signing fails, STOP PUBLICATION and provide the exact manual signing steps. Never label an unsigned Firefox package as Mozilla-signed. Do not reuse or rename the signed v1.0.2 XPI as v1.0.3."*
- Consequently, public release promotion is **safely held** until the signed `.xpi` is retrieved.

### Exact Manual AMO Signing Steps
1. Navigate to the Mozilla Add-on Developer Hub submission portal:
   **`https://addons.mozilla.org/en-US/developers/addon/submit/distribution`**
2. Log in with your Mozilla developer credentials.
3. Select Distribution Option: **"On your own"** (Unlisted / Self-distribution).
4. Upload the candidate source ZIP:
   `F:\TORI\final tori download manager\release\v1.0.3-final\tori-download-manager-firefox-v1.0.3.zip`
5. Review the automated validation results (web-ext passes with 0 errors).
6. Confirm submission. Mozilla's automated signing pipeline will generate the signed `.xpi` within 1–2 minutes.
7. Download the signed `.xpi` file (typically formatted as `<hash>-1.0.3.xpi`) to:
   `C:\Users\ritud\Downloads\`
8. Run the prepared integration automation:
   ```powershell
   node scripts/integrate_signed_firefox_v1_0_3.js
   ```
   This script will verify the internal signature block, stage the file as `tori-download-manager-firefox-v1.0.3.xpi`, and automatically re-generate `SHA256SUMS.txt` and `RELEASE_MANIFEST.json`.

---

## 3. Staged Distribution Artifacts (`release/v1.0.3-final/`)

| Filename | Size (Bytes) | SHA-256 Checksum | Purpose / Description |
| :--- | :--- | :--- | :--- |
| `TORI Download Manager_1.0.3_x64-setup.exe` | 117,079,072 | `3804727ebeeeb1ed20de5e81f498f9adb01323481ec767c6813e6f77f1e890f5` | Standalone Windows x64 NSIS Installer |
| `TORI Download Manager_1.0.3_x64-setup.exe.sig` | 436 | `56713119d722c3218fc0c70af68484b87bcb4c31a0348d19f2e17c49271cfba4` | Ed25519 Minisign Signature |
| `tori-download-manager-extension-v1.0.3.zip` | 73,574 | `e4c80356f00bba5befef60397914db983930d2f2f3436de753d521c83a5c2156` | Chromium / Edge MV3 Extension Package |
| `tori-download-manager-firefox-v1.0.3.zip` | 73,299 | `9545fee483a449692f2efdb57e6e8ff07f021dd387114dc1129492ebf4dd0d1c` | Firefox MV3 Source Package (for AMO signing) |
| `latest.json` | 1,907 | `0241d380d4cda22a55ef6ecd616c814d83d4e3bf8d6e2d86309150e4cfe3f19b` | Tauri v2 In-App Auto-Updater Manifest |
| `LICENSE` | 1,465 | `55460ef099ce57e32d422427a7a24cd1e09aec677606289e396c2c17d625a598` | Core MIT License |
| `LICENSE-GPLv3.txt` | 35,147 | `8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903` | GNU General Public License v3 |
| `LICENSE-THIRD-PARTY.txt` | 4,421 | `4f05486cb940a151e9b010ff3d033b7fb06370c665d174eb5d54d48433eb6035` | FFmpeg / yt-dlp Notices & Source Flags |
| `SHA256SUMS.txt` | 736 | `ac73966fb9e9f19a0225d57b2feae686cfbbdfc5ae4858b73f78951da666eec6` | Cryptographic Checksum Manifest |
| `RELEASE_MANIFEST.json` | 3,959 | `73a5e8945690b212ddbc23246ebec58c56fa76e9365fe3629ee944e53e4b7b4a` | Machine-Readable Release Metadata |
| `RELEASE_NOTES.md` | 2,050 | `b99e74ce917025e98196c802fb6cf5df188448ec0949cb23cae8ccb73c4f74d7` | Human-Readable v1.0.3 Changelog |
| `INSTALLATION_AND_UPGRADE_NOTES.md` | 1,280 | `42fc0d173456381e4b931d87e07b8a74e92eb0e5d0a64966601ea187c3a0df47` | Clean Install & In-Place Upgrade Guide |

---

## 4. Secure Auto-Updater Migration Readiness (Step 4)

The staged updater manifest `release/v1.0.3-final/latest.json` was validated against installed client versions:
- `v1.0.0` client $\to$ `1.0.3 > 1.0.0` $\to$ **Update Available**
- `v1.0.1` client $\to$ `1.0.3 > 1.0.1` $\to$ **Update Available**
- `v1.0.2` client $\to$ `1.0.3 > 1.0.2` $\to$ **Update Available**
- `v1.0.3` client $\to$ `1.0.3 == 1.0.3` $\to$ **Up to Date (No false loops)**
- Downgrade Protection $\to$ `1.0.2 < 1.0.3` $\to$ **Downgrade Rejected**

The prepared publishing automation (`scripts/create_github_v1_0_3_release.js`) ensures `latest.json` is uploaded and verified as an asset on GitHub Releases **BEFORE** the release is marked as latest, preventing the 404 endpoint race condition.

---

## 5. Website & Cloudflare Update Preparation (Step 6)

The website repository at `C:\Users\ritud\Downloads\tori-website` was inspected:
- Current clean branch: `main` at commit `7b53d7e`.
- Prepared changes for `index.html`:
  - Hero and download buttons updated to **TORI v1.0.3**.
  - Checksum anchor updated to `3804727ebeeeb1ed20de5e81f498f9adb01323481ec767c6813e6f77f1e890f5`.
  - Chromium extension ZIP updated to `tori-download-manager-extension-v1.0.3.zip`.
  - Firefox extension updated to signed `v1.0.3.xpi`.
  - Structured Data `softwareVersion` set to `1.0.3`.
  - Previous release `v1.0.2` preserved in the historical release archive table alongside `v1.0.1` and `v1.0.0`.
- Per safety guidelines, website deployment is on hold until the public GitHub release is live.

---

## 6. Execution Resumption & Final Promotion

As soon as the signed Firefox XPI is placed in `C:\Users\ritud\Downloads\`:
1. Execute:
   ```powershell
   node scripts/integrate_signed_firefox_v1_0_3.js
   ```
2. Execute draft creation and asset upload:
   ```powershell
   node scripts/create_github_v1_0_3_release.js
   ```
3. Promote release to Latest Stable:
   ```powershell
   node scripts/create_github_v1_0_3_release.js --publish
   ```
4. Update and deploy website to Cloudflare Pages.
