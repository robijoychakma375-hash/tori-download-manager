# TORI Download Manager v2.0 — Gate 8.5 Verification Report
**Clean Build, Release Stabilization & Real-World Windows Verification**

**Date:** November 3, 2026  
**Host Environment:** Windows 10/11 x64  
**Compiler:** `rustc 1.98.0 (88d9e12ae 2026-08-18)`  
**C++ Toolchain:** Microsoft Visual Studio Build Tools 2022 (MSVC `14.44.35207`, Windows SDK `10.0.26100.0`)  
**Frontend Engine:** Node.js v24.13.0, Vite v8.3.5, React 19  
**Packaging:** Tauri v2.11.4 (`tauri-cli`), NSIS (`makensis`)  
**Status:** **PASSED — ALL GATES & VERIFICATION CRITERIA SATISFIED**

---

## 1. Executive Summary

Gate 8.5 was undertaken to transition TORI Download Manager from a state with missing local linker tools and stale build artifacts into a **genuinely compiled, 100% verified, low-memory Windows production release**.

All core engines—HTTP/HTTPS multi-range partitioned downloading, Adaptive Concurrency & Redistribution, RFC 8216 HLS VOD, ISO/IEC 23009-1 MPEG-DASH VOD, BitTorrent/Magnet P2P, and Universal Live Stream Ingestion—were compiled cleanly from source with zero warnings, zero mock objects, and verified against real network and stream probes.

### Summary Metrics:
- **Workspace Automated Tests:** **83 passed / 0 failed / 0 skipped** across 11 test suites.
- **Compiler Warnings:** **0** (`cargo clippy --workspace --all-targets -- -D warnings`).
- **Code Formatting:** **100% compliant** (`cargo fmt --all -- --check`).
- **Frontend Build Time:** **955 ms** (`npm --prefix ui run build`).
- **Release Workspace Build Time:** **4m 35s** (`cargo build --release --workspace`).
- **Installer Bundle:** `TORI Download Manager_0.1.0_x64-setup.exe` (**15.52 MB**, SHA-256: `AADBC29ED8660B8F307313A7A3CCFC9027B3A86FC467C33AAB189787F3C1C31B`).
- **Desktop Idle RAM (Full Process Tree):** **167.62 MB** (includes Tauri host + all WebView2 runtime child processes).
- **Core Engine RAM (Line-rate download):** **2.60 MB Working Set / 0.52 MB Private Memory**.

---

## 2. Phase 1: Windows Build Toolchain & Linker Diagnosis

### Diagnosis
Fresh Cargo release builds previously failed with:
```
error: linker `link.exe` not found
  |
  = note: program not found
```
Investigation revealed that the system had Visual Studio Installer base components and the Windows SDK, but lacked the MSVC C++ toolchain payload (`Microsoft.VisualStudio.Workload.VCTools`).

### Remediation
1. Installed Visual Studio 2022 Build Tools with the C++ workload:
   ```powershell
   winget install --id Microsoft.VisualStudio.2022.BuildTools --exact --source winget `
     --accept-source-agreements --accept-package-agreements --silent `
     --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
   ```
2. Verified installation at `C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC\14.44.35207\bin\Hostx64\x64\link.exe`.
3. Validated that `vswhere.exe` properly discovers version `17.14.44` and Windows SDK `10.0.26100.0`.
4. Successfully compiled and linked fresh Rust native binaries without custom PATH hacks or brittle flags.

---

## 3. Phase 2: Fresh Source Verification & Automated Test Suites

The entire workspace was built and tested sequentially from clean source code:

| Step | Command | Result | Duration |
|---|---|---|---|
| Workspace Typecheck | `cargo check --workspace` | Exit 0 | 1.52s |
| Code Formatting | `cargo fmt --all -- --check` | 0 diff | 0.81s |
| Linter / Clippy | `cargo clippy --workspace --all-targets -- -D warnings` | 0 warnings | 3.28s |
| Automated Test Matrix | `cargo test --workspace -- --test-threads=1` | **83 passed / 0 failed** | 50.36s |
| React UI Bundle | `npm --prefix ui run build` | Built in `dist/` | 955ms |
| Release Binary Build | `cargo build --release --workspace` | Exit 0 | 4m 35s |

