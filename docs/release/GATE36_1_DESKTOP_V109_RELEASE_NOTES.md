# TORI Download Manager Desktop v1.0.9 — Release Notes (LOCAL RELEASE CANDIDATE — UNPUBLISHED)

**Release Candidate Version:** `1.0.9`  
**Status:** **LOCAL RELEASE CANDIDATE (NOT PUBLISHED)**  
**Target Platform:** Windows 10 / 11 (64-bit x64 NSIS Installer)  
**Compatible Browser Companion:** TORI Browser Companion `v1.0.11` (Public Stable, Security Hotfix)  
**Production External Tools Compatibility:** Stage 1 Dual-Key Trust (`CDC23D8CC8DA5397` legacy shared + `C3FD6626A3718E63` dedicated active) — 100% compatible with live Tools Manifest Revision 2 (`dedicated-only cutover remains DISABLED`)

---

## Overview

TORI Download Manager Desktop `v1.0.9` consolidates the verified Gate 35.1 security hardening and Gate 35.2 reliability & startup-behavior fixes into a clean Windows x64 Desktop release candidate fully compatible with the publicly released **Browser Companion `v1.0.11` (`SEC-35-04`)** and existing **External Tools Manifest revision 2**.

---

## What's Fixed & Hardened in Desktop v1.0.9

### 1. Download Engine HTTP Range Reliability & Data-Corruption Prevention (Gate 35.1 + Gate 35.2)
- **Strict `Range: bytes=0-0` Probe Validation (`probe.rs`):** Prevents servers/CDNs that ignore `Range: bytes=0-0` and reply `206` with full file bounds from being falsely classified as multi-chunk resumable; enforces strict `start <= end < total` bounds parsing.
- **Strict `206 Content-Range` & `ETag` / `Last-Modified` Validator Checks (`worker.rs`):** Rejects missing or malformed `Content-Range` headers (`InvalidRangeHeader`) and mid-download resource changes (`ETagMismatch`) before writing a single byte, eliminating two silent data-corruption vectors.
- **Safe Bounded Single-Stream Fallback (`manager.rs`, `worker.rs`, `repo.rs`):** When a server returns `MismatchedContentRange`, `InvalidRangeHeader`, `RangeNotSupported (200)`, `ETagMismatch`, or `HTTP 416` during multi-chunk fetching (such as broken CDN responses observed on `ledger-live-desktop` downloads), TORI cleanly drains all active chunk workers, performs at most one bounded single-stream full-body fallback with target-only `.tdm-part` truncation and SQLite chunk-bound update, verifies contiguity/size, and atomically publishes the file without affecting any unrelated partial downloads.

### 2. Unwanted Windows Startup Popup Elimination & Tray Lifecycle Hardening (Gate 35.2)
- **Cross-Process Native-Host Spawn Mutex (`tdm-native-host/src/ipc.rs`):** Adds a pipe-scoped Windows named mutex (`Local\TORI_DM_EngineSpawn_<fnv1a64>`) with double-checked IPC connect around `ensure_engine_running()`, preventing concurrent multi-process `tori-download-manager.exe` spawn stampedes during OS startup.
- **True Silent Minimized Launch (`src-tauri/src/lib.rs`, `startup_policy.rs`):** `--minimized` launches now keep the main window hidden in the system tray (`window.hide()`) instead of flashing/minimizing onto the taskbar.
- **No Unsolicited Failed-Job Popup Windows (`src-tauri/src/commands.rs`, `startup_policy.rs`):** Automatic (`force = false`) progress popups are suppressed for already-`Failed` or `Cancelled` jobs and non-active minimized starts while preserving explicit user clicks (`force = true`), active user downloads, and Close-to-Tray settings.

### 3. Post-Release Security & Keyring Hardening (Gate 35.1)
- **Stage 2 Keyring & Security Guards:** Incorporates all Gate 35.1 post-release security hardening fixes and regression tests while preserving Stage 1 dual-key transition compatibility (`CDC23D8CC8DA5397` + `C3FD6626A3718E63`) for production External Tools manifest revision 2.
- **Native Messaging & Browser Companion `v1.0.11` Compatibility:** Preserves full localhost HTTP API and Native Messaging compatibility with Mozilla-signed Firefox and Chromium/Edge Browser Companion `v1.0.11`.

---

## Known Limitations (Pre-Publication Disclosures)

- **Windows Authenticode Code Signing:** **NOT SIGNED** (`NotSigned`; Windows SmartScreen prompt expected until an Authenticode certificate is provisioned — signing pipeline ready via `scripts/build_nsis_installer.ps1 -SignAuthenticode`).
- **Clean Windows 10 / Windows 11 VM Verification:** **NOT TESTED** on this workstation (`0` local provisioned Windows 10/11 VMs; GitHub Actions manual workflow `.github/workflows/clean-windows-release-qa.yml` is staged for clean `windows-2022` / `windows-2025` runner verification prior to public release).
- **External Tools Dedicated-Key Offline Backup (`C3FD6626A3718E63`):** Deferred per owner directive (`BACKUP_VERIFICATION_DEFERRED_BY_OWNER`); Stage 2 dedicated-only External Tools signing remains **DISABLED**.
- **Public Release Status:** **NOT PUBLISHED** — local Release Candidate only (`release/v1.0.9-rc/`).

---

## Upgrade & Preservation Notes (`v1.0.8` → `v1.0.9`)

- Additive SQLite schema preserves all existing downloads, `download_chunks`, `engine_settings`, themes, Close-to-Tray configuration, incomplete `.tdm-part` files, and External Tools registry records.
- Signed with the existing authorized Tauri Desktop Auto-Updater Ed25519 key (`CDC23D8CC8DA5397`).
- Compatible with Browser Companion `v1.0.11` without re-pairing or changing extension IDs.
