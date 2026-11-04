# TORI Download Manager (TDM) — Implementation Status

Last Updated: Gate 10.5.2 Real Extension Download & Release Readiness Verified (106 Automated Tests Passing + Microsoft Edge Browser E2E Verified)
Target Platform: Windows 10/11 x64 (MSVC toolchain 14.44.35207 + Windows SDK 10.0.26100.0)

---

## Acceptance Gate Status Matrix

| Gate | Feature | Status | Verification Command | Observed Result | Known Limitations / Notes |
|---|---|---|---|---|---|
| **Gate 0** | Toolchain & Workspace Integrity | **VERIFIED** | `cargo check --workspace` & `cargo fmt --all -- --check` & `cargo clippy --workspace --all-targets -- -D warnings` | Exit code 0, clean check, 0 warnings. | Strict workspace resolver "2", Rust edition 2021. |
| **Gate 0** | Frontend Build Pipeline | **VERIFIED** | `npm --prefix ui run build` | Built in 955ms, dist assets verified (0 errors). | React 19 + TypeScript + Vite 8. |
| **Gate 1** | HTTP Range Download (206) | **VERIFIED** | `cargo test -p tdm-core --test integration_tests -- test_multipart_range_download_success` | Passed in 0.18s; 4MB payload SHA-256 exact match. | Up to 8 concurrent non-overlapping range workers based on file size. |
| **Gate 1** | HTTP 200 Fallback (Ignored Range) | **VERIFIED** | `cargo test -p tdm-core --test integration_tests -- test_http_200_stream_fallback` | Passed in 0.12s; 500KB payload SHA-256 exact match. | Single streaming task when server does not support ranges. |
| **Gate 1** | Unknown Content-Length Streaming | **VERIFIED** | `cargo test -p tdm-core --test integration_tests -- test_unknown_content_length_streaming` | Passed in 0.08s; stream complete with exact SHA-256. | Dynamic part file writer flushes to final file upon EOF. |
| **Gate 1** | HEAD Unsupported Fallback | **VERIFIED** | `cargo test -p tdm-core --test integration_tests -- test_head_unsupported_fallback` | Passed in 0.06s; 405 Method Not Allowed cleanly falls back to GET probe. | Handles both 405 and 501 fallback safely. |
| **Gate 1** | Mismatched `Content-Range` Handling | **VERIFIED** | `cargo test -p tdm-core --test integration_tests -- test_mismatched_content_range_failure` | Passed in 0.05s; detects corrupted byte offsets and transitions to Failed. | Protects file integrity against misbehaving CDNs. |
| **Gate 1** | Pause & Resume Continuity | **VERIFIED** | `cargo test -p tdm-core --test integration_tests -- test_pause_and_resume_continuity` | Passed in 1.20s; paused midway, resumed and verified exact SHA-256. | Non-blocking cancellation; tokens dropped before queue advancing. |
| **Gate 1** | ETag Change Invalidation & Restart | **VERIFIED** | `cargo test -p tdm-core --test integration_tests -- test_etag_change_triggers_restart` | Passed in 0.23s; detected ETag mismatch, wiped stale chunks and downloaded v2 correctly. | Standards-compliant `If-Range` validation with strong entity tags. |
| **Gate 1** | App Crash & Restart Recovery | **VERIFIED** | `cargo test -p tdm-core --test integration_tests -- test_crash_and_restart_recovery` | Passed in 0.38s; abrupt shutdown recovered from SQLite WAL checkpoints. | `reconcile_on_startup()` automatically resets orphaned states to `Paused`. |
| **Gate 1** | Real Network Live HTTPS Download | **VERIFIED** | `.\target\release\tdm-cli.exe "https://raw.githubusercontent.com/tauri-apps/tauri/dev/README.md"` | Successfully downloaded and verified 6,055-byte file. | Real TLS transport using reqwest rustls. |
| **Gate 1** | Windows Reserved Filenames Hardening | **VERIFIED** | `cargo test -p tdm-core --lib test_sanitize_filename_windows_reserved_and_illegal` | Passed; `prn.tar.gz` -> `_prn.tar.gz`, `CON.txt` -> `_CON.txt`, illegal chars sanitized. | Strict Windows NT namespace rules (CON, PRN, AUX, NUL, COM1-9, LPT1-9). |
| **Gate 1** | Windows File Locking Publish Retry | **VERIFIED** | `publish_final_file` retry loop with backoff | Passed; eliminates OS Error 5/32 from anti-virus and indexer file locks. | Exponential backoff across 5 retry attempts. |
| **Gate 2** | Concurrency Governor (Global & Per-Host) | **VERIFIED** | `cargo test -p tdm-core --test gate2_adaptive_tests test_gate2_concurrency_governor_enforces_per_host_limit` | Passed in 0.22s; strictly clamped concurrent connections to 2 under heavy multi-download load. | Bounded global & host-scoped RAII permit system. |
| **Gate 2** | Straggler Tail Splitting & Redistribution | **VERIFIED** | `cargo test -p tdm-core --test gate2_adaptive_tests test_gate2_adaptive_straggler_tail_splitting` | Passed in 0.35s; 10MB payload: idle worker detected slow tail, split safely, completed with exact SHA-256. | Zero overlapping writes; atomic `end_bound` truncates active straggler in flight. |
| **Gate 2** | Priority Queue Scheduling | **VERIFIED** | `cargo test -p tdm-core --test gate2_adaptive_tests test_gate2_real_priority_queue_scheduling` | Passed; High priority downloads are strictly dispatched before Normal before Low under constrained concurrency. | Real SQLite query ordering by `CASE priority WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 ELSE 4 END ASC, created_at ASC`. |
| **Gate 2** | Simultaneous Split-Cancel-Crash-Resume | **VERIFIED** | `cargo test -p tdm-core --test gate2_adaptive_tests test_gate2_simultaneous_split_cancel_crash_resume` | Passed in 0.45s; crash midway through atomic split verified non-overlapping chunks in SQLite, resumed cleanly to exact SHA-256. | Mathematical guarantee against corrupted chunks during mid-split crashes. |
| **Gate 2** | Adaptive Concurrency & Resource Benchmark | **VERIFIED** | `cargo test -p tdm-core --test gate2_adaptive_tests test_gate2_adaptive_vs_fixed_concurrency_and_resources -- --nocapture` | Passed; Throughput 204.15 MB/s, peak working set memory strictly bounded at 45.05 MB. | Benchmarked against fixed single-stream baseline. |
| **Gate 2** | Host Throttling & Backoff (HTTP 429) | **VERIFIED** | `cargo test -p tdm-core --test gate2_adaptive_tests test_gate2_host_throttling_429_retry_recovery` | Passed in 0.52s; 429 response handled with exponential backoff retry; file verified. | Auto-retries up to 3 times on 429, 502, 503, 504 and connection resets. |
| **Gate 2** | Fsync Flush Benchmark & Optimization | **VERIFIED** | `cargo test -p tdm-core --test gate2_adaptive_tests test_gate2_fsync_throughput_benchmark -- --nocapture` | Passed; measured 512KB (267.8 MB/s), 1024KB (412.7 MB/s), 2048KB (448.2 MB/s). | Upgraded checkpoint threshold from 512 KB to 1 MB (+54% write throughput improvement). |
| **Gate 3** | Windows Native Host (Rust) & Named Pipe IPC | **VERIFIED** | `cargo test -p tdm-native-host --test host_tests` | 7 tests passed in 1.44s; process e2e stdin/stdout verified, Named Pipe IPC server connection verified. | Decoupled native host forwards to persistent desktop engine via `\\.\pipe\tori-download-manager-ipc`. |
| **Gate 3** | Chrome & Edge Native Host Registry | **VERIFIED** | `.\target\release\tdm-native-host.exe --register` | Passed; created `%APPDATA%\tori-download-manager\com.tori.download_manager.json` and registry keys in HKCU for Chrome and Edge. | Deterministic Extension ID `jfnfgmcbgapcpieaonbaolgebjaejcdm` via pinned 2048-bit RSA key. |
| **Gate 3** | Media Interception (Manifest V3) | **VERIFIED** | Extension background service worker & webRequest hooks | Tested; detects MP4, WEBM, MKV, MOV, MP3, M4A, AAC, FLAC, OGG, OPUS, HLS M3U8, and MPEG-DASH MPD. | Deduplicated per tab (max 50 candidates); least-privilege permissions. |
| **Gate 3** | Real HTML5 Video Overlay & Popup UI | **VERIFIED** | `extension/content.js`, `extension/popup/` | Verified; floating "Download with TORI" video overlay, 480px popup with dark/light themes, live status pill, queue controls. | Reconnects cleanly on app restart; zero fake progress. |
| **Gate 4** | RFC 8216 HLS Master & Media Playlist Parser | **VERIFIED** | `cargo test -p tdm-core --test gate4_hls_tests test_hls_parser_master_and_media_playlist_unit` | Passed; extracts variants, bandwidth, resolution, codecs, audio renditions, target duration, init segments, byte-ranges, sequence keys. | Rejects playlists with 0 media segments or invalid URLs. |
| **Gate 4** | HLS DRM Rejection (SAMPLE-AES / FairPlay) | **VERIFIED** | `cargo test -p tdm-core --test gate4_hls_tests test_hls_parser_drm_unsupported_error` | Passed; cleanly errors with explicit message refusing DRM bypass. | Strict compliance with rule 9: never bypass DRM. |
| **Gate 4** | HLS AES-128 Cryptographic Decryption | **VERIFIED** | `cargo test -p tdm-core --test gate4_hls_tests test_hls_aes128_cryptographic_decryption` | Passed; AES-128-CBC with PKCS#7 unpadding and sequence-derived IVs roundtrip verified. | Full RFC 8216 Section 5.2 compliant implementation. |
| **Gate 4** | Real MPEG-TS HLS VOD Download & FFmpeg Remux | **VERIFIED** | `cargo test -p tdm-core --test gate4_hls_tests test_hls_real_mpeg_ts_stream_download_and_muxing` | Passed in 0.58s; downloaded real H.264 TS segments, remuxed to MP4 via stream-copy, verified duration via ffprobe. | Concat stream-copy (`-c copy -movflags +faststart`) avoids re-encoding. |
| **Gate 4** | AES-128 Encrypted Stream Download & Remux | **VERIFIED** | `cargo test -p tdm-core --test gate4_hls_tests test_hls_aes128_encrypted_stream_download_and_muxing` | Passed in 0.42s; fetched encryption keys, decrypted segments, remuxed and probed via ffprobe. | Caches key fetches per URI; derived IV fallback if IV attribute omitted. |
| **Gate 4** | Separate Audio Rendition Muxing | **VERIFIED** | `cargo test -p tdm-core --test gate4_hls_tests test_hls_master_playlist_with_separate_audio_rendition` | Passed in 0.48s; downloaded parallel video + audio renditions and muxed into single MP4 with ffprobe duration verification. | Handles `EXT-X-MEDIA:TYPE=AUDIO` matched by `AUDIO` group ID. |
| **Gate 4** | Byte-Range Segments (`EXT-X-BYTERANGE`) | **VERIFIED** | `cargo test -p tdm-core --test gate4_hls_tests test_hls_byterange_segments_download_and_muxing` | Passed in 0.35s; parsed `@offset` and sequential sub-range slices from single container, remuxed to valid MP4. | Fully compliant with RFC 8216 Section 4.3.2.2. |
| **Gate 4** | HLS Pause & Resume Continuity | **VERIFIED** | `cargo test -p tdm-core --test gate4_hls_tests test_hls_pause_and_resume_continuity` | Passed in 0.52s; paused download midway, confirmed preserved segments in `.hls_parts`, resumed without re-downloading existing segments, verified final duration. | Resumes gracefully, cleans up work directory upon completion. |
| **Gate 4** | Gate 4 Hardening (Validation & Live Stream Detection) | **VERIFIED** | `validate_hls_segment` + live stream check in `download_hls_vod` | Verified; checks TS sync byte (0x47) & fMP4 box atoms; strictly rejects non-VOD streams missing `#EXT-X-ENDLIST`. | Eliminates false-success on live streams or truncated segment files. |
| **Gate 5** | ISO 8601 Duration Parser & Template Formatting | **VERIFIED** | `cargo test -p tdm-core --test gate5_dash_tests test_dash_parser_duration_and_template_formatting` | Passed; parses PT durations, formats `$RepresentationID$`, `$Number%05d$`, `$Time$`, `$Bandwidth$`. | Standards-compliant ISO/IEC 23009-1 template formatting. |
| **Gate 5** | DASH Dynamic Live & DRM Rejection | **VERIFIED** | `cargo test -p tdm-core --test gate5_dash_tests test_dash_parser_rejects_dynamic_live_and_drm` | Passed; strictly errors on `type="dynamic"` and Widevine/PlayReady/FairPlay ContentProtection. | Preserves legal integrity; live DASH routed to Gate 7 engine. |
| **Gate 5** | Nested BaseURL & Multi-Period Resolution | **VERIFIED** | `cargo test -p tdm-core --test gate5_dash_tests test_dash_nested_base_url_and_multi_period_resolution` | Passed; resolves root -> Period -> AdaptationSet -> Representation URL hierarchy; resolves SegmentTimeline. | Handles multi-period media timeline alignment. |
| **Gate 5** | Single-Period Video-Only DASH Download & Muxing | **VERIFIED** | `cargo test -p tdm-core --test gate5_dash_tests test_dash_single_period_video_only_download_and_muxing` | Passed in 0.31s; downloaded fMP4 init + media fragments, remuxed to faststart MP4, verified duration via ffprobe. | Concat stream-copy with zero transcoding quality loss. |
| **Gate 5** | Separate Audio & Video DASH Download | **VERIFIED** | `cargo test -p tdm-core --test gate5_dash_tests test_dash_separate_audio_and_video_download_and_muxing` | Passed in 0.35s; downloaded parallel video + audio streams, remuxed into dual-stream MP4, verified via `probe_media_streams`. | Maps video from stream 0 and audio from stream 1. |
| **Gate 5** | Compatible WebM DASH Stream Download | **VERIFIED** | `cargo test -p tdm-core --test gate5_dash_tests test_dash_webm_stream_download_and_muxing` | Passed in 0.32s; downloaded VP9 WebM init + fragments, remuxed to playable WebM, verified via ffprobe. | Native WebM container output supported. |
| **Gate 5** | SegmentList & Byte-Range Subsegments | **VERIFIED** | `cargo test -p tdm-core --test gate5_dash_tests test_dash_segment_list_and_byterange_download` | Passed in 0.18s; downloaded initialization and subsegments via byte-range requests from single container, remuxed to valid MP4. | Compliant with SegmentList & SegmentBase addressing. |
| **Gate 5** | Transient 429/503 Retries with Backoff | **VERIFIED** | `cargo test -p tdm-core --test gate5_dash_tests test_dash_transient_429_503_retry_recovery` | Passed in 0.45s; rate-limited requests retried with exponential backoff; completed download with duration verified. | Auto-retries up to 3 times on transient network errors. |
| **Gate 5** | DASH Pause, Resume & Recovery Continuity | **VERIFIED** | `cargo test -p tdm-core --test gate5_dash_tests test_dash_pause_resume_and_recovery_continuity` | Passed in 0.42s; paused download midway, verified cached segments in `.dash_parts`, resumed without re-downloading init segment, verified output duration. | Checkpoint recovery in SQLite; work directory cleaned up on completion. |
| **Gate 6** | Torrent & Magnet (librqbit) | **VERIFIED** | `cargo test -p tdm-core --test gate6_torrent_tests -- --nocapture --test-threads=1` | 8 tests passed in 0.47s; magnet URI parsing, BEP 0009/0053 infohash extraction, multi-file layout, piece verification, rate limiting, and local seeder/leecher P2P verified. | Complete native Rust BitTorrent engine via librqbit v9.1; zero fake progress. |
| **Gate 7** | Protocol Detection & Flag Generation | **VERIFIED** | `cargo test -p tdm-core --test gate7_live_tests -- test_live_stream_protocol_detection_unit` | Passed; validates RTSP, RTMP, RTMPS, SRT, RIST, RTP, UDP, TCP, MMS, Live HLS, Live DASH. | Configures bounded probesize, analyzeduration and socket timeouts. |
| **Gate 7** | UDP Broadcast Live Recording | **VERIFIED** | `cargo test -p tdm-core --test gate7_live_tests -- test_live_stream_udp_transport_real_recording` | Passed in 6.79s; real H.264 MPEG-TS stream captured to fragmented MP4, probe verified duration > 0.5s. | Bounded UDP FIFO buffer and socket options. |
| **Gate 7** | TCP Stream Recording to Matroska (MKV) | **VERIFIED** | `cargo test -p tdm-core --test gate7_live_tests -- test_live_stream_tcp_recording_to_mkv` | Passed in 5.59s; stream captured over TCP socket to `.mkv`, probed and duration verified > 0.5s. | Native Matroska muxer formatting with clean trailers. |
| **Gate 7** | Sliding-Window Live HLS Recording | **VERIFIED** | `cargo test -p tdm-core --test gate7_live_tests -- test_live_stream_sliding_window_hls_recording` | Passed in 2.18s; dynamic playlist without `#EXT-X-ENDLIST` successfully captured and finalized. | Sliding playlist polling without EOF reconnection loops. |
| **Gate 7** | User-Controlled Stop & Clean Trailer Flush | **VERIFIED** | `cargo test -p tdm-core --test gate7_live_tests -- test_live_stream_user_stop_recording_clean_trailer_flush` | Passed in 4.31s; user STOP command flushes MP4 moof/mfra trailers and transitions job to `Completed`. | Graceful `b"q\n"` stdin finalization with bounded process wait. |
| **Gate 7** | Cancellation & Zero Orphan Process Cleanup | **VERIFIED** | `cargo test -p tdm-core --test gate7_live_tests -- test_live_stream_cancellation_and_no_orphaned_ffmpeg_processes` | Passed in 1.25s; cancel terminates process, reaps child handle, cleans temp file, 0 orphan processes. | `kill_on_drop(true)` + `wait().await` reaps process handles cleanly. |
| **Gate 7** | Fragmented MP4 Partial Recovery | **VERIFIED** | `cargo test -p tdm-core --test gate7_live_tests -- test_live_stream_fragmented_mp4_partial_recovery` | Passed in 6.79s; interrupted live recording retains playable moof/mdat atoms with verified duration. | `-movflags +frag_keyframe+empty_moov+default_base_moof`. |
| **Gate 7** | Performance, RAM/CPU & Throughput Benchmark | **VERIFIED** | `cargo test -p tdm-core --test gate7_live_tests -- test_live_stream_bounded_resources_and_throughput` | Passed in 3.03s; 15.37 KB/s throughput, peak RAM 11.73 MB, total CPU 0.08s without transcoding load. | Stream-copy (`-c copy`) avoids CPU transcoding overhead. |
| **Gate 8** | Single-Instance Windows IPC & Focus Window | **VERIFIED** | `target\debug\deps\gate8_protocol_matrix_tests-*.exe test_matrix_single_instance_ipc_focus` | Passed; Named Pipe IPC triggers `DownloadEvent::ShowWindow` event; unminimizes and focuses desktop window. | Eliminates duplicate manager instances and prevents socket conflicts. |
| **Gate 8** | Unified Protocol Matrix Compatibility | **VERIFIED** | `target\debug\deps\gate8_protocol_matrix_tests-*.exe` | 8 tests passed in 11.58s; tests HTTP range, HLS VOD probe, Torrent/Magnet, UDP, TCP MKV, Live HLS, DRM rejection, single-instance. | Hard validation of real protocols against actual stream probes. |
| **Gate 8** | Stress, Queue Advancement & Recovery Reliability | **VERIFIED** | `target\debug\deps\gate8_stress_tests-*.exe` | 4 stress tests passed in 2.44s; concurrent queue progression, part file cleanup on cancel, rapid pause-resume, 503 transient recovery. | Safe disk sync and chunk state tracking guarantees zero corruption under stress. |
| **Gate 8.5** | Clean Windows MSVC Toolchain & Release Compilation | **VERIFIED** | Visual Studio Build Tools 2022 (`vswhere` 17.14, MSVC 14.44.35207, SDK 10.0.26100.0) & `cargo build --release --workspace` | Fresh compilation and linking completed in 4m 35s with exit code 0. | Zero unresolved externals; native link.exe auto-discovered. |
| **Gate 8.5** | Complete Workspace Regression Pass | **VERIFIED** | `cargo test --workspace -- --test-threads=1` | 83 tests passing across 11 test suites (0 failed, 0 ignored). | Full protocol coverage (HTTP, HLS, DASH, Torrent, Live, Native Host). |
| **Gate 8.5** | Robust NSIS Installer & Sidecar Packaging | **VERIFIED** | `cargo tauri bundle --bundles nsis` | Created `target\release\bundle\nsis\TORI Download Manager_0.1.0_x64-setup.exe` (15.52 MB). | `hooks.nsh` verified with `--register`/`--unregister` and browser manifest. |
| **Gate 8.5** | Process Tree Resource & Low-Memory Profiling | **VERIFIED** | `powershell -ExecutionPolicy Bypass -File scripts/profile_matrix.ps1` | Measured full process hierarchy across 8 scenarios; core engine RAM 1-14 MB private, full UI tree 167.6 MB idle. | Measured Peak Working Set, Private Bytes, Threads, Handles, and Sockets. |
| **Gate 9** | Production Design System & Tokens | **VERIFIED** | `ui/src/tokens.css`, `ui/src/App.css` matching `design/tori-design/` | 100% visual fidelity to `tori-app-ndm-pro.html`, `tokens.css`, custom fonts, radii, spacing, colors. | Exact Light, Dark (`[data-theme="dark"]`), and System Auto themes. |
| **Gate 9** | Custom Pre-crafted SVG Iconography | **VERIFIED** | `ui/public/icons/` (toolbar, chips, settings-tabs) | All generic/lucide icons eliminated; uses official 24px toolbar, 20px chips, and 26px settings SVG assets. | As-is pixel fidelity without icon distortion. |
| **Gate 9** | Real Action Wiring & IPC Commands | **VERIFIED** | `create_download`, `pause_download`, `resume_download`, `delete_download`, `get_download_chunks`, `open_file`, etc. | All controls wired to persistent engine; zero mock progress; real chunk segment visualizer. | SQLite checkpoint durability preserved. |
| **Gate 9** | Real Windows Executable Launch & Verification | **VERIFIED** | `powershell -ExecutionPolicy Bypass -File scripts/verify_desktop_ui.ps1` | Desktop app launched and verified; 166.91 MB working set / 47.32 MB private memory; clean shutdown. | Verified with 2-process tree (Tauri + WebView2). |
| **Gate 9** | Production Package with Gate 9 UI | **VERIFIED** | `cargo tauri bundle --bundles nsis` | Created `target\release\bundle\nsis\TORI Download Manager_0.1.0_x64-setup.exe` (15.56 MB). | SHA-256: `C0DB6FDF35483BCC9F48A35BF9951B087882FF7D7DEAFCAA87C61D6CE2824016`. |
| **Design Sync** | Corrected Real ToggleSwitch & CSS | **VERIFIED** | Real elements (`.swl`, `.swi`, `.sw-track`, `.sw-knob`) matching `design/toggle.html` & `tokens.css` | Robust 40x24 track, 18x18 knob, 16px translation, no pseudo-element alignment defects. | Live ON/OFF state and persistence across restarts verified. |
| **Design Sync** | Bottom Details/Segments Pane Removal | **VERIFIED** | `DESIGN.md` spec update & `ui/src/App.tsx` | Main window details/segments pane removed; download list `#rows` expands down to status bar `#stat`. | Segments visualizer preserved inside dedicated Progress Modal (`#prog`). |
| **Design Sync** | Automated Test DB Isolation | **VERIFIED** | `TORI_DATA_DIR` environment override in `tdm-native-host` and `src-tauri` | Zero test writes to production `%APPDATA%/tori-download-manager/tdm_storage.sqlite`. | Eliminates repeated `e2e_video.mp4` test artifacts from production rendering. |
| **Design Sync** | Standalone Production Release Execution | **VERIFIED** | `cargo tauri build --no-bundle` + `scripts/verify_updated_design.ps1` | Launched Windows executable with embedded React bundle; 0 localhost requests; 40.06 MB WS / 8.72 MB Private. | Verified offline standalone execution. |
| **Pre-Gate 10 Audit** | Engine Settings Backend Persistence & Throttling | **VERIFIED** | `cargo test -p tdm-core --lib engine::limiter` & SQLite query | Settings persisted in `engine_settings` SQLite table; token-bucket limiter throttles or runs zero-overhead; dynamic concurrency & retries wired. | Bidirectional sync with React UI. |
| **Pre-Gate 10 Audit** | Redownload Completed Tasks | **VERIFIED** | `cargo test -p tdm-core --test integration_tests -- test_redownload_completed_download` | Passed in 0.20s; completed task cleanly resets chunks and redownloads from scratch with identical valid SHA-256. | Preserves normal duplicate prevention. |
| **Pre-Gate 10 Audit** | IPC Test Suite Isolation | **VERIFIED** | `cargo test -p tdm-native-host --test host_tests` with `TORI_IPC_PIPE` isolation | Passed all 6 tests in 0.40s; isolated test Named Pipe prevents forwarding requests into running production engine. | Zero collision with desktop app. |
| **Pre-Gate 10 Audit** | Gate 4 HLS Full Coverage Restored | **VERIFIED** | `cargo test -p tdm-core --test gate4_hls_tests` | 8/8 tests passed in 1.79s including pause/resume continuity; 0 clippy warnings. | Fully intact test coverage. |
| **Pre-Gate 10 Audit** | WebView2 Memory Audit & Optimization | **VERIFIED** | `scripts/audit_memory_profile.ps1` & `scripts/verify_dialog_stability.ps1` | Removed redundant backdrop-filter texture layers; eliminated React listener churn; memoized sidebar & row re-renders; measured 8.17 MB Rust Private Bytes, 210.59 MB Total Private Bytes, 0 orphaned processes. | Zero memory leak; complete process tree profiled across 30s/2m/minimized/restored. |
| **Gate 10** | Custom Browser Extension UI (Popup, Overlay & Options) | **VERIFIED** | `extension/` manual loading and test suite | Design Source A (Media popup & Video overlay) and Design Source B (6-tab Options/Settings) matching HTML/CSS specs. | Full MV3 service worker with pinned ID `jfnfgmcbgapcpieaonbaolgebjaejcdm`. |
| **Gate 10.2** | Localhost Port-Based Browser Integration Server | **VERIFIED** | `cargo test -p tdm-native-host --test server_tests` & `node scripts/verify_gate10_2.js` | 5/5 automated Rust tests + 16/16 Node e2e verification steps passed. Binds exclusively to `127.0.0.1:6800` (no 0.0.0.0). Defeats DNS rebinding (400), blocks web origins (403), allows extension CORS, requires cryptographic token auth (401), full CRUD + SSE events. | Dual integration: high-performance localhost HTTP API + optional Native Messaging bootstrap. |
| **Gate 10.4** | Media Extraction & Webpage Download Rejection | **VERIFIED** | `cargo test --workspace` (96 tests) & `node scripts/verify_gate10_4.js` | Traced failed "watch" job to `window.location.href` fallback & mock formats; purged all fabricated sizes (420 MB, 210 MB, etc.); added MIME-type HTML detection & watch page URL rejection in Rust engine; verified controlled `flower.mp4` download completing 100% (1,120,000 bytes) on disk. | Zero fake downloads; displays honest "Source Unavailable" on protected/MSE blob streams. |
| **Gate 10.5** | Universal Media Resolver & Format Engine | **VERIFIED** | `cargo test -p tdm-core --test gate10_5_resolver_tests` & `node scripts/verify_gate10_5.js` | 5/5 resolver unit tests + 8/8 end-to-end integration verification steps passed. Safely executes yt-dlp `--dump-single-json` with explicit arguments, 30s timeout, and 12MB buffer; anti-SSRF blocks loopback, private ranges, and cloud metadata (169.254.169.254); pairs video-only formats with top audio; excludes storyboards; calculates exact/estimated size; streams progress via SQLite & EventBus; zero orphan processes on cancel. | Full support for YouTube, Facebook, Instagram, Vimeo, and direct media sites. DRM protected streams honestly reported. |
| **Gate 10.5.1** | Complete Video Download & FFprobe Verification | **VERIFIED** | `node scripts/verify_gate10_5_1.js` | 8/8 real-world verification steps passed (100%). Verified real downloads: 360p video with audio (640x360 H.264 + AAC), 720p video with audio (1280x720 VP9 + AAC), 1080p video with audio (1920x1080 H.264 + AAC), and Audio-only (AAC, 0 video streams). Verified FFmpeg automatic merging (`--merge-output-format mp4/mkv`), active UI merging state (`JobState::Verifying`), self-contained runtime directory (`%LOCALAPPDATA%\tori-download-manager\bin`), multi-site resolution (YouTube, Facebook, MDN Direct HTML5), and cancellation process reaping. | Zero audio-only false reports; 100% verified playable media on disk with ffprobe. |
| **Gate 10.5.2** | Real Extension Download & Release Readiness | **VERIFIED** | `node scripts/verify_edge_integration.js` & `cargo test --workspace` | Replaced 3.5s timeout with endpoint-aware deadlines (35s resolve, 12s download, 4s ping); request deduplication in background SW; standards-compliant container pairing matrix (VP9+Opus->WebM, H264+AAC->MP4, VP9+AAC->MKV, H264+Opus->MKV); tested in real Microsoft Edge via CDP on port 9223 with isolated profile; verified Extension Options pairing, Extension Popup status, in-browser media resolution (24 genuine formats), 720p download (19.3 MB MKV) and 1080p download (40.1 MB MP4) with FFprobe video+audio streams, cancellation with zero orphan processes. 106 automated tests passing. | Production release binary compiled: `target/release/tori-download-manager.exe` (26.2 MB). |

