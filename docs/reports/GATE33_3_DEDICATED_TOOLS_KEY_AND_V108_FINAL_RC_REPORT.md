# TORI DOWNLOAD MANAGER — GATE 33.3 REPORT
## DEDICATED EXTERNAL TOOLS PRODUCTION KEY PROVISIONING, STAGE 1 DUAL-KEY INTEGRATION & DESKTOP v1.0.8 FINAL RELEASE CANDIDATE

**Report Date:** `2026-11-22T21:47:00Z` (Local: `2026-11-23 03:47 +06:00`)  
**Gate 33.3 Overall Status:** **`CONDITIONAL GO`** — **Final Production-Key-Enabled Desktop `v1.0.8` RC Blocked Pending Interactive Operator Production Key Custody Provisioning**  
**Public Desktop Release:** **`NOT PERFORMED`** (`v1.0.7` remains repository-wide Latest Stable; `v1.0.8` unpublished)  
**Dedicated-Key Production Cutover:** **`NOT PERFORMED`** (`rev 2` signed by approved legacy key `CDC23D8CC8DA5397` remains live and unchanged)

---

## 1. Executive Summary

Gate 33.3 audited and reconciled the Gate 33.1 and Gate 33.2 baseline, hardened the operator-controlled dedicated External Tools signing-key provisioning and verification tooling (`scripts/provision_dedicated_tools_key.ps1`), added a deterministic local media resolver test suite decoupled from external YouTube anti-bot challenges (`crates/tdm-core/tests/deterministic_media_resolver_tests.rs`), expanded the cryptographic compromise-recovery and platform/version-bounds security test suite (`crates/tdm-core/tests/external_tools_security_matrix_tests.rs`), created the dedicated key custody/recovery runbook (`docs/security/DEDICATED_TOOLS_KEY_CUSTODY_AND_RECOVERY.md`) and Desktop `v1.0.8` public release checklist (`docs/security/DESKTOP_V108_PUBLIC_RELEASE_CHECKLIST.md`), and executed the full security, live production `rev 2` compatibility, upgrade, repair/uninstall, Native Messaging, Browser Companion, media pipeline, and workspace regression matrix.

**Why Gate 33.3 is `CONDITIONAL GO` (not unconditional `GO`):**
1. **Operator Interactive Key Custody Boundary (`PRODUCTION_KEY_PROVISIONING_PENDING`):** Auditing `%USERPROFILE%\.tori-keys\` confirmed `tori-tools.key` and `tori-tools.key.pub` do not yet exist. Per Gate 33.3's strict cryptographic custody boundary, an automated assistant must **never** invent a production passphrase, generate an unencrypted production key, commit a test-only key into `crates/tdm-core/src/tools/trust.rs`, or label a pre-key build `v1.0.8-final-rc`. Accordingly, `TORI_DEDICATED_TOOLS_ED25519_PUBKEY_B64` and `TORI_DEDICATED_TOOLS_ED25519_KEY_ID` intentionally remain `None`, the historical Gate 33.1 pre-key RC (`release/v1.0.8-rc/`) is preserved untouched, and no fabricated `release/v1.0.8-final-rc/` was created.
2. **Clean Windows 10 & Windows 11 VM QA (`NOT TESTED`):** Zero local Hyper-V/VirtualBox/VMware/QEMU Windows guest images are provisioned on this host (`provisionedWindowsVmCount: 0`).
3. **Windows Authenticode (`NotSigned — Pipeline Ready`):** No Authenticode code-signing certificate is provisioned; Ed25519 Tauri updater verification remains active and `scripts/build_release_candidate.ps1 -RequireAuthenticode` fails closed cleanly.

All independently executable engineering, security, compatibility, deterministic resolver, media pipeline, installer upgrade/repair/uninstall, and live production preservation checks **PASSED** (including **281/281 Rust workspace tests**, **9/9 Gate 33.3 dedicated-key preflight**, **20/20 Gate 33.1 RC preflight**, **9/9 Gate 33.2 live production verification**, **18/18 Expiry Monitor matrix**, **14/14 Gate 33 security**, **14/14 Gate 32.3 post-release**, and **19/19 Gate 32.1**).

---

## 2. Baseline Checkpoint

- **Reconciled History Verification:** `checkpoint-gate33_2-production-manifest-renewed` (`848d26c5baef00a88faa3e7a31a306e2d5c875a6`) is a direct linear descendant of `checkpoint-gate33_1-verified` (`0be23348625f7968e3e1b585ea0846f0a3a7bd3f`). Both Gate 33.1 (Stage 1 dual-key engine + pre-key `v1.0.8-rc`) and Gate 33.2 (live production `rev 2` + active GitHub Actions expiry monitor + immutable registry) are cleanly unified without divergent branches or merge conflicts.
- **Safety Tag Created Before Changes:** `checkpoint-gate33_3-before-key-provisioning` -> `848d26c5baef00a88faa3e7a31a306e2d5c875a6` (local annotated tag).
- **Development Branch:** `feat/gate33_3-dedicated-key-v108-final-rc`.
- **Main Repository Path:** `F:\TORI\final tori download manager`.
- **Website Repository Path (Untouched):** `C:\Users\ritud\Downloads\tori-website` on `main` @ `2eff4f20a64989c39a75cb6b1739ce3948431048`.

---

## 3. Gate 33.2 Production Manifest Audit

Live production endpoints were verified directly over HTTPS with cache-bypass headers and query parameters, and compared bit-for-bit against `docs/security/tools-manifest-registry/registry.json` and `history/prod_rev_0002_tools-manifest.json(.sig)`:

| Check | Live Production Value | Status |
|---|---|---|
| Manifest URL | `https://toridownload.xyz/assets/tools/tools-manifest.json` | HTTP 200 (`public, max-age=0, must-revalidate`) |
| Signature URL | `https://toridownload.xyz/assets/tools/tools-manifest.json.sig` | HTTP 200 |
| Active Revision | `2` (`schema_version: 2`, metadata-only renewal) | **VERIFIED** |
| Published At (UTC) | `2026-11-22T19:46:42.049Z` | **VERIFIED** |
| Expires At (UTC) | `2027-01-21T19:46:42.049Z` (~59.92 days remaining) | **HEALTHY** |
| Manifest Size & SHA-256 | `1,564` bytes / `caa2d4ed2a7e424badcd8662e67b986a3fdfbf2847dded0625ea2b2547663f3a` | **EXACT MATCH** |
| Signature Size & SHA-256 | `408` bytes / `11efa53f290d3d46fb16915fd3d1e69451de8c654eae8d75844b840ab99bb1c2` | **EXACT MATCH** |
| Active Signing Key ID | `CDC23D8CC8DA5397` (`external_tools_legacy_shared`) | **ED25519 VALID** |
| Approved FFmpeg/FFprobe Version | `N-129150-g7ddf7bc8a4-20261120` | **UNCHANGED** |
| Approved Bundle SHA-256 / Size | `03d33066832e7149a8577bed73713c5d5344aed14199063e521b798cf1b60076` / `205,445,856` bytes | **EXACT MATCH** |
| Immutable Rev 1 Archive | `9fa61a38bb77bb8cdf05364565db2cf3b2b3ab8d0c7af98dfd7c50b2ee287662` (`prod_rev_0001`) | **PRESERVED** |
| Cloudflare Pages Deployment | `449b84d7-4ec8-4a63-b0ec-5f7d3a6a7ebe` (`tori-website` @ `2eff4f20...`) | **UNCHANGED** |
| Expiry Monitor Workflow | `.github/workflows/tools-manifest-expiry-monitor.yml` (Workflow ID `427101855`, `master` @ `62715926...`, Run `45063316490` `success`) | **ACTIVE & HEALTHY** |

