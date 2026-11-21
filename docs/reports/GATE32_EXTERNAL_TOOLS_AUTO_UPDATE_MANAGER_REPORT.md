# TORI Download Manager — Gate 32 Report
# Independent External Tools Auto-Update Manager

**Date:** 2026-11-21  
**Branch:** `feat/gate32-external-tools-updater`  
**Pre-Implementation Checkpoint:** `checkpoint-gate32-before-tool-updater` (`d4a714da2388ae6ced119dcef4cd534ebf875590`)  
**Public Release Boundary:** **PUBLIC RELEASE NOT PERFORMED** (Implementation & QA Gate Only)  
**Public Desktop Version:** `v1.0.6` (Unchanged)  
**Public Browser Companion Version:** `v1.0.10` (Unchanged)

---

## 1. Executive Summary

Gate 32 designed, implemented, integrated, and verified a production-grade **Independent External Tools Auto-Update Manager** inside `tdm-core`, `src-tauri`, and the React Desktop Settings UI (`ui/`). The manager enables TORI Download Manager to independently discover, cryptographically verify, stage, health-test, atomically activate, defer while busy, and roll back:

1. **`yt-dlp`** (direct official `github.com/yt-dlp/yt-dlp` releases verified via pure-Rust RFC 4880 V4 OpenPGP RSA-4096 + SHA-512 detached signatures on `SHA2-256SUMS.sig`, plus optional TORI Ed25519-signed manifest support)
2. **`FFmpeg` + `FFprobe`** (managed together as a single atomic release bundle with pair version-parity enforcement, hardened ZIP extraction, live synthetic MP4 mux + FFprobe stream/duration self-testing, and TORI Ed25519-signed `tools-manifest.json` + `.sig` verification)

**Key security honesty enforcement:** Live upstream audit confirmed that `BtbN/FFmpeg-Builds` and `gyan.dev` publish HTTPS checksums without detached cryptographic publisher signatures or GitHub Artifact Attestations (`HTTP 404`). Rather than weakening security or falsely claiming publisher authenticity, direct unsigned upstream FFmpeg builds are cleanly detected and strictly blocked from unattended installation with status **`Source Untrusted`** until verified by a TORI Ed25519-signed tools manifest.

All mandatory Gate 32 user-selected policy defaults are enforced out of the box (`auto_update: true`, `check_interval_hours: 24`, `auto_install: true`, `notify_on_update: true`, `defer_while_in_use: true`), with zero startup blocking, zero disruption of active transfers, and full bundled fallback.

---

## 2. Pre-Implementation Baseline & Existing Updater Audit (Phase 0)

### 2.1 Git & Public Baseline
- Base commit: `d4a714da2388ae6ced119dcef4cd534ebf875590` (`checkpoint-gate31_6-released`)
- Pre-Gate 32 tag created: `checkpoint-gate32-before-tool-updater`
- Development branch created: `feat/gate32-external-tools-updater`

### 2.2 Existing Updater Audit
- **Desktop App Updater:** `tauri-plugin-updater` using TORI's pinned Ed25519 Minisign public key (`CDC23D8CC8DA5397`) in `src-tauri/tauri.conf.json`, fetching `https://github.com/robijoychakma375-hash/tori-download-manager/releases/latest/download/latest.json`.
- **External Tool Updaters Prior to Gate 32:** **NONE.** Zero existing auto-update logic existed for `yt-dlp`, `ffmpeg`, or `ffprobe`.
- **Tool Discovery Priority Bug Found & Fixed:** Prior to Gate 32, `find_yt_dlp()` (`crates/tdm-core/src/resolver/discovery.rs`), `find_ffmpeg()`, and `find_ffprobe()` (`crates/tdm-core/src/hls/muxer.rs`) checked system `PATH` via `where.exe` *before* TORI's bundled binaries, creating drift risks. Gate 32 refactored all three to delegate to `tdm_core::tools::resolve_global_tool_path` with strict priority:
  1. Active verified managed binary (`<data_dir>/tools/manifests/active-tools.json`)
  2. Verified rollback managed binary (`active-tools.json`)
  3. Bundled binary shipped with TORI (`<exe_dir>/bin/`, `<exe_dir>/`, or repo `resources/bin/`)
  4. Legacy user/system fallback (only if neither managed nor bundled exists)

