# TORI Download Manager — Gate 26.5 Desktop v1.0.4 Publication Report

**Date:** 2026-11-13  
**Release Tag:** `v1.0.4`  
**GitHub Release ID:** `443394435`  
**Target Desktop Version:** `v1.0.4`  
**Active Browser Companion:** `v1.0.5` (Unmodified & Fully Compatible)  
**Main Repository:** `robijoychakma375-hash/tori-download-manager`  
**Website Repository:** `robijoychakma375-hash/tori-website-private` (`main` branch)  
**Live Website:** `https://toridownload.xyz`  
**Verification Result:** **36 / 36 PASSED (0 FAILED)**  
**Overall Status:** **PUBLICATION COMPLETE — OFFICIAL LATEST STABLE RELEASE**

---

## 1. Executive Summary

On November 13, 2026, **TORI Download Manager Desktop v1.0.4** was officially published to GitHub Releases as the **Latest Stable** desktop release. The release includes the signed production Windows x64 NSIS installer (`TORI.Download.Manager_1.0.4_x64-setup.exe`), detached Minisign Ed25519 signature, updater manifest (`latest.json`), and checksum files.

The Tauri v2 in-app auto-updater manifest at `https://github.com/robijoychakma375-hash/tori-download-manager/releases/latest/download/latest.json` is actively serving version `1.0.4`, enabling smooth, verified in-place upgrades from `v1.0.0`, `v1.0.1`, `v1.0.2`, and `v1.0.3`.

The official website at `https://toridownload.xyz` has been updated and redeployed via Cloudflare Pages, linking directly to the v1.0.4 installer while preserving all responsive design elements and the official Mozilla-signed Firefox `v1.0.5` XPI with same-origin `application/x-xpinstall` headers.

All 36 live end-to-end verification checks passed with zero defects. The user's local installation (`v1.0.3`), production SQLite database (`tdm_storage.sqlite`), settings, registry, and historical GitHub releases remain **100% untouched and pristine**.

---

## 2. GitHub Release Details