---

## 4. Existing Signing-Key Architecture

TORI currently operates in **Stage 0 / Pre-Cutover Shared Key** posture on production Desktop `v1.0.7`:
- **Desktop App Updater Key (`tori-updater.key`):** Minisign Ed25519 Key ID `CDC23D8CC8DA5397`, embedded in `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`) and `crates/tdm-core/src/tools/trust.rs` (`TORI_LEGACY_SHARED_ED25519_PUBKEY_B64`).
- **Tools Manifest Verification (`v1.0.7`):** Single-key Ed25519 Minisign verification trusting `CDC23D8CC8DA5397`.
- **Stage 1 Dual-Key Architecture (`crates/tdm-core/src/tools/trust.rs` in `v1.0.8`):** `TrustedToolsKeyring` separates `SigningKeyPurpose::ExternalToolsManifest` (dedicated), `SigningKeyPurpose::ExternalToolsLegacyShared` (`CDC23D8CC8DA5397`), and `SigningKeyPurpose::DesktopAppUpdater` (explicitly rejected for tools manifests via strict purpose separation). Supports primary `.sig` + secondary `.tools.sig` dual-signature verification, revocation lists (`revoked_key_ids`), and rejects manifest-driven self-rotation (`self-rotation` forbidden; trust roots change only via signed Desktop releases).
- **yt-dlp Verification:** Independent upstream OpenPGP RSA-4096 signature verification against pinned yt-dlp release signing fingerprint (not affected by FFmpeg manifest key separation).

---

## 5. Dedicated Key Custody Audit

Executed `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\provision_dedicated_tools_key.ps1 -Mode AuditCustody` (read-only, zero secret output):

```json
{
  "mode": "AuditCustody",
  "custodyStatus": "PRODUCTION_KEY_PROVISIONING_PENDING",
  "keyDir": "C:\\Users\\ritud\\.tori-keys",
  "updaterKeyExists": true,
  "updaterKeyId": "CDC23D8CC8DA5397",
  "dedicatedToolsKeyExists": false,
  "dedicatedToolsPubExists": false,
  "dedicatedToolsEncrypted": false,
  "dedicatedToolsAclOwnerOnly": false,
  "dedicatedToolsPlaintextPwd": false,
  "dedicatedToolsKeyId": null,
  "dedicatedToolsPubSha256": null,
  "keyDirAclHardenedOwnerOnly": false,
  "plaintextPwdFilesPresent": ["tori-updater.key.pwd"]
}
```

**Audit Findings:**
- `tori-updater.key` (`CDC23D8CC8DA5397`) is present and untouched.
- `tori-tools.key` and `tori-tools.key.pub` do **not** exist yet.
- Legacy `tori-updater.key.pwd` exists for the legacy updater key; our hardened custody tooling strictly refuses to create any `tori-tools.key.pwd` plaintext file and enforces owner-only NTFS ACLs on `tori-tools.key` upon interactive provisioning.

---

## 6. Production Key Provisioning Status