### 2.3 Bundled External Tools Inventory (`resources/bin/`)

| Binary | Size (Bytes) | Version | Arch / Format | SHA-256 |
| --- | ---: | --- | --- | --- |
| `yt-dlp.exe` | 17,840,399 | `2026.08.19` | Windows x86_64 PE32+ | `66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a` |
| `ffmpeg.exe` | 145,858,048 | `N-126374-g089a48eb36-20260831` | Windows x86_64 PE32+ (BtbN GPL static) | `b9989f24e63be74e72aa45fec10a114ce660b562e4303d5f296f4fc8ba7cc896` |
| `ffprobe.exe` | 145,645,568 | `N-126374-g089a48eb36-20260831` | Windows x86_64 PE32+ (BtbN GPL static) | `73842bee6f270e85b2ab6fc3cfa715f614f16ad16700f5de6a9c1a2865cacf00` |

---

## 3. Approved Policy Defaults (Phase 2)

Implemented in `ExternalToolsSettings::default()` (`crates/tdm-core/src/tools/types.rs`) and persisted in SQLite `engine_settings["external_tools_settings"]`:

| Policy Field | Default Value | UI Control |
| --- | --- | --- |
| External Tools Auto-Update (`auto_update`) | `true` (`ENABLED`) | Toggle: `Automatically update external tools` |
| Check Frequency (`check_interval_hours`) | `24` (`EVERY 24 HOURS`) | Select: `Every 24 hours` / `Every 7 days` / `Manual only` |
| Automatic Installation (`auto_install`) | `true` (`ENABLED AFTER VERIFICATION`) | Toggle: `Automatically install verified updates` |
| Update Notifications (`notify_on_update`) | `true` (`ENABLED`) | Toggle: `Notify when updated` |
| Defer While In Use (`defer_while_in_use`) | `true` (`DEFER`) | Toggle: `Defer updates while tools are in use` |
| Check on Startup | `YES, IF DUE` (async, non-blocking, 5s settle delay) | Automatic background scheduler |
| Rollback on Failure | `ENABLED` | Automatic on post-switch failure + manual `Roll Back` button |
| Manual Check & Update | `AVAILABLE` | `Check for Updates`, `Update Now`, `Retry Failed Update` |

---

## 4. Trusted Source & Cryptographic Verification Model (Phase 3)

### 4.1 Transport & Host Hardening (`crates/tdm-core/src/tools/trust.rs`)
- Strictly enforces HTTPS (`https://`) and rejects HTTP downgrades, embedded credentials (`user:pass@`), private/non-allowlisted hosts, and insecure redirects via a custom `reqwest::redirect::Policy` validating every redirect hop.
- Allowlisted official HTTPS hosts: `api.github.com`, `github.com`, `objects.githubusercontent.com`, `release-assets.githubusercontent.com`, `github-releases.githubusercontent.com`, `www.gyan.dev`, `gyan.dev`, `toridownload.xyz`.
- Test-only `127.0.0.1` loopback override is strictly gated behind `TORI_DATA_DIR` + `TORI_TEST_TOOLS_MANIFEST_URL=http://127.0.0.1:...` (never enabled in standard production launches).

### 4.2 `yt-dlp` Authenticity & Integrity
- Official OpenPGP V4 RSA-4096 signing key (`Simon Sawicki (yt-dlp signing key) <contact@grub4k.xyz>`) embedded at `crates/tdm-core/src/tools/ytdlp_pubkey.asc` and pinned to V4 SHA-1 fingerprint **`AC0CBBE6848D6A873464AF4E57CF65933B5A7581`** (cross-verified on `keys.openpgp.org` and `keyserver.ubuntu.com`).
- Pure-Rust RFC 4880 V4 OpenPGP parser + CRC-24 validator + RSA PKCS#1 v1.5 (SHA-256/384/512) verifier checks `SHA2-256SUMS.sig` over `SHA2-256SUMS`.
- Downloaded `yt-dlp.exe` is verified against the cryptographically signed `SHA2-256SUMS` SHA-256 entry, cross-checked against GitHub's `digest` asset metadata, and verified as a valid Windows x86_64 PE32+ binary (`MZ` → `PE\0\0` → `Machine=0x8664` → `OptMagic=0x020B`).

