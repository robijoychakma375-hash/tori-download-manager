# TORI Download Manager — Gate 35.2 Security Hotfix & Desktop Bug Triage Report

**Date:** 2026-11-25  
**Gate:** Gate 35.2 — Security Hotfix (`SEC-35-04`) & Desktop Bug Triage (`Content-Range` Failure & Unwanted Windows Startup Popup)  
**Branch:** `feat/gate35_2-companion-security-and-triage`  
**Base Checkpoint:** `checkpoint-gate35_1-security-hardening-verified` (`cb885d48cfcfc1557489a033984e12037c10ea80`)  
**Release Action Taken:** **NONE** (local RC & verification gate only; production Desktop `v1.0.8`, Companion `v1.0.10`, tools manifest rev 2, and `toridownload.xyz` remain 100% untouched)  
**Final Verdict:** **CONDITIONAL GO** *(all Gate 35.2 code fixes, adversarial security checks, and 313 Rust workspace tests pass locally; publishing Companion `v1.0.11` or Desktop `v1.0.9` remains gated on Firefox AMO signing, explicit separate owner release authorization, clean Windows 10/11 VM QA, Authenticode signing, and offline key backup).*

---

## 1. Executive Summary

Gate 35.2 resolved all three owner-identified priorities with full forensic proof and automated regression coverage while preserving all frozen production releases and the OEM user environment:

| Priority | Issue | Ownership & Forensic Verdict | Status | Verification Evidence |
| :--- | :--- | :--- | :--- | :--- |
| **Priority 1** | **`SEC-35-04`** (`__TORI_DISPATCH__` webpage-to-extension security boundary failure) | Confirmed critical vulnerability in `extension/content.js:3131-3141` and `extension/background.js:1982-2565` (shared by Chrome/Edge & Firefox). | **FIXED (`v1.0.11` local RC staged)** | `scripts/verify_gate35_2_extension_security.js`: **26/26 PASS** (Chromium/Edge + Firefox); `web-ext lint`: **0 errors**. **Firefox ZIP is `UNSIGNED_AMO_PENDING`.** |
| **Priority 2** | `Mismatched Content-Range: expected offset 55803060, server responded with bytes 0-178569791/178569792` | **Confirmed TORI bug** via OEM SQLite (21 failed `ledger-live-desktop` jobs). **Confirmed Gate 35.1 did NOT fix this bug.** Pre-fix tests also proved 2 silent data-corruption vectors. | **FIXED** | `gate35_2_content_range_tests`: **7/11 failed pre-fix → 11/11 PASS post-fix** (0.41s); full workspace **313/313 PASS**. |
| **Priority 3** | Unwanted Windows Startup Popup | **Confirmed 4-layer causal chain** via Registry + `lifecycle.log`: **0 TORI Windows Run keys**; triggered by Edge `MicrosoftEdgeAutoLaunch` → extension replaying completed Nov-14 download + `onStartup` native pairing → 14x concurrent native-host spawn stampede → `open_progress_window_internal` popping up `always_on_top` `"Download failed"` window. | **FIXED across all 4 layers** | Extension startup-replay & offline-`onStartup` checks (**PASS**); `ipc::tests` cross-process spawn mutex (**2/2 PASS**); `gate35_2_startup_and_tray_tests` (**5/5 PASS**). |

### Global Skills Applied (Per Global Skill Usage Policy)
`chrome-extensions`, `security-auditor`, `rust-pro`, `systematic-debugging`, `typescript-expert`, `code-review-checklist`, and `performance-engineer`. No third-party skill scripts were executed; no dependencies were installed; no production release or registry mutation was performed.

---

## 2. Priority 1 — `SEC-35-04` Browser Companion Security Hotfix (`v1.0.11` RC)

### 2.1 Root Cause Trace

Forensic inspection of `extension/` and `extension/firefox/` identified every entry point of the boundary failure:

1. **Webpage-Callable Arbitrary Extension Bridge (`extension/content.js:3131-3141` & `extension/firefox/content.js:3131-3141`):**
   - Exposed `document.documentElement.dataset.toriExtensionUrl = chrome.runtime.getURL('')` directly to untrusted webpage JavaScript (leaking extension ID / Firefox UUID).
   - Registered `window.addEventListener('__TORI_DISPATCH__', ...)` forwarding untrusted `e.detail.{ action, payload, id }` directly to `chrome.runtime.sendMessage` and returning full responses via `CustomEvent('__TORI_RESPONSE__' + id)`.
   - Zero project scripts referenced `__TORI_DISPATCH__`.
