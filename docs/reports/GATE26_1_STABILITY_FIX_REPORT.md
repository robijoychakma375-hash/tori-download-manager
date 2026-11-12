# TORI Download Manager — Gate 26.1 Stability Fix & Verification Report

- **Project:** `F:\TORI\final tori download manager`
- **Branch:** `release/v1.0.4`
- **Base Checkpoints:**
  - `checkpoint-gate26-start`: `5ccfe445e4a7c3fd180218772a28d8868fc11f26`
  - `checkpoint-gate26.1-start`: `957d5ed`
- **Target Desktop Version:** `v1.0.3` production $\rightarrow$ `v1.0.4` release candidate (staged in [`release/v1.0.4-rc/`](file:///F:/TORI/final%20tori%20download%20manager/release/v1.0.4-rc))
- **Browser Companion Status:** Published `v1.0.5` preserved untouched in [`release/v1.0.5-extension/`](file:///F:/TORI/final%20tori%20download%20manager/release/v1.0.5-extension); candidate `v1.0.6-rc` staged separately in [`release/v1.0.6-rc-extension/`](file:///F:/TORI/final%20tori%20download%20manager/release/v1.0.6-rc-extension)
- **Date:** 2026-11-12

---

## 1. Preserved Evidence Summary (STEP 1)

All production diagnostic evidence captured in Gate 26 remains preserved read-only and unmodified:

| Evidence Item | Preserved Location | Verification Status |
| :--- | :--- | :--- |
| Gate 26 Interrupted Session Recovery Report | [`docs/reports/GATE26_INTERRUPTED_SESSION_RECOVERY.md`](file:///F:/TORI/final%20tori%20download%20manager/docs/reports/GATE26_INTERRUPTED_SESSION_RECOVERY.md) | `PASS` |
| Lifecycle Log Snapshot (`258` lines, `23,365` bytes) | `target/gate26_evidence/lifecycle.log` | `PASS` |
| SQLite Database Snapshot (`61,440` bytes) | `target/gate26_evidence/tdm_storage.sqlite` | `PASS` |
| Raw SQLite WAL Snapshot (`2,282,472` bytes; `545` frames) | `target/gate26_evidence/raw_wal.bin` | `PASS` |
| Windows Event Viewer / WER Crash Query Output | `target/gate26_evidence/event_viewer.txt` | `PASS` |
| WebView2 LocalStorage LevelDB Log (`closeToTray:false` proof) | `target/gate26_evidence/webview2_localstorage_000003.log` | `PASS` |
| Active Production SQLite DB (`%APPDATA%\tori-download-manager\tdm_storage.sqlite`) | Untouched (never opened or modified during Gate 26.1) | `PASS` |
| Installed Production TORI v1.0.3 (`%LOCALAPPDATA%\TORI Download Manager\`) | Untouched (`1.0.3` binary & sidecars preserved) | `PASS` |

---

## 2. Large-File Disk Writer Root Cause & Fix (STEP 2)

### Root Causes Identified in v1.0.3
1. **Synchronous Multi-GB NTFS VDL Zero-Fill Stall:** In `PartFileWriter::open_or_create` ([`crates/tdm-core/src/engine/writer.rs`](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/src/engine/writer.rs)), `file.set_len(total)` was called without `FSCTL_SET_SPARSE`, and 16 workers immediately called `seek_write` at offsets up to `47.53 GiB` (`51,031,588,895` bytes). On Windows NTFS, writing at `47.53 GiB` when Valid Data Length (VDL) is `0` forces the kernel to synchronously zero-fill `0..47.53 GiB` on disk while holding the file's paging I/O resource exclusively, freezing all 16 worker threads at `0%` / `0 B/s` for minutes.
2. **Blocking Tokio Worker Threads & Excessive `FlushFileBuffers`:** `PartFileWriter::open_or_create` and `writer.sync()` (`FlushFileBuffers`) ran synchronously on async Tokio worker threads, and `writer.sync()` was invoked every `1 second` per worker (`16` hardware disk flushes/sec).
3. **Concurrent `.tdm-part` File Collision:** `create_download_with_all_options_scheduled` only checked `target_path.exists()` when choosing a unique filename, allowing two active downloads started before completion to open and write to the same `.tdm-part` file (`The Gate II ... Setup_Part1.rar.tdm-part`).
4. **Unpersisted `downloads.downloaded_bytes` on Pause/Crash:** Workers updated `download_chunks.written_bytes`, but `downloads.downloaded_bytes` remained `0` unless the download completed (`100%`), causing UI and DB inspection after pause/crash to report `0` downloaded bytes.

### Fixes Implemented
- **Windows Sparse File Allocation & Volume Capability Validation ([`crates/tdm-core/src/engine/writer.rs`](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/src/engine/writer.rs)):**
  - Queries volume capabilities (`GetVolumeInformationByHandleW`) and free disk space (`GetDiskFreeSpaceExW`).
  - Rejects files $> 4\text{ GiB} - 1\text{ byte}$ on FAT/FAT32 filesystems upfront with a clear `EngineError::DiskWrite` message.
  - Marks `.tdm-part` files sparse on NTFS/ReFS via `DeviceIoControl(..., FSCTL_SET_SPARSE, ...)` before `file.set_len(total)`, eliminating synchronous multi-GB zero-filling on high-offset chunk writes (`47.5 GiB` write completes in $< 5\text{ ms}$).
  - On non-sparse filesystems (e.g., exFAT) for files $> 64\text{ MiB}$, skips upfront `set_len` and falls back to single-worker sequential writing from byte `0`.
- **Non-Blocking I/O & 256 KiB Write Buffering ([`crates/tdm-core/src/engine/writer.rs`](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/src/engine/writer.rs), [`crates/tdm-core/src/engine/worker.rs`](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/src/engine/worker.rs)):**
  - Added `open_or_create_for_job_async` and `sync_async` using `tokio::task::spawn_blocking`.
  - Added `256 KiB` per-worker write buffering with immediate first-packet flush (`!has_flushed_first_bytes`) so UI progress updates arrive immediately, SQLite chunk progress checkpoints run every `4 MiB` / `2s`, and hardware `sync_async()` runs every `32 MiB` & `15s` (plus on pause, cancel, and completion).
- **Process-Wide `.tdm-part` Lock Registry & Path Allocation ([`crates/tdm-core/src/engine/writer.rs`](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/src/engine/writer.rs), [`crates/tdm-core/src/engine/manager.rs`](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/src/engine/manager.rs)):**
  - `allocate_unique_paths` checks `target_path.exists()`, `temp_path.exists()`, and all active/paused DB jobs under `path_alloc_lock`.
  - `ACTIVE_PART_FILES` prevents two distinct download jobs from ever opening the same `.tdm-part` file concurrently.
- **Strict Contiguous Chunk Completion Verification ([`crates/tdm-core/src/engine/writer.rs`](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/src/engine/writer.rs)):**
  - `verify_chunks_complete_and_contiguous` verifies before rename that every chunk is `is_complete == true`, sorted chunk ranges cover `0..expected_total` with zero gaps or overlaps (so unwritten sparse regions can never be accepted as downloaded data), and physical file size equals `expected_total`.
- **Startup & Pause Byte Reconciliation ([`crates/tdm-core/src/db/repo.rs`](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/src/db/repo.rs), [`crates/tdm-core/src/engine/manager.rs`](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/src/engine/manager.rs)):**
  - `reconcile_on_startup()` synchronizes `downloads.downloaded_bytes = SUM(download_chunks.written_bytes)`, and `run_download_task` persists `downloaded_bytes` every `2s` and on pause/cancel/error.

---

## 3. HTTP Client / Worker Timeout & Concurrency Fix (STEP 3)

### Root Causes Identified in v1.0.3
1. **60-Second Total Body Wall-Clock Timeout:** `build_http_client()` in [`crates/tdm-core/src/engine/client.rs`](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/src/engine/client.rs) set `.timeout(Duration::from_secs(60))`. In `reqwest`, `.timeout(...)` applies to the **entire request + response body stream**, unconditionally killing every chunk stream of `192 MB` (`3 GB / 16`) or `3.18 GB` (`50.9 GB / 16`) at the 60-second mark.
2. **Premature Stream EOF Acceptance:** In [`crates/tdm-core/src/engine/worker.rs`](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/src/engine/worker.rs), if `stream.next()` returned `None` early (`Ok(None)`), the worker exited the loop without checking whether `chunk.start_byte + chunk.written_bytes > final_bound`.
3. **Aggressive 16-Stream Presigned CDN Concurrency:** Opening 16 simultaneous Range requests against single-token presigned CDN URLs (`?v=...`) triggered CDN throttling/429s, and a single worker failure aborted all remaining workers (`join_set.abort_all()`).

### Fixes Implemented
- **Separated Connection, Header, and Idle-Read Timeouts ([`crates/tdm-core/src/engine/client.rs`](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/src/engine/client.rs), [`crates/tdm-core/src/engine/worker.rs`](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/src/engine/worker.rs), [`crates/tdm-core/src/engine/probe.rs`](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/src/engine/probe.rs)):**
  - Removed `.timeout(Duration::from_secs(60))` from `build_http_client()`.
  - Configured `.connect_timeout(Duration::from_secs(15))`, `.read_timeout(Duration::from_secs(45))`, and `.tcp_keepalive(Duration::from_secs(30))`.
  - Added `RESPONSE_HEADER_TIMEOUT` (`30s`) and per-read `STREAM_IDLE_READ_TIMEOUT` (`45s`) in `worker.rs`, allowing multi-hour downloads to stream indefinitely as long as bytes continue arriving.
  - Bounded `HEAD` probe timeout in `probe.rs` to `4s` and `GET Range: bytes=0-0` probe to `12s`.
- **Incomplete Stream Reconnection & Graceful Worker Degradation ([`crates/tdm-core/src/engine/worker.rs`](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/src/engine/worker.rs), [`crates/tdm-core/src/engine/manager.rs`](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/src/engine/manager.rs)):**
  - If a stream ends before `final_bound`, `worker.rs` resumes from `chunk.start_byte + chunk.written_bytes` (resetting no-progress retries when forward progress was made, up to `MAX_PROGRESS_RECONNECTS = 64`).
  - Enforced `governor.acquire_permit(&host)`, capped initial concurrency on presigned CDN URLs to `4`, and scaled concurrency down gracefully when a secondary worker fails instead of aborting active workers.

---

## 4. Duplicate Browser Handoff Root Cause & Fix (STEP 4)

### Root Cause Identified
In [`extension/background.js`](file:///F:/TORI/final%20tori%20download%20manager/extension/background.js), `handleBrowserDownload(item)` called `POST /api/v1/downloads` with a `3,500ms` timeout (`callDesktopApi(..., 3500)`). When a remote CDN `probe_url` took $> 3.5\text{s}$:
1. The extension's `3.5s` HTTP timeout fired (`httpRes.status === 0`) and immediately invoked `sendNativeMessage({ action: 'start_download', ... })`.
2. Because the first probe was still in flight (not yet inserted into SQLite `downloads`), `db.list_jobs()` in `server.rs` and `lib.rs` saw no existing row, so both paths probed and inserted duplicate jobs (`Setup_Part1.rar` and `Setup_Part1 (1).rar`).
3. Additionally, `recentlyInterceptedDownloadIds.add(item.id)` was only called after `await ensureSettingsLoaded()` and `await callDesktopApi()`.

### Fixes Implemented
- **Idempotent Handoff & In-Flight Probe Coalescing ([`crates/tdm-core/src/engine/manager.rs`](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/src/engine/manager.rs), [`crates/tdm-native-host/src/server.rs`](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-native-host/src/server.rs), [`crates/tdm-native-host/src/lib.rs`](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-native-host/src/lib.rs)):**
  - Added `DownloadManager::create_or_coalesce_download(..., handoff_id)` backed by `in_flight_creations` (`tokio::sync::broadcast`) and `recent_handoffs`.
  - Wrapped `handle_create_download` in `server.rs` inside `tokio::spawn` so if the extension's HTTP client aborts at `3.5s`, the in-flight probe continues and coalesces with the subsequent Native Messaging `start_download` fallback into a **single** `DownloadJob` (even for the unmodified published Extension `v1.0.5`).
- **Staged Extension Candidate `v1.0.6-rc` ([`release/v1.0.6-rc-extension/`](file:///F:/TORI/final%20tori%20download%20manager/release/v1.0.6-rc-extension)):**
  - Registers `inFlightDownloadIds.add(item.id)` synchronously before `await ensureSettingsLoaded()`.
  - Sends deterministic `handoff_id: "ext_<id>_<startTime>"` on both HTTP and Native Messaging requests.
  - Distinguishes explicit HTTP rejection (`400`/`401`/`403`/`422`) from unknown timeout (`status === 0`) and reconciles via `GET /api/v1/downloads` before retrying.
  - Preserves legitimate distinct downloads and all security-relevant CDN query parameters.
  - Published `v1.0.5` in `extension/` and `release/v1.0.5-extension/` remains 100% untouched.

---

## 5. Unexpected Termination Root Cause & Fix (STEP 5)

### Verified Root Cause of `PID:5328`, `PID:26792`, and `PID:23504` Terminations
Cross-referencing `target/gate26_evidence/lifecycle.log` lines 241–256 with `raw_wal.bin` and [`crates/tdm-native-host/src/ipc.rs`](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-native-host/src/ipc.rs) proved:
1. User-launched instances (`PID:25316`, `PID:3496`) always log `[WINDOW] RESTORE_MAIN` after `[FRONTEND] READY`.
2. `PID:5328` (`07:11:51.762Z`), `PID:26792` (`07:12:17.162Z`), and `PID:23504` (`07:12:28.948Z`) **never logged `RESTORE_MAIN`** because they were spawned with `--minimized` by `tdm-native-host.exe` (`ensure_engine_running()`) when Firefox handed off downloads after `PID:25316` had exited (`close_to_tray=false`).
3. In v1.0.3, `ensure_engine_running()` spawned `tori-download-manager.exe --minimized` without clearing `HANDLE_FLAG_INHERIT` on `tdm-native-host.exe`'s Native Messaging `stdin`/`stdout`/`stderr` pipes, without `Stdio::null()`, and without `CREATE_BREAKAWAY_FROM_JOB`.
4. As a result:
   - `tori-download-manager.exe` inherited the Native Messaging `stdout` pipe and `tracing_subscriber::fmt::init()` wrote log text to `stdout`, corrupting the 32-bit length-prefixed Native Messaging stream, AND
   - When the one-shot `tdm-native-host.exe` process exited ~1 second later (`07:12:18.207Z` and `07:12:29.987Z`), Firefox closed the Native Messaging Windows Job Object (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`), which terminated the child `tori-download-manager.exe` via kernel `TerminateJobObject` (explaining why `EXIT_REQUESTED`, `RUST_PANIC`, and Windows Event Viewer 1000/1001 were all absent).

### Fixes Implemented
- **Non-Inheritable Native Messaging Pipes & Job Object Breakaway ([`crates/tdm-native-host/src/ipc.rs`](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-native-host/src/ipc.rs), [`crates/tdm-native-host/src/lib.rs`](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-native-host/src/lib.rs)):**
  - Clears `HANDLE_FLAG_INHERIT` (`SetHandleInformation(..., HANDLE_FLAG_INHERIT, 0)`) on `stdin`, `stdout`, and `stderr` in `tdm-native-host`.
  - Spawns `tori-download-manager.exe --minimized` with `.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())` and `CREATE_BREAKAWAY_FROM_JOB | CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS` (`0x01000208`, with fallback to `CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW`).
  - Added `%LOCALAPPDATA%\TORI Download Manager\tori-download-manager.exe` to `locate_desktop_binary()`.
- **Stderr Tracing & Enhanced Lifecycle Logging ([`src-tauri/src/lib.rs`](file:///F:/TORI/final%20tori%20download%20manager/src-tauri/src/lib.rs)):**
  - Configured `tracing_subscriber::fmt().with_writer(std::io::stderr).init()` so logs never write to `stdout`.
  - Logged startup CLI `args`, `WindowEvent::Destroyed` (`[WINDOW] DESTROYED`), and `RunEvent::Exit` (`[APP] PROCESS_EXIT`).

---

## 6. Close-to-Tray Root Cause & Fix (STEP 6)

### Root Cause Identified
In [`src-tauri/src/tray.rs`](file:///F:/TORI/final%20tori%20download%20manager/src-tauri/src/tray.rs), `is_close_to_tray_enabled` defaults to `true`, and [`ui/src/types.ts`](file:///F:/TORI/final%20tori%20download%20manager/ui/src/types.ts) defaults `closeToTray` to `true`. However, an earlier QA run set `TORI_DATA_DIR` without setting `WEBVIEW2_USER_DATA_FOLDER`, causing the QA test to share the user's production WebView2 profile (`%LOCALAPPDATA%\com.tori.downloadmanager\EBWebView`) and write `"closeToTray": false` into `localStorage.tori_settings_v2` (proven by `target/gate26_evidence/webview2_localstorage_000003.log`). When the production app launched on a fresh SQLite DB, `App.tsx` pushed `localStorage` (`"closeToTray": false`) into `engine_settings.app_settings`.

### Fixes Implemented
- **Automatic WebView2 Profile Isolation ([`src-tauri/src/lib.rs`](file:///F:/TORI/final%20tori%20download%20manager/src-tauri/src/lib.rs)):**
  - Whenever `TORI_DATA_DIR` is set and `WEBVIEW2_USER_DATA_FOLDER` is not set, `src-tauri/src/lib.rs` automatically sets `WEBVIEW2_USER_DATA_FOLDER` to `<TORI_DATA_DIR>\EBWebView` before building Tauri, making it impossible for any test/QA run to pollute the user's real WebView2 profile.
- **Authoritative Backend Sync & Fresh-DB Default ([`ui/src/App.tsx`](file:///F:/TORI/final%20tori%20download%20manager/ui/src/App.tsx), [`src-tauri/src/commands.rs`](file:///F:/TORI/final%20tori%20download%20manager/src-tauri/src/commands.rs)):**
  - On startup, when `get_engine_settings` returns `null` (fresh SQLite database), `App.tsx` enforces `closeToTray: true` rather than trusting potentially stale `localStorage`. When `backendSettings` exists in SQLite, `backendSettings.closeToTray` overwrites `localStorage`.
  - Both `WindowEvent::CloseRequested` and `commands::window_close` now invoke `tray::hide_main_window` so `[WINDOW] HIDE_MAIN` is consistently logged.
- **Explicit Safe Recovery Utility & CLI Flag ([`scripts/enable_close_to_tray.js`](file:///F:/TORI/final%20tori%20download%20manager/scripts/enable_close_to_tray.js), [`src-tauri/src/lib.rs`](file:///F:/TORI/final%20tori%20download%20manager/src-tauri/src/lib.rs)):**
  - Added `--enable-close-to-tray` CLI flag (and `TORI_ENABLE_CLOSE_TO_TRAY=1`) plus standalone [`scripts/enable_close_to_tray.js`](file:///F:/TORI/final%20tori%20download%20manager/scripts/enable_close_to_tray.js) to set `"closeToTray": true` in `engine_settings.app_settings` while preserving all other user settings (`theme`, `accent`, `con`, `dir`, `port`, etc.).

---

## 7. Large-File Test Results (STEP 7)

Executed via [`crates/tdm-core/tests/gate26_1_large_file_and_handoff_tests.rs`](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/tests/gate26_1_large_file_and_handoff_tests.rs) and [`crates/tdm-core/src/engine/writer.rs`](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/src/engine/writer.rs) using local controlled HTTP/1.1 Range servers and isolated storage:

| Test Case / File Size | Mode | Time to First Progress | Worker Activity | Sparse High-Offset Write Latency | Pause / Resume & Restart Recovery | Integrity / Gap Verification | Result |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **100 MB** (`104,857,600` B) | Full physical download + HTTP 429 worker degradation | `< 150 ms` | `16` chunks (`4` initial on presigned URL, graceful 429 recovery) | `< 5 ms` (`FSCTL_SET_SPARSE`) | `PASS` | Full size + head/tail 1 MiB SHA-256 verified | **`PASS`** |
| **1 GB** (`1,073,741,824` B) | Controlled multi-chunk Range stream | `< 200 ms` (`>= 8 MiB` in `< 0.5s`) | `16` chunks | `< 5 ms` (`FSCTL_SET_SPARSE`) | `PASS` (`downloaded_bytes == SUM(written_bytes)`) | Sparse allocation & chunk persistence verified | **`PASS`** |
| **> 4 GB (`5 GB` / `5,368,709,120` B)** | 64-bit `u64` Range boundary (> FAT32 limit) | `< 200 ms` | `16` chunks (chunk 15 at `5.03 GB`) | `< 5 ms` at offset `5.36 GB` | `PASS` (`reconcile_on_startup` verified) | Rejects unwritten sparse gaps; accepts contiguous `0..5GiB` | **`PASS`** |
| **10 GB** (`10,737,418,240` B) | Controlled 64-bit sparse/range simulation | `< 200 ms` | `16` chunks (chunk 15 at `10.06 GB`) | `< 5 ms` at offset `10.73 GB` | `PASS` (`reconcile_on_startup` verified) | Rejects unwritten sparse gaps; accepts contiguous `0..10GiB` | **`PASS`** |
| **50 GB** (`53,687,091,200` B) | Controlled 64-bit sparse/range simulation | `< 200 ms` | `16` chunks (chunk 15 at `50.33 GB`, presigned cap `4`) | `< 5 ms` at offset `53.68 GB` | `PASS` (`reconcile_on_startup` verified) | Rejects unwritten sparse gaps; accepts contiguous `0..50GiB` | **`PASS`** |

All 9 recovery tests in `gate17_4_queue_recovery_tests` and all 47 unit tests in `tdm-core` also passed (`0` failures).

---

## 8. Browser Handoff Test Results (STEP 4 & STEP 7)

Executed via [`crates/tdm-native-host/tests/host_tests.rs`](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-native-host/tests/host_tests.rs), [`crates/tdm-core/tests/gate26_1_large_file_and_handoff_tests.rs`](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/tests/gate26_1_large_file_and_handoff_tests.rs), and [`scripts/verify_gate26_1_runtime.js`](file:///F:/TORI/final%20tori%20download%20manager/scripts/verify_gate26_1_runtime.js):

| Test Scenario | Description | Observed Result | Classification |
| :--- | :--- | :--- | :--- |
| **HTTP Timeout (`1.8s` / `3.5s`) + Native Messaging Fallback (`STEP 4.1`)** | `POST /api/v1/downloads` times out while `3.6s` CDN `HEAD` probe is in flight; `tdm-native-host.exe` immediately sends `start_download` | Coalesced to **1** job (`jobCount: 1`, `filename: "Setup_Part1.rar"`, `nmFallbackStatus: "already_exists"`, `headProbeCount: 1`, zero `(1).rar` duplicates) | **`PASS`** |
| **50.9 GB In-Flight Handoff Coalescing (Without `handoff_id`)** | Simulates published Extension `v1.0.5` fallback arriving 150ms into a 600ms probe for `54,676,684,800`-byte RAR | Both calls return identical `job_id`; `1` HEAD request issued; `1` DB row created | **`PASS`** |
| **Legitimate Distinct Downloads & Signed Query Preservation (`STEP 4.2`)** | Second download `Setup_Part2.rar?v=1776063402-X9z&token=cdn_sig_2` dispatched after `Setup_Part1.rar` | Both jobs created cleanly (`totalJobs: 2`) with full signed query strings intact | **`PASS`** |

---

## 9. Close-to-Tray & Lifecycle Test Results (STEP 5 & STEP 6)

Executed in isolated `TORI_DATA_DIR` via [`scripts/verify_gate26_1_runtime.js`](file:///F:/TORI/final%20tori%20download%20manager/scripts/verify_gate26_1_runtime.js) (full JSON output in `target/gate26_1_runtime_results.json`):

| Test ID | Verification Check | Observed Evidence | Classification |
| :--- | :--- | :--- | :--- |
| **STEP 5.1** | `tdm-native-host.exe` auto-spawns desktop with clean `stdout` framing | `code: 0`, `validFraming: true`, `status: "ok"`, `action: "pong"` (zero `tracing_subscriber` text on `stdout`) | **`PASS`** |
| **STEP 5.2** | Spawned `tori-download-manager.exe --minimized` survives after `tdm-native-host.exe` exits | `PID:24568` remained alive 2.5s+ after `tdm-native-host.exe` exited | **`PASS`** |
| **STEP 5.3** | Persistent desktop HTTP API server online & authenticated after background spawn | `GET /api/v1/status` returned `200 OK`, `authenticated: true`, `engine_active: true` | **`PASS`** |
| **STEP 6.1** | `scripts/enable_close_to_tray.js` enables `closeToTray` without resetting user settings | `closeToTray: false -> true`; `theme: "dark"`, `accent: "ocean"`, `con: 12`, `port: 16840`, `dir` preserved | **`PASS`** |
| **STEP 6.2** | `TORI_DATA_DIR` automatically isolates `WEBVIEW2_USER_DATA_FOLDER` | Created `<TORI_DATA_DIR>\EBWebView` automatically without touching `%LOCALAPPDATA%\com.tori.downloadmanager\EBWebView` | **`PASS`** |
| **STEP 6.3** | Single-instance guard focuses primary instance and exits secondary process | Secondary process logged `[APP] SECONDARY_INSTANCE` and exited while primary `PID:24568` stayed alive | **`PASS`** |
| **STEP 6.4** | Clicking `X` (`window_close`) with `closeToTray=true` hides window to tray | Logged `[WINDOW] WINDOW_CLOSE_COMMAND: label=main, close_to_tray=true` and `[WINDOW] HIDE_MAIN`; `PID:25180` (`v1.0.4`) stayed alive | **`PASS`** |
| **STEP 6.5** | Explicit Exit (`exit_app`) cleanly terminates application | Logged `[APP] EXIT_APP_COMMAND`, `[APP] EXPLICIT_EXIT`, `[APP] PROCESS_EXIT`; `aliveAfterExit: false` | **`PASS`** |

---

## 10. Storage Audit & Proposed Safe Cleanup Plan (STEP 8)

**No build caches or user files were deleted during Gate 26.1.** Revalidated storage breakdown for `F:\TORI\final tori download manager`:

| Path | Size | Classification | Proposed Action (Pending User Approval) |
| :--- | ---: | :--- | :--- |
| `target/debug` | **`52.99 GB`** (`56,897,415,195` B) | Reproducible Rust debug build cache | **PROPOSED DELETE** (Reclaims `52.99 GB`; regenerates on `cargo test`/`cargo build`) |
| `target/<26 old QA temp dirs>` *(excluding `target/gate26_evidence`)* | **`0.91 GB`** (`979,981,234` B) | Ephemeral QA test sandboxes (`gate14_*`..`gate25_*`, `temp_*`) | **PROPOSED DELETE** (Reclaims `0.91 GB`; **keep `target/gate26_evidence/`**) |
| `release/` obsolete pre-v1.0.3 folders (`v1.0.0`, `v1.0.1-*`, `v1.0.2-final`, `separate-pc-qa-kit*`) | **`1.33 GB`** (`1,428,219,532` B) | Superseded pre-v1.0.3 release candidates | **PROPOSED DELETE** (Reclaims `1.33 GB`; **keep `v1.0.3-final`, `v1.0.4-rc`, `v1.0.4-extension`, `v1.0.5-extension`, `v1.0.6-rc-extension`**) |
| `qa_manual_env` | **`0.07 GB`** (`73,509,142` B) | Old manual QA sandbox | **PROPOSED DELETE** (Reclaims `0.07 GB`) |
| `target/release` | **`7.95 GB`** | Release build cache & v1.0.4 RC binaries | **KEEP** (Or run `cargo clean --release` after v1.0.4 NSIS installer is finalized) |
| `resources/bin` | **`0.46 GB`** | Bundled sidecar binaries (`ffmpeg`, `ffprobe`, `yt-dlp`, `tdm-native-host`, `tdm-cli`) | **KEEP (REQUIRED)** |
| `.git` | **`0.33 GB`** | Git repository history | **KEEP (DO NOT TOUCH)** |
| `ui/node_modules` & `node_modules` | **`0.28 GB`** | Frontend & QA dependencies | **KEEP** |

- **Realistic Immediately Reclaimable Total (Safe Deletion List Above):** **`~55.30 GB`** without affecting source code, `.git`, `resources/bin`, `target/gate26_evidence`, active `v1.0.3`/`v1.0.4-rc`/`v1.0.5` releases, or installed user data.

---

## 11. Desktop v1.0.4 Release Candidate & Extension v1.0.6-rc Status (STEP 9)

### Staged Desktop v1.0.4 Release Candidate ([`release/v1.0.4-rc/`](file:///F:/TORI/final%20tori%20download%20manager/release/v1.0.4-rc))
| Artifact | Size (Bytes) | SHA-256 |
| :--- | ---: | :--- |
| `tori-download-manager-v1.0.4-rc.exe` | `30,164,480` | `b89066e3eec2a0d128f7a7f433fde659cbca448ed422d62a68c1ec5014ec702e` |
| `tdm-native-host-v1.0.4-rc.exe` | `17,169,408` | `37d917b1dbd47fb485c1af56d89fd74b2f2b264e9b9f5ad0fec9d37163ff2eac` |
| `tdm-cli-v1.0.4-rc.exe` | `16,962,048` | `5b147193120e9aae8932930262520faea3ea684a64c66e1193ca38c9ac7dda13` |
| `SHA256SUMS.txt` | `286` | Staged in `release/v1.0.4-rc/SHA256SUMS.txt` |

### Staged Browser Companion v1.0.6-rc Candidate ([`release/v1.0.6-rc-extension/`](file:///F:/TORI/final%20tori%20download%20manager/release/v1.0.6-rc-extension))
| Artifact | Size (Bytes) | SHA-256 |
| :--- | ---: | :--- |
| `tori-download-manager-extension-v1.0.6-rc.zip` | `73,907` | `29b25523fee49101a6b85124b17b1ed25d6ecd00f95856d15c7295c87c5d10bb` |
| `tori-download-manager-firefox-v1.0.6-rc.zip` | `73,632` | `644056190e58c130ca3c0e8e331e1488361d72f4fb75132a7201594977afd4df` |
| `SHA256SUMS.txt` | `222` | Staged in `release/v1.0.6-rc-extension/SHA256SUMS.txt` |

- **Public Release Protection:** Public GitHub release `v1.0.3`, `latest.json`, `extension-v1.0.5`, `website/`, and the user's installed TORI application were **not** modified.

---

## 12. Remaining Risks or Untested Scenarios

| Item | Classification | Notes |
| :--- | :--- | :--- |
| Live user production SQLite database (`%APPDATA%\tori-download-manager\tdm_storage.sqlite`) migration | **`NOT TESTED` (Intentionally Untouched)** | Per strict Gate 26.1 constraints, the user's live production database was not opened or modified. Once the user installs `v1.0.4` (or runs `node scripts/enable_close_to_tray.js --confirm-production` / `tori-download-manager.exe --enable-close-to-tray`), `closeToTray: true` will be enabled in their live profile without resetting any other settings. |
| Full 50 GB physical byte transfer over external internet CDN (`bzzhr.to`) | **`NOT TESTED` (Simulated Locally at 50 GB Scale)** | Tested with a local HTTP/1.1 Range server at the exact `50 GB` / `50.9 GB` (`54,676,684,800` B) offset scale with sparse NTFS allocation (`FSCTL_SET_SPARSE`), presigned CDN query throttling (`429`), and contiguous gap verification rather than consuming 50 GB of external WAN bandwidth and SSD wear. |
| Mozilla AMO signing for staged `v1.0.6-rc` Firefox extension | **`NOT TESTED` (Staged as Candidate Only)** | Published signed `v1.0.5` Firefox XPI remains active and already benefits from the backend's in-flight probe coalescing in Desktop `v1.0.4-rc`. |
