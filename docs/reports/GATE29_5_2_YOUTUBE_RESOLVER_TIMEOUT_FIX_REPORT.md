# TORI Download Manager — Gate 29.5.2 Report
## YouTube Media Resolver Timeout Fix (`FF109-YT-FMT-01`) & Final Signed Firefox Regression

**Date:** 2026-11-17  
**Branch:** `fix/gate27-runtime-fixes`  
**Pre-Fix Safety Tag:** `checkpoint-gate29_5_2-before-resolver-fix` (commit `457924554d2468b06b83213d2ddf1d1adbf025bd`)  
**Target Release Candidates:** Desktop `v1.0.5` (`release/v1.0.5-gate29_5_2-rc`, `release/v1.0.5-rc`, `release/v1.0.5-v1.0.9-final-rc`) + Browser Companion `v1.0.9` (Mozilla-signed Firefox `a70ed17e183648a9bcf4-1.0.9.xpi` & Chromium/Edge ZIP)

---

## 1. Executive Summary

The confirmed Gate 29.5.1 production blocker **`FF109-YT-FMT-01`** (Firefox `v1.0.9` live YouTube Format Picker timing out after 32 seconds while Desktop resolution appeared fast on empty-candidate calls) has been **diagnosed, fixed exclusively in the TORI Desktop Rust resolver (`crates/tdm-core`), rebuilt, Minisign-signed, and verified end-to-end with zero modifications to `extension/` or the Mozilla-signed Firefox XPI**.

- **Before Fix (`v1.0.5-rc` @ `4579245`):**
  - Firefox live YouTube `RESOLVE_MEDIA` timed out at `32s` (`code: "TIMEOUT"`, `Media resolution timed out (32s).`).
  - Desktop `/api/v1/media/resolve` WITH Firefox candidates took **`37,908 ms` (~37.91 s)** vs `5,838 ms` cold / `6 ms` cache hit with empty candidates.
- **After Fix (`v1.0.5-gate29_5_2-rc`):**
  - Live signed Firefox `v1.0.9` end-to-end `FF109-YT-FMT-01` check passed in **`10,947 ms`** (page navigation + YouTube DOM hydration + multi-quality Format Picker rendering **12 quality rows** + **Download Playlist** banner, with `retriedAfterColdTimeout: false`).
  - Desktop `/api/v1/media/resolve` WITH real Firefox YouTube candidates completed in **`4,194 ms`** cold (`3,648 ms`–`4,478 ms` across runs, an **88.9% reduction** from `37,908 ms`) and **`5 ms`** on cache hit (`extension` `RESOLVE_MEDIA` message round-trip: **`12 ms`–`19 ms`** when warm).
  - Selecting `480p WEBM +Audio vp09` directly from the signed Firefox `v1.0.9` Format Picker queued and completed `WING IT! - Blender Open Movie.mkv` (`11,803,755` bytes, `ffprobeOk: true`).
  - Full `verify_gate29_5_1_firefox_signed_v1_0_9.js` suite passed **`10 PASS, 0 FAIL, 0 TIMEOUT, 0 NOT TESTED`**.

---

## 2. Exact Root Cause & Extension Candidate Findings

Live profiling against frozen Desktop `v1.0.5-rc` (`4579245`) and signed Firefox `v1.0.9` on `https://www.youtube.com/watch?v=u9lj-c29dxI&list=PL6B3937A5D230E335` captured:

1. **Incoming Extension Candidate Payload:**
   - DOM metadata (`<meta property="og:video:*">`) supplied:
     - `https://www.youtube.com/embed/u9lj-c29dxI?[keys=list]`
     - `text/html`
     - `1280`
     - `720`
   - Network `webRequest` interception during YouTube playback can additionally supply YouTube UI audio assets (`youtube.com/s/search/audio/no_input.mp3`, `failure.mp3`, `open.mp3`, `success.mp3`) or ephemeral `googlevideo.com/videoplayback?...` range/segment URLs.
