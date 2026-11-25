# TORI Download Manager — Gate 35 Stage 2 External Tools Signing Migration Readiness Design

**Document Status:** Technical Readiness Design Only (NO Production Cutover Executed)  
**Gate:** Gate 35.1 — Post-Release Production Audit, Security Hardening & Stage 2 Readiness  
**Date:** 2026-11-25  
**Production Baseline:**
- Public Desktop Stable: `v1.0.8` (GitHub Release ID `455125259`, commit `1a24265d247a43371ab2b637e195425df2c78b82`)
- Historical Desktop Stable: `v1.0.7` (GitHub Release ID `454278227`)
- Production External Tools Manifest: `https://toridownload.xyz/assets/tools/tools-manifest.json` (`schema_version = 2`, `manifest_revision = 2`, SHA-256 `caa2d4ed2a7e424badcd8662e67b986a3fdfbf2847dded0625ea2b2547663f3a`, expires `2027-01-21T19:46:42.049Z`)
- Production Legacy Shared Key ID: `CDC23D8CC8DA5397` (`ExternalToolsLegacyShared` / Desktop Auto-Updater key)
- Provisioned Dedicated External Tools Key ID: `C3FD6626A3718E63` (`ExternalToolsManifest`, encrypted scrypt local key at `C:\Users\ritud\.tori-keys\tori-tools.key`, public key embedded in `v1.0.8+`)

> [!IMPORTANT]
> **STAGE 2 PRODUCTION CUTOVER IS STRICTLY BLOCKED.**
> This document is an engineering design and migration blueprint only. No production manifest revision 3 has been published, no signing keys were regenerated or rotated, and `CDC23D8CC8DA5397` remains the active production signer for `rev 2`.

---

## 1. Executive Summary & Critical Gate 35.1 Architectural Discovery (`SEC-35-03`)

During the Gate 35.1 line-level cryptographic audit of `crates/tdm-core/src/tools/providers.rs` and `crates/tdm-core/src/tools/types.rs`, we uncovered a **critical Stage 2 compatibility defect in shipped Desktop `v1.0.8`** (`SEC-35-03`):

1. Shipped Desktop `v1.0.8` (`commit 1a24265d`) embeds BOTH `CDC23D8CC8DA5397` (`ExternalToolsLegacyShared`) and `C3FD6626A3718E63` (`ExternalToolsManifest`) inside `TrustedToolsKeyring::default_production_transition()`.
2. However, `ToolsManagerConfig::default()` sets `tools_keyring: None` and `expected_manifest_key_id: Some("CDC23D8CC8DA5397")`.
3. In shipped `v1.0.8`, `providers.rs:432-442` checks:
   ```rust
   if config.tools_keyring.is_none() {
       if let Some(ref expected_kid) = config.expected_manifest_key_id {
           if actual_key_id.as_deref() != Some(exp_norm.as_str()) {
               return ManifestFetchOutcome::RejectedSecurity(...);
           }
       }
   }
   ```
4. **Consequence for shipped `v1.0.8`:**
   - **Stage 1 (Legacy Primary `.sig` by `CDC23D8CC8DA5397`):** **WORKS** in `v1.0.7` and `v1.0.8`.
   - **Stage 1.5 (Dual-Signed: Primary `.sig` by `CDC23D8CC8DA5397` + Sidecar `.tools.sig` by `C3FD6626A3718E63` with `"dedicated_signing_key_id": "C3FD6626A3718E63"`):** **WORKS** in BOTH `v1.0.7` (ignores unknown `dedicated_signing_key_id` field, verifies `.sig`) AND shipped `v1.0.8` (verifies `.sig` against `CDC23D8CC8DA5397` AND cryptographically enforces `.tools.sig` against `C3FD6626A3718E63` at `providers.rs:469-537`!).
   - **Stage 2 (Dedicated-Only Primary `.sig` by `C3FD6626A3718E63`):** **FAILS (`RejectedSecurity`)** in BOTH `v1.0.7` AND shipped `v1.0.8`!