2. **Missing Runtime Sender Authentication & Authorization (`extension/background.js:1982-2565`):**
   - Only `GET_ALL_MEDIA` inspected `sender.url`.
   - All 14 other privileged actions (`INITIATE_PAIRING`, `RECONNECT_DESKTOP`, `PING_DESKTOP`, `GET_CONNECTION_STATUS`, `GET_DOWNLOADS`, `PAUSE_DOWNLOAD`, `RESUME_DOWNLOAD`, `CANCEL_DOWNLOAD`, `RETRY_DOWNLOAD`, `SHOW_DESKTOP`, `OPEN_OPTIONS`, `OPEN_POPUP_TAB`, `RESOLVE_PLAYLIST`, `ENQUEUE_PLAYLIST`) accepted messages from any content script or foreign sender without checking `sender.id === chrome.runtime.id`, `sender.origin`, `sender.url`, or `sender.frameId`.
   - Any webpage could invoke `INITIATE_PAIRING` to exfiltrate the Desktop pairing token and gain full authenticated localhost API control.
   - `GET_TAB_MEDIA` honored arbitrary `message.tabId` from content scripts, allowing cross-tab media spying.
   - `START_DOWNLOAD` and `START_MEDIA_DOWNLOAD` accepted arbitrary `destination` overrides and unvalidated `url` / `format_id` fields from content scripts.
3. **Synthetic Click & Open Shadow DOM Exposure (`extension/content.js:791, 1970, 2398, 2497`):**
   - Overlay portal used `attachShadow({ mode: 'open' })`, and click handlers on `pill`, `playlistBtn`, and `dlBtn` did not check `e.isTrusted`, enabling webpage scripts to synthesize `.click()` events.

### 2.2 Security Remediations Implemented

- **`extension/content.js` (and byte-synced `extension/firefox/content.js`):**
  - Completely removed `dataset.toriExtensionUrl`, `__TORI_DISPATCH__`, and `__TORI_RESPONSE__`.
  - Switched overlay portal to `host.attachShadow({ mode: 'closed' })`.
  - Enforced `if (!e.isTrusted) return;` at the entry of `pill`, `playlistBtn`, and `dlBtn` click handlers so only genuine user interactions can trigger downloads or playlist opens.
- **`extension/background.js` (and byte-synced `extension/firefox/background.js`):**
  - Added `classifyRuntimeSender(sender)` using browser-enforced runtime metadata: requires `sender.id === chrome.runtime.id`, validates exact `chrome.runtime.getURL('')` prefix and `sender.origin`, restricts extension UI senders strictly to top-level (`frameId === undefined || frameId === 0`) `popup/popup.html` or `options/options.html` (`documentLifecycle === 'active'`), and restricts content script senders to valid `http:`/`https:` tabs with `sender.tab.id >= 0`.
  - Added `authorizeRuntimeMessage(message, sender)` enforcing a strict action allowlist:
    - **15 Extension-UI-only actions** rejected from content scripts and untrusted senders with `UNAUTHORIZED_SENDER`.
    - **Token minimization:** pairing `token` is returned ONLY to `options/options.html` (stripped even from `popup/popup.html`, never accessible to content scripts).
    - **6 Content-script actions** strictly schema-validated & scoped:
      - `GET_TAB_MEDIA` and `RECORD_MEDIA_FROM_DOM` force `tabId = sender.tab.id` for content scripts (ignoring `message.tabId`).
      - `START_DOWNLOAD` and `START_MEDIA_DOWNLOAD` strictly reject any `destination` field from content scripts (`FORBIDDEN_FIELD`), enforce `http(s)://` URLs without leading `-` or control characters, sanitize filenames against path traversal, validate `format_id` (`/^[A-Za-z0-9][A-Za-z0-9_+./:=,\-<>\[\]]{0,127}$/`), derive referer strictly from `sender.tab.url`, and apply per-tab burst rate limiting.
      - `PAUSE_DOWNLOAD`, `RESUME_DOWNLOAD`, `CANCEL_DOWNLOAD`, and `RETRY_DOWNLOAD` validate `job_id` (`/^[A-Za-z0-9_-]{1,128}$/`) to prevent URL path traversal.
      - Unknown actions fail closed with `UNKNOWN_ACTION`.
