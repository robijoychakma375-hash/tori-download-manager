# TORI Gate 36.2 — Desktop v1.0.9 Public Release Security & Readiness Checklist

**Target Release:** `v1.0.9` (TORI Download Manager Desktop — Windows x64 NSIS Installer)  
**Compatible Public Browser Companion:** `v1.0.11` (`extension-v1.0.11`, GitHub Release ID `458864802`)  
**Compatible Production External Tools Manifest:** Revision 2 (`CDC23D8CC8DA5397`, `caa2d4ed2a7e424badcd8662e67b986a3fdfbf2847dded0625ea2b2547663f3a`)  
**Preparation Branch:** `feat/gate36_2-desktop-v109-prepublish`  
**Publication Status:** **LOCAL PREFLIGHT ONLY — PUBLIC RELEASE NOT AUTHORIZED / NOT PERFORMED**

---

## 1. Frozen Artifact & Cryptographic Integrity Controls

| # | Control | Verified Baseline / Requirement | Status |
| :-: | :--- | :--- | :---: |
| 1 | Frozen RC Installer Hash | `TORI.Download.Manager_1.0.9_x64-setup.exe` (`118,170,722` B), SHA-256 `460f5da00d09267a5f33274645250d92162bbfa3605f0348cc656a39a8a19ead` | **PASS** |
| 2 | Detached Tauri Ed25519 Signature | `TORI.Download.Manager_1.0.9_x64-setup.exe.sig` (`436` B), SHA-256 `9fd6f9e8a46e93dd1e1f6212b9d174aba3cc23761c55704f2a407965cb385aa0`, valid under `CDC23D8CC8DA5397` | **PASS** |
| 3 | Cryptographic Tamper Rejection | 1-byte mid-installer mutation strictly rejected by Ed25519 verification (`Rust` + `Node`) | **PASS** |
| 4 | Updater Metadata Parity (`latest.json`) | UTF-8 no-BOM JSON, `version: "1.0.9"`, `1.0.8 < 1.0.9`, exact `.sig` match, exact dotted installer URL | **PASS** |
| 5 | Stage 1 Dual-Key External Tools Keyring | Legacy shared `CDC23D8CC8DA5397` + Dedicated active `C3FD6626A3718E63` (`6807e183...`); `allow_legacy_shared_key = true`; dedicated-only cutover **DISABLED** | **PASS** |
| 6 | Key Custody & Independence | `VerifyProductionKey = VALID_PRODUCTION_KEY`; scrypt-encrypted, owner-only NTFS ACL, no `.pwd` on tools key, independent of updater key | **PASS** |
| 7 | Zero Secret Leakage | `0` private keys, `.key`/`.pwd`/`.pfx` files, PATs, or bearer tokens in `release/v1.0.9-rc/`, `release/v1.0.9-public-staging/`, scripts, or reports | **PASS** |

---

## 2. Security, Reliability & Compatibility Regression Controls

| # | Control | Evidence | Status |
| :-: | :--- | :--- | :---: |
| 8 | Gate 35.1 Security Hardening Retained | `gate35_security_hardening_tests` (`10/10`) + `external_tools_security_matrix_tests` (`5/5`) + `cb885d48` verified ancestor | **PASS** |
| 9 | Gate 35.2 `Content-Range`, ETag, `416` & Corruption Prevention | `gate35_2_content_range_tests` (`11/11`) + live `v1.0.9` RC broken-CDN `206` single-stream fallback (`G361-08`) | **PASS** |
| 10 | Gate 35.2 Startup Policy, Hidden `--minimized` & Spawn Mutex | `gate35_2_startup_and_tray_tests` (`5/5`) + `tdm-native-host` unit/integration (`32/32`) + live `v1.0.9` `4x` concurrent native host (`G361-06`, `G361-09`, `G361-10`) | **PASS** |
| 11 | Isolated `v1.0.8` → `v1.0.9` Upgrade & Preservation | `verify_gate36_1_v109_rc.js` (`12/12`): SQLite `ok`, downloads, `closeToTray`, theme/accent, and pre-existing `.tdm-part` preserved bit-for-bit | **PASS** |
| 12 | Public Browser Companion `v1.0.11` Compatibility | Live public Signed Firefox XPI (`15/15`) + live public Chromium ZIP across Chrome/Edge/Firefox (`32/32`) + `SEC-35-04` VM (`30/30`) against `v1.0.9` RC | **PASS** |
| 13 | Bundled Tools & Manifest Rev 2 Continuity | Bundled `ffmpeg` (`N-126374`), `ffprobe` (`N-126374`), `yt-dlp` (`2026.08.19`) verified; live `tools-manifest.json` rev 2 (`caa2d4ed...`) untouched | **PASS** |
| 14 | Production & Operator Environment Preservation | Public Desktop `v1.0.8` (ID `455125259`), Companion `v1.0.11` (ID `458864802`), live `toridownload.xyz`, OEM `v1.0.6`/SQLite/`21` `.tdm-part`/HKCU registry untouched | **PASS** |

---

## 3. Open Risks Requiring Explicit Owner Disposition (NEVER Inherited from v1.0.8)

| Risk ID | Risk Description | Current Measured State | Owner Disposition Required Before Publish |
| :--- | :--- | :--- | :---: |
| **`RISK-36-01`** | Dedicated External Tools Key (`C3FD6626A3718E63`) Offline Backup & Recovery | **`BACKUP_RECOVERY_NOT_VERIFIED`** | Execute `-Mode VerifyBackup` on offline media OR record explicit owner waiver for Stage 1 (Stage 2 cutover remains strictly blocked) |
| **`RISK-36-02`** | Clean Windows 10 & Windows 11 OS Installation / Upgrade QA | **`CLEAN_WINDOWS_QA_NOT_TESTED`** (`0` local VMs; CI workflow not yet on `origin/master`) | Execute clean Win10/Win11 VM or GitHub Actions `windows-2022`/`windows-2025` QA OR record explicit owner waiver |
| **`RISK-36-03`** | Windows Authenticode Commercial Code Signing | **`NotSigned`** (commercial cert not configured; WDK test cert prohibited) | Provision commercial Authenticode cert & re-sign OR record explicit owner waiver accepting SmartScreen disclosure |
| **`RISK-36-04`** | `v1.0.9`-Specific Regression or Packaging Defects | **No open product defects** *(UTF-8 BOM in `draft_latest.json` caught & fixed via `UTF8Encoding($false)`)* | Verified resolved |

---

## 4. Mandatory Owner Release Gate

- [ ] Owner explicitly reviews and records disposition for `RISK-36-01`, `RISK-36-02`, and `RISK-36-03` for Desktop `v1.0.9` specifically
- [ ] Owner grants explicit separate release authorization to execute `docs/release/GATE36_2_DESKTOP_V109_PUBLICATION_RUNBOOK.md`