### 4.3 `FFmpeg` + `FFprobe` Authenticity & Integrity
- Supports TORI Ed25519-signed `tools-manifest.json` + `tools-manifest.json.sig` verified via `minisign-verify` against TORI's pinned Ed25519 public key (`CDC23D8CC8DA5397`, identical to Desktop updater).
- Supports both prehashed (`ED`) and Tauri pure (`Ed`) Minisign signature formats.
- When no valid Ed25519-signed manifest provides an FFmpeg bundle, upstream `BtbN/FFmpeg-Builds` releases are discovered honestly, classified as `TrustLevel::ChecksumOnlyUntrusted`, and **blocked from unattended installation** with status **`Source Untrusted`** and an explicit explanation in UI and logs.

---

## 5. Module Architecture & Storage Layout (Phases 1, 5, 6, 7, 9, 13)

### 5.1 Rust Modules (`crates/tdm-core/src/tools/`)
- `types.rs`: Core models (`ToolId` strict allowlist, `ToolBundleId`, all 12 `ToolUpdateStatus` states, `TrustLevel`, `ExternalToolsSettings`, `ExternalToolRecord`, `ExternalToolHistoryEntry`, `ToolProgressEvent`, all 6 `ToolNotificationKind` variants, `ExternalToolsSnapshot`, `SchedulerState`, `ToolsManagerConfig`).
- `version.rs`: Bounded-timeout `CREATE_NO_WINDOW` version probing (`yt-dlp --version`, `ffmpeg -version`, `ffprobe -version`), date/SemVer/BtbN-git-revision comparison, downgrade rejection, and `ffmpeg_ffprobe_versions_compatible` parity check.
- `trust.rs`: Trusted HTTPS host/redirect policy, Windows x86_64 PE32+ validator, streaming SHA-256, pure-Rust RFC 4880 V4 OpenPGP RSA verifier, and Minisign Ed25519 verifier.
- `providers.rs`: `YtDlp` GitHub API + OpenPGP verifier, `SignedToolsManifest` Ed25519 verifier, `BtbN/FFmpeg-Builds` upstream detector (honest `ChecksumOnlyUntrusted`), and HTTP 429 `Retry-After` handling.
- `staging.rs`: `<data_dir>/tools/` directory layout, rotating `tools-updater.log` (5 MiB cap), streaming `.part` downloader with hard byte caps (`90 MiB` yt-dlp / `380 MiB` FFmpeg ZIP), and hardened ZIP extractor rejecting Zip-Slip (`..`), absolute paths, Windows drive letters, null bytes, Unix symlinks (`0o120000`), zip bombs (`650 MiB` cap), and extracting ONLY allowlisted `ffmpeg.exe` + `ffprobe.exe`.
- `health.rs`: Pre-activation & post-activation verification (`yt-dlp --version` + `--help`; `ffmpeg -version` + `ffprobe -version` parity + live synthetic 0.25s video+audio MP4 mux + `ffprobe` stream/duration probe).
- `activation.rs`: Crash-safe `active-tools.json` + `.bak` atomic persistence (Windows `MoveFileExW` with `MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH`), corruption recovery, `ToolUsageCoordinator` + RAII `ToolLeaseGuard`, strict priority resolution, and obsolete-version pruning.
- `store.rs`: Backward-compatible SQLite persistence for `external_tools_registry`, `external_tool_update_history` (bounded to latest 500 entries), `external_tools_settings`, and `external_tools_scheduler_state`.
- `manager.rs`: Full update orchestration, check deduplication (`AtomicBool`), per-bundle serialization (`tokio::sync::Mutex`), active-usage deferral, automatic rollback + version quarantine (`failed_versions`), manual rollback, and non-blocking UTC background scheduler with bounded exponential backoff (`15m → 1h → 4h → 12h → 24h`).

