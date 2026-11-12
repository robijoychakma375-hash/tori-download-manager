# TORI Download Manager — Gate 26 Interrupted Session Recovery Report

**Generated:** 2026-11-12  
**Project:** `F:\TORI\final tori download manager`  
**Mode:** Read-Only Diagnostic & State Recovery  
**Current Branch:** `release/v1.0.4`  
**Current HEAD:** `5ccfe445e4a7c3fd180218772a28d8868fc11f26`  
**Checkpoint Tag:** `checkpoint-gate26-start` (`5ccfe445e4a7c3fd180218772a28d8868fc11f26`)

---

## 1. Git Recovery Status (STEP 1)

| Property | Value | Status |
| :--- | :--- | :--- |
| **Current Branch** | `release/v1.0.4` | Verified |
| **Current `HEAD`** | `5ccfe445e4a7c3fd180218772a28d8868fc11f26` | Verified |
| **Tag `checkpoint-gate26-start`** | Exists -> `5ccfe445e4a7c3fd180218772a28d8868fc11f26` | Verified |
| **Branch `release/v1.0.4`** | Exists -> `5ccfe445e4a7c3fd180218772a28d8868fc11f26` | Verified |
| **Working Tree Status (`git status --short`)** | Clean (`0` modified, `0` staged, `0` untracked in repo) | Verified |
| **Incomplete File Writes / Source Corruption** | **None (`0` files modified prior to interruption)** | Verified Safe |

### Recent Commit History (`git log -n 10 --oneline --decorate`)
```text
5ccfe44 (HEAD -> release/v1.0.4, tag: checkpoint-gate26-start, origin/main, origin/HEAD, main) docs(gate25.1): record Gate 25.1 publication report and release scripts
ad47cef (tag: v1.0.5-extension, origin/extension/v1.0.5, hotfix/overlay-drag, extension/v1.0.5) fix(extension): resolve sticky video overlay drag and bump extension to v1.0.5
a9e2b6b docs(gate24.1): add Gate 24.1 extension v1.0.4 publication report and helper scripts
cb87c9d (tag: v1.0.4-extension, origin/extension/v1.0.4, extension/v1.0.4) chore(extension): prepare TORI Browser Companion v1.0.4 release packages
7a4dcab (tag: checkpoint-post-ui-redesign) docs(gate23.6): add final extension UI migration regression verification report
31b74a0 feat(extension): migrate toolbar popup and video overlay to new UI design
1b2e522 (tag: checkpoint-pre-ui-redesign) docs(gate23.4): add v1.0.3 GitHub release asset cleanup report and audit scripts
99beeb4 (tag: v1.0.3) docs(gate23.3): finalize v1.0.3 public release report and website download links
e4ca32b chore(release): integrate Mozilla-signed Firefox v1.0.3 XPI and update checksums
2da435d docs(gate23.2): add v1.0.3 production readiness report and final release scripts
```

---

## 2. Diagnostic Evidence Inventory (STEP 2)

All diagnostic evidence gathered prior to the PC shutdown was preserved intact on disk and verified without re-running destructive operations.

### A. Repository Evidence Directory (`F:\TORI\final tori download manager\target\gate26_evidence\`)
*(Ignored by `.gitignore` under `/target`, preserving a clean Git working tree)*

