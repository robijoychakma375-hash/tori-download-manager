# TORI Download Manager v1.0.1 — Milestone Plan: Gate 17.7
## Desktop Memory Optimization + Project Storage Cleanup

### Objectives
1. Investigate TORI's high WebView2 process-tree memory consumption across lifecycle states.
2. Identify and fix confirmed desktop memory or lifecycle leaks.
3. Analyze why `F:\TORI` occupies ~70.2 GB with recursive directory and file inventory.
4. Safely remove verified disposable temporary and test files without damaging source code, test infrastructure, Git history, dependencies, release binaries, or user data.
5. Preserve all previously validated Gate 15–17.6 functionality without indiscriminate deletion or unverified rewrites.

Maintain development on `dev/v1.0.1` at baseline commit `adca31f`. Preserve stable installed v1.0.0 untouched. Clean Windows Sandbox / installer QA remain deferred.

---

### Specific Measurable Milestones

#### Milestone 1: Baseline Checkpoint & System Overview (Task 1)
- [x] Verify Git branch (`dev/v1.0.1`), HEAD commit (`adca31f`), clean working tree.
- [x] Confirm stable public TORI v1.0.0 exists untouched (`C:\Program Files\Tori Download Manager`).
- [x] Preserve all untracked test scripts, metrics, and reports.

#### Milestone 2: Desktop Memory Profiling & Breakdown across States (Task 2 & Task 3)
- [x] Measure memory across discrete states:
  - State 1: Idle Desktop (Main Window visible: Tree WS 406.45 MB, Tree Private 193.95 MB, Rust WS 49.11 MB, Rust Private 12.62 MB)
  - State 2: Active Multi-Chunk HTTP & HLS Downloads (Tree WS 494.59 MB, Tree Private 257.70 MB, Rust WS 51.55 MB, Rust Private 14.13 MB)
  - State 3: Settings Modal open (Tree WS 503.85 MB, Tree Private 274.87 MB, Rust WS 51.52 MB, Rust Private 13.11 MB)
  - State 4: Progress Toast Window open (Tree WS 507.91 MB, Tree Private 295.34 MB, Rust WS 52.25 MB, Rust Private 13.80 MB)
  - State 5: Minimized to System Tray (Tree WS 32.04 MB [93.7% reduction!], Tree Private 222.85 MB, Rust WS 6.10 MB [88.3% reduction!])
- [x] Record per-process metrics:
  - Main Rust process (`tori-download-manager.exe`), WebView2 Browser, GPU (`--type=gpu-process`), Renderer (`--type=renderer`), Utility (`--type=utility`)
  - Full process-tree Working Set and Private Committed memory sum, Handle counts, thread counts
- [x] Audit WebView2 child-process lifecycles, React event listeners, toast window destruction, and memory trim mechanisms.

#### Milestone 3: Controlled Memory Workload (Task 4)
- [x] Run sustained multi-cycle test with automated evaluation:
  - Repeated window open / minimize-to-tray / restore cycles
  - Concurrent downloads (HTTP range + HLS VOD)
  - Progress toast window open, update, and auto-dismiss
  - Active post-workload working set stabilized at 299.87 MB (Private: 278.80 MB)
  - Minimized post-workload working set dropped to 102.65 MB
  - Zero handle leaks (3,810 -> 4,326 within stable bounds, no runaway handles)
  - Zero orphan helper processes.

#### Milestone 4: Targeted Memory Optimizations & Fixes (Task 5)
- [x] Identify and optimize titlebar window minimize:
  - Added `crate::lifecycle::trim_memory()` invocation to `window_minimize` command in `src-tauri/src/commands.rs`.
  - Ensures titlebar minimize button triggers working set tree trimming alongside tray close.
  - Verified compilation and zero regressions.

#### Milestone 5: Complete Storage Inventory of `F:\TORI` (Task 6 & Task 7)
- [x] Perform comprehensive recursive disk usage analysis of `F:\TORI`:
  - Total size before cleanup: 70.21 GB (75,382,700,519 bytes) in 80,833 files and 11,706 directories.
  - Generated full recursive catalog: Top 30 largest directories and Top 50 largest files saved in `scripts/f_tori_storage_inventory.json`.
  - Storage consumption breakdown: `target/debug/deps` (35.96 GB stale test PDBs/rlibs), `target/debug/incremental` (21.51 GB compiler cache), `target/release` (6.91 GB), disposable test environments in `target/` (~1.93 GB).
- [x] Classify every candidate:
  - Category A: SAFE TO REMOVE (65 disposable test environments, sandbox fixture trees, test video files) = 1.93 GB.
  - Category B: REBUILDABLE BUT EXPENSIVE (`target/debug/incremental` [21.51 GB], stale test PDBs in `target/debug/deps` [35.96 GB]) = 57.47 GB (Requires explicit user approval before touching).
  - Category C: MUST PRESERVE (Source code, git history, release binaries, sidecars, test harnesses, documentation) = preserved 100% intact.
  - Category D: UNCERTAIN (Standalone root image `davinci_...png` [5.1 MB]).

#### Milestone 6: Safe Automated Cleanup & Space Verification (Task 8 & Task 9)
- [x] Generate detailed cleanup manifest in `scripts/cleanup_category_a.js`.
- [x] Perform automated cleanup of 65 confirmed Category A disposable items.
- [x] Space recovered: 1.93 GB (2,073,276,210 bytes) safely recovered.
- [x] Directory count decreased from 11,706 to 5,861 (-5,845 directories); file count decreased from 80,833 to 71,160 (-9,673 files).
- [x] Formulated Category B / Category D approval request for user.

#### Milestone 7: Final Regression & Report Sign-Off (Task 10 & Task 11)
- [x] Re-run full test and quality suite:
  - `cargo fmt --all -- --check` -> PASS (0 diffs)
  - `cargo clippy --workspace --all-targets -j 2 -- -D warnings` -> PASS (0 warnings)
  - `cargo test --workspace -j 2` -> PASS (188 tests, 100% pass)
  - `npm run build --prefix ui` -> PASS (263ms build)
  - Full Gate 17.6 regression harness -> PASS (22/22 scenarios passed, 0 failures)
- [x] Deliver `GATE17_7_MEMORY_AND_STORAGE_OPTIMIZATION_REPORT.md` in artifact directory.
- [x] Update `IMPLEMENTATION_STATUS.md`.
- [x] Stop cleanly without starting subsequent gates.
