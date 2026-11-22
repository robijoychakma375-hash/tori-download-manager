# TORI Download Manager — Gate 33 Engineering Report
# External Tools Security Hardening, Signing-Key Separation, Manifest Renewal & Clean Windows QA

- **Date:** 2026-11-22 (UTC verification window `2026-11-22T16:31Z – 17:30Z`)
- **Gate:** Gate 33 — External Tools Security Hardening, Signing-Key Separation, Manifest Renewal & Clean Windows QA
- **Development Branch:** `feat/gate33-tools-security-maintenance`
- **Baseline Commit:** `303b16c2aeb1438825dda6f20472bc66c13ec622` (includes `checkpoint-gate32_3-released` @ `3337be3f53be719fc5c35d4e2ded5f1a7d9e7e6e` + Gate 32 `G32-05` post-release fix `303b16c`)
- **Pre-Gate Safety Tag:** `checkpoint-gate33-before-security-hardening` -> `303b16c2aeb1438825dda6f20472bc66c13ec622`
- **Public Release Status:** **NOT PERFORMED** (Implementation, Staging, Hardening & QA Gate Only)
- **Public Desktop Version (Unchanged):** `v1.0.7` (GitHub Release ID `454278227`, source commit `84da0c08256d6abaca253b5612010034237c86f9`)
- **Public Browser Companion Version (Unchanged):** `v1.0.10` (GitHub Release ID `451270856`)
- **Final Verdict:** **CONDITIONAL GO (Development & Staging Complete; Ready for Future Dedicated-Key Release Planning)** — all 18 Gate 33 acceptance criteria pass, with the two documented environment limitations honestly preserved (`Clean Windows 10/11 VM`: **NOT TESTED**; `Windows Authenticode`: **NOT AVAILABLE / PIPELINE READY**).

---

## 1. Executive Summary

Gate 33 hardens the long-term security, cryptographic isolation, manifest lifecycle maintenance, and release verification repeatability of TORI Download Manager's Independent External Tools Auto-Update infrastructure while leaving all live public releases (`Desktop v1.0.7`, `latest.json`, `Browser Companion v1.0.10`, production `tools-manifest.json` rev `1`, and `toridownload.xyz` public download pages) 100% untouched.

### Verification Honesty Classification Matrix

| Capability / Deliverable | Classification | Exact Verification Evidence |
| --- | --- | --- |
| Dedicated External Tools Signing-Key Architecture (`TrustedToolsKeyring`, purpose binding, revocation, dual-key transition, unsafe-removal guard) | **Implemented & Tested Locally + Over HTTPS (Staging)** | Rust `external_tools_security_matrix_tests` (`3/3` suites covering 27 scenarios), `verify_gate33_staging_key_transition.js` (`9/9 PASS` over live Cloudflare Pages HTTPS) |
| Production Dedicated Signing Key (`tori-tools.key`) Activation | **NOT Deployed to Production** | Intentionally withheld per Gate 33 release boundary; existing public `v1.0.7` clients trust only `CDC23D8CC8DA5397` until a future dual-key Desktop release (`v1.0.8+`) ships |
| Controlled Manifest Renewal CLI (`scripts/renew_trusted_tools_manifest.js`) & Expiry Monitor (`scripts/monitor_tools_manifest_expiry.js`) | **Implemented & Tested Locally + Live Read-Only Production Checks** | `verify_gate33_renewal_and_security.js` (`14/14 PASS`), live `--check` & expiry monitor confirming `rev 1` (`43.95` days remaining, `HEALTHY`) |
| Durable Immutable Manifest & Artifact Registry (`docs/security/tools-manifest-registry/`) | **Implemented & Verified Locally** | Verbatim archived `prod_rev_0001_tools-manifest.json` (`9fa61a38...`) + `.sig` (`e0e23db7...`) bit-identical to live production |
| Isolated Gate 33 Dedicated-Key Staging Manifest (`https://toridownload.xyz/assets/tools/staging/gate33/`) | **Deployed to Staging & Tested Over Real HTTPS** | `tori-website-private` commit `fb42622`; live Desktop binary verified rev `2` dedicated test key, rev `3` rollback, invalid sig rejection, revoked key rejection (`9/9 PASS`) |
| Settings → External Tools Consumer-Safe Manifest Status Strip (Phase 15) | **Implemented, Built & Visually Verified Locally** | `ui` lint (`0` errors) + build (`278ms`) + visually inspected Light & Dark screenshots (`docs/reports/screenshots/gate33/`) |
| Clean Windows 10/11 Release QA Automation (`clean_windows_qa_guest.ps1`, `run_clean_windows_vm_qa.ps1`, `.github/workflows/clean-windows-release-qa.yml`) | **Implemented & Syntax/Audit Verified**; **Physical Clean VM Run: NOT TESTED** | PowerShell parser checks PASS; `-AuditOnly` confirms Windows 11 Pro host has Hyper-V running but `0` pre-provisioned licensed Win10/Win11 VM images |
| Windows Authenticode Pipeline Readiness (`build_nsis_installer.ps1`, `verify_authenticode_readiness.ps1`) | **Implemented & Fail-Closed Tested**; **Certificate: NOT AVAILABLE** | `signtool.exe` present (`10.0.26100.0`), `-RequireAuthenticode` fails closed cleanly; public `v1.0.7` remains honestly `NotSigned` for Authenticode (Ed25519 `.sig` active) |
| Full TORI Regression & Production Invariant Suite | **Tested Locally & Live Against Public Endpoints** | Rust workspace (`274/274`), Clippy (`0` errors), Gate 32 (`18/18`), Gate 32.1 (`19/19`), Gate 29.1 (`20/20`), Gate 29.2 (`17/17`), Gate 29.4 (`18/18`), Gate 31.4 (`15/15`), Gate 31.5 (`23/23`), Gate 32.3 Post-Release (`14/14`) |

