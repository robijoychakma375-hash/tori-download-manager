# TORI Download Manager — Gate 27.3.1: Firefox v1.0.6 Mozilla ZIP Packaging Fix Report

**Date:** 2026-11-13  
**Project Root:** `F:\TORI\final tori download manager`  
**Git Branch:** `fix/gate27-runtime-fixes`  
**Base Commit (Gate 27.3):** `a460656`  
**Target Package:** Firefox Extension v1.0.6 Candidate (`tori-companion-v1.0.6-firefox.zip`)  
**Status:** **PASSED — MOZILLA-COMPATIBLE ARCHIVE VERIFIED (READY FOR AMO SUBMISSION)**

---

## 1. Executive Summary

During submission of `tori-companion-v1.0.6-firefox.zip` to the Mozilla Add-on Developer Hub (AMO), the package was rejected during initial archive ingestion with the error:
> `Validation error: Invalid file name in archive: icons\icon-128.png`

Investigation confirmed that the ZIP archive was generated via PowerShell's `Compress-Archive` cmdlet, which emitted Windows-style backslashes (`\`) into the local file headers and central directory records. While Windows file extractors normalize backslashes, the ZIP specification (PKWARE APPNOTE.TXT) and Mozilla Add-on Developer Hub strictly mandate standard POSIX path separators (`/`). Mozilla interpreted the backslash character as an illegal literal in the filename.

Under **Gate 27.3.1**:
1. The root cause was isolated and confirmed via programmatic inspection of the ZIP central directory.
2. The Firefox packaging pipeline in `scripts/package_v1_0_6_extensions.js` was permanently updated to utilize Mozilla's official `web-ext build` engine.
3. Extraneous demo/preview mockups (`preview.html`) were removed from the Firefox distribution and excluded from asset syncing.
4. An automated 10-point archive validation script (`scripts/verify_firefox_zip.js`) was authored and executed: **10 / 10 PASS**.
5. `web-ext lint` executed on `extension/firefox`: **0 errors, 0 notices**.
6. Staging metadata in `release/v1.0.5-rc/extensions/SHA256SUMS.txt` was updated with the new archive checksum.
7. The Desktop v1.0.5 release candidate and Chromium v1.0.6 extension package were 100% preserved and untouched.

---

## 2. Root Cause Analysis

### Rejected Archive Characteristics (Pre-Fix)
Programmatic analysis of the original `release/v1.0.5-rc/extensions/tori-companion-v1.0.6-firefox.zip` revealed:
- **Packaging Engine:** PowerShell `Compress-Archive -Path '.../extension/firefox/*' ...`
- **Central Directory Records:**
  ```text
  icons\icon-128.png
  icons\icon-16.png
  icons\preview.html
  icons\chips\all-downloads.svg
  options\options.html
  popup\popup.html
  ```
