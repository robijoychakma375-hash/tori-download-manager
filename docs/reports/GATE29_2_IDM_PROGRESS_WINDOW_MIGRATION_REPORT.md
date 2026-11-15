# TORI Download Manager — Gate 29.2 Acceptance Report
## Production-Grade IDM-Style Download Progress Window Migration

- **Branch:** `fix/gate27-runtime-fixes`
- **Pre-migration checkpoint:** `checkpoint-gate29_2-before-progress-migration` (`ef4c5cf`)
- **Verified baseline tag:** `checkpoint-gate29_1-verified` (`ef4c5cf`)
- **Desktop target version:** `1.0.5` (`v1.0.5-rc` local NSIS build, unpublished; prior snapshot backed up to `release/checkpoints/v1.0.5-rc-pre-gate29_2/`)
- **Extension / Companion scope:** Untouched
- **Mozilla-signed Firefox XPI (`v1.0.7`):** Verified untouched (`sha256: b082c8f2f4c8b4ed035fab77d9569622737defb3e02279f20073d3404dda4fa0`)

---

## 1. Executive Summary

TORI's independent per-download Progress Window (`index.html?window=toast&id=...`, routed through `ProgressWindow.tsx` -> `DownloadToast.tsx`) was migrated to the IDM-style layout defined by `design/tori-idm-reference/tori-download-popup.html` and `ui/src/tokens.css`, wired directly to `tdm-core`'s `DownloadManager` and Tauri 2 native window management:

- **Independent Per-Download Windows & Lifecycle (`src-tauri/src/commands.rs`, `ui/src/App.tsx`):**
  - Migrated popup creation from a shared window to per-download `progress_<sanitized_id>` windows (`open_progress_window` with duplicate prevention and focus/restore via `'progress-restore-full'`).
  - Independent visibility when Main Window minimizes or hides to tray (`hide_main_window` hides `"main"` only).
  - Live `alwaysOnTop` updates and cross-window `settings-updated` propagation on `update_engine_settings`.
  - Respects `showDownloadPopup` (`always`, `on_start` one-shot tracking, `never`); closing a progress window never cancels active transfers; deletes cleanly close matching open popups.
- **Live Telemetry, Per-Download Speed Limiter & Completion Actions (`crates/tdm-core/`, `src-tauri/src/lib.rs`):**
  - Added `DownloadStatusDetails` & `DownloadCompletionOptions` (`crates/tdm-core/src/types.rs`, re-exported in `crates/tdm-core/src/lib.rs`) and SQLite `delete_setting(&self, key: &str)` (`crates/tdm-core/src/db/repo.rs`).
  - Added per-job `BandwidthLimiter` acquisition alongside global limiter in `download_chunk_with_limiters` & `download_stream_with_limiters` (`crates/tdm-core/src/engine/worker.rs`) and `set_job_speed_limit` / `job_speed_limit` / `get_download_status_details` / completion options persistence & cleanup on `delete_download` (`crates/tdm-core/src/engine/manager.rs`).
  - Wired `StateChanged { Completed }` actions (`notify_on_complete` via PowerShell WinRT Toast + `NOTIFY` / `DOWNLOAD_COMPLETE` entry in `logs/lifecycle.log`, `open_on_complete`, and `close_on_complete`) in `src-tauri/src/lib.rs` and registered `get_download_status_details`, `set_download_speed_limit`, `set_download_completion_options`, and `get_download_completion_options`.
- **Production IDM Progress Popup UI (`ui/src/components/DownloadToast.tsx`, `DownloadToast.css`, `SettingsModal.tsx`, `types.ts`, `index.html`):**
  - Scoped styling under `.dl-popup-root` (`460px` width, `32px` `.dl-wbar`, `.dl-win.m` + `.dl-mini` compact bar resized down to `38px` via `update_toast_bounds` min height `34.0`, 3 tabs `Download status` / `Speed limiter` / `Options on completion`, `1fr 110px 110px` footer, zero `backdrop-filter`).
  - Strict `<= 1 Hz` UI update commit loop active only when transferring and visible; timer cleared cleanly when paused, completed, failed, cancelled, or hidden.
  - Added Always-on-Top (`alwaysOnTop`) setting toggle in `SettingsModal.tsx`.