---

## 2. Baseline Repository & Public State (Phase 0)

- **Main Repository (`F:\TORI\final tori download manager`):**
  - Release source commit (`v1.0.7` tag): `84da0c08256d6abaca253b5612010034237c86f9`
  - Gate 32.3 final release checkpoint (`checkpoint-gate32_3-released`): `3337be3f53be719fc5c35d4e2ded5f1a7d9e7e6e`
  - Post-release Gate 32 `G32-05` test fix verified present on `release/v1.0.7-rc` at `303b16c2aeb1438825dda6f20472bc66c13ec622`
  - Pre-Gate 33 annotated safety tag created: `checkpoint-gate33-before-security-hardening` -> `303b16c2aeb1438825dda6f20472bc66c13ec622`
  - Development branch created: `feat/gate33-tools-security-maintenance`
- **Public Baseline Verified Live Before & After Gate 33:**
  - GitHub Latest Stable: `v1.0.7` (Release ID `454278227`, 16 Desktop assets, installer SHA-256 `142e4528410a70c43cf7166acda87d8b27e293348237113b2350a025467966cb`, `.sig` SHA-256 `945b5efdcc69edf85373c54cfdb603d50976f5ba6be75bef5e130ca5350224e8`).
  - Public `latest.json`: version `1.0.7` (`pub_date: 2026-11-22T07:31:00.467Z`), verified Ed25519 signature (`CDC23D8CC8DA5397`).
  - Browser Companion: `extension-v1.0.10` (Release ID `451270856`), Firefox XPI SHA-256 `a93a43872d224426902c49e217e31b2c603263d8c260c429940539b34b2852b8` (`application/x-xpinstall`), Chromium ZIP SHA-256 `f220fab2e26fd54ef7f85fd7e40613faad79e7f9a7f44fadf228ccd0edcc22f1`.
  - Production Tools Manifest: `https://toridownload.xyz/assets/tools/tools-manifest.json` (`schema_version: 2`, `manifest_revision: 1`, signer `CDC23D8CC8DA5397`, SHA-256 `9fa61a38bb77bb8cdf05364565db2cf3b2b3ab8d0c7af98dfd7c50b2ee287662`, `.sig` SHA-256 `e0e23db79990f885c0745165299b20befd41f5dc8a73f7b00ca0476502955eb4`, expires `2027-01-05T16:00:29.945Z`).
  - Approved Immutable FFmpeg Archive: `N-129150-g7ddf7bc8a4-20261120` (`205,445,856` B, SHA-256 `03d33066832e7149a8577bed73713c5d5344aed14199063e521b798cf1b60076`, GitHub prerelease ID `453686141`).

---

## 3. Existing Cryptographic Architecture Audit (Phase 1)

Full written audit and answers to all 8 security questions are documented in `docs/security/EXTERNAL_TOOLS_SIGNING_KEY_MIGRATION_SPEC.md`:

1. **Shared Key Confirmed:** Desktop Auto-Updater (`src-tauri/tauri.conf.json`) and External Tools Manifest (`crates/tdm-core/src/tools/trust.rs`) currently share Ed25519 Minisign key `CDC23D8CC8DA5397` (`%USERPROFILE%\.tori-keys\tori-updater.key`).
2. **Independent Verification Surfaces:** `tauri-plugin-updater` reads exclusively `src-tauri/tauri.conf.json`, while External Tools reads exclusively `ToolsManagerConfig` / `TrustedToolsKeyring` in `tdm-core` — enabling clean separation without altering Desktop updater signatures.
3. **Blast Radius Finding:** Sharing one key means a single private-key compromise impacts both Desktop application updates and External Tools manifests. Separating `tori-tools.key` preserves the Desktop updater trust anchor as an authenticated recovery channel if a tools signing key is ever compromised.

---

## 4. Dedicated External Tools Signing-Key Architecture (Phase 2)

Implemented across `crates/tdm-core/src/tools/types.rs`, `trust.rs`, `providers.rs`, `manager.rs`, `mod.rs`, and `src-tauri/src/lib.rs`:

- **`SigningKeyPurpose`:** Explicitly distinguishes `ExternalToolsManifest` (dedicated `tori-tools.key`), `ExternalToolsLegacyShared` (transitional `CDC23D8CC8DA5397`), and `DesktopAppUpdater` (strictly rejected for External Tools manifests).
- **`TrustedKeyStatus`:** Tracks `Active`, `TransitionLegacy`, `Retired`, and `Revoked` with optional `valid_from` / `retired_after` bounds.
- **`TrustedToolsKeyring`:** Versioned multi-key trust configuration (`keyring_version: 1`) with explicit `revoked_key_ids`, `allow_legacy_shared_key`, and `validate_safety()` (prevents unsafe key removal that would leave zero active signing keys).
- **Signature-Header Key Extraction (`extract_minisign_sig_key_id_hex`):** Extracts the exact 8-byte little-endian signer key ID directly from the Minisign signature before selecting the matching pinned key; rejects revoked, retired, unknown, and wrong-purpose keys before cryptographic verification and rejects `manifest.key_purpose != "external_tools_manifest"`.
- **Stage 0 Production Default Preserved:** `ToolsManagerConfig::default()` resolves `TrustedToolsKeyring::default_production_transition()` (`CDC23D8CC8DA5397` as `ExternalToolsLegacyShared / TransitionLegacy`, `allow_legacy_shared_key: true`) — **zero** unapproved production dedicated key is activated during Gate 33.

---

## 5. Current Public Desktop `v1.0.7` Compatibility Analysis

- Public `v1.0.7` binaries (compiled at `84da0c08`) hardcode `TORI_ED25519_PUBKEY_B64` (`CDC23D8CC8DA5397`) and strictly reject any `tools-manifest.json.sig` signed by another key ID.
- Replacing the production signature today would strand `v1.0.7` clients from FFmpeg/FFprobe updates.
- Gate 33 enforces **no self-authorizing manifest rotation**: a downloaded manifest can never authorize a new public key on its own; new keys enter trust stores strictly through an authenticated Desktop release.

---

## 6. Safe Key Migration Strategy (Phase 3)

Documented in full in `docs/security/EXTERNAL_TOOLS_SIGNING_KEY_MIGRATION_SPEC.md`:
- **Stage 0 (Current Public `v1.0.7`):** Legacy shared key `CDC23D8CC8DA5397`; Gate 33 `TrustedToolsKeyring` ready in development.
- **Stage 1 (Future Desktop `v1.0.8`):** Ship `TrustedToolsKeyring` trusting BOTH dedicated `tori-tools.key` (`Active`) and `CDC23D8CC8DA5397` (`TransitionLegacy`, `allow_legacy_shared_key: true`). Continue signing primary `.sig` with `CDC23D8CC8DA5397` (100% `v1.0.7` compatible) and optionally publish `.tools.sig` sidecar signed by `tori-tools.key` (verified natively by `v1.0.8+`, safely ignored by `v1.0.7`).
- **Stage 2 (Cutover):** After verified `v1.0.8+` adoption, switch primary `.sig` at revision `N+1` to `tori-tools.key`. Emergency rollback to legacy key remains possible during Stage 2 via revision `N+2` signed by `CDC23D8CC8DA5397`.
- **Stage 3 (Retirement — Future Desktop `v1.0.9+`):** Set `allow_legacy_shared_key = false` and mark `CDC23D8CC8DA5397` as `Retired` inside `TrustedToolsKeyring`, while Desktop Auto-Updater retains `CDC23D8CC8DA5397` independently.