### Test Suite Breakdown:
1. `tdm-core` unit tests: **15 passed** (filename sanitization, AES-128 decryption, HLS/DASH parsing, magnet parsing, concurrency limits).
2. `gate2_adaptive_tests`: **8 passed** (straggler tail splitting, per-host concurrency governor, 1MB fsync benchmark, 429 backoff retry, priority queue scheduling, crash/resume).
3. `gate4_hls_tests`: **8 passed** (MPEG-TS remuxing, AES-128 decryption, separate audio renditions, byte-range segments, pause/resume continuity, DRM rejection).
4. `gate5_dash_tests`: **9 passed** (duration parsing, template formatting, dynamic stream rejection, multi-period resolution, fMP4 and WebM remuxing, SegmentList, pause/resume).
5. `gate6_torrent_tests`: **8 passed** (metainfo parsing, magnet URI parsing, multi-file layout, piece verification, rate limiting, local seeder/leecher real download).
6. `gate7_live_tests`: **8 passed** (RTSP/RTMP/UDP/TCP protocol detection, UDP live capture, TCP MKV recording, sliding-window HLS, user stop trailer flush, orphan cleanup).
7. `gate8_protocol_matrix_tests`: **8 passed** (unified protocol compatibility matrix, DRM rejection, single-instance Named Pipe focus).
8. `gate8_stress_tests`: **4 passed** (rapid pause-resume cycling, part file cleanup on cancel, transient 503 retry recovery, concurrent queue progression).
9. `integration_tests`: **8 passed** (HTTP 206 multi-part range downloads, HTTP 200 fallback, chunk boundary integrity, ETag invalidation restart, crash recovery).
10. `tdm-native-host` unit tests: **1 passed** (framing roundtrip).
11. `host_tests`: **6 passed** (native host capability detection, URL rejection, Named Pipe IPC persistent engine bridge, process stdin/stdout, candidate deduplication).

---

## 4. Phase 3: Real Windows Installer Verification

### Generated Binaries
All release executables were generated in `target/release/`:
- `tori-download-manager.exe` (24,234,496 bytes)
- `tdm-native-host.exe` (15,884,288 bytes)
- `tdm-cli.exe` (15,820,288 bytes)

### NSIS Installer Verification
- Executable: `target\release\bundle\nsis\TORI Download Manager_0.1.0_x64-setup.exe`
- File Size: **15,528,889 bytes (~14.81 MB)**
- SHA-256 Hash: `AADBC29ED8660B8F307313A7A3CCFC9027B3A86FC467C33AAB189787F3C1C31B`
- Bundled Resources: Includes `tdm-native-host.exe` and `tdm-cli.exe` as embedded sidecars.
- Installer Hooks (`src-tauri/nsis/hooks.nsh`):
  - On Post-Install: Automatically executes `tdm-native-host.exe --register` with automatic directory discovery (`$INSTDIR` or `$INSTDIR\resources`).
  - Native Host Manifest: Generates `%APPDATA%\tori-download-manager\com.tori.download_manager.json` pointing directly to the installed executable.
  - Allowed Origins: Configures deterministic extension ID `chrome-extension://jfnfgmcbgapcpieaonbaolgebjaejcdm/` and `edge-extension://...` matching the pinned key.
  - Windows Registry: Registers `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.tori.download_manager` and `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.tori.download_manager`.
  - On Uninstallation: Calls `tdm-native-host.exe --unregister` and purges registry keys and host manifest while strictly preserving user download files and SQLite databases.

---

## 5. Phase 4: Browser Integration Verification

### Manifest V3 Extension (`extension/`)
- Manifest: Standard Manifest V3 with minimal permissions (`nativeMessaging`, `webRequest`, `storage`, `tabs`, `activeTab`).
- Cryptographic Key: Pinned 2048-bit RSA SPKI key yielding extension ID `jfnfgmcbgapcpieaonbaolgebjaejcdm` across all Chromium browsers (Chrome, Edge, Brave, Vivaldi).
- Content Script (`content.js`):
  - Detects HTML5 `<video>` and `<audio>` elements in the DOM.
  - Injects non-intrusive floating `TORI` download badge with hover animation.
  - Transient feedback toasts for user actions (Started, Already Exists, Error).
