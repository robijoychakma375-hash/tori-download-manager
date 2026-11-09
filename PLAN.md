# TORI Download Manager v1.0.1 — Milestone Plan: Gate 17.4.2
## Native Time-Based Download Scheduler

### Objective
Implement a reliable, persistent, one-time time-based Download Scheduler using TORI's existing Rust engine, Tokio runtime, SQLite database, queue management, and Tauri 2 + React desktop interface.

Preserve all previously validated Gate 15.x, 17.0, 17.1, 17.2, 17.3, 17.4, and 17.4.1 functionality without introducing secondary engines, external daemons, or speculative architecture rewrites.

---

### Specific Measurable Milestones

#### Milestone 1: Baseline Checkpoint & Audit (Task 1 & Task 2)
- [x] Verify Git branch (`dev/v1.0.1`), expected baseline HEAD (`aaa7059`), clean working tree, untracked verification scripts.
- [x] Confirm stable public TORI v1.0.0 exists untouched (`C:\Program Files\Tori Download Manager`).
- [x] Inspect existing `DownloadManager`, `JobState`, SQLite schema/migrations, startup reconciliation, Tauri commands, Native Host APIs, and UI (`AddDownloadModal.tsx`, `DownloadTable.tsx`).
- [x] Formulate minimal reliable integration path.

#### Milestone 2: Persistent One-Time Scheduler Data Model & SQLite Migration (Task 3)
- [x] Extend `JobState` enum with `JobState::Scheduled`.
- [x] Extend `DownloadJob` struct with `scheduled_at: Option<DateTime<Utc>>`.
- [x] Add backward-compatible SQLite migration in `crates/tdm-core/src/db/schema.rs`: `ALTER TABLE downloads ADD COLUMN scheduled_at TEXT;`.
- [x] Add index on `idx_downloads_scheduled_at` for efficient lookup of due scheduled jobs.
- [x] Update `Database::insert_job`, `Database::get_job`, `Database::list_jobs`, and add query methods for scheduled jobs (`get_earliest_scheduled_time()`, `admit_due_scheduled_jobs(now)`).
- [x] Support rescheduling: `update_job_scheduled_at(id, Option<DateTime<Utc>>)`.

#### Milestone 3: Scheduler Engine Integration in `tdm-core` (Task 4 & Task 5)
- [x] Implement event-driven Tokio scheduler loop in `DownloadManager`:
  - Uses `tokio::sync::Notify` to wake up on new schedules, cancels, or reschedules.
  - Computes sleep duration: `due_time - now_utc`.
  - Non-busy sleep via `tokio::time::sleep`.
  - When timer fires or catch-up runs: atomically transitions due jobs from `JobState::Scheduled` to `JobState::Queued` in priority/FIFO order, and calls `process_queue()`.
  - Overdue catch-up policy on startup: during `reconcile_on_startup()`, any job with `state = 'scheduled'` and `scheduled_at <= now` is transitioned to `JobState::Queued` to execute immediately according to catch-up policy.
  - If `scheduled_at > now`, job remains `JobState::Scheduled`, and the scheduler timer is armed.
  - Cancelled or paused scheduled jobs transition cleanly and never start.

#### Milestone 4: Tauri Commands & Local API Integration (Task 7)
- [x] Update Tauri commands in `src-tauri/src/commands/`:
  - `create_download` accepts optional `scheduled_at: Option<String>`.
  - Add `reschedule_download(id: String, scheduled_at: Option<String>)`.
  - Add `cancel_download` / `pause_download` handling for scheduled jobs.
- [x] Update Native Host HTTP server in `crates/tdm-native-host/src/server.rs`:
  - `CreateDownloadReq` accepts optional `scheduled_at: Option<String>`.
  - `/api/v1/downloads/{id}/reschedule` endpoint for updating schedule.
  - Maintain backwards compatibility: immediate download when `scheduled_at` is omitted/null.

#### Milestone 5: Desktop UI Integration (Task 6)
- [x] In `ui/src/components/AddDownloadModal.tsx`:
  - Add "Download Now" vs "Schedule Download" toggle.
  - Local date picker and time picker with minimum validation (cannot be in the past).
  - Clean validation message and formatted local timezone display.
- [x] In `ui/src/components/DownloadTable.tsx` / `ContextMenu.tsx`:
  - Render "Scheduled" badge with formatted local date & time.
  - Add Reschedule and Start Now buttons/actions for scheduled tasks.
  - Preserve visual design, Dark/Light theme, and existing actions.

#### Milestone 6: Automated End-to-End Tests & Safety Validation (Task 8)
- [x] Create `crates/tdm-core/tests/gate17_4_2_scheduler_tests.rs`:
  - Test 1: Immediate download default.
  - Test 2: Near-future scheduled download fires on time and completes.
  - Test 3: Multiple jobs due simultaneously fire in priority order.
  - Test 4: Scheduled job respects `max_active_jobs` capacity.
  - Test 5: Engine restart before due time keeps job scheduled; fires on schedule.
  - Test 6: Engine restart after due time applies catch-up policy; executes safely.
  - Test 7: Cancelled scheduled job never starts.
  - Test 8: Paused scheduled job never starts until resumed.
  - Test 9: Rescheduled job starts at new time, not old time.
  - Test 10: Clear schedule to queued executes immediately.
- [x] Create `scripts/verify_gate17_4_2_scheduler_e2e.js`:
  - Real end-to-end test against release binary and UI API (4/4 scenarios passed).
  - SHA256 integrity verification of completed payloads.

#### Milestone 7: Full Workspace Regression Validation (Task 9)
- [x] `cargo fmt --all -- --check`
- [x] `cargo clippy --workspace --all-targets -j 2 -- -D warnings`
- [x] `cargo test --workspace -j 2`
- [x] Frontend `cd ui; npm run build`

#### Milestone 8: Final Report & Clean Local Commit (Task 10)
- [x] Generate `GATE17_4_2_NATIVE_SCHEDULER_REPORT.md`.
- [x] Update `IMPLEMENTATION_STATUS.md`.
- [x] Create clean local commit on `dev/v1.0.1`.
- [x] STOP after Gate 17.4.2.
