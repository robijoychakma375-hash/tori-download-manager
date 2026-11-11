# TORI Download Manager — Gate 22 Diagnosis & Migration Report
## In-App Auto-Updater Root Cause Analysis, Security Audit & Safe Migration Plan

**Date:** 2026-11-11  
**Project:** `F:\TORI\final tori download manager`  
**GitHub Repository:** `robijoychakma375-hash/tori-download-manager`  
**Current Published Release:** `v1.0.2` (Latest Stable, Release ID: `441473140`)  
**Tested Installed Client:** `v1.0.0` (Production Release, Tag: `v1.0.0`)  
**Test Suite Status:** 29 / 29 PASSED (100% Verified in Isolated Test Harness)  

---

## 1. Executive Summary

### 1.1 The Reported Incident
A user running an installed instance of **TORI Download Manager v1.0.0** attempted to perform an in-app upgrade to **v1.0.2** by navigating to **Settings → About → Check for Updates**.

The application displayed the following error banner:
```text
Update check error: Could not fetch a valid release JSON from the remote
```
The user confirmed that the automatic update toggle was enabled, their internet connection was active, and normal downloads functioned properly.

### 1.2 Root Cause Summary
1. **GitHub Dynamic Release Resolution:** In `tauri.conf.json`, TORI Download Manager configures its update endpoint as:
   ```text
   https://github.com/robijoychakma375-hash/tori-download-manager/releases/latest/download/latest.json
   ```
   GitHub dynamically maps `/releases/latest/download/<filename>` to `/releases/download/<LATEST_RELEASE_TAG>/<filename>`.
2. **Current Latest Tag:** When TORI v1.0.2 was published during Gate 21.1 with `make_latest: true`, `<LATEST_RELEASE_TAG>` became `v1.0.2`.
3. **Endpoint Target HTTP 404:** GitHub issued an HTTP `302 Found` redirecting from `/releases/latest/download/latest.json` to:
   ```text
   https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.2/latest.json
   ```
   However, `latest.json` was omitted from the release assets of GitHub Release `v1.0.2`. Consequently, this request returned **`HTTP 404 Not Found`**.
4. **Tauri Updater Error Path:** In `tauri-plugin-updater` (v2.14.1), when an endpoint returns a non-2xx status code (`res.status().is_success() == false`), the internal `remote_release` remains `None`. At line 661 of `updater.rs`, the code evaluates:
   ```rust
   let release = remote_release.ok_or(Error::ReleaseNotFound)?;
   ```
   `Error::ReleaseNotFound` has the display formatting:
   ```rust
   #[error("Could not fetch a valid release JSON from the remote")]
   ReleaseNotFound,
   ```
   The frontend caught this string and formatted it into the UI as:
   `"Update check error: Could not fetch a valid release JSON from the remote"`.

### 1.3 Cryptographic Key Continuity & Safety Findings
- **Zero Key Drift:** The updater public key hardcoded in `v1.0.0`, `v1.0.1`, and `v1.0.2` `tauri.conf.json` is **100% bit-for-bit identical**:
  ```text
  dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IENEQzIzRDhDQzhEQTUzOTcKUldTWFU5cklqRDNDelRBOVAzOSs1L0RXN0FFLy9YWGFJc2NnUStaNktxSkNOQ1ZCeG01MjFTZzQK
  ```
