# TORI Download Manager — Gate 31.5 Report
## Installed Version Repair & Desktop v1.0.6 Release Preflight

**Report Date:** 2026-11-21  
**Branch:** `fix/gate27-runtime-fixes`  
**Baseline Pre-Repair Checkpoint:** `04d06fb` (`checkpoint-gate31_4-verified`, `checkpoint-gate31_5-before-install-repair`)  
**Target Desktop RC:** `v1.0.6` (Local Unpublished Staging — `release/v1.0.6-rc/`)  
**Public Baseline Preserved:** Desktop `v1.0.5` | Browser Companion `v1.0.10`  
**Final Gate Status:** **`CONDITIONAL GO — DOCUMENTED LIMITATIONS`**  
**Public Release Status:** **`NOT PERFORMED`** (no GitHub push/release, no `latest.json` change, no website deploy, no Companion repackage)

---

## 1. Executive Summary

During Gate 31.4, the operator's Windows workstation continued showing the legacy dark floating download toast even after reinstalling public Desktop `v1.0.5`. Gate 31.5 executed a controlled forensic audit, full rollback backup, production installation repair, installer/QA hardening, end-to-end acceptance on the repaired production binary, full regression verification, and Desktop `v1.0.6` release preflight.

- **Installed Production Repair:** The stale `v1.0.4` executable at `%LOCALAPPDATA%\TORI Download Manager\tori-download-manager.exe` was cleanly upgraded via the verified NSIS `v1.0.6` RC installer (`TORI Download Manager_1.0.6_x64-setup.exe /P`) into `%LOCALAPPDATA%\TORI Download Manager\`.
- **Registry, Shortcuts & Native Messaging Repaired:** `HKCU\Software\tori\TORI Download Manager`, `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\TORI Download Manager` (`DisplayVersion = 1.0.6`), Chrome/Edge/Firefox `NativeMessagingHosts\com.tori.download_manager`, `%APPDATA%\tori-download-manager\com.tori.download_manager(.firefox).json`, OneDrive Desktop shortcut, and Start Menu shortcut all point cleanly to `%LOCALAPPDATA%\TORI Download Manager\`, with **0** stale `%TEMP%` or `_qa` references remaining.
- **Root Causes Eliminated in Code & QA Tooling:**
  1. `src-tauri/nsis/hooks.nsh` (`NSIS_HOOK_PREINSTALL`) now automatically detects and redirects stale `\temp\` / `_qa` paths saved in `HKCU\Software\tori\TORI Download Manager` back to `$LOCALAPPDATA\${PRODUCTNAME}` on non-silent installs (GUI and Tauri `/P /UPDATE`) and removes any empty stale leaf directory.
  2. `src-tauri/nsis/hooks.nsh` (`NSIS_HOOK_POSTINSTALL`) terminates any lingering `tori-download-manager.exe` instance respawned by browser Native Messaging during installation so the upgraded `v1.0.6` launches cleanly as primary instance without `SECONDARY_INSTANCE` exit conflicts.
  3. `scripts/lib/qa_oem_state_guard.js` now enforces fail-closed, out-of-tree (`target/_oem_state_backups/`) host-state backup, restoration, and post-restore parity verification across Gate 29.4, Gate 31.4, and Gate 31.5 QA harnesses.
- **100% User Data Preservation:** Production `%APPDATA%\tori-download-manager\tdm_storage.sqlite` passed `PRAGMA integrity_check = ok` with all **42 downloads** (`29 completed`, `11 failed`, `2 paused`), exact operator settings (`theme=dark`, `accent=rose`, `showDownloadPopup=always`, `alwaysOnTop=true`, `closeToTray=true`, `port=6800`), and all **11 `.tdm-part` partial files** verified bit-for-bit unchanged.
- **All 10 Regression & Acceptance Suites Passed (0 Failures, 0 Timeouts):** Rust workspace (`252/252`), Ed25519 updater cryptography (`7/7`), UI build & lint (`0` errors), Gate 31.5 installed `v1.0.6` & Companion `v1.0.10` (`23/23`), Gate 31.4 (`15/15`), Gate 29.2 (`17/17`), Gate 29.1 (`20/20`), Gate 29.4 (`18/18`), and live public baseline preservation Gate 31.3 (`23/23`).

---

## 2. Root Cause Confirmation

Forensic inspection of the host Windows registry, installed directories, and historical QA scripts confirmed a **three-part causal chain**:

1. **Stale Production Binary (`v1.0.4`) Left Behind by Polluted Registry Path:**
   - During an earlier isolated installer QA run (Gate 30.2), running the NSIS installer with `/S /D=%TEMP%\tori_g30_2_install_qa\desktop_install` overwrote `HKCU\Software\tori\TORI Download Manager` to point at `%TEMP%\tori_g30_2_install_qa\desktop_install`.
   - Because Tauri's generated NSIS template (`RestorePreviousInstallLocation`) reads `HKCU\Software\tori\TORI Download Manager` on subsequent non-silent installs, reinstalling Desktop `v1.0.5` updated the temporary QA folder (`v1.0.5`, `30,723,072` B, `mtime 2026-11-21 13:55:33`) instead of `%LOCALAPPDATA%\TORI Download Manager\`, which remained stuck on `v1.0.4` (`30,163,456` B, pre-Gate 29.2 legacy dark floating toast).
2. **Self-Destructive QA Backup Ordering (Explaining Absent Keys at Phase 1 Start):**
   - Earlier inline `backupOemState()` helpers in `scripts/verify_gate31_4_toast_replacement.js` and `scripts/verify_gate29_4_final_integration.js` saved `uninstall.reg` and `manu.reg` inside `QA_ROOT/oem_backup`. When `verify_gate31_4_toast_replacement.js` subsequently executed `fs.rmSync(QA_ROOT, { recursive: true, force: true })`, it deleted its own backup `.reg` files; `restoreOemState()` then treated the missing `.reg` files as absent and ran `reg delete` on both `HKCU\Software\tori\TORI Download Manager` and `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\TORI Download Manager`.
3. **Browser Native Messaging Auto-Respawn & Single-Instance Conflict:**
   - Live browser sessions (Chrome/Edge/Firefox) invoke `tdm-native-host.exe`, which could respawn the old `v1.0.4` Desktop binary during installer execution, causing the newly launched upgraded binary to hit `SECONDARY_INSTANCE` and exit immediately while the stale `v1.0.4` stayed active in the tray.

---

## 3. Phase 0 Safety Checkpoint & Rollback Backup Inventory

Before any host modification occurred:
- **Git Checkpoint:** Local annotated tag `checkpoint-gate31_5-before-install-repair` created at commit `04d06fb2a53a4e027973b5f4174d971ba25e8a43` on branch `fix/gate27-runtime-fixes` (clean working tree).
- **Backup Location:** `target/gate31_5_rollback_backup/`
  - `localappdata_v104/`: Complete copy of pre-repair `%LOCALAPPDATA%\TORI Download Manager\` (`v1.0.4`).
  - `appdata/`:
    - `tdm_storage.sqlite` (`2,715,648` B, SHA-256 `4e0617618bc4456bfc4bf13c3ab3c60f9ac8bba898de59fcadb7f4baf3b5da92`)
    - `tdm_storage.sqlite-wal` (`4,148,872` B, SHA-256 `f3298b62344ffeee2a64769fcb397897f90eae57ca48dfb41e5b4b439984c648`)
    - `tdm_storage.sqlite-shm` (`32,768` B)
    - `tdm_storage.online_backup.sqlite` (`2,715,648` B, consistent SQLite online backup, `PRAGMA integrity_check = ok`, SHA-256 `62683a44f41b2ed7f18078650aecaa9ad2df97ee0303e46849353ec65b2831f2`)
    - `com.tori.download_manager.json` (SHA-256 `436048ee3155699379e14923be40dfd9f47269f1f424e12bc8cafc0770ad12d7`)
    - `com.tori.download_manager.firefox.json` (SHA-256 `823e6a5cfca6f29305300a64694ffbd94e9f5398e425b553db92e863628d7417`)
  - `registry/`: `nm_chrome.reg`, `nm_edge.reg`, `nm_firefox.reg` (verified `HKCU\Software\tori\TORI Download Manager` and `Uninstall\TORI Download Manager` were absent at Phase 0 start).
  - `before_snapshot.json`: Exact snapshot of all `42` download rows, `app_settings`, and sizes + SHA-256 hashes of all `11` `.tdm-part` partial files.

---

## 4. Phase 1 Forensic Audit — Before vs. After Repair

| Forensic Dimension | Before Repair (Phase 1) | After Repair (Post-Phase 4 & Phase 7) |
|---|---|---|
| **Production Install Dir** | `C:\Users\ritud\AppData\Local\TORI Download Manager\` | `C:\Users\ritud\AppData\Local\TORI Download Manager\` |
| **Installed Desktop PE Version** | **`1.0.4`** (stale, legacy toast) | **`1.0.6`** (hardened RC, IDM progress window) |
| **Installed Desktop Exe Size** | `30,163,456` B | `30,559,232` B |
| **Installed Desktop Exe SHA-256** | `dd1faf8aba7fe1d8ffc2ee36b8fd5c899b6cbed3e139d0fbd6aa2b5ed2d4cf56` | `570833b379668f64d8f0a81e0a2c138635835e0c0382f37f24ec969caccf0fda` |
| **Diff vs. Standalone RC Exe** | N/A (`v1.0.4` vs `v1.0.6`) | Exact **3-byte** Tauri NSIS bundle patch (`_UNK` → `_NSS`) |
| **Installed `uninstall.exe` Ver** | `1.0.4` | **`1.0.6`** |
| **Installed `tdm-native-host.exe`** | `17,160,704` B (`v1.0.4`, SHA-256 `21f4e50f...`) | `19,397,632` B (`v1.0.6`, SHA-256 `d02da8be8056cd987bd4b5cdca9535a016f60bcb7cbed94fb43d56c042967671`, exact RC match) |
| **Installed `tdm-cli.exe`** | `16,964,608` B (`v1.0.4`, SHA-256 `e62aa50d...`) | `17,067,008` B (`v1.0.6`, SHA-256 `2d8286a091caed95979893a1c2e7941163a8acf417d916d01bf31d6b72f58e76`, exact RC match) |
| **Bundled `ffmpeg` / `ffprobe` / `yt-dlp`** | Present | Present — 100% SHA-256 match vs. `resources/bin/` |
| **`HKCU\Software\tori\TORI Download Manager`** | `<ABSENT>` (previously redirected to `%TEMP%\tori_g30_2_install_qa\desktop_install`) | `C:\Users\ritud\AppData\Local\TORI Download Manager` (`Installer Language = 1033`) |
| **`HKCU\...\Uninstall\TORI Download Manager`** | `<ABSENT>` | `DisplayVersion = 1.0.6`, `InstallLocation = "C:\Users\ritud\AppData\Local\TORI Download Manager"`, `UninstallString = "...\uninstall.exe"`, `DisplayIcon = "...\tori-download-manager.exe"` |
| **Chrome / Edge / Firefox NativeMessagingHosts** | Pointed to `%APPDATA%` JSONs → `v1.0.4` `tdm-native-host.exe` | Point to `%APPDATA%` JSONs → `v1.0.6` `C:\Users\ritud\AppData\Local\TORI Download Manager\bin\tdm-native-host.exe` |
| **Pinned Extension IDs in Manifests** | `bflchfddfgkfglmjapohkjmldepflkbe`, `jfnfgmcbgapcpieaonbaolgebjaejcdm`, `tori-download-manager@toridm.org` | 100% Preserved unchanged |
| **Desktop & Start Menu Shortcuts** | Pointed to `v1.0.4` exe | Both `OneDrive\Desktop\TORI Download Manager.lnk` and `Start Menu\Programs\TORI Download Manager\TORI Download Manager.lnk` → `v1.0.6` exe |
| **Stale QA Registry References** | Historical Gate 30.2 pollution | **0** references across all TORI registry trees |
| **Obsolete `%TEMP%\tori_g30_2_install_qa`** | Present on disk (`v1.0.5` copy) | Left untouched on disk (per non-destructive safety rules), zero registry references |

---

## 5. Phase 2 Controlled Shutdown Verification

- Verified `0` running `tori-download-manager.exe`, `tdm-native-host.exe`, `tdm-cli.exe`, and TORI WebView2 child processes prior to repair.
- Verified local Desktop HTTP API port `6800` closed (`TcpTestSucceeded: False`), Named Pipe free, and `%LOCALAPPDATA%\TORI Download Manager\` unlocked.
- Verified `0` active transfers in `%APPDATA%\tori-download-manager\tdm_storage.sqlite` (`29 completed`, `11 failed`, `2 paused`, `0 active`).

---

## 6. Phase 3 & Phase 4 Production Installation Repair Verification

- Executed the finalized `release/v1.0.6-rc/TORI Download Manager_1.0.6_x64-setup.exe /P` (official supported NSIS passive installation mode, default `$LOCALAPPDATA\${PRODUCTNAME}`).
- **Installer Exit Code:** `0`.
- **Single-Instance & Primary Boot Check:** Normal production launch of `C:\Users\ritud\AppData\Local\TORI Download Manager\tori-download-manager.exe` verified:
  - `APP_VERSION = 1.0.6`, HTTP API `/api/v1/ping` (`status=ok`, `version=2.0.0`, `engine_active=true`, `authenticated=true`, `port=6800`).
  - `HAD_SECONDARY_INSTANCE = false`.
  - `PRESERVED_DOWNLOAD_COUNT = 42` with live browser companion indicator `Extension connected`.
  - Close-to-Tray verified (`visHidden=false`, `pingWhileHidden=true`, `visRestored=true`).
- **Evidence Screenshots (Production Repaired `v1.0.6`, Dark + Rose theme, 42 preserved downloads):**
  - [01_repaired_production_v106_main_dark_rose.png](file:///F:/TORI/final%20tori%20download%20manager/docs/reports/screenshots/gate31_5/01_repaired_production_v106_main_dark_rose.png)
  - [02_repaired_production_v106_about.png](file:///F:/TORI/final%20tori%20download%20manager/docs/reports/screenshots/gate31_5/02_repaired_production_v106_about.png)

---

## 7. Phase 5 Standalone IDM Progress Window Verification (Installed `v1.0.6`)

Executed against the **actual installed production binary** (`C:\Users\ritud\AppData\Local\TORI Download Manager\tori-download-manager.exe`) under isolated QA data directory (`scripts/verify_gate31_5_install_repair_and_preflight.js`):

| Requirement | Status | Observed Runtime Evidence |
|---|---|---|
| Standalone native Windows progress window (`progress_<id>`) | **PASS** | Label `progress_f6cbcded-...`, separate WebView2 window target |
| Filename, percentage, live transfer rate & ETA | **PASS** | `11% large-http.bin`, `12.6 MB`, `1.4 MB (11.33%)`, `1.31 MB/s`, `8 sec` |
| Active connections & real segment bars | **PASS** | `Connections : 2`, `0 / 2 parts complete`, 2 active `.dl-sg i` bars |
| All 3 tabs present & interactive | **PASS** | `["Download status", "Speed limiter", "Options on completion"]` |
| Speed limiter controls | **PASS** | Checkbox + numeric KB/s input (`512 KB/s`) verified |
| Options on completion persistence | **PASS** | `set_download_completion_options` / `get_download_completion_options` verified (`notify_on_complete: true`) |
| Compact progress mode toggle (`#mn`) | **PASS** | Window height transitioned cleanly `365px → 38px` (`class="dl-win m"`) |
| Always-on-Top behavior | **PASS** | `getCurrentWindow().isAlwaysOnTop() === true` |
| Pause & Resume buttons | **PASS** | `pausedState="paused"` → `resumedState="downloading"` → exact SHA-256 |
| Closing progress window does NOT cancel transfer | **PASS** | Closed `#cl` mid-transfer (`popStillOpen=false`), 12 MiB download completed with exact SHA-256 |
| Tray-hidden browser-captured download | **PASS** | Main window hidden (`isVisible=false`), standalone progress window opened (`isIdm=true`), exact SHA-256 |
| Multiple simultaneous downloads (no duplicates) | **PASS** | 3 concurrent jobs → 3 unique progress windows (`activePopCount=3, uniqueCount=3`), 4th queued promoted cleanly |
| Zero legacy dark floating toast | **PASS** | `legacyToast=false` across every test scenario |
| Respects `showDownloadPopup = "never"` | **PASS** | Completed transfer with `neverPopOpened=false` |

