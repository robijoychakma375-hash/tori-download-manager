# TORI Download Manager — Gate 33.1 Production Tools Key Provisioning, Backward-Compatible Manifest Renewal & Desktop v1.0.8 RC Preflight Report

**Report ID:** `TORI-GATE33_1-REPORT-001`  
**Date (UTC):** `2026-11-22T19:33:00Z`  
**Development Branch:** `feat/gate33_1-dual-key-v108-rc`  
**Baseline Checkpoint:** `2ae26bb4914ae2018af372bcd56497c70838993d` (`checkpoint-gate33-verified`)  
**Safety Tag Created:** `checkpoint-gate33_1-before-rc` (at `2ae26bb4914ae2018af372bcd56497c70838993d`)  
**Public Desktop Release Performed:** **NO (STRICTLY PROHIBITED IN GATE 33.1)**  
**Production Manifest Publication Performed:** **NO (STRICTLY PROHIBITED IN GATE 33.1)**  
**Final Gate 33.1 Verdict:** **`CONDITIONAL GO`**

---

## 1. Executive Summary

Gate 33.1 successfully executed all locally feasible engineering, cryptographic hardening, manifest renewal staging, monitoring verification, Desktop `v1.0.8-rc` packaging, physical `v1.0.7 → v1.0.8-rc` NSIS upgrade testing, cross-version `v1.0.7` vs `v1.0.8-rc` dual-key compatibility verification, External Tools validation, Browser Companion `v1.0.10` compatibility verification, and full public + OEM preservation checks without publishing any public release or mutating any live production endpoint.