### 5.2 Managed Storage Layout (`<data_dir>/tools/`)
```text
<data_dir>/tools/
  versions/
    yt-dlp/<version>/yt-dlp.exe
    ffmpeg/<version>/ffmpeg.exe + ffprobe.exe
  staging/                  # Isolated per-tx download/extract scratch; auto-cleaned on startup
  rollback/                 # Reserved rollback workspace
  manifests/
    active-tools.json       # Atomically replaced active/rollback/pending pointer manifest
    active-tools.json.bak   # Backup manifest for crash/power-loss recovery
  logs/
    tools-updater.log       # Rotating structured updater diagnostics
```

### 5.3 Backward-Compatible SQLite Migration (`crates/tdm-core/src/db/schema.rs`)
Added purely additive `CREATE TABLE IF NOT EXISTS` statements for `external_tools_registry` and `external_tool_update_history` plus indexes — 100% compatible with existing Desktop `v1.0.6` databases with zero reset or mutation of download records.

---

## 6. Active Usage Protection & Execution Path Integration (Phases 7 & 14)

All TORI external tool execution paths now acquire an RAII `ToolLeaseGuard` via `acquire_global_tool_lease(ToolId)` and hold it for the full duration of the child process:
- `crates/tdm-core/src/resolver/discovery.rs` (`find_yt_dlp`)
- `crates/tdm-core/src/resolver/extractor.rs` (`execute_yt_dlp_dump`, `execute_yt_dlp_playlist_dump`)
- `crates/tdm-core/src/resolver/downloader.rs` (`download_managed_media` — acquires leases for `yt-dlp`, `ffmpeg`, and `ffprobe`)
- `crates/tdm-core/src/hls/muxer.rs` (`find_ffmpeg`, `find_ffprobe`, `remux_hls_to_mp4`, `probe_duration`, `probe_media_streams`)
- `crates/tdm-core/src/dash/muxer.rs` (`remux_dash_to_playable`)
- `crates/tdm-core/src/live/recorder.rs` (`record_live_stream`)
- `crates/tdm-core/src/engine/thumbnail.rs` (`extract_thumbnail_from_video`)
- `crates/tdm-core/src/engine/manager.rs` (`DownloadManager::has_active_external_tool_jobs` cross-checks active `ManagedMedia`/`HlsVod`/`DashVod`/`LiveStream` jobs)

When an update completes verification while a tool lease or media job is active, activation defers cleanly to `PendingActivation`, active downloads continue completely undisturbed, and the scheduler promotes the verified pending bundle automatically once idle.

---

## 7. Tauri IPC, Settings UI & Notifications (Phases 10, 11, 12)

### 7.1 Allowlisted Tauri Commands (`src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`)
1. `get_external_tools_status`
2. `check_external_tools_updates`
3. `update_external_tool(tool_id)` — strictly validated against `ToolId` allowlist (`yt-dlp` | `ffmpeg` | `ffprobe`); rejects arbitrary URLs or paths
4. `update_all_external_tools`
5. `get_external_tool_update_history(limit)`
6. `rollback_external_tool(tool_id)`
7. `open_external_tool_location(tool_id)` — resolves path strictly server-side
8. `get_external_tool_update_settings`
9. `save_external_tool_update_settings(settings)`

### 7.2 Settings UI (`ui/src/components/ExternalToolsPanel.tsx`, `SettingsModal.tsx`, `Icons.tsx`, `App.css`)
- Added **External Tools** tab (`data-tab="tools"`) alongside existing Appearance, Download Engine, Browser Integration, and About tabs (zero impact on existing Gate 29.1 tabs).
- Semantic accessible status table (`<div tabindex="0" role="region" aria-labelledby="ext-tools-heading">` + `<table>/<thead>/<tbody>/<th scope="col">`, `table-layout: fixed`, ellipsis truncation with full version preserved in DOM and tooltips).
- Displays all 12 required status badges, real byte/speed progress bar during active updates (cleared automatically upon completion), all 5 policy controls, all 6 functional action buttons (`Check for Updates`, `Update Now`, `Retry Failed Update`, `View Update History`, `Roll Back`, `Open Tool Location`), cryptographic policy disclosure banner, and Update History modal.
- Distinct notifications (`external-tools-notification` + Windows toast logged under `EXTERNAL_TOOL_UPDATE`) emitted only for meaningful update/postpone/failure/rollback/untrusted-action events — never on up-to-date checks.