---

## 2. Critical Defect Resolved During Verification

- **Token Bucket Deadlock on Large Socket Reads at Low Speed Limits (`crates/tdm-core/src/engine/limiter.rs`):**
  - *Symptom caught by Gate 29.2 live `FEAT-LIMITER` verification:* When per-download rate was set to `180 KB/s` (`max_bucket = 360_000` bytes = `2.0s * rate`), a single socket read returning `> 360 KB` (observed with `limit-test.bin` multi-chunk transfer over loopback) caused `guard.tokens >= bytes as f64` to remain permanently `false`, deadlocking `BandwidthLimiter::acquire`.
  - *Fix:* Updated `BandwidthLimiter::acquire` to deduct tokens incrementally in bounded slices (`slice_cap = (max_bucket * 0.25).floor().max(1.0) as u64`) while re-checking `rate_bps` each iteration.
  - *Verification:* Added unit test `test_bandwidth_limiter_large_chunk_exceeding_bucket_never_deadlocks` (`150 KB` at `50 KB/s`, `max_bucket = 100 KB`), and confirmed `FEAT-LIMITER` (`limit-test.bin` at `180 KB/s`) completed accurately in `4636ms`.

---

## 3. Final Verification Results (After Final Source Edit)

### Build, Lint & Rust Test Suite
- **UI Production Build (`npm --prefix ui run build`):** Passed in `208ms` (`tsc -b && vite build`).
- **Touched UI Lint (`oxlint src/components/DownloadToast.tsx src/components/SettingsModal.tsx src/App.tsx src/types.ts`):** `0 warnings, 0 errors` (`106ms`).
- **Full UI Lint (`npm --prefix ui run lint` across `23` files):** `7` pre-existing warnings (`DetailsPane.tsx`, `PlaylistModal.tsx`, `AddDownloadModal.tsx`), `0 errors`.
- **Rust Workspace Tests (`cargo test --workspace --no-fail-fast`):** `37` suites, `238 passed, 0 failed, 0 ignored` (including `gate29_2_progress_backend_tests`: `2 passed, 0 failed`, and `engine::limiter::tests`: `3 passed, 0 failed`).

### Gate 29.2 Live WebView2 E2E Suite (`scripts/verify_gate29_2_idm_progress_window.js`) — `PASS=17, FAIL=0`

| Check ID | Verification Target | Observed Result |
|---|---|---|
| `PERF-BASE` | Idle MainWindow memory & CPU baseline (no popup open) | `ws=363.4MB`, `cpuSec=2.359s`, `procs=7` |
| `UI-LIGHT` | Light mode `460px` IDM layout, real connections/segments & `110px` buttons | `width=460, height=365, blur="none", conn=2, segs=2` |
| `PERF-HZ` | Progress UI updates strictly `<= 1 Hz` during active transfer | `titleUpdatesIn3.1s=3` |
| `STATE-PAUSE-THEME` | Pause (`connections->0`, `Resume`) & live Dark+Ocean propagation | `state="paused", theme="dark", accent="ocean", conn=0` |
| `UI-COMPACT` | Compact progress mode shrinks native window height cleanly | `hasM=true, winH=38, innerH=38, miniVisible=true` |
| `UI-RESTORE-COMPACT` | Restore button returns full height | `restoredH=365` |
| `WIN-NODUP` | Duplicate popup prevented on repeated open | `targetsForJob1=1` |
| `WIN-AOT` | Live Always-on-Top toggle (`true -> false -> true`) | `on=true, off=false, restored=true` |
| `PERF-OPEN-STATS` | Desktop memory & CPU with Progress Window open & visible | `ws=466.1MB (delta=+102.7MB)`, `cpu=3.859s`, `procs=8` |
| `WIN-MAIN-MIN` | Popup remains visible while Main Window minimized | `popVisible=true` |
| `UI-DARK-ACTIVE` | Dark mode active resumed connections | `state="downloading", theme="dark", conn=2` |
| `STATE-COMPLETE` | Completed state title, `Close`/`Open`, folder link & disk SHA-256 | `title="Download complete"`, `btns=["Close","Open"]`, exact SHA-256 |
| `STATE-FAIL-RETRY` | HTTP 500 error banner + `Retry` recovers to 100% completion | `title="Download failed", btns=["Close","Retry"], errVisible=true`, recovered |
| `FEAT-LIMITER` | Per-download `180 KB/s` limit persists, throttles & leaves global untouched | `persisted=180000B/s, elapsedMs=4636, globalLimMode=off` |
| `FEAT-COMPLETE-OPTS` | `close_on_complete` + `notify_on_complete` persist & execute | `autoClosed=true, notifyLogged=true` |
| `MULTI-AND-CLOSE` | Multi-popup coexistence, unknown size (`Unknown`), close-leaves-running | `hasTwoIndependentPopups=true, bgWindowClosed=true, bothFinished=true` |
| `SAFETY-OEM` | Production `%APPDATA%` SQLite unchanged | `sha256: c2bb1ada2d3966837aa22f37f2e6a21d10687a88a726e26693f68929f2d91679` |