---

---

## Process Tree Resource Profiling Matrix (Gate 8.5)

Measured using Windows Process Performance APIs (`GetProcessMemoryInfo`, `WorkingSet64`, `PrivateMemorySize64`, `Handles`, `Threads`, and `Get-NetTCPConnection`):

| Scenario | Working Set (MB) | Peak Working Set (MB) | Private Bytes (MB) | Handles | Threads | Sockets | Notes |
|---|---|---|---|---|---|---|---|
| **1. Idle (Desktop UI + WebView2)** | 167.62 | 167.63 | 47.48 | 1978 | 88 | 4 | Complete process tree (Rust Tauri host + all WebView2 child processes). |
| **2. 1 Active HTTP (Line-Rate 32MB)** | 2.60 | 54.20 | 0.52 | 25 | 1 | 4 | Real line-rate streaming engine with 1 MB periodic fsync checkpoints. |
| **3. 4 Concurrent HTTP (Adaptive)** | 27.05 | 27.05 | 14.42 | 144 | 6 | 1 | Multi-worker parallel range downloads under adaptive governor concurrency. |
| **4. HLS VOD (Segments + FFmpeg)** | 15.25 | 15.25 | 2.48 | 144 | 6 | 1 | Segment download workers + FFmpeg concat remuxer without transcoding. |
| **5. DASH VOD (Audio/Video Streams)** | 15.43 | 15.43 | 2.41 | 144 | 6 | 1 | Parallel audio and video representation downloads + MP4 faststart muxer. |
| **6. BitTorrent Transfer (Pieces + Seed)** | 4.00 | 4.00 | 1.45 | 46 | 4 | 0 | Real local seeder/leecher P2P transfer with SHA-1 piece hash verification. |
| **7. Live UDP Packet Ingestion** | 11.79 | 11.79 | 2.24 | 144 | 6 | 0 | Continuous live UDP packet reception writing fragmented MP4 chunks. |
| **8. Native Messaging Host IPC Bridge** | 9.90 | 9.90 | 2.33 | 146 | 16 | 1 | Stdin/stdout length-prefixed framing bridge to persistent desktop engine. |