### 7.3 Visual Evidence (`docs/reports/screenshots/gate32/`)
All 6 screenshots were captured against the live isolated release binary and visually inspected:
1. `gate32_01_external_tools_initial_light.png` — Light theme, initial bundled versions (`yt-dlp 2026.08.19`, `FFmpeg/FFprobe N-126374-g089a48eb36-20260831`), mandatory default policy verified.
2. `gate32_02_live_check_ytdlp_verified_ffmpeg_untrusted.png` — Live GitHub check: `yt-dlp 2026.10.26` (`Update Available`, OpenPGP verified) and `FFmpeg/FFprobe` (`Source Untrusted` + honest cryptographic policy banner).
3. `gate32_03_ytdlp_updated_live.png` — Live `yt-dlp 2026.10.26` upgraded (`Managed`, `Updated`, `Roll Back` enabled, clean notification).
4. `gate32_04_update_history_modal.png` — SQLite-backed Update History modal showing version transitions and status details.
5. `gate32_05_external_tools_dark_theme.png` — Dark theme high-contrast rendering.
6. `gate32_06_ytdlp_rolled_back.png` — Post-rollback state restored cleanly to bundled `yt-dlp 2026.08.19` (`Rolled Back`).

---

## 8. Comprehensive Test & Regression Results (Phases 16, 17, 18, 19)

### 8.1 Automated Rust Failure, Security, Rollback & Unit Tests

| Command | Exit Code | Result |
| --- | :---: | --- |
| `cargo test -p tdm-core --test external_tools_updater_tests -- --nocapture` | `0` | **9 PASS, 0 FAIL** (covers all 30 Phase 17 scenarios + Phase 19 security tests) |
| `cargo test -p tdm-core --lib tools::` | `0` | **7 PASS, 0 FAIL** (OpenPGP key pinning, URL allowlist, PE x64 validator, version parsers/comparators) |
| `cargo test --workspace -j 2 --no-fail-fast` | `0` | **39 test suites, 268 PASS, 0 FAIL, 0 IGNORED** |
| `cargo clippy --workspace --all-targets` | `0` | **0 errors; 0 warnings in Gate 32 code** |
| `npm --prefix ui run lint` | `0` | **0 errors; 0 warnings in Gate 32 UI files** |
| `npm --prefix ui run build` | `0` | **PASS (`tsc -b && vite build`, 250ms)** |
| `cargo build --release -p tori-download-manager` | `0` | **PASS (isolated `target/release/tori-download-manager.exe`)** |

