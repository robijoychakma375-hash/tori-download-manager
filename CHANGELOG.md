# Changelog

All notable changes to **TORI Download Manager** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.0.1] â€” 2026-11-10

### Major Reliability, Cross-Browser & Performance Release

#### Added
- **Mozilla Firefox Companion Extension (MV3):** Dedicated Manifest V3 add-on officially signed by Mozilla AMO (`tori-download-manager-firefox-v1.0.2.xpi`) with Gecko ID `tori-download-manager@toridm.org` and 0 linter warnings.
- **Native Time-Based Download Scheduler:** Event-driven zero-polling scheduler powered by Tokio `Notify` and SQLite schema persistence (`scheduled_at`), with startup overdue catch-up and native UI date/time picker.
- **Close-to-Tray & System Tray Controls:** Main window close button hides to the Windows System Tray; tray context menu includes Show/Hide, live active download count, Pause All, Resume All, and exit protection dialog for active downloads.
- **Adaptive Streaming Concurrency:** Parallel segment fetching ($C=4$, configurable up to $C=8$) for HLS and DASH VOD streams, yielding up to 4.21x throughput improvement under network latency.
- **Generic Download Interception:** Automatic capture of archives, executables, documents, and media redirects in Firefox, Chrome, and Edge, while preserving browser download history shelves.
- **GPLv3 Compliance Documentation:** Bundled full `LICENSE-GPLv3.txt` and `LICENSE-THIRD-PARTY.txt` attributing FFmpeg/FFprobe GPLv3 binaries, yt-dlp, and Rust libraries.

#### Fixed & Hardened
- **Window Close Lifecycle:** Titlebar Close button (X) now cleanly hides the window to the system tray instead of abruptly terminating running downloads and background listeners.
- **Dailymotion Video Player Overlay:** Isolated pointer events and added transport bar clearance (56px bottom margin) to eliminate interference with native player seek/pause controls.
- **BitTorrent Magnet Probing:** Unseeded or resolving magnet links emit `JobState::Probing` ("Connecting to peers...") and fail gracefully after a 60-second metadata timeout instead of stalling at 0%.
- **Crash Recovery & Validator Safety:** Automatic detection of changed ETags, Last-Modified timestamps, or Content-Lengths resets stale chunk plans, guaranteeing byte-perfect resumes.
- **Memory Trimming:** Immediate working set memory trimming invoked on titlebar minimize and tray hide, dropping resident memory footprint from ~500 MB to under 32 MB.

---

## [1.0.0] â€” 2026-11-06

### Initial Public Production Release

#### High-Performance Download Engine
- **HTTP Multipart Partitioned Downloads:** Multi-connection range downloading (up to 32 connections per job) with byte-accurate verification, dynamic chunk allocation, and standards-compliant `If-Range` / `ETag` restart protection.
- **RFC 8216 HLS VOD & Live Streams:** Automated manifest parsing, variant stream selection, concurrent TS/fMP4 segment downloading, and lossless FFmpeg stream-copy remuxing.
- **ISO/IEC 23009-1 MPEG-DASH:** Dynamic and static manifest parsing, representation selection, fragmented audio/video multiplexing.
- **BitTorrent P2P Client:** Fully integrated peer-to-peer downloading powered by `librqbit` with magnet link resolution, piece verification, and background queuing.
- **Resilient SQLite Persistence:** Checkpointing via SQLite WAL journal mode preserving all metadata, chunk boundaries, and partial files across crashes and reboots.

#### Browser Integration (Manifest V3)
- **Chrome & Microsoft Edge Extension:** Native Messaging IPC integration, automatic localhost port auto-discovery (ports 6800â€“6803), cryptographic authentication token management.
- **Multi-Strategy Media Discovery:** Real-time webRequest inspection, DOM media element scraping, HTML5 OpenGraph/Schema.org parsing, and platform extractor fallbacks.
- **Fast-Fail & MIME Discrimination:** Strict MIME validation ensuring only legitimate video and audio streams are presented; skips arbitrary advertising iframes and subtitle tracks.

#### Desktop Application & User Interface
- **Windows System Tray & Background Downloads:** Seamless minimize-to-tray with background download engine persistence and independent floating Download Toast.
- **Interactive Download Toast:** DPI-aware floating progress window with real-time speed, ETA, circular progress ring, and interactive pause/resume/drawer controls.
- **WebView2 Memory Optimization:** Recursive process tree memory trimming via Win32 `SetProcessWorkingSetSize` with 4-second rate-limiting cooldown, reducing idle footprint to ~27 MB physical RAM.
- **Design Tokens & Themes:** 100% faithful implementation of the approved design system with 4 accent themes (Indigo, Ocean, Emerald, Rose) and light/dark modes.

#### Installer & Updates
- **Self-Contained Windows NSIS Installer:** Bundles `tori-download-manager.exe`, `tdm-native-host.exe`, `tdm-cli.exe`, FFmpeg, FFprobe, and yt-dlp for out-of-the-box operation on clean Windows 10/11 machines without developer toolchain prerequisites.
- **Signed Auto-Updater:** Official Tauri v2 updater integration featuring Ed25519 minisign signature verification, user-controlled updates, 24-hour background checking, and active download safety protection preventing restarts during in-flight transfers.