5. **Gate 35.1 Remediation (Local Branch `feat/gate35_1-postrelease-security-hardening`, slated for Desktop `v1.0.9`):**
   - `providers.rs:432` was hardened to `if config.tools_keyring.is_none() && keyring.keys.len() == 1`, preserving strict `expected_manifest_key_id` enforcement for explicit single-key overrides while allowing the default multi-key transition keyring to accept primary `.sig` signatures from **either** `CDC23D8CC8DA5397` or `C3FD6626A3718E63`.
   - Regression-verified by `test_sec35_03_default_transition_config_has_dual_key_keyring_and_accepts_dedicated_primary` in `crates/tdm-core/tests/gate35_security_hardening_tests.rs`.

### Strategic Impact on Rollout Sequence
Because shipped `v1.0.8` cannot verify a dedicated-only primary `.sig`, TORI **MUST NOT** jump directly from Stage 1 (`rev 2`) to Stage 2 (dedicated-only primary `.sig`) while `v1.0.7` or `v1.0.8` clients remain active! Instead, TORI must follow a strict 3-stage bridge:
- **Stage 1 (Current Live Production — `rev 2`):** Single `.sig` signed by `CDC23D8CC8DA5397`.
- **Stage 1.5 (Dual-Signed Transition — Future `rev 3`, after offline key backup verification):** Primary `.sig` signed by `CDC23D8CC8DA5397` **PLUS** detached `.tools.sig` sidecar signed by `C3FD6626A3718E63` over the exact identical manifest bytes, with `"dedicated_signing_key_id": "C3FD6626A3718E63"` inside `tools-manifest.json`. Zero breakage for `v1.0.7`, full dual-signature enforcement for `v1.0.8` and `v1.0.9+`.
- **Stage 2 (Dedicated-Only Cutover — Future `rev 4+`, ONLY after `v1.0.9+` fleet adoption & legacy deprecation):** Primary `.sig` signed directly by `C3FD6626A3718E63` (`"signing_key_id": "C3FD6626A3718E63"`, no `.tools.sig` required).
- **Stage 3 (Legacy Key Retirement — Future `v1.1.0+`):** Set `allow_legacy_shared_key = false` and mark `CDC23D8CC8DA5397` as `Retired` for External Tools (while preserving `CDC23D8CC8DA5397` solely for Tauri Desktop Auto-Updater).

---

## 2. Dual-Signed Metadata Readiness (Stage 1.5) vs Dedicated-Only Signing (Stage 2)

The existing manifest format (`schema_version = 2`) **already supports dual signing via a separate detached sidecar signature file** without breaking the single-signature `.sig` contract:

| Dimension | Stage 1 (Current `rev 2`) | Stage 1.5 (Dual-Signed Bridge) | Stage 2 (Dedicated-Only Cutover) |
| :--- | :--- | :--- | :--- |
| **Manifest File** | `tools-manifest.json` | `tools-manifest.json` | `tools-manifest.json` |
| **Primary Signature File** | `tools-manifest.json.sig` (`CDC23D8CC8DA5397`) | `tools-manifest.json.sig` (`CDC23D8CC8DA5397`) | `tools-manifest.json.sig` (`C3FD6626A3718E63`) |
| **Sidecar Signature File** | None | `tools-manifest.json.tools.sig` (`C3FD6626A3718E63`) | Optional / None |
| **`schema_version`** | `2` | `2` | `2` |
| **`manifest_revision`** | `2` | `3` (strictly monotonic `> 2`) | `4+` (strictly monotonic `> 3`) |
| **`signing_key_id`** | `"CDC23D8CC8DA5397"` | `"CDC23D8CC8DA5397"` | `"C3FD6626A3718E63"` |
| **`dedicated_signing_key_id`** | Omitted (`null`) | `"C3FD6626A3718E63"` | Omitted (`null`) or `"C3FD6626A3718E63"` |
| **`key_purpose`** | `"external_tools_manifest"` | `"external_tools_manifest"` | `"external_tools_manifest"` |
| **Desktop `v1.0.7` Result** | **PASS** (legacy `.sig`) | **PASS** (verifies `.sig`, ignores extra field) | **REJECTED** (unknown key ID) |
| **Shipped Desktop `v1.0.8` Result** | **PASS** (legacy `.sig`) | **PASS** (verifies BOTH `.sig` AND `.tools.sig`) | **REJECTED** (`SEC-35-03` bug in `providers.rs:432`) |
| **Hardened Desktop `v1.0.9+` Result** | **PASS** (legacy `.sig`) | **PASS** (verifies BOTH `.sig` AND `.tools.sig`) | **PASS** (verifies dedicated `.sig`) |
| **Future Stage 3 Desktop (`v1.1.0+`)** | **REJECTED** (legacy retired) | **REJECTED** (legacy primary retired) | **PASS** (dedicated-only active) |