- Background Coordinator (`background.js`):
  - Listens to `webRequest.onHeadersReceived` to intercept media responses (`video/*`, `audio/*`, `.m3u8`, `.mpd`, direct formats).
  - Protocol classification: Direct HTTP/HTTPS, RFC 8216 HLS, ISO/IEC 23009-1 MPEG-DASH, BitTorrent, Magnet, RTSP, RTMP, SRT, RIST, RTP, UDP.
  - Candidate Deduplication: Bounded to 50 items per tab, deduplicated by exact URL, automatically updates action badge counter.
  - Single Persistent Engine Forwarding: Forwards requests via Native Messaging Host to the Windows Named Pipe server (`\\.\pipe\tori-download-manager-ipc`). If the desktop app is not running, the host auto-spawns it minimized.

---

## 6. Phase 5 & 6: Process Tree Resource & Memory Profiling

Resource utilization was measured on Windows across the full process hierarchy using `scripts/profile_matrix.ps1`:

| Scenario | Working Set (MB) | Peak WS (MB) | Private Bytes (MB) | Handles | Threads | Sockets | Resource Characteristics |
|---|---|---|---|---|---|---|---|
| **1. Idle (Desktop UI + WebView2)** | 167.62 | 167.63 | 47.48 | 1978 | 88 | 4 | Complete process tree (Rust Tauri host + WebView2 runtime child processes). |
| **2. 1 Active HTTP (Line-Rate 32MB)** | 2.60 | 54.20 | 0.52 | 25 | 1 | 4 | Real line-rate streaming engine with 1 MB periodic fsync checkpoints. |
| **3. 4 Concurrent HTTP (Adaptive)** | 27.05 | 27.05 | 14.42 | 144 | 6 | 1 | Multi-worker parallel range downloads under adaptive governor concurrency. |
| **4. HLS VOD (Segments + FFmpeg)** | 15.25 | 15.25 | 2.48 | 144 | 6 | 1 | Parallel segment workers + FFmpeg stream-copy remuxer without transcoding. |
| **5. DASH VOD (Audio/Video Streams)** | 15.43 | 15.43 | 2.41 | 144 | 6 | 1 | Parallel representation downloads + MP4 faststart muxer. |
| **6. BitTorrent Transfer (Pieces + Seed)** | 4.00 | 4.00 | 1.45 | 46 | 4 | 0 | Real local seeder/leecher P2P transfer with SHA-1 piece verification. |
| **7. Live UDP Packet Ingestion** | 11.79 | 11.79 | 2.24 | 144 | 6 | 0 | Continuous live UDP packet reception writing fragmented MP4 chunks. |
| **8. Native Messaging Host IPC Bridge** | 9.90 | 9.90 | 2.33 | 146 | 16 | 1 | Stdin/stdout length-prefixed framing bridge to persistent desktop engine. |

### Memory Findings:
- The core Rust download engine runs at an exceptionally low memory footprint: **0.5 MB to 14.4 MB private bytes** even under heavy multi-connection and P2P transfers.
- The idle desktop footprint of **167.62 MB** represents the total combined Working Set of the Tauri application and Microsoft Edge WebView2 multi-process architecture (Browser, GPU, Network, and Renderer processes).
- Zero memory leaks, zero process handle leaks, and zero orphan FFmpeg child processes were observed.

---

## 7. Phase 7: Security and Stability Audit

1. **Single-Instance Enforcement & Window Focus**:
   - The desktop application checks `tdm_native_host::ipc::try_connect_engine()`.
   - If an active instance exists on `\\.\pipe\tori-download-manager-ipc`, the second process emits `show_window`, bringing the primary instance to the foreground, and exits immediately.
2. **Windows Named Pipe Access Control**:
   - Uses `ServerOptions::new().first_pipe_instance(true)` on the primary instance, ensuring that rogue processes cannot hijack the pipe server.
   - Restricts message framing to length-prefixed JSON with strict deserialization bounds.
3. **Path Traversal & Filename Defense**:
   - `sanitize_filename()` strips all path delimiters (`/`, `\`, `:`), control characters, and reserved Windows device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9`).
   - Slashes and directory traversal tokens (`../`, `..\`) are converted to `_`.
   - Destination directories are strictly joined with the sanitized filename, preventing escape from user-chosen download folders.
   - Windows file lock conflicts (OS Error 5/32 from antivirus/indexers) are resolved via exponential backoff retries in `publish_final_file`.

---

## 8. Conclusion and Gate 9 Readiness

Gate 8.5 is **fully verified and complete**. The core systems, protocol adapters, background services, IPC channels, and packaging pipelines are hardened and production-ready.

The project is now completely prepared for **Gate 9 — Desktop UI Redesign & Modern Visual Polish**.

