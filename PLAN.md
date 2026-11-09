# TORI Download Manager v1.0.1 — Milestone Plan: Gate 17.6
## Final Development Regression & Release Candidate Audit

### Objective
Conduct an exhaustive final development audit of TORI Download Manager v1.0.1 across download engines, browser extension, native messaging, desktop UI, scheduler, persistence, security, memory, dependencies, and release build integrity to determine whether the development build is suitable for a Release Candidate.

Maintain development on `dev/v1.0.1` at baseline commit `437b635`. Preserve stable installed v1.0.0 untouched. Clean Windows Sandbox / installer QA remain deferred.

---

### Specific Measurable Milestones

#### Milestone 1: Repository Baseline & Integrity Verification (Task 1)
- [x] Verify Git branch (`dev/v1.0.1`), HEAD commit (`437b635`), clean tracked working tree.
- [x] Confirm stable public TORI v1.0.0 exists untouched (`C:\Program Files\Tori Download Manager`).
- [x] Confirm version strings across `Cargo.toml`, `src-tauri/tauri.conf.json`, `ui/package.json`.
- [x] Preserve all untracked test scripts, metrics, and reports.

#### Milestone 2: Complete Download Engine Regression (Task 2)
- [x] Run automated protocol regression harness verifying:
  - Direct HTTP/HTTPS single-stream download
  - HTTP Range requests (206 Partial Content) & multi-chunk downloads (4 & 8 chunks)
  - Mid-stream pause, resume, and partial-file byte preservation
  - Validator change (ETag / Last-Modified / Content-Length) handling and safe chunk reset
  - Network timeouts, retries, and HTTP 429/503 exponential backoff
  - HLS VOD multi-segment download with bounded concurrency ($C=4$)
  - DASH VOD multi-representation separate A/V segment downloading and muxing
  - HLS AES-128 encryption with explicit IV and implicit sequence IV
  - FFmpeg stream-copy remuxing and bitstream validation (`ffmpeg -v error -f null -`)
  - yt-dlp platform metadata extraction and exact format selection
  - 100% byte-for-byte SHA-256 integrity and ffprobe container validation

#### Milestone 3: Scheduler, Queue & Database Integrity (Task 3)
- [x] Verify immediate download dispatch behavior.
- [x] Verify one-time scheduled downloads with `scheduled_at` SQLite timestamp.
- [x] Test restart BEFORE scheduled time (remains scheduled across engine restart).
- [x] Test restart AFTER scheduled time (overdue catch-up transitions to queued and downloads immediately).
- [x] Verify pause, cancellation, and rescheduling via API/UI.
- [x] Verify priority queue ordering (`High` > `Normal` > `Low`).
- [x] Verify `max_active_jobs` bounded concurrency governor.
- [x] Verify crash recovery (interrupted downloads reconcile safely to `paused`).
- [x] Verify missing partial-file handling (resets chunks safely).
- [x] Verify SQLite WAL integrity and download history preservation.
- [x] Verify SQLite format metadata cache TTL and bounded eviction.

#### Milestone 4: Desktop UI Functional Regression (Task 4)
- [x] Launch real desktop Tauri 2 application with isolated profile and remote debugging.
- [x] Verify Main window layout, toolbar, sidebar, and status bar.
- [x] Verify Download table rendering, selections, and context menus.
- [x] Verify Add Download dialog (immediate vs scheduled).
- [x] Verify Scheduler UI controls and past-time prevention.
- [x] Verify Settings modal persistence to SQLite and UI reload.
- [x] Verify About modal dynamic metadata and link openers.
- [x] Verify independent floating progress toast window.
- [x] Verify system tray hide/show and close-to-tray lifecycle.
- [x] Verify Dark and Light themes with WCAG AAA contrast.
- [x] Verify handling of long filenames and Unicode characters.

#### Milestone 5: Browser Extension & Native Messaging Regression (Task 5)
- [x] Launch Microsoft Edge with isolated profile and loaded extension.
- [x] Verify Native Messaging pairing with `tdm-native-host.exe`.
- [x] Verify direct MP4, WebM, HLS master manifests, and DASH MPD detection.
- [x] Verify multi-video page discovery and dynamic DOM MutationObserver capture.
- [x] Verify transport segment suppression (.m4s, .cmfv, .cmfa, raw .ts chunks).
- [x] Verify media candidate deduplication and popup reopening.
- [x] Verify extension service worker termination and recovery via `chrome.storage.session`.
- [x] Verify desktop reconnection and cross-tab candidate isolation.
- [x] Verify browser-to-desktop download dispatch and SQLite job creation.

