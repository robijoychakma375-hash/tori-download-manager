# TORI DOWNLOAD MANAGER v2.0
## GATE 12.5.2 VERIFICATION REPORT — ACCURATE MEDIA FILE SIZE DISPLAY

**Status:** Complete & Fully Verified  
**Date:** 2026-11-05  
**Target:** Windows 10/11 x64 (MSVC toolchain 14.44.35207 + WebView2)  
**Reference Document:** `GATE 12.5.2 — ACCURATE MEDIA FILE SIZE DISPLAY`  

---

### 1. Executive Summary

In Gate 12.5.1, Facebook Reels resolution and downloads were stabilized. However, the browser extension popup and overlay consistently displayed `"Size unknown"` for resolved Facebook formats (`sd` and `hd`), while YouTube videos displayed approximate or exact sizes.

In Gate 12.5.2, we investigated the metadata pipeline from `yt-dlp` output to Rust `MediaResolver`, desktop IPC, and Chrome/Edge extension UI. We identified the root cause: Facebook CDN streams omit top-level `filesize`, `filesize_approx`, and `tbr` metadata, but **embed stream bitrates directly inside the signed CDN URL query parameters** (`&bitrate=127000` for SD, `&bitrate=580000` for HD). 

By extracting this bitrate and coupling it with the top-level media duration, TORI now calculates precise estimated filesizes (`~1.1 MB` for SD, `~5.1 MB` for HD) with zero network overhead, zero delay, and without firing speculative HEAD or Range requests against expiring CDN tokens. Furthermore, we established a strict 4-step priority hierarchy across Rust, the Tauri desktop UI, and browser extension surfaces.

---

### 2. Root Cause Analysis & Metadata Audit

#### A. Metadata Inspection on Facebook Reels vs. YouTube
Inspection of `yt-dlp --dump-single-json` on Facebook Reels (e.g., `https://www.facebook.com/reel/10153231379946729`) revealed:
1. **Top-Level Video Duration:** Present (`duration = 74.304s`).
2. **Format-Level Size Fields:**
   - `"filesize"`: `null` or `undefined`
   - `"filesize_approx"`: `null` or `undefined`
   - `"tbr"` / `"vbr"` / `"abr"`: `null`
3. **Format Direct Stream URL:**
   - SD format URL: `https://video.xx.fbcdn.net/...&bitrate=127000&...`
   - HD format URL: `https://video.xx.fbcdn.net/...&bitrate=580000&...`
4. **Previous Resolver Behavior:**
   - `parse_single_format` only checked `f["filesize"]` and `f["filesize_approx"]`.
   - `duration_seconds` was not passed into individual format parsers.
   - URL query parameters were not parsed for `bitrate=`.
   - Consequently, both formats evaluated to `FilesizeType::Unknown`, displaying `"Size unknown"` in the UI.

#### B. Combined DASH Streams and Muxing Overhead
- On platforms providing separate DASH video and audio streams (e.g., YouTube `137` 1080p video + `140` m4a audio):
  - Previously, combining exact video bytes + exact audio bytes marked the resulting format as `FilesizeType::Exact`.
  - In practice, container framing, MP4 box headers (`moov`/`mdat`), and muxing packet overhead mean the final file size will differ slightly from the raw sum.
  - Per specifications, all combined DASH estimates must be marked `FilesizeType::Estimated` and prefixed with `~` in the UI.

---

### 3. Implementation Details

#### A. Core Engine (`crates/tdm-core/src/resolver/pipeline.rs`)
1. **Facebook CDN Bitrate Extraction:**
   Added `extract_bitrate_kbps_from_url(url: &str) -> Option<f64>`:
   ```rust
   pub fn extract_bitrate_kbps_from_url(url: &str) -> Option<f64> {
       if let Some(pos) = url.find("bitrate=") {
           let after = &url[pos + 8..];
           let digits: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
           if let Ok(b) = digits.parse::<f64>() {
               if b > 0.0 {
                   return Some(if b > 5000.0 { b / 1000.0 } else { b });
               }
           }
       }
       None
   }
   ```
2. **4-Step Priority Hierarchy in `parse_single_format`:**
   - **Priority 1:** Exact `filesize` if reliably available -> `FilesizeType::Exact`.
   - **Priority 2:** `filesize_approx` -> `FilesizeType::Estimated`.
   - **Priority 3:** If `duration_seconds` and `bitrate_kbps` exist -> `(duration_seconds * bitrate_kbps * 1000 / 8)` -> `FilesizeType::Estimated`.
   - **Priority 4:** If all indicators missing -> `FilesizeType::Unknown`.
3. **Combined DASH Audio/Video Handling:**
   When merging separate streams in `pipeline.rs`:
   ```rust
   let v_eff = v.filesize.or(v.filesize_approx);
   let a_eff = a.filesize.or(a.filesize_approx);
   match (v_eff, a_eff) {
       (Some(v_e), Some(a_e)) => {
           (None, Some(v_e + a_e), FilesizeType::Estimated, merge_id)
       }
       _ => (None, None, FilesizeType::Unknown, merge_id),
   }
   ```
   Both streams are summed without double-counting, and the result is strictly marked `FilesizeType::Estimated` (`filesize_approx`).