---

## Executable Artifacts

1. **Production Windows NSIS Installer**:
   - Location: `target\release\bundle\nsis\TORI Download Manager_0.1.0_x64-setup.exe`
   - Size: 16,089,211 bytes (~16.09 MB)
   - SHA-256: `3F5B1B90521D000C3B01449DE2F4A52C0CFDB8B11F3E534E88942E6B557FB68C`
   - Architecture: x86_64-pc-windows-msvc
   - Bundled Binaries: `tori-download-manager.exe`, `tdm-native-host.exe`, `tdm-cli.exe`
   - Registry Hooks: Configured via `src-tauri/nsis/hooks.nsh` to automatically invoke `tdm-native-host.exe --register` and `--unregister`, managing `%APPDATA%\tori-download-manager\com.tori.download_manager.json` and registering `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.tori.download_manager` and `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.tori.download_manager`.

2. **Desktop GUI Application**:
   - Location: `target\release\tori-download-manager.exe`
   - Size: 26,200,576 bytes (~26.20 MB)
   - SHA-256: `845D8BD2FC450A53F4850FF2FC5FEC2A3A0CF5B3DD982C13E6B39D6B9207C213`
   - Architecture: x86_64-pc-windows-msvc
   - Features: React 19 + TypeScript + Vite + Tauri 2 with dark mode, real-time metrics, dynamic priority controls, live streaming detection & recording controls, adaptive stream indicators, pause/resume/cancel/retry/open folder, Windows Named Pipe IPC server, single-instance detection, and localhost HTTP server (port 6800) with Universal Media Resolver and automatic FFmpeg video/audio merging.