---

## 3. Complete Cryptographic Verification Matrix

| Scenario | Desktop `v1.0.7` | Shipped `v1.0.8` | Hardened `v1.0.9` | Future Stage 3 (`v1.1.0+`) |
| :--- | :--- | :--- | :--- | :--- |
| Valid `rev 2` signed by `CDC23D8CC8DA5397` | ACCEPT | ACCEPT | ACCEPT | REJECT (`LegacyKeyDisabled`) |
| Valid `rev 3` dual-signed (`.sig` legacy + `.tools.sig` dedicated) | ACCEPT (`.sig` only) | ACCEPT (BOTH verified) | ACCEPT (BOTH verified) | REJECT (legacy primary) |
| Dual-signed `rev 3` with **missing `.tools.sig` (404)** | ACCEPT (`.sig` only) | **REJECT (`RejectedSecurity`)** | **REJECT (`RejectedSecurity`)** | REJECT |
| Dual-signed `rev 3` with **tampered `.tools.sig`** | ACCEPT (`.sig` only) | **REJECT (`RejectedSecurity`)** | **REJECT (`RejectedSecurity`)** | REJECT |
| Valid `rev 4` primary `.sig` signed by `C3FD6626A3718E63` | REJECT | **REJECT (`SEC-35-03`)** | **ACCEPT** | **ACCEPT** |
| Manifest signed by unknown Ed25519 key | REJECT | REJECT | REJECT | REJECT |
| Manifest with `key_purpose: "desktop_app_updater"` | REJECT | REJECT | REJECT | REJECT |
| Manifest with `signing_key_id` mismatching signature header | REJECT | REJECT | REJECT | REJECT |
| Expired manifest (`now > expires_at + 900s`) | REJECT | REJECT | REJECT | REJECT |
| Future-dated manifest (`published_at > now + 900s`) | REJECT | REJECT | REJECT | REJECT |
| Lower revision replay (`rev 1` after `rev 2`) | REJECT | REJECT | REJECT | REJECT |
| Same-revision equivocation (modified bytes, same `rev`) | REJECT | REJECT | REJECT | REJECT |
| **Schema v1 downgrade (`schema_version=1, rev=0` after `rev 2`)** | VULNERABLE (`SEC-35-05`) | VULNERABLE (`SEC-35-05`) | **REJECT (`SEC-35-05` fixed)** | **REJECT** |
| Revoked dedicated key in `revoked_key_ids` | N/A | REJECT | REJECT | REJECT |

---

## 4. Dedicated-Key Signing Workflow (Offline Maintainer Procedure)

No private keys or passphrases may ever reside in Git, CI secrets without hardware protection, `release/`, or `tori-website`.

### 4.1 Prerequisites Before Any Signing Operation
1. **Offline Backup & Recovery Verification Complete (`BACKUP_VERIFIED` + `BACKUP_RECOVERY_VERIFIED`):**
   - Dedicated key `C3FD6626A3718E63` (`C:\Users\ritud\.tori-keys\tori-tools.key`) exported to at least two independent encrypted offline media copies (e.g., BitLocker/VeraCrypt USB + cold archive) with passphrase recorded in a separate offline vault.
   - Independent recovery drill executed: restore `tori-tools.key` into a clean temp directory, verify public key fingerprint equals `6807e183079787d7d00f889293a27a880b2a346e83556d3d090f28b92a132c9d` and Key ID equals `C3FD6626A3718E63`, sign a scratch test payload, verify Ed25519 signature, then securely wipe scratch directory.
