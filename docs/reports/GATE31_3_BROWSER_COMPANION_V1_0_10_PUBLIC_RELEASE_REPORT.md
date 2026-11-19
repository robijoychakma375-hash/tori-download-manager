# TORI Download Manager — Gate 31.3 Public Stable Release Report
## TORI Browser Companion v1.0.10 Public Release & Production Website Deployment

- **Date:** 2026-11-19
- **Overall Release Status:** **`SUCCESS`**
- **Desktop Version:** `v1.0.5` (Unchanged — Baseline Frozen)
- **Browser Companion Version:** `v1.0.10` (Public Release)
- **Target Browsers:** Google Chrome, Microsoft Edge, Mozilla Firefox (Mozilla AMO Signed)
- **Known Owner-Accepted Limitations (Preserved):** Windows Authenticode PE signing remains absent (`NotSigned`); independent clean Windows VM testing pending operator execution. Both remain accurately documented.

---

## 1. Executive Summary

Following explicit operator authorization, **Gate 31.3 (Extension-Only Public Release)** was executed cleanly with zero desktop regressions, zero auto-updater disruptions, and 100% verified public artifact integrity.

### Release Accomplishments:
1. **Dedicated Extension-Only GitHub Release:** Published release `extension-v1.0.10` on `robijoychakma375-hash/tori-download-manager` with all 5 approved release assets.
2. **Desktop Auto-Updater Strictly Preserved:** Enforced `make_latest: "false"` on GitHub release creation. Verified that `/releases/latest` remains Desktop `v1.0.5` (ID: 449053824) and `https://github.com/robijoychakma375-hash/tori-download-manager/releases/latest/download/latest.json` resolves to Desktop `1.0.5` with untouched Ed25519 signatures.
3. **Official Website Deployed (`https://toridownload.xyz/`):**
   - Deployed updated website to Cloudflare Pages (Deployment ID: `9d7f211c-66f0-434c-b7d4-52ad327910c4`, Commit `e71450e`).
   - Desktop displayed as `v1.0.5`; Browser Companion updated to `v1.0.10`.
   - Hosted Mozilla-signed XPI at `/assets/tori-download-manager-firefox-v1.0.10.xpi` with verified `Content-Type: application/x-xpinstall` and byte-identical hash.
   - Updated SHA-256 verification instructions, sitemap, and download links.
4. **Live HTTPS Post-Release Verification:**
   - Downloaded live XPI and ZIP packages over HTTPS from both GitHub and the production website.
   - SHA-256 hashes matched the approved release candidates bit-for-bit.
   - Verified permanent installation in real Mozilla Firefox under strict signature enforcement (`xpinstall.signatures.required = true`, `signedState = 2`, `temporarilyInstalled = false`).
5. **Zero Desktop Binary Modifications:** Desktop v1.0.5 binaries, updater metadata, and installer packages were not recompiled or altered in any way.

---

## 2. Release Identification & Git Provenance

| Repository | Component | Tag / Ref | Commit Hash | Release Status |
| :--- | :--- | :--- | :--- | :--- |
| `robijoychakma375-hash/tori-download-manager` | Extension v1.0.10 | `extension-v1.0.10` | `dd188f1` | **PUBLISHED (STABLE)** |
| `robijoychakma375-hash/tori-download-manager` | Desktop v1.0.5 | `v1.0.5` | `91f883a` | **LATEST STABLE (UNCHANGED)** |
| `robijoychakma375-hash/tori-website-private` | Production Website | `main` | `e71450e` | **DEPLOYED (PRODUCTION)** |

---

## 3. GitHub Release Details

- **Release Name:** `TORI Browser Companion v1.0.10`
- **Release ID:** `451270856`
- **Tag:** `extension-v1.0.10`
- **Public URL:** `https://github.com/robijoychakma375-hash/tori-download-manager/releases/tag/extension-v1.0.10`
- **Repository Latest (`releases/latest`):** `false` (Explicitly preserved as Desktop v1.0.5)
- **Draft / Prerelease:** `false` / `false`
- **Target Commit:** `dd188f132b55d25cced3b65ad4d9799525071e0c`

### Published Assets & Cryptographic Checksums