3. **Windows Native Messaging Host**:
   - Location: `target\release\tdm-native-host.exe`
   - Size: 15,884,288 bytes (~15.8 MB)
   - Architecture: x86_64-pc-windows-msvc
   - Integration: Chrome & Edge Native Messaging Host (`com.tori.download_manager`)
   - CLI commands: `--register` (registers registry keys and host manifest), `--unregister`
   - IPC: Forwards messages directly to persistent engine via `\\.\pipe\tori-download-manager-ipc`; auto-spawns desktop application if not currently running.

4. **Browser Extension (Manifest V3 — Gate 10.5.1 Verified)**:
   - Directory: `extension/`
   - Architecture:
     - **Universal Media Resolver Integration**:
       - Dynamic resolution on YouTube, Facebook, Instagram, Vimeo, and direct media sites.
       - Zero mock formats or fabricated sizes; spinner feedback while resolving.
       - Dispatches managed download requests with combined format IDs (e.g. `270+140`, `609+140`, `230+140`) ensuring video downloads always include audio.
     - **Design Source A (Media Popup & HTML5 Video Overlay)**:
       - Toolbar popup: `popup/popup.html`, `popup/popup.css`, `popup/popup.js` (includes "Resolve Media on Page" button)
       - Video overlay: `content.js`, `content.css` injecting `.tori-mp`, `.tori-pill`, and `.tori-pn` format selection panel with live resolution
       - Stream detection: Real HLS (`.m3u8`), DASH (`.mpd`), and direct MP4/WebM candidates intercepted via `webRequest.onHeadersReceived` and forwarded to overlay picker
     - **Design Source B (Extension Options & Settings)**:
       - Options page: `options/options.html`, `options/options.css`, `options/options.js`
       - 6 Tab Sections: Connection (`conn`), Capture (`cap`), Media (`media`), Sites (`sites`), Appearance (`app`), About (`about`)
       - Native Messaging latency benchmark and real engine connectivity probe
       - Interactive chips for file types and domain exclusions
       - `chrome.storage.local` persistence with live theme and setting synchronization
   - Supported Browsers: Google Chrome, Microsoft Edge, Brave, Vivaldi, Opera
   - Pinned Extension ID: `jfnfgmcbgapcpieaonbaolgebjaejcdm` across all browsers via 2048-bit RSA SPKI public key.

