# TORI Download Manager — Desktop v1.0.8 Future Public Release Readiness Checklist

**Checklist ID:** `TORI-CHECKLIST-V108-PUB-001`  
**Target Release:** TORI Download Manager Desktop `v1.0.8` (Stage 1 Dual-Key Release)  
**Public Release Authorization Status:** **`NOT AUTHORIZED — BLOCKED PENDING OPERATOR KEY CUSTODY & SEPARATE OWNER RELEASE GATE`**

---

| # | Release Requirement | Status | Evidence / Action Required |
|---:|---|---|---|
| 1 | Dedicated production `tori-tools.key` custody completed (`-Mode ProductionInteractive` + verified offline encrypted backup) | **`BLOCKED`** | Currently `PRODUCTION_KEY_PROVISIONING_PENDING`. Requires interactive operator passphrase entry & offline backup verification (`-Mode VerifyBackup -VerifyPassphrase`). |
| 2 | Dedicated production public key embedded in `crates/tdm-core/src/tools/trust.rs` | **`BLOCKED`** | `TORI_DEDICATED_TOOLS_ED25519_KEY_ID` and `TORI_DEDICATED_TOOLS_ED25519_PUBKEY_B64` remain `None` until item #1 completes. |
| 3 | Final key-enabled Desktop `v1.0.8` RC rebuilt into `release/v1.0.8-final-rc/` from post-embedding commit | **`BLOCKED`** | Must be rebuilt cleanly AFTER item #2; Gate 33.1 `release/v1.0.8-rc/` (`659f5f23...`) is pre-key-provisioning audit artifact only. |
| 4 | Final RC installer SHA-256 & `SHA256SUMS.txt` verified | **`BLOCKED`** | Dependent on item #3 final rebuild. |
| 5 | Final RC Tauri Ed25519 signature (`CDC23D8CC8DA5397`) verified | **`BLOCKED`** | Dependent on item #3 final rebuild (verified on Gate 33.1 pre-key RC `51f401b0...`). |
| 6 | Live production tools manifest `rev 2` compatibility (`v1.0.7` & `v1.0.8`) | **`READY`** | Verified live over HTTPS (`G332-LIVE-01..07`, `G333-01..02`; `caa2d4ed...`, expires `2027-01-21T19:46:42.049Z`). |
| 7 | Browser Companion `v1.0.10` preserved & compatible (Chrome/Edge/Firefox + signed XPI) | **`READY`** | Unchanged (`a93a4387...`, `f220fab2...`); verified live capture on `v1.0.8-rc` (`G331-18..19`, `G333` suite). |
| 8 | Native Messaging stdio & HTTP fallback compatibility | **`READY`** | Verified `ping -> pong` & `/api/v1/status` HTTP `200`. |
| 9 | Full mandatory security tests (25 scenarios, keyring separation, anti-escalation, compromise recovery) | **`READY`** | Verified in `external_tools_security_matrix_tests` (`5/5 PASS`), `updater_cryptography_tests` (`9/9 PASS`), `external_tools_updater_tests` (`11/11 PASS`), `verify_gate33_3_dedicated_key_preflight.js`. |
| 10 | Critical downloader, UI, Progress Window, Close-to-Tray & media pipeline tests | **`READY`** | Verified across Gate 29.1, 29.2, 29.4, 31.4, 31.5, 32, 32.1, 32.3, 33, 33.1, 33.2, 33.3 + deterministic media resolver tests. |
| 11 | Production user data & OEM `v1.0.6` preservation | **`READY`** | OEM binary `570833b3...`, SQLite (`PRAGMA integrity_check=ok`, `42` rows, `355` chunks), `11` `.tdm-part` files & Registry 100% preserved. |
| 12 | Clean Windows 10 VM QA | **`NOT TESTED`** | `0` pre-provisioned licensed Win10 VMs on host; automation ready (requires clean VM run or explicit owner acceptance). |
| 13 | Clean Windows 11 VM QA | **`NOT TESTED`** | `0` pre-provisioned licensed Win11 VMs on host; automation ready (requires clean VM run or explicit owner acceptance). |
| 14 | Windows Authenticode PE code signing | **`ACCEPTED LIMITATION`** | `NotSigned` (no commercial certificate configured; `signtool.exe` pipeline ready & fail-closed; Tauri Ed25519 updater signing independent and active). |
| 15 | Final release assets frozen & Git release tag `v1.0.8` prepared | **`BLOCKED`** | Dependent on items #1–#5; do NOT create or push `v1.0.8` tag until final key-enabled RC is verified. |
| 16 | Rollback readiness confirmed (`v1.0.8 → v1.0.7`, atomic tool rollback, emergency `rev 3` plan) | **`READY`** | Verified in `G332-LIVE-05`, Phase 12 `rev 3` plan, and backward-compatible SQLite schema. |
| 17 | Explicit project-owner authorization for Desktop `v1.0.8` public publication | **`BLOCKED`** | Public release is **NOT AUTHORIZED** in Gate 33.3 and requires a dedicated future publication gate. |
