# TORI Download Manager — Gate 12.9 Execution Plan
## Multi-Strategy Media Discovery & Broad Website Compatibility

### Milestone Objective
Deliver a verified, production-quality implementation of **Gate 12.9**:
1. Build a unified media discovery orchestrator in Rust (`crates/tdm-core`) combining:
   - Platform site extractors (yt-dlp for YouTube, Facebook, Instagram, TikTok, etc.)
   - Direct HTTP media probe (.mp4, .webm, .mkv, .mp3, etc.)
   - HLS manifest detection & variant parsing (.m3u8)
   - DASH manifest detection & representation parsing (.mpd)
   - HTML metadata extraction (OpenGraph `og:video`, JSON-LD `VideoObject`, `<video src>`, `<source src>`)
   - Optional Streamlink discovery adapter (graceful runtime detection, zero overhead when not present)
   - Browser candidate stream handoff (DOM `<video>` elements + `chrome.webRequest` network capture)
2. Enhance generic browser media detection in Manifest V3 (`extension/content.js`, `extension/background.js`, `extension/popup/popup.js`):
   - HTML5 `<video src>` and `<source src>` extraction across light DOM and open `shadowRoot`
   - OpenGraph and video poster extraction
   - Network request interception of streaming manifests (.m3u8, .mpd) and direct media (.mp4, .webm) with MIME type recognition
   - Strict filtering of ad widgets and tracking requests
   - Correlation with tab, frame, and page URL
3. Update desktop API (`crates/tdm-native-host/src/server.rs`) to support candidate handoff in `/api/v1/media/resolve`.
4. Comprehensive Streamlink evaluation (packaging, licensing, RAM/CPU overhead, plugin coverage).
5. Build test harness and verification suite (`scripts/verify_gate12_9.js`, `crates/tdm-core/tests/gate12_9_discovery_tests.rs`).
6. Run full regression tests (121+ Rust tests, release verification, linter, formatting).
7. Generate `GATE12_9_MULTI_STRATEGY_MEDIA_DISCOVERY_REPORT.md` and commit to Git.

---

### Phase 1: Audit Current Media Discovery
- Identify limitations of single-URL extraction.
- Preserve existing YouTube, Facebook Reels, Instagram, TikTok, and direct stream pipelines.

---

### Phase 2: Rust Media Discovery Orchestrator
- In `crates/tdm-core/src/resolver/`:
  - Create `orchestrator.rs`: defines `DiscoveryStrategy`, `MediaCandidate`, `DiscoveryOrchestrator`.
  - Implement HTML metadata parser: extracts `og:video`, JSON-LD `VideoObject` from webpage responses.
  - Implement candidate deduplication and ranking (highest resolution, bitrate, protocol preference).
  - Implement optional `StreamlinkAdapter` (probes `streamlink --json` if installed; skips cleanly if absent).
  - Integrate orchestrator into `MediaResolver::resolve` and add support for batch candidate resolution.
- In `crates/tdm-native-host/src/server.rs`:
  - Extend `ResolveMediaReq` to accept `candidates: Option<Vec<String>>`, `page_title: Option<String>`, `thumbnail_url: Option<String>`.

---

### Phase 3: Generic Browser Media Detection Improvements
- In `extension/content.js`:
  - Extract direct `video.src`, `video.currentSrc`, and `<source src="...">` elements.
  - Extract OpenGraph `og:video` and poster URLs from page metadata.
  - Send DOM candidates with `RESOLVE_MEDIA` payload.
  - Filter out ad containers and tracking elements.
- In `extension/background.js`:
  - Intercept media requests by MIME type (`video/*`, `audio/*`, `application/x-mpegurl`, `application/dash+xml`) and query parameters.
  - Filter out tracking domains and analytics scripts.
  - Pass captured candidates to `/api/v1/media/resolve`.

---

### Phase 4: Streamlink Evaluation & Direct Stream Handoff
- Evaluate Streamlink across all criteria (licensing, packaging, performance, Rust engine compatibility).
- Validate stream candidates via HTTP HEAD/Range probes.
- Map candidates directly to `DownloadCapability::NativeHttp`, `NativeHls`, or `NativeDash`.

---

### Phase 5: Verification & Benchmark Suite
- Create `crates/tdm-core/tests/gate12_9_discovery_tests.rs`:
  - Test HTML metadata extraction (`og:video`, JSON-LD).
  - Test candidate deduplication and ranking.
  - Test direct media and HLS/DASH manifest discovery.
  - Test Streamlink adapter graceful degradation when absent.
  - Test multi-strategy orchestrator resolution.
- Create `scripts/verify_gate12_9.js`:
  - End-to-end verification covering HTML5 video, source elements, HLS, DASH, direct media, candidate handoff, and fast-fail.
- Execute full test suite:
  - `cargo fmt --all -- --check`
  - `cargo clippy --workspace --all-targets -- -D warnings`
  - `cargo test --workspace`
  - `npm --prefix ui run build`
  - `powershell -ExecutionPolicy Bypass -File scripts\verify_production_release.ps1`
- Rebuild production executable via `cargo tauri build --no-bundle`.
- Generate `GATE12_9_MULTI_STRATEGY_MEDIA_DISCOVERY_REPORT.md`.
