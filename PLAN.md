# TORI Download Manager v2.0 — Milestone Plan
## Gate 8: Production Hardening, Real-World Verification, Low-Memory Optimization and Windows Distribution

### PART 1: Single-Instance Architecture & IPC Hardening
1. Add `DownloadEvent::ShowWindow` in `crates/tdm-core/src/engine/events.rs`.
2. Handle `"show_window"` action in `crates/tdm-native-host/src/lib.rs`.
3. In `src-tauri/src/lib.rs`:
   - Detect if primary engine Named Pipe (`\\.\pipe\tori-download-manager-ipc`) is active.
   - If active, forward `show_window` request to un-minimize/focus primary window and exit secondary instance cleanly.
   - Listen to `DownloadEvent::ShowWindow` in primary window to restore/unminimize/focus WebView2 window.
   - Prevents duplicate SQLite locks, duplicate `DownloadManager` instances, and Named Pipe access conflicts.

### PART 2: Real Protocol Compatibility Matrix & Automated Suite
1. Create `crates/tdm-core/tests/gate8_protocol_matrix_tests.rs`:
   - Protocol-by-protocol verification for HTTP, HTTPS, HLS VOD, DASH VOD, Torrent, Magnet, RTSP, RTMP, RTP, UDP, TCP, Live HLS, and Live DASH.
   - For each protocol, verify container format, duration, audio/video streams via FFprobe, timestamp monotonically increasing, and clean finalization.
   - Distinguish available, implemented, locally tested, real-world verified, and unsupported (DRM).

### PART 3: Full Process-Tree Memory & CPU Profiling
1. Develop deterministic process-tree profiler (`scripts/profile_workloads.ps1` or dedicated Rust benchmark):
   - Measures complete process tree: Desktop Rust process, WebView2 runtime processes (`msedgewebview2.exe`), Native Host, FFmpeg subprocesses, and torrent workers.
   - Benchmark 8 core scenarios:
     1. Idle application baseline
     2. Single direct HTTP download
     3. 4 concurrent HTTP downloads
     4. Single HLS VOD download
     5. Single DASH VOD download
     6. Single BitTorrent P2P download
     7. Single live-stream recording
     8. Mixed simultaneous workload
   - Metrics: Private bytes, Working Set (RAM), CPU time, handle counts, disk I/O, throughput, child process counts.

### PART 4: Long-Duration Reliability & Deterministic Stress Tests
1. Create `crates/tdm-core/tests/gate8_stress_tests.rs`:
   - Large payload streaming and range splitting.
   - Rapid start/stop/pause/resume cycling under active I/O.
   - Simulated network connection drop and exponential backoff retry.
   - Transient server 429/503 throttling resilience.
   - Crash and recovery validation against disk corruption.
   - Temporary `.tdm-part` file and child process leak verification.

### PART 5: Windows NSIS Installer Package
1. Configure `src-tauri/tauri.conf.json`:
   - Bundle `tdm-native-host.exe` and `tdm-cli.exe` sidecars/resources.
   - Configure NSIS target (`targets: ["nsis"]`).
   - Create custom NSIS install hook (`src-tauri/nsis/hooks.nsh`) for:
     - Registering Native Messaging Host pointing to installed binary directory.
     - Registering Chrome and Edge HKCU native messaging registry keys.
     - Uninstaller cleanup of native messaging host registry entries while preserving user downloads and database.
2. Build installer with `cargo tauri build --bundles nsis`.
3. Verify installer output binary on Windows.

### PART 6: Full Verification Sequence
1. `cargo check --workspace`
2. `cargo fmt --all -- --check`
3. `cargo clippy --workspace --all-targets -- -D warnings`
4. `cargo test --workspace -- --test-threads=1`
5. `npm --prefix ui run build`
6. `cargo build --release --workspace`
7. Update `IMPLEMENTATION_STATUS.md` with complete matrix, profiling measurements, installer location, and verified capabilities.
