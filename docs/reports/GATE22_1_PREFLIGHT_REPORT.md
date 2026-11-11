# TORI Download Manager — Gate 22.1 Preflight Report
## Secure Auto-Updater Activation Safety Audit & Compatibility Preflight

**Date:** 2026-11-11  
**Project:** `F:\TORI\final tori download manager`  
**GitHub Repository:** `robijoychakma375-hash/tori-download-manager`  
**Target Release:** `v1.0.2` (Latest Stable, Release ID: `441473140`)  
**Tested Client Baselines:** `v1.0.0` (Production Release) & `v1.0.1` (Stable Release)  
**Preflight Test Results:** 26 / 26 PASSED (100% Automated Preflight Validation)  

---

## 1. Executive Preflight Summary

Gate 22 diagnosed the root cause of the in-app update check failure:
```text
"Update check error: Could not fetch a valid release JSON from the remote"
```
The failure was caused by the absence of `latest.json` on GitHub Release `v1.0.2`.

Gate 22.1 performs the final preflight safety audit to verify the manifest, validate deployment idempotency, test upgrade compatibility across released clients, evaluate user-data preservation, and produce a formal **GO / NO-GO** activation recommendation.

---

## 2. Step 1 — Manifest Validation Results

The local manifest artifact at `release/v1.0.2-final/latest.json` was inspected and validated against all requirements:

| Check Item | Requirement | Observed Value | Status |
| :--- | :--- | :--- | :---: |
| **1. Version** | Must be `1.0.2` | `"1.0.2"` | **PASS** |
| **2. JSON Schema** | Conforms to Tauri v2 `RemoteRelease` format | Valid JSON with `version`, `notes`, `pub_date`, `platforms` | **PASS** |
| **3. Platform ID** | Matches installed Windows x64 clients | `"windows-x86_64"` and `"windows-x86_64-nsis"` both present | **PASS** |
| **4. Installer URL** | Points to existing v1.0.2 release asset | `https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.2/TORI.Download.Manager_1.0.2_x64-setup.exe` | **PASS** |
| **5. Signature** | Exactly matches installer `.sig` file | Identical Minisign base64 string (`dW50cnVzdGVk...`) | **PASS** |
| **6. Public Key** | Compatible across released versions | `dW50cn...` (CDC23D8C) identical in v1.0.0, v1.0.1, v1.0.2 | **PASS** |
| **7. Installer SHA-256** | Matches published release checksum | `1ab7f3454dc08ef3b33843a9b8dfc3d3b2c5b2814fbe8946ef9b263f2d2452c2` | **PASS** |
| **8. Credential Safety** | Zero local paths or tokens exposed | Checked strings: 0 local drives, 0 usernames, 0 tokens | **PASS** |

---

## 3. Step 2 — Deployment Script Safety Assessment

Review of `scripts/deploy_gate22_updater_manifest.js`:

1. **Target Release Locking:** Strict pinning to GitHub Release ID `441473140` and tag `v1.0.2`.
2. **Strict Idempotency:**
   - Queries existing release assets prior to execution.
   - If `latest.json` is present and matches the local manifest, it logs `[IDEMPOTENT SAFE STOP]` and exits with code `0` without making any modifications.
3. **Conflict Refusal:**
   - If `latest.json` exists remotely but differs from the local manifest, it halts immediately with `[CONFLICT ERROR]` and exits with code `1`.
4. **Scope Isolation:**
   - Uploads strictly `latest.json`.
   - Never deletes other release assets.
   - Never alters git tags or commits.
   - Never creates a new release.
   - Never rebuilds installer binaries.
   - Never touches Cloudflare web hosting.
   - Never touches older releases (`v1.0.0`, `v1.0.1`).

---

## 4. Step 3 — Upgrade Compatibility & Cryptographic Validation

### 4.1 Cryptographic Verification Matrix
Minisign Ed25519 verification was executed using the official Rust `minisign-verify` engine:

```text
=== Verifying: TORI Download Manager_1.0.2_x64-setup.exe ===
  Installer Size: 117,073,652 bytes
  Signature trusted comment: "timestamp:1794389520\tfile:TORI Download Manager_1.0.2_x64-setup.exe"
  [OK] Minisign Ed25519 signature verified successfully!
  [OK] Tampered binary rejected correctly: InvalidSignature
```

- **v1.0.0 Binary:** Passes Minisign Ed25519 verification.
- **v1.0.1 Binary:** Passes Minisign Ed25519 verification.
- **v1.0.2 Binary:** Passes Minisign Ed25519 verification.
- **Tampered Binaries:** Single-bit corruption is strictly rejected with `InvalidSignature`.