---

## 7. Manifest Renewal System (Phases 5 & 7)

Implemented in `scripts/renew_trusted_tools_manifest.js`:
- **Strict Policy Separation:** `--prepare` / `--dry-run` performs **metadata-only renewal for an unchanged approved immutable artifact** (verifies artifact availability/size/SHA-256, strictly increments `manifest_revision`, sets bounded UTC TTL `[7..90]` days, and **refuses** `--new-url`, `--new-sha256`, or `--new-version`). New FFmpeg binaries MUST follow the full provenance + media compatibility + approval pipeline in `scripts/publish_trusted_tools_manifest.js`.
- **Supported Modes:** `--check`, `--prepare`, `--verify`, `--dry-run`, `--publish-staging`, `--rollback-plan`, and strictly dual-authorized `--publish-production` (fails closed without both `--i-authorize-production-manifest` and an exact SHA-256/revision/key-ID approval token).
- **Operational Safety:** Exclusive lockfile (`renewal.lock`) blocks concurrent runs; duplicate identical proposals are cleanly suppressed; supports offline preparation from immutable archived manifests (`--offline-manifest`).

---

## 8. Manifest Expiration Audit & Monitoring (Phases 4 & 6)

- **Live Audit Timestamp:** `2026-11-22T17:18:44Z`
  - `published_at`: `2026-11-21T16:00:29.945Z`
  - `expires_at`: `2027-01-05T16:00:29.945Z`
  - **Remaining Validity:** **`43.95` days (`1,054.7` hours)** — **`HEALTHY`** (`renewalRecommended: false`)
  - Scheduled alert dates (UTC): `30d` Renewal Due (`2026-12-06`), `14d` Warning (`2026-12-22`), `7d` High Alert (`2026-12-29`), `48h` Critical (`2027-01-03`).
- **Monitoring Script & Policy:** `scripts/monitor_tools_manifest_expiry.js` + `docs/security/manifest_expiry_monitoring_config.json` + `.github/workflows/tools-manifest-expiry-monitor.yml` (daily 06:00 UTC read-only monitor, zero signing secrets).
  - Enforces UTC calculations, persistent scheduler state, minimum check interval deduplication, 12-hour same-severity alert suppression with immediate escalation on severity worsening, bounded exponential outage backoff (`15m → 1h → 4h → 12h`), stalled-approval warnings (`>=72h`), CDN stale-manifest detection, signature validation, and artifact drift detection.
- **Client Expiry Fail-Safe:** Verified in `external_tools_security_matrix_tests` and `external_tools_updater_tests` — expired manifests fail closed (`RejectedSecurity`) without deleting or disabling already-installed verified tools or bundled fallbacks.

---

## 9. Artifact Provenance Policy & Immutable Registry (Phases 8 & 12)

- **Policy Document:** `docs/security/TORI_RELEASE_SECURITY_POLICY.md` (covers all 15 least-privilege release, custody, provenance, CI/CD, GitHub, Cloudflare, and incident-response controls).
- **Durable Append-Only Registry:** `docs/security/tools-manifest-registry/registry.json` tracks revision `1` with immutable verbatim copies archived at `docs/security/tools-manifest-registry/history/prod_rev_0001_tools-manifest.json` (`9fa61a38...`) and `.sig` (`e0e23db7...`).

---

## 10. Secure Signing Workflow & Operational Runbooks (Phases 7 & 19)

Documented with exact verified commands across all 10 operational runbooks in `docs/security/EXTERNAL_TOOLS_OPERATIONAL_RUNBOOKS.md` (expiry monitoring, metadata renewal, new binary candidate approval, dedicated key custody, staged key transition, emergency rollback, key compromise response, clean Windows VM QA, optional Authenticode signing, and post-deployment verification).

---

## 11. Emergency Rollback & Revocation (Phase 9)

- Because clients enforce strictly monotonic `manifest_revision` anti-replay, rollback NEVER re-serves an older revision.
- `scripts/renew_trusted_tools_manifest.js --rollback-plan` generates a strictly higher revision (`highest + 1`) pointing to the previous approved rollback-eligible immutable artifact from `registry.json` with `"allow_rollback_to": true`.
- Verified end-to-end both in Rust (`external_tools_security_matrix_tests` Scenario 14) AND over live Cloudflare Pages HTTPS (`G33-STG-04`, rev `2` → rev `3`).

---

## 12. Real HTTPS Staging Test Results (Phase 14)

