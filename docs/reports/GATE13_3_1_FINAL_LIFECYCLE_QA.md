# TORI Download Manager v2.0 — Engineering Report
## Gate 13.3.1: Final System Tray & Background Lifecycle Verification

**Date:** November 6, 2026  
**Project Root:** `F:\TORI\final tori download manager`  
**Baseline Git Commit:** `420047a` (post-Gate 13.3)  
**Status:** **PASSED & FULLY VERIFIED**  
**Target Platform:** Windows 10/11 x64 (MSVC toolchain 14.44.35207 + Windows SDK 10.0.26100.0)

---

### Executive Summary

Gate 13.3.1 was executed to conduct an exhaustive, rigorous quality assurance verification of the newly introduced Windows System Tray, background lifecycle, and crash diagnostics implemented in Gate 13.3. All potential lifecycle edge cases were audited, tested, and resolved:
1. **Close-to-Tray ON vs OFF:** When OFF, closing the main window terminates the process completely with exit code 0, leaving **zero invisible orphan processes** running on Windows.
2. **Setting Survival across Restarts:** Verified that `closeToTray` persists in SQLite `app_settings` across application shutdowns and restarts.
3. **Toast Background Lifecycle:** Verified that when the main window is hidden, the independent floating Download Toast (`progress_toast`) remains visible, active, and responsive.
4. **Toast Controls (Pause, Resume, Cancel):** Updated `DownloadToast.tsx` so clicking the red `×` button on active downloads invokes `cancel_download` while dismisses terminal items; verified Pause, Resume, and Cancel actions while the main window is hidden.
5. **Authenticated Desktop API:** Confirmed `127.0.0.1:6800` remains reachable, active, and strictly authenticated with Bearer tokens while hidden (unauthorized requests return `401 Unauthorized`).
6. **Crash vs Normal Close Forensic:** Verified lifecycle logs differentiate `WINDOW_CLOSE_COMMAND`, `CLOSE_REQUESTED`, `PREVENT_EXIT`, and `EXPLICIT_EXIT`. Verified **zero Rust panics** and **zero token leaks**.
7. **NSIS Installer Packaging Currency Audit:** Audited existing NSIS installer, identified that it contained pre-Gate 13.3 binaries, synchronized `resources/bin/` with current companion executables, and packaged a brand-new self-contained NSIS installer (`116,604,270 bytes`, SHA-256 `CCB6A6AA...`).

All 28 automated Gate 13.3.1 QA tests, 139/139 workspace Rust tests, and 15/15 production release guard checks passed without error or regression.

---

### 1. Detailed Verification by Requirement

#### 1. Close-to-Tray = ON vs OFF & Orphan Process Prevention
- **When `closeToTray = true` (Default Mode):**
  - Clicking the TitleBar `X` button triggers `window_close` -> `window.hide()`.
  - The process remains active in the background.
  - The Axum server on `127.0.0.1:6800` remains responsive.
  - Lifecycle log records: `[WINDOW] WINDOW_CLOSE_COMMAND: label=main, close_to_tray=true`.
- **When `closeToTray = false`:**
  - Clicking `X` or invoking Alt+F4 invokes `app_handle.exit(0)`.
  - Tauri terminates all open windows (including floating toast windows if active).
  - Port 6800 is released immediately.
  - Verified via Windows NT process inspection: **Zero `tori-download-manager` processes remain running**.
  - Lifecycle log records: `[WINDOW] WINDOW_CLOSE_COMMAND: label=main, close_to_tray=false` followed by `[APP] EXPLICIT_EXIT: Exiting with explicit code: Some(0)`.

#### 2. Close-to-Tray Setting Persistence across Restarts
- In `ui/src/App.tsx`, `update_engine_settings` writes the updated configuration to SQLite `app_settings`.
- In `src-tauri/src/tray.rs`, `is_close_to_tray_enabled()` reads directly from SQLite on every call.
- Verified: Setting `closeToTray: false`, shutting down TORI, and launching a fresh instance loads `closeToTray: false` from the database. Re-enabling `closeToTray: true` similarly survives application restarts.

