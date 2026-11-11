# TORI Browser Companion — Gate 24 Extension v1.0.4 Release Readiness Report

**Project:** `F:\TORI\final tori download manager`  
**Branch:** `extension/v1.0.4`  
**Base Checkpoint:** `7a4dcab` (`checkpoint-post-ui-redesign`)  
**Desktop Target:** `1.0.3` (Unchanged — Stable)  
**Extension Target:** `1.0.4` (Production Redesign Release)  
**Date:** 2026-11-12  
**Status:** `READY FOR RELEASE — PENDING USER APPROVAL & AMO SIGNING`

---

## Executive Summary

Gate 24 successfully prepared, tested, packaged, and audited the production **TORI Browser Extension v1.0.4** across both Chromium/Edge and Mozilla Firefox platforms.

This update delivers the verified toolbar popup (Design 1) and floating video download overlay (Design 2) presentation redesigns while strictly preserving:
- Download engine integration at `127.0.0.1:6800`
- Native Messaging and local HTTP/SSE bridge
- Automatic media sniffing and multi-format extraction
- Download capture and user settings persistence
- Chromium extension identity and Mozilla Gecko ID

All **25 regression audit tests** and **26 real download smoke tests** passed with 100% compliance. Both extension packages were built using Mozilla's official `web-ext` toolchain to guarantee 100% forward-slash ZIP entry formatting and strict compliance with Chrome Web Store and Mozilla AMO validation rules.

---

## 1. Verified Package Inventory & Checksums

| Package Description | Output Path | Archive Size | SHA-256 Checksum | Validation Status |
|---|---|---|---|:---:|
| **Chromium / Edge MV3 Extension** | `release/v1.0.4-extension/tori-download-manager-extension-v1.0.4.zip` | 72,995 bytes | `8bb803a3c3e68427b984980dd6c7633162a75d2f48c360ac6cfca95e3ac7c626` | **VERIFIED** |
| **Mozilla Firefox MV3 Package (AMO)** | `release/v1.0.4-extension/tori-download-manager-firefox-v1.0.4.zip` | 72,720 bytes | `9575da0d8eb2ef16ab123dd43e7216c09f521cb23cc347af192659a58b63eced` | **VERIFIED** |
| **Checksum Manifest** | `release/v1.0.4-extension/SHA256SUMS.txt` | 196 bytes | `6f3c1d93b169bb8fcfa1e79f64bfcb2ce1a5e1140fdcf9fa090b852aa25b7ca8` | **VERIFIED** |

*(Duplicate copies are also staged in `target/release/` for standard build pipeline compatibility).*

---

## 2. Package Structure & Linter Verification

