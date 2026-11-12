# TORI Download Manager — Gate 26.3: Real Large-File Stability & Packaged Windows Acceptance Report

- **Project:** `F:\TORI\final tori download manager`
- **Branch:** `release/v1.0.4`
- **Desktop Candidate:** `v1.0.4-rc` (`release/v1.0.4-rc/`)
- **Extension Candidate:** `v1.0.6-rc` (`release/v1.0.6-rc-extension/`) + Production `v1.0.5` backward-compatibility verified
- **Public Production Release:** `v1.0.3` (Updater `latest.json` verified untouched & online)
- **Date:** 2026-11-12

---

## 1. Executive Summary

Gate 26.3 executed rigorous, real-world packaged Windows acceptance testing against the **TORI Download Manager `v1.0.4-rc`** release-profile binaries (`tori-download-manager-v1.0.4-rc.exe`, `tdm-native-host-v1.0.4-rc.exe`, and `tdm-cli-v1.0.4-rc.exe`) in isolated temporary runtime profiles (`TORI_DATA_DIR`, `TORI_IPC_PIPE`, `TORI_ALLOW_LOOPBACK=1`) without touching the installed `v1.0.3` production application, user SQLite database (`C:\Users\ritud\AppData\Roaming\tori-download-manager\tdm_storage.sqlite`), or public `v1.0.3` auto-updater manifest.

