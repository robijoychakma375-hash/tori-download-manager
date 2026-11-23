# TORI Download Manager — Desktop v1.0.8 Future Public Release Readiness Checklist

**Checklist ID:** `TORI-CHECKLIST-V108-PUB-001`  
**Target Release:** TORI Download Manager Desktop `v1.0.8` (Stage 1 Dual-Key Release)  
**Gate 33.3 Handover Status:** **`CONDITIONAL GO — QA COMPLETE, BACKUP VERIFICATION DEFERRED`**  
**Owner Backup Governance Flags:**
- `BACKUP_VERIFICATION_DEFERRED_BY_OWNER`
- `BACKUP_RECOVERY_NOT_VERIFIED`
- `PRODUCTION_KEY_LOSS_RISK_ACCEPTED_FOR_CONTINUED DEVELOPMENT`

**Public Release Authorization Status:** **`NOT AUTHORIZED — SEPARATE EXPLICIT OWNER AUTHORIZATION REQUIRED FOR GATE 34`**  
**Preflight Plan:** `docs/security/GATE34_DESKTOP_V108_PUBLIC_STABLE_PREFLIGHT_PLAN.md`

---

| # | Release Requirement | Status | Evidence / Action Required |
|---:|---|---|---|
| 1 | Dedicated production `tori-tools.key` custody (`-Mode ProductionInteractive` + encrypted offline backup & recovery) | **`DEFERRED RISK (OWNER ACCEPTED FOR DEV)`** | Active key `C3FD6626A3718E63` (`6807e183...`) verified via `-Mode VerifyProductionKey` (`VALID_PRODUCTION_KEY`, scrypt `Ed`/`Sc`, owner-only NTFS ACL, zero `.pwd`). Offline backup & recovery are **NOT VERIFIED** (`BACKUP_VERIFICATION_DEFERRED_BY_OWNER`, `BACKUP_RECOVERY_NOT_VERIFIED`, `PRODUCTION_KEY_LOSS_RISK_ACCEPTED_FOR_CONTINUED DEVELOPMENT`). Explicit release risk for Gate 34; **HARD BLOCKER** for Stage 2 dedicated-key production cutover. |
| 2 | Dedicated production public key embedded in `crates/tdm-core/src/tools/trust.rs` | **`READY`** | `TORI_DEDICATED_TOOLS_ED25519_KEY_ID = Some("C3FD6626A3718E63")` and `TORI_DEDICATED_TOOLS_ED25519_PUBKEY_B64` embedded; Stage 1 dual-key keyring verified (`CDC23D8CC8DA5397` + `C3FD6626A3718E63`). |
| 3 | Final key-enabled Desktop `v1.0.8` RC rebuilt into `release/v1.0.8-final-rc/` from verified commit `1a24265d247a43371ab2b637e195425df2c78b82` | **`READY`** | Built fresh into `release/v1.0.8-final-rc/`; distinct from preserved pre-key Gate 33.1 `release/v1.0.8-rc/` (`659f5f23...`); zero private keys/secrets in RC dir. |
| 4 | Final RC installer SHA-256 & `SHA256SUMS.txt` verified | **`READY`** | `TORI Download Manager_1.0.8_x64-setup.exe` = `118,110,372` bytes, SHA-256 `728d0d253a8fadc3fea5244723237f267dcd13abf65cac49b91a4ec83a3dcffb`; all 10 artifacts match `SHA256SUMS.txt`. |
| 5 | Final RC Tauri Ed25519 signature (`CDC23D8CC8DA5397`) verified | **`READY`** | `TORI Download Manager_1.0.8_x64-setup.exe.sig` (`436` B, SHA-256 `8f2bc20bd2c8994ac04d8d2fc84be37b5569f11caeb47b63f369a4c72b44294c`) cryptographically verified in `updater_cryptography_tests` (`10/10 PASS`) with tamper & corruption rejection. |
| 6 | Live production tools manifest `rev 2` compatibility (`v1.0.7` & `v1.0.8-final-rc`) | **`READY`** | Verified live over HTTPS (`G333-02..03`, `G332-LIVE-01..09`, `G323-05`; `caa2d4ed...`, expires `2027-01-21T19:46:42.049Z`, `CDC23D8CC8DA5397`). |
| 7 | Browser Companion `v1.0.10` preserved & compatible (Chrome/Edge/Firefox + signed XPI) | **`READY`** | Unchanged (`a93a4387...`, `f220fab2...`); verified live across `G333-02`, `Gate 31.5` (`23/23 PASS`), `Gate 32.3` (`14/14 PASS`), and `Gate 29.4` (`18/18 PASS` on `v1.0.8-final-rc`). |
| 8 | Native Messaging stdio & HTTP fallback compatibility | **`READY`** | Verified Chrome, Edge & Firefox registry registration (`G333-08`), stdio `ping -> pong` (`G323-12`), and `tdm-native-host` `28/28 PASS`. |
| 9 | Full mandatory security tests (25+ scenarios, keyring separation, anti-escalation, compromise recovery) | **`READY`** | Verified in `external_tools_security_matrix_tests` (`5/5 PASS`), `updater_cryptography_tests` (`10/10 PASS`), `Gate 33.3` (`10/10 PASS`), `Gate 33` (`14/14 PASS`), `Expiry Monitor` (`18/18 PASS`), `Gate 32.1` (`19/19 PASS`), and `Gate 32` (`18/18 PASS`). |
| 10 | Critical downloader, UI, Progress Window, Close-to-Tray, upgrade & media pipeline tests | **`READY`** | Verified **435/435 PASS** (**282/282** Rust workspace + **153/153** Node E2E checks across all 10 suites, `0 FAIL`, `0 TIMEOUT`). |
| 11 | Production user data & OEM `v1.0.6` preservation | **`READY`** | OEM binary `570833b3...`, SQLite (`PRAGMA integrity_check=ok`, `42` rows, `355` chunks, `5` protected settings), `11` `.tdm-part` files & Chrome/Edge/Firefox Registry 100% preserved. |
| 12 | Clean Windows 10 VM QA | **`NOT TESTED`** | `0` pre-provisioned licensed Win10 VMs on host (requires clean VM run or explicit owner risk acceptance in Gate 34). |
| 13 | Clean Windows 11 VM QA | **`NOT TESTED`** | `0` pre-provisioned licensed Win11 VMs on host (requires clean VM run or explicit owner risk acceptance in Gate 34). |
| 14 | Windows Authenticode PE code signing | **`ACCEPTED LIMITATION`** | `NotSigned` (no commercial certificate configured; `signtool.exe` pipeline ready & fail-closed; Tauri Ed25519 updater signing independent and active). |
| 15 | Final release assets frozen & Git release tag `v1.0.8` held | **`READY (LOCAL FROZEN / UNTAGGED)`** | `release/v1.0.8-final-rc/` frozen and verified locally; Git tag `v1.0.8` and reserved `checkpoint-gate33_3-final-rc-verified` intentionally NOT created. |
| 16 | Rollback readiness confirmed (`v1.0.8 -> v1.0.7`, atomic tool rollback, emergency `rev 3` plan) | **`READY`** | Verified in `G332-LIVE-05..06`, `G32-13/16`, `G321-13..15`, and backward-compatible SQLite schema. |
| 17 | Explicit project-owner authorization for Gate 34 Desktop `v1.0.8` public publication | **`BLOCKED`** | Public release is **NOT AUTHORIZED** in Gate 33.3 and requires separate explicit Gate 34 owner authorization (including explicit acceptance or resolution of `BACKUP_VERIFICATION_DEFERRED_BY_OWNER`). |
