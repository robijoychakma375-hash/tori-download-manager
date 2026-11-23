# TORI Download Manager — Desktop v1.0.8 Public Stable Release Checklist

**Checklist ID:** `TORI-CHECKLIST-V108-PUB-001`  
**Target Release:** TORI Download Manager Desktop `v1.0.8` (Stage 1 Dual-Key Release)  
**Gate 34.2 Publication Status:** **`FULL GO — PUBLIC STABLE RELEASED & VERIFIED (2026-11-23T08:25:29Z)`**  
**Owner Accepted Stage 1 Risk Flags (NOT RESOLVED):**
- `RISK-34-01`: `BACKUP_VERIFICATION_DEFERRED_BY_OWNER` / `BACKUP_RECOVERY_NOT_VERIFIED` -> `ACCEPTED_FOR_STAGE1_V108_PUBLIC_RELEASE` (**HARD BLOCKER** for Stage 2 dedicated-only tools signing cutover)
- `RISK-34-02`: `CLEAN_WINDOWS_10_11_VM_NOT_TESTED` -> `ACCEPTED_FOR_STAGE1_V108_PUBLIC_RELEASE`
- `RISK-34-03`: `WINDOWS_AUTHENTICODE_NOT_SIGNED` -> `ACCEPTED_FOR_STAGE1_V108_PUBLIC_RELEASE`

**Public Release Authorization Status:** **`AUTHORIZED & COMPLETED (GATE 34.2)`**  
**Final Release Report:** `docs/reports/GATE34_2_DESKTOP_V108_PUBLIC_STABLE_RELEASE_REPORT.md`  
**Preflight Plan:** `docs/security/GATE34_DESKTOP_V108_PUBLIC_STABLE_PREFLIGHT_PLAN.md`

---

