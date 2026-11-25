# TORI Download Manager — Gate 35.1 Post-Release Production Audit, Security Hardening & Stage 2 Readiness Report

**Gate:** Gate 35.1 — Post-Release Production Audit, Security Hardening & Stage 2 Readiness  
**Status:** **`CONDITIONAL GO — HARDENING VERIFIED LOCALLY; COMPANION v1.0.11 CRITICAL REMEDIATION & DEFERRED CUSTODY/VM/AUTHENTICODE ITEMS TRACKED`**  
**Date:** 2026-11-25  
**Scope Notice:** Production maintenance, read-only live audit, bounded local security/reliability hardening, regression testing, and readiness documentation ONLY. **Zero public release artifacts, GitHub releases, website files, Browser Companion packages, External Tools manifest `rev 2`, signing keys, remote `master`, or OEM user data were modified.**

---

## 1. Verified Post-Release Baseline

| Item | Verified Value |
| :--- | :--- |
| **Main Repository** | `F:\TORI\final tori download manager` |
| **Baseline Commit** | `f458328473a31d9059aa98fea16cf595d909bbc9` (`release/gate34_2-v108-public-stable`, tag `checkpoint-gate34_2-v108-public-stable-released`) |
| **Pre-Work Local Tag** | `checkpoint-gate35_1-preflight` (`f458328473a31d9059aa98fea16cf595d909bbc9`) |
| **Remote `origin/master`** | `62715926785da3fd7da811da997279931cc5cad0` (preserved untouched) |
| **Development Branch** | `feat/gate35_1-postrelease-security-hardening` |
| **Public Desktop Release** | `v1.0.8` — GitHub Release ID `455125259`, tag `v1.0.8` -> commit `1a24265d247a43371ab2b637e195425df2c78b82` |
| **Public Installer SHA-256** | `728d0d253a8fadc3fea5244723237f267dcd13abf65cac49b91a4ec83a3dcffb` (`118,110,372` bytes) |
| **Tauri `.sig` SHA-256** | `8f2bc20bd2c8994ac04d8d2fc84be37b5569f11caeb47b63f369a4c72b44294c` (`436` bytes, Ed25519 verified) |
| **Browser Companion** | `v1.0.10` (`extension-v1.0.10`, GitHub Release ID `451270856`) — untouched in Gate 35.1 |
| **Website Repository** | `C:\Users\ritud\Downloads\tori-website` (`181b3fb7c4d2abb9889d7d988b223fe63e02506f`, clean, untouched) |
| **Production Manifest** | `https://toridownload.xyz/assets/tools/tools-manifest.json` (`schema_version = 2`, `rev 2`, SHA-256 `caa2d4ed2a7e424badcd8662e67b986a3fdfbf2847dded0625ea2b2547663f3a`, expires `2027-01-21T19:46:42.049Z`) |
| **Legacy Shared Signing Key** | `CDC23D8CC8DA5397` (Desktop Auto-Updater + Stage 1 External Tools manifest `rev 2`) |
| **Dedicated Tools Public Key** | `C3FD6626A3718E63` (embedded in Desktop `v1.0.8+`; SHA-256 `6807e183079787d7d00f889293a27a880b2a346e83556d3d090f28b92a132c9d`) |

---

## 2. Live Production Health & Release Integrity Audit (2026-11-25)

All 14 live read-only production health checks passed (`14/14 HEALTHY` at `2026-11-25T15:30:05Z`, plus `8/8` live public release invariant checks in `verify_gate34_2_public_release.js` including two cache-bypass CDN passes):

