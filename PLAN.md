# TORI Download Manager — Gate 12.9.1 Execution Plan
## Real-World Media Discovery Acceptance Test

### Milestone Objective
Execute a rigorous real-world media discovery acceptance test of Gate 12.9 on real, authorized, unprotected media sources without starting Gate 13:

1. **Step 1: Check Project Integrity**
   - Verify Git HEAD is at `505f3d9` with clean working tree.
   - Verify production binary `target\release\tori-download-manager.exe` (28,043,264 bytes, SHA-256 `538F9732...`).
   - Verify SQLite database, user settings, and history preservation.

2. **Step 2: Verify Discovery Strategies Independently**
   - Strategy A: yt-dlp supported URLs (YouTube, Facebook, etc.)
   - Strategy B: Generic HTML5 video (<video src>, <source src>)
   - Strategy C: Direct MP4 / WebM media resources
   - Strategy D: HLS .m3u8 master and media playlists
   - Strategy E: DASH .mpd manifests
   - Strategy F: Accessible embedded players (cross-frame and same-frame)
   - Strategy G: Browser-observed network media requests (candidate handoff)
   - Strategy H: Optional Streamlink fallback (graceful degradation when absent)
   - Verify that failure of one strategy does not prevent valid candidates from succeeding.

3. **Step 3: Test Real Media Downloads & FFprobe Verification**
   - Download real authorized public test files:
     - Direct MP4 test file
     - Direct WebM test file
     - Real HLS VOD stream
     - Real DASH stream
     - Real public YouTube video
     - Real public Facebook video
   - Verify complete downloaded output with `ffprobe.exe` (resolution, codecs, duration, bitrate, container).
   - Record exact resolver duration, download completion, RAM and CPU usage.

4. **Step 4: Investigate Previously Reported Diagnostic Sites**
   - Probe `fprime.at`, `flaxjoy.app`, and `zetmoon.live`.
   - Record exact HTTP status, Cloudflare challenge presence, MSE player structure, and extractor stderr.
   - Honest reporting: do not claim downloadability when media is gated behind anti-bot challenges or DRM.

5. **Step 5: Full Regression Protection**
   - Run full Rust test suite (`cargo test --workspace`).
   - Run linters (`cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets -- -D warnings`).
   - Run UI build (`npm --prefix ui run build`).
   - Run release guard (`scripts\verify_production_release.ps1`).
   - Verify Facebook thumbnails and toast window controls.

6. **Step 6: Deliverables**
   - Create `GATE12_9_1_REAL_WORLD_ACCEPTANCE_REPORT.md` (and copy to artifact directory).
   - Update `IMPLEMENTATION_STATUS.md`.
