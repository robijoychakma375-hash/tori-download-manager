# TORI Download Manager — Gate 26.4 Desktop v1.0.4 Release Readiness Report

**Date:** 2026-11-13  
**Branch:** `release/v1.0.4`  
**Verified Git Commit:** `f7fa6df`  
**Verified Checkpoint Tag:** `checkpoint-gate26.4-complete`  
**Target Desktop Version:** `v1.0.4`  
**Verified Browser Companion:** `v1.0.5` (Published) / `v1.0.6-rc` (Staged)  
**Overall Status:** **13/13 PASSED (0 FAILED) — PRODUCTION READY**  
**Final Release Recommendation:** **GO (Awaiting Explicit Operator Approval to Publish)**

---

## 1. Executive Summary

Following the real-world stability fixes implemented in **Gate 26.1**, development disk storage reclamation in **Gate 26.2**, and large-file test matrix validation in **Gate 26.3**, **Gate 26.4** executed final cryptographic signing, release artifact packaging, and complete packaged Windows x64 NSIS installer acceptance testing for **TORI Desktop v1.0.4**.

All **13 of 13** installer acceptance assertions passed with zero defects. The final self-contained NSIS installer (`TORI.Download.Manager_1.0.4_x64-setup.exe`) and detached Minisign signature have been generated, cryptographically validated, and staged in `release/v1.0.4-final/`.

Throughout the verification suite, the developer machine's active production installation (`v1.0.3`), user SQLite database (`tdm_storage.sqlite`), user settings, HKCU uninstall registry, and public GitHub release updater (`latest.json`) remained **100% untouched and pristine**.

---

## 2. Desktop v1.0.4 Final Production Installer Specification

| Property | Value |
| :--- | :--- |
| **Installer File** | `TORI.Download.Manager_1.0.4_x64-setup.exe` |
| **Staging Path** | `release/v1.0.4-final/TORI.Download.Manager_1.0.4_x64-setup.exe` |
| **Target Build Path** | `target/release/bundle/nsis/TORI Download Manager_1.0.4_x64-setup.exe` |
| **File Size** | `117,161,694` bytes (111.73 MiB) |
| **SHA-256 Checksum** | `739fe9d240dd9d717ed0cb593b35950fad20ff5c5f0406977bcc2c4b61ea4880` |
| **PE FileVersion** | `1.0.4.0` |
| **PE ProductVersion** | `1.0.4` |
| **Architecture** | Windows x64 (`x86_64-pc-windows-msvc`) |
| **Installer Framework** | NSIS (Nullsoft Scriptable Install System) v3 via Tauri Bundler |
| **Signing Algorithm** | Ed25519 (Minisign compatible) |
| **Signing Key ID** | `CDC23D8CC8DA5397` (Continuous across v1.0.0, v1.0.1, v1.0.2, v1.0.3, v1.0.4) |
| **Signature File** | `release/v1.0.4-final/TORI.Download.Manager_1.0.4_x64-setup.exe.sig` |

---

## 3. Cryptographic Verification & Anti-Tamper Security

The detached Ed25519 signature was generated using the out-of-repo private release key (`%USERPROFILE%\.tori-keys\tori-updater.key`) and evaluated via the standalone Rust cryptographic verifier (`verify_minisign`):

1. **Signature Integrity:** The installer binary strictly verified against the public key `CDC23D8CC8DA5397` embedded in `tauri.conf.json`.
2. **Key Continuity:** Public key ID matches across all historical TORI Desktop releases (`v1.0.0` through `v1.0.4`).
3. **Anti-Tamper Rejection:** A single-byte corrupted copy of the installer was rejected with `InvalidSignature`, proving robust tamper protection for Tauri in-app updates.

```
ALL VERSIONS PASSED MINISIGN CRYPTOGRAPHIC VERIFICATION!
Tampered binary rejected correctly: InvalidSignature
```

---

## 4. Gate 26.4 Acceptance Test Matrix (13 / 13 Passed)

The end-to-end acceptance suite (`scratch/verify_gate26_4_installer_acceptance.js`) ran in isolated sandbox directories (`%TEMP%\tori_gate26_4_*`) using isolated HTTP Range servers, isolated IPC named pipes, and isolated data paths:

| Check | Name | Result | Evidence / Metric |
| :---: | :--- | :---: | :--- |
| **STEP 1** | Gate 26.3 Acceptance Verification | **PASS** | 14/14 Gate 26.3 tests verified; physical vs sparse transfers explicitly distinguished. |
| **STEP 2** | Version 1.0.4 Synchronization | **PASS** | `Cargo.toml`, `tauri.conf.json`, `ui/package.json`, release PE binaries, and NSIS PE metadata synced to `1.0.4`. |
| **STEP 4** | Ed25519 Signature & Anti-Tamper | **PASS** | Signature verified against Key ID `CDC23D8CC8DA5397`; tampered binary rejected. |
| **STEP 5.1** | Fresh v1.0.4 NSIS Installation | **PASS** | Deployed `tori-download-manager.exe`, `tdm-native-host.exe`, `tdm-cli.exe`, `ffmpeg.exe`, `ffprobe.exe`, `yt-dlp.exe`, `LICENSE-THIRD-PARTY.txt`, `uninstall.exe`, and browser NM manifests. |
| **STEP 5.2** | Real v1.0.3 → v1.0.4 NSIS In-Place Upgrade | **PASS** | Silent `/S /NS` upgrade replaced `1.0.3` PE binaries with `1.0.4` cleanly with zero locked-file stalls. |
| **STEP 5.3** | Existing User Settings Preservation | **PASS** | SQLite `engine_settings` preserved `app_settings` (accent `emerald`, `con: 6`, `port: 16870`, `closeToTray: true`) and custom user keys. |
| **STEP 5.4** | Completed Download History Preservation | **PASS** | Existing completed history preserved; target file on disk (`4 MiB`) remained intact. |
| **STEP 5.5** | Resumable Partial Download Preservation | **PASS** | Partial `.tdm-part` (`17.03 MiB`) preserved across upgrade and resumed cleanly under v1.0.4 to 100% (`33.55 MiB`). |
| **STEP 6** | Browser Companion v1.0.5 Compatibility | **PASS** | Native host protocol ping `ok`, capability `ok`, server-side handoff coalescing deduplicated duplicate fallback without `handoff_id`, and `/api/v1/media/resolve` + `/download` succeeded. |
| **STEP 5.11-12** | Installed v1.0.4 Large-File (1 GB) Transfer | **PASS** | Instant NTFS `FSCTL_SET_SPARSE` allocation; mid-stream pause & resume; completed `1,073,741,824` bytes; process survived. |
| **STEP 5.7-10** | Close-to-Tray, Restore, Single-Instance & Exit | **PASS** | Window close hid to tray (`HIDE_MAIN`); process survived in background; tray restored (`RESTORE_MAIN`); secondary instance detected and exited (`SECONDARY_INSTANCE`); clean explicit exit (`EXIT_CLEAN`). |
| **STEP 7** | Staged Release Assets & Updater Manifest | **PASS** | All 8 files in `release/v1.0.4-final/` checksummed; updater matrix verified: v1.0.0-v1.0.3 get `Update Available`, v1.0.4 gets `Up to Date`. |
| **STEP 8** | Production Safety & Isolation | **PASS** | User production executable (`v1.0.3`), production database (`tdm_storage.sqlite`), HKCU registry, and public GitHub updater remained untouched. |

---

## 5. Summary of Real-World Production Bug Fixes in v1.0.4

### 1. Large-File Engine Multi-Gigabyte Stability (100 MB to 50+ GB)
- **Instant NTFS Sparse Allocation:** Files `≥ 64 MiB` invoke Windows `FSCTL_SET_SPARSE` (`0x000900C4`) before `set_len()`. This eliminates the fatal disk pre-allocation freeze that previously blocked 1 GB, 4.5 GB, 10 GB, and 50+ GB transfers.
- **256 KiB Buffered Writes & Throttled Checkpoints:** Individual network chunk writes are buffered in memory up to 256 KiB. SQLite WAL checkpoints are throttled to 4 MiB / 1s intervals, and disk file syncs are throttled to 16 MiB / 2s intervals, eliminating SQLite WAL write contention and high CPU usage.
- **Straggler Tail-Split Clamping:** Atomic worker positions are synchronized before dynamic tail-splitting, and worker write boundaries are strictly clamped to avoid overlapping chunks.
- **Presigned CDN Concurrency Capping:** S3, CloudFront, R2, and B2 URLs with expiration timestamps or token signatures are capped at 4 initial connections, with dynamic tail-splitting disabled to prevent HTTP 403/429 rate-limiting.
- **HEAD Probe Fallback:** Network probes enforce a strict 4-second timeout, automatically falling back to `GET Range: bytes=0-0` when servers fail to reply to HEAD requests.

### 2. Browser Handoff Deduplication (Firefox & Chromium)
- **Server-Side In-Flight Coalescing:** The desktop engine tracks in-flight and recent handoffs by URL, referrer, and user-agent. When Firefox or Chromium triggers a Native Messaging fallback after an HTTP capture timeout, the server coalesces the request, preventing duplicate `filename (1).ext` tasks.
- **Backward Compatibility:** Seamlessly compatible with published Browser Companion `v1.0.5` (which does not send `handoff_id`) as well as candidate `v1.0.6`.