Executed via `node scripts/verify_gate33_staging_key_transition.js` against isolated Cloudflare Pages staging directory `https://toridownload.xyz/assets/tools/staging/gate33/` (`tori-website-private` commit `fb42622`, **zero** changes to production manifest, Gate 32.1 staging manifest, or public site HTML) using a **TEST-ONLY** staging key (`3373746167653333`, stored strictly inside gitignored `target/gate33_staging_keys/`):

**Result: `9 PASS, 0 FAIL`**
- `G33-STG-01`: Isolated staging rev `2` (dedicated test key), rev `3` (rollback), and invalid `.sig` live & byte-identical on Cloudflare Pages (`Cache-Control: public, max-age=0, must-revalidate`).
- `G33-STG-02`: Real compiled Desktop binary verified live HTTPS staging rev `2` with dedicated test key (`verification_status=verified, current_revision=2, signing_key_id=3373746167653333, signing_key_purpose=external_tools_manifest`).
- `G33-STG-03`: Phase 15 Settings → External Tools rendered `Manifest Verified · Rev 2`, `Revision: 2`, and `Next check` cleanly in Light & Dark modes with zero private material exposed.
- `G33-STG-04`: Real Desktop binary accepted live HTTPS higher-revision emergency rollback `rev 2 → rev 3`.
- `G33-STG-05`: Real Desktop binary rejected live HTTPS invalid signature fail-closed (`rejected_security`, `source_untrusted`, bundled binaries preserved).
- `G33-STG-06`: Real Desktop binary rejected live HTTPS manifest signed by a revoked key (`Rejected signature from revoked External Tools signing key 3373746167653333`).
- `G33-STG-07`: Default production config verified live production manifest `rev 1` (`CDC23D8CC8DA5397`, `external_tools_legacy_shared`) seamlessly.
- `G33-STG-08`: Live production manifest (`9fa61a38...`) and Gate 32.1 staging manifest (`587e83d9...`) verified 100% untouched.
- `G33-STG-09`: OEM production binary, SQLite DB, 11 `.tdm-part` files, and Native Messaging registry 100% preserved.

---

## 13. Automated Clean Windows QA Implementation (Phase 10)

- **`scripts/clean_windows_qa_guest.ps1`:** Repeatable clean-machine verification harness covering all 18 Phase 10 checks (fresh NSIS install, launch, WebView2 runtime check, first-run profile, SQLite `PRAGMA integrity_check`, Chrome/Edge/Firefox Native Messaging registration, External Tools tables, bundled `yt-dlp`, bundled FFmpeg/FFprobe synthetic MP4 mux + probe, live HTTPS signed tools manifest verification, daily 24h defaults, Close-to-Tray, uninstall + repair reinstall, zero visible console windows, zero missing dependencies), guarded by `-AllowCleanMachineMutation`.
- **`scripts/run_clean_windows_vm_qa.ps1`:** Host Hyper-V orchestrator supporting safe read-only `-AuditOnly` and automated checkpoint-revert → PowerShell Direct execution → JSON report collection → checkpoint-restore.
- **`.github/workflows/clean-windows-release-qa.yml`:** Manual (`workflow_dispatch`) clean Microsoft-hosted Windows runner (`windows-2022` & `windows-2025`) workflow.
- All PowerShell scripts passed strict .NET `System.Management.Automation.Language.Parser` validation (`0` parse errors).

---

## 14. Real Clean-VM Testing Status (Honest Audit)

Host audit (`scripts/run_clean_windows_vm_qa.ps1 -AuditOnly`):
- **Host:** Microsoft Windows 11 Pro (`10.0.26300`), AMD Ryzen 5 5500 (6C/12T, `VirtualizationFirmwareEnabled: true`), `15.9 GB` RAM (`2.2–5.0 GB` free), `C:` `25.77 GB` free, `F:` `42.37 GB` free.
- **Virtualization State:** Hyper-V services (`vmms`, `HvHost`) running and Hyper-V module installed; Windows Sandbox, VirtualBox, and VMware not installed; **0 pre-provisioned licensed Windows 10 or Windows 11 VM images/VHDs/ISOs exist on disk**, and current session is non-elevated. System virtualization configuration was NOT altered.
- **Clean Windows 10 VM Test Status:** **`NOT TESTED`** (reproducible automation delivered; awaits operator-provisioned clean Win10 Hyper-V VM or GitHub Actions clean runner execution).
- **Clean Windows 11 VM Test Status:** **`NOT TESTED`** (reproducible automation delivered; awaits operator-provisioned clean Win11 Hyper-V VM or GitHub Actions clean runner execution).