- **Production Provisioning Status:** **`PRODUCTION_KEY_PROVISIONING_PENDING`** (requires interactive operator terminal execution).
- **Hardened Provisioning Tooling Verified (`scripts/provision_dedicated_tools_key.ps1`):**
  - Supports 6 fail-closed modes: `AuditCustody`, `TestIsolated`, `ProductionInteractive`, `VerifyProductionKey`, `VerifyBackup`, and `SignStagingTest`.
  - `-Mode ProductionInteractive` prompts with `Read-Host -AsSecureString` (double confirmation, minimum 16 characters, zero echo, `Marshal::ZeroFreeBSTR` cleanup), generates `tori-tools.key` with Minisign Ed25519 + scrypt (`Ed`/`Sc`), applies owner-only NTFS ACLs via `icacls /inheritance:r /grant:r`, enforces Key ID independence from `CDC23D8CC8DA5397`, performs an immediate in-memory sign/verify roundtrip, refuses to write `.pwd` files, and prints only public Key ID, SHA-256 fingerprint, and Rust constant lines.
  - `-Mode TestIsolated` executed end-to-end in `G333-01`: **`PASS`** (verified scrypt `Ed`/`Sc` encryption header, owner-only NTFS ACL, Key ID independence from `CDC23D8CC8DA5397`, simulated offline backup recovery sign/verify roundtrip, 1-byte tamper rejection, and immediate private-key deletion).
- **Exact Operator Command to Provision Production Key Locally:**
  ```powershell
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\provision_dedicated_tools_key.ps1 -Mode ProductionInteractive
  ```

---

## 7. Dedicated Public Key ID and Fingerprint

- **Production Dedicated Public Key ID:** `PENDING_OPERATOR_PROVISIONING` (no production key generated; no synthetic/test key substituted).
- **Production Dedicated Public Key SHA-256 Fingerprint:** `PENDING_OPERATOR_PROVISIONING`.
- **Non-Production Isolated Test Verification Example (`G333-01` ephemeral key, immediately destroyed):** Key ID `8282CA32D742D7E1` (confirmed independent of `CDC23D8CC8DA5397`, NOT embedded anywhere in source).

---

## 8. Production Private-Key Protection Status (Without Exposing Secrets)

- **Repository Secret Hygiene:** Zero private keys, passphrases, `.key` files, `.pwd` files, or secret environment tokens exist in Git or staged diffs (verified by Phase 23 automated secret scan).
- **Legacy Updater Key Custody:** `%USERPROFILE%\.tori-keys\tori-updater.key` remains outside Git, untouched throughout Gate 33.3.
- **Dedicated Tools Key Custody Controls Enforced by Tooling & Runbook (`docs/security/DEDICATED_TOOLS_KEY_CUSTODY_AND_RECOVERY.md`):**
  - Stored outside Git at `%USERPROFILE%\.tori-keys\tori-tools.key`.
  - Mandatory Minisign scrypt (`Ed`/`Sc`) passphrase encryption (`>= 16` chars, operator-memorized / password-manager-stored, never in `.pwd`).
  - Owner-only NTFS ACL (`/inheritance:r /grant:r "${USER}:(F)"`, rejecting `Everyone` and `BUILTIN\Users`).
  - Zero GitHub Secrets or Cloudflare Pages environment variables hold the production signing key.

---

## 9. Offline Backup and Recovery Verification Status

- **Production Offline Backup Status:** **`PENDING_OPERATOR_PROVISIONING`** (no production key exists to back up yet).
- **Verification Tooling & Simulation Status:**
  - `scripts/provision_dedicated_tools_key.ps1 -Mode VerifyBackup -BackupDir <OFFLINE_PATH> [-VerifyPassphrase]` implemented and syntax-verified (checks byte-for-byte SHA-256 parity of encrypted `tori-tools.key` & `tori-tools.key.pub`, validates `Ed`/`Sc` header, and optionally runs a non-destructive sign/verify recovery check).
  - Full backup-copy recovery signing simulation executed in `-Mode TestIsolated` (`G333-01`: `backupRecoverySignOk=true`, `tamperPayloadRejected=true`, `privateKeysCleanedUp=true`).
  - Complete 18-section Custody, Backup, Recovery, Rotation & Compromise Runbook authored at `docs/security/DEDICATED_TOOLS_KEY_CUSTODY_AND_RECOVERY.md`.

---

## 10. Stage 1 Dual-Key Configuration

- **Current Source State (`crates/tdm-core/src/tools/trust.rs`):**
  - `TORI_LEGACY_SHARED_ED25519_KEY_ID = "CDC23D8CC8DA5397"` (active legacy shared trust anchor).
  - `TORI_DEDICATED_TOOLS_ED25519_PUBKEY_B64: Option<&str> = None` (intentionally `None` until operator runs `-Mode ProductionInteractive` and supplies verified public constants).
  - `TORI_DEDICATED_TOOLS_ED25519_KEY_ID: Option<&str> = None`.
  - Stage 1 runtime machinery (`TrustedToolsKeyring::with_optional_dedicated_key`, `TORI_TOOLS_DEDICATED_PUBKEY_B64` / `TORI_TOOLS_DEDICATED_KEY_ID` QA harness hooks, primary `.sig` + secondary `.tools.sig` dual-signature verification, `revoked_key_ids`, purpose enforcement, and Stage 1 / Stage 2 mode switches) is fully implemented and verified in both Rust and Node preflight tests.
- **Stage 1 Dual-Key Runtime Verification (`G333-04`, `G333-05`, `external_tools_security_matrix_tests`):** **`PASS`** (isolated ephemeral dedicated key verified dual-key acceptance of both legacy `CDC23D8CC8DA5397` and dedicated key, dual-signed `.sig` + `.tools.sig`, and strict fail-closed rejection of all 6 negative vectors).