2. **Workstation Key Directory Hardening:**
   - Restrict `C:\Users\ritud\.tori-keys` directory NTFS ACL to owner-only (`keyDirAclHardenedOwnerOnly = true`) and remove legacy plaintext `tori-updater.key.pwd` if no longer needed (or migrate to interactive passphrase entry).
3. **Separate Explicit Owner Authorization:**
   - Signed renewal / migration approval token specifying exact target `manifest_revision`, `expires_at` (`<= 60` days recommended), and target signing mode (`dual_signed` vs `dedicated_only`).

### 4.2 Stage 1.5 Dual-Signed Publication Workflow (`rev 3`)
1. Generate canonical `tools-manifest.json` with:
   - `schema_version: 2`, `manifest_revision: 3`
   - `published_at: <current UTC RFC3339>`, `expires_at: <published_at + 60 days>`
   - `signing_key_id: "CDC23D8CC8DA5397"`
   - `dedicated_signing_key_id: "C3FD6626A3718E63"`
   - `key_purpose: "external_tools_manifest"`
   - Verified SHA-256, exact byte sizes, and HTTPS GitHub release URLs for `yt-dlp` and `ffmpeg_bundle`.
2. Sign exact raw bytes of `tools-manifest.json` with legacy key `CDC23D8CC8DA5397` -> produce `tools-manifest.json.sig`.
3. Sign the **exact identical raw bytes** of `tools-manifest.json` with dedicated key `C3FD6626A3718E63` (prompted interactively via scrypt passphrase — never persisted in `.pwd` file) -> produce `tools-manifest.json.tools.sig`.
4. Verify BOTH signatures offline locally against `TORI_ED25519_PUBKEY_B64` and `TORI_DEDICATED_TOOLS_ED25519_PUBKEY_B64` AND run staging verification under `/assets/tools/staging/gate35/`.
5. Publish `tools-manifest.json`, `tools-manifest.json.sig`, and `tools-manifest.json.tools.sig` atomically in a single Cloudflare Pages deployment so clients never observe `tools-manifest.json` referencing `dedicated_signing_key_id` while `.tools.sig` returns HTTP 404!

### 4.3 Stage 2 Dedicated-Only Cutover Workflow (`rev 4+`)
**Hard Entry Gates (ALL MUST BE TRUE):**
- [ ] `BACKUP_VERIFIED` and `BACKUP_RECOVERY_VERIFIED` formally recorded and signed off by owner.
- [ ] Hardened Desktop **`v1.0.9+`** (containing the `SEC-35-03` multi-key `providers.rs:432` fix and `SEC-35-05` schema-downgrade fix) is published as public Stable and promoted via `latest.json`.
- [ ] Sufficient fleet migration window elapsed (recommended: >= 30–60 days after `v1.0.9` public release, or owner explicitly accepts end-of-manifest-updates for un-upgraded `v1.0.7`/`v1.0.8` clients — note un-upgraded clients gracefully continue using bundled tools and auto-update Desktop via `latest.json` signed by `CDC23D8CC8DA5397`!).
- [ ] Stage 1.5 dual-signed `rev 3` ran cleanly in production with zero verification incidents.
- [ ] Separate explicit owner approval issued for Stage 2 cutover.

**Execution Steps:**
1. Publish `manifest_revision: 4` (or `N+1`) with `"signing_key_id": "C3FD6626A3718E63"`, `"dedicated_signing_key_id": null`, signed into primary `tools-manifest.json.sig` using `tori-tools.key` (`C3FD6626A3718E63`).
2. Update `scripts/monitor_tools_manifest_expiry.js` and `docs/security/EXTERNAL_TOOLS_MANIFEST_REGISTRY.json` to expect `C3FD6626A3718E63` on primary `.sig`.
3. Verify live multi-pass HTTPS download, Ed25519 verification, and GitHub Actions daily expiry monitor (`427101855`) pass `HEALTHY`.

---

## 5. Anti-Replay, Rollback Safety, Recovery & Incident Response

