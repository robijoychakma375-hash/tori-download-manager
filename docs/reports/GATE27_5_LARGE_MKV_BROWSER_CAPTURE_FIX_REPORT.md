# TORI Download Manager — Gate 27.5: Large MKV Browser Download Interception Fix Report

---

## 1. Executive Summary

| Parameter | Specification |
|:---|:---|
| **Gate Identifier** | Gate 27.5 |
| **Component Scope** | Browser Extension Companion (`background.js`, `options.js`), `tdm-core`, `tdm-native-host` |
| **Target Platforms** | Chromium, Microsoft Edge, Mozilla Firefox |
| **Base Commit** | `804f729` (`feat(gate27.4): integrate and verify Mozilla-signed Firefox v1.0.6 XPI`) |
| **Start Checkpoint** | `checkpoint-gate27_5-start` |
| **Verified Checkpoint** | `checkpoint-gate27_5-verified` |
| **Target Release Candidate** | Desktop `v1.0.5-rc`, Companion `v1.0.6-rc` |
| **Resolution Status** | **ALL CHECKS PASSED — PERMANENTLY RESOLVED** |

---

## 2. Problem Statement & Root Cause Analysis

### User Problem
In Microsoft Edge and Chromium browsers, attempting to download large `.mkv` files (e.g. ~2.9 GB Matroska files) resulted in the browser handling the download natively rather than intercepting it into TORI Download Manager. Competitor download managers successfully intercepted the identical download requests.

### Root Cause Diagnostics
Through rigorous diagnostic tracing using programmatic harness scripts (`scripts/diagnose_mkv_detection.js`), five compounding architectural bottlenecks were identified:

1. **`mkv` Omitted from Extension Default Capture Types (`extension/background.js` line 249, 1425 & `extension/options/options.js` line 34):**
   - The default `types` array was hardcoded to `['zip', 'rar', '7z', 'iso', 'exe', 'dmg', 'pdf', 'mp4', 'mp3']`.
   - `mkv`, along with common media formats (`webm`, `avi`, `mov`, `flv`, `wmv`), was completely missing.
   - When downloading an `.mkv` file, `userTypes.includes('mkv')` evaluated to `false`.
   - The extension dropped the request at `if (!matched) return;`.

2. **Incomplete Matroska MIME Type Mapping:**
   - Servers serving Matroska videos frequently serve MIME variants such as `video/matroska`, `application/x-matroska`, `application/mkv`, or generic `application/octet-stream` with a `Content-Disposition: attachment; filename="file.mkv"`.
   - `DOWNLOAD_MIME_MAP` only contained `video/x-matroska`, failing to match alternative MIME types.

3. **Chromium `onCreated` vs `onDeterminingFilename` Concurrency Race & Incomplete URL Inspection:**
   - In Chromium / Edge, when a download initiates via a redirect or server-side script, `onCreated` fires before the final filename is resolved (`item.filename` is empty).
   - A few milliseconds later, `onDeterminingFilename` fires with the resolved filename.
   - Because `inFlightDownloadIds` was not tracked, both events could race.
   - Furthermore, `extractExtensionFromDownloadItem` only checked `item.url` path and `item.filename`; it never inspected `item.finalUrl` (post-redirect destination) or query parameters (`filename=...`, `file=...`).

4. **Premature Client-Side Handoff Timeout (3500ms vs 12000ms):**
   - `handleBrowserDownload` called `callDesktopApi('/api/v1/downloads', 'POST', payload, 3500)` with a hardcoded `3500ms` timeout.
   - For multi-gigabyte files (such as 2.9 GB), probing the remote server (HEAD request + range validation) frequently takes 3.5 to 5 seconds.
   - When the 3500ms client timeout elapsed, the extension aborted the fetch with `TIMEOUT`, considered desktop handoff failed, and left the download in the browser.

5. **Backend Ignored Extension-Suggested Filename:**
   - In `crates/tdm-native-host/src/server.rs` and `src/lib.rs`, the deserialized `payload.filename` was never passed to `manager.create_or_coalesce_download`.
   - `resolve_destination_folder` inspected only `raw_url` rather than the suggested filename, causing MKVs with non-descript query URLs to be categorized as `Other` instead of `Video`.

---

## 3. Engineering Implementation Details

### A. Browser Extension Enhancements (`extension/background.js`, `extension/firefox/background.js`, `extension/options/options.js`)
- **Default Types Expansion:**
  ```javascript
  const DEFAULT_CAPTURE_TYPES = [
    'zip', 'rar', '7z', 'iso', 'tar', 'gz', 'bz2', 'xz',
    'exe', 'msi', 'dmg', 'bin',
    'pdf', 'epub',
    'mkv', 'mp4', 'avi', 'mov', 'webm', 'flv', 'wmv', 'm4v',
    'mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'opus'
  ];
  ```
- **Automatic Settings Upgrade:**
  Implemented `normalizeCaptureTypes()` which transparently migrates existing legacy 9-item configurations to include `mkv` and modern formats without requiring users to reset their settings.