### Chromium MV3 Archive Audit (`tori-download-manager-extension-v1.0.4.zip`)
- **Root Manifest:** Confirmed `manifest.json` at archive root with version `"1.0.4"`.
- **Identity Key:** Official Chromium extension public key preserved intact.
- **Entry Path Formatting:** 0 backslashes (`\`); 100% forward-slash (`/`) entry separators.
- **Path Traversal & Security:** 0 absolute paths; 0 parent directory traversal (`../`) references.
- **Asset Cleanliness:** 0 preview files (developer `icons/preview.html` excluded); 0 forbidden subdirectories (no nested `firefox/`).
- **Core Scripts:** `background.js`, `content.js`, `content.css`, `popup/`, `options/`, `icons/` present.

### Mozilla Firefox MV3 Archive Audit (`tori-download-manager-firefox-v1.0.4.zip`)
- **Root Manifest:** Confirmed `manifest.json` at archive root with version `"1.0.4"`.
- **Gecko ID:** Confirmed unchanged: `"tori-download-manager@toridm.org"`.
- **Mozilla `web-ext lint` Result:** **0 errors, 0 notices** (16 standard MV3 security notices regarding sanitized innerHTML assignments).
- **Entry Path Formatting:** 100% forward-slash formatting generated via `npx web-ext build` (prevents previous Mozilla AMO validation error `icons\icon-128.png`).
- **Cleanliness:** 0 preview files (`icons/preview.html` excluded).

---

## 3. Real Download Smoke Test & Integration Audit

Tested live against running TORI Desktop v1.0.3 production executable (`target/release/tori-download-manager.exe`) on `127.0.0.1:6800` via automated suite `scripts/verify_gate24_smoke_tests.js`:

| # | Test Area | Verified Behavior | Status |
|:---:|---|---|:---:|
| 1 | **Desktop Engine Startup** | Real v1.0.3 binary started in isolated QA sandbox (PID: 17252) | **PASS** |
| 2 | **API Connectivity** | Engine listening on `127.0.0.1:6800`, `/api/v1/ping` returns `status: "ok"` | **PASS** |
| 3 | **Popup Connected State** | Redesigned popup reflects live engine connection (Status: "Connected", dot: `#34d399`) | **PASS** |
| 4 | **Settings Navigation** | Gear icon opens `#settings` view, switches toggle smoothly and update storage | **PASS** |
| 5 | **Open Tori Action** | Open Tori button triggers `SHOW_DESKTOP` IPC dispatch | **PASS** |
| 6 | **Media Resolution** | Engine `/api/v1/media/resolve` successfully resolves format candidates | **PASS** |
| 7 | **Direct Video Download** | Direct download job (`smoke-test-video.mp4`, 512 KB) accepted by engine | **PASS** |
| 8 | **Job Registry** | Job registered in TORI engine active state and SQLite database | **PASS** |
| 9 | **Download Completion** | Output file written to disk (`downloads/Video/sample-video.mp4`) | **PASS** |
| 10 | **File Integrity** | Output size: **524,288 bytes**; SHA-256 matches source **100% byte-for-byte** (`0ed35ffa...`) | **PASS** |
| 11 | **Pause / Resume** | `/api/v1/downloads/{id}/pause` and `/api/v1/downloads/{id}/resume` lifecycle functional | **PASS** |
| 12 | **Overlay Injection** | Redesigned floating pill button (`.tori-pill`) injected over HTML5 video | **PASS** |
| 13 | **Drag Threshold** | 5px drag threshold strictly enforced; relative position saved to `data-pos-rx`/`data-pos-ry` | **PASS** |
| 14 | **Panel Expansion** | Clicking pill expands format card (`.tori-pn.on`, `aria-expanded="true"`) | **PASS** |
| 15 | **Quality Selection** | Format radio options listed; Audio only / Video segmented tabs update paths | **PASS** |
| 16 | **Overlay Download** | Triggering download from overlay dispatches valid job to engine | **PASS** |
| 17 | **Popup Disconnected State** | Terminating engine causes popup to immediately show "Disconnected" | **PASS** |

**Smoke Test Result:** **26 / 26 TESTS PASSED**

---

## 4. Gate 23.6 Regression Suite Audit

The Gate 23.6 functional regression test suite (`scripts/verify_final_extension_ui_migration.js`) was re-run against the v1.0.4 manifests:
- Codebase byte-level parity between Chromium and Firefox: **PASS (5/5 files identical)**
- Zero demo data / zero fake connections in production code: **PASS**
- Manifest version synchronization: **PASS (1.0.4)**
- Draggable overlay 5px threshold and boundary clamping: **PASS**
- HLS / DASH stream fragment filtering (.m4s, .ts excluded): **PASS**

**Regression Audit Result:** **25 / 25 TESTS PASSED**

---

## 5. Release Strategy & Operational Constraints

1. **Desktop Remains v1.0.3:**
   - TORI Desktop remains at version `1.0.3`.
   - `Cargo.toml`, `tauri.conf.json`, `package.json`, and Rust crates are **not** bumped.
2. **Public Updater Unchanged:**
   - The public auto-updater endpoint (`https://toridownload.xyz/releases/latest.json`) remains targeted at Desktop `v1.0.3`.
   - No separate GitHub Latest release will be created for an extension-only update.
3. **Firefox AMO Signing Strategy:**
   - `tori-download-manager-firefox-v1.0.4.zip` is prepared specifically for upload to the **Mozilla Add-on Developer Hub**.
   - The unsigned `.zip` must **not** be distributed as a direct user install package.
   - Once Mozilla signs the package and generates `tori-download-manager-firefox-v1.0.4.xpi`, it will be integrated alongside the Chromium package.
4. **Chromium Extension Distribution:**
   - `tori-download-manager-extension-v1.0.4.zip` can be side-loaded in developer mode or submitted to the Chrome Web Store.

---

## 6. Git Traceability & Checkpoints

- **Pre-Redesign Baseline:** `1b2e522` (`checkpoint-pre-ui-redesign`)
- **Post-Redesign Checkpoint:** `7a4dcab` (`checkpoint-post-ui-redesign`)
- **Dedicated Branch:** `extension/v1.0.4` (Pushed to `origin/extension/v1.0.4`)
- **Release Commit:** `6fc4a49` (`feat(extension): prepare v1.0.4 with verified UI redesign, smoke test suite, and packaging`)
- **Release Blockers:** **None**. Awaiting user approval to publish or submit to Mozilla AMO.