- **Failure Mechanism:** PowerShell's `Compress-Archive` does not normalize file path separators to POSIX `/` when compressing directories on Windows. Mozilla AMO's ingestion parser rejects filenames containing the literal `\` character as invalid path traversal tokens.

---

## 3. Packaging Pipeline Remediation

### 3.1 Script Modifications (`scripts/package_v1_0_6_extensions.js`)
1. **Mozilla `web-ext build` Integration:**
   Replaced PowerShell `Compress-Archive` with:
   ```javascript
   execSync(
     `npx --no-install web-ext build --source-dir extension/firefox --artifacts-dir "${tempFfStaging}" --filename tori-companion-v1.0.6-firefox.zip --overwrite-dest`,
     { cwd: PROJECT_ROOT, stdio: 'inherit' }
   );
   ```
2. **Selective Build Flag:**
   Added `--firefox-only` CLI parameter to rebuild only the Firefox candidate while guaranteeing the verified Chromium candidate (`tori-companion-v1.0.6-chromium.zip`) remains bit-for-bit preserved.
3. **Asset Sync Filtering:**
   Enhanced `copyRecursive` to exclude non-production mockups (`preview.html`) and transient temporary files (`*.tmp`, `*.zip`) when syncing shared UI components from `extension/` to `extension/firefox/`.
4. **Source Cleanup:**
   Removed `extension/firefox/icons/preview.html` from the Firefox extension source tree.

---

## 4. Corrected Release Candidate Artifacts

| Asset | File Size | SHA-256 Checksum | Status |
| :--- | :--- | :--- | :--- |
| **`tori-companion-v1.0.6-firefox.zip`** | **74,319 bytes** | `75d8759410054087bf87f7fd203f1f2aa290971b7357830cffef6bd28f3725df` | **REBUILT (MOZILLA-COMPATIBLE)** |
| `tori-companion-v1.0.6-chromium.zip` | 74,702 bytes | `da47e6b11550a8cb0f92209cb39a0bcfcc61f899219fa3a6d9e2eaa51bcce0ec` | Unchanged (Preserved) |
| `TORI Download Manager_1.0.5_x64-setup.exe` | 117,568,384 bytes | `609d74ad8999893de70e835efb28ec6c45a38550c1114ef3e51a8a98164b8256` | Unchanged (Preserved) |
| `TORI Download Manager_1.0.5_x64-setup.exe.sig` | 436 bytes | `9a1a9a38e6beba4b2dd194572e80d4f8c3a94988d38cf86c04d523e9077caab2` | Unchanged (Preserved) |

Staging Directory: `F:\TORI\final tori download manager\release\v1.0.5-rc\extensions\`  
Checksum Record: `release/v1.0.5-rc/extensions/SHA256SUMS.txt`

---

## 5. Automated Archive Verification (10-Point Suite)

Executed via `scripts/verify_firefox_zip.js`:

| # | Check Description | Requirement | Result |
| :---: | :--- | :--- | :---: |
| **1** | Backslash presence | Zero backslashes (`\`) in any entry | **PASS** |
| **2** | Directory separator standard | 100% POSIX forward slashes (`/`) | **PASS** |
| **3** | Manifest location | `manifest.json` located directly at ZIP root | **PASS** |
| **4** | Parent encapsulation | No nested parent directory (`extension/` or `firefox/`) | **PASS** |
| **5** | Absolute path check | Zero absolute paths or drive letters | **PASS** |
| **6** | Path traversal check | Zero `../` traversal tokens | **PASS** |
| **7** | Manifest reference integrity | All declared icons, scripts, and pages exist | **PASS** |
| **8** | Extraneous mockups | Zero demo or `preview.html` files present | **PASS** |
| **9** | Manifest version | `version === "1.0.6"` | **PASS** |
| **10** | Extension ID preservation | `gecko.id === "tori-download-manager@toridm.org"` | **PASS** |

### Complete Archive Central Directory (40 Entries)
```text
[01] icons/
[02] options/
[03] popup/
[04] icons/chips/
[05] icons/settings-tabs/
[06] icons/toolbar/
[07] background.js
[08] content.js
[09] content.css
[10] manifest.json
[11] icons/icon-16.png
[12] icons/icon-32.png
[13] icons/icon-128.png
[14] icons/icon-48.png
[15] options/options.css
[16] options/options.html
[17] options/options.js
[18] popup/popup.css
[19] popup/popup.html
[20] popup/popup.js
[21] icons/chips/compressed.svg
[22] icons/chips/all-downloads.svg
[23] icons/chips/finished.svg
[24] icons/chips/other.svg
[25] icons/chips/programs.svg
[26] icons/chips/music.svg
[27] icons/chips/documents.svg
[28] icons/chips/video.svg
[29] icons/settings-tabs/about.svg
[30] icons/chips/unfinished.svg
[31] icons/settings-tabs/browser-integration.svg
[32] icons/settings-tabs/appearance.svg
[33] icons/settings-tabs/download-engine.svg
[34] icons/toolbar/add-url.svg
[35] icons/toolbar/pause.svg
[36] icons/toolbar/delete.svg
[37] icons/toolbar/settings.svg
[38] icons/toolbar/resume.svg
[39] icons/toolbar/stop-all.svg
[40] icons/toolbar/start-queue.svg
```

---

## 6. Mozilla Lint Validation

Executed via `npx web-ext lint --source-dir extension/firefox`:
- **Errors:** **0**
- **Notices:** **0**
- **Warnings:** 16 (Standard DOM `innerHTML` dynamic assignments in UI options/popup and fallback manifest warnings; zero blocking errors)
- **Verdict:** **PASSED**

---

## 7. Confirmation of Source & Logic Integrity

- **Extension ID:** `tori-download-manager@toridm.org` (Preserved)
- **Manifest Version:** `1.0.6` (Preserved)
- **Manifest Architecture:** Manifest V3 (Preserved)
- **Popup Design & Video Overlay:** Unchanged
- **Native Messaging Engine:** Unchanged
- **Close-to-Tray Integration:** Unchanged
- **Audio / Video Sequence Download Logic:** Unchanged
- **Playlist Download & YouTube Mix Rejection:** Unchanged
- **Desktop Binaries & Signatures:** Unchanged
- **Release Status:** Unsigned Release Candidate (Ready for manual AMO upload)