Key verified outcomes:
- **Phase 2 Dedicated Tools Key Provisioning Tooling:** Implemented `scripts/provision_dedicated_tools_key.ps1` with `-Mode AuditCustody`, `-Mode TestIsolated` (passed: encrypted `Ed`/`Sc` scrypt key box, owner-only NTFS ACL, independent Key ID, 404-byte `.sig` roundtrip, immediate private-key cleanup), and `-Mode ProductionInteractive`. Audited `%USERPROFILE%\.tori-keys` honestly as **`PRODUCTION_KEY_PROVISIONING_PENDING`** because `tori-tools.key` does not exist and approved offline backup custody / interactive operator passphrase are required prior to production key creation.
- **Phase 3 Stage 1 Dual-Key Trust Readiness (`v1.0.8-rc`):** Wired compile-time dedicated External Tools key slots (`TORI_DEDICATED_TOOLS_ED25519_PUBKEY_B64`, `TORI_DEDICATED_TOOLS_ED25519_KEY_ID`), `TrustedToolsKeyring::stage1_dual_key_transition(...)`, and strict anti-trust-escalation rejection of inline key-management JSON fields (`trusted_keys`, `add_trusted_key`, `authorize_new_key`, `replace_keyring`, `rotate_pubkey`, `new_trusted_pubkey`). Verified by `external_tools_security_matrix_tests` (**4/4 PASS**) and live side-by-side binary execution across Phase 11 Scenarios A–E (**5/5 PASS**).
- **Phases 4–5 Unpublished Manifest Revision 2 Candidate:** Generated deterministic, strictly **UNSIGNED** `release/v1.0.8-rc/tools-manifest-rev2-candidate/tools-manifest.json` (`rev 2`, 45-day TTL expiring `2027-01-06T18:49:04.644Z`, unchanged approved FFmpeg `N-129150-g7ddf7bc8a4-20261120` SHA-256 `03d33066832e7149a8577bed73713c5d5344aed14199063e521b798cf1b60076`) with `RACE_PRECHECK_POLICY.json` (`expected_live_revision == 1`). All 15 Phase 5 checks verified (`G331-04`, `G331-05`) using clearly separated non-production test fixtures under `target/gate33_1_qa/non_prod_test_fixtures/`.
- **Phases 6–7 Hardened Expiry Monitor & Workflow:** Upgraded `scripts/monitor_tools_manifest_expiry.js` and `.github/workflows/tools-manifest-expiry-monitor.yml` (least-privilege `contents: read`, zero secrets, 30-day audit artifact upload). Executed all **18/18** failure simulations in `scripts/verify_gate33_1_expiry_monitor_matrix.js` (**18/18 PASS**). Workflow is validated locally and **not yet active on remote GitHub Actions schedule**.
- **Phases 8–13 Desktop `v1.0.8-rc` Build, Upgrade & Parity:** Built and Ed25519-signed `release/v1.0.8-rc/TORI Download Manager_1.0.8_x64-setup.exe` (`118,132,865` B, SHA-256 `659f5f239c80510d4e2da8d50a7f2ab92e1ba6a48fa63cd6c7ad2604078a5c02`). Passed **20/20** Gate 33.1 preflight checks (`scripts/verify_gate33_1_v108_rc_preflight.js`), including physical `v1.0.7 → v1.0.8-rc` NSIS upgrade, paused `.tdm-part` resume, standalone IDM Progress Window, Close-to-Tray, External Tools (`yt-dlp` OpenPGP update + rollback + FFmpeg H.264/AAC/MKV + FFprobe JSON), and permanent Mozilla-signed Firefox Companion `v1.0.10` XPI live MKV capture.
- **Phases 15–17 Regression & Preservation:** All **9** Node end-to-end/security suites passed **100%** (**196/196 checks**: Gate 33.1 `20/20`, Expiry Monitor Matrix `18/18`, Gate 33 Renewal/Security `14/14`, Gate 32.3 Public Invariants `14/14`, Gate 32.1 `19/19`, Gate 32 `18/18`, Gate 29.1 `20/20`, Gate 29.2 `17/17`, Gate 31.4 `15/15`, Gate 31.5 `23/23`, Gate 29.4 `18/18`). `cargo clippy --workspace --all-targets` passed with **0 errors**, `npm --prefix ui run lint && build` passed with **0 errors**, and `cargo test --workspace -j 2 --no-fail-fast` passed **270/276** (100% of non-YouTube-anti-bot tests; 6 external live-YouTube tests hit YouTube's `"Sign in to confirm you're not a bot"` anti-bot gate, which was explicitly not bypassed).
- **Why `CONDITIONAL GO` (Not Full Unconditional `GO`):** Three genuine external prerequisites remain outside automated local execution: (1) operator interactive provisioning & offline backup custody of production `tori-tools.key` (`PRODUCTION_KEY_PROVISIONING_PENDING`), (2) Clean Windows 10 & Windows 11 VM execution (`NOT TESTED` — 0 pre-provisioned licensed VMs on host), and (3) Windows Authenticode code-signing certificate (`NOT AVAILABLE — PIPELINE READY`).

---

## 2. Baseline Repository Audit

- **Main Repository:** `F:\TORI\final tori download manager`
  - Verified Gate 33 baseline commit: `2ae26bb4914ae2018af372bcd56497c70838993d` (`checkpoint-gate33-verified`)
  - Verified public Desktop `v1.0.7` release commit: `84da0c08256d6abaca253b5612010034237c86f9` (tag `v1.0.7`, `checkpoint-gate32_3-released`)
  - Safety tag created prior to edits: `checkpoint-gate33_1-before-rc` → `2ae26bb4914ae2018af372bcd56497c70838993d`
  - Active development branch: `feat/gate33_1-dual-key-v108-rc`
- **Website Repository:** `C:\Users\ritud\Downloads\tori-website`
  - Branch: `main` @ `fb42622` (`Gate 33 staging: publish isolated gate33/tools-manifest.json rev 2`)
  - Working tree status: **100% clean, zero files modified, zero commits pushed during Gate 33.1**.
- **Public Production Manifest Baseline Checked Live:**
  - Command: `node scripts/renew_trusted_tools_manifest.js --check --strict-exit`
  - Result: `OK`, `rev 1`, `remainingDays: 43.89`, `HEALTHY`, expires `2027-01-05T16:00:29.945Z`, SHA-256 `9fa61a38bb77bb8cdf05364565db2cf3b2b3ab8d0c7af98dfd7c50b2ee287662`, `.sig` SHA-256 `e0e23db79990f885c0745165299b20befd41f5dc8a73f7b00ca0476502955eb4`.

---

## 3. Production Preservation Evidence

Verified live at the conclusion of Gate 33.1 via `node scripts/verify_gate32_3_public_release.js --post-release` (**14/14 PASS**) and `G331-02`/`G331-03`/`G331-20`:

| Production Surface | Expected Invariant | Measured Post-Gate 33.1 Result | Status |
|---|---|---|---|
| GitHub Latest Stable | Desktop `v1.0.7` (Release ID `454278227`, commit `84da0c08...`) | `id=454278227`, `tag=v1.0.7`, `16` assets, installer `142e4528...` (`118,097,450` B), `.sig` `945b5efd...` (`436` B) | **PRESERVED** |
| Public `latest.json` | Version `1.0.7` pointing to `v1.0.7` installer | HTTP `200`, `version: "1.0.7"`, `pub_date: "2026-11-22T07:31:00.467Z"` | **PRESERVED** |
| Browser Companion `v1.0.10` | `extension-v1.0.10` (ID `451270856`), untouched XPI & Chromium ZIP | XPI `a93a43872d224426902c49e217e31b2c603263d8c260c429940539b34b2852b8`, Chromium ZIP `f220fab2e26fd54ef7f85fd7e40613faad79e7f9a7f44fadf228ccd0edcc22f1` | **PRESERVED** |
| Production Tools Manifest | `https://toridownload.xyz/assets/tools/tools-manifest.json` (`rev 1`) | HTTP `200`, SHA-256 `9fa61a38bb77bb8cdf05364565db2cf3b2b3ab8d0c7af98dfd7c50b2ee287662`, `.sig` `e0e23db79990f885c0745165299b20befd41f5dc8a73f7b00ca0476502955eb4` | **PRESERVED** |
| Public Website (`toridownload.xyz`) | Desktop `v1.0.7` + Companion `v1.0.10`, commit `6dd3ffd7` / repo `fb42622` | Desktop (1440×900) & Mobile (390×844) `layoutsOk=true`, `linksOk=true`, `statVer=1.0.7`, zero website modifications | **PRESERVED** |
| Immutable Rev 1 Registry Archive | `docs/security/tools-manifest-registry/history/prod_rev_0001_tools-manifest.json` | Byte-identical `9fa61a38...` | **PRESERVED** |

---

## 4. Production Key Custody Status

Audited via read-only command:
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\provision_dedicated_tools_key.ps1 -Mode AuditCustody
```

Observed output (secrets never displayed):
- **`custodyStatus`:** **`PRODUCTION_KEY_PROVISIONING_PENDING`**
- **Key directory:** `C:\Users\ritud\.tori-keys`
- **Desktop Updater Key (`tori-updater.key`):** Present, Key ID `CDC23D8CC8DA5397`, untouched throughout Gate 33.1.
- **Dedicated External Tools Key (`tori-tools.key` / `tori-tools.key.pub`):** **Not present.**
- **Existing ACL Audit Finding:** `C:\Users\ritud\.tori-keys` currently retains inherited Windows ACLs (`(I)`) and legacy plaintext password file `tori-updater.key.pwd`.
- **Policy Compliance:** In accordance with Gate 33.1 security rules, an unbacked-up production private key was **NOT** silently generated, `tori-updater.key` was **NOT** overwritten, and no `.pwd` file will ever be created for `tori-tools.key`.
- **Isolated Workflow Verification (`-Mode TestIsolated`):**
  ```powershell
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\provision_dedicated_tools_key.ps1 -Mode TestIsolated
  ```
  - Result: **`PASS`** (`encryptedSecretKey: true` verifying `rsign encrypted secret key` comment + binary `Ed`/`Sc` scrypt KDF header, `ntfsAclOwnerOnly: true`, `independentFromUpdater: true`, `testKeyIdHex: D05CEE5D593115E6`, `sigGeneratedBytes: 404`, `privateKeyCleanedUp: true`).

---

## 5. Dedicated Public Key Identity

- **Production Dedicated External Tools Key ID:** `PENDING_OPERATOR_PROVISIONING` (`Option<&str> = None` in `crates/tdm-core/src/tools/trust.rs`)
- **Production Dedicated External Tools Public Key:** `PENDING_OPERATOR_PROVISIONING` (`TORI_DEDICATED_TOOLS_ED25519_PUBKEY_B64: Option<&str> = None`)
- **Production Desktop Updater / Stage 1 Legacy Shared Key ID:** `CDC23D8CC8DA5397` (embedded in `src-tauri/tauri.conf.json` and `TORI_ED25519_PUBKEY_B64`)
- **Verification Test Keys (Non-Production Only):**
  - Phase 2 isolated provisioning QA key: `D05CEE5D593115E6` (SHA-256 `9e490f150173244191e4ee0273ee5c594b2a16c998ac3b54b7a0a2eae6466963`; private key destroyed immediately after test)
  - Phase 11 isolated loopback compatibility QA keys: Legacy test key `AA11223344556677`, Dedicated test key `BB8899AABBCCDDEE` (ephemeral in-memory during `verify_gate33_1_v108_rc_preflight.js`)

---

## 6. Stage 1 Dual-Key Configuration

Implemented in `v1.0.8-rc` across:
- `crates/tdm-core/src/tools/trust.rs`: Added `TORI_DEDICATED_TOOLS_ED25519_PUBKEY_B64: Option<&str> = None` and `TORI_DEDICATED_TOOLS_ED25519_KEY_ID: Option<&str> = None`.
- `crates/tdm-core/src/tools/types.rs`:
  - `TrustedToolsKeyring::default_production_transition()` preserves `CDC23D8CC8DA5397` as `ExternalToolsLegacyShared` (`TransitionLegacy`, `allow_legacy_shared_key: true`) and automatically registers the dedicated `ExternalToolsManifest` (`Active`) key the moment both compile-time constants are populated.
  - Added `TrustedToolsKeyring::stage1_dual_key_transition(...)` for deterministic Stage 1 dual-key construction and testing.
- `crates/tdm-core/src/tools/providers.rs`: Added strict rejection of unauthorized inline trust-escalation manifest fields (`trusted_keys`, `add_trusted_key`, `authorize_new_key`, `replace_keyring`, `rotate_pubkey`, `new_trusted_pubkey`).
- `crates/tdm-core/tests/external_tools_security_matrix_tests.rs`: Added `test_gate33_1_stage1_dual_key_and_unauthorized_trust_escalation_rejection` covering all 10 Phase 3 Stage 1 security assertions (**4/4 PASS**).

---

## 7. Legacy Client Compatibility (Phase 11 Real Cross-Version Matrix)

Verified against BOTH the real frozen **`v1.0.7`** binary (`release/v1.0.7-rc` installed via NSIS and snapshotted prior to upgrade) AND the upgraded **`v1.0.8-rc`** binary (`scripts/verify_gate33_1_v108_rc_preflight.js`):

| Scenario | Manifest Under Test | Frozen `v1.0.7` Result | Upgraded `v1.0.8-rc` Result | Check ID & Verdict |
|---|---|---|---|---|
| **A** | Live production `rev 1` (`https://toridownload.xyz/assets/tools/tools-manifest.json`, legacy `CDC23D8CC8DA5397`) | `update_available` (`N-129150-g7ddf7bc8a4-20261120`) | `verified`, `rev=1`, `update_available` (`N-129150-g7ddf7bc8a4-20261120`) | `G331-12` — **PASS** |
| **B** | Dual-signed `rev 2` (legacy `.sig` + dedicated `.tools.sig`, isolated loopback test keys) | Accepts via primary `.sig` (`update_available`) | Verifies via Stage 1 dual-key keyring (`verified`, `rev=2`, `update_available`); independent `.tools.sig` verified in `G331-05` | `G331-13` — **PASS** |
| **C** | Dedicated-key-only `rev 2` (signed solely by dedicated key `BB8899AABBCCDDEE`) | **Strictly REJECTS** (`source_untrusted`) | **Strictly ACCEPTS** (`verified`, `key=BB8899AABBCCDDEE`, `purpose=external_tools_manifest`) | `G331-14` — **PASS** |
| **D** | Invalid / tampered detached signature | **Strictly REJECTS** (`source_untrusted`) | **Strictly REJECTS** (`rejected_security`, `source_untrusted`, bundled tools intact) | `G331-15` — **PASS** |
| **E** | Higher-revision emergency rollback (`rev 3`, `allow_rollback_to=true`) + unauthorized inline `trusted_keys` escalation (`rev 4`) | N/A (`v1.0.8-rc` policy matrix) | Accepts `rev 3` rollback (`verified`, `rev=3`) and **strictly blocks** `rev 4` inline `trusted_keys` (`rejected_security`) | `G331-16` — **PASS** |

---

## 8. Manifest Revision 2 Preparation

Prepared offline using:
```powershell
node scripts\renew_trusted_tools_manifest.js --prepare --offline --unsigned --revision 2 --ttl-days 45 --out-dir release\v1.0.8-rc\tools-manifest-rev2-candidate
```

Artifacts staged in `release/v1.0.8-rc/tools-manifest-rev2-candidate/` (gitignored, unpublished):
- `tools-manifest.json` (`1,564` B, SHA-256 `af7edd089989d150bb6179c0a051e8b4669aed04fe6b564c3a44cbe1f23bdfe4`)
  - `schema_version: 2`, `manifest_revision: 2`, `signing_key_id: "CDC23D8CC8DA5397"`, `key_purpose: "external_tools_manifest"`
  - `expires_at: "2027-01-06T18:49:04.644Z"` (45-day bounded TTL)
  - Approved unchanged FFmpeg/FFprobe artifact: `N-129150-g7ddf7bc8a4-20261120`, SHA-256 `03d33066832e7149a8577bed73713c5d5344aed14199063e521b798cf1b60076`, exact size `205,445,856` B, `platform: "windows"`, `architecture: "x86_64"`, `min_tori_version: "1.0.6"`.
- `RACE_PRECHECK_POLICY.json` (`1,322` B, SHA-256 `fbba46591b15254ed735c1e0ede270ae770883be243fff7a12b389c0cc3b9874`) enforcing `expected_live_revision: 1`, `abort_if_live_revision_differs: true`, exclusive lock, and dual operator approval token prior to any future Gate 33.2 publication.
- `RENEWAL_PROPOSAL.json` (`1,114` B) and `SHA256SUMS.txt` (`86` B).
- **Signature Status:** **Strictly UNSIGNED** (`tools-manifest.json.sig` and `tools-manifest.json.tools.sig` are intentionally absent from `release/v1.0.8-rc/tools-manifest-rev2-candidate/`, verified by both `G331-01` and Rust `updater_cryptography_tests`).

---

## 9. Manifest Cryptographic Verification (Phase 5 — 15 Checks)

All 15 Phase 5 checks passed across `G331-04`, `G331-05`, and `updater_cryptography_tests`:
1. Valid JSON parsing & zero duplicate keys (`reject_duplicate_json_keys` + JS strict duplicate-key scanner) — **PASS**
2. Schema v2 & required field compliance (`schema_version == 2`, `key_purpose == external_tools_manifest`) — **PASS**
3. Strictly higher monotonic revision (`2 > 1`) — **PASS**
4. Bounded UTC TTL window (`45.0` days inside `[7..90]`) — **PASS**
5. Approved artifact URL immutability (no `/latest/`, pinned tag `tools-ffmpeg-N-129150-g7ddf7bc8a4`) — **PASS**
6. Exact SHA-256 (`03d33066...`) and byte size (`205,445,856` B) parity with immutable rev 1 registry — **PASS**
7. Platform/architecture (`windows` / `x86_64`) and `min_tori_version == "1.0.6"` compatibility — **PASS**
8. Live remote HTTPS `HEAD` on artifact URL returned HTTP `200`, `Content-Length: 205445856` — **PASS**
9. Pre-publication race-guard policy (`expected_live_revision == 1`, `abort_if_live_revision_differs == true`) — **PASS**
10. Production candidate kept strictly unsigned (zero test-key `.sig` files inside `release/v1.0.8-rc/tools-manifest-rev2-candidate/`) — **PASS**
11. Isolated non-production test fixture signed with legacy test key (`AA11223344556677`) verifies cleanly — **PASS**
12. Isolated non-production test co-signature (`.tools.sig`) signed with dedicated test key (`BB8899AABBCCDDEE`) verifies cleanly — **PASS**
13. Single-byte manifest tamper strictly rejected — **PASS**
14. Detached signature corruption strictly rejected — **PASS**
15. Cross-key / wrong-key verification strictly rejected — **PASS**

---

## 10. Renewal Monitoring Workflow Readiness (Phase 7 — 18 Simulations)

Hardened `scripts/monitor_tools_manifest_expiry.js` and executed all **18** failure simulations via:
```powershell
node scripts\verify_gate33_1_expiry_monitor_matrix.js
```
Result: **`PASS=18 FAIL=0`** (`MON-01`..`MON-18`):
- `MON-01` Healthy (`>30d`) → `HEALTHY`
- `MON-02` `30d` threshold (`28d`) → `RENEWAL_DUE`
- `MON-03` `14d` threshold (`13d`) → `WARNING`
- `MON-04` `7d` threshold (`6d`) → `HIGH_PRIORITY_ALERT`
- `MON-05` `48h` threshold (`36h`) → `CRITICAL_ALERT` (`--strict-exit` exit code `2`)
- `MON-06` Expired (`-24h`) → `EXPIRED_INCIDENT` (`--strict-exit` exit code `2`)
- `MON-07` Invalid signature → `SECURITY_INCIDENT`
- `MON-08` Stale CDN response (`rev 1 < registry rev 2`) → `CDN_STALE_MANIFEST`
- `MON-09` Unreachable endpoint (HTTP `503`) → `NETWORK_OR_FETCH_FAILURE` + `15m` backoff
- `MON-10` Unexpected redirect to untrusted host (`evil.example`) → `SECURITY_REDIRECT_BLOCKED`
- `MON-11` Artifact URL unavailable (`HEAD 404`) → `ARTIFACT_AVAILABILITY_DRIFT`
- `MON-12` Duplicate scheduled execution within cooldown → `SKIPPED_DEDUP`
- `MON-13` Missing operator approval token → `MISSING_APPROVAL_TOKEN`
- `MON-14` Stalled renewal preparation (`>= 72h`) → `STALLED_APPROVAL`
- `MON-15` Backward system clock skew → `CLOCK_SKEW_DETECTED`
- `MON-16` Future-dated manifest (`published_at > now + 15m`) → `FUTURE_DATED_MANIFEST`
- `MON-17` Unrecorded higher live revision (`rev 3 > registry rev 1`) → `UNRECORDED_HIGHER_REVISION`
- `MON-18` Expired approval token → `EXPIRED_APPROVAL_TOKEN`

---

## 11. GitHub Actions Execution Status

- **Workflow file:** `.github/workflows/tools-manifest-expiry-monitor.yml`
  - **YAML validation:** `YAML_OK jobs=['monitor-expiry']`
  - **Security posture:** Least-privilege `permissions: contents: read`, single concurrency group, `strict_exit` manual dispatch toggle, 30-day auditable JSON report upload, **zero signing keys or production secrets**.
  - **Honest Operational Status:** **IMPLEMENTED AND LOCALLY VALIDATED — NOT YET MERGED/ENABLED ON REMOTE GITHUB ACTIONS SCHEDULE.** Until merged into the default branch on GitHub, scheduled `0 6 * * *` cron executions do not run remotely.
- **Clean Windows QA workflow:** `.github/workflows/clean-windows-release-qa.yml` (`CLEAN_QA_YAML_OK jobs=['clean-windows-qa']`) — **PREPARED AND VALIDATED LOCALLY; NOT YET EXECUTED ON GITHUB RUNNERS.**

---

## 12. Desktop v1.0.8 RC Build Metadata

- **Version:** `1.0.8` (bumped in `Cargo.toml`, `Cargo.lock`, `src-tauri/tauri.conf.json`, `ui/package.json`, `ui/src/components/SettingsModal.tsx`; Browser Companion `v1.0.10` untouched)
- **Build Commands:**
  - `npm --prefix ui run lint` (`0 errors`, 7 pre-existing warnings)
  - `npm --prefix ui run build` (`vite v8.3.5`, `345ms`)
  - `cargo build --release --workspace` (`1m 57s`)
  - `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build_nsis_installer.ps1`
- **Staged Local Directory (Unpublished, Gitignored):** `release/v1.0.8-rc/`
- **Metadata Files:** `BUILD_METADATA.json`, `RELEASE_MANIFEST.json`, `SHA256SUMS.txt`, `draft_latest.json`, `RELEASE_NOTES_v1.0.8.md`, `INSTALLATION_AND_UPGRADE.md`

| Artifact (`release/v1.0.8-rc/`) | Exact Size (Bytes) | SHA-256 |
|---|---|---|
| `TORI Download Manager_1.0.8_x64-setup.exe` | `118,132,865` | `659f5f239c80510d4e2da8d50a7f2ab92e1ba6a48fa63cd6c7ad2604078a5c02` |
| `TORI Download Manager_1.0.8_x64-setup.exe.sig` | `436` | `51f401b094ea934eb0499a61e4ff4fc6972b69d90e38f25bfa96f41260cbc98b` |
| `tori-download-manager.exe` | `32,100,352` | `7030eb4e410fa1379098becdc48a539a255a56a9ee93a58fb9c3b0de40c207c5` |
| `tdm-native-host.exe` | `19,382,272` | `662fd2b8098e93de2d02b15e67ead616bf7275a9f8fd4ca687e67e25db6ef6a3` |
| `tdm-cli.exe` | `17,033,216` | `734882c79e946476640c9ac95eb27ea68ba03c677b9914405e0d65a24699d404` |
| `draft_latest.json` | `1,581` | `6ca6618218676c0027445bfbeac0a475847b9790410b4fc3ab10176b4bb4cd79` |
| `tools-manifest-rev2-candidate/tools-manifest.json` | `1,564` | `af7edd089989d150bb6179c0a051e8b4669aed04fe6b564c3a44cbe1f23bdfe4` |
| `tools-manifest-rev2-candidate/RACE_PRECHECK_POLICY.json` | `1,322` | `fbba46591b15254ed735c1e0ede270ae770883be243fff7a12b389c0cc3b9874` |

---

## 13. NSIS Installer Hash & Cryptographic Signature

- **Installer SHA-256:** `659f5f239c80510d4e2da8d50a7f2ab92e1ba6a48fa63cd6c7ad2604078a5c02` (`118,132,865` B)
- **Tauri Ed25519 Detached Signature (`.sig`):** `436` B, SHA-256 `51f401b094ea934eb0499a61e4ff4fc6972b69d90e38f25bfa96f41260cbc98b`, signed strictly with Desktop Updater key `CDC23D8CC8DA5397`.
- **Rust Cryptographic Verification (`updater_cryptography_tests` — 9/9 PASS):**
  - `test_v108_release_candidate_signature_draft_updater_stage1_keyring_and_rev2_candidate` verified: PE header (`MZ`), Minisign Ed25519 signature pass, trusted comment `file:TORI Download Manager_1.0.8_x64-setup.exe`, single-byte installer tamper rejection, `draft_latest.json` signature parity for `windows-x86_64` and `windows-x86_64-nsis`, and SemVer `1.0.7 < 1.0.8`.
- **Windows Authenticode Status:** `NotSigned` (**NOT AVAILABLE — PIPELINE READY**; `signtool.exe` detected and `-RequireAuthenticode` fail-closed verified in `G33S-14`).

---

## 14. v1.0.7 → v1.0.8-rc Isolated Physical NSIS Upgrade

Executed via `node scripts/verify_gate33_1_v108_rc_preflight.js` (**20/20 PASS**):
- **Physical Upgrade (`G331-06`):** Installed frozen `v1.0.7` NSIS installer (`release/v1.0.7-rc`) into `target/gate33_1_qa/desktop_install`, seeded completed/paused/failed/queued jobs + `.tdm-part` + user settings, left `v1.0.7` running, and executed in-place silent upgrade using `release/v1.0.8-rc/TORI Download Manager_1.0.8_x64-setup.exe /S /D=...`.
- **Verification Results:**
  - PE version upgraded `1.0.7 → 1.0.8`, all bundled binaries (`ffmpeg.exe`, `ffprobe.exe`, `yt-dlp.exe`, `tdm-native-host.exe`, `tdm-cli.exe`, `LICENSE-THIRD-PARTY.txt`) intact, registry install dir accurate (`G331-06`).
  - Clean cold boot (`822 ms`), zero `SECONDARY_INSTANCE` error, `get_app_version === "1.0.8"`, SQLite `PRAGMA integrity_check = ok` with all 8 schema tables (`G331-07`).
  - All seeded downloads & settings preserved; paused download `.tdm-part` byte-identical across upgrade and resumed to exact SHA-256 (`G331-08`).
  - Standalone IDM Progress Window opened (`isIdm=true`, `legacyToast=false`, `label=progress_*`, `4.19 MB/s`, exact SHA-256) (`G331-09`).
  - Close-to-Tray hid main window while keeping engine alive and restored cleanly; Settings → External Tools verified live production `rev 1` (`Manifest Verified · Rev 1`, key `CDC23D8CC8DA5397`) with Light & Dark screenshots captured (`G331-10`).
  - Warm restart (`845 ms`) preserved all 7 downloads, SQLite tool registry, update history, and settled with `consoleCount=0`, `procCount=7`, `wsMb=403.84` (`G331-11`).
- **UI Evidence Screenshots:**
  - `docs/reports/screenshots/gate33_1/gate33_1_01_about_v108_light.png`
  - `docs/reports/screenshots/gate33_1/gate33_1_02_external_tools_v108_light.png`
  - `docs/reports/screenshots/gate33_1/gate33_1_03_external_tools_v108_dark.png`

---

## 15. Browser Companion v1.0.10 Compatibility

- **Unchanged Artifacts (`G331-03`):** Firefox signed XPI (`a93a4387...`) and Chromium ZIP (`f220fab2...`) remain 100% byte-identical and unmodified.
- **Native Messaging & Chromium Package (`G331-18`):** Upgraded `v1.0.8-rc` `tdm-native-host.exe` responded `{"status":"ok","action":"pong","version":"2.0.0",...}` over stdio, HTTP fallback `/api/v1/status` returned HTTP `200`, and Chromium `v1.0.10` package (`Chrome`/`Edge`) retains Instagram overlay, YouTube picker, and playlist handoff.
- **Permanent Mozilla-Signed Firefox Capture (`G331-19`):** Installed `tori-companion-v1.0.10-firefox-signed.xpi` permanently (`xpinstall.signatures.required=true`, `temporary=false`) into isolated Firefox via Marionette; verified addon ID `tori-download-manager@toridm.org`, triggered live MKV download capture into upgraded `v1.0.8-rc`, yielding `newJobs=1` (zero duplicates) and exact SHA-256 match.

---

## 16. External Tools Regression (Phase 12 & Historical Suites)

- **Gate 33.1 `G331-17` (Upgraded `v1.0.8-rc`):** Live OpenPGP RSA-4096 `yt-dlp` update (`2026.08.19 → 2026.10.26`) ran concurrently with active HTTP + live YouTube media downloads without interrupting either transfer; both completed with exact integrity, manual rollback (`2530 ms`) restored bundled `yt-dlp`, and direct FFmpeg/FFprobe H.264/AAC MP4 → MKV transcode + FFprobe JSON verification passed (`ffCodecOk=true`).
- **Gate 32 External Tools Updater Suite:** **`18/18 PASS`** (`node scripts/verify_gate32_external_tools_updater.js`).
- **Gate 32.1 Remote Signed Tools Manifest Suite:** **`19/19 PASS`** (`node scripts/verify_gate32_1_remote_manifest.js`).
- **Gate 33 Renewal, Monitoring & Security Suite:** **`14/14 PASS`** (`node scripts/verify_gate33_renewal_and_security.js`).

---

## 17. Clean Windows 10 QA

- **Status:** **`NOT TESTED`**
- **Host Audit Evidence (`powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run_clean_windows_vm_qa.ps1 -AuditOnly`):**
  - Host OS: Windows 11 Pro (`10.0.26300`), AMD Ryzen 5 5500 (6C/12T), `15.9 GB` RAM, `39.97 GB` free on `F:`, Hyper-V `vmms` running, non-elevated session, **`provisionedWindowsVmCount: 0`**, no licensed Windows 10 clean VM image present on host.
- **Prepared Automation:** `scripts/clean_windows_qa_guest.ps1`, `scripts/run_clean_windows_vm_qa.ps1`, and `.github/workflows/clean-windows-release-qa.yml` are all syntax-validated (`PASS`) and ready for execution on a clean Windows 10 VM or GitHub Windows runner.

---

## 18. Clean Windows 11 QA

- **Status:** **`NOT TESTED`**
- **Host Audit Evidence:** Same virtualization audit (`provisionedWindowsVmCount: 0`, no pre-provisioned licensed Windows 11 clean VM image available on host; Windows Sandbox unavailable).
- **Prepared Automation:** Ready via `scripts/clean_windows_qa_guest.ps1` / `.github/workflows/clean-windows-release-qa.yml`.

---

## 19. Security Regression

- **Rust Security Integration Tests:**
  - `cargo test -p tdm-core --test external_tools_security_matrix_tests -- --nocapture`: **`4/4 PASS`** (Stage 1 dual-key keyring, unauthorized inline trust-escalation rejection, key purpose isolation, revocation, anti-replay, equivocation, redirect blocking, artifact tamper/downgrade rejection).
  - `cargo test -p tdm-core --test updater_cryptography_tests -- --nocapture`: **`9/9 PASS`** (including new `v1.0.8-rc` installer Ed25519 signature, tamper rejection, `draft_latest.json`, Stage 1 keyring safety, and unsigned `rev 2` candidate checks).
  - `cargo test -p tdm-core --test external_tools_updater_tests`: **`11/11 PASS`**.
- **Node Security & Monitoring Matrices:**
  - `scripts/verify_gate33_1_expiry_monitor_matrix.js`: **`18/18 PASS`**
  - `scripts/verify_gate33_renewal_and_security.js`: **`14/14 PASS`** (including `G33S-13` zero secret leakage check)
  - `scripts/verify_gate33_1_v108_rc_preflight.js` (Phase 5 & Phase 11 security scenarios): **`20/20 PASS`**

---

## 20. Full Workspace Regression

| Suite / Command | Result | Notes |
|---|---|---|
| `npm --prefix ui run lint` | **PASS** (`0 errors`, 7 warnings) | Clean UI lint on `1.0.8` |
| `npm --prefix ui run build` | **PASS** (`345 ms`) | Production UI bundle `1.0.8` |
| `cargo clippy --workspace --all-targets` | **PASS** (`0 errors`) | Zero clippy errors across workspace |
| `cargo test --workspace -j 2 --no-fail-fast` | **`270/276 PASS`** (**6 external YouTube anti-bot blocks**) | **270/270 (100%)** of local/core/crypto/security/tools/HLS/DASH/BT/native-host/server tests PASSED. 6 live-YouTube tests (`gate12_9_1_acceptance_tests` 1/6, `gate29_5_2_resolver_priority_tests` 3/10, `speed_audit_tests` 1/3, `gate15_1_performance_tests` 1/1) failed solely due to YouTube returning `"Sign in to confirm you're not a bot"` on unauthenticated `yt-dlp` extraction (not bypassed per policy). |
| `scripts/verify_gate33_1_v108_rc_preflight.js` | **`20/20 PASS`** | Full `v1.0.8-rc` preflight, upgrade, Phase 11 matrix, Firefox signed XPI, live YouTube concurrent protection |
| `scripts/verify_gate33_1_expiry_monitor_matrix.js` | **`18/18 PASS`** | All 18 Phase 7 monitoring failure scenarios |
| `scripts/verify_gate33_renewal_and_security.js` | **`14/14 PASS`** | Offline renewal, locking, dual-auth guard, Authenticode readiness, secret scan |
| `scripts/verify_gate32_3_public_release.js --post-release` | **`14/14 PASS`** | Public `v1.0.7`, `latest.json`, `rev 1` manifest, Companion `v1.0.10`, `toridownload.xyz`, OEM preservation |
| `scripts/verify_gate32_1_remote_manifest.js` | **`19/19 PASS`** | Live HTTPS staging signed manifest |
| `scripts/verify_gate32_external_tools_updater.js` | **`18/18 PASS`** | Independent External Tools updater matrix |
| `scripts/verify_gate29_1_idm_desktop_ui.js` | **`20/20 PASS`** | IDM Desktop UI on `v1.0.8` |
| `scripts/verify_gate29_2_idm_progress_window.js` | **`17/17 PASS`** | Standalone IDM Progress Window |
| `scripts/verify_gate31_4_toast_replacement.js` | **`15/15 PASS`** | Zero legacy download toast on `v1.0.8-rc` installer |
| `scripts/verify_gate31_5_install_repair_and_preflight.js` | **`23/23 PASS`** | OEM `v1.0.6` install repair invariants |
| `scripts/verify_gate29_4_final_integration.js` | **`18/18 PASS`** | Full `v1.0.8-rc` installer integration, crash recovery, live YouTube 360p/720p/1080p/audio/playlist + Firefox capture |

---

## 21. User Data Preservation

Verified across EVERY isolated suite (`G331-20`, `G323-14`, `G294-SAFETY-DB`, `G294-SAFETY-REG`) and direct post-run inspection:
- **OEM Installed Desktop Binary (`%LOCALAPPDATA%\TORI Download Manager\tori-download-manager.exe`):** Byte-identical `v1.0.6` SHA-256 `570833b379668f64d8f0a81e0a2c138635835e0c0382f37f24ec969caccf0fda`.
- **Production SQLite Database (`%APPDATA%\tori-download-manager\tdm_storage.sqlite`):** `PRAGMA integrity_check = ok`, `42` download rows, `355` chunks, `5` protected settings, `11` `.tdm-part` partial files — **100% hash-identical before and after all suites**.
- **Native Messaging Registry & Shortcuts:** Restored with 100% parity (`regOk=true`, zero residual QA paths).

---

## 22. Rollback Readiness

- **External Tools Manual & Automatic Rollback:** Verified in `G331-17` (`2530 ms` manual `yt-dlp` rollback) and `external_tools_updater_tests` (`11/11 PASS`, atomic `FFmpeg`+`FFprobe` rollback + bundled fallback).
- **Manifest Emergency Rollback (`rev 2 → rev 3`, `allow_rollback_to=true`):** Verified end-to-end on upgraded `v1.0.8-rc` in `G331-16` and offline rollback-plan generation in `G33S-12`.
- **Desktop Binary Rollback (`v1.0.8 → v1.0.7`):** Additive SQLite schema remains 100% backward-compatible with frozen `release/v1.0.7-rc/TORI Download Manager_1.0.7_x64-setup.exe`.
- **Git Rollback Anchor:** Annotated tag `checkpoint-gate33_1-before-rc` preserved at `2ae26bb4914ae2018af372bcd56497c70838993d`.

---

## 23. Changed Files

**Modified Tracked Files:**
- `.github/workflows/tools-manifest-expiry-monitor.yml`
- `Cargo.toml`
- `Cargo.lock`
- `crates/tdm-core/src/tools/mod.rs`
- `crates/tdm-core/src/tools/providers.rs`
- `crates/tdm-core/src/tools/trust.rs`
- `crates/tdm-core/src/tools/types.rs`
- `crates/tdm-core/tests/external_tools_security_matrix_tests.rs`
- `crates/tdm-core/tests/updater_cryptography_tests.rs`
- `scripts/monitor_tools_manifest_expiry.js`
- `scripts/verify_gate33_renewal_and_security.js`
- `src-tauri/tauri.conf.json`
- `ui/package.json`
- `ui/src/components/SettingsModal.tsx`

**New Tracked Files:**
- `docs/reports/GATE33_1_PRODUCTION_TOOLS_KEY_AND_V108_RC_PREFLIGHT_REPORT.md`
- `docs/reports/screenshots/gate33_1/gate33_1_01_about_v108_light.png`
- `docs/reports/screenshots/gate33_1/gate33_1_02_external_tools_v108_light.png`
- `docs/reports/screenshots/gate33_1/gate33_1_03_external_tools_v108_dark.png`
- `docs/security/GATE33_PRODUCTION_ROLLOUT_PLAN.md`
- `scripts/provision_dedicated_tools_key.ps1`
- `scripts/verify_gate33_1_expiry_monitor_matrix.js`
- `scripts/verify_gate33_1_v108_rc_preflight.js`

**New Local Unpublished Release Candidate Artifacts (Gitignored under `release/v1.0.8-rc/`):**
- `TORI Download Manager_1.0.8_x64-setup.exe`, `.sig`, `tori-download-manager.exe`, `tdm-native-host.exe`, `tdm-cli.exe`, `draft_latest.json`, `BUILD_METADATA.json`, `RELEASE_MANIFEST.json`, `SHA256SUMS.txt`, `RELEASE_NOTES_v1.0.8.md`, `INSTALLATION_AND_UPGRADE.md`, `tools-manifest-rev2-candidate/*`.

---

## 24. Known Limitations

1. **Production Dedicated Tools Key Custody (`PRODUCTION_KEY_PROVISIONING_PENDING`):** `%USERPROFILE%\.tori-keys\tori-tools.key` has not yet been interactively generated by the operator with an independent passphrase and offline encrypted backup. Compile-time dedicated key slots in `crates/tdm-core/src/tools/trust.rs` remain `None` until operator provisioning is performed.
2. **Clean Windows 10 & Windows 11 VMs (`NOT TESTED`):** No pre-provisioned licensed clean Windows 10 or Windows 11 VMs exist on this host.
3. **Windows Authenticode Code Signing (`NOT AVAILABLE — PIPELINE READY`):** Installer and executables remain unsigned for Windows Authenticode (`NotSigned`), though Tauri Ed25519 updater signing is active and verified.
4. **GitHub Actions Scheduled Monitoring (`NOT YET MERGED/ENABLED REMOTELY`):** `.github/workflows/tools-manifest-expiry-monitor.yml` is validated locally on branch `feat/gate33_1-dual-key-v108-rc`, not yet merged to the remote default branch.
5. **External Live-YouTube Anti-Bot Rate Limit in Workspace Cargo Run:** 6 external live-YouTube Rust tests (`gate12_9_1_acceptance_tests` 1/6, `gate29_5_2_resolver_priority_tests` 3/10, `speed_audit_tests` 1/3, `gate15_1_performance_tests` 1/1) encountered YouTube's `"Sign in to confirm you're not a bot"` prompt during the unauthenticated workspace test run (while live YouTube end-to-end tests in `G331-17` and `G294-YT-RES` / `G294-FF-PLAYLIST` passed).

---

## 25. Remaining Operator Actions

1. **Provision Dedicated Production External Tools Key:** Run `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\provision_dedicated_tools_key.ps1 -Mode ProductionInteractive`, copy encrypted `tori-tools.key` + `.pub` to an offline encrypted backup separated from `tori-updater.key`, and harden `%USERPROFILE%\.tori-keys` NTFS ACLs / remove legacy plaintext `tori-updater.key.pwd` once operator password manager custody is confirmed.
2. **Embed Dedicated Public Key for Final `v1.0.8` Build:** Populate `TORI_DEDICATED_TOOLS_ED25519_PUBKEY_B64` and `TORI_DEDICATED_TOOLS_ED25519_KEY_ID` in `crates/tdm-core/src/tools/trust.rs` and rebuild `release/v1.0.8-rc/` prior to Gate 33.3 public release authorization.
3. **Clean Windows 10/11 QA Execution (Optional/Recommended):** Execute `.github/workflows/clean-windows-release-qa.yml` or a provisioned Hyper-V clean VM run (or explicitly accept the documented clean-VM & Authenticode limitations as in Gate 32.3).
4. **Merge Monitoring Workflow:** Merge `.github/workflows/tools-manifest-expiry-monitor.yml` to the remote default branch so daily 06:00 UTC expiry monitoring runs automatically on GitHub Actions.

---

## 26. Future Production Rollout Sequence

Documented in full in `docs/security/GATE33_PRODUCTION_ROLLOUT_PLAN.md`:
1. **Gate 33.2 — Authorized Production Manifest Renewal (`rev 1 → rev 2`):** Execute prior to `2026-12-06` (30-day renewal threshold ahead of `rev 1` expiry `2027-01-05T16:00:29.945Z`), signing `rev 2` with `CDC23D8CC8DA5397` (preserving 100% `v1.0.7` compatibility) plus optional `.tools.sig` co-signature once `tori-tools.key` is provisioned.
2. **Gate 33.3 — Authorized Public Stable Release of Desktop `v1.0.8` (Stage 1 Dual-Key Client):** Embed operator-provisioned dedicated public key into `trust.rs`, rebuild/sign `v1.0.8`, publish via two-phase GitHub release (`latest.json` → `1.0.8`), update `toridownload.xyz` Desktop download links (leaving Browser Companion `v1.0.10` unchanged), and run live post-release verification.
3. **Gate 33.4 — Dedicated-Key Cutover & Eventual Legacy Key Retirement (Stage 2 → Stage 3):** Gated strictly on verified `v1.0.8+` fleet adoption (no unsafe fixed calendar date) and explicit operator authorization.

---

## 27. Final Gate 33.1 Verdict

**`CONDITIONAL GO`**

All implemented Gate 33.1 engineering, cryptographic, renewal, monitoring, upgrade, compatibility, security, and preservation checks passed with zero code defects and 100% preservation of all public production releases and local OEM user data. Full unconditional `GO` for public `v1.0.8` Stage 1 activation awaits only the documented external operator prerequisites: (1) interactive custody provisioning & offline backup of production `tori-tools.key` (`PRODUCTION_KEY_PROVISIONING_PENDING`), (2) Clean Windows 10/11 VM execution (or explicit owner acceptance), and (3) explicit owner authorization for Gate 33.2 (manifest `rev 2` signing/publication) and Gate 33.3 (Desktop `v1.0.8` public release).