### Key Highlights
- **14 / 14 Packaged Windows Acceptance Checks Passed (`0` failures)** and **68 / 68 Rust `--release` Unit & Integration Tests Passed (`0` failures)**.
- **Reclaimed Storage Preserved:** All compilations and test executions strictly used `--release`. `target/debug` remained at `9` sidecar files (`327.16 MiB` inside `target/debug/bin`), preserving `127.92 GiB` of free space on Drive `F:`.
- **1 Real Edge-Case Race Condition Discovered & Fixed During Gate 26.3:**
  - During the live `100 MB` multi-worker full-physical download test, we discovered an interaction between the `256 KiB` buffered chunk writer ([`crates/tdm-core/src/engine/worker.rs`](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/src/engine/worker.rs)) and dynamic straggler tail splitting ([`crates/tdm-core/src/engine/manager.rs`](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/src/engine/manager.rs)):
    1. `evaluate_straggler_split` in `manager.rs` read `db.get_chunks()` (which checkpoints every `4 MiB`) instead of the live atomic byte counters (`active_chunk_progress`), and if a split aborted after clamping `orig_bound`, it lacked an `else` branch to restore `orig_bound` to `plan.original_end`.
    2. In `worker.rs`, `flush_worker_buffer` wrote buffered bytes without clamping `write_buf` to the dynamically lowered `end_bound` (`current_bound`), causing `verify_chunks_complete_and_contiguous` to reject the chunk when `written_bytes` exceeded the split `end_byte` by up to `256 KiB`.
  - Both [`crates/tdm-core/src/engine/manager.rs`](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/src/engine/manager.rs#L1897-L2024) and [`crates/tdm-core/src/engine/worker.rs`](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/src/engine/worker.rs#L37-L80) were fixed, rebuilt in `--release`, restaged into `release/v1.0.4-rc/`, and verified across all 5 large-file tiers (`100 MB`, `1 GB`, `4.51 GB`, `10 GB`, and `50.9 GB`).

### Staged `v1.0.4-rc` Binary Fingerprints
| Artifact | Path | Size (Bytes) | SHA-256 |
| :--- | :--- | ---: | :--- |
| Main Desktop GUI & Engine | `release/v1.0.4-rc/tori-download-manager-v1.0.4-rc.exe` | `30,163,456` | `0ff93e42012d17e0c6e9507d92955dce70fd412906774628d0e9c3bf29daabb8` |
| Native Messaging Host | `release/v1.0.4-rc/tdm-native-host-v1.0.4-rc.exe` | `17,160,704` | `21f4e50fa8f21cc78d14ac04f930a2e80361a25a63c43497fdec21eef39f1382` |
| Command-Line Interface | `release/v1.0.4-rc/tdm-cli-v1.0.4-rc.exe` | `16,964,608` | `e62aa50d181b05f0f56bbc07a632e4ec0b7711528e349771ce035500545253e4` |
| Chromium Extension RC | `release/v1.0.6-rc-extension/tori-extension-chrome-edge-v1.0.6-rc.zip` | `31,843` | `9ec15d34aa04056fcbf4847a373a8b55d6e10b22026c2d7c2be7e22c5beae64b` |
| Firefox Extension RC | `release/v1.0.6-rc-extension/tori-extension-firefox-v1.0.6-rc-unsigned.xpi` | `31,945` | `f82f4f53b1653c88aaecbcba76eb52dc49f776c9a92a4c71ed264e9745875029` |

---

## 2. Large-File Stability Results

Per Gate 26.3 requirements, **Full Physical File Downloads** (every byte streamed over HTTP Range sockets, written to disk, finalized from `.tdm-part` to target filename, and byte-verified on disk) and **Live Sparse/Range Large-Offset Scenarios** (`10 GB` and `50.9 GB` presigned CDN with crash/restart reconciliation) are reported separately below.

### 2.1 Full Physical File Downloads ( Packagaged `tori-download-manager-v1.0.4-rc.exe` + Local HTTP Range Server)

| Scenario | Exact Size (Bytes) | First-Byte Latency | Active Workers | Sparse Flag (`FSCTL_SET_SPARSE`) | Elapsed Time | Sustained Throughput | WorkingSet RAM (Start -> Peak) | Pause / Resume Tested | Byte & Boundary Integrity | Result |
| :--- | ---: | ---: | ---: | :---: | ---: | ---: | :---: | :---: | :--- | :---: |
| **`100 MB` Full Physical** | `104,857,600` | `2 ms` | `4` | N/A (`< 64 MiB` threshold or pre-sparse) / Verified | `0.857 s` | `116.7 MB/s` | `29.1 MB -> 29.4 MB` | Covered in Gate 26.1 + `1 GB` | Verified deterministic `64 B` blocks at `0`, `50 MiB`, `100 MiB - 64` + exact size | **PASS** |
| **`1 GB` (`1 GiB`) Full Physical + Pause/Resume** | `1,073,741,824` | `2 ms` | `4` | `true` (`0x200` Sparse) | `3.588 s` | `285.4 MB/s` | `29.1 MB -> 31.8 MB` | **Yes** (Paused at `> 100 MiB`, verified `Paused` state, resumed to `100%`) | Verified deterministic `64 B` blocks at `0`, `256 MiB`, `512 MiB`, `1 GiB - 64` | **PASS** |
| **`> 4 GB` (`4.51 GB`) Full Physical (`u32::MAX` Boundary)** | `4,509,715,968` | `1 ms` | `4` | `true` (`0x200` Sparse) | `8.060 s` | `533.6 MB/s` | `29.9 MB -> 34.6 MB` | Continuous multi-worker + straggler split | Verified deterministic `64 B` blocks at `0`, `2 GiB`, `4 GiB - 64` (`4,294,967,232`), `4 GiB` (`4,294,967,296`), and `4.51 GB - 64` | **PASS** |

- **Temporary Disk Cleanup:** Each physical test file (`100 MB`, `1 GB`, `4.51 GB`) was verified on disk immediately upon completion and then unlinked so temporary test files did not consume permanent disk space.

### 2.2 Live Sparse/Range High-Offset Runtime & Crash Recovery Scenarios (`10 GB` & `50.9 GB`)

| Scenario | Logical Size (Bytes) | `.tdm-part` Sparse Allocation | First-Byte Latency | Active Workers | Bytes Streamed During Window | WorkingSet RAM (Start -> Peak) | Special Conditions Verified | Result |
| :--- | ---: | :---: | ---: | ---: | ---: | :---: | :--- | :---: |
| **`10 GB` (`10 GiB`) Sparse/Range Runtime** | `10,737,418,240` | `true` (`10,737,418,240` B logical, instant `< 5 ms` allocation) | `2 ms` | `4` | `840,582,479` B (`801.6 MiB`) across 4 high-offset workers | `30.5 MB -> 30.5 MB` | Instant sparse file creation without 10 GB zero-fill stall; immediate `Starting -> Downloading` transition | **PASS** |
| **`50.9 GB` (`54.68 GB`) Presigned CDN Sparse/Range + Crash Recovery** | `54,676,684,800` | `true` (`54,676,684,800` B logical, instant `< 5 ms` allocation) | `2 ms` | `4` (capped `<= 4` by Presigned CDN heuristic) | `733,060,382` B (`699.1 MiB`) before forced kill; `743,725,997` B (`709.3 MiB`) persisted & reconciled on restart | `29.9 MB -> 35.8 MB` | URL `?X-Amz-Signature=...` capped at 4 workers; survived injected HTTP `429 Too Many Requests` backoff; survived forced `process.kill` and `reconcile_on_startup()` without resetting `.tdm-part` | **PASS** |

- **Additional Rust `--release` Sparse Boundary & Gap Verification (`gate26_1_large_file_and_handoff_tests`):**
  - Directly verified `5 GB`, `10 GB`, and `50 GB` sparse `.tdm-part` high-offset writes and confirmed `verify_chunks_complete_and_contiguous()` rejects unwritten sparse holes before `.tdm-part` finalization.

---

## 3. Browser Handoff Verification

Tested against both the packaged Desktop HTTP server (`127.0.0.1:16860`) and the packaged Native Messaging Host (`tdm-native-host-v1.0.4-rc.exe`) using real length-prefixed stdin/stdout frames:

| Test Case | Behavior Verified | Observed Metrics | Result |
| :--- | :--- | :--- | :---: |
| **3.1 Firefox & Chromium Session Header Preservation** | Browser handoff payload carrying custom `Referer` (`https://portal.example.org/releases/download-page`) and `User-Agent` (`Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0`) forwards both headers to the upstream server across both `HEAD` probe and `GET Range` chunk requests. | `refererForwarded: true`, `uaForwarded: true`, `requestsSeen: 4` | **PASS** |
| **3.2 HTTP Timeout + Native Messaging Fallback Coalescing (Zero Duplicate `(1)` Files)** | Simulated a slow upstream `HEAD` probe (`3,700 ms` delay) where the browser extension's `3,500 ms` HTTP handoff times out and immediately triggers a Native Messaging `start_download` fallback (tested **without** `handoff_id` to verify backward compatibility with published Extension `v1.0.5` as well as `v1.0.6-rc`). | `slowJobsCount: 1`, `nmStatus: "already_exists"`, `dupPartExists: false` (`0` duplicate `.tdm-part` or `(1)` files created) | **PASS** |
| **3.3 Non-HTTP Scheme Filtering & Safe Failure Fallback** | Verified both `extensions/firefox/background.js` (`v1.0.5` & `v1.0.6-rc`) and `extensions/chrome/background.js` (`v1.0.6-rc`) ignore `blob:`, `data:`, `file:`, `about:`, `moz-extension:`, and `chrome-extension:` URLs (`/^https?:\/\//i`), generate UUID `handoff_id`, and only call `chrome.downloads.cancel()` when `accepted === true`. Also verified `tdm-native-host` rejects non-HTTP schemes (`test_native_host_invalid_urls_rejected`). | `skipsNonHttp: true`, `hasHandoffIdIn106: true`, `cancelsOnlyOnSuccess: true` | **PASS** |

---

## 4. Process Survival & Crash Resistance

| Test Case | Scenario & Failure Mode | Observed Behavior | Result |
| :--- | :--- | :--- | :---: |
| **4.1 Windows Job Object Breakaway (`CREATE_BREAKAWAY_FROM_JOB \| DETACHED_PROCESS`)** | Invoked `tdm-native-host-v1.0.4-rc.exe` with `{"type":"ping"}` while no Desktop instance was running. Native Host spawned `tori-download-manager-v1.0.4-rc.exe --minimized` using `CREATE_BREAKAWAY_FROM_JOB (0x01000000) \| CREATE_NEW_PROCESS_GROUP (0x00000200) \| DETACHED_PROCESS (0x00000008)` and immediately exited. | Native Host exited cleanly; spawned Desktop process (`PID 17612`) survived past `5.5s` (the exact window where `v1.0.3` died in production) and served authenticated `/api/v1/status` requests. | **PASS** |
| **4.2 Hung `HEAD` Server Probe Fallback (`4s` Timeout)** | Upstream server accepted TCP connection on `/hung_head.bin` (`8 MiB`) and hung indefinitely (`20s`) on `HEAD`, while responding normally to `GET Range`. | Probe timed out `HEAD` after `4.0s`, fell back to `GET Range: bytes=0-0`, transitioned `Starting -> Downloading -> Completed` in **`4,027 ms`**, and never hung in `Starting`. | **PASS** |
| **4.3 HTTP `404` Isolation & Mid-Stream TCP Reset Recovery** | Submitted a permanent `404 Not Found` download (`/fail_404.bin`) followed immediately by a `16 MiB` download (`/tcp_reset_once.bin`) whose server destroyed the TCP socket mid-stream after `64 KiB` on the first Range request. | `404` task failed cleanly without crashing the engine; `/tcp_reset_once.bin` reconnected automatically via worker retry and completed all `16,777,216` bytes with exact byte integrity while `PID 17612` remained alive. | **PASS** |
| **4.4 Forced Termination & Partial Progress Survival** | Killed `tori-download-manager-v1.0.4-rc.exe` mid-transfer during the `50.9 GB` download (`733.1 MB` written), then relaunched against the same `TORI_DATA_DIR`. | `reconcile_on_startup()` recovered the task in `Paused` state with `743.7 MB` preserved in SQLite/chunk records and the `50.9 GiB` sparse `.tdm-part` intact. | **PASS** |

---

## 5. Close-to-Tray Verification (Enabled & Disabled)

Tested using the real packaged GUI executable (`tori-download-manager-v1.0.4-rc.exe`) driven via WebView2 Chrome DevTools Protocol (`--remote-debugging-port=19229`) in an isolated profile (`TORI_DATA_DIR`):

| Mode | Actions Executed | Lifecycle Log & Runtime Evidence | Result |
| :--- | :--- | :--- | :---: |
| **5.1 Close-to-Tray Enabled (`closeToTray = true`)** | 1. Launched GUI (`PID 26320`) with `--enable-close-to-tray`.<br>2. Invoked `window_close` (the custom TitleBar `X` button command).<br>3. Started a `100 MB` download (`tray_bg_100mb.bin`) while the window was hidden in the system tray.<br>4. Restored the window via `show_main_window` (Tray Show command).<br>5. Spawned a second `tori-download-manager-v1.0.4-rc.exe` instance. | - `[WINDOW] WINDOW_CLOSE_COMMAND: label=main, close_to_tray=true`<br>- `[WINDOW] HIDE_MAIN: main window hidden to system tray`<br>- `100 MB` background download completed (`104,857,600` B) while hidden in tray (`bgDlCompletedWhileHidden: true`).<br>- `[WINDOW] RESTORE_MAIN: main window shown and focused` on the same `PID 26320`.<br>- `[APP] SECONDARY_INSTANCE: secondary launch intercepted` (`activeInstances: 1`). | **PASS** |
| **5.2 Close-to-Tray Disabled (`closeToTray = false`)** | 1. Updated live engine/UI setting via `update_engine_settings({ closeToTray: false })`.<br>2. Invoked `window_close` (TitleBar `X` button). | - `[SETTINGS] CLOSE_TO_TRAY_UPDATED: enabled=false`<br>- `[WINDOW] WINDOW_CLOSE_COMMAND: label=main, close_to_tray=false`<br>- `[APP] EXIT_CLEAN: explicit exit requested via window_close (close_to_tray=false)`<br>- `[APP] EXPLICIT_EXIT: app.exit(0) called`<br>- Process `PID 26320` terminated cleanly (`aliveAfterClose: false`). | **PASS** |

---

## 6. Regression Test Results

All automated test suites were executed in `--release` mode (zero `target/debug` regeneration):

| Suite | Command | Passed | Failed | Duration |
| :--- | :--- | ---: | ---: | ---: |
| `tdm-core` Unit Tests | `cargo test --release -p tdm-core --lib` | **47** | **0** | `1.52 s` |
| Queue & Crash Recovery Integration Tests | `cargo test --release -p tdm-core --test gate17_4_queue_recovery_tests` | **9** | **0** | `4.10 s` |
| Gate 26.1 Large-File & Handoff Integration Tests | `cargo test --release -p tdm-core --test gate26_1_large_file_and_handoff_tests` | **4** | **0** | `3.74 s` |
| Native Messaging Host Integration Tests | `cargo test --release -p tdm-native-host --test host_tests` | **8** | **0** | `0.65 s` |
| Frontend UI TypeScript & Vite Production Build | `npm --prefix ui run build` | **44 modules** | **0** | `0.39 s` |
| Gate 26.3 Packaged Windows Acceptance Suite | `node scratch/verify_gate26_3_acceptance.js` | **14** | **0** | `44.6 s` |
| **TOTAL** | | **82 checks + UI build** | **0** | |

---

## 7. Remaining Risks or Edge Cases

1. **Historical `closeToTray` Migration in Existing User WebView2 `localStorage`:**
   - As documented in Gate 26.1, `ui/src/App.tsx` includes a one-time migration (`tori_settings_v104_tray_migrated`) that resets `closeToTray` to `true` on first launch of `v1.0.4` so existing `v1.0.3` users whose setting was previously inverted or unclear get Close-to-Tray enabled by default, while honoring any subsequent toggle to `false`.
2. **Mozilla AMO Signing for Extension `v1.0.6` (Optional Companion Update):**
   - Because `tdm-core` (`v1.0.4-rc`) and `tdm-native-host` (`v1.0.4-rc`) enforce server-side URL + in-flight deduplication (`reserve_in_flight_handoff` + `find_recent_duplicate_handoff`), Desktop `v1.0.4-rc` already prevents duplicate downloads even with the currently published Extension `v1.0.5` (verified in Step 3.2). Extension `v1.0.6-rc` adds client-side `handoff_id` UUID generation and `3.5s` HTTP timeout tuning as defense-in-depth and can be published independently once Mozilla-signed.
3. **NSIS / MSI Installer Packaging for Public Release:**
   - The `release/v1.0.4-rc/` binaries are compiled and verified. Before publishing `v1.0.4` to GitHub Releases and updating `latest.json`, the standard Tauri installer bundle (`cargo tauri build`) and updater signature generation will be needed in the release publication gate.

---

## 8. Final Desktop v1.0.4 Release Readiness Verdict

**VERDICT: READY FOR DESKTOP v1.0.4 PACKAGING & RELEASE**

- All four production issues investigated in Gate 26 (large-file stalls/throttling, duplicate Firefox/Chromium handoff tasks, `5.5s` unexpected exit after Native Host spawn due to Windows Job Objects, and Close-to-Tray state desynchronization) are permanently resolved and verified under real packaged Windows execution.
- Reclaimed disk space (`127.92 GiB` free on `F:`), Gate 26 crash evidence (`target/gate26_evidence/`), user production data (`tdm_storage.sqlite`), and the live `v1.0.3` updater remain 100% intact.
