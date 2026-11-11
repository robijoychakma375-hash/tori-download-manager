# TORI Download Manager — Gate 21 Production Release Report

**Release Candidate:** v1.0.2  
**Target Architecture:** Windows 10 / 11 (x64)  
**Git Branch:** `release/v1.0.2`  
**Head Commit:** `b2397fbb3072a2db9c6f2df3299cae708df8a73a`  
**GitHub Draft Release ID:** `441473140`  
**Date:** 2026-11-11  

---

## Executive Summary

Gate 21 successfully prepared **TORI Download Manager v1.0.2** as a unified production release candidate, establishing strict version parity across the desktop application (`1.0.2`) and companion browser extensions (`1.0.2`). 

All 5 core phases of Gate 21 were executed strictly respecting production isolation constraints:
1. **Phase 1 — Version Synchronization:** Synchronized desktop version metadata across `Cargo.toml`, `src-tauri/tauri.conf.json`, and `ui/package.json` to `1.0.2`, aligning with existing companion browser extensions (`1.0.2`).
2. **Phase 2 — Production Build:** Compiled React UI production bundle, companion binaries (`tdm-native-host.exe`, `tdm-cli.exe`), and packaged the Windows x64 NSIS production installer (`TORI Download Manager_1.0.2_x64-setup.exe`, 111.6 MB). Generated Ed25519 updater signature (`.sig`). Staged 10 distribution artifacts into `release/v1.0.2-final/`.
3. **Phase 3 — Safe Automated Validation:** Executed 93 automated tests across Rust native host, core download engine, queue recovery, adaptive chunking, HLS/DASH remuxing, updater cryptography, extension manifests, and safety constraints with **100% PASS (93/93)**.
4. **Phase 4 — GitHub Draft Release:** Created a private GitHub Draft Release (ID `441473140`, `draft: true`, `prerelease: false`) tied to commit `b2397fb` on branch `release/v1.0.2`. Staged all distribution assets to the draft release. Release is **NOT** published.
5. **Phase 5 — Website Preparation:** Updated `C:\Users\ritud\Downloads\tori-website\index.html` with v1.0.2 primary installer links, hero pill, release details card, checksum references, and JSON-LD schema, while preserving v1.0.1 in the release archive. Cloudflare Pages deployment is **ON HOLD** awaiting operator approval.

---

## 1. Version Synchronization & Baseline Audit

| Manifest / Component | File Path | Previous Version | Target Version | Status |
| :--- | :--- | :--- | :--- | :--- |
| **Cargo Workspace Root** | `Cargo.toml` | `1.0.1` | `1.0.2` | ✓ Synced |
| **Tauri Application Config** | `src-tauri/tauri.conf.json` | `1.0.1` | `1.0.2` | ✓ Synced |
| **Desktop React UI** | `ui/package.json` | `1.0.1` | `1.0.2` | ✓ Synced |
| **Chromium Extension** | `extension/manifest.json` | `1.0.2` | `1.0.2` | ✓ In Parity |
| **Firefox Extension** | `extension-firefox/manifest.json` | `1.0.2` | `1.0.2` | ✓ In Parity |
| **Version Verifier Script** | `scripts/verify_baseline_versions.js` | — | — | **4/4 PASS** |

---

## 2. Production Build & Distribution Artifacts

The production Windows installer was built using Tauri NSIS bundling (`cargo tauri build --bundles nsis`). Ed25519 signature was generated using the private updater key at `~/.tori-keys/tori-updater.key`.

### Staged Release Artifacts (`release/v1.0.2-final/`)

| File Name | Size (Bytes) | SHA-256 Checksum | Purpose / Description |
| :--- | :--- | :--- | :--- |
| `TORI Download Manager_1.0.2_x64-setup.exe` | 117,073,652 | `1ab7f3454dc08ef3b33843a9b8dfc3d3b2c5b2814fbe8946ef9b263f2d2452c2` | Windows x64 NSIS standalone offline installer (PE version: 1.0.2) |
| `TORI Download Manager_1.0.2_x64-setup.exe.sig` | 436 | `936d40e044901e16e1e2caff0040fe24342f054949ecccd3198696070e4fad5c` | Ed25519 updater cryptographic signature |
| `tori-download-manager-firefox-v1.0.2.xpi` | 86,743 | `520424ff38ddb1bf84152e7fd3c9bf4678ce6af1542995a6d4b58c4dc4fbb8d0` | Official Mozilla-signed Firefox companion extension (AMO approved) |
| `tori-download-manager-extension-v1.0.2.zip` | 71,971 | `788bbb16f38356109a8ea529809e9acc708f0c97dbfac939dca68cdc0bd11805` | Chromium / Edge MV3 companion extension package |
| `tori-download-manager-firefox-v1.0.2.zip` | 72,284 | `a4bcce6f041df4529979deb8f54f84342362732aa456c0390f1b85baf367b848` | Firefox MV3 extension package (unpacked) |
| `SHA256SUMS.txt` | 888 | `51df38b2ba7fb4ab31da1b0780ec62c27ab0cab2f73cc47ae6f73187e2b2c0c2` | Official SHA-256 manifest for distribution verification |
| `RELEASE_NOTES.md` | 1,934 | `162134ff455c9efe3af90c7089886b6ae4c7a1905eb151340423eb97f94c1445` | Release notes & changelog for v1.0.2 |
| `LICENSE-GPLv3.txt` | 35,147 | `8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903` | GNU General Public License v3 |
| `LICENSE-THIRD-PARTY.txt` | 4,421 | `4f05486cb940a151e9b010ff3d033b7fb06370c665d174eb5d54d48433eb6035` | Bundled third-party dependency licenses (FFmpeg, yt-dlp) |
| `RELEASE_MANIFEST.json` | 3,927 | `ddf60dc0eef6259e17cec30d6eb52d9785b3dd5e6b3d76a61acf5fb4a135da3d` | Machine-readable release metadata & file hashes |

