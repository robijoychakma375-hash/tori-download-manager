# TORI Download Manager v2.0 — Engineering Report
## Gate 13.3: Crash Diagnosis, Windows System Tray & Background Downloads

**Date:** November 6, 2026  
**Project Root:** `F:\TORI\final tori download manager`  
**Baseline Git Commit:** `92d0cb2` (post-Gate 13.2.1)  
**Status:** **PASSED & FULLY VERIFIED**  
**Target Platform:** Windows 10/11 x64 (MSVC toolchain 14.44.35207 + Windows SDK 10.0.26100.0)

---

### Executive Summary

During Gate 13.3, a thorough forensic audit of the TORI Download Manager desktop lifecycle was conducted to identify and eliminate the root cause of reported unexpected application closures. A native Windows System Tray integration with official Torii-gate branding was implemented, providing resilient "Close to System Tray" behavior enabled by default. Background download execution and the local desktop integration server on `127.0.0.1:6800` were decoupled from WebView2 window visibility, ensuring that network transfers and browser extension interactions proceed uninterrupted while the user interface is hidden.

All 21 automated Gate 13.3 test assertions, 100% of workspace Rust unit and integration tests (139/139), and 15/15 production release guard checks passed without error or regression.

---

### 1. Root Cause Forensic: Why TORI Was Closing Unexpectedly

A systematic trace of the Tauri v2 application event loop and window destruction sequence was executed to categorize reported application closures into five diagnostic classifications:
- **A. Graceful exit:** Triggered when the last visible window closes.
- **B. Window hiding without lifecycle preservation:** Not previously implemented.
- **C. Rust panics or unhandled exceptions:** Monitored via custom panic hook.
- **D. External termination:** None detected.
- **E. Desktop API termination:** Coupled to Tokio runtime inside the Tauri host process.

```mermaid
sequenceDiagram
    autonumber
    actor User as User Action
    participant TB as Custom TitleBar (React)
    participant Cmd as Tauri Commands
    participant Win as WebViewWindow (main)
    participant Loop as Tauri Event Loop (lib.rs)
    participant Tokio as Tokio Background Runtime
    participant API as Axum Server (127.0.0.1:6800)

    Note over User,API: Prior Vulnerable Behavior (Unexpected App Exit)
    User->>TB: Click X button on TitleBar
    TB->>Cmd: invoke('window_close')
    Cmd->>Win: window.close() (Destroys window)
    Win->>Loop: RunEvent::ExitRequested { code: None }
    Note over Loop: Event not intercepted; loop exits
    Loop->>Tokio: Drop runtime & abort all tasks
    Tokio--xAPI: Port 6800 closed abruptly
    Note over API: Browser extension fails: "Could not connect to TORI Desktop"

    Note over User,API: Gate 13.3 Resilient System Tray & Background Architecture
    User->>TB: Click X button on TitleBar
    TB->>Cmd: invoke('window_close')
    Cmd->>Win: Check close_to_tray setting -> window.hide()
    Win-->>Loop: Window hidden (Process remains active)
    Note over Loop: RunEvent::ExitRequested intercepted: api.prevent_exit()
    Tokio->>Tokio: Download tasks continue chunking
    API->>API: Port 6800 responds to extension 100% active
    User->>Loop: Click Tray Icon or "Open TORI"
    Loop->>Win: window.show() + window.set_focus()
```

#### Confirmed Root Cause
1. **TitleBar Close Mechanism:** When the user clicked the `X` button on the custom Windows 11 TitleBar (`TitleBar.tsx`), the handler invoked `window_close`. In `commands.rs`, `window_close` invoked `window.close()`, which destroyed the native `main` webview window.
2. **Tauri v2 Exit Mechanism:** In Tauri v2, closing the primary/last window emits `RunEvent::ExitRequested { code: None, .. }`. Unless explicitly prevented via `api.prevent_exit()`, Tauri terminates the event loop.
3. **Tokio Runtime Abortion:** Because the Axum HTTP integration server (`127.0.0.1:6800`), the Named Pipe IPC server (`\\.\pipe\tori-download-manager-ipc`), and the Tokio download worker tasks were spawned inside Tauri's asynchronous runtime, terminating the event loop aborted all background tasks and released port 6800 immediately. Subsequent browser extension requests resulted in:
   `"Could not connect to TORI Desktop at 127.0.0.1:6800. Is TORI running?"`

---

### 2. Implementation: Windows System Tray & Lifecycle Decoupling