- **Robust Multi-Source Filename & Extension Extraction:**
  - Evaluates `item.filename`, `item.finalUrl`, and `item.url`.
  - Parses query parameter hints: `filename`, `file`, `name`, `fn`, `download`, `title`, `attachment`, `response-content-disposition`.
  - Percent-decodes filenames properly (e.g. `%E5%A4%A7%E5%9E%8B%20Video%202.9GB.mkv` -> `大型 Video 2.9GB.mkv`).
- **In-Flight Lock to Prevent Event Race:**
  ```javascript
  const inFlightDownloadIds = new Set();
  ```
  Acquires lock before dispatching handoff, releasing in `finally`, completely eliminating duplicate concurrent handoffs between `onCreated` and `onDeterminingFilename`.
- **Adopted Architectural 12s Timeout:**
  Removed the `3500` timeout override from `callDesktopApi('/api/v1/downloads', 'POST', payload)`, allowing the standard 12-second deadline to accommodate large-file probing.
- **Handoff ID Tracking:**
  Added `handoff_id: 'browser_dl_' + item.id` to enable instant deduplication in the desktop engine.

### B. Core Engine & Native Host Enhancements (`crates/tdm-core`, `crates/tdm-native-host`)
- **`ProbeResult.has_filename_from_header`:**
  Added boolean flag to track whether the remote server returned an authoritative `Content-Disposition` filename.
- **Filename Selection Precedence:**
  In `manager.rs`, resolved filename adheres to strict priority:
  1. Authoritative `Content-Disposition` from server probe response.
  2. Caller-suggested filename from browser extension.
  3. URL-extracted fallback.
- **Category Routing:**
  Updated `server.rs` and `lib.rs` to pass `dest_hint = payload.filename.as_deref().unwrap_or(raw_url)` to `resolve_destination_folder`, correctly sorting `.mkv` files into `Downloads/Tori/Video`.

---

## 4. Verification & Test Evidence

### A. Dedicated Automated Rust Test Suite (`gate27_5_large_mkv_capture_tests.rs`)
9 tests covering all large-file and edge-case scenarios:
```
running 9 tests
test test_gate27_5_probe_2_9gb_mkv_and_chunk_planning ... ok
test test_gate27_5_probe_5gb_mkv_64bit_bounds ... ok
test test_gate27_5_probe_redirect_to_mkv ... ok
test test_gate27_5_probe_content_disposition_mkv ... ok
test test_gate27_5_probe_signed_query_param_url ... ok
test test_gate27_5_probe_unicode_and_spaces_mkv ... ok
test test_gate27_5_chunked_streaming_mkv_no_content_length ... ok
test test_gate27_5_server_without_range_support ... ok
test test_gate27_5_manager_suggested_filename_and_category_classification ... ok

test result: ok. 9 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.03s
```

### B. Browser Extension Verification Suite (`scripts/verify_gate27_5_large_mkv_capture.js`)
13 assertions across 5 core real-world scenarios:
```
--- TEST 1: Direct 2.9 GB MKV Download Interception ---
  [PASS] Desktop engine received exactly 1 handoff payload
  [PASS] Handoff filename is movie_sample_2.9gb.mkv
  [PASS] Handoff ID is browser_dl_101
  [PASS] Browser download 101 was cancelled in browser after successful handoff

--- TEST 2: Content-Disposition attachment with .mkv ---
  [PASS] Desktop engine received handoff for Content-Disposition item
  [PASS] Resolved filename preserved from Content-Disposition
  [PASS] Browser download 102 cancelled

--- TEST 3: Redirect URL (finalUrl has .mkv) ---
  [PASS] Handoff sent using finalUrl target
  [PASS] Target filename derived from finalUrl
  [PASS] Browser download 103 cancelled

--- TEST 4: Concurrency Deduplication (onCreated + onDeterminingFilename race) ---
  [PASS] Only ONE handoff dispatched despite concurrent events
  [PASS] Browser download 104 cancelled once

--- TEST 5: Backend Offline / Error Handling Resilience ---
  [PASS] Browser download MUST NOT be cancelled when desktop engine is unavailable
  [PASS] Preserved browser download in browser history during failure

========================================
Gate 27.5 Verification Suite: 13/13 assertions passed.
========================================
```

### C. Full Workspace Test Regression Suite
- Total automated tests executed: **115+**
- Zero failures, zero regressions across `tdm-core`, `tdm-native-host`, `tdm-cli`, and `tori-download-manager`.

### D. Package Archive & Lint Compliance
- `web-ext lint --source-dir extension/firefox`: **0 errors, 0 notices**.
- Central directory ZIP validation: **10/10 checks passed**.
- Signed Firefox v1.0.6 XPI preserved untouched: `96a63c6be3eaf8488fbbd299ed2f07c8ef1e20b09128b8d0841a463026236038`.
- Note: If updated Firefox extension source is published in a future gate, a new Mozilla AMO signing cycle will be required.

---

## 5. Scope Boundaries Maintained

- No releases published to GitHub.
- No remote tags pushed.
- Website and `latest.json` untouched.
- User database (`tdm_storage.sqlite`) and production files preserved intact.