- **Cryptographic Verification:** The official Windows NSIS installer for v1.0.2 (`TORI Download Manager_1.0.2_x64-setup.exe`, SHA256: `1ab7f3454dc08ef3b33843a9b8dfc3d3b2c5b2814fbe8946ef9b263f2d2452c2`) and its accompanying Minisign Ed25519 signature file pass complete cryptographic verification against this key.
- **Tamper Rejection:** Single-bit corruption of the installer binary is strictly rejected with `InvalidSignature`.
- **User Data Safety:** The NSIS installation routines in `hooks.nsh` update binary files in `%LOCALAPPDATA%\Programs\TORI Download Manager` while leaving `%APPDATA%\com.tori.downloadmanager\` and the SQLite database `tdm_storage.sqlite` completely untouched.

---

## 2. Phase 1 — Deep Root Cause Investigation

### 2.1 Codebase Audit Across Versions
A line-by-line inspection was performed across git tags `v1.0.0`, `v1.0.1`, and `v1.0.2`:

| Component | v1.0.0 Tag | v1.0.1 Tag | v1.0.2 HEAD | Status |
| :--- | :--- | :--- | :--- | :--- |
| `src-tauri/tauri.conf.json` | `version: "1.0.0"` | `version: "1.0.1"` | `version: "1.0.2"` | Aligned |
| Updater Plugin Crate | `tauri-plugin-updater 2.14.1` | `tauri-plugin-updater 2.14.1` | `tauri-plugin-updater 2.14.1` | Identical |
| Public Key (`pubkey`) | `dW50cn...` (CDC23D8C) | `dW50cn...` (CDC23D8C) | `dW50cn...` (CDC23D8C) | **100% Identical** |
| Updater Endpoint | `.../releases/latest/download/latest.json` | `.../releases/latest/download/latest.json` | `.../releases/latest/download/latest.json` | **100% Identical** |
| Capabilities (`default.json`)| `updater:default` | `updater:default` | `updater:default` | Granted |
| UI Logic (`ui/src/updater.ts`)| `check()`, `download()`, `install()` | `check()`, `download()`, `install()` | `check()`, `download()`, `install()` | Identical |

### 2.2 Live Network & HTTP Redirect Chain Trace
Using curl to trace the exact request initiated by the application:

```text
Step 1: Client sends GET request:
  GET https://github.com/robijoychakma375-hash/tori-download-manager/releases/latest/download/latest.json
  Header: Accept: application/json
  Header: User-Agent: tauri-plugin-updater/2.14.1

Step 2: GitHub edge server responds:
  HTTP/1.1 302 Found
  Location: https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.2/latest.json

Step 3: Client follows redirect:
  GET https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.2/latest.json

Step 4: GitHub storage responds:
  HTTP/1.1 404 Not Found
  Content-Length: 9
  Body: "Not Found"
```

### 2.3 Rust Internal Execution Path
In `tauri-plugin-updater-2.14.1\src\updater.rs`:
```rust
// Lines 610-661 in updater.rs:
match response {
    Ok(res) => {
        if res.status().is_success() {
            // Evaluates to FALSE on HTTP 404
            ...
        } else {
            log::error!("update endpoint did not respond with a successful status code");
        }
    }
    ...
}

// Since res.status().is_success() was false, remote_release was never set:
let release = remote_release.ok_or(Error::ReleaseNotFound)?;
```
`Error::ReleaseNotFound` maps directly to:
`#[error("Could not fetch a valid release JSON from the remote")]`.

In `ui/src/updater.ts`:
```typescript
try {
  const update = await check();
  ...
} catch (err: unknown) {
  const errStr = String(err);
  return {
    available: false,
    update: null,
    error: `Update check error: ${errStr}`
  };
}
```
Resulting in the exact error displayed to the user.

---

## 3. Phase 2 — Safe Update Migration Plan

### 3.1 Architecture of the Solution
Because `v1.0.0` and `v1.0.1` clients query `/releases/latest/download/latest.json` dynamically, **no client rebuild or source code modification is required for installed users**.

By uploading a correctly formatted, cryptographically signed `latest.json` directly to the published GitHub Release **v1.0.2** (Release ID `441473140`), all existing `v1.0.0` and `v1.0.1` installations will instantly and securely detect `v1.0.2` on their next update check.

### 3.2 Required `latest.json` Schema & Content
To support both Tauri v2 standard target resolution (`windows-x86_64-nsis`) and legacy/generic resolution (`windows-x86_64`), the payload provides both platform keys:

```json
{
  "version": "1.0.2",
  "notes": "TORI Download Manager v1.0.2 Production Release.\n\n- Unified Version Parity across Desktop Engine and Extensions (v1.0.2)\n- Persistent Engine Lifecycle & Tray Hardening\n- Multi-Stream Chunking (C=4/8) & SQLite WAL Crash Recovery\n- Officially Signed Firefox AMO Extension & Edge/Chrome MV3 Integration\n- Full Third-Party Notices & GPLv3 Compliance",
  "pub_date": "2026-11-11T12:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVTWFU5cklqRDNDemFqMWd0R3IwbTc2WXJuelZZV2t0eStuMlh6enRUYWlzTy9WOUNWOE1LcGpOak4yMXdVd0todUpLU3BLMWt1N2hQU3d3ajJNUlNaNEFvaGgxOUdJYXdrPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzk0Mzg5NTIwCWZpbGU6VE9SSSBEb3dubG9hZCBNYW5hZ2VyXzEuMC4yX3g2NC1zZXR1cC5leGUKVVJCNlpyZ3pJNkRrQmJadG5HYlZ0YXBhRHZ4U1B1NzJqZ052U2Z5c25PNFBxTkRXMG9uWDJjOW1SMnVMYW1OWW9nbG9MbmgzOFdFY1hLaVhITnRhRFE9PQo=",
      "url": "https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.2/TORI.Download.Manager_1.0.2_x64-setup.exe"
    },
    "windows-x86_64-nsis": {
      "signature": "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVTWFU5cklqRDNDemFqMWd0R3IwbTc2WXJuelZZV2t0eStuMlh6enRUYWlzTy9WOUNWOE1LcGpOak4yMXdVd0todUpLU3BLMWt1N2hQU3d3ajJNUlNaNEFvaGgxOUdJYXdrPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzk0Mzg5NTIwCWZpbGU6VE9SSSBEb3dubG9hZCBNYW5hZ2VyXzEuMC4yX3g2NC1zZXR1cC5leGUKVVJCNlpyZ3pJNkRrQmJadG5HYlZ0YXBhRHZ4U1B1NzJqZ052U2Z5c25PNFBxTkRXMG9uWDJjOW1SMnVMYW1OWW9nbG9MbmgzOFdFY1hLaVhITnRhRFE9PQo=",
      "url": "https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.2/TORI.Download.Manager_1.0.2_x64-setup.exe"
    }
  }
}
```

> [!IMPORTANT]
> **GitHub Asset Filename Normalization:**  
> GitHub release asset uploads convert spaces to periods: `TORI.Download.Manager_1.0.2_x64-setup.exe`.  
> Live HTTP tests confirmed that `TORI.Download.Manager_1.0.2_x64-setup.exe` returns `302 Found` with full binary download, whereas `TORI%20Download%20Manager_1.0.2_x64-setup.exe` returns `404 Not Found`. The download URL in `latest.json` accurately reflects the dot-normalized asset name.

### 3.3 Upgrade Path Matrix
- **v1.0.0 → v1.0.2:** Fully supported in a single leap. Direct update replaces application binaries, leaving SQLite databases and download history intact.
- **v1.0.1 → v1.0.2:** Fully supported in a single leap.
- **v1.0.2 → v1.0.2:** Application reports "up to date" (`status: up_to_date`), avoiding recursive update prompts.

---

## 4. Phase 3 — Security & Cryptographic Verification

### 4.1 Cryptographic Identity & Signature Audit
All verification tests were executed against the release binaries using standard Minisign cryptographic verification algorithms:

| Property | Value | Status |
| :--- | :--- | :--- |
| **Algorithm** | Minisign Ed25519 | Verified |
| **Public Key (Base64)** | `dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IENEQzIzRDhDQzhEQTUzOTcKUldTWFU5cklqRDNDelRBOVAzOSs1L0RXN0FFLy9YWGFJc2NnUStaNktxSkNOQ1ZCeG01MjFTZzQK` | Verified |
| **Public Key Decoded** | `untrusted comment: minisign public key: CDC23D8CC8DA5397\nRWSXU9rIjD3CzTA9P39+5/DW7AE//XXaIscgQ+Z6KqJCNCVBxm521Sg4` | Verified |
| **v1.0.2 Installer SHA-256** | `1ab7f3454dc08ef3b33843a9b8dfc3d3b2c5b2814fbe8946ef9b263f2d2452c2` | Bit-for-bit Concordance |
| **v1.0.2 Installer Size** | `117,073,652` bytes | Verified |
| **Signature File SHA-256** | `936d40e044901e16e1e2caff0040fe24342f054949ecccd3198696070e4fad5c` | Verified |
| **Signature Trusted Comment** | `timestamp:1794389520\tfile:TORI Download Manager_1.0.2_x64-setup.exe` | Verified |
| **Tamper Resistance** | Flipping 1 byte in the installer binary triggers `InvalidSignature` | PASS |

