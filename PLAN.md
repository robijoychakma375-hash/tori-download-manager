# TORI Download Manager — Gate 12.9.2 Execution Plan
## Full Browser-to-File Media Download Verification — [STATUS: 100% VERIFIED]

### Milestone Objective
Verify the complete workflow from browser playback and media discovery through the TORI download engine to a completed, playable output file validated with `ffprobe.exe`, without starting Gate 13:

1. **Step 1: Complete Media Download Pipelines (End-to-End File Output) [VERIFIED]**
   - **Direct MP4:** Enqueued download, downloaded CC0 sample (`flower.mp4`, 1,128,375 bytes), validated with `ffprobe` (h264, 960x540, aac, 5.05s).
   - **Direct WebM:** Enqueued download, downloaded CC0 sample (`flower.webm`, 554,058 bytes), validated with `ffprobe` (vp8, 960x540, vorbis, 5.06s).
   - **HLS VOD (.m3u8):** Enqueued download, downloaded all TS segments, remuxed to MP4 with FFmpeg stream-copy (`-c copy`), validated with `ffprobe` (h264, 640x360, aac, ~2.0s).
   - **DASH VOD (.mpd):** Enqueued download, downloaded fragmented MP4 video and audio segments, multiplexed into MP4 with FFmpeg stream-copy, validated with `ffprobe` (h264 + aac, ~2.0s).
   - **HTML5 Embedded & Iframe Players:** Tested candidate stream handoff from HTML `<video>` and iframe to full downloaded file.
   - **Public Media (yt-dlp):** Downloaded real public video, muxed streams, and validated file with `ffprobe`.
   - Recorded exact duration, resolution, codecs, audio presence, file size, download success in test reports.

2. **Step 2: Real Browser Extension End-to-End Verification [VERIFIED]**
   - Tested in Microsoft Edge with real browser playback:
     - Player detection during video playback.
     - Correct tab and frame association (`all_frames: true`).
     - Network candidate interception via `webRequest`.
     - Overlay visibility and positioning (`.tori-mp` / `.tori-pill`).
     - Extension popup resolver request & format display.
     - Browser-to-desktop job handoff via REST API `/api/v1/media/download` & Native Messaging.
     - Destination folder resolution and category sorting.
     - Download progress and completion.
     - Thumbnail extraction and persistence.
   - Captured real browser playback screenshot: `design/gate12_9_2_browser_overlay_verified.png`.

3. **Step 3: Multi-Strategy Fallback & Failure Isolation [VERIFIED]**
   - Proved failure of `yt-dlp` unsupported URL on generic page fast-fails in <2.3s and does not block candidate streams.
   - Verified proper deduplication and ranking by resolution (height) and bitrate.
   - Confirmed terminal error states without infinite spinners.

4. **Step 4: Evaluate Optional Streamlink Integration [VERIFIED]**
   - Probed Streamlink runtime status; Streamlink not present on machine (`where.exe streamlink` returns exit code 1).
   - `find_streamlink()` returns `None`; `probe_streamlink()` gracefully returns empty list with 0ms penalty.
   - Accurately documented as unverified rather than claiming real-world success.

5. **Step 5: Verify Production FFmpeg Dependencies & Packaging [VERIFIED]**
   - Audited discovery paths in `find_ffmpeg()` and `find_ffprobe()` across PATH, WinGet package directory, and sidecar directory (`%LOCALAPPDATA%\tori-download-manager\bin`).
   - Documented requirements for clean Windows installs without developer PATH or WinGet (bundling `ffmpeg.exe` and `ffprobe.exe` in application `bin/`).

6. **Step 6: Full Regression Protection & Deliverables [VERIFIED]**
   - `cargo fmt --all -- --check` (PASSED).
   - `cargo clippy --workspace --all-targets -- -D warnings` (PASSED).
   - `cargo test --workspace` (PASSED - all 142 tests passing).
   - `npm --prefix ui run build` (PASSED).
   - `cargo tauri build --no-bundle` (PASSED - 28,064,768 bytes, SHA-256 `A433AE96...`).
   - `powershell -ExecutionPolicy Bypass -File scripts\verify_production_release.ps1` (PASSED - 15/15 checks).
   - Delivered `GATE12_9_2_END_TO_END_DOWNLOAD_REPORT.md` (and copy to artifact directory).
   - Updated `IMPLEMENTATION_STATUS.md`.
