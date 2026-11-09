# TORI Download Manager v1.0.1 — Release Notes

**Release Version:** 1.0.1  
**Internal Protocol / API Version:** 2.0.0  
**Target Platform:** Windows 10 & Windows 11 (x64 AMD64)  
**Binary Architecture:** `x86_64-pc-windows-msvc`  
**Release Date:** November 2026  

---

## Welcome to TORI Download Manager v1.0.1

TORI Download Manager v1.0.1 is a major reliability, cross-browser, and performance update to the high-speed Windows desktop download engine. This release introduces complete **Mozilla Firefox** browser integration, an event-driven **Native Time-Based Scheduler**, bounded **Adaptive Streaming Concurrency** ($C=4$), advanced **Crash & Validator Recovery**, and process-tree **Memory Trimming**.

---

## Key Highlights & New Capabilities

### 1. Full Mozilla Firefox Integration (Manifest V3)
- **Dedicated Firefox Extension:** Native Manifest V3 extension built for Mozilla Firefox 142+, adhering strictly to Mozilla's event page architecture (`background.scripts`).
- **Official Mozilla Linter Compliance:** Verified with official `web-ext lint` reporting **0 errors and 0 warnings**.
- **Dual Native Messaging Manifests:** Automatic registration of `com.tori.download_manager.firefox.json` (`allowed_extensions`) and `com.tori.download_manager.json` (`allowed_origins`) in Windows registry hives.
- **Local API Origin Security:** Hardened localhost API with strict 36-character UUID origin validation (`moz-extension://<uuid>`) and SHA256-based random token authentication.
- **Seamless Fallback:** If Native Messaging is unregistered or unavailable, the extension automatically routes requests through the secure Local API without interrupting downloads.

### 2. Native Time-Based Download Scheduler
- **Zero-Polling Precision Timing:** Integrated dynamic sleep calculation and `tokio::sync::Notify` event loop in Tokio, consuming zero CPU cycles while idle.
- **Persistent SQLite Scheduling:** Schema extended with `scheduled_at TEXT` and indexed for instant lookups.
- **Startup Catch-Up:** Overdue scheduled tasks automatically transition to `Queued` upon application launch and execute in priority order.
- **Intuitive UI Controls:** "Schedule for later ⏰" picker with native date/time validation, past-time prevention, table badges, and context menu actions ("Start Download Now", "Reschedule download…").

### 3. Adaptive Streaming Concurrency & Performance
- **Bounded Parallel Segment Streaming:** Replaced sequential segment fetching with bounded concurrent fetching ($C=4$, configurable up to $C=8$ via `TORI_STREAM_CONCURRENCY`) for HLS and DASH VOD streams.
- **Empirical 4.2x Speedup:** Measured 4.21x throughput improvement under realistic 50ms network RTT without increasing memory footprint.
- **AES-128 Key Pre-Fetching:** Eliminates redundant key requests by fetching unique crypto keys once per stream.
- **Strict Memory Bounding:** Segments stream directly to disk without intermediate in-memory buffer accumulation ($O(C \times S)$ RAM bounds).

### 4. Hardened Crash Recovery & Validator Safety
- **Unexpected Crash Recovery:** Interrupted transfers due to unexpected power loss or process kill (`kill -9`) safely transition to `paused` on startup and resume byte-perfect.
- **Resource Validator Invalidation:** Automatically detects changed ETags, Last-Modified timestamps, or Content-Lengths on resume, purging stale chunks and resetting chunk plans to prevent corrupted merges.
- **Transient Network Backoff:** Exponential backoff and auto-retry on HTTP 429 and 503 server responses.
- **Continuous Workload Stability:** Verified in 20.9-minute continuous stress workload with zero memory drift and 0 orphan companion processes.

### 5. Memory Optimization & Titlebar Trimming
- **Working Set RAM Trimming:** Minimizing the window to the system tray triggers immediate process-tree working set trimming, reducing physical RAM from ~500 MB to under 32 MB (over 90% physical memory reduction).
- **Zero Resource Leaks:** Sustained repeated modal opening, toast creation, and download cycles with stable handle counts.