### 4.2 Downgrade Protection & Anti-Rollback Safeguards
Tauri v2 updater evaluates updates using strict SemVer semantics:
```rust
let should_update = release.version > self.current_version;
```
If an adversary attempts to serve an older or revoked release (e.g. `0.9.0` or `1.0.1` to a `1.0.2` client):
- `release.version > self.current_version` evaluates to `false`.
- The updater terminates with `Ok(None)` without initiating a download or executing any installer.

### 4.3 Active Download Safety Collision Guard
In `ui/src/updater.ts`, the application queries the core engine before initiating an installation:
```typescript
export async function installUpdateSafe(update: Update) {
  const activeCount = await getActiveDownloadsCount();
  if (activeCount > 0) {
    return {
      success: false,
      activeDownloads: activeCount,
      error: `Cannot install update while ${activeCount} download(s) are actively downloading.`
    };
  }
  await update.install();
  return { success: true };
}
```
If downloads are in progress, the updater halts and prompts the user to pause or complete active transfers first, preventing file corruption and lost chunks.

---

## 5. Phase 4 — Isolated Testing Suite & Verification Matrix

An automated test suite was constructed and executed in `scripts/verify_gate22_updater_isolated.js` using a local ephemeral HTTP server.

```text
================================================================
GATE 22 ISOLATED VERIFICATION SUMMARY: 29/29 PASSED (0 FAILED)
================================================================
```

### Detailed Scenario Test Results