---

## 3. Automated Validation Battery Results

```
Suite 1: tdm-native-host (IPC Protocol, Headers, Port Forwarding)
  - tests/host_tests.rs ............................................. 3/3 PASS
  - tests/server_tests.rs ........................................... 4/4 PASS
  - tests/referer_tests.rs .......................................... 5/5 PASS
  - tests/user_agent_tests.rs ....................................... 4/4 PASS
  Subtotal: 16/16 PASS (100%)

Suite 2: tdm-core (Engine, Protocols, Recovery, Media, Updater)
  - tests/gate17_4_2_scheduler_tests.rs ............................. 6/6 PASS
  - tests/gate17_4_queue_recovery_tests.rs .......................... 9/9 PASS
  - tests/gate2_adaptive_tests.rs ................................... 8/8 PASS
  - tests/gate4_hls_tests.rs ........................................ 7/7 PASS
  - tests/gate5_dash_tests.rs ....................................... 7/7 PASS
  - tests/gate8_protocol_matrix_tests.rs ............................ 16/16 PASS
  - tests/updater_cryptography_tests.rs ............................. 5/5 PASS
  Subtotal: 58/58 PASS (100%)

Suite 3: Integrity, Extensions, Licensing & Safety Scripts
  - scripts/verify_baseline_versions.js ............................. 4/4 PASS
  - scripts/verify_zip_manifests.js ................................. 8/8 PASS
  - scripts/verify_signed_xpi.js .................................... 4/4 PASS
  - scripts/verify_safety_check.js .................................. 3/3 PASS
  Subtotal: 19/19 PASS (100%)

Total Battery: 93 / 93 PASSED (100.0%)
```

---

## 4. GitHub Release Candidate Status

- **Draft Release ID:** `441473140`
- **Release Tag:** `v1.0.2`
- **State:** **DRAFT** (`draft: true`, `prerelease: false`)
- **Public Visibility:** Hidden (invisible to public users and updater feeds)
- **Draft URL:** `https://github.com/robijoychakma375-hash/tori-download-manager/releases/tag/untagged-7e87b19a2874d1791836`
- **Target Commit:** `b2397fbb3072a2db9c6f2df3299cae708df8a73a` on `origin/release/v1.0.2`
- **Publication Gate:** **AWAITING APPROVAL** (No automatic publication performed).

---

## 5. Website Preparation Status (`toridownload.xyz`)

- **Repository Path:** `C:\Users\ritud\Downloads\tori-website`
- **Target File:** `index.html`
- **Modifications Prepared:**
  - Hero Pill: Updated to `"New · v1.0.2 for Windows (Stable Candidate)"`
  - Hero CTA & Main Download buttons: Updated to point to v1.0.2 installer URL
  - Card Version & Assets: Updated to v1.0.2 installer name and 111.6 MB size
  - Integrity Checksum: Updated to v1.0.2 `SHA256SUMS.txt`
  - Structured Data (Schema.org JSON-LD): `softwareVersion` set to `"1.0.2"`
  - Client-side Fallback Release Object: Updated to v1.0.2 metadata
  - Archive Preservation: Historical stable releases (v1.0.1 and v1.0.0) preserved in release history table.
- **Deployment Status:** **HELD** (Local working copy modified; no commit, push, or Cloudflare Pages deployment executed).

---

## 6. Physical Acceptance & Safe Integration Status

- **Workstation Isolation:** No installer was executed on the primary development workstation. Registry, start menu, and user configuration were untouched.
- **Physical Acceptance Testing:** **NOT TESTED** on separate physical PC hardware. Operators should execute the checklist defined in `docs/reports/GATE20_2_ACCEPTANCE_READINESS_REPORT.md` on clean Windows 10/11 x64 systems prior to general availability.
- **Auto-Updater Isolation:** `latest.json` updater feed is strictly isolated and **NOT** updated or published. Existing v1.0.0 and v1.0.1 installations will not receive automatic update prompts until physical acceptance is approved.

---

## 7. Stable Release Immutability Confirmation

- Existing published release tag `v1.0.1` remains anchored strictly to commit `48d083d1b42b9c7edf76202abde599e6beb87b2e`.
- Release folder `release/v1.0.1-final/` and its assets are completely unmodified.
- `master` branch has not been modified or merged.