2. **Defective Orchestrator Ordering (`crates/tdm-core/src/resolver/orchestrator.rs`):**
   - `DiscoveryOrchestrator::resolve_multi_strategy` previously looped **sequentially** over every item in `req.candidates` (`probe_direct_media` followed by fallback `resolver.resolve(cand_trim)` invoking `yt-dlp`) **before** checking `is_known_platform_domain(raw_url)` and **before** checking the SQLite `format_metadata_cache`.
   - When `probe_direct_media` rejected `https://www.youtube.com/embed/u9lj-c29dxI?list=...` because it returned `text/html`, the fallback launched `yt-dlp` on the `/embed/...` URL, burning **`~32 seconds`** before finally reaching Step 3 (`if is_platform`), which itself took `5.8s` — totaling **`37,908 ms`** and breaching Firefox extension's 32s RPC timeout.
   - Compounding issues fixed in the same subsystem:
     - `req.candidates` lacked SSRF validation (`validate_safe_media_url`), duplicate/non-URL/segment filtering, candidate count caps, bounded concurrency, and per-probe/sweep deadlines.
     - `probe_direct_media`, `probe_direct_hls`, and `probe_direct_dash` did not fail cleanly on non-2xx HTTP status codes on `GET`.
     - `probe_streamlink` spawned a blocking child via `spawn_blocking` without `kill_on_drop(true)`.
     - Cached `MediaMetadata` entries were not checked for structural completeness (`formats.is_empty()` / empty titles / `is_direct_media`) before serving.

---

## 3. Desktop Backend Architecture Changes (No Extension Edits)

Modified source files (strictly within `crates/tdm-core/`):

1. **[`crates/tdm-core/src/resolver/cache.rs`](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/src/resolver/cache.rs)**
   - Added `is_valid_cached_metadata(meta: &MediaMetadata) -> bool` requiring non-direct media metadata with non-empty `title`, `extractor`, `formats`, and at least one playable format carrying `format_id`, `container`, and `resolution_label`.
2. **[`crates/tdm-core/src/resolver/pipeline.rs`](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/src/resolver/pipeline.rs)**
   - Added `MediaResolver::resolve_with_options_budget(..., budget: Option<Duration>)` (with `resolve_with_options` delegating seamlessly).
   - Validated cached entries with `is_valid_cached_metadata`; incomplete/stale entries are evicted via `db.invalidate_format_cache` and cleanly re-resolved.
   - Clamped `execute_yt_dlp_dump` timeout to remaining request budget (`default_timeout.min(budget)`).
   - Redacted URL query parameter values in `[FormatCache]` log lines using `redact_url_for_log`.
   - Enforced `resp.status().is_success()` checks in `probe_direct_media`, `probe_direct_hls`, and `probe_direct_dash`.
   - Replaced substring domain checks in `is_known_platform_domain` with exact suffix domain matching (`host_matches_domain`) including `youtube-nocookie.com`, preventing false positives such as `notyoutube.com`.
   - Preserved definitive platform errors (`is_definitive_platform_error`) instead of masking them with direct HTML HTTP probe errors.