### 4.2 Upgrade Path Evaluation
- **`v1.0.0 → v1.0.2`:** Supported in a single leap (`1.0.2 > 1.0.0`).
- **`v1.0.1 → v1.0.2`:** Supported in a single leap (`1.0.2 > 1.0.1`).
- **`v1.0.2 → v1.0.2`:** Evaluates to `1.0.2 == 1.0.2`, reporting "up to date" without false loops.
- **Downgrade Rejection:** Rejection of `1.0.1` against `1.0.2` and `0.9.0` against `1.0.0` confirmed.

### 4.3 User Data & SQLite Storage Preservation
- **Application Binaries:** Installed into `%LOCALAPPDATA%\Programs\TORI Download Manager`.
- **User Data & Settings:** Stored in `%APPDATA%\tori-download-manager\tdm_storage.sqlite`.
- **NSIS Hook Inspection:** `src-tauri/nsis/hooks.nsh` contains zero commands deleting the SQLite database or user directory.
- **Engine Recovery:** `src-tauri/src/lib.rs` restores persisted engine settings from `app_settings` on startup.

> [!WARNING]
> ### Physical In-Place Upgrade Status: **NOT TESTED**
> While architectural analysis, NSIS hook review, SQLite WAL compatibility, and mock server tests confirm data preservation, **an actual in-place GUI execution of the NSIS installer over an installed v1.0.0 instance has not been physically executed on a standalone Windows machine**.  
> In accordance with instructions, this is formally classified as **NOT TESTED** pending Separate-PC Physical Acceptance.

---

## 5. Step 4 — Live Activation Risk Assessment

| Risk | Likelihood | Impact | Mitigation in Place |
| :--- | :---: | :---: | :--- |
| **Active Download Interruption** | Low | Medium | **Mitigated:** `installUpdateSafe()` checks `getActiveDownloadsCount() > 0` and blocks update until active downloads finish. |
| **Windows SmartScreen Prompt** | High | Low | **Expected:** Commercial EV certificate is deferred; standard "More info -> Run anyway" workflow applies. |
| **Physical-PC In-Place Collision** | Medium | High | **Unverified (NOT TESTED):** Requires user acceptance on a separate clean machine before activating wide-scale distribution. |
| **Network Interruption during Download** | Medium | Low | **Mitigated:** Tauri updater validates signature only after full binary download; partial downloads are discarded. |
| **Malformed Manifest Injection** | Low | High | **Mitigated:** Strict JSON parsing, schema validation, and Minisign cryptographic verification reject invalid or unsigned payloads. |

---

## 6. Step 5 — Deployment & Rollback Procedures

### 6.1 Deployment Procedure (Upon Operator Authorization)
```bash
cd "F:\TORI\final tori download manager"
node scripts/deploy_gate22_updater_manifest.js --execute
```
The script will:
1. Verify local manifest validity and Minisign signature.
2. Query GitHub Release ID `441473140`.
3. If absent, upload `latest.json` (Asset ID will be logged).
4. If already present and concordant, halt safely with zero modifications.

### 6.2 Emergency Rollback Procedure
If a regression or issue is reported after activation, auto-updates can be disabled instantly without touching client machines:

**Option A — Delete Manifest (Disables Update Endpoint):**
```bash
curl.exe -X DELETE \
  -H "Authorization: Bearer <GITHUB_TOKEN>" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/robijoychakma375-hash/tori-download-manager/releases/assets/<ASSET_ID>
```
*Effect:* Reverts the endpoint to HTTP 404; clients report "up to date" or check error without downloading any installer.

**Option B — Deploy Null/Same-Version Manifest:**
Deploy a `latest.json` announcing version `1.0.0` (or `pub_date` in past). Clients compare SemVer and conclude they are already on the newest version.

---

## 7. Activation Decision & Recommendation

### Recommendation: **GO (Conditional on Operator Authorization)**

- **Cryptographic Readiness:** **100% READY** (Verified public key continuity, bit-for-bit installer SHA256 match, Minisign signature match).
- **Deployment Safety:** **100% READY** (Idempotent script, zero cross-impact on releases or repository).
- **Client Upgrade Logic:** **100% READY** (SemVer upgrade paths and downgrade protection verified).
- **Condition:** Operator must acknowledge that **Physical-PC in-place upgrade execution remains NOT TESTED**.

**Preflight Complete. All actions stopped awaiting operator instructions.**