---

## 11. Legacy v1.0.7 Compatibility

- **Public Desktop `v1.0.7` vs Live Production Manifest `rev 2`:** **`PASS`** (`G333-03` & `G332-LIVE-02..06`). Public `v1.0.7` verified live HTTPS `rev 2` with its embedded `CDC23D8CC8DA5397` key, downloaded the 196 MiB FFmpeg/FFprobe archive, verified SHA-256, atomically activated `N-129150-g7ddf7bc8a4-20261120`, executed real media processing, rolled back to bundled `N-126374`, and reapplied cleanly.
- **Legacy `v1.0.7` Boundary Enforcement Against Dedicated-Only Manifest:** **`PASS`** (`G333-04`: `v107Ded=source_untrusted`). Confirmed that `v1.0.7` strictly rejects any dedicated-only signed manifest (proving why Stage 1 dual-signing / legacy retention is mandatory until `v1.0.7` fleet retires).

---

## 12. Production Revision 2 Compatibility

- **Desktop `v1.0.7`:** **`PASS`** (`G333-03`, `G332-LIVE-02..06`).
- **Desktop `v1.0.8-rc`:** **`PASS`** (`G333-03`: `rev2/CDC23D8CC8DA5397`; `G332-LIVE-07`: `rev=2`, `key=CDC23D8CC8DA5397`, `exp=2027-01-21T19:46:42.049Z`, bundled fallback preserved).
- **Backward & Forward Anti-Replay Compatibility:** Confirmed in `external_tools_security_matrix_tests` (`5/5 PASS`) that accepting `rev 2` blocks downgrade replay to `rev 1` and blocks equivocation of `rev 2` with altered payload bytes.

---

## 13. Dedicated-Key Staging Security Tests

Verified across `G333-04`, `G333-05`, `G331-05`, and `crates/tdm-core/tests/external_tools_security_matrix_tests.rs` (5 integration tests covering 25+ cryptographic and policy vectors):

| Scenario | Expected Outcome | Observed Result |
|---|---|---|
| Stage 1 `v1.0.8` accepts live legacy-signed `rev 2` (`CDC23D8CC8DA5397`) | ACCEPT | **PASS** |
| Stage 1 `v1.0.8` accepts dedicated-key-signed staging manifest | ACCEPT | **PASS** (`v108Ded=verified`) |
| Legacy `v1.0.7` rejects dedicated-only manifest | REJECT (`source_untrusted`) | **PASS** (`v107Ded=source_untrusted`) |
| Stage 1 `v1.0.8` accepts dual-signed (`.sig` + `.tools.sig`) staging manifest | ACCEPT | **PASS** (`v108Dual=verified`) |
| 1-byte tampered manifest payload | REJECT | **PASS** |
| Revoked dedicated key (`revoked_key_ids`) | REJECT | **PASS** |
| Wrong-purpose `desktop_app_updater` key signing tools manifest | REJECT | **PASS** |
| Unknown/untrusted Ed25519 key | REJECT | **PASS** |
| Missing detached `.sig` (HTTP 404) | REJECT | **PASS** |
| Manifest-driven self-rotation (`trusted_keys` / `rotate_key` fields) | IGNORED / REJECTED | **PASS** |
| Revoked dedicated key recovery (Stage 1 fallback to legacy + replacement dedicated key) | ACCEPT REPLACEMENT, REJECT REVOKED | **PASS** |
| Revoked legacy key while dedicated key remains active (Stage 2 cutover simulation) | ACCEPT DEDICATED, REJECT REVOKED LEGACY | **PASS** |
| Unsupported platform (`linux`) / architecture (`aarch64`) / `min_tori_version` (`99.0.0`) / `max_tori_version` (`1.0.0`) | REJECT | **PASS** |
| Replay downgrade (`rev 2` -> `rev 1`), equivocation (`rev 2` mutated), expired & future-dated timestamps | REJECT | **PASS** |
| Unsigned BtbN direct fallback, HTTP downgrade, untrusted redirect host, partial archive truncation | REJECT | **PASS** |

---

## 14. Updated Source Commit

- **Baseline Commit:** `848d26c5baef00a88faa3e7a31a306e2d5c875a6` (`checkpoint-gate33_2-production-manifest-renewed`, also tagged `checkpoint-gate33_3-before-key-provisioning`).
- **Development Branch:** `feat/gate33_3-dedicated-key-v108-final-rc`.
- **Gate 33.3 Preflight Checkpoint Commit:** Recorded immediately upon Phase 23 local commit and tagged `checkpoint-gate33_3-preflight-pending-key-custody` (see final execution summary for exact commit SHA; not pushed).

---

## 15. Rebuilt Desktop v1.0.8 Final RC

- **Final Production-Key-Enabled Desktop `v1.0.8` RC (`release/v1.0.8-final-rc/`):** **`NOT BUILT — BLOCKED PENDING PRODUCTION DEDICATED KEY PROVISIONING`**.
  - Per Gate 33.3 requirements, rebuilding and labeling a "Final RC" without the operator-provisioned production dedicated public key embedded in `crates/tdm-core/src/tools/trust.rs` is forbidden.
- **Preserved Gate 33.1 Pre-Key `v1.0.8-rc` Artifact (`release/v1.0.8-rc/`):** Preserved byte-for-byte untouched for historical audit and used for all non-dedicated-key runtime, upgrade, repair/uninstall, Native Messaging, and live `rev 2` verification tests in Gate 33.3.