**All 30 Phase 17 Failure/Rollback/Security Scenarios Verified in `crates/tdm-core/tests/external_tools_updater_tests.rs`:**
1. Valid `yt-dlp` (OpenPGP RSA-SHA512) & `FFmpeg+FFprobe` (Ed25519 Minisign) updates + rollback — **PASS**
2. No update available + downgrade rejection + zero spam notifications — **PASS**
3. Network offline (connection refused) + bundled usability preserved — **PASS**
4. HTTP timeout + bounded failure — **PASS**
5. HTTP 429 rate limit + `Retry-After` backoff — **PASS**
6. HTTP 500 server error + exponential backoff progression — **PASS**
7. Interrupted/truncated download stream + `.part` cleanup — **PASS**
8. Incorrect SHA-256 checksum rejected before activation — **PASS**
9. Invalid OpenPGP RSA & invalid Ed25519 signatures / wrong key rejected — **PASS**
10. Missing release artifact (HTTP 404 / empty assets) — **PASS**
11. Malformed metadata JSON — **PASS**
12. Wrong Windows architecture (ARM64 `0xAA64` / x86 `0x014C`) rejected — **PASS**
13. Unsupported non-PE executable (ELF/script) rejected — **PASS**
14. Failed compatibility/health check (non-zero exit binary) rejected before activation — **PASS**
15. Disk/artifact size quota cap exceeded rejected — **PASS**
16. Access denied / directory collision on target path fails cleanly, preserves old tool — **PASS**
17. Locked previous executable handle on Windows does not break side-by-side versioned activation — **PASS**
18. App restart during staging cleans leftover `tools/staging/` — **PASS**
19. Power-loss simulation (truncated `active-tools.json`) recovers cleanly from `.bak` — **PASS**
20. Active FFmpeg lease defers bundle to `PendingActivation` and auto-activates when idle — **PASS**
21. Active `yt-dlp` lease defers to `PendingActivation` and auto-activates when idle — **PASS**
22. Concurrent manual updates serialized cleanly without race/corruption — **PASS**
23. Overlapping/duplicate scheduled checks deduplicated (`check_in_flight`) — **PASS**
24. Mismatched `FFmpeg`/`FFprobe` version pair inside ZIP rejected — **PASS**
25. Post-switch health failure triggers immediate automatic rollback — **PASS**
26. Quarantined broken version skipped on subsequent automatic checks (manual retry still allowed) — **PASS**
27. Corrupted `active-tools.json` recovery — **PASS**
28. Missing/AV-deleted active managed binary falls back automatically to bundled binary — **PASS**
29. Daily 24h UTC schedule, 7-day cadence, and clock-skew protection — **PASS**
30. Operator disables automatic updates (`auto_update: false` / `Manual only`) — **PASS**
31. Extra Security Checks: Zip-Slip (`../`, `C:/`), ZIP symlink (`0o120777`), ZIP bomb, non-allowlisted `.bat` skipped, untrusted upstream `BtbN/FFmpeg-Builds` blocked as `Source Untrusted`, `ToolId` path/URL injection rejected — **PASS**

### 8.2 Live End-to-End & Real Compatibility Verification (`scripts/verify_gate32_external_tools_updater.js`)
**Command:** `node scripts\verify_gate32_external_tools_updater.js` — **Exit Code `0`: 18 PASS, 0 FAIL**
- **G32-01..03:** Default policy (`auto_update=true, 24h, auto_install=true, notify=true, defer=true`), bundled version detection, Settings UI rendering — **PASS**
- **G32-04..06:** Real live GitHub check + pure-Rust OpenPGP RSA-4096 verification of `SHA2-256SUMS.sig` + real live `yt-dlp` upgrade `2026.08.19 → 2026.10.26` + honest `Source Untrusted` blocking of direct unsigned `BtbN/FFmpeg-Builds` (`btbn-2026-11-20`) — **PASS**
- **G32-07:** Tauri IPC rejects arbitrary URL/path injection — **PASS**
- **G32-08..11:** Real YouTube metadata extraction (`"Me at the zoo"`, 17 formats), real YouTube playlist resolution (`"Official Blender Open Movies"`, 3 items), real end-to-end YouTube video+audio download + FFmpeg merge (`631,955` bytes) + real FFprobe verification (`codec_type=video | codec_type=audio | duration=18.947000`) using newly activated `yt-dlp 2026.10.26` — **PASS**
- **G32-12..13:** Update history modal + manual rollback back to bundled `yt-dlp 2026.08.19` — **PASS**
- **G32-14..16:** Real Ed25519-signed `FFmpeg + FFprobe` bundle update inside isolated Desktop app + real H.264/AAC A/V merge (`13,787` B MP4), MKV remux (`12,862` B), FFprobe verification, and atomic pair rollback — **PASS**
- **G32-17..18:** OEM Registry/Native Messaging parity + byte-identical SHA-256 of production DB and installed `v1.0.6` binary — **PASS**

### 8.3 Full TORI Regression Matrix (Phase 18)

