# TORI Download Manager — Gate 21.1: Final v1.0.2 GitHub Publication & Website Deployment Report

**Release Version:** v1.0.2 (Latest Stable)  
**Target Platform:** Windows 10 / 11 (x64)  
**Release Tag:** `v1.0.2`  
**Release ID:** `441473140`  
**Source Commit:** `c6ed19423ef4a777a4870fab09ba11f4269eb2d8` (on branch `release/v1.0.2`)  
**Production Build Commit:** `b2397fb8cbaba152bf857560bf1db91468dedcfd` (0 application code diff to `c6ed194`)  
**Published Release URL:** `https://github.com/robijoychakma375-hash/tori-download-manager/releases/tag/v1.0.2`  
**Official Website:** `https://toridownload.xyz/`  
**Website Deployment Commit:** `7b53d7e` (on `origin/main` in `tori-website-private`)  
**Date:** 2026-11-11  

---

## Executive Summary

Gate 21.1 achieved the official public promotion and live production deployment of **TORI Download Manager v1.0.2** as the new primary **Latest Stable Release**.

All steps were executed strictly respecting immutable production constraints:
1. **Critical Preflight (56/56 PASS):** Verified repository branch, commit provenance, local staged files, Ed25519 updater cryptography, draft release asset readiness (10/10), and complete immutability of the historical v1.0.1 tag (`48d083d`) and release (`440552231`).
2. **GitHub Release Publication:** Converted draft release ID `441473140` into Latest Stable (`draft: false`, `prerelease: false`, `make_latest: true`) associated with tag `v1.0.2` anchored to commit `c6ed194`. Confirmed `/releases/latest` resolves to `v1.0.2`.
3. **Official Website Update & Licensing Audit:** Updated `https://toridownload.xyz` in `C:\Users\ritud\Downloads\tori-website\index.html`. Removed all pre-release/candidate wording. Promoted v1.0.2 installer and companion extensions to primary download actions. Corrected licensing statements across JSON-LD schema, FAQ, and footer links to properly reflect GPLv3 binary distribution obligations due to bundled FFmpeg media tools alongside MIT/Apache-2.0 source code.
4. **Cloudflare Pages Production Deployment:** Committed changes (`7b53d7e`) and pushed to `origin/main` on `tori-website-private`. Live production edge nodes verified immediately with HTTP 200 OK and zero stale cache.
5. **Live Bitstream & Checksum Verification:** Downloaded release assets directly from GitHub CDN and verified byte counts and SHA-256 cryptographic parity bit-for-bit against staged release files.

---

## 1. Verified Release Distribution Assets (`v1.0.2`)

All 10 distribution assets are publicly hosted on GitHub Release `441473140`:

| Asset File Name | Size (Bytes) | SHA-256 Checksum | Asset ID | State |
| :--- | :--- | :--- | :--- | :--- |
| `TORI.Download.Manager_1.0.2_x64-setup.exe` | 117,073,652 | `1ab7f3454dc08ef3b33843a9b8dfc3d3b2c5b2814fbe8946ef9b263f2d2452c2` | `734961645` | `uploaded` |
| `TORI.Download.Manager_1.0.2_x64-setup.exe.sig` | 436 | `936d40e044901e16e1e2caff0040fe24342f054949ecccd3198696070e4fad5c` | `734997404` | `uploaded` |
| `tori-download-manager-firefox-v1.0.2.xpi` | 86,743 | `520424ff38ddb1bf84152e7fd3c9bf4678ce6af1542995a6d4b58c4dc4fbb8d0` | `734997441` | `uploaded` |
| `tori-download-manager-extension-v1.0.2.zip` | 71,971 | `788bbb16f38356109a8ea529809e9acc708f0c97dbfac939dca68cdc0bd11805` | `734997488` | `uploaded` |
| `tori-download-manager-firefox-v1.0.2.zip` | 72,284 | `a4bcce6f041df4529979deb8f54f84342362732aa456c0390f1b85baf367b848` | `734997532` | `uploaded` |
| `SHA256SUMS.txt` | 888 | `51df38b2ba7fb4ab31da1b0780ec62c27ab0cab2f73cc47ae6f73187e2b2c0c2` | `734959804` | `uploaded` |
| `RELEASE_NOTES.md` | 1,934 | `162134ff455c9efe3af90c7089886b6ae4c7a1905eb151340423eb97f94c1445` | `734997557` | `uploaded` |
| `LICENSE-GPLv3.txt` | 35,147 | `8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903` | `734997634` | `uploaded` |
| `LICENSE-THIRD-PARTY.txt` | 4,421 | `4f05486cb940a151e9b010ff3d033b7fb06370c665d174eb5d54d48433eb6035` | `734997711` | `uploaded` |
| `RELEASE_MANIFEST.json` | 3,927 | `ddf60dc0eef6259e17cec30d6eb52d9785b3dd5e6b3d76a61acf5fb4a135da3d` | `734997755` | `uploaded` |