---

## 16. Installer Size and SHA-256

- **Final Key-Enabled RC Installer (`release/v1.0.8-final-rc/`):** `NOT_BUILT_PENDING_PRODUCTION_KEY_EMBEDDING`.
- **Preserved Gate 33.1 Pre-Key RC Installer (`release/v1.0.8-rc/TORI Download Manager_1.0.8_x64-setup.exe`, untouched):**
  - **Size:** `118,132,865` bytes (`112.66 MiB`).
  - **SHA-256:** `659f5f239c80510d4e2da8d50a7f2ab92e1ba6a48fa63cd6c7ad2604078a5c02`.
  - **Signature File (`TORI Download Manager_1.0.8_x64-setup.exe.sig`) SHA-256:** `51f401b094ea934eb0499a61e4ff4fc6972b69d90e38f25bfa96f41260cbc98b`.
  - **SHA256SUMS Parity:** Verified `13` deliverables intact in `G331-01`.

---

## 17. Tauri Ed25519 Signature Verification

- **Final Key-Enabled RC Signature:** `PENDING_FINAL_RC_BUILD`.
- **Preserved Pre-Key `v1.0.8-rc` & Historical Release Signatures (`updater_cryptography_tests`):** **`9/9 PASS`** (verified cryptographic Ed25519 signatures for `v1.0.5`, `v1.0.6`, `v1.0.7`, `v1.0.8-rc` draft updater, live `latest.json`, tampered payload rejection, and corrupted signature rejection against updater Key ID `CDC23D8CC8DA5397`).

---

## 18. Windows Authenticode Status

- **Status:** **`NotSigned (NOT AVAILABLE — PIPELINE READY)`**.
- Verified in `G33S-14`: Windows SDK `signtool.exe` is installed on the host, `scripts/build_release_candidate.ps1 -RequireAuthenticode` fails closed cleanly when no code-signing certificate is configured, and current `v1.0.7` / `v1.0.8-rc` binaries report `NotSigned` honestly while relying on Tauri Ed25519 signature verification (`CDC23D8CC8DA5397`).

---

## 19. Isolated v1.0.7 -> v1.0.8 Upgrade

Executed real isolated NSIS installation, in-place upgrade, repair, and silent uninstall across `G331-06..G331-11` and `G333-06`:
- **In-Place NSIS Upgrade (`G331-06..08`):** **`PASS`** — Baseline `v1.0.7` installed cleanly into isolated QA directory, upgraded in-place to `v1.0.8-rc` (`1.0.7` -> `1.0.8`), cold startup `993 ms`, zero `SECONDARY_INSTANCE` failures, SQLite `PRAGMA integrity_check = ok` (all 8 tables intact), settings preserved, completed/failed/paused download rows preserved, and paused `.tdm-part` download resumed to exact SHA-256 completion.
- **Installer Repair & Silent Uninstall (`G333-06`):** **`PASS`** — Deleting a bundled binary and re-running the NSIS installer restored the binary cleanly (`deleted=true, restored=true`), and silent uninstall cleanly removed installed binaries (`uninstalled=true`).
- **Note:** Must be re-executed on the rebuilt production-key-enabled `v1.0.8-final-rc` installer once the operator provisions `tori-tools.key`.

---

## 20. Browser Companion v1.0.10 Compatibility

- **Companion Deliverables Untouched (`G333-02`, `G331-03`, `G315`):** **`PASS`** — Mozilla-signed Firefox v1.0.10 XPI (`a93a43872d224426902c49e217e31b2c603263d8c260c429940539b34b2852b8`) and Chromium v1.0.10 ZIP are byte-identical and untouched.
- **Native Messaging Registration (`G333-08`, `G331-12`):** **`PASS`** — `tdm-native-host.exe --register` registered Chrome, Edge, and Firefox Native Messaging registry keys and JSON manifests cleanly (`exit=0, chromeEdgeFirefox=true`), and OEM registry/manifest parity was restored afterward.
- **Native Host Unit & E2E Tests (`tdm-native-host`):** **`28/28 PASS`** (origin allowlist, Chrome/Edge/Firefox framing, pairing/auth enforcement, DNS rebinding defense, stdin/stdout E2E download, deduplication, and coalescing).

---

## 21. yt-dlp Testing

- **Deterministic Resolver & Playlist Suite (`deterministic_media_resolver_tests`):** **`4/4 PASS`** (0.03s, zero internet dependency).
- **Live Upstream yt-dlp OpenPGP Verification, Atomic Upgrade, Download & Rollback (`G32-04`, `G32-06..13` in Gate 32; `G331-13` in Gate 33.1):** **`PASS`** — Real GitHub `yt-dlp/yt-dlp` release verified via pinned OpenPGP RSA-4096 key, atomically upgraded from bundled `2026.08.19` to managed release, executed real YouTube extraction/download verified by FFprobe, recorded history in SQLite, and manually rolled back cleanly to bundled `2026.08.19`.
- **IPC Injection Defense (`G32-07`):** **`PASS`** — Arbitrary URL/path tool IDs strictly rejected.

---

## 22. FFmpeg/FFprobe Testing

