# TORI Download Manager v1.0.1 — Milestone Plan: Gate 17.5
## Desktop UI, Settings & Progress Window Functional QA

### Objective
Perform comprehensive, real desktop functional QA of the Tauri 2 + React interface, including the newly implemented scheduler, download table, settings, themes, dialogs, context menus, and independent progress window. Diagnose and fix any confirmed functional or visual defects without redesigning TORI or altering the existing download architecture.

Maintain development on `dev/v1.0.1` at commit `d91cfdc`. Preserve stable installed v1.0.0 untouched. Clean Windows Sandbox / installer QA remain deferred.

---

### Specific Measurable Milestones

#### Milestone 1: Baseline Checkpoint & Isolated Harness Setup (Task 1)
- [x] Verify Git branch (`dev/v1.0.1`), HEAD commit (`d91cfdc`), clean working tree.
- [x] Confirm stable public TORI v1.0.0 exists untouched (`C:\Program Files\Tori Download Manager`).
- [x] Build updated release binary `target/release/tori-download-manager.exe` with embedded `ui/dist`.
- [x] Create isolated test environment (`target/gate17_5_env`) with disposable data dir, downloads dir, edge profile dir, and test SQLite DB.

#### Milestone 2: Actual Desktop UI Inspection via CDP & Headless WebView2 (Task 2)
- [x] Launch `tori-download-manager.exe` with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222"`.
- [x] Connect via CDP WebSocket to the real running Tauri desktop application.
- [x] Inspect main window layout: Top toolbar, sidebar, download table, columns, status bar, and icons.
- [x] Verify right-click context menu positioning, actions, and dismiss behavior.
- [x] Verify dialogs: Add Download modal, Settings modal, About tab, Delete confirmation modal.
- [x] Test layout at Windows display scalings (100%, 125%, 150%) and check for clipping, overlap, or scrollbar issues.
- [x] Capture visual screenshots of key states (`task2_layout_100pct.png`, `task2_layout_125pct.png`, `task2_layout_150pct.png`).

#### Milestone 3: Scheduler UI Acceptance (Task 3)
- [x] Open Add Download modal. Verify "Download now / manual" default.
- [x] Select "Schedule for later ⏰". Verify date and time inputs activate.
- [x] Test past date/time rejection (shows validation warning, disables Add).
- [x] Submit valid future scheduled download.
- [x] Verify scheduled job appears in download list with "Scheduled" badge and formatted local time.
- [x] Test context menu "Reschedule download…" action and verify time updates in DB and UI.
- [x] Test context menu "Start Download Now" and verify immediate dispatch.
- [x] Verify downloaded bitstream SHA-256 matches source fixture.

#### Milestone 4: Download Table & Action Matrix (Task 4)
- [x] Verify handling of Unicode URLs (fixed percent-decoding in probe: `unicode_日本語_test.zip`).
- [x] Verify handling of long filenames (>150 chars) without layout collapse.
- [x] Verify handling of unknown file size (chunked streaming) with zero NaN/Infinity values.
- [x] Verify that removing from list (`deleteFiles: false`) removes history while keeping completed files on disk 100% intact.

#### Milestone 5: Settings Persistence & Backend Alignment (Task 5)
- [x] Inspect SettingsModal controls: `maxa`, `con`, `retries`.
- [x] Verify settings persist to SQLite database (`engine_settings` table, `app_settings` key).
- [x] Capture screenshot of Settings modal (`task5_settings_modal.png`).

#### Milestone 6: Independent Progress Window (DownloadToast) QA (Task 6)
- [x] Trigger progress window via `open_progress_window`.
- [x] Discover dedicated WebView2 toast target (`index.html?window=toast`).
- [x] Verify `.toast` card, filename, progress ring, and close button `.cx`.
- [x] Capture screenshot (`task6_progress_toast.png`).

#### Milestone 7: Dark / Light Theme QA (Task 7)
- [x] Switch theme dynamically between Dark and Light.
- [x] Verify CSS tokens and contrast ratios (`--win: #232326` dark, `--win: #f5f5f8` light).
- [x] Capture screenshots of both themes (`task7_theme_dark.png`, `task7_theme_light.png`).

#### Milestone 8: Browser Extension Handoff Verification (Task 8)
- [x] Launch Microsoft Edge with TORI extension in isolated profile.
- [x] Verify content script attaches video overlay in DOM (`data-tori-attached`).
- [x] Verify Native Messaging pairing via `chrome.runtime.sendNativeMessage` returns valid token.
- [x] Verify HTML5 media candidate discovery in background service worker.

#### Milestone 9: Performance, Memory & Window Lifecycle (Task 9)
- [x] Measure Rust engine memory (Working Set: 51.03 MB < 75 MB limit; Private Bytes: 12.95 MB < 50 MB limit).
- [x] Verify single-instance forwarding (secondary instance exits cleanly).
- [x] Verify zero orphan processes upon exit.

#### Milestone 10: Targeted Bug Fixes & Regression Verification (Task 10 & Task 11)
- [x] Apply minimal safe fixes:
  - `crates/tdm-core/src/engine/probe.rs`: Added URL percent decoding for extracted filenames.
  - `ui/src/components/DownloadTable.tsx`: Added `data-id` attribute on table rows.
  - `ui/src/components/SettingsModal.tsx`: Added `id="scon"`, `id="smaxa"`, `id="sretries"` on numeric inputs.
  - `extension/background.js`: Corrected `GET_ALL_MEDIA` check to allow options page tabs.
- [x] Run `cargo fmt --all -- --check` (PASS).
- [x] Run `cargo clippy --workspace --all-targets -j 2 -- -D warnings` (PASS).
- [x] Run `cargo test --workspace -j 2` (PASS, 100% test pass).
- [x] Run `cd ui; npm run build` (PASS).

#### Milestone 11: Final Report & Clean Local Commit (Task 12)
- [x] Create `GATE17_5_DESKTOP_UI_FUNCTIONAL_QA_REPORT.md`.
- [ ] Update `IMPLEMENTATION_STATUS.md`.
- [ ] Commit locally on `dev/v1.0.1`.
- [ ] STOP after Gate 17.5.