#### 3. Floating Native Download Toast while Hidden
- Starting an authorized download via the Desktop API while the main window is hidden immediately opens the floating toast (`http://tauri.localhost/index.html?window=toast`).
- The toast displays real-time transfer metrics, circular SVG progress ring, filename, and connection details.

#### 4. Toast Interactive Controls (Pause, Resume, Cancel)
- **Pause:** Clicking the Pause button in the toast invokes `pause_download`, transitioning the backend job to `paused` state while hidden.
- **Resume:** Clicking the Resume button in the toast invokes `resume_download`, returning the backend job to `downloading` state while hidden.
- **Cancel:** Updated `DownloadToast.tsx` so clicking the red `×` button on an active download triggers `cancel_download` in the backend before dismissing the card from the toast, transitioning the backend job to `cancelled` state.

#### 5. Tray Menu Controls & Exit Behavior
- **Open TORI:** Restores, unminimizes, and focuses the primary window.
- **Pause All:** Iterates active jobs and pauses them safely.
- **Resume All:** Iterates paused jobs and resumes download queues.
- **Exit TORI without active downloads:** Exits immediately without prompts.
- **Exit TORI with active downloads:** Displays a modal confirmation warning the user, pauses active downloads upon confirmation, and exits cleanly.

#### 6. Authenticated Desktop API on Port 6800
- While running in the system tray, requests to `http://127.0.0.1:6800/api/v1/downloads` with a valid Bearer token succeed with `200 OK`.
- Requests without a valid token are rejected with `401 Unauthorized` (`"Authentication required."`), ensuring full CORS and API security while operating in the background.

#### 7. Crash vs Normal Close Lifecycle Diagnostics
- Bounded rotating log at `%APPDATA%\tori-download-manager\logs\lifecycle.log` was reviewed:
  - Startup and shutdown events are logged with precise ISO 8601 timestamps and process IDs.
  - Normal closes log `WINDOW_CLOSE_COMMAND` and `CLOSE_REQUESTED`.
  - Token scrubbing was validated: 0 raw `tori_<hex>` tokens or Bearer authorization headers exist in the log.
  - **Zero Rust panics** and **zero unexpected crashes** were observed.

#### 8. NSIS Installer Currency Audit
- **Audit Finding:** The existing installer `target/release/bundle/nsis/TORI Download Manager_2.0.0_x64-setup.exe` had a timestamp of `11/6/2026 4:47:28 PM`, pre-dating the Gate 13.3 release binaries (`5:15:45 PM`). Furthermore, `resources/bin/tdm-native-host.exe` and `resources/bin/tdm-cli.exe` had not been synchronized with the latest release builds.
- **Remediation:** Synchronized companion binaries from `target/release/` to `resources/bin/`, updated `DownloadToast.tsx`, rebuilt the release binary, and executed `cargo tauri build --bundles nsis`.
- **New Installer Details:**
  - Filename: `TORI Download Manager_2.0.0_x64-setup.exe`
  - Size: `116,604,270 bytes` (111.20 MB)
  - Last Modified: `11/6/2026 6:01:11 PM`
  - SHA-256: `CCB6A6AAF7B421140733D7194690ACF4D75CBBE178697D8B8161FE594264B608`
  - Currency Status: **CURRENT & VERIFIED**

---

### 2. Automated Test Results: `verify_gate13_3_1_qa.js`

```powershell
node scripts/verify_gate13_3_1_qa.js
```