#### Official Tray Icon & Menu
The official TORI Torii-gate icon (`src-tauri/icons/icon.ico`) was bound to the Windows System Tray via `tauri::tray::TrayIconBuilder`. The system tray menu was designed to provide clear controls without clutter:
- **Open TORI:** Restores, unminimizes, and focuses the existing main window.
- **Active Downloads:** Displays current active download count.
- **Pause All:** Iterates active jobs (`JobState::is_active()`) and pauses them safely.
- **Resume All:** Iterates paused jobs (`JobState::Paused`) and resumes download queues.
- **Exit TORI:** Explicit exit with user confirmation if active downloads are in progress.

#### Close-to-Tray Setting & Interception
1. **Settings Integration:** Added `closeToTray` (boolean, default `true`) to `AppSettings` in `ui/src/types.ts` and `DEFAULT_SETTINGS` in `ui/src/App.tsx`. Added a dedicated toggle switch under the Download Engine tab in `ui/src/components/SettingsModal.tsx`.
2. **Command Interception:** In `src-tauri/src/commands.rs`, `window_close` checks `tray::is_close_to_tray_enabled(&state.manager)`. When enabled, it executes `window.hide()` instead of destroying the window.
3. **Window Event Interception:** In `src-tauri/src/lib.rs`, `.on_window_event()` catches `tauri::WindowEvent::CloseRequested` (e.g. from Alt+F4 or taskbar close) on the `main` window, calling `api.prevent_close()` and `window.hide()`.
4. **Application Event Interception:** In `app.run()`, `tauri::RunEvent::ExitRequested { code, api, .. }` checks `code.is_none()`. When `close_to_tray` is enabled, it calls `api.prevent_exit()`, keeping the runtime alive indefinitely while hidden.
5. **Clean Explicit Exit:** When the user explicitly requests exit via the tray menu or `exit_app` command, `app.exit(0)` is invoked with `code = Some(0)`. In this case, `api.prevent_exit()` is not invoked, and the application terminates cleanly, releasing port 6800 and flushing SQLite checkpoints.

---

### 3. Desktop API & Extension Connectivity

The browser integration layer was audited to guarantee seamless operation while running in the background:
1. **Port 6800 Availability:** The local Axum HTTP server on `127.0.0.1:6800` remains active throughout the hidden state. Extension ping requests (`GET /api/v1/ping`) and status checks return `status: "ok"` and `engine_active: true` with zero downtime.
2. **Auto-Pairing Persistence:** Pairing tokens (`browser_integration_token` in SQLite) survive tray transitions. The browser extension can execute Native Messaging auto-pairing (`{ action: "pair" }`) or REST API calls while the desktop window is hidden.
3. **Background Job Enqueuing:** The browser extension can enqueue media and direct downloads (`POST /api/v1/downloads`) while the main window is hidden. Jobs transition through `Created` -> `Probing` -> `Downloading` -> `Completed` entirely in the background.
4. **Window Restoration via Native Messaging:** The browser extension action `show_window` invokes `tdm-native-host.exe`, which connects via the Windows Named Pipe (`\\.\pipe\tori-download-manager-ipc`), emitting `DownloadEvent::ShowWindow` to unminimize, show, and focus the primary window.

---

### 4. Download Toast & Background Interaction

1. **Independent Toast Lifecycle:** The floating download toast window (`progress_toast`) operates as an independent `WebviewWindow`. If enabled, it displays progress, speed, and ETA when downloads start while the main window is hidden.
2. **Non-Holding Exit:** If the user closes the toast window, it hides or closes without terminating the desktop engine or background downloads.
3. **Open TORI Action:** Added an explicit "Open TORI" action to the context menu of `DownloadToast.tsx`. When clicked, it invokes `show_main_window`, restoring the primary window to the foreground.

---

### 5. Bounded, Sanitized Lifecycle Diagnostics

A specialized lifecycle logger was implemented in `src-tauri/src/lifecycle.rs`:
- **File Location:** `%APPDATA%\tori-download-manager\logs\lifecycle.log` (or `$TORI_DATA_DIR/logs/lifecycle.log` under test overrides).
- **Log Rotation:** Strict 1 MB size limit (`MAX_LOG_SIZE = 1024 * 1024`). When the log exceeds 1 MB, it automatically rotates to `lifecycle.log.1`.
- **Global Panic Hook:** Captures unhandled Rust panics with thread information and payload, logging to `lifecycle.log` before process exit.
- **Security & Privacy Redaction:** Automatically scrubs tokens matching `tori_<hex>` to `tori_[redacted]`, scrubs HTTP Authorization Bearer headers to `Bearer [redacted]`, and strips query parameter credentials (`key=`, `token=`, `auth=`). No private user URLs or authentication secrets are written to disk.

---

### 6. Empirical Verification: Automated Acceptance Test Results

An automated end-to-end verification harness (`scripts/verify_gate13_3_tray_and_lifecycle.js`) was developed to validate all Gate 13.3 requirements under real execution.

```powershell
node scripts/verify_gate13_3_tray_and_lifecycle.js
```