---

## 15. Windows Authenticode Readiness (Phase 11)

- **Host Toolchain:** `signtool.exe` available at `C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\signtool.exe`.
- **Pipeline Integration (`scripts/build_nsis_installer.ps1`):** Added opt-in `-SignAuthenticode`, `-RequireAuthenticode`, `-CertThumbprint`, `-CertPfxPath`, `-CertPfxPasswordEnv`, `-TimestampUrl` (`http://timestamp.digicert.com`), and `-VerifyOnly`. Signs inner executables + NSIS setup BEFORE regenerating the independent Tauri Ed25519 `.sig` over the final Authenticode-signed bytes.
- **Verified (`scripts/verify_authenticode_readiness.ps1` / `G33S-14`):** `signToolAvailable=true`, `-RequireAuthenticode` without credentials fails closed cleanly (`AUTHENTICODE_REQUIRED_ERROR`), current `v1.0.7` installer honestly reports `NotSigned` for Authenticode while independent Ed25519 `.sig` remains present.
- **Status:** **`NOT AVAILABLE (PIPELINE READY)`** — no commercial certificate provisioned yet; SmartScreen reputation caveat documented honestly in `docs/security/WINDOWS_AUTHENTICODE_INTEGRATION.md`.

---

## 16. Settings → External Tools UI Integration (Phase 15)

Updated `ui/src/types.ts`, `ui/src/components/ExternalToolsPanel.tsx`, and `ui/src/App.css` with a compact, consumer-safe **Trusted Update Status strip** driven by `ExternalToolsSnapshot.manifest_status`:
- Displays manifest verification badge (`Manifest Verified · Rev N`, `Manifest Blocked (Security)`, etc.), trusted source policy summary, last manifest verification timestamp, revision, validity expiration, next scheduled check, and last failure (only when present).
- Zero private key details and zero maintainer-only clutter in the consumer UI.
- Visually inspected Light & Dark screenshots:
  - `docs/reports/screenshots/gate33/gate33_01_external_tools_manifest_status_light.png`
  - `docs/reports/screenshots/gate33/gate33_02_external_tools_manifest_status_dark.png`

---

## 17. Security Test Matrix Results (Phase 13 — All 35 Scenarios Covered)

| Suite | Coverage | Result |
| --- | --- | --- |
| `cargo test -p tdm-core --test external_tools_security_matrix_tests` | Scenarios 1–23, 30, 32, 34, 35 (legacy key, dedicated key, unknown key, wrong-purpose Desktop key, revoked key, invalid sig, modified manifest, tampered artifact, expired, future-dated, replay, equivocation, unauthorized downgrade, authorized rollback, dual-key sidecar, unsafe key removal prevention, key rotation rollback, duplicate JSON key, unsupported schema, invalid platform, malicious redirect, missing artifact, wrong SHA-256, signing-key mismatch, partial `.sig` 404, CDN stale manifest, existing `v1.0.7` client compatibility) | **3/3 test suites PASS (`0` FAIL)** |
| `node scripts/verify_gate33_renewal_and_security.js` | Scenarios 24–35 + Authenticode Readiness + Immutable Registry (`G33S-01`..`G33S-14`) | **14/14 PASS (`0` FAIL)** |
| `node scripts/verify_gate33_staging_key_transition.js` | Real Cloudflare Pages HTTPS dedicated-key, rollback, invalid sig, revoked key, legacy prod compatibility, OEM parity (`G33-STG-01`..`G33-STG-09`) | **9/9 PASS (`0` FAIL)** |

---

## 18. Full TORI Regression Test Matrix (Phase 17)