### Visual Screenshot Inspection (`docs/reports/screenshots/gate29_2/`)
All `8` PNG screenshots captured during the `17/17` verified run were inspected visually:
- `01_progress_downloading_light.png` — Light active transfer (`8% range-multi.bin`, `Connections : 2`, `0 / 2 parts complete`, two proportional segment bars, `Cancel`/`Pause` `110px` buttons).
- `02_progress_downloading_dark.png` — Dark + Ocean active resumed transfer (`42% range-multi.bin`).
- `03_progress_paused.png` — Paused state (`33% Paused - range-multi.bin`, muted grey bar/segments, `Connections : 0`, `Resume`).
- `04_progress_completed.png` — Completed state (`Download complete`, full green progress & segment bars, `2 / 2 parts complete`, `Open containing folder`, `Close`/`Open`).
- `05_progress_failed.png` — Failed state (`Download failed`, red status, `Server returned error status: 500` error banner, `Close`/`Retry`).
- `06_progress_speed_limiter.png` — Speed limiter tab (`Use speed limiter` checked, `180 KB/s` input).
- `07_progress_options_completion.png` — Options on completion tab (`Close this window...` and `Show a notification...` checked).
- `08_compact_progress_mode.png` — Compact progress mode strip (`38px` height with restore toggle `□`, close `×`, and `.dl-mini` bar).

### Regression Suites (Against Staged Gate 29.2 NSIS RC Installer)
Prior `release/v1.0.5-rc/` was backed up to `release/checkpoints/v1.0.5-rc-pre-gate29_2/` before staging the rebuilt NSIS bundle (`release/v1.0.5-rc/SHA256SUMS.txt`):
- **`scripts/verify_gate29_1_idm_desktop_ui.js`:** `PASS=20, FAIL=0`.
- **`scripts/verify_gate27_8_playlist_e2e.js`:** `12 PASS, 0 FAIL, 0 TIMEOUT, 0 NOT TESTED`.
- **`scripts/verify_gate27_8_large_mkv_and_classification.js`:** `10 PASS, 0 FAIL, 0 TIMEOUT, 0 NOT TESTED`.

### Staged `release/v1.0.5-rc/SHA256SUMS.txt` (Local RC Only, Unpublished)
```
a84a9709a7e71100d532d2ad06cb6b8379e17867ac6e56ee361ff31d48837eba  tdm-cli.exe
3b6ec3f0c7ee7455fd462aee14648da9bc625004170b17d6a5b0f2cf3b3591cc  tdm-native-host.exe
f60779f5467157608507302f7ae3e482fb2446fd86fa0dd4a25a55bdd6e0780f  TORI Download Manager_1.0.5_x64-setup.exe
1d9021020a925d05867ee425128e48f5ccfc33b687397dbcddcfc5ad32c617b3  TORI Download Manager_1.0.5_x64-setup.exe.sig
9d84b2601180cfff1093fba761027174839462c8b1580778aa793649fd4687fd  tori-download-manager.exe
```

No remote git pushes, GitHub release publications, `latest.json` modifications, website edits, or browser extension alterations were performed.
