# TORI Download Manager v1.0.1 — Milestone Plan: Gate 17.4
## Persistent Queue, Scheduler & Crash Recovery Reliability

### Objective
Verify and strengthen TORI's existing download queue, scheduler, pause/resume, partial-file preservation, SQLite persistence, and unexpected process recovery across all protocols, preserving all previously validated Gate 15.x, Gate 17.0, Gate 17.1, Gate 17.2, and Gate 17.3 functionality without introducing replacement download engines or speculative architecture rewrites.

---

### Specific Measurable Milestones

#### Milestone 1: Checkpoint & Gate 17.3 Safety Audit (Task 1)
- [x] Verify Git branch (`dev/v1.0.1`), expected baseline HEAD (`fcb12a5`), clean working tree, and untracked verification scripts.
- [x] Confirm stable public TORI v1.0.0 exists untouched (`C:\Program Files\Tori Download Manager`).
- [x] Audit Gate 17.3 changes:
  1. `GET_ALL_MEDIA` handler in `extension/background.js` guarded against caller tabs; content scripts rejected.
  2. Localhost / `127.0.0.1` content-script match patterns preserved for local test harnesses.
  3. Authentication and ownership checks for `POST /api/v1/downloads/{id}/progress` verified (401/404).
  4. Secondary-instance Tokio runtime fix in `src-tauri/src/lib.rs` verified.
  5. 10-second Native Messaging auto-pair cooldown active.

#### Milestone 2: Queue Behavior & Bounded Concurrency (Task 2)
- [x] Test queueing 10–30 concurrent download requests under bounded concurrency (`max_active_jobs = 4`).
- [x] Verify unique job IDs and proper SQLite insertion in `JobState::Queued`.
- [x] Verify priority ordering: High > Normal > Low, with FIFO (`created_at ASC`) within identical priority.
- [x] Verify worker capacity release: when an active job completes, pauses, or cancels, the next queued job is automatically dispatched.
- [x] Verify paused jobs release their active worker slot immediately without consuming worker concurrency.
- [x] Verify cancelled jobs do not restart automatically.
- [x] Verify failed jobs respect retry policies without queue stalling or worker starvation.

#### Milestone 3: Pause & Resume Across 8 Server/Network Edge Conditions (Task 3)
- [x] Condition 1: Accept-Ranges server (partial-content 206, byte offset preservation).
- [x] Condition 2: Server without HTTP Range support (explicit restart single-stream fallback).
- [x] Condition 3: Intermittent network failures (transient socket drop & reconnection).
- [x] Condition 4: Slow network connection / throttled transfer.
- [x] Condition 5: Interrupted chunk transfer during active chunk download.
- [x] Condition 6: Stale ETag / Last-Modified metadata (validator mismatch detection; resets chunk plans and purges stale parts).
- [x] Condition 7: Changed Content-Length upon resume (re-plans chunks to prevent corrupted file assembly).
- [x] Condition 8: Corrupt or missing partial `.tdm-part` chunk (resets SQLite chunk progress and re-fetches cleanly).
- [x] Verify byte-for-byte SHA256 integrity on all completed files.

#### Milestone 4: Application Crash Recovery Across 5 Execution Stages (Task 4)
- [x] Interrupt development engine at Stage 1: Initial connection / probing.
- [x] Interrupt development engine at Stage 2: Active chunk writing (mid-stream).
- [x] Interrupt development engine at Stage 3: Final chunk completion.
- [x] Interrupt development engine at Stage 4: File assembly / rename from `.tdm-part` to final.
- [x] Interrupt development engine at Stage 5: SQLite state commit.
- [x] Verify `reconcile_on_startup()` transitions interrupted active jobs to `Paused` without false `Completed`.
- [x] Verify resumed jobs achieve byte-perfect SHA256 matches.

#### Milestone 5: Scheduler Reliability (Task 5)
- [x] Audit scheduling mechanisms (priority queue scheduling, adaptive straggler scheduling, queue advancement).
- [x] Test future scheduled execution / delayed queue dispatch where applicable.
- [x] Test paused scheduled jobs, cancelled scheduled jobs, and missed execution windows.
- [x] Confirm cancelled or paused jobs never start unexpectedly.

#### Milestone 6: Storage and File Safety (Task 6)
- [x] Verify SQLite WAL consistency (`PRAGMA integrity_check` = ok), zero duplicate records, and atomic transactions.
- [x] Verify partial-file preservation: `.tdm-part` files are never prematurely deleted.
- [x] Verify file collision safety: `coll_doc (1).pdf` avoidance without overwriting existing user data.
- [x] Verify graceful handling of permission-denied / disk-full edge conditions.

