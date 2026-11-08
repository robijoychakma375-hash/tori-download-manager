# TORI Download Manager v1.0.1 — Milestone Plan: Gate 17.4.1
## Scheduler & Long-Run Reliability Evidence Closure

### Objective
Close two critical evidence gaps from Gate 17.4 before proceeding to Gate 17.5:
1. Forensic audit and acceptance testing of TORI's actual scheduler features (priority queue vs. wall-clock scheduling).
2. Controlled 20–30 minute continuous long-run stability workload measuring physical working set, private bytes, CPU, file handles, SQLite growth, and child processes across multiple concurrent and adaptive streaming downloads.

Preserve all previously validated Gate 15.x, 17.0, 17.1, 17.2, 17.3, and 17.4 functionality without speculative feature additions or engine rewrites.

---

### Specific Measurable Milestones

#### Milestone 1: Review Existing Evidence (Task 1)
- [x] Review `GATE17_4_QUEUE_SCHEDULER_RECOVERY_REPORT.md`, Gate 17.4 test results, SQLite schema, and existing benchmarks.
- [x] Audit existing scheduler implementation in `crates/tdm-core/src/db/repo.rs`, `manager.rs`, and `adaptive.rs`.
- [x] Determine exact coverage and isolate the two evidence gaps.

#### Milestone 2: Scheduler Acceptance & Feature Inventory (Task 2)
- [x] Identify features actually implemented in TORI (Priority Queue Scheduler, Bounded Concurrency Governor, Adaptive Straggler Scheduler).
- [x] Explicitly inventory unsupported/absent features (Future scheduled download start, wall-clock time execution, delayed execution, missed time handling).
- [x] Execute deterministic tests for all 9 required verification points:
  1. Future scheduled download start (Verify absence / unsupported status honestly: No `scheduled_at` column/field in TORI).
  2. Persistent scheduled job state (Verify `JobState::Queued` persistence in SQLite).
  3. Application restart before execution (Verify queued jobs persist across restarts and reconcile on startup).
  4. Correct execution when due (Verify priority `high > normal > low` and FIFO queue dispatch when slots free).
  5. Cancelled scheduled jobs remain cancelled (Verify cancelled jobs never auto-start or return from scheduler).
  6. Paused scheduled jobs do not start unexpectedly (Verify paused jobs remain paused and ignored by `get_next_queued_job`).
  7. No duplicate execution after repeated scheduler evaluation (Verify idempotency of `process_queue` and `start_download`).
  8. Correct handling of missed scheduled times (Verify absence / unsupported status honestly: No wall-clock schedule exists).
  9. Correct SQLite state transitions (`Queued -> Downloading -> Paused / Completed / Cancelled`).

#### Milestone 3: Controlled 20–30 Minute Long-Run Stability Workload (Task 3)
- [x] Construct realistic, controlled multi-workload harness using disposable test data:
  - Multiple concurrent queued HTTP downloads (bounded to 3 active slots).
  - Native HLS VOD streaming workflow with multi-segment TS chunks remuxing to MP4.
  - Periodic pause and resume operations mid-stream (pause @ 3m, resume @ 6m).
  - Temporary network interruption (transient 503 from 8m to 9m) with automatic retry recovery.
  - Normal download completions with SHA-256 byte-for-byte integrity verification.
- [x] Run continuous 20-minute workload (1,200 seconds / 20.9 min actual) with periodic 30-second sampling (40 samples):
  - Rust engine Working Set: 30.47 MB initial -> 32.69 MB final (+2.22 MB net drift, peak 33.96 MB < 75 MB limit).
  - Private Bytes: 12.80 MB initial -> 13.40 MB final (+0.60 MB net drift, peak 14.11 MB < 50 MB limit).
  - Engine CPU utilization: baseline 0.0% – 0.5%.
  - OS File Handle count: 666 – 692 handles (stable).
  - SQLite DB and WAL storage footprint: 12 KB DB, 664 KB – 1086 KB WAL (strictly bounded).
  - Temporary `.tdm-part` disk usage: cleaned atomically on job completion.
  - Active worker concurrency vs. queued count: strictly bounded to $\le 3$.
  - Companion orphan processes: 0 `tdm-native-host`, 0 `ffmpeg`, 0 `yt-dlp`.
- [x] Confirm no memory leak, handle leak, or unhandled process degradation over 20+ minutes.

#### Milestone 4: Critical Safety Review (Task 4)
- [x] Verify original download data preservation during normal resume (byte-perfect SHA-256).
- [x] Verify safe invalidation of stale partial files when server validators change (stale V1 purged, fresh V2 assembled).
- [x] Verify correct file-size mismatch handling.
- [x] Verify no duplicate job execution (single SQLite record, token deduplication).
- [x] Verify no accidental deletion of completed downloads (collision detection preserves original, saves as `filename (1).ext`).
- [x] Verify no cross-tab media exposure to untrusted content scripts (caller tab validation on `GET_ALL_MEDIA`).
- [x] Confirm all tests execute strictly within isolated disposable directories (`%TEMP%\tori_*`).

#### Milestone 5: Evidence Closure Report & Repository Hygiene (Task 5)
- [ ] Deliver `GATE17_4_1_EVIDENCE_CLOSURE_REPORT.md` in artifact directory.
- [ ] Update `IMPLEMENTATION_STATUS.md` with verified status.
- [ ] Verify zero regressions (`cargo fmt`, `cargo clippy`, `cargo test`).
- [ ] Commit locally on `dev/v1.0.1` branch without version bump.
- [ ] STOP immediately after Gate 17.4.1.