| Section | Assertion | Result | Details |
|---|---|---|---|
| **Sec 1** | TORI Desktop API ready on port 6800 | **PASS** | `status: "ok"` |
| **Sec 1** | Native Messaging auto-pairing succeeded | **PASS** | Returned valid token |
| **Sec 1** | CDP connected to main TORI window | **PASS** | Attached to `http://tauri.localhost/` |
| **Sec 1** | Process remains running after X with closeToTray=true | **PASS** | Process PID active |
| **Sec 1** | Desktop API active while in tray | **PASS** | Port 6800 responsive |
| **Sec 2** | Download creation accepted via Desktop API while hidden | **PASS** | Job enqueued |
| **Sec 2** | Native Download Toast window spawned and detected via CDP | **PASS** | `window=toast` target active |
| **Sec 2** | Download successfully paused via Toast control | **PASS** | `state: paused` |
| **Sec 2** | Download successfully resumed via Toast control | **PASS** | `state: downloading` |
| **Sec 2** | Download successfully cancelled via Toast Cancel button | **PASS** | `state: cancelled` |
| **Sec 3** | Unauthorized request without token rejected with 401 | **PASS** | HTTP 401 Unauthorized |
| **Sec 3** | Authorized request with valid Bearer token returns 200 | **PASS** | HTTP 200 OK |
| **Sec 4** | TORI process exited completely when closeToTray=false | **PASS** | Process terminated |
| **Sec 4** | Desktop API port 6800 released immediately | **PASS** | ECONNREFUSED on port 6800 |
| **Sec 4** | Zero orphan tori-download-manager processes running | **PASS** | 0 orphan PIDs |
| **Sec 5** | TORI instance 2 started up successfully | **PASS** | Process restarted |
| **Sec 5** | CDP connected to TORI instance 2 | **PASS** | Re-attached |
| **Sec 5** | closeToTray=false persisted across restart in SQLite | **PASS** | `closeToTray: false` verified |
| **Sec 6** | Lifecycle log exists at APPDATA/logs/lifecycle.log | **PASS** | File verified |
| **Sec 6** | Log records STARTUP events | **PASS** | Event verified |
| **Sec 6** | Log records TRAY INITIALIZED events | **PASS** | Event verified |
| **Sec 6** | Log records WINDOW_CLOSE_COMMAND | **PASS** | Event verified |
| **Sec 6** | Log records close_to_tray=true state | **PASS** | Event verified |
| **Sec 6** | Log records close_to_tray=false state | **PASS** | Event verified |
| **Sec 6** | Zero Rust panics recorded in lifecycle log | **PASS** | 0 panics |
| **Sec 6** | Zero authentication tokens leaked in lifecycle log | **PASS** | 0 tokens leaked |
| **Sec 7** | Current release executable exists | **PASS** | Binary verified |
| **Sec 7** | NSIS installer currency status audited | **PASS** | Status: **CURRENT** |

**Total:** **28 PASSED, 0 FAILED**

---

### 3. Regression Verification Results

| Suite | Command | Result |
|---|---|---|
| **Code Formatting** | `cargo fmt --all -- --check` | Clean, 0 diffs |
| **Clippy Linter** | `cargo clippy --workspace --all-targets -- -D warnings` | Clean, 0 warnings |
| **Workspace Unit Tests** | `cargo test --workspace` | **139 passed**, 0 failed |
| **Production Release Guard** | `scripts/verify_production_release.ps1` | **15 passed**, 0 failed |
| **Gate 13.3 Test Harness** | `scripts/verify_gate13_3_tray_and_lifecycle.js` | **21 passed**, 0 failed |
| **Gate 13.3.1 QA Harness** | `scripts/verify_gate13_3_1_qa.js` | **28 passed**, 0 failed |

---

### 4. Verified Executables & Installer Inventory

| File | Size (Bytes) | SHA-256 Checksum |
|---|---|---|
| `target/release/tori-download-manager.exe` | 28,444,160 | `1591379CBF79A2FAC4F0AD4CC23D24485FE55694AC9419C97665BEFB260ED604` |
| `target/release/tdm-native-host.exe` | 16,556,544 | `2F20B446503D0440926D0196AF1DAABA765D1E4123084FF53DA81A0012F09896` |
| `target/release/tdm-cli.exe` | 16,444,416 | `E52E6B7C13E79DD9C898C4ACBB9DF0A0DAB8B56390176A3A0424F7A7C4F08425` |
| `target/release/bundle/nsis/TORI Download Manager_2.0.0_x64-setup.exe` | 116,604,270 | `CCB6A6AAF7B421140733D7194690ACF4D75CBBE178697D8B8161FE594264B608` |

---

### Conclusion & Readiness

Gate 13.3.1 has resolved every edge case and lifecycle question raised. Close-to-Tray ON vs OFF guarantees process termination with zero orphans when disabled, settings survive restarts, Toast controls operate seamlessly while hidden, the desktop API is authenticated and persistent, and the self-contained NSIS installer packages the updated binaries. TORI Download Manager v2.0 is fully verified and stable.