#### Milestone 7: Multi-Protocol Recovery Capability Matrix (Task 7)
- [x] Direct HTTP/HTTPS: Pause, Resume (HTTP 206), Restart, Retry, Cancel, Partial file preserved.
- [x] Multi-Chunk HTTP: Pause, Resume (chunk byte offsets), Restart, Retry, Cancel, Partial file preserved.
- [x] Native HLS VOD: Pause, Resume (segment restart), Restart, Retry, Cancel, Clean MP4 remux.
- [x] Native DASH VOD: Pause, Resume (segment restart), Restart, Retry, Cancel, Clean MP4 remux.
- [x] AES-128 Encrypted HLS: Pause, Resume (key cached), Restart, Retry, Cancel, Decrypts to valid MP4.

#### Milestone 8: Resource Stability & Long-Running Profile (Task 8)
- [x] Working Set physical memory bounded < 75 MB (measured: 29.38 MB).
- [x] Private Bytes memory bounded < 50 MB (measured: 13.00 MB).
- [x] Zero orphan background processes (`tdm-native-host`, `ffmpeg`, `yt-dlp` = 0).
- [x] Background thumbnail backfill conditioned on video extensions to prevent process churn.

#### Milestone 9: Targeted Bug Fixes (Task 9)
- [x] Multi-slot worker advancement loop in completion/pause/cancel callbacks.
- [x] Concurrency cap enforcement in `start_job_internal` preventing unconstrained worker spawns.
- [x] Validator re-verification on resume (ETag, Last-Modified, Content-Length, Range support).
- [x] Missing or corrupt partial file auto-recovery.
- [x] GET_ALL_MEDIA cross-tab isolation in extension background worker.

#### Milestone 10: Regression Verification (Task 10)
- [x] `cargo fmt --all -- --check` (0 differences).
- [x] `cargo clippy --workspace --all-targets -j 2 -- -D warnings` (0 warnings).
- [x] `cargo test --workspace -j 2` (100% passing across all workspace suites).
- [x] Frontend `cd ui; npm run build` (0 errors).

#### Milestone 11: Final Report & Clean Commit (Task 11)
- [ ] Deliver `GATE17_4_QUEUE_SCHEDULER_RECOVERY_REPORT.md` artifact.
- [ ] Commit changes locally on `dev/v1.0.1` branch without version bump.
- [ ] All destructive file tests execute in isolated disposable test directories.

#### Milestone 7: Multi-Protocol Recovery Matrix (Task 7)
- [ ] Direct HTTP/HTTPS: Pause, Resume, Restart recovery, Retry, Cancellation, Partial preservation.
- [ ] HLS VOD: Pause, Resume, Restart recovery, Retry, Cancellation, Partial preservation.
- [ ] DASH VOD: Pause, Resume, Restart recovery, Retry, Cancellation, Partial preservation.
- [ ] AES-128 Encrypted HLS: Key caching, Segment recovery, Playable output.
- [ ] Multi-chunk HTTP: Range redistribution, Split plan, Assembly integrity.
- [ ] Truthful capability matrix distinguishing fully resumable protocols from restart-required protocols.

#### Milestone 8: Resource & 20-30 Minute Longer-Duration Stability Benchmark (Task 8)
- [ ] Run continuous 20–30 minute workload with real fixtures and queue churning.
- [ ] Measure Engine Working Set (RAM), Private Bytes, CPU usage, file handles, network sockets, worker tasks.
- [ ] Verify zero memory leaks, zero stalled jobs, and zero orphan companion processes (`ffmpeg`, `yt-dlp`, `tdm-native-host`).

#### Milestone 9 & 10: Targeted Bug Fixing & Regression Verification (Task 9 & 10)
- [ ] Deterministic failing tests for any identified bugs.
- [ ] Minimal safe fixes with zero speculative architecture rewrites.
- [ ] Run:
  - `cargo fmt --all -- --check`
  - `cargo clippy --workspace --all-targets -j 2 -- -D warnings`
  - `cargo test --workspace -j 2`

#### Milestone 11: Final Report & Local Commit (Task 11)
- [ ] Produce `GATE17_4_QUEUE_SCHEDULER_RECOVERY_REPORT.md`.
- [ ] Update `IMPLEMENTATION_STATUS.md`.
- [ ] Commit locally to `dev/v1.0.1`.
- [ ] STOP; do not proceed to Gate 17.5.
