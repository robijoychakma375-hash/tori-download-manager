# TDM implementation gates — verifiable work, not demo phases

## Gate 0 — Build environment and project integrity

- Discover installed toolchain; create Rust Cargo workspace and desktop app; compile real stub-free core types.
- Establish job schema migrations, structured logs, cancellation primitives and error types.
- **Pass:** `cargo test`, frontend build, Tauri development app launches on Windows; record results.

## Gate 1 — Real HTTP engine integrated into UI (FIRST working release)

- Create task from URL; inspect content; stream an actual remote file into `.tdm-part` then rename after validation.
- For verified 206 servers, implement multiple ranged connections with strict no-overlap writer and full coverage check; otherwise fall back to streaming.
- Implement pause/resume, cancel, retry, persisted checkpoints, restart safety, throughput/ETA and true progress events.
- Implement primary UI: paste URL -> start, status, progress, pause/resume/cancel, open folder, error details, queue.
- **Pass:** actually download known test assets and compare known SHA-256, including deliberate app crash/restart, 200-only server and ETag change. Build usable Windows executable.

## Gate 2 — Queue, resources and adaptive scheduling

- Global/per-host concurrency limits; priorities; fair scheduling; bandwidth cap; retry budgets.
- Dynamic pending-range stealing (not simultaneous overlapping writes); adaptive network concurrency based on measured benefit, not fixed thread count.
- **Pass:** parallel jobs with constrained RAM/disk usage and correct bytes, no starvation or corruption; record observed throughput and memory.

## Gate 3 — Chrome/Edge extension (REAL integration)

- MV3 URL observation with permissions, candidate registry, MP4/WebM/audio/HLS/DASH detection.
- Native Messaging helper registration/installer support, validated local IPC, direct download from popup or visible overlay where feasible.
- Do not force quality-selection scans. Respect permission, auth, browser-origin and DRM boundaries.
- **Pass:** actual browser -> extension -> desktop -> saved real file; browser restart and extension worker shutdown tests.

## Gate 4 — HLS VOD

- Master/media playlists, media groups, initialization maps, byte ranges, discontinuities, subtitles when available and authorized access.
- Correct TS and fMP4 output; FFmpeg on-demand remux if necessary.
- **Pass:** independently playable files with duration, video, audio, expected segment coverage and interrupted download recovery.

## Gate 5 — DASH VOD

- MPD Period/AdaptationSet/Representation and SegmentTemplate/Timeline/List/Base variants; audio-video mux and duration validation.
- **Pass:** real fixtures including separate audio/video and initialization segments; correct playback.

## Gate 6 — Torrent and magnet

- Integrate maintained `librqbit`/rqbit library; shared job/events and resource policy; piece verification, pause/resume.
- **Pass:** verified file from legal test torrent/magnet, cross-restart resume and correct hash.

## Gate 7 — Live streams and advanced network

- FFmpeg adapters for RTSP/RTMP/RTP/UDP/SRT/RIST/MMS, checking protocol support actually available in selected build. Recording end condition, output and reconnect semantics.
- Optional proxy, HTTP/3, DoH, mirror failover only if performance, compatibility and security tests justify them.
- **Pass:** available protocol adapter recorded on real supported stream to playable file; one test per claimed protocol.

## Gate 8 — Production hardening

- Installer and extension native-host registration; recovery tests, upgrade/migration tests, license compliance, installer/uninstaller, diagnostics, crash reports (privacy-preserving), memory/CPU benchmarks.
- **Pass:** release build and installer run on a clean supported Windows machine. No unsupported feature marketed as implemented.

## Explicitly postponed / excluded from the hot path

- Mandatory yt-dlp or quality-scanning stage, unneeded re-encoding, permanent FFmpeg processes, high-frequency database updates, heavy animated UI, cross-domain mirror stitching without identity checks, DRM circumvention.