### Captured Phase 5 & Phase 6 Screenshots
- [03_installed_v106_idm_progress_active.png](file:///F:/TORI/final%20tori%20download%20manager/docs/reports/screenshots/gate31_5/03_installed_v106_idm_progress_active.png) — Active IDM progress window (`Download status` tab)
- [04_installed_v106_idm_progress_speed_limiter.png](file:///F:/TORI/final%20tori%20download%20manager/docs/reports/screenshots/gate31_5/04_installed_v106_idm_progress_speed_limiter.png) — `Speed limiter` tab
- [05_installed_v106_idm_progress_completion_opts.png](file:///F:/TORI/final%20tori%20download%20manager/docs/reports/screenshots/gate31_5/05_installed_v106_idm_progress_completion_opts.png) — `Options on completion` tab
- [06_installed_v106_idm_progress_compact.png](file:///F:/TORI/final%20tori%20download%20manager/docs/reports/screenshots/gate31_5/06_installed_v106_idm_progress_compact.png) — Compact 38px progress bar mode
- [07_installed_v106_tray_hidden_browser_capture_progress.png](file:///F:/TORI/final%20tori%20download%20manager/docs/reports/screenshots/gate31_5/07_installed_v106_tray_hidden_browser_capture_progress.png) — Browser-captured download while main window hidden in tray
- [08_installed_v106_desktop_main_with_downloads.png](file:///F:/TORI/final%20tori%20download%20manager/docs/reports/screenshots/gate31_5/08_installed_v106_desktop_main_with_downloads.png) — Main Desktop window displaying all completed transfers
- Historical Before Reference (Gate 31.4 `v1.0.4` legacy dark toast, preserved untouched): [00_before_legacy_v104_dark_toast.png](file:///F:/TORI/final%20tori%20download%20manager/docs/reports/screenshots/gate31_4/00_before_legacy_v104_dark_toast.png)

---

## 8. Phase 6 Real Download Verification Matrix (Installed `v1.0.6`, 12/12 PASS)

| # | Scenario | Result | Verification Details |
|---:|---|---|---|
| 1 | Small HTTP file (`small-http.txt`, 128 KiB) | **PASS** | `label=progress_...`, `dup=1`, `legacyToast=false`, exact SHA-256 |
| 2 | Large HTTP file (`large-http.bin`, 12 MiB) | **PASS** | Live `1.31 MB/s`, 2 connections/segments, closed window mid-transfer, exact SHA-256 |
| 3 | Browser-captured MKV (`browser-captured-movie.mkv`, 6 MiB) | **PASS** | Standalone IDM progress window, exact SHA-256 |
| 4 | Real YouTube video (`watch?v=u9lj-c29dxI`, `605+251`) | **PASS** | Standalone IDM progress window, playable muxed `.mkv`, `ffprobe` duration `237.941s` |
| 5 | Real YouTube audio (`watch?v=u9lj-c29dxI`, `bestaudio`) | **PASS** | Standalone IDM progress window, playable `.m4a`, `ffprobe` audio stream `237.941s` |
| 6 | Multiple simultaneous downloads (`multi-1..3.bin`) | **PASS** | 3 independent IDM windows (`uniqueCount=3`), 0 duplicates, exact SHA-256 |
| 7 | Queued download promotion (`multi-4.bin`, `maxa=3`) | **PASS** | Observed `earlyState="queued"`, auto-promoted with IDM progress window, exact SHA-256 |
| 8 | Pause & Resume | **PASS** | Paused & resumed directly via IDM progress window buttons, exact SHA-256 |
| 9 | Retry after failure (`transient-retry.zip`, HTTP 500 → Retry) | **PASS** | Transitioned to `failed`, recovered via `retry_download` to `completed`, exact SHA-256 |
| 10 | Completed download & completion notification setting | **PASS** | Displayed in Main Window (`10` completed), `notify_on_complete=true` persisted |
| 11 | Main window hidden in system tray + `showDownloadPopup=never` | **PASS** | Tray capture opened IDM progress window; `never` suppressed popup; main restored cleanly |
| 12 | **Browser Companion `v1.0.10`** (Chromium + Signed Firefox XPI) | **PASS** | **Chromium (`msedge` unpacked `v1.0.10`)**: captured `chrome_companion_v1010.mkv` → installed Desktop `v1.0.6` IDM progress window + exact SHA-256. **Firefox (`tori-companion-v1.0.10-firefox-signed.xpi`, `xpinstall.signatures.required=true`, `signed=true`, `temporary=false`)**: captured `firefox_companion_v1010.mkv` → installed Desktop `v1.0.6` IDM progress window + exact SHA-256. |

---

## 9. Phase 7 Complete Regression Test Matrix (Post-Final Changes)

| Suite | Command | Result | Exact Counts | Duration |
|---|---|---|---|---:|
| UI Production Build | `npm --prefix ui run build` | **PASS** | `0` errors (`dist` built) | 1.5s |
| UI Lint (`oxlint`) | `npm --prefix ui run lint` | **PASS** | `0` errors, `7` pre-existing warnings | 0.6s |
| Rust Workspace Tests | `cargo test --workspace --no-fail-fast` | **PASS** | `252` passed, `0` failed, `0` ignored | 233.0s |
| Updater Ed25519 Crypto Tests | `cargo test --workspace --test updater_cryptography_tests` | **PASS** | `7` passed, `0` failed (`v1.0.5` + `v1.0.6` + tamper rejection) | 7.5s |
| Gate 31.5 Installed `v1.0.6` + Companion `v1.0.10` + Install-Path Hardening | `node scripts\verify_gate31_5_install_repair_and_preflight.js` | **PASS** | `23` PASS, `0` FAIL, `0` TIMEOUT, `0` NOT TESTED | 104.3s |
| Gate 31.4 Legacy Toast Replacement | `node scripts\verify_gate31_4_toast_replacement.js` | **PASS** | `15` PASS, `0` FAIL | ~76s |
| Gate 29.2 IDM Progress Window | `node scripts\verify_gate29_2_idm_progress_window.js` | **PASS** | `17` PASS, `0` FAIL | 41.3s |
| Gate 29.1 IDM Desktop UI | `node scripts\verify_gate29_1_idm_desktop_ui.js` | **PASS** | `20` PASS, `0` FAIL | 21.8s |
| Gate 29.4 Final Integration & Stability | `node scripts\verify_gate29_4_final_integration.js` | **PASS** | `18` PASS, `0` FAIL, `0` TIMEOUT, `0` NOT TESTED | ~184s |
| Gate 31.3 Live Public Baseline Preservation | `node scripts\verify_gate31_3_live_release.js` | **PASS** | `23` / `23` PASSED (`100.0%`) | 35.0s |
| Independent Clean Windows VM Install Test | External VM environment | **NOT TESTED** | Not available on single local workstation | — |

### Focused Installation-Path Hardening Regression Details (All 5 PASS inside Gate 31.5)
1. **`REG-STALE-QA-RECOVER` (PASS):** Seeded `HKCU\Software\tori\TORI Download Manager` with `%TEMP%\tori_g31_5_stale_qa_probe\desktop_install`, executed `TORI Download Manager_1.0.6_x64-setup.exe /P /UPDATE`; verified `NSIS_HOOK_PREINSTALL` automatically redirected `$INSTDIR` to `C:\Users\ritud\AppData\Local\TORI Download Manager`, repaired both `HKCU\Software\tori\TORI Download Manager` and `Uninstall\TORI Download Manager`, extracted `0` files into `%TEMP%`, and removed the empty stale leaf directory (`fakeTempHasExe=false`, `fakeTempLeafExists=false`).
2. **`REG-RESPAWN-KILL` (PASS):** Spawned lingering `v1.0.4` binary on the default single-instance IPC pipe (simulating live browser Native Messaging respawn), executed `v1.0.6` silent install to an isolated dir; verified `NSIS_HOOK_POSTINSTALL` terminated `v1.0.4` (`staleKilledByInstaller=true`) and newly installed `v1.0.6` started cleanly as primary instance (`hadSecondary=false`).
3. **`REG-SINGLE-INST` (PASS):** Launched second `v1.0.6` process on the same IPC pipe while primary was running; second instance forwarded activation and exited cleanly (`exitCode=0` in `32ms`, `SECONDARY_INSTANCE` logged) while primary remained healthy.
4. **`REG-USER-DATA-PRESERVE` (PASS):** Booted installed `v1.0.6` against an isolated copy of the operator's real `42`-download SQLite database + sample `.tdm-part`; verified all `42` rows, `dark`/`rose`/`showDownloadPopup=always`/`closeToTray=true` settings, `PRAGMA integrity_check=ok`, and exact `.tdm-part` SHA-256 preserved without overwrite.
5. **`REG-OEM-GUARD-PARITY` (PASS):** Deleted `QA_ROOT` prior to calling `oemGuard.restore()`; verified all 8 registry + manifest parity checks (`manuExistedMatch`, `manuValMatch`, `uninstExistedMatch`, `nmChrRegMatch`, `nmEdgeRegMatch`, `nmFfRegMatch`, `nmChrJsonMatch`, `nmFfJsonMatch`) returned `true`.

---

## 10. Phase 8 Installer & QA Workflow Hardening — Changed Files

| File | Purpose |
|---|---|
| [hooks.nsh](file:///F:/TORI/final%20tori%20download%20manager/src-tauri/nsis/hooks.nsh) | Added `NSIS_HOOK_PREINSTALL` guard redirecting stale `\temp\` / `_qa` paths back to `$LOCALAPPDATA\${PRODUCTNAME}` on non-silent installs (`/P /UPDATE` & GUI) + `RMDir` of empty stale leaf; retained `NSIS_HOOK_POSTINSTALL` `tdm-native-host --register` & lingering `tori-download-manager.exe` termination. |
| [qa_oem_state_guard.js](file:///F:/TORI/final%20tori%20download%20manager/scripts/lib/qa_oem_state_guard.js) | New shared fail-closed QA host-state guard storing backups strictly outside `QA_ROOT` (`target/_oem_state_backups/`), covering Uninstall, Manufacturer, Chrome/Edge/Firefox NativeMessagingHosts, `%APPDATA%` manifests, OneDrive/standard Desktop & Start Menu shortcuts, OEM running exe, and 8-point post-restore parity verification. |
| [verify_gate31_4_toast_replacement.js](file:///F:/TORI/final%20tori%20download%20manager/scripts/verify_gate31_4_toast_replacement.js) | Migrated to `QaOemStateGuard`, fixed backup-before-cleanup ordering, and updated `OEM` check to handle already-repaired `v1.0.6` hosts without overwriting historical `v1.0.4` BEFORE screenshot. |
| [verify_gate29_4_final_integration.js](file:///F:/TORI/final%20tori%20download%20manager/scripts/verify_gate29_4_final_integration.js) | Migrated to `QaOemStateGuard`, added `G294-SAFETY-REG` parity assertion, and hashed `OEM_DB_PATH` prior to re-enabling live browser Native Messaging so live browser respawn does not cause false-positive WAL checkpoint hash diffs. |
| [verify_gate31_5_install_repair_and_preflight.js](file:///F:/TORI/final%20tori%20download%20manager/scripts/verify_gate31_5_install_repair_and_preflight.js) | Comprehensive 23-check Gate 31.5 installed-binary acceptance, Companion `v1.0.10` (Chromium + signed Firefox XPI), and 5 focused installation-path regression tests. |

---

## 11. Phase 9 Desktop v1.0.6 Release Preflight & Artifact Inventory (Local Unpublished)

All artifacts staged locally in `release/v1.0.6-rc/` (not pushed, not published):

| Artifact | Size (Bytes) | SHA-256 |
|---|---:|---|
| `TORI Download Manager_1.0.6_x64-setup.exe` | `117,794,132` | `c29ee1080b0c3587d29a2e95fd4374524d49fc16055dfa74f9f66554161c6c7c` |
| `TORI Download Manager_1.0.6_x64-setup.exe.sig` | `436` | `2a3f4b217ae381a7a1d1042ca8b395480132d89d5d58c46a2c8dcccba765624a` |
| `tori-download-manager.exe` (standalone RC) | `30,559,232` | `57cce9fd0207b769ff74f4395a07c184b310c0fcc82bdc38ca5924edb4ce9b3d` |
| `tori-download-manager.exe` (installed NSIS `_NSS`) | `30,559,232` | `570833b379668f64d8f0a81e0a2c138635835e0c0382f37f24ec969caccf0fda` |
| `tdm-native-host.exe` | `19,397,632` | `d02da8be8056cd987bd4b5cdca9535a016f60bcb7cbed94fb43d56c042967671` |
| `tdm-cli.exe` | `17,067,008` | `2d8286a091caed95979893a1c2e7941163a8acf417d916d01bf31d6b72f58e76` |
| [SHA256SUMS.txt](file:///F:/TORI/final%20tori%20download%20manager/release/v1.0.6-rc/SHA256SUMS.txt) | — | Matches all 5 RC binaries/signatures |
| [BUILD_METADATA.json](file:///F:/TORI/final%20tori%20download%20manager/release/v1.0.6-rc/BUILD_METADATA.json) | — | `published: false`, `public_v105_modified: false`, `browser_companion_modified: false` |
| [RELEASE_NOTES_v1.0.6.md](file:///F:/TORI/final%20tori%20download%20manager/release/v1.0.6-rc/RELEASE_NOTES_v1.0.6.md) | — | Draft operator-ready release notes |
| [RELEASE_MANIFEST.json](file:///F:/TORI/final%20tori%20download%20manager/release/v1.0.6-rc/RELEASE_MANIFEST.json) | — | Structured preflight manifest |

### Cryptographic & Public Baseline Verification
- **Tauri Updater Ed25519 Signature:** **VALID** (`test_v106_release_candidate_signature_cryptographic_verification ... ok`, verified against public key in `src-tauri/tauri.conf.json`).
- **Windows Authenticode PE Signature:** **`NotSigned`** (commercial code-signing certificate not configured).
- **Public Baseline Read-Only Audit (`verify_gate31_3_live_release.js`, 23/23 PASS):**
  - GitHub public Desktop `v1.0.5` release & assets: **UNTOUCHED**
  - Public `latest.json` updater feed (pointing to `v1.0.5`): **UNTOUCHED**
  - Production website `toridownload.xyz`: **UNTOUCHED**
  - Browser Companion `v1.0.10` (`extension/` source, Mozilla-signed XPI SHA-256 `a93a43872d224426902c49e217e31b2c603263d8c260c429940539b34b2852b8`, Chromium ZIP SHA-256 `f220fab2e26fd54ef7f85fd7e40613faad79e7f9a7f44fadf228ccd0edcc22f1`): **UNTOUCHED**

---

## 12. User Database & Partial Download Preservation Audit

- **SQLite Database (`%APPDATA%\tori-download-manager\tdm_storage.sqlite`):**
  - `PRAGMA integrity_check`: **`ok`**
  - Total Download Rows: **`42`** (`29 completed`, `11 failed`, `2 paused`) — identical before & after repair and across all 10 QA suites.
  - User Settings: `theme="dark"`, `accent="rose"`, `dir="C:\\Users\\ritud\\Downloads"`, `showDownloadPopup="always"`, `alwaysOnTop=true`, `closeToTray=true`, `port=6800` — 100% preserved.
  - Note: During routine normal production launch + live browser reconnect, SQLite WAL automatically checkpointed clean pages without altering any user row or setting; rollback copy remains preserved in `target/gate31_5_rollback_backup/appdata/`.
- **Incomplete `.tdm-part` Partial Downloads:** All **11** operator `.tdm-part` files verified bit-for-bit identical against Phase 0 SHA-256 hashes (`all_11_unchanged=True`).

---

## 13. Documented Rollback Procedure

If the operator ever wishes to revert the local workstation from `v1.0.6` RC back to pre-repair state or public `v1.0.5`:
1. Quit TORI Download Manager completely from the system tray (verify `Get-Process tori-download-manager` returns nothing).
2. **To restore public `v1.0.5`:** Run `release\v1.0.5-rc\TORI Download Manager_1.0.5_x64-setup.exe /P` (the repaired `HKCU\Software\tori\TORI Download Manager` now points cleanly to `%LOCALAPPDATA%\TORI Download Manager\`).
3. **To restore exact pre-Gate-31.5 `v1.0.4` snapshot:**
   - Copy `target\gate31_5_rollback_backup\localappdata_v104\*` back to `%LOCALAPPDATA%\TORI Download Manager\`.
   - Run `"%LOCALAPPDATA%\TORI Download Manager\bin\tdm-native-host.exe" --register`.
   - If database rollback is also desired, copy `target\gate31_5_rollback_backup\appdata\tdm_storage.online_backup.sqlite` to `%APPDATA%\tori-download-manager\tdm_storage.sqlite` and remove matching stale `-wal`/`-shm` files.
4. **Git rollback:** `git checkout checkpoint-gate31_5-before-install-repair`.

---

## 14. Remaining Blockers & Documented Limitations

1. **Windows Authenticode Code Signing (`NotSigned`):** Neither `TORI Download Manager_1.0.6_x64-setup.exe` nor `tori-download-manager.exe` carries a commercial Windows Authenticode PE signature (same limitation as public `v1.0.5`). SmartScreen warnings may appear on fresh machines until an EV/OV code-signing certificate is provisioned.
2. **Independent Clean Windows VM Verification (`NOT TESTED`):** Verification was executed on the operator's Windows 11 host (both directly against the repaired production installation and in isolated user/WebView2/Chrome/Edge/Firefox profiles). Testing on a separate clean Windows VM remains `NOT TESTED`.
3. **Public Publication Intentionally Held:** Per Gate 31.5 authorization rules, Desktop `v1.0.6` has **not** been pushed to GitHub, added to `latest.json`, or linked on `toridownload.xyz`.

---

## 15. Release Decision & Next Recommended Action

- **Gate 31.5 Decision:** **`CONDITIONAL GO — DOCUMENTED LIMITATIONS`**
  - Local workstation installation repair is **100% COMPLETE and VERIFIED**.
  - Desktop `v1.0.6` RC passes all cryptographic, unit, UI, real download, Browser Companion `v1.0.10`, and installation-path regression checks (`0` failures across all 10 automated suites).
  - Public release awaits explicit operator sign-off acknowledging the two documented non-code limitations (`Authenticode: NotSigned`, `Clean Windows VM: NOT TESTED`).
- **Next Recommended Action:** Operator reviews this report and screenshots, optionally smoke-tests a live browser download on the repaired local `v1.0.6` installation, and then authorizes a dedicated publication gate (**Gate 31.6**) to publish GitHub Release `desktop-v1.0.6`, update public `latest.json`, and update `toridownload.xyz` (keeping Browser Companion `v1.0.10` untouched).
