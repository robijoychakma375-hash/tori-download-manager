# TORI Download Manager v1.0.1 — Milestone Plan: Gate 17.2
## Real-World Website Compatibility & Universal Media Detection

### Objective
Improve TORI's reliability when detecting and downloading authorized public videos from real websites through the existing Microsoft Edge/Chrome extension and Rust download engine, preserving all completed Gate 17.1 HLS/DASH concurrency optimizations without introducing another download engine.

---

### Specific Measurable Milestones

#### Milestone 1: Baseline Checkpoint & Audit
- [x] Verify Git branch (`dev/v1.0.1`), HEAD commit (`9fcab79`), clean working tree, and 13 untracked verification scripts.
- [x] Confirm installed stable TORI v1.0.0 is untouched (`C:\Program Files\Tori Download Manager`).
- [x] Inspect existing resolver, extension background/content/popup scripts, and native host server.

#### Milestone 2: Real Website Compatibility & Failure Analysis
- [x] Test 7 target media sources:
  1. YouTube (`https://www.youtube.com/watch?v=jNQXAC9IVRw`)
  2. Vimeo (`https://vimeo.com/27246366` / `https://player.vimeo.com/video/27246366`)
  3. Dailymotion (`https://www.dailymotion.com/video/x7tgad0`)
  4. Internet Archive (`https://archive.org/details/BigBuckBunny_124`)
  5. Facebook public video/reel
  6. Instagram public Reels
  7. TikTok public video (`https://www.tiktok.com/@tiktok/video/7106594312292453675`)
- [x] Evaluate each site across the 10-step pipeline:
  - Page/video detection
  - Candidate extraction
  - Available formats & quality labels
  - Video/audio pairing
  - Extension popup display
  - Download button interaction
  - Native Messaging handoff
  - Correct job creation
  - Download completion
  - FFprobe verification & FFmpeg decode
- [x] Distinguish platform access walls (login walls, anti-bot) from engine defects.

#### Milestone 3: Universal Media Detection & Transport Segment Filtering
- [x] Ensure transport segments (`.m4s`, `.cmfv`, `.cmfa`, numbered `.ts`) are NEVER displayed as independent downloadable full videos in popup or content script overlay.
- [x] Verify detection of direct MP4, WebM, HLS M3U8, DASH MPD, HTML5 video elements, blob-backed playback with network media URLs, dynamically inserted elements, and redirects.
- [x] Verify DRM protection rejection (e.g. watch.plex.tv, Widevine/FairPlay) without circumvention.

#### Milestone 4: Download Initiation & Minimal Production Fixes
- [x] Direct candidate download: ensure clicking "Download" on captured direct media sends `START_DOWNLOAD` with `target.url` to TORI's native high-speed downloader instead of discarding it.
- [x] Remove erroneous `isTransientCdnUrl` rerouting to yt-dlp in `extension/background.js`.
- [x] Propagate `job.referer` and `job.user_agent` to `yt-dlp` in `crates/tdm-core/src/resolver/downloader.rs`.
- [x] Pass `--referer` for Vimeo embed player in `crates/tdm-core/src/resolver/extractor.rs`.
- [x] Normalize Vimeo URLs in `crates/tdm-core/src/resolver/pipeline.rs`, `server.rs`, and extension scripts.
- [x] Fix content script multi-video parent container attachment bug and decouple DOM candidate recording.

#### Milestone 5: Real Microsoft Edge E2E & Browser Stability Validation
- [x] Create `scripts/verify_gate17_2_website_compatibility.js` driving real Microsoft Edge via CDP.
- [x] Verify popup reopening, tab navigation, extension service-worker restarts, cancellation, and download completion.
- [x] Validate zero orphan subprocesses and clean temp file deletion.

#### Milestone 6: Automated Regression & Build Integrity
- [x] Unit tests for URL normalization and referer/user-agent propagation.
- [x] `cargo test --workspace` (HLS, DASH, adaptive HTTP, multisite, format cache, server, referer, user_agent)
- [x] `cargo fmt --all -- --check`
- [x] `cargo clippy --workspace -- -D warnings`
- [x] Produce `GATE17_2_WEBSITE_COMPATIBILITY_REPORT.md` and update `IMPLEMENTATION_STATUS.md`.