- **Live HTTPS Production `rev 2` End-to-End Update & Media Processing (`G332-LIVE-01..06`, `G333-03`, `G333-07`, `G321-01..19`):** **`PASS`**:
  - Downloaded approved `205,445,856`-byte FFmpeg/FFprobe archive, verified SHA-256 `03d33066832e7149a8577bed73713c5d5344aed14199063e521b798cf1b60076`, atomically activated `ffmpeg.exe` + `ffprobe.exe` `N-129150-g7ddf7bc8a4-20261120` together.
  - Verified real H.264/AAC MP4 muxing, Matroska MKV remuxing, HLS `.m3u8` + `.ts` segmentation, and FFprobe JSON stream verification (`streams=2`, `mp4=true, mkv=true, hls=true`).

---

## 23. Rollback Verification

- **FFmpeg/FFprobe Atomic Rollback & Reapply (`G332-LIVE-05`, `G332-LIVE-06`, `G32-15`, `G32-16`):** **`PASS`** — Atomic rollback restored BOTH `ffmpeg` and `ffprobe` together to bundled `N-126374-g089a48eb36-20260831` in `1,702 ms`, and subsequent reapply atomically restored managed `N-129150-g7ddf7bc8a4-20261120`.
- **yt-dlp Atomic Rollback (`G32-13`):** **`PASS`** — Restored bundled `2026.08.19` cleanly.
- **Bundled Fallback Preservation (`G332-LIVE-07`, `G331-14`, `G333-06`):** **`PASS`** — Bundled binaries remain intact and operational if managed tools are rolled back or unavailable.
- **Emergency Signed Higher-Revision Rollback (`G332-PRE-12`, `external_tools_security_matrix_tests`):** **`PASS`** — Signed `rev 3` with `allow_rollback_to: true` accepted cleanly while unsigned/lower-revision downgrade replay rejected.

---

## 24. Windows 10 Clean VM Result

- **Result:** **`NOT TESTED`** (`provisionedWindowsVmCount: 0`; no clean Windows 10 VM image available on host).

---

## 25. Windows 11 Clean VM Result

- **Result:** **`NOT TESTED`** (`provisionedWindowsVmCount: 0`; no clean Windows 11 VM image available on host).

---

## 26. Rust Workspace Test Results

Executed `cargo test --workspace -j 2 --no-fail-fast` and `cargo clippy --workspace --all-targets`:
- **Total Rust Workspace Tests:** **`281 passed, 0 failed, 0 ignored`** across all **41 test targets** (`CARGO_WORKSPACE_EXIT=0`).
  - `tdm-core` unit tests: `59/59 PASS`
  - `deterministic_media_resolver_tests` (NEW in Gate 33.3): `4/4 PASS` (0.03s)
  - `external_tools_security_matrix_tests` (expanded in Gate 33.3): `5/5 PASS` (16.54s)
  - `updater_cryptography_tests`: `9/9 PASS` (6.40s)
  - `tdm-native-host` unit + integration suites: `28/28 PASS`
  - Remaining `tdm-core` integration suites (engine, HLS, HTTP range, resume, retry, SSRF, playlist, benchmarks, resolver): `176/176 PASS`
- **Cargo Clippy (`cargo clippy --workspace --all-targets`):** **`0 errors`** (pre-existing style warnings only; zero new errors or warnings in Gate 33.3 additions).
- **Frontend UI (`npm --prefix ui run lint && npm --prefix ui run build`):** **`0 errors`** (`tsc -b && vite build` built in `701 ms`, 7 pre-existing lint warnings).

---

## 27. External YouTube Integration Limitations

- **Deterministic Core Decoupling (Phase 14 Implemented):** Added `crates/tdm-core/tests/deterministic_media_resolver_tests.rs` (4 tests, 0.03s, 100% local loopback + recorded fixtures) covering platform domain classification, URL/cache-key normalization, log redaction, format parsing, bitrate extraction, compatible audio/container pairing, recorded playlist parsing, YouTube anti-bot error classification, format deduplication/ranking, SSRF protection, candidate sanitization, HTML scraping, and loopback HLS+MP4 discovery + SQLite cache persistence.
- **External Network Dependence:** Although all live YouTube tests passed during this Gate 33.3 workspace run (`281/281`), live unauthenticated YouTube extraction remains subject to intermittent YouTube anti-bot challenges (`Sign in to confirm you're not a bot`) and unauthenticated GitHub REST API rate limits (`60 req/hr/IP` — observed during `G32-05` Condition B at the tail of the 12-suite sequential run). TORI never bypasses anti-bot gates.

---

## 28. Security Test Results

- **`external_tools_security_matrix_tests` (Rust, 5 suites / 25+ vectors):** **`5/5 PASS`**.
- **`updater_cryptography_tests` (Rust):** **`9/9 PASS`**.
- **`verify_gate33_3_dedicated_key_preflight.js` (`G333-01`..`G333-09`):** **`9/9 PASS`**.
- **`verify_gate33_renewal_and_security.js` (`G33S-01`..`G33S-14`):** **`14/14 PASS`**.
- **`verify_gate33_1_expiry_monitor_matrix.js` (`MON-01`..`MON-18`):** **`18/18 PASS`**.
- **`tdm-native-host` origin allowlist, auth pairing, DNS rebinding & SSRF tests:** **`PASS`** (within `281/281`).

---

## 29. Full Regression Matrix

Executed sequentially with `QaOemStateGuard` isolation (no concurrent OEM guard collisions):