| Suite / Command | Result | Notes |
| --- | --- | --- |
| `cargo test --workspace -j 2 --no-fail-fast` (40 targets) | **274 PASS, 0 FAIL, 0 IGNORED** | Includes `external_tools_security_matrix_tests` (`3/3`), `external_tools_updater_tests` (`11/11`), `updater_cryptography_tests` (`8/8`); transient 1s-TTL contention retry on `gate15_1_format_cache_tests` passed `8/8` cleanly |
| `cargo clippy --workspace --all-targets` | **0 ERRORS** | Exit 0 |
| `npm --prefix ui run lint` & `npm --prefix ui run build` | **0 ERRORS** | `oxlint` 0 errors (7 pre-existing warnings), `tsc -b && vite build` `278ms` |
| `cargo build --release -p tori-download-manager` | **PASS** | Isolated `target/release/tori-download-manager.exe` (OEM untouched) |
| `node scripts/verify_gate32_external_tools_updater.js` | **18 PASS, 0 FAIL** | Dual `G32-05` security check preserved (signed prod manifest accepted + unsigned direct BtbN blocked) |
| `node scripts/verify_gate32_1_remote_manifest.js` | **19 PASS, 0 FAIL** | Live `205 MiB` HTTPS FFmpeg/FFprobe update (`610.2s`), H.264/AAC/MP4/MKV/HLS/FFprobe, YouTube merge/playlist, atomic rollback & reapply, `rawFileSha256Match=true`, `exeShaMatch=true` |
| `node scripts/verify_gate29_1_idm_desktop_ui.js` | **20 PASS, 0 FAIL** | Desktop UI, Settings tabs, virtualization intact |
| `node scripts/verify_gate29_2_idm_progress_window.js` | **17 PASS, 0 FAIL** | Standalone IDM progress window intact |
| `node scripts/verify_gate29_4_final_integration.js` | **18 PASS, 0 FAIL, 0 TIMEOUT, 0 NOT TESTED** | `G294-SAFETY-DB` `rawFileSha256Match=true` |
| `node scripts/verify_gate31_4_toast_replacement.js` | **15 PASS, 0 FAIL** | Legacy toast stays replaced |
| `node scripts/verify_gate31_5_install_repair_and_preflight.js` | **23 PASS, 0 FAIL, 0 TIMEOUT, 0 NOT TESTED** | OEM safety & Native Messaging intact |
| `node scripts/verify_gate32_3_public_release.js --post-release` | **14 PASS, 0 FAIL** | All public `v1.0.7` & Companion `v1.0.10` invariants intact |

---

## 19. Production Invariants & User-Data Preservation (Phases 16 & 18)

- **Public Desktop:** `v1.0.7` (`id=454278227`, installer SHA-256 `142e4528...`) — **UNCHANGED**
- **Desktop `latest.json`:** `1.0.7` — **UNCHANGED**
- **Browser Companion:** `v1.0.10` (`extension-v1.0.10`, XPI `a93a4387...`, Chromium `f220fab2...`) — **UNCHANGED**
- **Production Tools Manifest:** `rev 1` (`9fa61a38...`), `.sig` (`e0e23db7...`), FFmpeg `N-129150-g7ddf7bc8a4-20261120` (`03d33066...`) — **UNCHANGED**
- **Official Website:** Desktop `v1.0.7` + Companion `v1.0.10` public pages — **UNCHANGED** (`fb42622` added isolated `assets/tools/staging/gate33/` only)
- **Installed OEM Desktop Binary:** `%LOCALAPPDATA%\TORI Download Manager\tori-download-manager.exe` (`v1.0.6`, SHA-256 `570833b379668f64d8f0a81e0a2c138635835e0c0382f37f24ec969caccf0fda`) — **UNCHANGED**
- **Production User Data:** `%APPDATA%\tori-download-manager\tdm_storage.sqlite` (`PRAGMA integrity_check = ok`, `42` downloads `8c54fcee...`, `355` chunks `79a5094e...`, `5` protected settings `3345a44d...`), all `11` `.tdm-part` files (`e701b86a...`), and Chrome/Edge/Firefox Native Messaging registry — **100% PRESERVED**.

---

## 20. Changed & Added Files

- **Rust Core & Tauri (`crates/tdm-core`, `src-tauri`):**
  - `crates/tdm-core/src/tools/types.rs`
  - `crates/tdm-core/src/tools/trust.rs`
  - `crates/tdm-core/src/tools/providers.rs`
  - `crates/tdm-core/src/tools/manager.rs`
  - `crates/tdm-core/src/tools/mod.rs`
  - `crates/tdm-core/tests/external_tools_security_matrix_tests.rs` (new)
  - `crates/tdm-core/tests/external_tools_updater_tests.rs`
  - `src-tauri/src/lib.rs`
- **Desktop Settings UI (`ui/`):**
  - `ui/src/types.ts`
  - `ui/src/components/ExternalToolsPanel.tsx`
  - `ui/src/App.css`