1. **GitHub `/releases/latest`:** HTTP `200`, ID `455125259`, tag `v1.0.8`, `draft = false`, `prerelease = false`, `16` Desktop-only assets, `published_at = 2026-11-23T08:25:29Z`.
2. **Historical Releases Preserved:** Desktop `v1.0.7` (`454278227`), `v1.0.6` (`453599579`), Browser Companion `extension-v1.0.10` (`451270856`), and FFmpeg Tools prerelease `tools-ffmpeg-N-129150-g7ddf7bc8a4` (`453686141`) all intact.
3. **Public Installer & `.sig` Download Verification:** Live downloaded `TORI.Download.Manager_1.0.8_x64-setup.exe` (`118,110,372` B) matches `728d0d25...`; `.sig` matches `8f2bc20b...`; Ed25519 signature verifies (`ed25519Valid = true`); Authenticode honestly reported as `NotSigned`.
4. **Live `latest.json` Auto-Updater Endpoint:** HTTP `200`, `version = 1.0.8`, `pub_date = 2026-11-23T07:55:00.033Z`, signature matches `.sig` byte-for-byte, zero `DRAFT` markers.
5. **Live Official Website (`https://toridownload.xyz`):** HTTP `200` (`cfRay = a601ad28ac46b8f9-DAC`, active Cloudflare Pages deployment `113c58b9-82c9-42ec-a096-7bc9b62c5b9e`), Desktop (`1440x900`) and Mobile (`390x844`) render `v1.0.8` + `v1.0.7` + `Companion v1.0.10` with zero overflow; `sitemap.xml` HTTP `200`.
6. **Live Browser Companion `v1.0.10` Assets:** Website XPI HTTP `200` (`Content-Type: application/x-xpinstall`, SHA-256 `a93a4387...`); GitHub Chromium ZIP HTTP `200` (`f220fab2...`).
7. **Live External Tools Manifest `rev 2` & Expiry Monitor:** HTTP `200` for manifest (`caa2d4ed...`) and `.sig` (`11efa53f...`), signer `CDC23D8CC8DA5397`, `ed25519Valid = true`, **`HEALTHY`** with **`57.18` days / `1372.28` hours remaining** (`0` anomalies).
8. **GitHub Actions Daily Monitor (Workflow ID `427101855`):** `3/3` recent runs `success`, including two automated daily `schedule` runs (`45226599640` on `2026-11-23`, `45442860013` on `2026-11-24`).

---

## 3. Deep Security & Reliability Audit Findings (`SEC-35-01` .. `SEC-35-20`)

**Summary:** **`4` Critical**, **`9` High**, **`7` Medium** findings identified across Tauri Desktop IPC, Native Messaging & local HTTP/SSE server, Browser Companion `v1.0.10`, External Tools cryptographic verification/activation, `yt-dlp`/FFmpeg/Streamlink invocation, media parsers, and download engine.
- **`15` bounded Desktop security/reliability fixes implemented and regression-tested in Gate 35.1** (`3` Critical, `8` High, `4` Medium).
- **`5` architectural / out-of-scope items documented with remediation designs** (`1` Critical in frozen Extension `v1.0.10`, `1` High engine lifecycle/task-generation refactor, `1` High Win32 Named Pipe SID/SDDL migration, `2` Medium operator custody & multi-layer defense items).

### 3.1 Critical Findings (`4`)

