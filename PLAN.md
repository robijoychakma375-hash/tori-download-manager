# TORI Download Manager v1.0.1 — Milestone Plan: Gate 17.1
## HLS/DASH Adaptive Segment Concurrency & Throughput Optimization

### Objective
Improve native HLS and DASH VOD download throughput when segment fetching is demonstrably bottlenecked by sequential network requests, while maintaining low RAM consumption, correct segment ordering, encryption, cancellation, retry behavior, and download bitstream integrity.

---

### Specific Measurable Milestones

#### Milestone 1: Benchmark-First Rigorous Bottleneck Analysis
- [ ] Create authorized, controlled HLS and DASH VOD test fixtures:
  - Short baseline fixture (12 segments, 24s)
  - Medium fixture (100+ segments, 200s)
  - Large media fixture (~100–200 MB)
  - Separate audio/video DASH
  - AES-128 HLS with explicit IV
  - AES-128 HLS with implicit sequence-derived IV
- [ ] Build a controlled fixture test server with configurable network latency (0ms, 30ms, 75ms, 150ms RTT), bandwidth throttling, and HTTP 429/503 fault injections.
- [ ] Benchmark sequential (concurrency=1) baseline:
  - Measure total download duration, throughput (MB/s), segment latency, memory working set, and private bytes.
  - Evaluate RTT overhead and determine if sequential fetching is a true network bottleneck.

#### Milestone 2: Safe Bounded Worker Concurrency Implementation
- [ ] In `crates/tdm-core/src/hls/downloader.rs`:
  - Implement bounded parallel segment worker pipeline using `futures_util::stream::StreamExt::buffer_unordered` or worker queue bounded by `max_concurrency` (tested at 1, 2, 4, 8; default 4 bounded by host governor).
  - Pre-fetch or safely cache unique AES-128 keys so concurrent workers do not redundantly fetch the same key URI.
  - Stream segments directly to disk (`seg_{:06}.ts`) and immediately release byte buffers to keep memory strictly $O(\text{concurrency} \times \text{segment\_size})$.
  - Preserve deterministic segment indexing and ordering for FFmpeg concatenation.
  - Propagate cancellation tokens, Referer, and User-Agent headers across all workers.
  - Preserve retry backoff logic for HTTP 429, 500–504, and network drops.
- [ ] In `crates/tdm-core/src/dash/downloader.rs`:
  - Implement bounded parallel segment worker pipeline for video and audio representations.
  - Stream segments directly to disk (`video_seg_{:06}.m4s` / `audio_seg_{:06}.m4s`).
  - Preserve initialization segment download prior to media segment worker fan-out.
  - Preserve cancellation, retry backoff, and deterministic remux ordering.

#### Milestone 3: Adaptive Concurrency & Backoff on Rate Limits
- [ ] Integrate dynamic rate-limit backoff:
  - When an HTTP 429 or 503 is encountered, decrease active concurrency immediately to reduce pressure on the remote host.
  - Bound maximum concurrency strictly to `governor.max_connections_per_host()`.
  - Support `TORI_STREAM_CONCURRENCY` override for testing candidate worker limits (1, 2, 4, 8).

#### Milestone 4: Correctness & Bitstream Integrity Verification
- [ ] Verify segment count, order, and container structure.
- [ ] Verify AES-128 decryption with explicit IV and sequence IV.
- [ ] Verify audio/video remuxing for both HLS separate A/V and DASH separate A/V.
- [ ] Execute `ffprobe` stream metadata inspection and full FFmpeg bitstream decode (`ffmpeg -v error -i <file> -f null -`) on all downloaded outputs (0 bitstream decode errors).
- [ ] Injected failure recovery: HTTP 429, HTTP 503, missing segment 404, mid-download cancellation.
- [ ] Check for temporary file cleanup and zero orphaned processes.

#### Milestone 5: Full Performance Comparison & Regression Verification
- [ ] Measure sequential vs candidate concurrency limits (1, 2, 4, 8) under identical latency and network conditions.
- [ ] Record median and p95 metrics for duration, throughput, peak RAM, and CPU.
- [ ] Run full regression suite:
  - `cargo fmt --all -- --check`
  - `cargo clippy --workspace --all-targets -- -D warnings`
  - `cargo test -p tdm-core --test gate4_hls_tests --test gate5_dash_tests`
- [ ] Generate comprehensive `GATE17_1_STREAMING_CONCURRENCY_REPORT.md` and stop.