### 5.1 Monotonic Revision & Equivocation Protection
- Every client persists `highest_accepted_revision` and `last_accepted_manifest_sha256` in SQLite (`engine_settings.external_tools_manifest_state`).
- **Rule:** Never republish altered bytes under an existing `manifest_revision`. Even a 1-byte whitespace edit or hotfix rollback **MUST increment `manifest_revision` (`rev N -> rev N+1`)**.
- Hardened Desktop `v1.0.9+` additionally blocks `schema_version: 1` downgrade attacks whenever `highest_accepted_revision > 0` (`SEC-35-05`).

### 5.2 Recovery from Failed Publication
- **Symptom A — Partial upload / `.tools.sig` missing (404) during Stage 1.5:**
  - `v1.0.8+` clients fail closed (`RejectedSecurity`) and keep existing active/bundled binaries safely without modifying disk state.
  - Fix: Re-deploy complete atomic Cloudflare Pages bundle containing matching `tools-manifest.json` + `.sig` + `.tools.sig`, or roll forward to `rev N+1` without `dedicated_signing_key_id`.
- **Symptom B — Bad tool artifact or broken upstream release in `rev N`:**
  - Client-side post-switch verification automatically quarantines the bad tool version and rolls back to the previous verified managed slot (or bundled binary), clearing `*_pending` cleanly (`SEC-35-10` fix prevents 30s retry loops).
  - Server-side remediation: Publish **`rev N+1`** reverting the tool entry to the last known-good version with `"allow_rollback_to": true`, signed and verified cleanly. Never decrement `manifest_revision`!

### 5.3 Key Compromise Response Playbook
1. **Dedicated Tools Key (`C3FD6626A3718E63`) Compromised:**
   - Desktop Auto-Updater (`CDC23D8CC8DA5397`) remains **completely uncompromised** (domain separation holds!).
   - Provision a new offline dedicated tools key `K_new` (with verified offline backup).
   - Ship emergency Desktop patch adding `C3FD6626A3718E63` to `TrustedToolsKeyring.revoked_key_ids` and pinning `K_new` (`Active`), delivered immediately via the uncompromised Tauri Auto-Updater (`latest.json`).
   - Publish `rev N+1` signed by `K_new` (or temporarily dual-signed with `CDC23D8CC8DA5397` if still uncompromised during transition).
2. **Legacy Shared Key (`CDC23D8CC8DA5397`) Compromised:**
   - Immediately revoke `CDC23D8CC8DA5397` in `TrustedToolsKeyring.revoked_key_ids` and set `allow_legacy_shared_key = false` in a new Desktop release signed by a newly provisioned Desktop Updater key (requiring manual re-install or new trust root for updater), while External Tools immediately operates solely on `C3FD6626A3718E63` (`rev N+1`).

### 5.4 Legacy-Key Retirement Criteria (Stage 3 — `v1.1.0+`)
Retire `CDC23D8CC8DA5397` from External Tools verification (`status = Retired`, `allow_legacy_shared_key = false`) ONLY when:
1. Stage 2 dedicated-only signing (`C3FD6626A3718E63`) has operated stably in production for >= 60 days across at least one full manifest renewal cycle.
2. Independent offline backup + recovery verification of `C3FD6626A3718E63` is current and verified.
3. All active Desktop clients are `v1.0.9+` (or `v1.0.7`/`v1.0.8` have reached planned end-of-support).
4. `CDC23D8CC8DA5397` remains intact exclusively for Tauri Desktop Auto-Updater unless a separate Desktop Updater key rotation gate is authorized.

### 5.5 Expiry Monitoring Compatibility
- Production GitHub Actions workflow `.github/workflows/external-tools-manifest-monitor.yml` (Workflow ID `427101855`) runs daily and verifies live signature, expiry threshold (`30d / 14d / 7d / 48h / expired`), revision registry drift, redirect allowlist, and artifact availability (`HEAD 200`).
- During Stage 1.5, update `scripts/monitor_tools_manifest_expiry.js` to validate BOTH `.sig` (`CDC23D8CC8DA5397`) AND `.tools.sig` (`C3FD6626A3718E63`) whenever `dedicated_signing_key_id` is present so sidecar drift or missing `.tools.sig` triggers an immediate `SECURITY_INCIDENT` alert!