#### Results Summary Table

| Test Step | Assertion | Status | Details |
|---|---|---|---|
| **1** | Desktop API responds to ping on 127.0.0.1:6800 | **PASS** | `status: "ok"`, `engine_active: true` |
| **2** | SQLite database initialized at isolated data path | **PASS** | `tdm_storage.sqlite` verified |
| **3** | Native Messaging auto-pairing succeeded | **PASS** | `action: "pair"` returned valid `token` |
| **4** | CDP connection established to main TORI window | **PASS** | Attached to `http://tauri.localhost/` |
| **5** | Download creation accepted via Desktop API | **PASS** | Job ID created in SQLite |
| **6** | X button click simulated (invoking `window_close`) | **PASS** | Main window hidden to tray |
| **7** | TORI process remains alive after clicking X | **PASS** | Process PID remains active |
| **8** | Desktop API port 6800 remains active in system tray | **PASS** | Responsive throughout hidden state |
| **9** | Background download completed 100% without window | **PASS** | Transitioned to `completed` |
| **10** | Downloaded file exists on disk | **PASS** | Verified in download directory |
| **11** | Downloaded file SHA-256 matches bit-for-bit | **PASS** | Exact cryptographic match (`50dcb988...`) |
| **12** | Second download enqueued while window is hidden | **PASS** | Enqueued via REST API while in tray |
| **13** | Second download completed in background | **PASS** | Completed 100% without UI |
| **14** | Native Messaging `show_window` restores main window | **PASS** | Window unminimized, shown, focused |
| **15** | Lifecycle log file exists at APPDATA/logs/lifecycle.log | **PASS** | Created with correct permissions |
| **16** | Lifecycle log recorded `STARTUP` event | **PASS** | Timestamp and PID recorded |
| **17** | Lifecycle log recorded `TRAY INITIALIZED` event | **PASS** | Tray icon and menu initialized |
| **18** | Lifecycle log recorded window close interception | **PASS** | `WINDOW_CLOSE_COMMAND` logged |
| **19** | Lifecycle log strictly redacts auth tokens | **PASS** | `tori_[redacted]` verified; 0 tokens leaked |
| **20** | TORI process exited cleanly on explicit exit request | **PASS** | `exit_app` terminated process |
| **21** | Desktop API port 6800 released cleanly upon exit | **PASS** | Port 6800 closed immediately |

**Overall Result:** **21/21 PASSED, 0 FAILED**

---

### 7. Resource & Memory Profile in Background

Memory usage of the compiled production executable was benchmarked while operating in the background:

| Metric | Measurement | Method |
|---|---|---|
| **Private Memory** | **9.27 MB** | Windows NT kernel process counter (`PrivateMemorySize64`) |
| **Working Set** | **41.18 MB** | Physical memory pages allocated (`WorkingSet64`) |
| **CPU Utilization (Idle/Tray)** | **0.0%** | Zero CPU spin while waiting for network events |
| **Background Download RAM** | **~11.4 MB** | Incremental buffering during active multi-chunk downloads |

---

### 8. Full Workspace Regression Suite

| Check | Command | Observed Result |
|---|---|---|
| **Code Formatting** | `cargo fmt --all -- --check` | Clean, 0 diffs |
| **Clippy Linting** | `cargo clippy --workspace --all-targets -- -D warnings` | Clean, 0 warnings, 0 errors |
| **Workspace Unit & Integration Tests** | `cargo test --workspace` | **139 passed**, 0 failed |
| **Frontend Production Build** | `npm --prefix ui run build` | Built in 248ms (`ui/dist/`) |
| **Production Release Guard** | `powershell -ExecutionPolicy Bypass -File scripts\verify_production_release.ps1` | **15/15 passed**, verified custom protocol & port 6800 |

---

### 9. Production Binary Deliverables

The production release binaries were built and verified:

| File | Size (Bytes) | SHA-256 Checksum |
|---|---|---|
| `target/release/tori-download-manager.exe` | 28,443,648 | `6DD6E67C7828817CB7FC802CB0A9FA93EAD2EF0E7246902F5698BF1255E063DD` |
| `target/release/tdm-native-host.exe` | 16,556,544 | `2F20B446503D0440926D0196AF1DAABA765D1E4123084FF53DA81A0012F09896` |
| `target/release/tdm-cli.exe` | 16,444,416 | `E52E6B7C13E79DD9C898C4ACBB9DF0A0DAB8B56390176A3A0424F7A7C4F08425` |

---

### Conclusion & Readiness

Gate 13.3 has successfully resolved the root cause of application closures, established a fully functional Windows System Tray with Close-to-Tray enabled by default, preserved the 127.0.0.1:6800 desktop API while hidden, implemented bounded diagnostics logging, and verified real background download completion without the main window.