- **Version Bump & Packaging (`v1.0.11` RC):**
  - Updated `extension/manifest.json`, `extension/firefox/manifest.json`, `extension/options/options.html`, and `extension/options/options.js` to `1.0.11`.
  - Added [`scripts/package_v1_0_11_extensions.js`](file:///F:/TORI/final%20tori%20download%20manager/scripts/package_v1_0_11_extensions.js) and [`scripts/verify_gate35_2_extension_security.js`](file:///F:/TORI/final%20tori%20download%20manager/scripts/verify_gate35_2_extension_security.js).

### 2.3 Browser Companion `v1.0.11` RC Artifact Inventory & Firefox AMO Signing Status

All artifacts were staged locally under `release/v1.0.11-extension-rc/` (unpublished; `release/v1.0.10-extension-rc/` preserved byte-for-byte):

| Artifact | Size (Bytes) | Entries | SHA-256 | Distribution / Signing Status |
| :--- | ---: | ---: | :--- | :--- |
| `tori-companion-v1.0.11-chromium.zip` | 94,445 | 35 | `000261399ed6bb33441d9982da3096145f7a3fc919f5e021e497af1cc3da879c` | **READY_FOR_UNPACKED_OR_STORE_SUBMISSION** (Chrome & Edge MV3) |
| `tori-companion-v1.0.11-chromium/` (unpacked) | — | 35 files | Parity verified | **READY** (Developer Mode / QA sideloading) |
| `tori-companion-v1.0.11-firefox.zip` | 95,261 | 42 | `3631e1a186be4a0e482703dada44c17f2fd5df8bc387d0c6432512e4d4414762` | **`UNSIGNED_AMO_PENDING` — NOT PRODUCTION-READY FOR PERMANENT FIREFOX INSTALL** |

> [!WARNING]
> **Explicit Firefox Signing Determination:** Environment verification confirmed `AMO_JWT_ISSUER`, `AMO_JWT_SECRET`, `WEB_EXT_API_KEY`, `WEB_EXT_API_SECRET`, `MOZILLA_API_KEY`, and `MOZILLA_API_SECRET` are all absent locally. `web-ext lint` passed with **0 errors** (7 warnings, 0 notices) and Gecko ID `tori-download-manager@toridm.org` (`strict_min_version: 142.0`, `data_collection_permissions.required: ["none"]`), so `tori-companion-v1.0.11-firefox.zip` is a valid **unsigned AMO submission candidate only**. Standard release Firefox rejects unsigned extensions for permanent installation; Mozilla AMO signing into a verified `.xpi` is mandatory before Firefox public release.

---

## 3. Priority 2 — `Content-Range` Download Failure Root Cause & Engine Remediation

### 3.1 Forensic Confirmation & Gate 35.1 Gap Proof

1. **TORI Owns the Failure:** Read-only inspection of the OEM database (`%APPDATA%\tori-download-manager\tdm_storage.sqlite`) revealed **21 failed `ledger-live-desktop` download jobs** (`ledger-live-desktop-4.23.0-win-x64.exe` through `(19).exe`, plus `4.28.0`), including exact job `02b2bc4a-72a5-4aeb-a153-3fbc24c19438`:
   - **URL:** `https://download.live.ledger.com/ledger-live-desktop-4.23.0-win-x64.exe`
   - **Size / Plan:** `178,569,792` bytes, 16 chunks (chunk 5 offset `55803060`)
   - **Recorded Error:** `Mismatched Content-Range: expected offset 55803060, server responded with bytes 0-178569791/178569792`
2. **Gate 35.1 Did NOT Fix This Defect:** Gate 35.1 only added `writer.truncate_to(0)?` when `download_stream_with_limiters` received HTTP `200 OK` on single-stream resume. It left **four root-cause bugs** completely unresolved in TORI's HTTP Range pipeline:
   - **`probe.rs:263-271`:** `probe_url` sent `Range: bytes=0-0` and blindly set `supports_ranges = true` on any HTTP `206`, even when the server ignored `0-0` and replied with `Content-Range: bytes 0-178569791/178569792`. Also `parse_content_range_bounds` accepted invalid `start > end` or `end >= total`.
   - **`worker.rs:297-326` (`download_chunk_with_limiters`):**
     - On `206` with **missing or malformed `Content-Range`**, silently proceeded to write wrong bytes at `fetch_start` (**silent data corruption** — reproduced in `test_05`).
     - Never validated `ETag` / `Last-Modified` or `Content-Range` total/upper-bound on `206` (**silent mixed-version corruption** — reproduced in `test_08`).
     - Treated `200 OK` on `fetch_start > 0` as `ETagMismatch` instead of `RangeNotSupported(200)`, and accepted `200 OK` full-body on chunk 0 (`fetch_start == 0`).
   - **`manager.rs:2686-2697` (`run_download_task`):** Treated `MismatchedContentRange`, `ETagMismatch`, `InvalidRangeHeader`, `RangeNotSupported`, and `HttpStatus(416)` as immediately fatal with zero fallback to a validated single-stream download.
   - **`worker.rs:735-745` (`download_stream_with_limiters`):** Lacked `If-Range`, lacked `206` `Content-Range` & validator checks on stream resume, lacked `416` recovery, lacked `expected_total` refresh on `200 OK` size change, and lacked a rewind cap (`MAX_STREAM_FULL_REWINDS`) to guarantee bounded failure.

### 3.2 Pre-Fix Reproduction Evidence

[`crates/tdm-core/tests/gate35_2_content_range_tests.rs`](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/tests/gate35_2_content_range_tests.rs) was written and executed **before** modifying engine code (`target/gate35_2_qa_logs/content_range_before_fix.log`), reproducing **7 failures out of 11 scenarios**:
- `test_02` FAILED: `probe_url` accepted `206 bytes 0-(N-1)/N` for `bytes=0-0` as `is_resumable = true`.
- `test_03` FAILED: exact `Mismatched Content-Range: expected offset 1048576, server responded with bytes 0-2097151/2097152` fatal abort.
- `test_04` FAILED: ignored `Range` (`200 OK`) caused fatal `ETagMismatch`.
- `test_05` FAILED (**silent corruption**): missing/malformed `Content-Range` on `206` wrote `0xFF` poison bytes and marked the corrupt file `Completed`.
- `test_07` FAILED: shorter changed resource caused fatal `ETagMismatch`.
- `test_08` FAILED (**silent corruption**): mid-download `ETag`/`Last-Modified` flip on `206` mixed v1+v2 bytes and marked the corrupt file `Completed`.
- `test_10` FAILED: HTTP `416` caused fatal failure.

### 3.3 Safe Engine Fix Implemented

1. **[`crates/tdm-core/src/engine/probe.rs`](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/src/engine/probe.rs):**
   - Hardened `parse_content_range_bounds` (case-insensitive `bytes `, rejects `start > end`, rejects `total == 0` or `end >= total`).
   - On `Range: bytes=0-0` HTTP `206` probe: sets `supports_ranges = true` **only** when `Content-Range` parses cleanly with `start == 0 && end == 0`; otherwise captures `total_bytes` safely and sets `supports_ranges = false` so broken CDNs immediately use single-stream mode without ever attempting multi-chunk Range requests.
2. **[`crates/tdm-core/src/engine/worker.rs`](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/src/engine/worker.rs):**
   - Added `validate_response_validators` (`ETag` & `Last-Modified` strict checks) and `validate_206_content_range` (requires valid `Content-Range`, exact `start == expected_start`, consistent `total`, and `cr_end <= fetch_end`).
   - Rejects missing/malformed `Content-Range` on `206` with `EngineError::InvalidRangeHeader` before writing a single byte.
   - Distinguishes `RangeNotSupported(200)` from `ETagMismatch` on unexpected `200 OK` responses during partial chunk fetches.
   - Added `download_stream_with_range_policy` with `If-Range`, strict `206` validation, `416` clean full-body restart, `200 OK` authoritative `Content-Length`/validator refresh, and `MAX_STREAM_FULL_REWINDS = 1` (preventing infinite rewind loops).
3. **[`crates/tdm-core/src/engine/manager.rs`](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/src/engine/manager.rs) & [`crates/tdm-core/src/db/repo.rs`](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/src/db/repo.rs):**
   - On multi-chunk `MismatchedContentRange`, `InvalidRangeHeader`, `RangeNotSupported`, `ETagMismatch`, or `HttpStatus(416)`:
     1. Immediately aborts and **fully drains `join_set`** (`while join_set.join_next().await.is_some() {}`) so no chunk worker can race writes after truncation.
     2. Performs **at most ONE** bounded fallback to single-stream full-body mode (`allow_range_resume = false`): truncates **only** this job's `.tdm-part` file (`writer.truncate_to(0)?`), resets DB chunks to 1 sequential non-resumable chunk, streams clean full body, updates authoritative `total_bytes` + chunk bounds (`save_chunks` now updates `start_byte` & `end_byte` on conflict), and runs `verify_chunks_complete_and_contiguous` + atomic publish.
   - Preserves all unrelated `.tdm-part` files untouched and fails cleanly within bounded attempts on permanently broken servers.

**Post-Fix Result:** **11/11 tests PASS** in `gate35_2_content_range_tests` (`0.41s`).

---

## 4. Priority 3 — Unwanted Windows Startup Popup Root Cause & Remediation

### 4.1 Read-Only Windows Startup & Forensic Process Audit

| Inspection Target | Result | Notes |
| :--- | :--- | :--- |
| `HKCU\...\Run` & `HKLM\...\Run` & `RunOnce` | **0 TORI entries** | `MicrosoftEdgeAutoLaunch_...` (`msedge.exe --no-startup-window --win-session-start`) and unrelated third-party `NeatDM.exe -autostart` are present. |
| `StartupApproved\Run` | 2 orphaned metadata entries (`ToriDownload`, `Tori Download Manager`) | No corresponding `Run` values exist; Windows does not launch TORI from these alone. |
| User & Common Startup Folders / Scheduled Tasks | **0 TORI entries** | Confirmed zero shortcuts and zero TORI scheduled tasks. |
| `%APPDATA%\tori-download-manager\logs\lifecycle.log` | **Exact causal trace captured** (`2026-11-25T15:23:25Z`–`15:23:29Z`) | Proved exact 4-layer startup popup mechanism below. |
| Leftover Host Registry State (Disclosed, NOT Mutated) | `HKCU\...\Uninstall\TORI Download Manager` points to `target\gate34_2_live_qa\upg_inst` (v1.0.7); `HKCU\...\NativeMessagingHosts\com.tori.download_manager` (Chrome/Edge/Firefox) point to `target\_oem_state_backups\gate34_2_live_25300_1795622594846\nm_*_blocked.json` | Residual from Gate 35.1 watchdog-terminated `verify_gate34_2_public_release.js` run. **Intentionally left untouched per Gate 35.2 no-registry-mutation rule**; owner can restore cleanly via TORI Desktop installer or `register_native_host` when authorized. |

### 4.2 Exact 4-Layer Causal Chain Proven by `lifecycle.log`

1. **OS Login Trigger:** Windows automatically starts Microsoft Edge in background mode (`msedge.exe --no-startup-window --win-session-start`).
2. **Browser Extension Replay & Startup Auto-Pair (`extension/background.js`):**
   - Edge fires `chrome.downloads.onCreated` for historical completed items in Edge's `History` DB (specifically `ledger-live-desktop-4.23.0-win-x64.exe`, completed on Nov 14). Because `handleBrowserDownload` did **not** check `item.state === 'in_progress'`, `item.paused`, `item.endTime`, or `item.startTime` recency, it re-intercepted the old completed download on every boot (generating `(1)` through `(19)`!) and triggered Native Messaging.
   - Simultaneously, `chrome.runtime.onStartup` called `autoPairWithDesktop(false)` → `sendNativeMessage({ action: 'pair' })`, spawning TORI Desktop even when TORI was not running.
3. **Concurrent Native-Host Spawn Stampede (`crates/tdm-native-host/src/ipc.rs`):**
   - `ensure_engine_running()` had no cross-process spawn mutex, causing ~14 concurrent `tdm-native-host.exe` processes to launch **14 simultaneous `tori-download-manager.exe --minimized` processes** between `15:23:25.275Z` and `15:23:27.572Z`.
4. **Desktop Popup After Immediate Job Failure (`src-tauri/src/commands.rs` & `src-tauri/src/lib.rs`):**
   - The replayed job `ledger-live-desktop-4.23.0-win-x64 (19).exe` was created at `15:23:29.339Z` and failed 413ms later (`15:23:29.752Z`) due to the Priority 2 `Content-Range` bug.
   - **80ms AFTER the job had already failed (`15:23:29.832Z`)**, `open_progress_window_internal(..., force=false)` still created an `always_on_top=true` standalone `"Download failed"` window directly on top of the user's desktop.
   - Additionally, `src-tauri/src/lib.rs:388` called `window.minimize()` instead of `window.hide()` on `--minimized` launch, contradicting `"visible": false` in `tauri.conf.json`.

### 4.3 Complete 4-Layer Fix Implemented

1. **Extension Layer ([`extension/background.js`](file:///F:/TORI/final%20tori%20download%20manager/extension/background.js) & synced Firefox copy):**
   - Added `shouldInterceptBrowserDownload(item, nowMs)` rejecting any `state !== 'in_progress'`, `paused === true`, `endTime` present, or `startTime` older than 60 seconds.
   - Replaced `onStartup` / `onInstalled` eager `autoPairWithDesktop` with `passivePairIfDesktopRunning()` — checks local HTTP passively and **never** invokes Native Messaging when Desktop is offline.
2. **Native Host Layer ([`crates/tdm-native-host/src/ipc.rs`](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-native-host/src/ipc.rs)):**
   - Added pipe-scoped Windows cross-process named mutex (`EngineSpawnMutexGuard` via `CreateMutexW` / `WaitForSingleObject` / `ReleaseMutex` / `CloseHandle`, `Local\TORI_DM_EngineSpawn_<fnv1a64>`) around `ensure_engine_running()` with double-checked `try_connect_engine()`, eliminating multi-process spawn stampedes.
3. **Pure Startup & Tray Policy Layer ([`crates/tdm-core/src/engine/startup_policy.rs`](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/src/engine/startup_policy.rs)):**
   - Added unit-tested `should_auto_open_progress_window`, `should_keep_main_window_hidden_on_startup`, and `is_close_to_tray_enabled_from_settings`.
4. **Desktop Shell Layer ([`src-tauri/src/lib.rs`](file:///F:/TORI/final%20tori%20download%20manager/src-tauri/src/lib.rs), [`src-tauri/src/commands.rs`](file:///F:/TORI/final%20tori%20download%20manager/src-tauri/src/commands.rs), [`src-tauri/src/tray.rs`](file:///F:/TORI/final%20tori%20download%20manager/src-tauri/src/tray.rs)):**
   - `--minimized` background startup now calls `window.hide()` instead of `window.minimize()`, staying silently in the system tray.
   - `open_progress_window_internal` blocks automatic (`force = false`) progress windows when `job.state` is `Failed` or `Cancelled`, or when launched minimized with a non-active job state, while keeping explicit user clicks (`force = true`), active user downloads, and close-to-tray behavior 100% preserved.

---

## 5. Executed Verification & Test Matrix

All suites below were executed cleanly in Gate 35.2 with logs captured under `target/gate35_2_qa_logs/`:

| Suite / Check | Command Executed | Exit Code | Exact Result | Log File |
| :--- | :--- | :---: | :--- | :--- |
| Companion v1.0.11 RC Packaging & `web-ext lint` | `node scripts/package_v1_0_11_extensions.js` | `0` | **PASS** — 5 preserved artifacts verified, 10-file byte parity verified, Chromium ZIP (35 entries), Firefox unsigned candidate ZIP (42 entries), `web-ext lint`: **0 errors**, 7 warnings, 0 notices | `target/gate35_2_qa_logs/package_v1_0_11.log` |
| Adversarial Extension Security & Cross-Browser Suite | `node scripts/verify_gate35_2_extension_security.js` | `0` | **26 / 26 PASS** (11 Chromium/Edge + 11 Firefox + 2 static content checks + 2 manifest checks) | `target/gate35_2_qa_logs/extension_security.log` |
| Priority 2 Pre-Fix Reproduction | `cargo test -p tdm-core --test gate35_2_content_range_tests` (pre-fix) | `101` | **Reproduced 7 failures** (`test_02, 03, 04, 05, 07, 08, 10`) including 2 silent corruption bugs | `target/gate35_2_qa_logs/content_range_before_fix.log` |
| Priority 2 & 3 Targeted Tests (Post-Fix) | `cargo test -p tdm-core --test gate35_2_content_range_tests --test gate35_2_startup_and_tray_tests` | `0` | **16 / 16 PASS** (`11/11` Content-Range + `5/5` Startup/Tray) | `target/gate35_2_qa_logs/gate35_2_core_tests.log` |
| Full Rust Workspace Test Suite (Clean Env) | `cargo test --workspace` | `0` | **313 / 313 PASS, 0 failed, 0 ignored** across 44 test binaries (incl. 61 `tdm-core` lib, 11 Content-Range, 5 Startup/Tray, 12 `tdm-native-host` lib incl. 2 spawn-mutex tests, 20 `tdm-native-host` integration tests, 10 updater crypto tests, 9 integration tests, etc.) | `target/gate35_2_qa_logs/cargo_test_workspace_clean.log` |
| Workspace Clippy & New Tests Clippy | `cargo clippy --workspace --all-targets` & `cargo clippy -p tdm-core --test gate35_2_content_range_tests --test gate35_2_startup_and_tray_tests` | `0` | **0 errors**, **0 warnings** in any Gate 35.2 new or modified code | `target/gate35_2_qa_logs/cargo_clippy.log`, `clippy_gate35_2_tests.log` |
| UI Lint & Production Build | `npm run lint` & `npm run build` (in `ui/`) | `0` | **0 errors** (7 pre-existing warnings, UI untouched); Vite build succeeded in `1.87s` | `target/gate35_2_qa_logs/ui_lint.log`, `ui_build.log` |
| Secret Scan | Python regex scan over all modified/new files | `0` | **0 secret hits** across 25 files | `target/gate35_2_qa_logs/preservation_and_secrets.log` |
| Production & OEM Preservation Check | Python SHA-256 + read-only SQLite + git check | `0` | **100% preserved** (details in Section 6) | `target/gate35_2_qa_logs/preservation_and_secrets.log`, `oem_final_verification.log` |

---

## 6. Production Release & OEM Environment Preservation Evidence

| Protected Asset | Expected Baseline | Verified Post-Gate 35.2 Value | Match |
| :--- | :--- | :--- | :---: |
| Frozen Desktop `v1.0.8` Installer | `728d0d253a8fadc3fea5244723237f267dcd13abf65cac49b91a4ec83a3dcffb` | `728d0d253a8fadc3fea5244723237f267dcd13abf65cac49b91a4ec83a3dcffb` | **YES** |
| Public Companion `v1.0.10` Chromium ZIP | `f220fab2e26fd54ef7f85fd7e40613faad79e7f9a7f44fadf228ccd0edcc22f1` | `f220fab2e26fd54ef7f85fd7e40613faad79e7f9a7f44fadf228ccd0edcc22f1` | **YES** |
| Public Companion `v1.0.10` Signed Firefox XPI | `a93a43872d224426902c49e217e31b2c603263d8c260c429940539b34b2852b8` | `a93a43872d224426902c49e217e31b2c603263d8c260c429940539b34b2852b8` | **YES** |
| Public Companion `v1.0.10` Firefox ZIP | `56139a065e74cf8b2232003f4368a721c5e055711834fa5e2fd644d62f8f9b0e` | `56139a065e74cf8b2232003f4368a721c5e055711834fa5e2fd644d62f8f9b0e` | **YES** |
| Historical Signed Firefox `v1.0.7` / `v1.0.9` XPIs | `b082c8f2...` / `d4e8d6e5...` | `b082c8f2...` / `d4e8d6e5...` | **YES** |
| OEM Installed `v1.0.6` Binary | `570833b379668f64d8f0a81e0a2c138635835e0c0382f37f24ec969caccf0fda` | `570833b379668f64d8f0a81e0a2c138635835e0c0382f37f24ec969caccf0fda` | **YES** |
| OEM SQLite (`tdm_storage.sqlite`, read-only) | `PRAGMA integrity_check = ok`, `56` downloads, `531` chunks | `ok`, `56` downloads, `531` chunks, `7` settings rows | **YES** |
| OEM `.tdm-part` Files | `21` files | `21` files | **YES** |
| Website Repo (`C:\Users\ritud\Downloads\tori-website`) | Clean working tree | Clean working tree (`git status --porcelain` empty) | **YES** |
| GitHub Releases / Production Tools Manifest rev 2 / Signing Keys | Unchanged | Unchanged (zero remote writes, zero key mutations) | **YES** |

---

## 7. Source Change Inventory

### Modified Files
- [`extension/content.js`](file:///F:/TORI/final%20tori%20download%20manager/extension/content.js) & [`extension/firefox/content.js`](file:///F:/TORI/final%20tori%20download%20manager/extension/firefox/content.js) — Removed `__TORI_DISPATCH__`, `__TORI_RESPONSE__`, `toriExtensionUrl`; closed Shadow DOM; added `e.isTrusted` guards.
- [`extension/background.js`](file:///F:/TORI/final%20tori%20download%20manager/extension/background.js) & [`extension/firefox/background.js`](file:///F:/TORI/final%20tori%20download%20manager/extension/firefox/background.js) — Strict sender authentication/authorization/schema validation, token minimization, content-script rate limiting, `shouldInterceptBrowserDownload` historical-replay guard, passive `onStartup`/`onInstalled`.
- [`extension/manifest.json`](file:///F:/TORI/final%20tori%20download%20manager/extension/manifest.json), [`extension/firefox/manifest.json`](file:///F:/TORI/final%20tori%20download%20manager/extension/firefox/manifest.json), [`extension/options/options.html`](file:///F:/TORI/final%20tori%20download%20manager/extension/options/options.html), [`extension/options/options.js`](file:///F:/TORI/final%20tori%20download%20manager/extension/options/options.js) (+ Firefox synced copies) — Version `1.0.11`.
- [`crates/tdm-core/src/engine/probe.rs`](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/src/engine/probe.rs) — Strict `Range: bytes=0-0` `206` validation & hardened `parse_content_range_bounds`.
- [`crates/tdm-core/src/engine/worker.rs`](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/src/engine/worker.rs) — Strict `206` `Content-Range` & `ETag`/`Last-Modified` validation, `RangeNotSupported(200)` handling, `download_stream_with_range_policy` with bounded rewind cap & `416` recovery.
- [`crates/tdm-core/src/engine/manager.rs`](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/src/engine/manager.rs) — Worker-drained 1x bounded multi-chunk → single-stream fallback with target-only `.tdm-part` truncation & final size/contiguity verification.
- [`crates/tdm-core/src/db/repo.rs`](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/src/db/repo.rs) — Update `start_byte` & `end_byte` in `save_chunks` upsert so single-stream fallback bounds persist accurately.
- [`crates/tdm-core/src/engine/mod.rs`](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/src/engine/mod.rs) & [`crates/tdm-core/src/lib.rs`](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/src/lib.rs) — Export `startup_policy` helpers.
- [`crates/tdm-native-host/src/ipc.rs`](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-native-host/src/ipc.rs) — Cross-process pipe-scoped Windows named mutex (`EngineSpawnMutexGuard`) around `ensure_engine_running()` + unit tests.
- [`src-tauri/src/lib.rs`](file:///F:/TORI/final%20tori%20download%20manager/src-tauri/src/lib.rs), [`src-tauri/src/commands.rs`](file:///F:/TORI/final%20tori%20download%20manager/src-tauri/src/commands.rs), [`src-tauri/src/tray.rs`](file:///F:/TORI/final%20tori%20download%20manager/src-tauri/src/tray.rs) — Silent `--minimized` `window.hide()`, suppression of auto-opened `Failed`/`Cancelled` progress windows, shared tray policy.

### Added Files
- [`crates/tdm-core/src/engine/startup_policy.rs`](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/src/engine/startup_policy.rs)
- [`crates/tdm-core/tests/gate35_2_content_range_tests.rs`](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/tests/gate35_2_content_range_tests.rs)
- [`crates/tdm-core/tests/gate35_2_startup_and_tray_tests.rs`](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/tests/gate35_2_startup_and_tray_tests.rs)
- [`scripts/package_v1_0_11_extensions.js`](file:///F:/TORI/final%20tori%20download%20manager/scripts/package_v1_0_11_extensions.js)
- [`scripts/verify_gate35_2_extension_security.js`](file:///F:/TORI/final%20tori%20download%20manager/scripts/verify_gate35_2_extension_security.js)
- [`docs/reports/GATE35_2_COMPANION_SECURITY_HOTFIX_AND_DESKTOP_BUG_TRIAGE_REPORT.md`](file:///F:/TORI/final%20tori%20download%20manager/docs/reports/GATE35_2_COMPANION_SECURITY_HOTFIX_AND_DESKTOP_BUG_TRIAGE_REPORT.md)

---

## 8. Remaining Blockers & Final Recommendation

### Remaining Release Blockers (Before Any Public Release)
1. **Firefox AMO Signing (Companion `v1.0.11`):** Submit `release/v1.0.11-extension-rc/tori-companion-v1.0.11-firefox.zip` to Mozilla AMO and obtain a verified Mozilla-signed `.xpi` before publishing Companion `v1.0.11` to Firefox users.
2. **Explicit Separate Owner Release Authorization:** Required before publishing Companion `v1.0.11` or building/publishing Desktop `v1.0.9`.
3. **Carried-Forward Stage 2 Production Governance Items (Desktop `v1.0.9`):**
   - Clean Windows 10 & Windows 11 VM end-to-end QA (fresh install, `v1.0.8` → `v1.0.9` auto-update, browser handoff, real `download.live.ledger.com` download verification, reboot/startup verification).
   - Windows Authenticode code signing (`RISK-34-02`).
   - Verified offline backup of signing keys (`RISK-34-01`).
4. **Optional Host Registry Cleanup (Owner Machine Only):** Restore `HKCU\...\NativeMessagingHosts\com.tori.download_manager` and `Uninstall\TORI Download Manager` when authorized (left untouched during Gate 35.2).

### Final Verdict: **CONDITIONAL GO**
- **GO** for local Gate 35.2 checkpointing (`checkpoint-gate35_2-security-hotfix-and-triage-verified`) and advancing Browser Companion `v1.0.11` Chromium RC + Firefox AMO signing submission.
- **HOLD** on public GitHub release publication, `latest.json` update, and website promotion until Firefox AMO signing completes and explicit owner release authorization is granted.