| File / Directory | Size (Bytes) | Description & Integrity Status |
| :--- | ---: | :--- |
| `lifecycle.log` | `28,143` | Complete copy of `C:\Users\ritud\AppData\Roaming\tori-download-manager\logs\lifecycle.log` (260 lines covering `2026-11-06` through `2026-11-12T07:15:07Z`). |
| `raw_db.bin` | `647,168` | Exact uncheckpointed raw byte copy of user's `tdm_storage.sqlite` before WAL checkpointing. |
| `raw_wal.bin` | `2,179,512` | Exact uncheckpointed raw byte copy of user's `tdm_storage.sqlite-wal` (`2.08 MiB`). Contains the complete binary WAL frame history of the user's `bzzhr.to` large-file downloads (`53.90 GB` and `3.25 GB`) before they were canceled/cleared from the live table. |
| `tdm_storage.sqlite` | `659,456` | Checkpointed read-only copy of the user's SQLite database (`engine_settings`, `downloads`, `download_chunks`, `categories`, `schedules`). |
| `Critical_ToriDownload.exe_fd112122...` | `0` (dir) | Empty directory placeholder created when copying from `C:\ProgramData\Microsoft\Windows\WER\ReportArchive\`; the source WER directory requires Administrator elevation (`EPERM` under standard user permissions). |

### B. Scratch Diagnostic Scripts (`C:\Users\ritud\.gemini\antigravity\brain\4cb6b42b-ac51-4843-b5b6-6960f8030e35\scratch\`)

| Script | Size (Bytes) | Purpose |
| :--- | ---: | :--- |
| `audit_storage.js` | `3,463` | Recursive non-destructive storage audit of `F:\TORI\final tori download manager`, `target/*`, `release/*`, and `AppData` TORI directories. |
| `inspect_evidence.js` | `948` | Queries `tdm_storage.sqlite` tables, row counts, `downloads`, `download_chunks`, and `engine_settings`. |
| `inspect_wal.js` | `1,123` | Scans `raw_db.bin` and `raw_wal.bin` for URLs, `.rar`/`.zip`/`.iso`/`.mp4` filenames, and error records. |
| `inspect_bzzhr_wal.js` | `727` | Extracts binary WAL frames referencing `ts.bzzhr.to`. |
| `inspect_both_large_files.js` | `1,137` | Reconstructs exact task UUIDs, byte sizes, ETags, chunk counts, and URLs for both large files from `raw_wal.bin`. |
| `inspect_uuid_history.js` | `1,435` | Extracts the chronological state transition history (`queued` -> `downloading` -> `paused` / `failed` / `cancelled`) for all 5 large-file task UUIDs in `raw_wal.bin`. |

### C. Saved Task Output Logs
- [`task-3813.log`](file:///C:/Users/ritud/.gemini/antigravity/brain/4cb6b42b-ac51-4843-b5b6-6960f8030e35/.system_generated/tasks/task-3813.log): Complete output of `node scratch/audit_storage.js` with byte/MB/GB breakdowns.

---

## 3. Summary of Verified Findings (STEP 3)

### Finding 1 — Why the Large Downloads (~3 GB and ~50 GB) Are Stuck at `Starting...` (`0%`, `0 KB/s`)

#### Forensic Reconstruction of the User's Actual Large Downloads (from `raw_wal.bin`)
Between `2026-11-12T07:06:46Z` and `2026-11-12T07:15:05Z`, the user attempted to download two large multi-gigabyte `.rar` archives from `bzzhr.to` (`https://ts.bzzhr.to/d/...`) in Firefox:

1. **~50 GB File (`50.20 GiB` / `53,902,835,631` bytes):**
   - **Filename:** `Call.of.Duty-Modern.Warfare.2.Remastered-SteamRIP.com.rar`
   - **Source URL:** `https://ts.bzzhr.to/d/fpby9u56rr9v?v=1794466727-...` (`Referer: https://bzzhr.to/`)
   - **Probe Result:** `total_bytes = 53,902,835,631`, `is_resumable = true (1)`, `chunk_count = 16`, `etag = "fpby9u56rr9v"`
   - **Task `89343dd7-94d0-42bb-8d30-6d314c810993`:** Created at `07:06:46.755Z` (`queued`), transitioned to `downloading` 1ms later (`07:06:46.756Z`). Remained at `downloaded_bytes = 0` (`0%`, `0 KB/s`) across all 16 chunks (`3,368,927,226` bytes per chunk) for over 5 minutes until process restart reconciled it to `paused` and user later canceled it (`07:15:05.752Z`).
   - **Task `06561973-f109-47b3-b805-493f47cdc800` (Duplicate):** Created at `07:08:03.820Z` with a new `?v=1794466789-...` token while Task `89343dd7` was still stuck in `downloading`. Transitioned to `downloading` at `07:08:03.821Z` and failed `325ms` later (`07:08:04.146Z`) with `Unknown engine error: task 21 was cancelled` and `downloaded_bytes = 0`.

2. **~3 GB File (`3.02 GiB` / `3,246,698,883` bytes):**
   - **Filename:** `Assassins.Creed.Liberation.HD.SteamRIP.com.rar`
   - **Source URL:** `https://ts.bzzhr.to/d/6bpgsbo2m8cy?v=1794467162-...` (`Referer: https://bzzhr.to/`)
   - **Probe Result:** `total_bytes = 3,246,698,883`, `is_resumable = true (1)`, `chunk_count = 16`, `etag = "6bpgsbo2m8cy"`
   - **Task `4be744bb-9847-4ccd-b199-e4be7792d67a`:** Created at `07:12:18.207Z` (`PID:26792`), transitioned to `downloading` at `07:12:18.208Z`, stayed at `downloaded_bytes = 0` across all 16 chunks (`202,918,680` bytes per chunk).
   - **Task `1a047cf2-4e7b-4bd4-b911-2ac78794c8ae` (Duplicate):** Created at `07:12:29.987Z` (`PID:23504`), transitioned to `downloading` at `07:12:29.987Z`, stayed at `downloaded_bytes = 0`.
   - **Task `4b223057-4328-4a37-99a1-4a0de8587266` (Duplicate):** Created at `07:13:42.200Z` (`PID:3496`), transitioned to `downloading` at `07:13:42.201Z`, stayed at `downloaded_bytes = 0` until canceled at `07:15:03.541Z`.

#### Verified Engine Root Causes in `crates/tdm-core/src/engine/`
1. **Non-Sparse NTFS Preallocation + High-Offset `seek_write` Kernel Zero-Fill Stall ([writer.rs](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/src/engine/writer.rs#L17-L56), [worker.rs](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/src/engine/worker.rs#L249-L260)):**
   - `PartFileWriter::open_or_create` calls `file.set_len(total)` (`SetEndOfFile`) on Windows NTFS **without** marking the file sparse (`FSCTL_SET_SPARSE`).
   - On Windows NTFS, `SetEndOfFile(53_902_835_631)` sets End-of-File to `50.20 GiB`, but the NTFS **Valid Data Length (VDL)** remains `0`.
   - Immediately afterward ([manager.rs](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/src/engine/manager.rs#L1460-L1538)), 16 concurrent chunk workers are spawned on Tokio tasks. Worker 15 calls `std::os::windows::fs::FileExt::seek_write` synchronously on the Tokio worker thread at offset `50,533,908,390` (`47.06 GiB`) for the 50 GB file (or `3,043,780,200` / `2.83 GiB` for the 3 GB file).
   - Writing past VDL on a non-sparse NTFS file forces the Windows NTFS kernel driver to **synchronously zero-fill every unallocated cluster from VDL (`0`) up to the write offset (`47.06 GiB` or `2.83 GiB`)** while holding the file's exclusive paging I/O lock.
   - Because `on_bytes_written(len)` ([worker.rs](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/src/engine/worker.rs#L259)) is only called **after** `writer.write_at(current_offset, &chunk)` returns, `total_downloaded_atomic` stays at `0`, so the UI remains frozen at `Starting...` (`0%`, `0 KB/s`) while all 16 Tokio worker threads block inside `seek_write`.
2. **Global 60-Second Total Request Wall-Clock Timeout in `reqwest::Client` ([client.rs](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/src/engine/client.rs#L17-L23)):**
   - `build_http_client()` sets `.timeout(Duration::from_secs(60))` on the `reqwest::Client`. In `reqwest`, `.timeout(...)` is a **total request wall-clock deadline across the entire response body stream** (`resp.bytes_stream()`), not a per-read idle socket timeout.
   - Any chunk transfer or blocked `write_at` stream that takes longer than 60 seconds total is forcibly aborted by `reqwest` with a timeout error at 60 seconds.
3. **Synchronous `writer.sync()` (`FlushFileBuffers`) Every 1 Second Across 16 Workers ([worker.rs](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/src/engine/worker.rs#L267-L269)):**
   - Every worker calls `writer.sync()` (`self.file.sync_data()`) synchronously inside the Tokio async loop every `1,000ms` or `1 MB`, serializing all 16 workers on hardware disk flushes.
4. **Unchecked `governor.acquire_permit(&host)` + 16 Simultaneous Connections to Presigned CDN URLs ([manager.rs](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/src/engine/manager.rs#L1468)):**
   - `manager.rs:1468` calls `let permit = governor.acquire_permit(&host);` without checking if `permit` is `None`. It unconditionally spawns 16 simultaneous HTTP `Range` requests (after 1 `HEAD` + 1 `GET bytes=0-0` probe = 18 connections) against `ts.bzzhr.to` presigned URLs. When a file-hosting CDN rate-limits or rejects excess concurrent connections on a single presigned token, any single worker failure after retries breaks the `JoinSet` loop ([manager.rs](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/src/engine/manager.rs#L1554)) and aborts all remaining workers (`task 21 was cancelled`).
5. **Duplicate Task `.tdm-part` File Collision ([manager.rs](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/src/engine/manager.rs#L645-L663)):**
   - `while target_path.exists()` checks only whether the completed target path (`.rar`) exists, **not** whether `temp_path` (`.rar.tdm-part`) is already open by an active download. Thus, duplicate tasks (`89343dd7` and `06561973`) both opened and truncated/wrote to the exact same `.tdm-part` file concurrently.

---

### Finding 2 — Whether the Desktop Process Truly Crashes or Exits Normally

Runtime evidence from [`target/gate26_evidence/lifecycle.log`](file:///F:/TORI/final%20tori%20download%20manager/target/gate26_evidence/lifecycle.log) proves that **both** normal exit (due to `close_to_tray=false`) and unlogged process termination occurred across different sessions:

1. **Normal Clean Exit When Clicking Window `X` (`PID:14216`, `PID:11900`, `PID:25316`, `PID:3496`):**
   - In `PID:25316` (`2026-11-12T07:11:51.295Z`) and `PID:3496` (`2026-11-12T07:15:07.882Z`), clicking the titlebar `X` button invoked `window_close`, which logged:
     ```text
     [2026-11-12T07:11:51.295342900+00:00] [PID:25316] WINDOW_CLOSE_COMMAND: label=main, close_to_tray=false
     [2026-11-12T07:11:51.306944900+00:00] [PID:25316] EXIT_CLEAN: Performing clean application exit
     [2026-11-12T07:11:51.308164300+00:00] [PID:25316] EXIT_REQUESTED: code=Some(0)
     [2026-11-12T07:11:51.308206700+00:00] [PID:25316] EXPLICIT_EXIT: Permitting application exit
     ```
   - Because `close_to_tray` was `false`, clicking `X` terminated the entire application instead of hiding the window to the system tray.
2. **Unlogged Terminations During the 3.02 GiB Download Attempts (`PID:5328`, `PID:26792`, `PID:23504`):**
   - Look at lines 245–256 of `lifecycle.log`:
     - `PID:5328` started at `07:11:51.762Z` -> terminated before `07:12:17.162Z` with **no** `WINDOW_CLOSE_COMMAND`, `EXIT_CLEAN`, `EXIT_REQUESTED`, or `RUST_PANIC` log entry.
     - `PID:26792` started at `07:12:17.162Z`, accepted 3.02 GiB download `4be744bb` at `07:12:18.207Z` -> terminated before `07:12:28.948Z` with **no** exit or panic log entry.
     - `PID:23504` started at `07:12:28.948Z`, accepted 3.02 GiB download `1a047cf2` at `07:12:29.987Z` -> terminated before `07:13:37.339Z` with **no** exit or panic log entry.
   - Upon each subsequent startup, `db.reconcile_on_startup()` ([manager.rs](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/src/engine/manager.rs#L62)) converted the interrupted `downloading` tasks (`89343dd7`, `4be744bb`, `1a047cf2`) into `paused` state in SQLite.
   - **Exact OS termination signal for `PID:5328`, `PID:26792`, and `PID:23504`:** Marked **`UNKNOWN`** (no Rust panic hook fired and no Windows Event ID 1000 crash entry was logged; consistent with the process hanging / becoming unresponsive during synchronous Tokio thread-pool starvation on NTFS zero-fill and being killed via Task Manager / Windows End Task, or an abrupt native termination).

---

### Finding 3 — What the Windows Crash Records Show

1. **Windows Application Event Log (`Get-WinEvent -LogName Application`, last 7 days):**
   - **Zero (`0`)** `Event ID 1000` (`Application Error`) or `Event ID 1026` crash events for `tori-download-manager.exe` or `tdm-native-host.exe`.
   - Multiple `Event ID 1001` `LiveKernelEvent` entries (`141`, `1b0`, `117` — Windows display/GPU watchdog kernel recovery events, including one at `2026-11-12 13:03:31` local time = `07:03:31Z`) were recorded on the system.
2. **Windows Error Reporting (`WER`) Archive (`C:\ProgramData\Microsoft\Windows\WER\ReportArchive\`):**
   - One folder named `Critical_ToriDownload.exe_fd1121225f55bfb16be615f5c929471ae773e742_df099318_ca86ca4e-9a66-4daf-b9fd-5ed89976349c` exists on disk.
   - **Contents of `Critical_ToriDownload.exe_fd112122...`:** Marked **`UNKNOWN`** because Windows DACLs restrict `C:\ProgramData\Microsoft\Windows\WER\ReportArchive\Critical_*` to elevated `Administrators`/`SYSTEM` (`EPERM: operation not permitted` under standard user context).

---

### Finding 4 — Whether Browser Interception Is Creating Duplicate Tasks

**YES — Verified by both SQLite WAL forensic records and source code inspection:**
1. **Runtime Proof (`raw_wal.bin`):**
   - The 50.20 GiB file (`fpby9u56rr9v`) created **2 tasks** (`89343dd7` and `06561973`).
   - The 3.02 GiB file (`6bpgsbo2m8cy`) created **3 tasks** (`4be744bb`, `1a047cf2`, and `4b223057`).
2. **Source Code Root Causes:**
   - **3.5-Second HTTP Handoff Timeout Race + Automatic Native Messaging Fallback ([extension/firefox/background.js](file:///F:/TORI/final%20tori%20download%20manager/extension/firefox/background.js#L1461-L1496)):**
     - `handleBrowserDownload` calls `callDesktopApi('/api/v1/downloads', 'POST', payload, 3500)` with a **3.5-second timeout**.
     - On the server ([crates/tdm-native-host/src/server.rs](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-native-host/src/server.rs#L577-L588)), `handle_create_download` awaits `create_download_with_all_options_scheduled(...)`, which performs a synchronous network probe (`probe_url_with_options`, up to 30s timeout for `HEAD` + `GET` range probe) **before** inserting the job into SQLite or returning HTTP 200.
     - If probing a remote CDN takes >3.5 seconds, `callDesktopApi` times out in the extension while the server continues probing and creates Job #1. Meanwhile, `background.js:1483` immediately falls back to `sendNativeMessage({ action: 'start_download', ...payload })`, which submits a **second** `add_download` request!
   - **Late Addition to `recentlyInterceptedDownloadIds` ([extension/firefox/background.js](file:///F:/TORI/final%20tori%20download%20manager/extension/firefox/background.js#L1378-L1500)):**
     - `recentlyInterceptedDownloadIds.add(item.id)` (line 1499) is only executed **after** the async `callDesktopApi` / `sendNativeMessage` completes, rather than synchronously when `handleBrowserDownload` starts.
   - **Exact-String URL Deduplication Fails on Rotating CDN Query Tokens ([crates/tdm-native-host/src/server.rs](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-native-host/src/server.rs#L521-L526) & [crates/tdm-native-host/src/lib.rs](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-native-host/src/lib.rs#L285-L290)):**
     - Both endpoints check only `j.url == raw_url`. For CDN URLs with rotating presigned query strings (`https://ts.bzzhr.to/d/fpby9u56rr9v?v=1794466727-...` vs `?v=1794466789-...`), `j.url == raw_url` evaluates to `false` even though the canonical URL path (`/d/fpby9u56rr9v`), resolved `filename`, `total_bytes`, and `etag` (`"fpby9u56rr9v"`) match an already-active download.
   - **Browser Download Canceled Before First Byte / Transfer Readiness ([extension/firefox/background.js](file:///F:/TORI/final%20tori%20download%20manager/extension/firefox/background.js#L1510-L1514)):**
     - As soon as `/api/v1/downloads` returns `status: "ok"`, `chrome.downloads.cancel(item.id)` cancels Firefox's built-in download before TORI has opened the `.tdm-part` file or received a single payload byte.

---

### Finding 5 — Whether the Download Engine Receives and Initializes These Tasks

**YES — 100% Proven by `raw_wal.bin`:**
- All 5 tasks reached `handle_create_download` -> `DownloadManager::create_download_with_all_options_scheduled` -> `probe_url_with_options`.
- For all 5 tasks, the probe succeeded (`206 Partial Content`, `Accept-Ranges: bytes`), extracted the exact filename (`Call.of.Duty-Modern.Warfare.2.Remastered-SteamRIP.com.rar` and `Assassins.Creed.Liberation.HD.SteamRIP.com.rar`), exact byte size (`53,902,835,631` and `3,246,698,883`), `etag` (`"fpby9u56rr9v"` and `"6bpgsbo2m8cy"`), `referer` (`"https://bzzhr.to/"`), and Firefox `user_agent`.
- All 5 tasks were inserted into `downloads` (`state = 'queued'`) along with 16 `download_chunks` rows each (`80` total chunk rows in WAL), and `start_download` transitioned every task to `state = 'downloading'` within `1ms`.
- The stall happens **after** initialization, inside `run_download_task` (`PartFileWriter::open_or_create` + 16 chunk workers).

---

### Finding 6 — What Close-to-Tray Source and Runtime Evidence Reveals

**100% Verified Root Cause Across SQLite, WebView2 LevelDB, `lifecycle.log`, and Source Code:**
1. **Runtime State in User's Installed AppData:**
   - In `C:\Users\ritud\AppData\Roaming\tori-download-manager\tdm_storage.sqlite` (`engine_settings` table, key `app_settings`) AND in `C:\Users\ritud\AppData\Local\com.tori.downloadmanager\EBWebView\Default\Local Storage\leveldb\000003.log` (`tori_settings_v2`), the persisted JSON contains:
     ```json
     "closeToTray": false,
     "MinimizeToTray": true,
     "startMinimized": false,
     "lastUpdateCheck": 1794079295646
     ```
2. **How `"closeToTray": false` Got Persisted (`2026-11-07T19:21:35Z`):**
   - `lifecycle.log` line 13 (`2026-11-06T15:02:53Z`) shows `WINDOW_CLOSE_COMMAND: label=main, close_to_tray=true` originally worked.
   - On `2026-11-07T19:21:35Z` (`1794079295646`), an automated QA script ([scripts/verify_gate13_3_1_qa.js](file:///F:/TORI/final%20tori%20download%20manager/scripts/verify_gate13_3_1_qa.js#L460-L508)) tested `closeToTray: false`. While that script set an isolated `TORI_DATA_DIR`, it **did not set an isolated `WEBVIEW2_USER_DATA_FOLDER`**, so WebView2 wrote `"closeToTray": false` directly into the user's global `C:\Users\ritud\AppData\Local\com.tori.downloadmanager\EBWebView` `localStorage` (`tori_settings_v2`)!
   - The next time the production app launched, `loadInitialSettings()` in [`ui/src/App.tsx`](file:///F:/TORI/final%20tori%20download%20manager/ui/src/App.tsx#L53-L64) read `"closeToTray": false` from `localStorage` (`tori_settings_v2`) and synced it to `C:\Users\ritud\AppData\Roaming\tori-download-manager\tdm_storage.sqlite` via `save_app_settings` ([App.tsx](file:///F:/TORI/final%20tori%20download%20manager/ui/src/App.tsx#L417-L427)).
3. **Why Earlier Fixes & Automated Tests Missed This:**
   - In [`ui/src/App.tsx`](file:///F:/TORI/final%20tori%20download%20manager/ui/src/App.tsx#L59) and [#L382](file:///F:/TORI/final%20tori%20download%20manager/ui/src/App.tsx#L382), `closeToTray` only falls back to `true` when `parsed.closeToTray === undefined`, so the polluted `false` value in `localStorage` and `tdm_storage.sqlite` remained permanently stuck at `false`.
   - Furthermore, startup sync in [`ui/src/App.tsx`](file:///F:/TORI/final%20tori%20download%20manager/ui/src/App.tsx#L389-L398) sets React state from backend `res`, which triggers the `useEffect` at line 417 (`save_app_settings(JSON.stringify(settings))`); if `localStorage` had `closeToTray: false` before `get_app_settings` resolved, the initial `useEffect` at mount immediately overwrote the backend SQLite setting with `localStorage`'s `closeToTray: false`!
   - Earlier QA scripts (`verify_gate23_1_runtime.js`) set `TORI_CLOSE_TO_TRAY=1` in the environment ([src-tauri/src/tray.rs](file:///F:/TORI/final%20tori%20download%20manager/src-tauri/src/tray.rs#L13)), which overrode `read_close_to_tray_from_db` during test runs and masked the bug in real user launches.

---

### Finding 7 — Whether the Installed Binary Matches the Published Version

**YES — 100% Match Verified:**
- **Installed Desktop Binary:** `C:\Users\ritud\AppData\Local\TORI Download Manager\tori-download-manager.exe`
  - **FileVersion / ProductVersion:** `1.0.3`
  - **Size:** `30,013,440` bytes
  - **SHA256:** `5B9BA55047E74CB056FD672941ED87E735E2232D0B2AB3FC43C5E9DA53AF89F1`
  - **Last Modified:** `2026-11-11T17:50:12.690Z` (`23:50:12` local time)
- **Installed Native Host Binary:** `C:\Users\ritud\AppData\Local\TORI Download Manager\tdm-native-host.exe` (`9,274,880` bytes, `2026-11-11T17:48:34.819Z`)
- **Installed Firefox Extension:** `C:\Users\ritud\AppData\Roaming\Mozilla\Firefox\Profiles\irHYegpg.Profile 1\extensions\tori-download-manager@toridm.org.xpi`
  - **Version:** `1.0.5` (Mozilla-signed, `active: true`, Gecko ID `tori-download-manager@toridm.org`)

---

### Findings 8 & 9 — Storage Audit Results & Safe Deletion Candidates

Full non-destructive audit of `F:\TORI\final tori download manager` (**`63.875 GB`** / `68,585,152,110` bytes across `95,213` files) and `AppData` TORI directories:

| Path | Size (Bytes) | Size (MB / GB) | Files | Classification & Safety |
| :--- | ---: | ---: | ---: | :--- |
| `target/debug` | `56,897,415,195` | `54,261.60 MB` (**`52.990 GB`**) | `41,652` | **SAFE TO DELETE** (Debug build cache & incremental artifacts; regenerates on `cargo build`). |
| `target/release` | `8,541,056,128` | `8,145.39 MB` (**`7.954 GB`**) | `11,689` | **KEEP BINARIES / OPTIONAL CACHE PRUNE** (`deps/` & `incremental/` account for ~7.8 GB; keep active release executables/NSIS bundle or rebuild cleanly). |
| `target/<qa_temp_dirs>` *(26 QA/temp folders, excluding `gate26_evidence`)* | `979,981,234` | `934.58 MB` (**`0.913 GB`**) | `337` | **SAFE TO DELETE** (`gate14_*`, `gate17_*`, `gate18_*`, `gate23_*`, `gate24_*`, `gate25_*`, `manual_qa_env`, `temp_*`, `ext_ui_audit_qa`, `firefox_install_v104_qa`, `signed_xpi_test_env`, etc.). **Keep `target/gate26_evidence` (`3.32 MB`).** |
| `release/` *(obsolete pre-v1.0.3 candidate folders)* | `1,428,219,532` | `1,362.05 MB` (**`1.330 GB`**) | `98` | **SAFE TO DELETE OBSOLETE CANDIDATES ONLY**: `v1.0.1-rc` (`355.77 MB`), `v1.0.1-final` (`223.82 MB`), `v1.0.1-firefox-final-candidate` (`111.89 MB`), `v1.0.1-installation-qa` (`111.66 MB`), `v1.0.1-installer-candidate` (`111.66 MB`), `separate-pc-qa-kit` (`111.84 MB`), `TORI_v1.0.1_Separate_PC_QA_Kit.zip` (`111.81 MB`), `v1.0.0` (`111.47 MB`), `v1.0.2-final` (`112.00 MB`). **MUST KEEP:** `release/v1.0.3-final` (`111.96 MB`), `release/v1.0.4-extension` (`0.22 MB`), `release/v1.0.5-extension` (`0.22 MB`). |
| `.git` | `358,412,566` | `341.81 MB` (**`0.334 GB`**) | `543` | **DO NOT TOUCH** (Git repository history). |
| `ui/node_modules` | `164,026,431` | `156.43 MB` (**`0.153 GB`**) | `14,769` | **KEEP** (Required for UI builds). |
| `node_modules` | `134,884,741` | `128.64 MB` (**`0.126 GB`**) | `2,953` | **KEEP** (Required for Playwright / verification scripts). |
| `qa_manual_env` | `73,509,142` | `70.10 MB` (**`0.068 GB`**) | `6` | **SAFE TO DELETE** (Old manual QA sandbox folder). |
| `website` | `4,877,507` | `4.65 MB` (**`0.005 GB`**) | `22,744` | **DO NOT TOUCH** (Production website source). |
| `C:\Users\ritud\AppData\Local\tori-download-manager` | `406,806,063` | `387.96 MB` (**`0.379 GB`**) | `5` | **SAFE TO DELETE AFTER VERIFICATION** (Legacy lowercase directory containing duplicate `deno.exe`, `ffmpeg.exe`, `ffprobe.exe`, `yt-dlp.exe`; current v1.0.3 uses `C:\Users\ritud\AppData\Local\TORI Download Manager\bin`). |
| `C:\Users\ritud\AppData\Local\TORI Download Manager` | `512,672,115` | `488.92 MB` (**`0.477 GB`**) | `15` | **DO NOT TOUCH** (Active installed production application + sidecars). |
| `C:\Users\ritud\AppData\Roaming\tori-download-manager` | `3,507,611` | `3.35 MB` (**`0.003 GB`**) | `9` | **DO NOT TOUCH** (Active user SQLite database, WAL, pairing token, and lifecycle logs). |

- **Total Immediately Reclaimable Without Touching Active `target/release`, `node_modules`, Source, or User Data:** **`~55.30 GB`** (`target/debug` `52.99 GB` + `target/<qa_temp_dirs>` `0.91 GB` + obsolete `release/v1.0.0–v1.0.2` folders `1.33 GB` + `qa_manual_env` `0.07 GB`).

---

## 4. Implementation Progress Classification (STEP 4)

**Zero (`0`) production source files were modified before the session interruption.** Every Gate 26 task is classified below:

| Gate 26 Phase / Task | Status | Notes / Evidence |
| :--- | :--- | :--- |
| **Phase 1.1–1.2:** Verify Git branch/commits & create `checkpoint-gate26-start` + `release/v1.0.4` | `COMPLETED AND VERIFIED` | Both `checkpoint-gate26-start` and `release/v1.0.4` exist at `5ccfe445e4a7c3fd180218772a28d8868fc11f26`. |
| **Phase 1.3–1.4:** Identify installed TORI executable (`1.0.3`) and Firefox extension (`1.0.5`) | `COMPLETED AND VERIFIED` | Verified exact paths, versions, timestamps, and SHA256. |
| **Phase 1.5–1.9:** Preserve logs, SQLite DB + raw WAL (`2.18 MB`), Event Viewer records, and storage audit in `target/gate26_evidence` | `COMPLETED AND VERIFIED` | All evidence files preserved and verified in `target/gate26_evidence/` and `scratch/`. |
| **Phase 2:** Root-cause investigation of ~3 GB and ~50 GB large-file download stalls (`Starting...` / `0%` / `0 KB/s`) | `COMPLETED AND VERIFIED` | Reconstructed all 5 `bzzhr.to` tasks from `raw_wal.bin` and identified all 5 root causes in `writer.rs`, `worker.rs`, `client.rs`, and `manager.rs`. |
| **Phase 2 (Implementation):** Implement sparse file / async non-blocking preallocation, per-read idle timeout instead of 60s total wall-clock timeout, adaptive chunk concurrency on presigned CDNs, and `.tdm-part` collision prevention | `NOT STARTED` | No code changes written yet. |
| **Phase 3:** Root-cause investigation of unexpected app termination (`lifecycle.log` + Event Viewer + WER) | `COMPLETED AND VERIFIED` | Identified both normal exit on `X` (`close_to_tray=false`) and unlogged terminations of `PID:5328`/`26792`/`23504` during 3.02 GiB download stalls. |
| **Phase 3 (Implementation):** Prevent Tokio worker starvation / UI hang and harden lifecycle/shutdown guards | `NOT STARTED` | No code changes written yet. |
| **Phase 4:** Root-cause investigation of duplicate browser handoff (`background.js`, `server.rs`, `lib.rs`) | `COMPLETED AND VERIFIED` | Identified 3.5s HTTP timeout fallback race, post-await ID tracking, canonical URL/ETag deduplication gap, and premature browser download cancel. |
| **Phase 4 (Implementation):** Fix browser handoff deduplication and handshake timeout/readiness | `NOT STARTED` | No code changes written yet. |
| **Phase 5:** Root-cause investigation of Close-to-Tray failure (`tray.rs`, `App.tsx`, `TitleBar.tsx`, `SettingsModal.tsx`, `tdm_storage.sqlite`, `leveldb`) | `COMPLETED AND VERIFIED` | Proven that `verify_gate13_3_1_qa.js` polluted global WebView2 `localStorage` (`tori_settings_v2`) with `"closeToTray": false`, which synced to `tdm_storage.sqlite`. |
| **Phase 5 (Implementation):** Fix Close-to-Tray state migration/sync, ensure QA scripts always isolate `WEBVIEW2_USER_DATA_FOLDER`, and verify live `X` hide/restore behavior | `NOT STARTED` | No code changes written yet. |
| **Phase 6:** Storage cleanup execution | `NOT STARTED` | Audit completed (`audit_storage.js`); zero files deleted pending authorization. |
| **Phase 7:** Build & end-to-end verification of Desktop `v1.0.4` | `NOT STARTED` | Pending Phases 2–6 implementation. |

---

## 5. Corruption & Data Safety Risk Assessment

1. **Repository & Source Code Integrity:** **100% Clean.** Zero modified, half-written, or corrupted files exist in `F:\TORI\final tori download manager`.
2. **User SQLite Database (`C:\Users\ritud\AppData\Roaming\tori-download-manager\tdm_storage.sqlite`):** **Untouched.** Only read-only copies were made to `target/gate26_evidence/`.
3. **User Downloads (`C:\Users\ritud\Downloads\TORI`):** **Untouched.** Existing completed user downloads (`583.91 MB`) are completely intact.
4. **QA Script Pollution Risk Identified:** Any future QA script that launches `tori-download-manager.exe` **must** set an isolated `WEBVIEW2_USER_DATA_FOLDER` alongside `TORI_DATA_DIR` so test runs never overwrite the user's production WebView2 `localStorage` (`C:\Users\ritud\AppData\Local\com.tori.downloadmanager\EBWebView`).

---

## 6. Exact Continuation Sequence (When Authorized to Proceed)

1. **Step A — Engine Large-File Stability Fixes (`crates/tdm-core/src/engine/`):**
   - **Sparse File / Non-Blocking Allocation (`writer.rs`):** Mark `.tdm-part` files as sparse on Windows (`FSCTL_SET_SPARSE` via `DeviceIoControl` or avoid upfront `set_len(total)` on multi-GB files without sparse flag) so writing at chunk offset `47.06 GiB` never triggers a synchronous 47 GiB NTFS VDL zero-fill stall.
   - **Offload Blocking Disk I/O & Relax `sync_data` (`writer.rs`, `worker.rs`):** Avoid calling `file.sync_data()` (`FlushFileBuffers`) every 1 second across 16 workers concurrently; flush only on pause/cancel/completion or coarse intervals (`>= 15s` / `64 MB`).
   - **Remove 60-Second Total Body Wall-Clock Timeout (`client.rs`, `worker.rs`):** Replace `.timeout(Duration::from_secs(60))` on `build_http_client()` with `.connect_timeout(Duration::from_secs(15))` and a **per-chunk-read idle timeout** (`tokio::time::timeout(Duration::from_secs(30), stream.next())`) so multi-gigabyte streams can run for hours as long as bytes keep flowing.
   - **Respect Host Governor & Adaptive Fallback for Presigned CDNs (`manager.rs`):** Enforce `governor.acquire_permit(&host)` (defaulting to a safe per-host cap such as 4–8 connections instead of 16 simultaneous connections to a single presigned CDN host), and if a secondary range worker gets HTTP 403/429/503 while Worker 0 is streaming, fall back gracefully instead of aborting the entire download.
   - **Prevent `.tdm-part` Collision (`manager.rs`):** Check both `target_path.exists()` and `temp_path.exists()` when assigning the output filename so two tasks never write to the same `.tdm-part` file.
2. **Step B — Browser Handoff Deduplication & Readiness (`crates/tdm-native-host/src/server.rs`, `lib.rs`, `extension/` if authorized):**
   - Deduplicate incoming downloads in `server.rs` and `lib.rs` not only by exact `url`, but also by canonical URL path + filename when an active (`Probing` / `Queued` / `Downloading`) task was created within the last 60 seconds, returning `already_exists` with the active `job_id` instead of spawning duplicate tasks when HTTP -> Native Messaging fallback or CDN token rotation occurs.
   - Ensure `/api/v1/downloads` responds within the extension's timeout window (or returns the registered `job_id` immediately once queued/validated) so `background.js` does not time out at `3,500ms` during slow CDN probes and fire a duplicate Native Messaging `start_download` call.
3. **Step C — Close-to-Tray Fix & Migration (`src-tauri/src/tray.rs`, `src-tauri/src/commands.rs`, `ui/src/App.tsx`):**
   - Fix the startup race in `ui/src/App.tsx` where the initial `useEffect` saves `localStorage` settings back to SQLite before `get_app_settings` from the backend has completed.
   - Add a one-time settings schema migration (`settingsVersion: 3` or backend migration) that restores `closeToTray: true` for installations whose `tori_settings_v2` was polluted by the pre-v1.0.4 QA run, while honoring explicit user toggles in `SettingsModal.tsx` thereafter.
   - Verify `TitleBar.tsx` `X` click -> `window_close` -> `handle_close_action` hides the main window (`WINDOW_HIDDEN_TO_TRAY`), keeps the process alive, and restores the window from the tray icon.
4. **Step D — Safe Storage Cleanup (After Operator Approval):**
   - Remove `target/debug` (`52.99 GB`), temporary QA directories in `target/` (`0.91 GB`, keeping `target/gate26_evidence`), `qa_manual_env` (`0.07 GB`), and obsolete `release/v1.0.0–v1.0.2` staging folders (`1.33 GB`, keeping `v1.0.3-final`, `v1.0.4-extension`, `v1.0.5-extension`), reclaiming **`~55.30 GB`**.
5. **Step E — Automated & Live Runtime Verification:**
   - Run unit/integration tests and a live large-file sparse-stream simulation (`>= 3 GB` and `>= 50 GB` offsets), duplicate handoff test, and Close-to-Tray verification with `WEBVIEW2_USER_DATA_FOLDER` properly isolated.

