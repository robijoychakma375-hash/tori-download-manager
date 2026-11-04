# Plan — Gate 10.6: Silent Background Processes & Independent Always-On-Top Download Progress Window

## Milestone Objective
Deliver a production-ready silent background execution model and an independent always-on-top download progress window for TORI Download Manager v2.0:
1. **Silent Background Process Execution (Zero CMD/Console Flashing):**
   - Audit all subprocess execution across `crates/tdm-core`, `crates/tdm-native-host`, and `src-tauri`.
   - Apply Windows `CREATE_NO_WINDOW` (`0x08000000`) flag across all `std::process::Command` and `tokio::process::Command` calls (`where.exe`, `yt-dlp`, `ffmpeg`, `ffprobe`, `deno`/`node`, `reg.exe`, `explorer.exe`).
   - Preserve standard stdio pipes (stdout/stderr AsyncBufRead and capture).
   - Ensure CLI (`tdm-cli`) and Native Messaging Host (`tdm-native-host`) maintain standard console stdio capability for browser native messaging without subsystem interference.
2. **Independent Always-On-Top Download Progress Window:**
   - Implement Tauri 2 native multi-window command `open_progress_window(id: String)`:
     - Window label: `format!("progress_{}", id)`.
     - Window properties: `always_on_top(true)`, `inner_size(800.0, 500.0)`, `min_inner_size(600.0, 420.0)`, `resizable(true)`.
     - Stays visible when main application window is minimized or behind other applications (e.g., Microsoft Edge).
     - Focus existing window if already open for that job ID (prevents duplicates).
     - Moving or closing the progress window MUST NOT cancel or pause the underlying download.
   - Frontend multi-window routing:
     - Detect `?window=progress&id={id}` in URL query parameters.
     - Render standalone progress window containing complete approved TORI progress UI:
       - TitleBar with filename and drag region.
       - Tabs: Download, Options, Connections.
       - Status badge, file size, downloaded bytes, bandwidth speed, ETA, resume support.
       - Progress bar and Segment Visualizer with real chunk progress.
       - Controls: Pause / Resume, Cancel, Open File.
       - Connections list with chunk ranges and status.
     - Emit `DownloadEvent::OpenProgressWindow { id }` when browser extension creates download so progress window opens automatically if configured.
     - Wire double-click and context menu "Show progress window" in main desktop app to `open_progress_window`.
3. **True Pause / Resume & State Consistency:**
   - Single source of truth is Rust `DownloadManager` and SQLite database.
   - Fix data wipe bug: REMOVE `cleanup_partial_files(&job.target_path)` from `cancel_token.cancelled()` in `crates/tdm-core/src/resolver/downloader.rs`.
   - Ensure partial files (`.part`, `.ytdl`) are preserved on disk during pause so yt-dlp resumes without restarting from 0%.
   - Add explicit `--continue` flag to yt-dlp arguments.
   - Fix `onCancel` bug in `ui/src/App.tsx` (previously invoked `handleTogglePause` instead of `cancel_download`).
   - Map exact engine states: `Resolving`, `Queued`, `Downloading`, `Pausing`, `Paused`, `Resuming`, `Merging`, `Verifying`, `Completed`, `Failed`, `Cancelled`.
4. **Verification & Quality Gates:**
   - Automated verification script (`scripts/verify_gate10_6.js`):
     - Test 1: Silent execution audit — zero console windows created during pause, resume, start, cancel, retry.
     - Test 2: Independent always-on-top progress window — window created, `always_on_top` verified, persists when main window minimized.
     - Test 3: True pause/resume — partial bytes retained on disk, resume continues from checkpoint.
     - Test 4: State synchronization — main window and progress popup reflect identical state transitions.
     - Test 5: Standard quality gates (`cargo fmt`, `cargo clippy`, `cargo test`, `npm run build`).
   - Deliver `GATE10_6_SILENT_PROCESS_AND_PROGRESS_WINDOW_REPORT.md` and update `IMPLEMENTATION_STATUS.md`.
