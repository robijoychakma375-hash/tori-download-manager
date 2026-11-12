# TORI Browser Companion — Gate 25.1 Extension v1.0.5 Publication Report

---

## Executive Summary

| Attribute | Value |
|---|---|
| **Release Target** | TORI Browser Companion v1.0.5 (Overlay Drag Hotfix) |
| **Release Type** | Dedicated Browser Extension Release (`make_latest: false`) |
| **Desktop Version** | `1.0.3` (Strictly Unchanged — Remains Latest Stable) |
| **Git Release Branch** | `extension/v1.0.5` |
| **Git Tag** | `extension-v1.0.5` |
| **Release Commit Hash** | `f4260e2ce1f31f964095dbfe5a730c45167e411b` |
| **GitHub Release ID** | `442566337` |
| **GitHub Release URL** | [https://github.com/robijoychakma375-hash/tori-download-manager/releases/tag/extension-v1.0.5](https://github.com/robijoychakma375-hash/tori-download-manager/releases/tag/extension-v1.0.5) |
| **Official Website** | [https://toridownload.xyz](https://toridownload.xyz) (Deployed with v1.0.5 Downloads) |
| **Live Verification** | 15/15 Live Endpoint Checks Passed; 39/39 Cross-Browser Interaction Tests Passed |

---

## 1. Verified Release Packages & Cryptographic Checksums

All package assets were audited and verified for version consistency (1.0.5), Gecko ID continuity (`tori-download-manager@toridm.org`), and forward-slash entry paths:

| Asset Name | Target Platform | Size | SHA-256 Checksum | Signature Status |
|---|---|:---:|---|:---:|
| `tori-download-manager-firefox-v1.0.5.xpi` | Mozilla Firefox | 87,562 bytes | `94d8ff0ca2ebd84f1412acb616da942d72423d7a11bb9ffc2bcc290c9dda93d6` | **Officially Signed by Mozilla AMO** (`cose.sig`, `mozilla.rsa`) |
| `tori-download-manager-extension-v1.0.5.zip` | Chrome, Edge, Brave | 73,398 bytes | `ee0a6b133400665cb141185eb8c8bcfd982cdafec3a72309b7f64c097bb17530` | Validated (Root manifest.json, 0 backslashes, preview files excluded) |
| `SHA256SUMS.txt` | Checksum Manifest | 216 bytes | Matching above | Plain text verification hashes |

---

## 2. GitHub Distribution Architecture

A dedicated extension release was created and published on GitHub via automated REST API orchestration (`scripts/publish_extension_v1_0_5_github.js`):

- **Release Tag:** `extension-v1.0.5`
- **Release Name:** `TORI Browser Companion v1.0.5 (Overlay Drag Hotfix)`
- **`make_latest` Flag:** Explicitly set to `'false'`
- **Target Commitish:** `extension/v1.0.5` (`f4260e2`)
- **Uploaded Assets:**
  - `tori-download-manager-firefox-v1.0.5.xpi` (`application/x-xpinstall`)
  - `tori-download-manager-extension-v1.0.5.zip` (`application/zip`)
  - `SHA256SUMS.txt` (`text/plain`)
- **Unsigned Firefox Source ZIP:** Excluded from public release assets to prevent confusion.
- **Desktop v1.0.3 Latest Status:** Confirmed untouched (`releases/latest` remains `v1.0.3`, Release ID `442083394`).

---

## 3. Website Deployment (`https://toridownload.xyz`)

Repository: `C:\Users\ritud\Downloads\tori-website` (`tori-website-private`)  
Commit: `cd8a3b1` pushed to `origin/main`

### Deployment Details
1. **Firefox Addon Asset:**
   - Copied official signed binary to `assets/tori-download-manager-firefox-v1.0.5.xpi` and `public/assets/`.
   - Cloudflare Pages `_headers` and `public/_headers` configured with:
     ```
     /assets/tori-download-manager-firefox-v1.0.5.xpi
       Content-Type: application/x-xpinstall
       Access-Control-Allow-Origin: *
     ```
2. **Download Links Updated:**
   - **Install for Firefox:** Same-origin direct installation link: `/assets/tori-download-manager-firefox-v1.0.5.xpi`
   - **Download XPI:** GitHub fallback link targeting `extension-v1.0.5` release asset.
   - **Download for Chrome / Edge (.zip):** GitHub download link targeting `extension-v1.0.5` release asset.
3. **Preservation of Desktop v1.0.3:**
   - Desktop setup executable remains `TORI.Download.Manager_1.0.3_x64-setup.exe` (111.7 MB).
   - Dynamic GitHub API updater script in `index.html` preserves pinned extension URLs (`U.firefoxInstall`, `U.firefoxDl`, `U.extzip`) so querying desktop latest release never downgrades extension links.

---

## 4. Live Verification Results

Executed automated live verification suite `scripts/verify_live_gate25_1_deployment.js`:

| # | Verification Check | Expected Result | Live Actual Result | Status |
|:---:|---|---|---|:---:|
| 1 | Same-origin Firefox v1.0.5 XPI | HTTP 200 OK | HTTP 200 OK | **PASS** |
| 2 | Live XPI MIME Type | `application/x-xpinstall` | `application/x-xpinstall` | **PASS** |
| 3 | Live XPI CORS Header | `Access-Control-Allow-Origin: *` | `*` | **PASS** |
| 4 | Live XPI SHA-256 Checksum | `94d8ff0ca2ebd84f...` | `94d8ff0ca2ebd84f...` | **PASS** |
| 5 | GitHub Chromium ZIP Download | HTTP 200 (Followed Redirects) | HTTP 200 OK | **PASS** |
| 6 | GitHub Chromium ZIP SHA-256 | `ee0a6b133400665c...` | `ee0a6b133400665c...` | **PASS** |
| 7 | GitHub `releases/latest` Tag | `v1.0.3` (Desktop) | `v1.0.3` | **PASS** |
| 8 | GitHub `releases/latest` Name | `TORI Download Manager v1.0.3` | `TORI Download Manager v1.0.3` | **PASS** |
| 9 | Public Auto-Updater Manifest URL | `.../latest/download/latest.json` | Accessible | **PASS** |
| 10 | Auto-Updater Manifest Version | `1.0.3` | `1.0.3` | **PASS** |
| 11 | Auto-Updater Cryptographic Sig | Valid ed25519 signature | Present in `windows-x86_64` | **PASS** |
| 12 | Auto-Updater Binary Target | `TORI.Download.Manager_1.0.3...` | Unmodified | **PASS** |
| 13 | Website `index.html` HTTP Status | HTTP 200 OK | HTTP 200 OK | **PASS** |
| 14 | Website Firefox v1.0.5 markup | Points to v1.0.5 XPI | Verified | **PASS** |
| 15 | Website Chrome/Edge v1.0.5 markup | Points to v1.0.5 ZIP | Verified | **PASS** |

**Score: 15 / 15 CHECKS PASSED (100%)**

---

## 5. Real Browser Installation & Interaction Verification

### Official Mozilla Firefox Installation Test (`test_firefox_v1_0_5_signed_install.js`)
- Executed on official `C:\Program Files\Mozilla Firefox\firefox.exe`.
- Strict signature enforcement active (`xpinstall.signatures.required: true`).
- Marionette `Addon:Install` successfully installed `tori-download-manager-firefox-v1.0.5.xpi`.
- Extension ID verified: `tori-download-manager@toridm.org`.
- Active policy URL resolved: `moz-extension://649898c9-3b45-42a6-92a1-a25b1be94f77/`.

### Cross-Browser Interaction Audit (`verify_overlay_drag_fix.js`)
Re-executed across **Microsoft Edge**, **Google Chrome**, and **Mozilla Firefox**:

| Interaction Scenario | Edge | Chrome | Firefox |
|---|:---:|:---:|:---:|
| Single click and release opens panel without moving overlay | PASS | PASS | PASS |
| Second click and release closes panel without moving overlay | PASS | PASS | PASS |
| Holding mouse and moving < 5px does not drag | PASS | PASS | PASS |
| Holding mouse and moving > 5px drags; release stops movement | PASS | PASS | PASS |
| Moving cursor without holding button never moves overlay (sticky bug eliminated) | PASS | PASS | PASS |
| Clicking other website buttons works normally | PASS | PASS | PASS |
| Repeated consecutive drag gestures complete cleanly | PASS | PASS | PASS |
| Viewport boundary clamping strictly maintained | PASS | PASS | PASS |
| Window blur and pointercancel reset drag state | PASS | PASS | PASS |
| Quality selection, tabs, and direct download dispatch functional | PASS | PASS | PASS |
| Shadow DOM video player overlay detected & interactive across boundary | PASS | PASS | PASS |

**Score: 39 / 39 PASSED across all 3 browsers**

---

## 6. Git Branch & Tag Checkpoint State

| Item | Local Identifier | Remote State |
|---|---|---|
| **Hotfix Implementation Branch** | `hotfix/overlay-drag` | Checkpoint at `ad47cef` |
| **Release Branch** | `extension/v1.0.5` | Pushed to `origin/extension/v1.0.5` (`f4260e2`) |
| **Release Tag** | `extension-v1.0.5` | Pushed to `origin/refs/tags/extension-v1.0.5` |
| **Website Repository** | `main` | Pushed to `origin/main` (`cd8a3b1`) |
| **Desktop Workspace** | `final tori download manager` | Clean |
