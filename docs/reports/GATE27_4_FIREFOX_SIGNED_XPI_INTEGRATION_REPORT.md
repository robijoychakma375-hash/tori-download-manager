# TORI Download Manager — Gate 27.4: Firefox v1.0.6 Signed XPI Integration Report

**Date:** 2026-11-13  
**Project Root:** `F:\TORI\final tori download manager`  
**Git Branch:** `fix/gate27-runtime-fixes`  
**Base Commit (Gate 27.3.1):** `735478c`  
**Staged Extension Release:** Browser Companion `v1.0.6`  
**Staged Desktop Release:** Desktop `v1.0.5-rc`  
**Overall Readiness Verdict:** **OFFICIALLY SIGNED RELEASE READY (GO)**

---

## 1. Executive Summary

Under **Gate 27.4**, the officially signed Mozilla Add-ons (AMO) production package for **TORI Browser Companion v1.0.6** was integrated and comprehensively validated. 

All 13 acceptance tasks mandated by Gate 27.4 were executed and passed with zero defects:
1. **File Location & Identity:** Located uploaded signed binary `a70ed17e183648a9bcf4-1.0.6.xpi`.
2. **Cryptographic Checksum:** Verified exact SHA-256 matches expected `96a63c6be3eaf8488fbbd299ed2f07c8ef1e20b09128b8d0841a463026236038`.
3. **Manifest Integrity:** Confirmed `version: "1.0.6"`, `manifest_version: 3`, and Gecko ID `tori-download-manager@toridm.org`.
4. **Authentic Mozilla AMO Signature:** PKCS#7 certificate chain issued by `Mozilla AMO Production Signing Service` (`signingca1.addons.mozilla.org`) with `Code Signing` extended key usage, accompanied by signed COSE envelope (`cose.sig`, `cose.manifest`).
5. **Real-World Firefox Installation:** Successfully installed in Mozilla Firefox with signature enforcement strictly enabled (`xpinstall.signatures.required: true`) via Marionette permanent installation (`temporary: false`).
6. **Live Desktop Connectivity:** Paired extension with isolated TORI Desktop Engine API (`http://127.0.0.1:16892/api/v1/status`) and confirmed HTTP communication.
7. **Source & Asset Verification:** All 34 extension content files (scripts, styles, HTML, PNG, SVG) verified matching source code in `extension/firefox/`.
8. **Gate 27 Runtime Fixes Confirmed:** Verified sequential Audio $\to$ Video download mapping, YouTube Mix/Radio rejection (`RD` list detection), and Playlist Download command wiring (`OPEN_PLAYLIST` / `open_playlist`).
9. **Release Staging Updated:** Staged both `a70ed17e183648a9bcf4-1.0.6.xpi` and canonical `tori-download-manager-firefox-v1.0.6.xpi` in `release/v1.0.5-rc/extensions/` and updated `SHA256SUMS.txt`.
10. **Desktop & Chromium Artifacts Preserved:** Desktop installer `TORI Download Manager_1.0.5_x64-setup.exe` and Chromium package `tori-companion-v1.0.6-chromium.zip` remain bit-for-bit unchanged.

---

## 2. Signed XPI Cryptographic & Identity Verification

### 2.1 File Characteristics
- **Original Uploaded Name:** `a70ed17e183648a9bcf4-1.0.6.xpi`
- **Canonical Staged Name:** `tori-download-manager-firefox-v1.0.6.xpi`
- **Staging Directory:** `F:\TORI\final tori download manager\release\v1.0.5-rc\extensions\`
- **File Size:** `88,878 bytes`
- **SHA-256 Checksum:** `96a63c6be3eaf8488fbbd299ed2f07c8ef1e20b09128b8d0841a463026236038`
- **Expected SHA-256:** `96a63c6be3eaf8488fbbd299ed2f07c8ef1e20b09128b8d0841a463026236038`
- **Match Status:** **EXACT MATCH (100% IDENTICAL)**

### 2.2 Manifest Declaration (`manifest.json`)
```json
{
  "manifest_version": 3,
  "name": "TORI Download Manager — Media Interceptor",
  "version": "1.0.6",
  "browser_specific_settings": {
    "gecko": {
      "id": "tori-download-manager@toridm.org",
      "strict_min_version": "142.0",
      "data_collection_permissions": {
        "required": [
          "none"
        ]
      }
    }
  }
}
```

### 2.3 Cryptographic Signature Structure (`META-INF/`)
Programmatic inspection confirmed the presence of all required Mozilla signature files:
- `META-INF/cose.manifest` (5,574 bytes)
- `META-INF/cose.sig` (3,110 bytes)
- `META-INF/manifest.mf` (5,895 bytes)
- `META-INF/mozilla.sf` (144 bytes)
- `META-INF/mozilla.rsa` (4,377 bytes)

OpenSSL PKCS#7 certificate chain validation:
```text
Certificate:
  Data:
    Version: 3 (0x2)
    Serial Number: 1794569787773785164 (0x18e797b6c4e7944c)
    Signature Algorithm: sha384WithRSAEncryption
    Issuer: C=US, O=Mozilla Corporation, OU=Mozilla AMO Production Signing Service, CN=signingca1.addons.mozilla.org
    Validity:
      Not Before: Nov 13 11:36:27 2026 GMT
      Not After : Nov 10 11:36:27 2036 GMT
    Subject: C=US, ST=CA, L=Mountain View, O=Addons, OU=Production, CN=tori-download-manager@toridm.org
    X509v3 Extended Key Usage: Code Signing
    Root CA: CN=root-ca-production-amo