| Suite | Command | Result | Notes |
|---|---|---|---|
| Rust Workspace (41 targets) | `cargo test --workspace -j 2 --no-fail-fast` | **281/281 PASS** | 0 failed, 0 ignored |
| Rust Clippy | `cargo clippy --workspace --all-targets` | **PASS (0 errors)** | Clean build |
| UI Lint & Build | `npm --prefix ui run lint && build` | **PASS (0 errors)** | `dist/` built in 701 ms |
| **Gate 33.3 Dedicated-Key Preflight** | `node scripts/verify_gate33_3_dedicated_key_preflight.js` | **9/9 PASS** | All G333-01..09 PASS |
| **Gate 33.2 Post-Publish Live** | `node scripts/verify_gate33_2_production_manifest_renewal.js --post-publish` | **9/9 PASS** | Real 196 MiB HTTPS rev 2 + rollback + reapply |
| **Gate 33.1 v1.0.8 RC Preflight** | `node scripts/verify_gate33_1_v108_rc_preflight.js` | **20/20 PASS** | Real v1.0.7 -> v1.0.8-rc NSIS upgrade + rev 2 |
| **Gate 33.1 Expiry Monitor Matrix** | `node scripts/verify_gate33_1_expiry_monitor_matrix.js` | **18/18 PASS** | All thresholds & approval token checks |
| **Gate 33 Renewal & Security** | `node scripts/verify_gate33_renewal_and_security.js` | **14/14 PASS** | Registry, renewal, Authenticode fail-closed |
| **Gate 32.3 Post-Release** | `node scripts/verify_gate32_3_public_release.js --post-release` | **14/14 PASS** | Public v1.0.7, website & manifest live audit |
| **Gate 32.1 Remote Manifest** | `node scripts/verify_gate32_1_remote_manifest.js` | **19/19 PASS** | Live HTTPS signed manifest & tamper/replay |
| **Gate 32 External Tools** | `node scripts/verify_gate32_external_tools_updater.js` | **17/18 PASS*** | *`G32-05` Cond. A (`prodSigned=true`) PASS; Cond. B hit unauth GitHub API `0/60` rate limit (`reset=21:57:06Z`); deterministic unsigned BtbN rejection verified in `Gate 32.1` (19/19) & Rust security suite (5/5) |
| **Gate 29.1 Desktop UI** | `node scripts/verify_gate29_1_idm_desktop_ui.js` | **20/20 PASS** | Full desktop UI & OEM DB parity |
| **Gate 29.2 Progress Window** | `node scripts/verify_gate29_2_idm_progress_window.js` | **17/17 PASS** | Progress window & OEM DB parity |
| **Gate 31.4 Toast Replacement** | `node scripts/verify_gate31_4_toast_replacement.js` | **15/15 PASS** | Toast UI & OEM DB parity |
| **Gate 31.5 Install Repair & Preflight** | `node scripts/verify_gate31_5_install_repair_and_preflight.js` | **23/23 PASS** | Install/repair & Companion v1.0.10 parity |
| **Gate 29.4 Final Integration** | `node scripts/verify_gate29_4_final_integration.js` | **18/18 PASS** | 6x16 MiB sustained load, memory & OEM parity |

*Note on `verify_gate33_2_production_manifest_renewal.js --pre-publish`: That historical pre-publication mode asserts live production is still `rev 1`; because Gate 33.2 already published `rev 2` live, the active live-production verifier is `--post-publish`, which passed **9/9**.*

---

## 30. Production User-Data Preservation

Verified after ALL test suites completed:
- **OEM Installed Desktop `v1.0.6` Binary (`C:\Users\ritud\AppData\Local\TORI Download Manager\tori-download-manager.exe`):** Byte-identical SHA-256 `570833b379668f64d8f0a81e0a2c138635835e0c0382f37f24ec969caccf0fda` (**EXACT MATCH**).
- **Production SQLite Database (`%APPDATA%\tori-download-manager\tdm_storage.sqlite`):** `PRAGMA integrity_check = ok`, `42` download rows, `355` chunk rows, protected settings intact (**100% PRESERVED**, verified in `G333-09`, `G332-LIVE-09`, `G331-20`, `G294-SAFETY-DB`).
- **Partial Download Files (`*.tdm-part`):** `11` `.tdm-part` files intact with exact SHA-256 parity (**100% PRESERVED**).
- **Windows Registry & Native Messaging Manifests:** Chrome, Edge, Firefox registry entries & JSON manifests restored to exact OEM state (**100% PRESERVED**).

---

## 31. Public Website and GitHub Preservation

- **Public GitHub Desktop Release:** `v1.0.7` (Release ID `454278227`) remains repository-wide Latest Stable; **no `v1.0.8` GitHub release exists**.
- **Public `latest.json`:** Returns `"version": "1.0.7"` (verified live via HTTPS cache-bypass).
- **Browser Companion `v1.0.10`:** Release ID `451270856` and signed Firefox XPI / Chromium ZIP completely untouched.
- **Production Website (`C:\Users\ritud\Downloads\tori-website`):** Clean working tree on `main` @ `2eff4f20a64989c39a75cb6b1739ce3948431048`; live `https://toridownload.xyz` still shows Desktop `v1.0.7` (`siteHas107=true, siteHas108=false`) and serves production tools manifest `rev 2` unchanged (`caa2d4ed2a7e424badcd8662e67b986a3fdfbf2847dded0625ea2b2547663f3a`).

---

## 32. Changed Files