---

## 2. Commit Provenance & Source Traceability

- **Build Commit (`b2397fb`):** `chore(release): prepare v1.0.2 production release metadata and scripts`. Synchronized version metadata across `Cargo.toml`, `src-tauri/tauri.conf.json`, and `ui/package.json`. The NSIS installer was built directly from this tree.
- **Release Documentation Commit (`c6ed194`):** `chore(gate21): finalize v1.0.2 draft release scripts and release report`. Added `GATE21_V1_0_2_RELEASE_REPORT.md` and auxiliary scripts.
- **Source Invariance:** `git diff b2397fb..c6ed194` confirms **0 diffs** across all application source code, UI code, sidecar manifests, and build configuration. Tag `v1.0.2` encapsulates both the verified build tree and its associated release report.

---

## 3. Cloudflare Pages Production Verification (`toridownload.xyz`)

Live HTTP verification against `https://toridownload.xyz/` confirmed:
1. **HTTP Status:** 200 OK with valid TLS certificate and Cloudflare edge delivery.
2. **Hero Badge:** Displays `"New · v1.0.2 for Windows (Stable)"`.
3. **Card 1 Label:** Displays `"Version 1.0.2 · Stable · Installer"`.
4. **Primary Downloads:** All buttons directly target the published v1.0.2 installer at `https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.2/TORI.Download.Manager_1.0.2_x64-setup.exe`.
5. **Browser Extensions:**
   - Firefox Add-on: Directly links to official Mozilla-signed `tori-download-manager-firefox-v1.0.2.xpi`.
   - Chromium / Edge: Links to unpacked distribution `tori-download-manager-extension-v1.0.2.zip`.
6. **Integrity Link:** Points directly to v1.0.2 `SHA256SUMS.txt`.
7. **Schema.org Structured Data:** Valid JSON-LD with `"softwareVersion": "1.0.2"` and updated download URLs.
8. **Footer Version:** Updated to `"v1.0.2 · Windows 10 / 11 (64-bit)"`.
9. **Licensing Accuracy:** Accurately states GNU General Public License v3 (GPLv3) compliance due to bundled FFmpeg media tools, with MIT/Apache-2.0 source code availability.

---

## 4. Historical Release Accessibility & Immutability

- **Stable Tag `v1.0.1`:** Strictly preserved at commit `48d083d1b42b9c7edf76202abde599e6beb87b2e`.
- **Release `v1.0.1` Endpoint:** Publicly accessible at `https://github.com/robijoychakma375-hash/tori-download-manager/releases/tag/v1.0.1` with all 10 assets intact.
- **Release `v1.0.0` Endpoint:** Publicly accessible at `https://github.com/robijoychakma375-hash/tori-download-manager/releases/tag/v1.0.0`.
- **Release Archive on Website:** Both v1.0.1 and v1.0.0 are preserved in the historical releases section.

---

## 5. Auto-Updater & Workstation Safety Isolation

- **`latest.json` Safeguard:** `latest.json` is strictly absent on the v1.0.2 release (returns HTTP 404). In-app auto-update notifications remain isolated until physical PC acceptance is approved.
- **v1.0.0 Feed Isolation:** The v1.0.0 auto-updater feed remains untouched and pinned to version 1.0.0.
- **Workstation Integrity:** Zero installer execution or registry modifications occurred on the development workstation.
- **Physical Acceptance Testing:** Remains **NOT TESTED** on separate physical PC hardware.

---

## 6. Verification Test Summary

```
Gate 21.1 Verification Results:
  - Step 1: Critical Preflight Suite .................... 56 / 56 PASS (100%)
  - Step 2: GitHub API Latest Stable Verification ........  4 /  4 PASS (100%)
  - Step 3: Cloudflare Pages Live Endpoint Suite ......... 11 / 11 PASS (100%)
  - Step 4: Live Bitstream CDN Parity Suite ..............  4 /  4 PASS (100%)
  - Step 5: Auto-Updater Isolation Suite .................  2 /  2 PASS (100%)
Total Gate 21.1 Verification: 77 / 77 PASSED (100.0%)
```