- **Operational Tooling, QA & Authenticode (`scripts/`, `.github/workflows/`):**
  - `scripts/renew_trusted_tools_manifest.js` (new)
  - `scripts/monitor_tools_manifest_expiry.js` (new)
  - `scripts/verify_gate33_renewal_and_security.js` (new)
  - `scripts/verify_gate33_staging_key_transition.js` (new)
  - `scripts/clean_windows_qa_guest.ps1` (new)
  - `scripts/run_clean_windows_vm_qa.ps1` (new)
  - `scripts/build_nsis_installer.ps1`
  - `scripts/verify_authenticode_readiness.ps1` (new)
  - `.github/workflows/clean-windows-release-qa.yml` (new)
  - `.github/workflows/tools-manifest-expiry-monitor.yml` (new)
- **Security Specifications, Policies, Registry & Runbooks (`docs/security/`, `docs/reports/`):**
  - `docs/security/EXTERNAL_TOOLS_SIGNING_KEY_MIGRATION_SPEC.md` (new)
  - `docs/security/TORI_RELEASE_SECURITY_POLICY.md` (new)
  - `docs/security/EXTERNAL_TOOLS_OPERATIONAL_RUNBOOKS.md` (new)
  - `docs/security/WINDOWS_AUTHENTICODE_INTEGRATION.md` (new)
  - `docs/security/manifest_expiry_monitoring_config.json` (new)
  - `docs/security/tools-manifest-registry/registry.json` (new)
  - `docs/security/tools-manifest-registry/history/prod_rev_0001_tools-manifest.json` & `.sig` (new)
  - `docs/reports/screenshots/gate33/gate33_01_external_tools_manifest_status_light.png` & `dark.png` (new)
  - `docs/reports/GATE33_EXTERNAL_TOOLS_SECURITY_AND_MAINTENANCE_REPORT.md` (this report)

---

## 21. Known Limitations

1. **Dedicated Production Key Not Active Publicly Yet:** Public Desktop `v1.0.7` clients still verify production manifests with shared key `CDC23D8CC8DA5397`. Production key separation completes only after generating production `tori-tools.key` offline and shipping a dual-key Desktop release (`v1.0.8+`) per Stage 1–3.
2. **Clean Windows 10 & Windows 11 VM Execution (`NOT TESTED`):** No pre-provisioned licensed clean Windows 10/11 Hyper-V VMs exist on the build workstation; automation is ready for operator Hyper-V VM provisioning or GitHub Actions clean runners.
3. **Windows Authenticode Code Signing (`NOT AVAILABLE`):** Pipeline integration and fail-closed guards are ready, but no commercial OV/EV or Azure Trusted Signing certificate is provisioned yet; public installers remain `NotSigned` for Authenticode.
4. **Upstream `BtbN/FFmpeg-Builds` Detached Signatures:** Upstream still does not provide detached publisher signatures; trust continues to rely on TORI provenance review, immutable mirroring, compatibility verification, and TORI Ed25519 manifest signing.

---

## 22. Remaining Blockers

- **Gate 33 Acceptance Blockers:** **NONE.**
- **Pre-Production Blockers for Future Stage 1 (`v1.0.8`) Dedicated-Key Rollout:**
  1. Operator offline generation and custody backup of production `tori-tools.key`.
  2. Embedding ONLY `tori-tools.key.pub` (and its 16-hex key ID) into `TrustedToolsKeyring::default_production_transition()` for `v1.0.8`.
  3. Optional provisioning of a Windows Authenticode / Azure Trusted Signing certificate and a clean Windows 10/11 VM or Actions run prior to `v1.0.8` publication.

---

## 23. Future Release Requirements (Recommended Next Gate — Gate 33.1 / Desktop `v1.0.8` Stage 1 Preflight)

1. Generate out-of-repo production `tori-tools.key` under approved custody (`Runbook 4`) and embed its public key in `TrustedToolsKeyring` alongside `CDC23D8CC8DA5397` (`Stage 1` dual-key client).
2. Perform routine production manifest metadata renewal (`rev 2`) before `2026-12-06` (30-day renewal due date for current `rev 1` expiring `2027-01-05`) using `scripts/renew_trusted_tools_manifest.js`.
3. Provision clean Windows 10/11 VM or run `.github/workflows/clean-windows-release-qa.yml` and optional Authenticode signing for `v1.0.8`.

---

## 24. Final Verdict: CONDITIONAL GO (Development & Staging Verified — Public Release NOT Performed)

All 18 Gate 33 acceptance criteria are verified with real automated tests and real Cloudflare Pages HTTPS staging execution; conditional only on the two honestly documented environment limitations (`Clean Windows 10/11 VM`: **NOT TESTED**; `Windows Authenticode`: **NOT AVAILABLE**).
