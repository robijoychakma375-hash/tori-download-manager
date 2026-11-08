# TORI Download Manager v1.0.1 — Milestone Plan: Gate 17.3
## Browser Extension, Native Messaging & Desktop Lifecycle Stability

### Objective
Ensure TORI remains reliable when Microsoft Edge/Chrome, the Manifest V3 extension service worker, Native Messaging host, Local API server, desktop application, or progress window is restarted, disconnected, or temporarily unavailable, preserving all completed Gate 15.x, 17.0, 17.1, and 17.2 functionality without introducing speculative architecture rewrites.

---

### Specific Measurable Milestones

#### Milestone 1: Baseline Checkpoint & Audit
- [x] Verify Git branch (`dev/v1.0.1`), expected baseline HEAD (`91174fc`), clean working tree, and untracked verification scripts.
- [x] Confirm stable public TORI v1.0.0 exists untouched (`C:\Program Files\Tori Download Manager`).
- [x] Verify development binaries (`target/release/tori-download-manager.exe`, `target/release/tdm-native-host.exe`).

#### Milestone 2: Extension Service-Worker Lifecycle & Session Continuity
- [ ] Test MV3 service-worker idle suspension and wake-up in real Microsoft Edge via CDP.
- [ ] Verify active downloads run independently in the desktop engine without depending on extension worker.
- [ ] Verify popup reopening reconnects seamlessly, displays existing jobs accurately, and creates zero duplicates.
- [ ] Verify media candidates persist across service-worker cycles via `chrome.storage.session`.

#### Milestone 3: Desktop Disconnection, Reconnection & Native Messaging
- [ ] Test offline desktop behavior on browser startup (graceful disconnected status, click-to-pair / click-to-retry).
- [ ] Test desktop termination while popup is active and recovery when desktop is restored.
- [ ] Verify bounded retry logic: no infinite loop, no CPU pegging, no token leakage in logs.
- [ ] Test Native Messaging host single-instance guarantee: ensure `ensure_engine_running()` does not spawn redundant desktop processes if an engine is already active.

#### Milestone 4: Background Download Continuity Matrix
- [ ] Differentiate and document the 6 lifecycle actions:
  1. Close extension popup -> background download continues unimpeded.
  2. Close source browser tab -> background download continues unimpeded.
  3. Close Microsoft Edge completely -> background download continues in desktop engine.
  4. Close TORI main window -> if `closeToTray: true` (default), window hides to tray and downloads continue; if false, exits cleanly.
  5. Explicit application exit -> prompts if active downloads exist, gracefully stops downloads.
  6. Unexpected backend crash -> SQLite persistence allows job resumption without data corruption.
- [ ] Empirically test each action in an automated test harness.

#### Milestone 5: Queue, Progress, SQLite Persistence & Progress Window
- [ ] Verify stable job IDs, consistent speed/ETA calculations, and bounded progress updates.
- [ ] Verify progress window / toast sync and state preservation across open/close cycles.
- [ ] Verify SQLite job state transitions (active $\to$ completed / failed / paused) survive desktop restart.

#### Milestone 6: Real Browser Media Detection & Gate 17.2 Regression
- [ ] Verify Gate 17.2 fixes in real Microsoft Edge:
  - Multiple HTML5 videos within shared parent container.
  - Dynamically injected video elements (MutationObserver).
  - Direct MP4 immediate native download routing.
  - HLS & DASH manifest capture and segment suppression.
  - Vimeo embed normalization and referer propagation.
  - Referer / User-Agent sanitization and SQLite persistence.

#### Milestone 7: Security, Resource Stability & Memory Profiling
- [ ] Verify origin validation on Local API (`403 Forbidden` / `400 Bad Request` on unauthorized origins).
- [ ] Verify Native Messaging origin enforcement.
- [ ] Verify token scrubbing in lifecycle logs.
- [ ] Measure memory across repeated disconnect/reconnect cycles (Working Set bounded < 75 MB, Private Bytes < 50 MB).
- [ ] Confirm zero orphan `tdm-native-host.exe`, `yt-dlp.exe`, or `ffmpeg.exe` processes.

#### Milestone 8: Automated Regression, Report & Local Commit
- [ ] Execute `cargo test --workspace`.
- [ ] Execute `cargo fmt --all -- --check`.
- [ ] Execute `cargo clippy --workspace --all-targets -- -D warnings`.
- [ ] Produce `GATE17_3_BROWSER_DESKTOP_STABILITY_REPORT.md` and update `IMPLEMENTATION_STATUS.md`.
- [ ] Commit verified bug fixes locally to `dev/v1.0.1`.