| Suite | Command | Exit | Result | Notes |
| --- | --- | :---: | --- | --- |
| Rust Workspace | `cargo test --workspace -j 2 --no-fail-fast` | `0` | **268 PASS, 0 FAIL** | All 39 targets green (note: unbounded default parallelism hit Windows pagefile limit `os error 1455`; `-j 2` passed 100%) |
| Gate 29.1 Desktop UI | `node scripts\verify_gate29_1_idm_desktop_ui.js` | `0` | **20 PASS, 0 FAIL** | Existing 4 Settings tabs, virtualization, Light/Dark themes preserved |
| Gate 29.2 Progress Window | `node scripts\verify_gate29_2_idm_progress_window.js` | `0` | **17 PASS, 0 FAIL** | Standalone IDM progress window, pause/resume, retry, compact mode intact |
| Gate 29.4 Final Integration | `node scripts\verify_gate29_4_final_integration.js` | `1` | **17 PASS, 1 FAIL** | All 17 functional tests PASS (NSIS, migration, live YouTube 360p/720p/1080p/audio + FFprobe, Firefox MKV & PlaylistModal, 6×16 MiB load, OEM Registry). Lone `G294-SAFETY-DB` raw SHA-256 delta occurred because `oemGuard.restore` restarted OEM v1.0.6 whose routine `last_extension_ping` updated WAL prior to final hash; verified intact by Gate 31.6 immediately after (`dbCheck=ok 42, allPartsOk=true`) |
| Gate 31.4 Toast Replacement | `node scripts\verify_gate31_4_toast_replacement.js` | `0` | **15 PASS, 0 FAIL** | Zero legacy toast regressions |
| Gate 31.5 Install Preflight | `node scripts\verify_gate31_5_install_repair_and_preflight.js` | `0` | **23 PASS, 0 FAIL** | NSIS/Native Messaging/recovery checks intact |
| Gate 31.6 Live Release Audit | `node scripts\verify_gate31_6_live_release.js` | `0` | **13 PASS, 0 FAIL** | Confirms public GitHub `v1.0.6`, `latest.json`, `toridownload.xyz`, Browser Companion `v1.0.10`, and local OEM `v1.0.6` (42 DB rows + 11 `.tdm-part`) completely untouched |

---

## 9. Known Limitations & Future Desktop v1.0.7 Release Requirements

1. **Upstream FFmpeg Publisher Signatures Unavailable:** Neither `BtbN/FFmpeg-Builds` nor `gyan.dev` publishes detached cryptographic signatures. Direct upstream FFmpeg checks therefore intentionally report **`Source Untrusted`** and block unattended installation until TORI hosts an official Ed25519-signed `tools-manifest.json` + `.sig` endpoint (e.g., on GitHub Releases or `https://toridownload.xyz/tools/tools-manifest.json`) configured in `ToolsManagerConfig::default().signed_manifest_url` for a future Desktop `v1.0.7` release.
2. **Public Release Not Performed:** Per Gate 32 scope, Desktop version remains `1.0.6`, Browser Companion remains `v1.0.10`, no public GitHub release or Cloudflare Pages deployment was modified, and the operator's installed production `%LOCALAPPDATA%\TORI Download Manager\` binary remains untouched at `v1.0.6`.
3. **Runtime Fix Discovered During Live QA:** `ExternalToolsManager::run_background_scheduler` was refactored to an explicit `async fn` spawned via `tauri::async_runtime::spawn` after initial isolated launch detected `tokio::spawn` inside Tauri's synchronous `.setup` hook. Re-verified cleanly across all 18 live Gate 32 checks and all 6 regression suites.
4. **Future Desktop `v1.0.7` Release Checklist:**
   - Decide & publish the official TORI Ed25519-signed `tools-manifest.json` + `.sig` endpoint for curated FFmpeg+FFprobe updates (and wire its URL into `ToolsManagerConfig::default()`).
   - Bump workspace & Tauri version to `1.0.7`, build signed NSIS installer + `.sig` + `latest.json`, run full preflight, and publish via a dedicated release gate.