#### Milestone 6: Deep Security Audit (Task 6)
- [x] Audit filename sanitization in `crates/tdm-core/src/engine/probe.rs` for path traversal (`../`, `..\`), encoded separators (`%2F`, `%5C`), Windows reserved names (`CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9`), and control characters.
- [x] Audit destination path containment (`resolve_destination_folder` and safe collision numbering).
- [x] Audit extension message authorization (`GET_ALL_MEDIA` origin validation, non-extension callers rejected).
- [x] Audit Native Messaging origin validation (only authorized Chrome/Edge extension IDs).
- [x] Audit Local API authentication (Bearer token required, 401 on missing/invalid, 403 on cross-origin).
- [x] Audit Host header validation (DNS rebinding protection).
- [x] Audit Referer and User-Agent header sanitation (CRLF injection prevention, length limits).
- [x] Audit diagnostic logs for token/secret leakage (`tori_[redacted]`).
- [x] Write and run deterministic negative tests for all security boundaries (6 probe tests passed).

#### Milestone 7: Resource, Process & Memory Profiling (Task 7)
- [x] Measure idle desktop engine Working Set (52.48 MB) and Private Bytes (14.92 MB).
- [x] Measure active multi-download engine Working Set and Private Bytes.
- [x] Measure entire Tauri + WebView2 process tree Working Set (526.66 MB) and Private Bytes (313.88 MB).
- [x] Measure Native Messaging host resource footprint.
- [x] Verify CPU utilization during idle (<0.5%) and active transfers.
- [x] Verify OS handle counts remain bounded (4,220 across 8 processes).
- [x] Check for leaked processes (`tdm-native-host`, `ffmpeg`, `yt-dlp`) upon download completion and app exit (0 orphans).

#### Milestone 8: Build and Dependency Audit (Task 8)
- [x] Build production React frontend (`npm run build --prefix ui` - 255ms).
- [x] Build Rust release binaries (`cargo build --release -j 2 --bin tori-download-manager --bin tdm-native-host --bin tdm-cli`).
- [x] Verify bundled companion binaries in `resources/bin/` (FFmpeg, FFprobe, yt-dlp, native host, CLI).
- [x] Verify executable resolution pathways (`find_ffmpeg`, `find_ffprobe`, `find_yt_dlp`).
- [x] Audit `LICENSE` and `LICENSE-THIRD-PARTY.txt` currency and completeness.
- [x] Review `tauri.conf.json` bundle configuration and capabilities.
- [x] Review `npm audit` on UI (0 vulnerabilities).

#### Milestone 9: Full Regression Tests Execution (Task 9)
- [x] Execute `cargo fmt --all -- --check` (clean, 0 diffs).
- [x] Execute `cargo clippy --workspace --all-targets -j 2 -- -D warnings` (clean, 0 warnings).
- [x] Execute `cargo test --workspace -j 2` (188/188 passed across 25 suites).
- [x] Execute Gate 17.6 audit harness (`node scripts/verify_gate17_6_release_audit.js` - 22/22 passed).

#### Milestone 10: Targeted Corrections (Task 10)
- [x] Fixed multi-byte Unicode char boundary truncation vulnerability in `crates/tdm-core/src/engine/probe.rs`.
- [x] Upgraded URL path segment percent-decoding to standard `percent_decode_str` preserving `+`, `&`, and `=`.
- [x] Added 3 security regression tests to `probe.rs`.

#### Milestone 11: Release Candidate Readiness Assessment (Task 11)
- [x] Classify all findings (0 BLOCKER, 0 MAJOR, 0 MINOR, 3 LIMITATION, 1 NOT TESTED).
- [x] Explicitly evaluate Readiness Dimensions:
  - Dimension A: Development Regression Readiness -> **PASSED / READY**
  - Dimension B: Installer / Packaging Readiness -> **LOCAL READY / NOT RELEASED**
  - Dimension C: Clean-Machine Installation Readiness -> **DEFERRED**
  - Dimension D: Public Distribution Readiness -> **DEFERRED / BLOCKED on Gate 16.3**

#### Milestone 12: Comprehensive Final Audit Report (Task 12)
- [x] Deliver `GATE17_6_FINAL_DEVELOPMENT_AUDIT_REPORT.md` in the artifact directory.
- [x] Update `IMPLEMENTATION_STATUS.md` with Gate 17.6 audit results.
- [x] Stop cleanly without starting Gate 17.7 or pushing to remote.