---

## Bug Fixes & Refinements

- **Unicode Boundary Panic Fix:** Fixed a multi-byte UTF-8 character boundary truncation issue in `crates/tdm-core/src/engine/probe.rs` preventing Rust panics on multi-byte international filenames.
- **Percent-Decoding Improvements:** Upgraded URL path segment decoding to standard `percent_decode_str`, preserving literal `+`, `&`, and `=` symbols in filenames.
- **DASH Manifest Classification:** Resolved manifest misclassification in `extension/background.js` where `application/dash+xml` was evaluated in the HLS block.
- **DOM Overlay Decoupling:** Fixed video overlay injection in `extension/content.js` to prevent parent container blocking on complex video players.
- **Thumbnail Process Optimization:** Restricted background FFmpeg thumbnail extraction strictly to recognized video extensions, preventing wasted CPU cycles on archive and document downloads.

---

## Supported Platforms & Prerequisites

- **Operating System:** Windows 10 (64-bit, Version 1809 or higher) or Windows 11 (64-bit).
- **Runtime Component:** Microsoft Edge WebView2 Runtime (pre-installed on Windows 10/11; automatically utilized by the Tauri desktop shell).
- **Supported Browsers:**
  - Microsoft Edge (Version 110+)
  - Google Chrome (Version 110+)
  - Mozilla Firefox (Version 142+)
  - Brave, Opera, Vivaldi, and Chromium-based browsers (Manifest V3)

---

## Known Limitations & Technical Scope

1. **DRM & Encrypted Content:** DRM-encrypted streams (Widevine, PlayReady, FairPlay) such as Netflix, Spotify, or `watch.plex.tv` are strictly unsupported and rejected with status 422 (`protected_media`).
2. **Login & Scraper Anti-Bot Walls:** Media behind mandatory user authentication or anti-scraping challenges (e.g. private Instagram/Facebook feeds) cannot be fetched without direct media URLs or authenticated browser sessions.
3. **Windows Authenticode Signing:** This release candidate is cryptographically signed with Minisign Ed25519 for internal auto-updates, but does not yet include a commercial EV Authenticode certificate. Windows SmartScreen may present an informational notice on first launch until public distribution certificates are applied.

---

## Installation & Verification Guide

### 1. Installing TORI Download Manager
1. Download `TORI Download Manager_1.0.1_x64-setup.exe`.
2. Run the installer. Default installation directory: `%LOCALAPPDATA%\Programs\TORI Download Manager`.
3. The installer automatically registers the Native Messaging hosts for Google Chrome, Microsoft Edge, and Mozilla Firefox.
4. Launch TORI from the desktop shortcut or Start Menu.

### 2. Installing Browser Extensions
- **Mozilla Firefox:** Install `tori-download-manager-firefox-v1.0.1.zip` via `about:debugging` (temporary) or install the signed `.xpi` once released on addons.mozilla.org (AMO).
- **Microsoft Edge / Google Chrome:** Load unpacked `extension/` or install `tori-download-manager-extension-v1.0.1.zip` via developer mode in `edge://extensions` or `chrome://extensions`.

### 3. Verifying File Integrity (SHA-256)
Open PowerShell and run:
```powershell
Get-FileHash -Algorithm SHA256 "TORI Download Manager_1.0.1_x64-setup.exe"
```
Compare the output against `SHA256SUMS.txt`:
```
8b508081c6c9a69cd61958aabb8bac1e5afa6f536eaceb072fd027dcdeb0db60  TORI Download Manager_1.0.1_x64-setup.exe
49908906f1627c6a3bc912e76c85f3be08a36cc3b47ffc622007adc93979c9cb  TORI Download Manager_1.0.1_x64-setup.exe.sig
515e030fc889e22eaefda40bccba82361ceff8f7f6d5202aa2f1b255f86897a7  tori-download-manager-firefox-v1.0.1.zip
7efa4f4a3a5a21b5bfc2561ba9ccdc1cfb7108c7cb63b6e4f1d56c6ae0a7f820  tori-download-manager-extension-v1.0.1.zip
```