### 3. Windows Job Object Process Survival
- **Job Object Breakaway:** `tdm-native-host.exe` spawns `tori-download-manager.exe --minimized` using `CREATE_BREAKAWAY_FROM_JOB | CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS`. This isolates the desktop app from the browser's Windows Job Object, preventing the application from being terminated when the short-lived Native Messaging host process exits after 5 seconds.

### 4. Close-to-Tray & Lifecycle Synchronization
- **Atomic State Synchronization:** The Rust `close_to_tray_enabled` state is synchronized with user settings on startup and on change.
- **Background Execution:** Clicking `X` hides the window to the notification area while active transfers continue in the background. Restoring from the tray icon or launching a secondary shortcut brings the primary window to the foreground cleanly.

---

## 6. Staged Final Release Assets (`release/v1.0.4-final/`)

All 8 official production assets are staged cleanly in `release/v1.0.4-final/`:

| File Name | Size (Bytes) | SHA-256 Checksum |
| :--- | :---: | :--- |
| `TORI.Download.Manager_1.0.4_x64-setup.exe` | 117,161,694 | `739fe9d240dd9d717ed0cb593b35950fad20ff5c5f0406977bcc2c4b61ea4880` |
| `TORI.Download.Manager_1.0.4_x64-setup.exe.sig` | 436 | `ed9b6984a96350a796b71d540677167157b8c5064387df8112b0e08dd4a8e59f` |
| `latest.json` | 2,230 | `5e2f064a4734f1305a304ec2fc03ff7924b0fc396ec2f9427a83888c0d9b3556` |
| `SHA256SUMS.txt` | 741 | `4e107c1b5ea3c75fb764d262174c3e800c6d2d46e6a4b11fdf12739ea19eb42b` |
| `RELEASE_NOTES.md` | 2,689 | `0569a435daf78b7b2c6b0374f1150143f5109d8bcd5b6706bea205c27cb81c31` |
| `INSTALLATION_AND_UPGRADE_NOTES.md` | 1,481 | `001201ae4a1d3e86524c5b524ec00252fac9528f774ce7b9aa7ebb2a61fd0c0c` |
| `LICENSE` | 1,068 | `55460ef099ce57e32d422427a7a24cd1e09aec677606289e396c2c17d625a598` |
| `LICENSE-THIRD-PARTY.txt` | 3,114 | `4f05486cb940a151e9b010ff3d033b7fb06370c665d174eb5d54d48433eb6035` |
| `LICENSE-GPLv3.txt` | 35,821 | `8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903` |

---

## 7. Public Auto-Updater Simulation Matrix

Using the staged `latest.json` manifest and detached signature:

| Client Version | Evaluated Target | In-App Updater Behavior | Status |
| :---: | :---: | :---: | :---: |
| `v1.0.0` | `v1.0.4` | Update Available (Prompts user to install v1.0.4) | **PASS** |
| `v1.0.1` | `v1.0.4` | Update Available (Prompts user to install v1.0.4) | **PASS** |
| `v1.0.2` | `v1.0.4` | Update Available (Prompts user to install v1.0.4) | **PASS** |
| `v1.0.3` | `v1.0.4` | Update Available (Prompts user to install v1.0.4) | **PASS** |
| `v1.0.4` | `v1.0.4` | Up to Date (No update prompt displayed) | **PASS** |

---

## 8. Git Release Checkpoint & State

- **Branch:** `release/v1.0.4`
- **HEAD Commit:** `f7fa6df` (`chore(release): synchronize v1.0.4 UI version fallbacks, release notes, and final release staging script`)
- **Base Checkpoint:** `1a85fd4` (`Gate 26.3: Fix straggler split buffer clamping and complete packaged Windows acceptance`)
- **Completion Tag:** `checkpoint-gate26.4-complete`
- **Working Tree:** Completely clean (`nothing to commit, working tree clean`)
- **Branch Isolation:** `release/v1.0.3` is untouched at commit `7a4dcab`.

---

## 9. Next Actions & Operational Safeguards

> [!IMPORTANT]
> **OPERATIONAL SAFEGUARD:** In accordance with Gate 26.4 release protocols, the release has **NOT** been published to GitHub Releases, the public `latest.json` has **NOT** been altered, and the website has **NOT** been modified.
>
> All production assets are staged locally in `release/v1.0.4-final/` awaiting explicit human operator approval.

When approved by the operator, publication can be executed via:
1. Creating GitHub Release `v1.0.4` with assets from `release/v1.0.4-final/`.
2. Updating the public auto-updater manifest (`latest.json`) on the download CDN / GitHub release.
3. Updating the official project download links.