| # | Scenario / Test Case | Input / Condition | Expected Behavior | Observed Result | Status |
| :-: | :--- | :--- | :--- | :--- | :-: |
| 1 | **Key Continuity (v1.0.0 vs v1.0.1)** | Tag comparison | Identical pubkey string | Matched exactly | PASS |
| 2 | **Key Continuity (v1.0.0 vs v1.0.2)** | Tag comparison | Identical pubkey string | Matched exactly | PASS |
| 3 | **Endpoint Continuity** | Config comparison | Identical endpoint URL | Matched exactly | PASS |
| 4 | **GitHub 302 Redirect** | Live HTTP probe | Redirects to latest release | Redirects to `/v1.0.2/` | PASS |
| 5 | **Missing Manifest (HTTP 404)** | Live HTTP probe | Confirms 404 response | Returned HTTP 404 | PASS |
| 6 | **Installer File Integrity** | Local disk check | Installer exists | Present in `release/v1.0.2-final/` | PASS |
| 7 | **Installer SHA-256 Check** | Hash computation | Matches release manifest | `1ab7f345...52c2` | PASS |
| 8 | **Minisign Cryptographic Verification**| Binary + signature | Verified by `PublicKey::verify` | Verified successfully | PASS |
| 9 | **Tampered Binary Rejection** | Flipped 1 byte | Throws `InvalidSignature` | Rejected with `InvalidSignature` | PASS |
| 10 | **Manifest Version Field** | JSON parsing | `version: "1.0.2"` | `1.0.2` | PASS |
| 11 | **RFC3339 Timestamp** | Date parsing | Valid ISO date | `2026-11-11T12:00:00Z` | PASS |
| 12 | **Target: `windows-x86_64`** | Manifest check | Key present | Present | PASS |
| 13 | **Target: `windows-x86_64-nsis`** | Manifest check | Key present | Present | PASS |
| 14 | **HTTPS Download URL** | URL inspection | Secure GitHub release link | Verified | PASS |
| 15 | **Signature Concordance** | Manifest vs Sig file | Matches exact base64 | Matched exactly | PASS |
| 16 | **Scenario 1: v1.0.0 → v1.0.2 Upgrade** | Client: 1.0.0, Remote: 1.0.2 | Update detected as available | `available: true`, `ver: 1.0.2` | PASS |
| 17 | **Scenario 2: v1.0.1 → v1.0.2 Upgrade** | Client: 1.0.1, Remote: 1.0.2 | Update detected as available | `available: true`, `ver: 1.0.2` | PASS |
| 18 | **Scenario 3: v1.0.2 Up to Date** | Client: 1.0.2, Remote: 1.0.2 | Up to date, no update loop | `available: false`, `up_to_date` | PASS |
| 19 | **Scenario 4: Downgrade Rejection** | Client: 1.0.2, Remote: 1.0.1 | Rejected by SemVer comparator | `available: false` | PASS |
| 20 | **Scenario 5: HTTP 404 Graceful Error**| Mock server 404 | Emits `ReleaseNotFound` | Handled gracefully | PASS |
| 21 | **Scenario 6: Malformed JSON Syntax** | Invalid JSON bytes | Emits deserialization error | Handled gracefully, no crash | PASS |
| 22 | **Scenario 7: Network Timeout** | Server unresponsive | Handled via timeout guard | Handled gracefully | PASS |
| 23 | **Active Download Guard (Active = 2)** | 2 active downloads | Block update installation | Blocked with warning | PASS |
| 24 | **Active Download Guard (Active = 0)** | 0 active downloads | Allow update installation | Installation permitted | PASS |
| 25 | **NSIS Data Preservation Audit** | `hooks.nsh` review | No user data deletion | User data preserved | PASS |
| 26 | **SQLite Database Safety** | `hooks.nsh` review | Preserves `tdm_storage.sqlite`| Explicit preservation comment | PASS |
| 27 | **Browser Host Registration** | `hooks.nsh` review | Re-registers `--register` | Native messaging preserved | PASS |
| 28 | **Zero Repository Pollution** | Git status check | Working tree clean | Clean | PASS |
| 29 | **Private Key Isolation** | Security audit | Key stored outside repo | Stored in `~/.tori-keys/` | PASS |

---

## 6. Phase 5 — Safe Publication & Deployment Workflow

### 6.1 Prepared Artifact
A staging file `release/v1.0.2-final/latest.json` has been prepared with the verified manifest payload:
- **File:** `release/v1.0.2-final/latest.json`
- **Size:** 1,028 bytes
- **SHA-256:** `2929e7104b2b3b0dfb2f281e4624a480cb22495af44baae62a2faeb25ec1396b`

### 6.2 Target GitHub Release
- **Repository:** `robijoychakma375-hash/tori-download-manager`
- **Target Release ID:** `441473140`
- **Release Tag:** `v1.0.2`
- **State:** Published (`draft: false`, `prerelease: false`)
- **Asset to Add:** `latest.json`

### 6.3 Deployment Automation Script
A dedicated script `scripts/deploy_gate22_updater_manifest.js` has been drafted to perform the single asset upload upon operator authorization:
```bash
node scripts/deploy_gate22_updater_manifest.js --execute
```
The script:
1. Validates the local `latest.json` checksum and Ed25519 signature.
2. Connects to GitHub API using Git Credential Manager credentials.
3. Uploads `latest.json` to Release ID `441473140`.
4. Performs a live HTTP verification following the full redirect chain to confirm `200 OK`.

---

## 7. Explicit Stop & Awaiting Operator Approval

In accordance with strict Gate 22 guidelines:
- **No changes have been uploaded to GitHub.**
- **No existing release assets or tags have been modified.**
- **No production binaries or workstation applications have been altered.**
- **All testing was conducted in isolated scratch environments.**

**Gate 22 Diagnosis and Verification is COMPLETE.**  
Awaiting explicit operator authorization to proceed with Phase 5 deployment.