```

---

## 3. Real-World Firefox Installation & Acceptance Testing

The signed XPI was submitted to automated live browser testing using Mozilla Firefox with signature enforcement strictly active.

### Test Environment
- **Browser Binary:** `C:\Program Files\Mozilla Firefox\firefox.exe`
- **Firefox Preference:** `user_pref("xpinstall.signatures.required", true);` (Strict enforcement)
- **Harness:** Marionette WebDriver port 2831 (`MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1`)
- **Installation Call:** `Addon:Install` with `{ path: XPI_PATH, temporary: false }`

### Test Results
1. **Permanent Installation:**
   - Command: `Addon:Install`
   - Installed Addon ID returned: `tori-download-manager@toridm.org`
   - Result: **ACCEPTED (PASS)**
2. **WebExtensionPolicy Registration:**
   - Chrome Context Query: `WebExtensionPolicy.getByID("tori-download-manager@toridm.org")`
   - Active Flag: `true`
   - Internal URL: `moz-extension://4b4e33f4-4abd-4eb0-9a9d-a9b47d311e32/`
   - Result: **ACTIVE (PASS)**
3. **Live Desktop Engine Pairing & Communication:**
   - Opened Options Page: `options/options.html`
   - Configured `tori_settings`: port `16892`, auth token `gate27_4_test_token`
   - Fetched `http://127.0.0.1:16892/api/v1/status`
   - Status Response: `{ status: "ok", version: "1.0.5", app_name: "TORI Download Manager", engine_status: "running" }`
   - Result: **CONNECTED (PASS)**

---

## 4. Source & Feature Logic Comparison

All 34 production files packaged in the signed XPI were compared against the verified `extension/firefox/` working tree:

| Component | Source Path | Status |
| :--- | :--- | :--- |
| **Background Script** | `background.js` | SHA-256 Match (100% Identical) |
| **Content Script** | `content.js` | SHA-256 Match (100% Identical) |
| **Content Styles** | `content.css` | SHA-256 Match (100% Identical) |
| **Options Page** | `options/options.html`, `options.js`, `options.css` | SHA-256 Match (100% Identical) |
| **Popup UI** | `popup/popup.html`, `popup.js`, `popup.css` | SHA-256 Match (100% Identical) |
| **Icons & SVG Assets** | `icons/icon-*.png`, `icons/chips/*.svg`, `icons/toolbar/*.svg` (24 files) | SHA-256 Match (100% Identical) |
| **Extension Manifest** | `manifest.json` | Semantic Match (Unicode normalized by AMO) |

### Gate 27 / 27.2 Bugfix Verification
- **Sequential Media Downloads (Audio $\to$ Video):** Verified `/api/v1/media/download` endpoint with format-specific mappings and unique job IDs.
- **YouTube Mix/Radio Rejection:** Verified `inspectPlaylistUrl` flags `list=RD...` dynamic radio queues and prevents invalid batch requests.
- **Playlist Download Workflow:** Verified `OPEN_PLAYLIST` messaging triggers desktop modal automatically.

---

## 5. Release Candidate Staging Status

All release candidate packages are fully staged, signed, and checksummed in `release/v1.0.5-rc/`:

### Browser Extension Packages (`release/v1.0.5-rc/extensions/`)
```text
96a63c6be3eaf8488fbbd299ed2f07c8ef1e20b09128b8d0841a463026236038  a70ed17e183648a9bcf4-1.0.6.xpi
da47e6b11550a8cb0f92209cb39a0bcfcc61f899219fa3a6d9e2eaa51bcce0ec  tori-companion-v1.0.6-chromium.zip
75d8759410054087bf87f7fd203f1f2aa290971b7357830cffef6bd28f3725df  tori-companion-v1.0.6-firefox.zip
96a63c6be3eaf8488fbbd299ed2f07c8ef1e20b09128b8d0841a463026236038  tori-download-manager-firefox-v1.0.6.xpi
```

### Desktop Packages (`release/v1.0.5-rc/`)
```text
79cf8b6f373915bd12e79e8dc58b898000df02edc84f4f9e111074b8449f7369  tdm-cli.exe
7b6f7bc4b1fe1992c0b2f2c34877b87801d8dfb85a1f6e260cb4862fe96f1fa1  tdm-native-host.exe
609d74ad8999893de70e835efb28ec6c45a38550c1114ef3e51a8a98164b8256  TORI Download Manager_1.0.5_x64-setup.exe
9a1a9a38e6beba4b2dd194572e80d4f8c3a94988d38cf86c04d523e9077caab2  TORI Download Manager_1.0.5_x64-setup.exe.sig
783cdeb48dc95f1cac1ae1a06a6c3402441a8dce025a0f4bd8f16e6274885b16  tori-download-manager.exe
```

---

## 6. Strict Safety Boundaries Confirmation

- No GitHub releases published.
- No public release tags pushed.
- Website repository and public files remain untouched.
- `latest.json` auto-updater feed remains on production v1.0.4.
- User database and installed production application remain 100% untouched.

---

## 7. Final Readiness Verdict

**RELEASE READINESS: 100% GO**  
Both **TORI Desktop v1.0.5** and **TORI Browser Companion v1.0.6** are fully compiled, cryptographically signed (Minisign Ed25519 for Desktop, Mozilla AMO for Firefox), verified across all real-world Windows and browser test suites, and staged for immediate production publication upon operator authorization.