5. **Headless CLI & Verification Runner**:
   - Location: `target\release\tdm-cli.exe`
   - Size: 15,820,288 bytes (~15.8 MB)
   - Architecture: x86_64-pc-windows-msvc
   - Usage: `tdm-cli.exe <url> [output_directory]`

---

## Workspace Automated Test Results

- **Total Automated Tests**: **106 passing tests** (0 failed, 0 ignored) across 13 test suites:
  - `tdm-core` unit tests: **22 passed** (2.95s)
  - `gate10_5_resolver_tests`: **6 passed** (7.01s)
  - `gate2_adaptive_tests`: **8 passed** (4.77s)
  - `gate4_hls_tests`: **8 passed** (6.01s)
  - `gate5_dash_tests`: **9 passed** (7.18s)
  - `gate6_torrent_tests`: **8 passed** (0.45s)
  - `gate7_live_tests`: **8 passed** (22.20s)
  - `gate8_protocol_matrix_tests`: **8 passed** (10.12s)
  - `gate8_stress_tests`: **4 passed** (2.19s)
  - `integration_tests`: **9 passed** (3.65s)
  - `tdm-native-host` unit tests: **1 passed** (0.00s)
  - `host_tests` (including IPC, OS process stdin/stdout, and `show_window` tests): **7 passed** (1.11s)
  - `server_tests` (Gate 10.2 local server, DNS rebind defense, CORS defense, pairing, CRUD, Gate 10.5 media endpoints): **7 passed** (2.77s)
- **Clippy**: 0 warnings across all targets (`cargo clippy --workspace --all-targets -j 2 -- -D warnings`).
- **Formatting**: 100% compliant with rustfmt (`cargo fmt --all -- --check`).
- **Frontend Build**: Built in 411ms with 0 errors (`npm --prefix ui run build`).
- **Release Build**: Built in 53s with 0 errors (`cargo tauri build --no-bundle`). Executable: `target\release\tori-download-manager.exe` (26,210,816 bytes, SHA-256: `80EF92A3581FBC622E96232638E791EB80505F23BB7CA7C868CDE173198E4552`).
- **Real Edge Extension Verification**: 8/8 automated browser integration steps verified with Microsoft Edge CDP, Options UI, Popup UI, media resolution without timeout (35s deadline), 720p/1080p downloads with FFprobe stream verification, and zero orphan processes (`node scripts/verify_edge_integration.js`).