| # | Release Requirement | Status | Evidence / Action Required |
|---:|---|---|---|
| 1 | Dedicated production `tori-tools.key` custody (`-Mode ProductionInteractive` + encrypted offline backup & recovery) | **`ACCEPTED STAGE 1 RISK (RISK-34-01)`** | Active key `C3FD6626A3718E63` (`6807e183...`) verified via `-Mode VerifyProductionKey`. Offline backup & recovery remain **NOT VERIFIED** (`BACKUP_VERIFICATION_DEFERRED_BY_OWNER`, `BACKUP_RECOVERY_NOT_VERIFIED`). Explicitly accepted by owner for Stage 1 Desktop `v1.0.8` only; **HARD BLOCKER** for Stage 2 dedicated-only production tools signing cutover. |
| 2 | Dedicated production public key embedded in `crates/tdm-core/src/tools/trust.rs` | **`VERIFIED (LIVE)`** | `C3FD6626A3718E63` embedded alongside `CDC23D8CC8DA5397`; verified inside installed public `v1.0.8` `tori-download-manager.exe` (`G342-09`) and `external_tools_security_matrix_tests` (`5/5 PASS`). |
| 3 | Frozen Desktop `v1.0.8` RC built from verified commit `1a24265d247a43371ab2b637e195425df2c78b82` without rebuild | **`PUBLISHED`** | Git tag `v1.0.8` (`b7828cda...`) dereferences to `1a24265d247a43371ab2b637e195425df2c78b82` (`0` code diff lines); published as GitHub Release ID **`455125259`** (`16/16` Desktop-only assets). |
| 4 | Published installer SHA-256 & `SHA256SUMS.txt` verified | **`VERIFIED (LIVE)`** | Live HTTPS download of `TORI.Download.Manager_1.0.8_x64-setup.exe` (`782056228`, `118,110,372` B) matches `728d0d253a8fadc3fea5244723237f267dcd13abf65cac49b91a4ec83a3dcffb` bit-for-bit (`G342-03`). |
| 5 | Published Tauri Ed25519 signature (`CDC23D8CC8DA5397`) & live `latest.json` verified | **`VERIFIED (LIVE)`** | `.sig` (`782094029`, `436` B, `8f2bc20b...`) & live `releases/latest/download/latest.json` (`782113345`, `version=1.0.8`, `pub_date=2026-11-23T07:55:00.033Z`) verified via Node Ed25519 (`G342-03/04`), real `v1.0.7` Tauri `plugin:updater|download` (`G342-09`), and `updater_cryptography_tests` (`10/10 PASS`). |
| 6 | Live production tools manifest `rev 2` compatibility & preservation (`v1.0.7` & `v1.0.8`) | **`VERIFIED (LIVE)`** | Unchanged (`caa2d4ed...`, `.sig` `11efa53f...`, `CDC23D8CC8DA5397`, expires `2027-01-21T19:46:42.049Z`); live expiry monitor `HEALTHY` (`59.43d`); verified live on public `v1.0.8` (`G342-05/11`) with 205 MiB FFmpeg/FFprobe update, media matrix, rollback & bundled fallback. |
| 7 | Browser Companion `v1.0.10` preserved & compatible (Chrome/Edge/Firefox + signed XPI) | **`VERIFIED (LIVE)`** | Unchanged (`extension-v1.0.10` ID `451270856`, XPI `a93a4387...`, ZIP `f220fab2...`); verified live Mozilla-signed Firefox permanent install & MKV capture into public `v1.0.8` (`G342-06/12`). |
| 8 | Native Messaging stdio & HTTP fallback compatibility | **`VERIFIED (LIVE)`** | Verified Chrome, Edge & Firefox `--register`, stdio `ping -> pong`, and HTTP `/api/v1/status` on public `v1.0.8` (`G342-12`). |
| 9 | Full mandatory security tests & post-release regression | **`VERIFIED (LIVE)`** | Gate 34.2 live public suite (`14/14 PASS`), `updater_cryptography_tests` (`10/10 PASS`), `external_tools_security_matrix_tests` (`5/5 PASS`), expiry monitor matrix (`18/18 PASS`), and frozen `1a24265d` Gate 33.3 baseline (`435/435 PASS`). |
| 10 | Real isolated `v1.0.7 -> v1.0.8` auto-updater, upgrade, IDM Progress Window, Close-to-Tray & warm restart | **`VERIFIED (LIVE)`** | Real `v1.0.7` `plugin:updater|check` + `plugin:updater|download` (`118,110,372` B, Rust Ed25519 verified) -> in-place upgrade -> `v1.0.8` (`G342-09/10/13 PASS`). |
| 11 | Production user data & OEM `v1.0.6` preservation | **`VERIFIED (LIVE)`** | OEM binary `570833b3...`, SQLite (`PRAGMA integrity_check=ok`, `42` rows, `355` chunks, `5` protected settings), `11` `.tdm-part` files & Registry 100% preserved (`G342-14 PASS`). |
| 12 | Clean Windows 10 VM QA | **`NOT TESTED (RISK-34-02)`** | Explicitly accepted by owner for Stage 1 Desktop `v1.0.8` (`CLEAN_WINDOWS_10_11_VM_NOT_TESTED`); deferred to Gate 35. |
| 13 | Clean Windows 11 VM QA | **`NOT TESTED (RISK-34-02)`** | Explicitly accepted by owner for Stage 1 Desktop `v1.0.8` (`CLEAN_WINDOWS_10_11_VM_NOT_TESTED`); deferred to Gate 35. |
| 14 | Windows Authenticode PE code signing | **`NOT SIGNED (RISK-34-03)`** | `NotSigned` explicitly accepted by owner (`WINDOWS_AUTHENTICODE_NOT_SIGNED`); Ed25519 Tauri updater signing active and verified. |
| 15 | Official Website (`https://toridownload.xyz`) promotion & Cloudflare Pages deploy | **`DEPLOYED & VERIFIED`** | Commit `181b3fb7c4d2abb9889d7d988b223fe63e02506f`, Cloudflare Pages Deployment **`113c58b9-82c9-42ec-a096-7bc9b62c5b9e`**; verified across 2 fresh cache-bypass passes & Desktop/Mobile renders (`G342-07/08 PASS`). |
| 16 | Rollback & emergency recovery readiness (`v1.0.7` preserved, pre-release backups, atomic tool rollback) | **`VERIFIED (LIVE)`** | `v1.0.7` (`454278227`) untouched; out-of-repo backups in `C:\Users\ritud\.tori-release-backups\gate34_2_pre_pub_20261123\`; live tool rollback & bundled fallback passed (`G342-11`). |
| 17 | Explicit project-owner authorization for Gate 34.2 Desktop `v1.0.8` public publication | **`GRANTED & EXECUTED`** | Public Stable release completed; reserved `checkpoint-gate33_3-final-rc-verified` intentionally withheld; `origin/master` untouched. |