#### B. Browser Extension (`extension/content.js` and `extension/popup/popup.js`)
1. **One-Decimal Formatting Below 100 MB (`formatBytes`):**
   ```javascript
   function formatBytes(bytes) {
     if (!bytes || bytes <= 0) return '';
     const units = ['B', 'KB', 'MB', 'GB'];
     let i = 0;
     let val = bytes;
     while (val >= 1024 && i < units.length - 1) {
       val /= 1024;
       i++;
     }
     if (i === 0) return `${val} B`;
     const formatted = val < 100 ? (val.toFixed(1).endsWith('.0') ? val.toFixed(0) : val.toFixed(1)) : val.toFixed(0);
     return `${formatted} ${units[i]}`;
   }
   ```
   - `25,794,969 bytes` -> `24.6 MB`
   - `5,387,040 bytes` -> `5.1 MB`
   - `1,179,576 bytes` -> `1.1 MB`
2. **Priority Display Function (`formatFilesizeDisplay`):**
   - Correctly renders `24.6 MB` for exact sizes.
   - Prepends `~` for approximate sizes: `~24.6 MB`, `~5.1 MB`, `~1.1 MB`.
   - Displays `"Size unknown"` when no data or bitrate is available.

#### C. Desktop Modal UI (`ui/src/components/AddDownloadModal.tsx`)
- Audio-only formats now check `fmt.filesize` or `fmt.filesize_approx` before displaying byte strings, matching the video formats pattern.

---

### 4. Verification & Testing

#### A. Automated Multisite Integration Tests
Ran `cargo test -p tdm-core --test gate12_5_multisite_tests`:
```
running 7 tests
test test_gate12_5_error_classification_precision ... ok
test test_gate12_5_facebook_dash_pairing_and_distinct_notes ... ok
test test_gate12_5_2_media_filesize_reporting_priority_and_accuracy ... ok
test test_gate12_5_1_facebook_reel_url_normalization_and_validation ... ok
test test_gate12_5_portrait_format_labeling_unit ... ok
test test_gate12_5_plex_drm_rejection_and_honest_reporting ... ok
test test_gate12_5_real_public_facebook_video_extraction_download_and_ffprobe ... ok

test result: ok. 7 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 10.11s
```

#### B. Resolver Integration Tests
Ran `cargo test -p tdm-core --test gate10_5_resolver_tests`:
```
running 7 tests
test test_container_compatibility_matrix ... ok
test test_parse_ytdlp_playlist_metadata_unit ... ok
test test_resolver_ssrf_rejection_security ... ok
test test_resolver_ytdlp_json_parsing_and_format_combination ... ok
test test_resolver_direct_media_probe ... ok
test test_resolver_discovery_finds_system_dependencies ... ok
test test_resolver_real_youtube_video_metadata ... ok

test result: ok. 7 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 4.34s
```

#### C. Extension Formatting Unit Assertions
Verified via Node.js scratch harness (`verify_filesize_formatting.js`):
- Exact filesize (25,794,969 bytes) -> `24.6 MB` (Priority 1)
- Approximate filesize (12,500,000 bytes) -> `~11.9 MB` (Priority 2)
- Facebook Reel SD Bitrate (127 kbps @ 74.304s) -> `~1.1 MB` (Priority 3)
- Facebook Reel HD Bitrate (580 kbps @ 74.304s) -> `~5.1 MB` (Priority 3)
- Combined DASH Video + Audio (22,000,000 bytes) -> `~21 MB` (Priority 3/Estimated)
- Unknown Stream -> `Size unknown` (Priority 4)
- All 6 unit assertions passed.

#### D. Rust Quality Gates
- `cargo fmt --all -- --check` -> Clean, 0 errors.
- `cargo clippy --workspace --all-targets -- -D warnings` -> Clean, 0 warnings.
- `npm --prefix ui run build` -> Clean, built in 356ms.

---

### 5. Summary of Modified Files

| File | Changes Made |
|---|---|
| `crates/tdm-core/src/resolver/pipeline.rs` | Added `extract_bitrate_kbps_from_url`; implemented duration/bitrate size calculation; enforced `FilesizeType::Estimated` for combined DASH streams. |
| `crates/tdm-core/src/resolver/mod.rs` | Re-exported `extract_bitrate_kbps_from_url` and `parse_single_format` for unit and integration testing. |
| `crates/tdm-core/tests/gate12_5_multisite_tests.rs` | Added `test_gate12_5_2_media_filesize_reporting_priority_and_accuracy` covering all 4 priority tiers and Facebook Reel CDN bitrates. |
| `extension/content.js` | Updated `formatBytes` for 1 decimal precision below 100 MB; updated `formatFilesizeDisplay` for robust case handling and priority rules. |
| `extension/popup/popup.js` | Updated `formatBytes` for 1 decimal precision below 100 MB; updated `formatFilesizeDisplay` for robust case handling and priority rules. |
| `ui/src/components/AddDownloadModal.tsx` | Added `fmt.filesize_approx` support for audio-only format label display. |
| `IMPLEMENTATION_STATUS.md` | Recorded Gate 12.5.2 verification results and status matrix update. |

---

### 6. Verification Status

Gate 12.5.2 is **COMPLETE and FULLY VERIFIED**. Facebook Reels formats now accurately display real estimated sizes (`~1.1 MB`, `~5.1 MB`), YouTube displays exact or approximate sizes with clean decimal formatting (`24.6 MB`), combined DASH formats honestly disclose estimated status (`~`), and downloads proceed without any added latency or blocking HEAD requests.