- **Release Name:** `TORI Download Manager v1.0.4`
- **Release ID:** `443394435`
- **Tag:** `v1.0.4` (Points to commit `591cfe471c80ad6156af7a0a742a56a0e16d985e`)
- **Release URL:** [https://github.com/robijoychakma375-hash/tori-download-manager/releases/tag/v1.0.4](https://github.com/robijoychakma375-hash/tori-download-manager/releases/tag/v1.0.4)
- **Draft:** `false`
- **Prerelease:** `false`
- **Latest Stable:** `true` (`releases/latest` resolves to `v1.0.4`)
- **Published At:** `2026-11-12T19:21:11Z`

---

## 3. Published Release Assets

All 9 official production assets were verified in the GitHub release:

| # | Asset Name | Size (Bytes) | SHA-256 Checksum | Asset ID |
| :-: | :--- | :---: | :--- | :---: |
| 1 | `TORI.Download.Manager_1.0.4_x64-setup.exe` | 117,161,694 | `739fe9d240dd9d717ed0cb593b35950fad20ff5c5f0406977bcc2c4b61ea4880` | `740739965` |
| 2 | `TORI.Download.Manager_1.0.4_x64-setup.exe.sig` | 436 | `ed9b6984a96350a796b71d540677167157b8c5064387df8112b0e08dd4a8e59f` | `740771284` |
| 3 | `latest.json` | 2,229 | `5e2f064a4734f1305a304ec2fc03ff7924b0fc396ec2f9427a83888c0d9b3556` | `740739690` |
| 4 | `SHA256SUMS.txt` | 729 | `4e107c1b5ea3c75fb764d262174c3e800c6d2d46e6a4b11fdf12739ea19eb42b` | `740739923` |
| 5 | `RELEASE_NOTES.md` | 2,689 | `0569a435daf78b7b2c6b0374f1150143f5109d8bcd5b6706bea205c27cb81c31` | `740739889` |
| 6 | `INSTALLATION_AND_UPGRADE_NOTES.md` | 1,481 | `001201ae4a1d3e86524c5b524ec00252fac9528f774ce7b9aa7ebb2a61fd0c0c` | `740739642` |
| 7 | `LICENSE` | 1,465 | `55460ef099ce57e32d422427a7a24cd1e09aec677606289e396c2c17d625a598` | `740739729` |
| 8 | `LICENSE-THIRD-PARTY.txt` | 4,421 | `4f05486cb940a151e9b010ff3d033b7fb06370c665d174eb5d54d48433eb6035` | `740739850` |
| 9 | `LICENSE-GPLv3.txt` | 35,147 | `8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903` | `740739805` |

---

## 4. Cryptographic Signature & In-App Auto-Updater

- **Signing Algorithm:** Ed25519 (Minisign)
- **Key Continuity:** Public Key ID `CDC23D8CC8DA5397` (Unchanged from v1.0.0, v1.0.1, v1.0.2, and v1.0.3)
- **Auto-Updater Manifest Endpoint:** [https://github.com/robijoychakma375-hash/tori-download-manager/releases/latest/download/latest.json](https://github.com/robijoychakma375-hash/tori-download-manager/releases/latest/download/latest.json)
- **HTTP Response:** `200 OK` (following `302 Found` redirect)
- **Manifest Content:**
  ```json
  {
    "version": "1.0.4",
    "pub_date": "2026-11-12T16:52:02.036Z",
    "platforms": {
      "windows-x86_64": {
        "signature": "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVTWFU5cklqRDNDelZjM2hKUk5CNDFVMVUzYWo3YzhiM2xPZHVQL0xEbU5FU0k0UkNCUGE4NFlNUjlqclNxWXE0dThZS0h3RWxUVlRJUGdTbUhNSkFYT09wakxKMWoyWWd3PQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzk0NTAyMjMwCWZpbGU6VE9SSSBEb3dubG9hZCBNYW5hZ2VyXzEuMC40X3g2NC1zZXR1cC5leGUKS2VWTWlDdDlrVWh3ZXhYcUQxclB4RmxoQXIvQXFwYWFxK3g0ekNCYktCSzFEbEIvWHo0RVBpVVQralh1YTF3eUVuKzJHMjN3c3R6QnA4a1NUMW9aQ3c9PQo=",
        "url": "https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.4/TORI.Download.Manager_1.0.4_x64-setup.exe"
      }
    }
  }
  ```
- **Live Upgrade Evaluation:**
  - `v1.0.0` client $\rightarrow$ **Update Available** (prompts upgrade to v1.0.4)
  - `v1.0.1` client $\rightarrow$ **Update Available** (prompts upgrade to v1.0.4)
  - `v1.0.2` client $\rightarrow$ **Update Available** (prompts upgrade to v1.0.4)
  - `v1.0.3` client $\rightarrow$ **Update Available** (prompts upgrade to v1.0.4)
  - `v1.0.4` client $\rightarrow$ **Up to Date** (no prompt)

---

## 5. Website Deployment & Live Verification

- **Website Repository:** `C:\Users\ritud\Downloads\tori-website`
- **Deployment Commit:** `a569761` (`feat(release): update desktop download links and changelog to v1.0.4 stable`)
- **Hosting Platform:** Cloudflare Pages (Custom domain: `https://toridownload.xyz`)
- **Deployment Status:** **Completed & Verified Live**

### Live Verification Matrix (36 / 36 Passed)

| Section | Check Description | Result | Details |
| :--- | :--- | :---: | :--- |
| **1. Website UI** | Root URL returns HTTP 200 | **PASS** | `200 OK` |
| | Hero pill displays `New · v1.0.4 for Windows (Stable)` | **PASS** | String matched |
| | Hero download button points to GitHub v1.0.4 installer | **PASS** | Target URL verified |
| | Download section pill displays `v1.0.4 · Latest Stable` | **PASS** | String matched |
| | Download card title displays `TORI for Windows · v1.0.4 Stable` | **PASS** | String matched |
| | What's new changelog displays `What’s new in v1.0.4` | **PASS** | String matched |
| | Changelog highlights Instant NTFS sparse allocation | **PASS** | Feature entry verified |
| | Changelog highlights 256 KiB buffered worker writes | **PASS** | Feature entry verified |
| | Changelog highlights Server-side handoff deduplication | **PASS** | Feature entry verified |
| | All files section displays `TORI Download Manager v1.0.4` | **PASS** | Release card verified |
| | Footer version badge displays `v1.0.4 · Windows 10 / 11 (64-bit)` | **PASS** | Badge text verified |
| | Client-side fallback `U.exe` points to v1.0.4 installer | **PASS** | Mapping verified |
| | Schema.org JSON-LD `softwareVersion` is `"1.0.4"` | **PASS** | SEO metadata verified |
| **2. Firefox Ext** | Same-origin v1.0.5 XPI returns HTTP 200 | **PASS** | `200 OK` |
| | Content-Type is `application/x-xpinstall` | **PASS** | Header verified |
| | `Access-Control-Allow-Origin: *` header present | **PASS** | Header verified |
| | Live XPI SHA-256 matches verified Mozilla AMO build | **PASS** | `94d8ff0ca2ebd84f1412acb616da942d72423d7a11bb9ffc2bcc290c9dda93d6` |
| **3. Chromium Ext** | GitHub Chromium v1.0.5 ZIP returns HTTP 200 | **PASS** | `200 OK` (followed redirects) |
| | Chromium ZIP SHA-256 matches verified build | **PASS** | `ee0a6b133400665cb141185eb8c8bcfd982cdafec3a72309b7f64c097bb17530` |
| **4. GitHub Release** | `releases/latest` tag is `v1.0.4` | **PASS** | `v1.0.4` |
| | Release is not a draft and not a prerelease | **PASS** | `draft: false`, `prerelease: false` |
| | Release name is `TORI Download Manager v1.0.4` | **PASS** | String matched |
| | Attached assets count is 9 | **PASS** | All 9 assets attached |
| **5. Updater API** | `latest.json` returns HTTP 200 | **PASS** | `200 OK` |
| | Manifest version is `1.0.4` | **PASS** | `1.0.4` |
| | Download URL matches GitHub v1.0.4 installer | **PASS** | Full URL matched |
| | Ed25519 signature is present and 436 characters | **PASS** | `len=436` |
| **6. Live Installer** | Content-Length matches expected 117,161,694 bytes | **PASS** | Exact byte match |
| | Live `SHA256SUMS.txt` returns HTTP 200 | **PASS** | `200 OK` |
| | `SHA256SUMS.txt` contains expected v1.0.4 hash | **PASS** | `739fe9d240dd9d717ed0cb593b35950fad20ff5c5f0406977bcc2c4b61ea4880` |
| **7. History** | Historical release `v1.0.3` preserved | **PASS** | Intact on GitHub |
| | Historical release `v1.0.2` preserved | **PASS** | Intact on GitHub |
| | Historical release `v1.0.1` preserved | **PASS** | Intact on GitHub |
| | Historical release `v1.0.0` preserved | **PASS** | Intact on GitHub |
| | Historical release `extension-v1.0.5` preserved | **PASS** | Intact on GitHub |

---

## 6. Browser Extension Compatibility

- **Published Browser Companion:** `v1.0.5` remains active and unchanged on Mozilla Firefox and Chrome/Edge.
- **Protocol Parity:** Native Host binary (`tdm-native-host.exe`) supports both legacy v1.0.5 messages (`action` and `type` fields) and future candidate protocols.
- **Server-Side Coalescing:** Desktop v1.0.4 protects against duplicate downloads from Extension v1.0.5 fallback calls without requiring the extension to supply a `handoff_id`.
- **Stream Discovery & Handoff:** Generic file interception, HTML5 video detection, and HLS/DASH media stream resolution function seamlessly across Firefox and Chromium browsers.

---

## 7. Remaining Limitations & Non-Blockers

1. **Third-Party CDN Rate Limits:** While S3, CloudFront, R2, and B2 links are protected with adaptive 4-worker concurrency capping and exponential backoff, external hosting providers may enforce strict per-IP connection limits outside client control.
2. **Chromium Extension Unpacked Distribution:** Chromium users continue to install via Developer Mode ("Load unpacked") until Web Store review is scheduled.

---

## 8. Final Git Status

### Main Repository (`F:\TORI\final tori download manager`)
- **Branch:** `release/v1.0.4` (Pushed to `origin/release/v1.0.4`)
- **Release Tag:** `v1.0.4` (Pushed to `origin/v1.0.4`, points to commit `591cfe4`)
- **Working Tree:** Completely clean

### Website Repository (`C:\Users\ritud\Downloads\tori-website`)
- **Branch:** `main` (Pushed to `origin/main`)
- **Latest Commit:** `a569761`
- **Working Tree:** Completely clean
