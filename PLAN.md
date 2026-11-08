# TORI Download Manager v1.0.1 — Milestone Plan: Gate 14.4.10
## DASH Manifest Misclassification Fix

### Objective
Fix the confirmed DASH manifest misclassification in the browser extension where valid DASH MPD responses with Content-Type `application/dash+xml` were misclassified as `type: 'hls'` and `format: 'm3u8'`. Ensure that:
1. `application/dash+xml` and `.mpd` URLs are strictly classified as `type: 'dash'` and `format: 'DASH (mpd)'`.
2. MIME parameters such as `; charset=utf-8` are properly parsed and handled.
3. Extensionless manifests for both DASH and HLS are recognized when Content-Type identifies the protocol.
4. Generic streaming detection, segment classification, manifest eviction protection, and session persistence remain fully functional.
5. Zero production code changes to the Rust engine or download manager core.

---

### Specific Measurable Next Milestones

#### Milestone 1: Root Cause Analysis & Plan Verification
- [x] Inspect `extension/background.js` lines 18-22, 38-42, 1000-1022, 1222-1230.
- [x] Confirm that `STREAMING_MIMES` contains `'application/dash+xml'` and is checked inside the HLS classification block before DASH classification, causing `.mpd` and `application/dash+xml` to be labeled as HLS.
- [x] Formulate minimal protocol-specific classifier correction separating `HLS_MIMES` and `DASH_MIMES`.

#### Milestone 2: Minimal Implementation in Browser Extension
- [x] In `extension/background.js`:
  - Define distinct `HLS_MIMES` and `DASH_MIMES`, keeping `STREAMING_MIMES = [...HLS_MIMES, ...DASH_MIMES]`.
  - Normalize MIME types with parameter stripping (`baseMime = lowerMime.split(';')[0].trim()`).
  - In `classifyMedia()`: Evaluate DASH detection before HLS, matching `lowerUrl.includes('.mpd') || DASH_MIMES.includes(baseMime) || lowerMime.includes('dash+xml')`.
  - In `classifyMedia()`: Update HLS detection to check `lowerUrl.includes('.m3u8') || HLS_MIMES.includes(baseMime) || lowerMime.includes('mpegurl')`.
  - In `isManifestCandidate()`: Support base MIME normalization with parameters.
  - In `onHeadersReceived`: Use `baseMime` to ensure extensionless DASH/HLS responses with parameters are intercepted.

#### Milestone 3: Automated Regression Test Suite
- [x] Create `scripts/verify_gate14_4_10_dash_fix.js`:
  - Test 1: MPD URL with `application/dash+xml` -> DASH (`type: 'dash'`, `format: 'DASH (mpd)'`).
  - Test 2: Extensionless URL with `application/dash+xml` -> DASH.
  - Test 3: MPD with MIME parameters (`application/dash+xml; charset=utf-8`) -> DASH.
  - Test 4: M3U8 URL with HLS MIME -> HLS (`type: 'hls'`, `format: 'm3u8'`).
  - Test 5: Extensionless HLS with HLS MIME -> HLS.
  - Test 6: Direct MP4 remains direct media (`type: 'direct'`, `format: 'MP4'`).
  - Test 7: Standalone TS and AAC remain supported.
  - Test 8: DASH M4S segments remain classified as segments (`is_segment: true`).
  - Test 9: HLS TS segment classification remains functional (`is_segment: true`).
  - Test 10: DASH manifest persists after MV3 service worker restart (`chrome.storage.session`).
  - Test 11: DASH manifest survives more than 50 segment candidates (eviction protection).
  - Test 12: Popup and overlay format display for DASH.
  - Regression check: Validate existing tests from Gates 14.4.2 through 14.4.6.

#### Milestone 4: Real Microsoft Edge Verification
- [x] Run Microsoft Edge with TORI extension in isolated development environment.
- [x] Pair with TORI v1.0.1 desktop host on port 6800.
- [x] Navigate to test page, trigger fetch of `/dash/manifest.mpd`.
- [x] Query candidates via `GET_TAB_MEDIA`: verify `type: 'dash'`, `format: 'DASH (mpd)'`, `is_segment: false`.
- [x] Open extension popup context, verify popup list renders `DASH (mpd)` with download button.
- [x] Dispatch download and verify completion.

#### Milestone 5: Reporting & Safe Git Commit
- [x] Verify `git status` (no modifications to Rust backend or unintended files).
- [x] Document all before/after classification results and test matrices in `IMPLEMENTATION_STATUS.md`.
- [x] Create local Git commit on `dev/v1.0.1` upon all tests passing.