3. **[`crates/tdm-core/src/resolver/orchestrator.rs`](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/src/resolver/orchestrator.rs)**
   - **Platform-First Priority:** When `is_known_platform_domain(raw_url)` is `true`, `resolve_multi_strategy` runs `resolver.resolve_with_options_budget` (cache check + normalized canonical platform extractor) **first**, inside `TOTAL_PLATFORM_RESOLVE_BUDGET` (26s — well inside Firefox's 32s timeout).
   - **Definitive Error Preservation:** Auth, private, age-restricted, DRM/protected, rate-limit (429), unavailable, and timeout errors (`is_definitive_platform_error`) return cleanly without masking. Non-definitive errors only run bounded candidate fallback if `>= 3s` budget remains and preserve the original platform error if fallback finds no formats.
   - **Candidate Sanitization & Filtering (`sanitize_candidate_urls`):** Drops blanks, non-`http`/`https` schemes (`blob:`, `data:`, `javascript:`, `"text/html"`, `"1280"`, `"720"`), primary/duplicate URLs, static/subtitle assets, HLS/DASH segments (`.m4s`, `/frag-`, `/segment-`, `/chunk-`, `?range=`, `googlevideo.com/videoplayback`), and platform embed pages during raw candidate sweeps; caps kept candidates to `MAX_DISCOVERY_CANDIDATES = 8`.
   - **Bounded Concurrent SSRF-Safe Probing (`probe_candidates_bounded`):** Validates every candidate through `validate_safe_media_url` before network I/O, probes up to `MAX_CANDIDATE_CONCURRENCY = 3` concurrently with `CANDIDATE_PROBE_TIMEOUT = 4s` and `CANDIDATE_SWEEP_BUDGET = 8s`, drops all pending futures cleanly on timeout/cancellation, and eliminates sequential `yt-dlp` spawning inside `req.candidates` loops.
   - **Cancel-Safe Streamlink Probing:** Updated `probe_streamlink` to spawn async `tokio::process::Command` with `.kill_on_drop(true)` and Windows `CREATE_NO_WINDOW`.
   - **Structured Redacted Diagnostics:** Logs redacted URLs (`redact_url_for_log`), path (`platform`, `generic_candidates`, etc.), cache hit/miss, candidate kept/dropped counts, stage durations (`platform_ms`, `candidate_ms`, `html_ms`, `generic_ytdlp_ms`, `streamlink_ms`), total duration, and timeout source.
4. **[`crates/tdm-core/src/resolver/mod.rs`](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/src/resolver/mod.rs)**
   - Exported new resolver validation, sanitization, redaction, and budget helpers.
5. **[`crates/tdm-core/tests/gate29_5_2_resolver_priority_tests.rs`](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/tests/gate29_5_2_resolver_priority_tests.rs)**
   - Added 10 dedicated unit and integration regression tests covering YouTube cold/warm resolution with slow/noisy candidates, platform priority over valid MP4 decoys, definitive error preservation, HTML5 MP4/WebM & HLS/DASH candidate compatibility, bounded timeouts against hanging servers, candidate filtering/capping/redaction, SSRF blocking, stale/incomplete cache eviction, and request cancellation cleanup.

---

## 4. Before vs. After Performance Comparison

| Scenario | Before (`v1.0.5-rc` @ `4579245`) | After (`v1.0.5-gate29_5_2-rc`) | Delta / Outcome |
|---|---|---|---|
| Live Firefox `v1.0.9` YouTube Format Picker (`FF109-YT-FMT-01`) | `TIMEOUT` (>32s) | **`10,947 ms`** (page load -> 12 quality rows + Download Playlist) | **FAIL -> PASS** |
| Extension `RESOLVE_MEDIA` IPC on warm YouTube tab | `TIMEOUT` (32s) | **`14 ms`** (`fmtCount: 24`, `extractor: "youtube"`) | **PASS** |
| `/api/v1/media/resolve` WITH real Firefox candidates (cold) | `37,908 ms` | **`4,194 ms`** (range `3,648 ms`–`4,478 ms`) | **-88.9% latency** |
| `/api/v1/media/resolve` WITH real Firefox candidates (cache hit) | N/A (probed candidates first) | **`5 ms`** (`is_cached: true`) | **< 10 ms** |
| `/api/v1/media/resolve` empty candidates (cold / cache hit) | `5,838 ms` / `6 ms` | `4,645 ms` / `6 ms` | Preserved / faster |

---

## 5. Verification & Regression Matrix (Post-Fix Build)

All checks below ran against the rebuilt Desktop `v1.0.5-gate29_5_2-rc` binaries and unmodified `v1.0.9` extension packages:

| Suite / Command | Result | Details |
|---|---|---|
| `cargo test --package tdm-core --test gate29_5_2_resolver_priority_tests` | **10 PASS, 0 FAIL** | Covers YouTube priority, cache hits, noisy/slow candidates, HTML5/HLS/DASH, SSRF, incomplete cache eviction, cancellation |
| `cargo test --workspace --no-fail-fast` | **238 PASS, 0 FAIL, 0 IGNORED** | 37 test targets across `tdm-core`, `tdm-native-host`, `tdm-cli`, `tori-download-manager` |
| `cargo test --package tdm-core --test updater_cryptography_tests` | **6 PASS, 0 FAIL** | Re-run after Metadata update; verifies Minisign Ed25519 signature + `latest.v1.0.5.draft.json` byte parity |
| `npm --prefix ui run build` | **PASS** | 46 modules built in `319 ms`, 0 errors |
| `npm --prefix ui run lint` | **PASS** | `oxlint`: 0 errors (7 pre-existing React warnings) |
| Extension `node --check` (8 JS files) | **PASS (8/8)** | Zero edits to `extension/` (`git diff --name-only -- extension/` empty) |
| `npx web-ext lint` (frozen Firefox `v1.0.9` ZIP) | **PASS** | 0 errors, 7 pre-existing non-blocking warnings, 0 notices |
| `node scripts/verify_gate29_5_1_firefox_signed_v1_0_9.js` | **10 PASS, 0 FAIL, 0 TIMEOUT** | **`FF109-YT-FMT-01` PASS (`10,947 ms`, 12 rows)**, SIG, Native, HTTP, MKV, Playlist + `ffprobe`, Mix reject, v1.0.7/DB safety |
| Signed Firefox `v1.0.9` Format Picker 480p download + `ffprobe` (`profile_ff109_yt_resolve.js`) | **PASS** | Downloaded `WING IT! - Blender Open Movie.mkv` (`11,803,755` bytes), `ffprobeOk: true` |
| `node scripts/verify_gate27_8_playlist_e2e.js` | **12 PASS, 0 FAIL, 0 TIMEOUT** | Cold launch, Tray restore, Chrome, Edge, signed Firefox `v1.0.7`, Mix 422 rejection |
| `node scripts/verify_gate27_8_large_mkv_and_classification.js` | **10 PASS, 0 FAIL, 0 TIMEOUT** | 2.30 GiB (`2,469,606,195` B) MKV pause/resume + SHA-256 `a71c0f55...` + `Content-Disposition` |
| `node scripts/verify_gate29_1_idm_desktop_ui.js` | **20 PASS, 0 FAIL** | IDM Desktop UI, tray, SQLite persistence, 1,200-row virtualization, OEM DB untouched |
| `node scripts/verify_gate29_2_idm_progress_window.js` | **17 PASS, 0 FAIL** | Progress popup modes, compact 38px collapse, speed limiter, retry, completion options |
| `node scripts/verify_gate29_3_idm_extension_ui.js` | **23 PASS, 0 FAIL, 0 TIMEOUT** | Chrome/Edge/Firefox `v1.0.9` UI, overlay dragging, YouTube 1080p/720p/Audio, Native/HTTP fallback |
| `node scripts/verify_gate29_4_final_integration.js` | **17 PASS, 0 FAIL, 0 TIMEOUT** | Initial run hit `ff-playlist-modal` timeout flake; immediate clean re-run passed **17/17** (NSIS clean/upgrade, crash recovery, 360p/720p/1080p/Audio `ffprobe`, 6x16 MiB load stability) |
| Local Mock Updater Preflight (`UPDATER_PREFLIGHT.json`) | **PASS** | Streamed `117,783,770`-byte installer verified against `latest.v1.0.5.draft.json` & `.sig` |

---

## 6. Artifacts, SHA-256 Checksums, Signing & Safety Verification

### Rebuilt Desktop `v1.0.5` Artifacts (`release/v1.0.5-gate29_5_2-rc`, `release/v1.0.5-rc`, `release/v1.0.5-v1.0.9-final-rc/Desktop`)
- `TORI Download Manager_1.0.5_x64-setup.exe`: `cab4156fc85a42ce74d5d4292e2976223ba14ad4c8e7d5bbfea533e4ca72f3cb`
- `TORI Download Manager_1.0.5_x64-setup.exe.sig`: `d43c0a98b5965cb8415be5062ced9abdbf10da58bf556751f0ff6eb92410e959`
  - Minisign/Ed25519 trusted comment: `trusted comment: timestamp:1794933070\tfile:TORI Download Manager_1.0.5_x64-setup.exe`
  - **Windows Authenticode PE Status:** **UNSIGNED** (no commercial OV/EV Authenticode certificate applied; SmartScreen prompt expected until signed).
- `tori-download-manager.exe` (x64): `629ebc63afe94a1240a4bc79802502c188bfbf6b8d0f24e0005e350f4a5f0f4a`
- `tdm-native-host.exe` (x64): `0c660aaacb1f2adfc43d2d29188f13317e2cac81bae117644cbfd9743a500d71`
- `tdm-cli.exe` (x64): `66673df965830fbded2d5e6e456a104ad7725fddfdbe62fec513a699e55e52e1`

### Unmodified Browser Companion Packages
- `release/v1.0.5-v1.0.9-final-rc/Extensions/a70ed17e183648a9bcf4-1.0.9.xpi` (Mozilla AMO-signed): `d4e8d6e585ba6dfaf841eb6b37f2ee27beae1cec55badbbe0dd12960ad5943ec` (**unchanged**)
- `release/v1.0.5-v1.0.9-final-rc/Extensions/tori-companion-v1.0.9-chromium.zip`: `dbc345b513795506c30c8300683d99fe1bd4b14d14c012663808bf7a406089ac` (**unchanged**)
- `release/v1.0.5-v1.0.9-final-rc/Extensions/tori-companion-v1.0.9-firefox.zip`: `b38468444094aa15ee1a7fef16022399550bafbba9d46c915d5beb2c2d02632d` (**unchanged**)
- `release/v1.0.7-extension-rc/a70ed17e183648a9bcf4-1.0.7.xpi` (preserved historical v1.0.7): `b082c8f2f4c8b4ed035fab77d9569622737defb3e02279f20073d3404dda4fa0` (**unchanged**)

### Rollback Checkpoints & OEM State Preservation
- Previous frozen RCs preserved intact at:
  - `release/checkpoints/v1.0.5-rc-pre-gate29_5_2/`
  - `release/checkpoints/v1.0.5-v1.0.9-final-rc-pre-gate29_5_2/`
- Production `%APPDATA%\tori-download-manager\tdm_storage.sqlite`: **33** download rows (`sha256=6265b854e25b446376276e2a67a5e0ed93d0a9374ffcfc0b335d601b90386dd8`, completely untouched across every suite).
- `HKCU\Software\Mozilla\NativeMessagingHosts\com.tori.download_manager`: points to `C:\Users\ritud\AppData\Roaming\tori-download-manager\com.tori.download_manager.firefox.json`.
- **Publication Safety:** No Git push, no GitHub Release creation, no public `latest.json` modification (`v1.0.4` remains live), no store upload, and no `toridownload.xyz` / Cloudflare change performed.

---

## 7. Remaining Open Notes & Gate 30 Readiness

- **Independent Clean Windows VM Validation:** **NOT TESTED** (no clean VM hypervisor available on host; all clean-install and upgrade scenarios ran under isolated `target/gate*` directories with isolated `TORI_DATA_DIR`, `TORI_IPC_PIPE`, `WEBVIEW2_USER_DATA_FOLDER`, and clean Firefox/Chrome/Edge profiles).
- **Windows Authenticode Code Signing:** Desktop binaries/installer remain Authenticode **UNSIGNED** (Ed25519 updater-signed only).
- **Gate 30 Assessment:** **`FF109-YT-FMT-01` is resolved** and all automated Rust, UI, Extension, and cross-browser E2E suites pass. Release candidate artifacts in `release/v1.0.5-v1.0.9-final-rc/` and `release/v1.0.5-gate29_5_2-rc/` are consistent, verified, and ready for operator Gate 30 publication authorization (with optional clean-VM/Authenticode sign-off noted).