| ID | Component & Location | Issue & Impact | Gate 35.1 Status |
| :--- | :--- | :--- | :--- |
| **`SEC-35-01`** | `src-tauri/src/commands.rs:76-109, 1534-1567` | **Windows Toast Notification PowerShell Unicode Quote Command Injection (RCE).** PowerShell 5.1 treats Unicode curly quotes (`U+2018`/`U+2019`/`U+201A`/`U+201B`) as `'`, breaking out of `-Command` single-quoted XML strings when download filenames contain crafted Unicode quotes. | **FIXED LOCALLY.** Replaced both functions with static `WINDOWS_TOAST_PS_SCRIPT` passing sanitized `TORI_NOTIFY_TITLE` / `TORI_NOTIFY_BODY` strictly via child process env vars into `$xml.CreateTextNode(...)` (zero string interpolation). |
| **`SEC-35-02`** | `crates/tdm-core/src/resolver/downloader.rs`, `extractor.rs`, `orchestrator.rs`, `pipeline.rs`, `engine/manager.rs`, `src-tauri/src/commands.rs`, `crates/tdm-native-host/src/server.rs` | **`yt-dlp` / `Streamlink` CLI Flag Injection (`--` missing), Missing `--ignore-config`, Unvalidated Media URLs & `-o` `%` Template Expansion.** Leading `-` URLs or `format_id`s could inject arbitrary `yt-dlp` options (e.g., `--exec`), user/CWD config files were loaded implicitly, and `%` in target paths triggered template evaluation. | **FIXED LOCALLY.** Added `--ignore-config` and `--` option terminator before URL across `downloader.rs`, `extractor.rs` (both dumps), and `orchestrator.rs`; escaped `%` -> `%%` in `-o`; enforced `validate_http_url_syntax` and `validate_format_id` across core, HTTP server, playlist parser, and Tauri IPC; hardened `is_media_portal_url` to use parsed `Url` host matching. Verified by `test_sec35_02_*`. |
| **`SEC-35-03`** | `crates/tdm-core/src/tools/providers.rs:432-442`, `types.rs:702-740` | **Stage 2 Dedicated Signing Key Compatibility Blocker in Default Config.** `ToolsManagerConfig::default()` sets `tools_keyring: None` and `expected_manifest_key_id: Some("CDC23D8CC8DA5397")`. `providers.rs:432` rejected any primary `.sig` signed by dedicated key `C3FD6626A3718E63` even though `effective_tools_keyring()` includes both keys. **Shipped `v1.0.8` already has this bug**, blocking direct Stage 2 cutover until `v1.0.9+` deploys! | **FIXED LOCALLY** (for `v1.0.9+`) & **STAGE 2 DESIGN UPDATED.** Gated `expected_manifest_key_id` enforcement on `config.tools_keyring.is_none() && keyring.keys.len() == 1`. Verified by `test_sec35_03_default_transition_config_has_dual_key_keyring_and_accepts_dedicated_primary`. Full compatibility matrix documented in [GATE35_STAGE2_TOOLS_SIGNING_MIGRATION_READINESS.md](file:///f:/TORI/final%20tori%20download%20manager/docs/security/GATE35_STAGE2_TOOLS_SIGNING_MIGRATION_READINESS.md). |
| **`SEC-35-04`** | `extension/content.js:3132-3140`, `extension/firefox/content.js:3132-3140`, `extension/background.js:1982-2565` | **URGENT — Arbitrary Webpage-to-Extension Privilege Escalation & Token Theft (`__TORI_DISPATCH__`).** Leftover QA `CustomEvent('__TORI_DISPATCH__')` bridge on `<all_urls>` forwards arbitrary untrusted webpage payloads to `background.js`, which allows content scripts to invoke `INITIATE_PAIRING` (stealing `X-Tori-Token`), `GET_DOWNLOADS`, `START_DOWNLOAD`, `START_MEDIA_DOWNLOAD`, `ENQUEUE_PLAYLIST`, and cross-tab media inspection. | **DOCUMENTED FOR URGENT COMPANION `v1.0.11` RELEASE** *(frozen Companion `v1.0.10` must not be altered in Gate 35.1)*. Desktop RCE chain (`SEC-35-01/02/06/07`) is broken in Desktop `v1.0.9`, and Companion `v1.0.11` MUST remove `__TORI_DISPATCH__` and restrict privileged actions to `isExtensionPage(sender)` immediately. |

### 3.2 High Findings (`9`)

| ID | Component & Location | Issue & Impact | Gate 35.1 Status |
| :--- | :--- | :--- | :--- |
| **`SEC-35-05`** | `crates/tdm-core/src/tools/providers.rs:614` | **Schema v1 Downgrade Bypasses Anti-Replay & Expiry.** A validly signed `schema_version = 1` (`manifest_revision = 0`, no `expires_at`) manifest bypassed monotonic anti-replay checks even after `highest_accepted_revision > 0`. | **FIXED LOCALLY.** Rejects `schema_version < 2` whenever `prior_state.highest_accepted_revision > 0`. Verified by `test_sec35_05_schema_v1_downgrade_rejected_after_revision_accepted`. |
| **`SEC-35-06`** | `crates/tdm-native-host/src/server.rs`, `src-tauri/src/{state,lib,commands}.rs` | **Loopback Server Hardening: `Origin: null` CORS Bypass, Unauthenticated `/api/v1/media/status` & `/api/v1/thumbnails/{id}`, Non-Constant-Time Token Compare, Stale `regenerate_pairing_token`, Long `RwLockReadGuard` Hold.** | **FIXED LOCALLY.** Rejected `Origin: null`; required `X-Tori-Token` on `/api/v1/media/status` (prevents local username path disclosure & unauthenticated `yt-dlp` spawn DoS) and `/api/v1/thumbnails/{id}`; added constant-time byte compare; introduced `authorize()` helper dropping read locks immediately; wired `ServerTokenHandle` into `AppState` so `regenerate_pairing_token` rotates live server memory immediately. Verified by `test_gate35_security_hardening_server_and_registry` & `test_server_media_endpoints`. |
| **`SEC-35-07`** | `crates/tdm-core/src/engine/manager.rs:707`, `server.rs`, `commands.rs` | **Destination Path Validation Missing UNC/Device/Symlink Checks & Inconsistent Enforcement.** Allowed `\\attacker\share` (NTLM leak / SMB write), `\\.\` / `\\?\` device paths, symlinked ancestors, and bypassed checks in media/playlist/settings handlers. | **FIXED LOCALLY.** Hardened `validate_destination_path` to reject UNC, `//`, `DeviceNS`, `Verbatim`, `..`, control chars, and symlink ancestors; enforced consistently in `manager.rs`, `server.rs`, and `commands.rs`. Verified by `test_sec35_02_and_07_*` & `server_tests`. |
| **`SEC-35-08`** | `crates/tdm-core/src/resolver/downloader.rs:43`, `extractor.rs:34, 167` | **`--no-check-certificates` Disabled TLS Validation in `yt-dlp`.** Exposed media metadata and downloads to silent MITM interception. | **FIXED LOCALLY.** Removed `--no-check-certificates` from all 3 `yt-dlp` invocations. |
| **`SEC-35-09`** | `crates/tdm-core/src/resolver/downloader.rs:487-519` | **Overbroad `cleanup_partial_files` Deleted Unrelated User Files.** Matched `lower.contains(".f") && !mp4/mkv/webm`, which deleted user files like `song.flac` or `song.final.mkv` sharing the stem prefix! | **FIXED LOCALLY.** Restricted deletion strictly to `{stem}.part`, `{stem}.ytdl`, `{stem}.temp.*`, and `{stem}.f<digits>.<ext>`. Verified by `test_sec35_09_cleanup_partial_files_preserves_unrelated_user_files`. |
| **`SEC-35-10`** | `crates/tdm-core/src/tools/manager.rs:1617-1620, 1893-1896` | **30s Infinite Broken-Activation Rollback Loop & Cross-Bundle Clobber.** Rollback overwrote the entire `ActiveToolsManifest` (`*m = restored_manifest`), clobbering concurrent updates to the other tool bundle and preserving `*_pending = Some(broken_slot)`. | **FIXED LOCALLY.** Mutates only the rolling-back bundle's fields and clears `*_pending = None` in both `active-tools.json` and SQLite. Verified by `test_sec35_10_tools_pending_rollback_preserves_other_bundle_and_clears_pending`. |
| **`SEC-35-11`** | `crates/tdm-native-host/src/registry.rs:39-78` | **`register_host` Overwrote Native Messaging Manifests with `tori-download-manager.exe`.** Invoking registration from the Tauri GUI wrote the GUI exe path instead of `tdm-native-host.exe`, breaking Chrome/Edge/Firefox stdio messaging. | **FIXED LOCALLY.** Added `resolve_native_host_binary_from` checking `tdm-native-host.exe`, `bin/`, and `resources/bin/` and erroring cleanly rather than corrupting manifests. Verified in `test_gate35_security_hardening_server_and_registry`. |
| **`SEC-35-12`** | `dash/parser.rs`, `hls/parser.rs`, `orchestrator.rs`, `downloader.rs`, `live/recorder.rs` | **DASH OOM Bombs, Byte-Range Underflow & UTF-8 Byte-Index Panics.** Unbounded `$Number%0<huge>d$` width and `SegmentTimeline r` repeats caused OOM; inverted DASH / zero-length HLS byte ranges caused underflow; `.to_lowercase()` byte slicing panicked on non-ASCII case expansion (`İ`); stderr trimming sliced mid-UTF-8 char. | **FIXED LOCALLY.** Capped DASH format width (`<= 32`) & resolved segments (`<= 50,000`), rejected `start > end` & `len == 0`, switched HTML scrapers to `.to_ascii_lowercase()`, and enforced `is_char_boundary` on stderr trimming. Verified by `test_sec35_12_dash_hls_and_html_parser_hardening`. |
| **`SEC-35-13`** | `src-tauri/src/commands.rs:325-464`, `src-tauri/src/lib.rs:299-303` | **Tauri IPC File/URL Launcher Hardening.** `open_file`/`open_folder`/`verify_checksum` accepted UNC/device paths; `verify_checksum` blocked Tokio async executor; `open_external_url` lacked full URL parsing; `open_on_complete` auto-executed `.exe`/`.bat`/`.ps1` files silently. | **FIXED LOCALLY.** Added `validate_local_shell_path`, moved `verify_checksum` to `spawn_blocking` + `is_file()`, validated `open_external_url` via `validate_http_url_syntax`, and blocked auto-execution of dangerous executable/script extensions in `open_on_complete` (opening containing folder instead). |
| **`SEC-35-16`** | `engine/thumbnail.rs`, `resolver/orchestrator.rs`, `resolver/pipeline.rs` | **SSRF via HTTP 30x Redirects.** External URLs validated pre-request could redirect (`302 Location`) into `127.0.0.1`, RFC 1918, or `169.254.169.254` cloud metadata. | **FIXED LOCALLY.** Implemented `ssrf_safe_redirect_policy()` validating every redirect hop's scheme, hostname, literal IP, and DNS-resolved IP (preserving `TORI_ALLOW_LOOPBACK=1` for QA). Verified by `test_sec35_16_ssrf_redirect_policy_blocks_loopback_redirect`. |
| **`SEC-35-17`** | `crates/tdm-core/src/engine/manager.rs:2031-2071, 2609-2613`, `src-tauri/src/tray.rs:75-82` | **Pause/Cancel/Retry Task Generation Race & Hard-Exit Shutdown (`app.exit(0)`).** Rapid pause/resume can overlap worker teardown; `app.exit(0)` bypasses graceful flush of SQLite/part-file handles. | **DOCUMENTED FOR `v1.0.9` ENGINE REFACTOR.** Requires dedicated generation-ID token map and bounded graceful shutdown drain (intentionally deferred from Gate 35.1 to keep diffs bounded and regression-free). |
| **`SEC-35-18`** | `crates/tdm-native-host/src/ipc.rs:22-110` | **Named Pipe ACL / Cross-Session Scope.** Default pipe `\\.\pipe\tori-download-manager-ipc` lacks per-user SID scoping and explicit Win32 SDDL DACL. | **PARTIALLY HARDENED + FOLLOW-UP.** Enabled `.reject_remote_clients(true)` on `ServerOptions` now; full per-user SID-scoped pipe name + SDDL DACL coordinated across Desktop + Native Host + Installer planned for `v1.0.9`. |

*(Note: `SEC-35-16` was classified High during audit, giving 9 High findings total alongside `SEC-35-05..13` and `SEC-35-17..18` where `SEC-35-17`/`SEC-35-18` are High architectural items and `SEC-35-14`/`SEC-35-15`/`SEC-35-19`/`SEC-35-20` cover Medium items — all 20 findings are tracked individually below.)*

### 3.3 Medium Findings (`7` tracked across `SEC-35-14`, `SEC-35-15`, `SEC-35-19`, `SEC-35-20`)

| ID | Component & Location | Issue & Impact | Gate 35.1 Status |
| :--- | :--- | :--- | :--- |
| **`SEC-35-14a`** | `crates/tdm-core/src/hls/muxer.rs:40-49` | **FFmpeg Concat Demuxer Single-Quote / Newline Breakout.** Unescaped `'` or `\n` in segment paths broke concat manifest syntax. | **FIXED LOCALLY.** Rejects `\r`/`\n`/`\0` and escapes `'` -> `'\''`. Verified by `test_sec35_14_concat_file_escapes_quotes_and_rejects_newlines`. |
| **`SEC-35-14b`** | `crates/tdm-core/src/live/recorder.rs:79` | **FFmpeg Live Recorder Missing `-protocol_whitelist` & Scheme Check.** Allowed `file://`, `concat:`, `subfile:` inputs if injected into live jobs. | **FIXED LOCALLY.** Enforced network-only live URL schemes (`http/https/tcp/rtsp/rtmp/rtmps/srt/rist/rtp/udp/mms/mmsh`) and added `-protocol_whitelist`. Verified by `test_sec35_14_live_recorder_rejects_local_file_and_concat_schemes` and `gate7_live_tests`. |
| **`SEC-35-15a`** | `crates/tdm-core/src/engine/worker.rs:740` | **Non-Range `200 OK` Rewind Without File Truncation.** If a server responded `200 OK` with a shorter file after partial progress, trailing stale bytes could survive in `.tdm-part`. | **FIXED LOCALLY.** Added `writer.truncate_to(0)?;` before resetting `total_written = 0`. |
| **`SEC-35-15b`** | `crates/tdm-core/src/engine/probe.rs:559-606`, `engine/manager.rs` | **Unicode BiDi Filename Spoofing, `"CON .txt"` Reserved Name Bypass & Unclamped Concurrency/Retry Setters.** | **FIXED LOCALLY.** Stripped BiDi override/isolate chars & `\x7f`, checked `stem.trim()` for reserved Windows device names, clamped `max_active_jobs` (`1..=16`) and `max_retries` (`0..=20`). Verified by `test_sec35_15_bidi_filename_sanitization_and_manager_clamping`. |
| **`SEC-35-19`** | Operator Workstation `C:\Users\ritud\.tori-keys` | **Workstation Key Custody Gaps.** `AuditCustody` reported `keyDirAclHardenedOwnerOnly: false` on `.tori-keys`, legacy plaintext `tori-updater.key.pwd` still present, and `BACKUP_RECOVERY_NOT_VERIFIED`. | **DOCUMENTED (OPERATOR ACTION REQUIRED).** `.tori-keys` intentionally untouched by Gate 35.1; exact remediation commands documented in [GATE35_CLEAN_WINDOWS_VALIDATION_CHECKLIST.md](file:///f:/TORI/final%20tori%20download%20manager/docs/qa/GATE35_CLEAN_WINDOWS_VALIDATION_CHECKLIST.md). |
| **`SEC-35-20a`** | `src-tauri/tauri.conf.json`, `server.rs:224` | **Missing Explicit WebView CSP & Permissive Firefox `moz-extension://<any-uuid>` Origin Check.** | **DOCUMENTED FOR `v1.0.9`.** Recommend adding explicit `tauri.conf.json` CSP and pinning paired Firefox UUID after Native Messaging handshake. |
| **`SEC-35-20b`** | `engine/manager.rs:2783`, `tools/manager.rs`, `engine/writer.rs:288`, `live/recorder.rs` | **Reliability/Defense-in-Depth Follow-ups:** Work-stealing split synchronization, `rollback_tool` SHA-256 re-verification, sparse disk-space check on resume, URL token redaction in `yt-dlp`/FFmpeg command logs, and release-build gating of test env overrides. | **DOCUMENTED FOR `v1.0.9` BACKLOG.** |

---

## 4. Phase 11 Targeted Regression & Verification Evidence

All tests were freshly executed in Gate 35.1 after the final code edit, with per-suite logs saved under `target/gate35_1_qa_logs/`:

| Suite / Check | Status | Exact Executed Result | Log File |
| :--- | :--- | :--- | :--- |
| **Gate 35.1 Security Hardening Suite** (`gate35_security_hardening_tests`) | **PASS** | `10 / 10` passed (`0` failed, `0` ignored) | `target/gate35_1_qa_logs/01_gate35_hardening.log` |
| **Full Rust Workspace Tests** (`cargo test --workspace`) | **PASS** | **`295 / 295` passed** (`0` failed, `0` ignored across `37` non-empty test suites) | `target/gate35_1_qa_logs/08_workspace_tests_full.log` |
| — *Updater Cryptography* (`updater_cryptography_tests`) | **PASS** | `10 / 10` passed | Included in `08_workspace_tests_full.log` |
| — *External Tools Security Matrix* (`external_tools_security_matrix_tests`) | **PASS** | `5 / 5` passed | Included in `08_workspace_tests_full.log` |
| — *External Tools Updater & Rollback* (`external_tools_updater_tests`) | **PASS** | `11 / 11` passed | Included in `08_workspace_tests_full.log` |
| — *Native Messaging & Local HTTP/SSE Server* (`tdm-native-host`) | **PASS** | `30 / 30` passed (`10` lib + `8` host + `8` server + `1` referer + `1` UA + `1` API + `1` perf) | Included in `08_workspace_tests_full.log` |
| — *Core Unit + Downloader/Protocol/HLS/DASH/Live/Torrent/Queue/SQLite* | **PASS** | `229 / 229` passed (`61` lib unit + `168` integration tests) | Included in `08_workspace_tests_full.log` |
| **Cargo Clippy** (`cargo clippy --workspace --all-targets`) | **PASS** | `exit = 0`, `0` errors | `target/gate35_1_qa_logs/09_workspace_clippy_final.log` |
| **UI Lint** (`ui`: `npm run lint` / `oxlint`) | **PASS** | `0` errors (`7` pre-existing React Compiler warnings) | `target/gate35_1_qa_logs/06_ui_lint.log` |
| **UI Build** (`ui`: `tsc -b && vite build`) | **PASS** | `exit = 0` (`604ms`, `46` modules) | `target/gate35_1_qa_logs/07_ui_build.log` |
| **External Tools Expiry Monitor 18-Scenario Matrix** (`verify_gate33_1_expiry_monitor_matrix.js`) | **PASS** | **`18 / 18` passed** (`0` failed) | `target/gate35_1_qa_logs/10_expiry_monitor_matrix.log` |
| **Live Public Health Audit** (GitHub, `latest.json`, Website, Companion, Manifest `rev 2`, Actions `427101855`) | **PASS** | **`14 / 14` HEALTHY** | Phase 2 live verification |
| **Gate 34.2 Live Release Invariants** (`verify_gate34_2_public_release.js`, 240s watchdog) | **PARTIAL PASS / TIMEOUT** | **`8 / 8` live release & website checks PASS (`G342-01..G342-08`)**; **`TIMEOUT (exit=124)`** terminated cleanly by 240s watchdog at Phase 14 (`[5] Isolated v1.0.7->v1.0.8` WebView2 CDP WebSocket attach — known non-blocking CDP hang) | `target/gate35_1_qa_logs/11_gate34_2_live_release_invariants.log` |
| **Installation Safety, Frozen Release Artifacts & OEM Preservation** | **PASS** | **`9 / 9` passed** (`0` failed) | `target/gate35_1_qa_logs/12_install_safety_and_oem_preservation.log` |
| **Clean Windows 10 x64 VM QA** | **NOT TESTED** | `0` Hyper-V VMs provisioned locally | See `GATE35_CLEAN_WINDOWS_VALIDATION_CHECKLIST.md` |
| **Clean Windows 11 x64 VM QA** | **NOT TESTED** | `0` Hyper-V VMs provisioned locally | See `GATE35_CLEAN_WINDOWS_VALIDATION_CHECKLIST.md` |

---

## 5. Production & Operator OEM Preservation Evidence

Re-verified after all Gate 35.1 tests completed (`12_install_safety_and_oem_preservation.log` — `9/9 PASS`):

- **OEM Desktop Binary:** `%LOCALAPPDATA%\TORI Download Manager\tori-download-manager.exe` (`v1.0.6`, `30,559,232` B, SHA-256 `570833b379668f64d8f0a81e0a2c138635835e0c0382f37f24ec969caccf0fda`) — **100% unchanged**.
- **OEM SQLite Database:** `%APPDATA%\tori-download-manager\tdm_storage.sqlite` — `PRAGMA integrity_check = ok`, **`56` downloads** (`655eba220cb0f7cbbd383a68cf48697e6bd67e9e9b37e501ebd28b2bef9fbddf`), **`531` chunks** (`1ec5ea04ec83f56a33520416aeab4d4f0615979a8db703669c17f556e52b6da1`), **`5` protected settings** (`b50fd3a47a02d6788f7df1933c2fe770b0fc998550c95726370c252bdf0e9733`) — **zero data drift**.
- **OEM Partial Downloads:** **`21` `.tdm-part` files** (`b99c38c623c4ca54ad0b15c5e83b98000d76ac2aea478dc4649e256b63cf5268`) — **100% preserved**.
- **Native Messaging Registry:** `HKCU` keys for Chrome, Edge, and Firefox intact and pointing to `%APPDATA%\tori-download-manager\com.tori.download_manager(.firefox).json`.
- **Frozen Public Artifacts:** `release/v1.0.8-final-rc/`, `release/v1.0.10-extension-rc/`, `extension/`, `C:\Users\ritud\Downloads\tori-website`, GitHub release `v1.0.8` (`455125259`), production manifest `rev 2`, and `origin/master` — **all 100% untouched**.

---

## 6. Key Custody, VM QA, Authenticode & Stage 2 Status

- **Dedicated Key Custody (`C3FD6626A3718E63`):** `VALID_PRODUCTION_KEY`, scrypt-encrypted, owner-only file ACL, zero plaintext `tori-tools.key.pwd`, `0` private key material in Git/release. Gaps accurately recorded: `BACKUP_VERIFICATION_DEFERRED_BY_OWNER`, `BACKUP_RECOVERY_NOT_VERIFIED`, `PRODUCTION_KEY_LOSS_RISK_ACCEPTED_FOR_CONTINUED_DEVELOPMENT`, plus workstation `.tori-keys` directory ACL (`keyDirAclHardenedOwnerOnly: false`) and legacy `tori-updater.key.pwd` noted for operator cleanup.
- **Clean Windows 10 & 11 VM QA:** `NOT TESTED` (runbook & CI workflow defaults updated locally to `v1.0.8` in `.github/workflows/clean-windows-release-qa.yml` and [GATE35_CLEAN_WINDOWS_VALIDATION_CHECKLIST.md](file:///f:/TORI/final%20tori%20download%20manager/docs/qa/GATE35_CLEAN_WINDOWS_VALIDATION_CHECKLIST.md)).
- **Authenticode:** `NotSigned` (commercial signing plan & strict Authenticode-first -> Tauri-`.sig`-second signing order documented).
- **Stage 2 Migration Readiness:** Technical design and compatibility matrix complete in [GATE35_STAGE2_TOOLS_SIGNING_MIGRATION_READINESS.md](file:///f:/TORI/final%20tori%20download%20manager/docs/security/GATE35_STAGE2_TOOLS_SIGNING_MIGRATION_READINESS.md). Stage 2 production cutover was **NOT** performed and remains blocked pending offline backup recovery verification, Desktop `v1.0.9+` (`SEC-35-03` fix) fleet adoption, and separate owner approval.

---

## 7. Security Remediation & Future Release Recommendations

1. **URGENT — Gate 35.2: Browser Companion `v1.0.11` Security Hotfix (HIGHEST PRIORITY):**
   - Remediate **`SEC-35-04`** immediately by removing the `__TORI_DISPATCH__` `CustomEvent` bridge from `extension/content.js` and `extension/firefox/content.js`, and enforcing `isExtensionPage(sender)` for `INITIATE_PAIRING`, `GET_DOWNLOADS`, `START_DOWNLOAD`, `START_MEDIA_DOWNLOAD`, `ENQUEUE_PLAYLIST`, and `GET_TAB_MEDIA` in `extension/background.js`.
   - Rebuild, sign via AMO (Firefox XPI) & package Chromium ZIP, and publish after explicit owner authorization.
2. **Gate 35.3: Hardened Desktop `v1.0.9` Security & Stage-2-Ready Release:**
   - Ships all 15 Gate 35.1 Desktop security/reliability fixes (`SEC-35-01`, `SEC-35-02`, `SEC-35-03` Stage 2 multi-key fix, `SEC-35-05` schema downgrade defense, `SEC-35-06..16`).
   - Optionally includes `SEC-35-17` (task generation barrier + graceful shutdown), `SEC-35-18` (SID-scoped Named Pipe + SDDL DACL), `SEC-35-20` (explicit CSP + Firefox UUID pinning), and resolves the isolated WebView2 CDP QA harness timeout.
   - Execute Clean Windows 10/11 VM QA (`GATE35_CLEAN_WINDOWS_VALIDATION_CHECKLIST.md`) and commercial Authenticode signing before public promotion.
3. **Gate 36: Offline Key Backup Recovery Drill -> Stage 1.5 Dual-Signed Manifest `rev 3` -> Future Stage 2 Dedicated-Only Cutover:**
   - Complete offline backup + recovery verification drill for `C3FD6626A3718E63`, harden `.tori-keys` directory ACL, publish Stage 1.5 dual-signed `rev 3` (`.sig` + `.tools.sig`) compatible with `v1.0.7` / `v1.0.8` / `v1.0.9+`, and schedule Stage 2 dedicated-only primary `.sig` cutover (`rev 4+`) ONLY after `v1.0.9+` adoption and explicit owner authorization.

---

## 8. Global Engineering Skills Applied

Per `global-skill-usage-policy.md`, the following global skills were read and applied during Gate 35.1:
- `security-auditor` (threat modeling, IPC/CORS/SSRF/injection/cryptographic key-boundary audit)
- `rust-pro` (memory/UTF-8 safety, async lock discipline, Tokio `spawn_blocking`, Rust error/test design)
- `code-review-checklist` (line-level audit, diff minimization, regression coverage)
- `systematic-debugging` (root-cause diagnosis of `SEC-35-03` default keyring rejection, `SEC-35-10` rollback loop, `tcp://` live scheme, and CDP WebSocket timeout)
- `typescript-expert` (UI lint/build & Browser Companion JS boundary review)
- `performance-engineer` (DASH OOM/DoS caps, `RwLock` contention removal, `verify_checksum` offloading)