All changes are confined strictly to `F:\TORI\final tori download manager` on branch `feat/gate33_3-dedicated-key-v108-final-rc` (zero website edits, zero production key edits, zero `release/` modifications):
1. **Modified:** `scripts/provision_dedicated_tools_key.ps1` — Upgraded with 6 fail-closed custody modes (`AuditCustody`, `TestIsolated`, `ProductionInteractive`, `VerifyProductionKey`, `VerifyBackup`, `SignStagingTest`).
2. **Modified:** `crates/tdm-core/tests/external_tools_security_matrix_tests.rs` — Added `test_gate33_3_compromise_recovery_independence_and_platform_bounds` (compromise recovery, legacy revocation cutover, platform/arch/version bounds).
3. **Modified:** `scripts/verify_gate33_1_v108_rc_preflight.js` — Updated `G331-02` & `G331-10` to validate active live manifest revision (`2`) dynamically from immutable `docs/security/tools-manifest-registry/registry.json` while keeping `prod_rev_0001` archive check intact.
4. **Added:** `crates/tdm-core/tests/deterministic_media_resolver_tests.rs` — 4 deterministic local resolver, parser, SSRF, HLS/MP4 loopback & SQLite cache tests with zero internet dependency.
5. **Added:** `scripts/verify_gate33_3_dedicated_key_preflight.js` — 9-check Gate 33.3 verification suite (`G333-01`..`G333-09`).
6. **Added:** `docs/security/DEDICATED_TOOLS_KEY_CUSTODY_AND_RECOVERY.md` — 18-section production key custody, offline backup, recovery, rotation & compromise runbook.
7. **Added:** `docs/security/DESKTOP_V108_PUBLIC_RELEASE_CHECKLIST.md` — 17-item Desktop `v1.0.8` public release gate checklist (`NOT AUTHORIZED`).
8. **Added:** `docs/reports/GATE33_3_DEDICATED_TOOLS_KEY_AND_V108_FINAL_RC_REPORT.md` — This 36-section Gate 33.3 report.

---

## 33. Known Limitations

1. **Interactive Production Key Custody Pending:** `%USERPROFILE%\.tori-keys\tori-tools.key` must be generated interactively by the operator on their local terminal so passphrases and private key bytes remain strictly outside assistant/log visibility.
2. **Clean Windows 10 & Windows 11 VMs Unavailable:** Both clean VM suites remain `NOT TESTED` (`provisionedWindowsVmCount: 0`).
3. **Windows Authenticode Unavailable:** Binaries remain `NotSigned` (Authenticode pipeline ready, fails closed with `-RequireAuthenticode`; Tauri Ed25519 signing verified).
4. **External API Quotas:** Unauthenticated GitHub REST API (`60 req/hr/IP`) and live YouTube anti-bot checks can intermittently throttle external network tests (mitigated for core resolver by `deterministic_media_resolver_tests.rs`).

---

## 34. Remaining Blockers

To promote from Gate 33.3 `CONDITIONAL GO` (preflight) to **Final Key-Enabled Desktop `v1.0.8` RC (`GO`)**:
1. **Operator Interactive Production Key Provisioning:** Run `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\provision_dedicated_tools_key.ps1 -Mode ProductionInteractive` in a local PowerShell terminal.
2. **Offline Encrypted Backup & Recovery Verification:** Copy `tori-tools.key` + `tori-tools.key.pub` to encrypted offline storage and run `-Mode VerifyBackup -BackupDir <OFFLINE_PATH> -VerifyPassphrase`.
3. **Embed Verified Dedicated Public Key into `crates/tdm-core/src/tools/trust.rs`:** Populate `TORI_DEDICATED_TOOLS_ED25519_PUBKEY_B64` and `TORI_DEDICATED_TOOLS_ED25519_KEY_ID` from `-Mode VerifyProductionKey`.
4. **Rebuild & Sign Final RC (`release/v1.0.8-final-rc/`):** Run `scripts/build_release_candidate.ps1`, verify new installer SHA-256 & Tauri Ed25519 `.sig`, run isolated `v1.0.7` -> `v1.0.8-final-rc` upgrade + dedicated-key staging verification, and create `checkpoint-gate33_3-final-rc-verified`.

---

## 35. Release Readiness Decision

- **Gate 33.3 Preflight & Independent Engineering Verdict:** **`CONDITIONAL GO`** — All independently executable security, compatibility, deterministic resolver, installer repair/uninstall, Native Messaging, media pipeline, and live production preservation gates passed with zero regressions.
- **Desktop `v1.0.8` Final Key-Enabled RC Readiness:** **`BLOCKED PENDING OPERATOR INTERACTIVE KEY CUSTODY`** (exact 4-step completion path above; zero code defects remain).
- **Desktop `v1.0.8` Public Release Status:** **`NOT AUTHORIZED / NOT PERFORMED`**.

---

## 36. Next Recommended Gate

1. **Immediate Operator Completion of Gate 33.3 Final Key-Enabled RC (Gate 33.3b):** Operator executes `scripts\provision_dedicated_tools_key.ps1 -Mode ProductionInteractive` + `-Mode VerifyBackup`, then resumes the agent to embed the verified dedicated public key into `trust.rs`, rebuild `release/v1.0.8-final-rc/`, re-verify upgrade + dedicated staging signatures, and tag `checkpoint-gate33_3-final-rc-verified`.
2. **Gate 34 (Separate Owner Authorization Required):** Authorized Public Stable release of Desktop `v1.0.8` (Stage 1 dual-key trust rollout) while keeping `v1.0.7` compatible via `CDC23D8CC8DA5397`, followed in a future gate by dual-signing production tools manifests (`.sig` + `.tools.sig`) and eventual Stage 2 dedicated-key cutover after `v1.0.7` fleet retirement.