| Asset Name | Asset ID | Size (Bytes) | Verified SHA-256 Checksum | Content-Type |
| :--- | :--- | ---:| :--- | :--- |
| `tori-companion-v1.0.10-firefox-signed.xpi` | `767481528` | 107,499 | `a93a43872d224426902c49e217e31b2c603263d8c260c429940539b34b2852b8` | `application/x-xpinstall` |
| `tori-companion-v1.0.10-chromium.zip` | `767481606` | 90,964 | `f220fab2e26fd54ef7f85fd7e40613faad79e7f9a7f44fadf228ccd0edcc22f1` | `application/zip` |
| `SHA256SUMS.txt` | `767481646` | 311 | `fe3314589d97bf73c090da57f00f074d618d36354fb3dfd77054f7fba6b13d2a` | `text/plain` |
| `RELEASE_NOTES.md` | `767481752` | 4,520 | `e0b3c6628b030ee77b4ba3c6902f5a6007ec14212711d94ff889d701048e7188` | `text/markdown` |
| `INSTALLATION_AND_UPGRADE.md` | `767481796` | 3,156 | `33bcfcae05cfc66a4f938a4b65551ba86cfa6f8ef1a72481432f8df81cb4f9fa` | `text/markdown` |

---

## 4. Production Website Deployment Details

- **Official Website URL:** `https://toridownload.xyz/`
- **Cloudflare Pages Deployment ID:** `9d7f211c-66f0-434c-b7d4-52ad327910c4`
- **Cloudflare Pages Deployment URL:** `https://9d7f211c.tori-download-manager.pages.dev`
- **Environment:** `Production` (Branch: `main`)
- **Website Source Commit:** `e71450e` (`robijoychakma375-hash/tori-website-private`)
- **Rollback Deployment ID:** `2d5c92f1-0774-4175-9edf-37853b09de31` (Commit `939bc97`)

### Live Website Changes:
1. **Hero & Download Sections:** Displays Desktop `v1.0.5` (112.3 MB) and Browser Companion `v1.0.10`.
2. **Same-Origin Firefox Extension:** Hosted at `/assets/tori-download-manager-firefox-v1.0.10.xpi` with verified `Content-Type: application/x-xpinstall` and `Access-Control-Allow-Origin: *`.
3. **Chrome & Edge Downloads:** Points directly to `https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/extension-v1.0.10/tori-companion-v1.0.10-chromium.zip`.
4. **Hashes & Changelog:** Updated in-page hash verification commands and What's New changelog cards.
5. **Sitemap:** `<lastmod>` updated to `2026-11-19`.

---

## 5. Desktop Auto-Updater Preservation Evidence

To ensure existing Desktop v1.0.3, v1.0.4, and v1.0.5 clients never encounter broken updater redirects:

- **Endpoint:** `https://github.com/robijoychakma375-hash/tori-download-manager/releases/latest/download/latest.json`
- **HTTP Status Check:** `302 Found` -> `200 OK`
- **Parsed Payload:**
  - `"version"`: `"1.0.5"`
  - `"platforms.windows-x86_64.url"`: `https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.5/TORI.Download.Manager_1.0.5_x64-setup.exe`
  - `"platforms.windows-x86_64.signature"`: Untouched Ed25519 signature for `v1.0.5`
- **GitHub Latest Release:** Confirmed `/repos/robijoychakma375-hash/tori-download-manager/releases/latest` remains `TORI Download Manager v1.0.5` (ID: `449053824`).

---

## 6. Post-Release Automated Verification Matrix

The post-release verification suite ([`verify_gate31_3_live_release.js`](file:///F:/TORI/final%20tori%20download%20manager/scripts/verify_gate31_3_live_release.js)) was executed against the live internet endpoints.

**Result: 23 / 23 TESTS PASSED (100.0%)**

| Test ID | Category | Target | Verified Behavior | Status |
| :--- | :--- | :--- | :--- | :---: |
| `GH-EXT-META` | GitHub API | `extension-v1.0.10` | Release exists, stable, draft=false, prerelease=false | **PASS** |
| `GH-EXT-ASSETS` | GitHub API | Assets Count | Exactly 5 approved release assets attached | **PASS** |
| `GH-EXT-XPI-ASSET`| GitHub API | Firefox XPI Asset | Size matches expected (107,499 bytes) | **PASS** |
| `GH-EXT-ZIP-ASSET`| GitHub API | Chromium ZIP Asset| Size matches expected (90,964 bytes) | **PASS** |
| `GH-EXT-SUMS-ASSET`| GitHub API | Checksums Asset | `SHA256SUMS.txt` present on release | **PASS** |
| `GH-LATEST-DESKTOP`| Repository | `/releases/latest` | Remains Desktop v1.0.5 (ID: 449053824) | **PASS** |
| `UPDATER-LATEST-JSON`| Auto-Updater| `latest.json` | Resolves to 1.0.5 with valid Ed25519 signature | **PASS** |
| `DL-GH-XPI-SHA` | Live Download| GitHub XPI | Downloaded 107,499 B, SHA-256 matches `a93a4387...` | **PASS** |
| `DL-GH-ZIP-SHA` | Live Download| GitHub ZIP | Downloaded 90,964 B, SHA-256 matches `f220fab2...` | **PASS** |
| `DL-GH-SUMS` | Live Download| GitHub Checksums | Both package hashes confirmed in `SHA256SUMS.txt` | **PASS** |
| `SITE-HOME-CONTENT`| Website | `toridownload.xyz/`| Desktop v1.0.5 + Companion v1.0.10 rendered | **PASS** |
| `SITE-XPI-HEADERS` | Website | Headers | `Content-Type: application/x-xpinstall` verified | **PASS** |
| `SITE-XPI-SHA` | Website | Website XPI | Downloaded 107,499 B, SHA-256 matches `a93a4387...` | **PASS** |
| `SITE-SITEMAP` | Website | `sitemap.xml` | Lastmod updated to `2026-11-19` | **PASS** |
| `FF-LIVE-INSTALL` | Real Firefox | AMO Signature | `Addon:Install` permanently installs live XPI | **PASS** |
| `FF-LIVE-SIG-STATE`| Real Firefox| Enforcement | Accepted with `signedState: 2` under signature enforcement | **PASS** |
| `FF-LIVE-PERMANENT`| Real Firefox| Lifecycle | `temporarilyInstalled: false`, `isActive: true` | **PASS** |
| `FF-LIVE-VER` | Real Firefox | Extension ID | ID `tori-download-manager@toridm.org`, version `1.0.10` | **PASS** |
| `CHR-LIVE-UNPACK` | Chromium | Extraction | Cleanly extracted 35 files from live ZIP | **PASS** |
| `CHR-LIVE-MANIFEST`| Chromium | Manifest V3 | Valid Manifest V3, version `1.0.10` confirmed | **PASS** |
| `DESKTOP-EXE-FROZEN`| Integrity | `tori-download-manager.exe` | Byte-for-byte identical to approved baseline | **PASS** |
| `INSTALLER-EXE-FROZEN`| Integrity| `setup.exe` | Byte-for-byte identical to approved baseline | **PASS** |
| `NATIVE-HOST-FROZEN`| Integrity | `tdm-native-host.exe` | Byte-for-byte identical to approved baseline | **PASS** |

### Regression Suites Summary (Gate 31.1 & Gate 31.2 Cumulative)
- `scripts/verify_gate31_1_instagram_overlay.js`: **57/57 PASSED (100.0%)**
- `scripts/verify_overlay_drag_fix.js`: **39/39 PASSED (100.0%)**
- `scripts/verify_gate31_2_signed_firefox.js`: **63/63 PASSED (100.0%)**
- `scripts/verify_gate31_3_live_release.js`: **23/23 PASSED (100.0%)**
- **Cumulative Test Results:** **182 / 182 PASSED (100.0%)**

---

## 7. Rollback & Contingency Information

In the event of an unforeseen issue:
1. **Cloudflare Pages Rollback:** Rollback deployment `2d5c92f1-0774-4175-9edf-37853b09de31` (Commit `939bc97`) is retained in Cloudflare Pages and can be reactivated in 1 click via dashboard or CLI.
2. **GitHub Release Rollback:** Release `451270856` (`extension-v1.0.10`) can be toggled to `draft: true` via GitHub API or web interface without affecting Desktop v1.0.5.
3. **Desktop Updater Immunity:** Desktop updater endpoints are completely isolated from extension releases and remain on `v1.0.5`.

---

## 8. Final Release Sign-Off

- **Final Classification:** **`SUCCESS`**
- **Published Extension Version:** `1.0.10`
- **Preserved Desktop Version:** `1.0.5`
- **Live Distribution Endpoints:**
  - Web: `https://toridownload.xyz/`
  - GitHub: `https://github.com/robijoychakma375-hash/tori-download-manager/releases/tag/extension-v1.0.10`
  - Same-Origin XPI: `https://toridownload.xyz/assets/tori-download-manager-firefox-v1.0.10.xpi`
- **Recommended Next Gate:** Gate 32 (Authenticode Code Signing Strategy & Automated Release CI/CD).
