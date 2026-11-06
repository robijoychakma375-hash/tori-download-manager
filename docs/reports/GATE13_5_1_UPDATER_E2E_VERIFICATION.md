# TORI Download Manager v1.0.0 — Gate 13.5.1 Engineering Report
## Signed Updater End-to-End Verification & Website Configuration

**Date:** 2026-11-06  
**Project:** `F:\TORI\final tori download manager`  
**Verified Baseline Checkpoint:** Commit `4c8e04c`  
**Target Platform:** Windows 10 & Windows 11 (x64)  
**Verification Status:** **100% VERIFIED** (67/67 Gate 13.5.1 E2E Tests, 5/5 Rust Cryptography Tests, 61/61 Gate 13.5 QA Tests, 146/146 Workspace Tests, 15/15 Release Guard Checks)

---

### Executive Summary

Gate 13.5.1 provides rigorous, end-to-end cryptographic and runtime verification of TORI Download Manager's signed auto-updater, application identity, website configuration, and operational security prior to public GitHub release.

All testing was executed in isolated local sandboxes without publishing to external remote servers or releasing Git tags.

#### Key Achievements:
1. **Website Configuration Update Verified:**
   - In accordance with project instructions, because the official TORI website has not yet been developed, no website URL is required or invented.
   - Set `OFFICIAL_WEBSITE_URL = null` in `ui/src/components/SettingsModal.tsx`, hiding the website link cleanly from the About tab until an official public website is ready and verified.
   - Configured verified GitHub project destinations as primary project endpoints:
     - Project Homepage: `https://github.com/tori-download-manager/tori-download-manager`
     - Releases & Downloads: `https://github.com/tori-download-manager/tori-download-manager/releases`
     - Issues & Feedback: `https://github.com/tori-download-manager/tori-download-manager/issues`
2. **Cryptographic Minisign Verification:**
   - Created `crates/tdm-core/tests/updater_cryptography_tests.rs`, integrating `minisign-verify` (0.3.0) and `base64`.
   - Verified that the public key configured in `src-tauri/tauri.conf.json` matches `%USERPROFILE%\.tori-keys\tori-updater.key.pub` identically.
   - Tested cryptographic signature verification against the production NSIS installer `TORI Download Manager_1.0.0_x64-setup.exe` and `.sig` envelope.
   - Empirically proved that flipping any single bit in the installer payload causes signature verification to fail immediately.
   - Empirically proved that corrupted signature strings fail immediately.
   - Verified that `target/release/latest.json` platform signature matches the standalone `.sig` file byte-for-byte.
3. **Operational Security & Key Safety:**
   - Confirmed that the private key `tori-updater.key` is stored strictly outside the Git repository at `%USERPROFILE%\.tori-keys\`.
   - Verified with `git ls-files` that zero `.key`, `.pwd`, `.pem`, or secrets are tracked in Git.
   - Added defense-in-depth rules to `.gitignore` (`*.key`, `*.pwd`, `*.pem`, `id_ed25519*`, `*.pfx`).
4. **Live Windows Update Sandbox Execution & Data Preservation:**
   - Performed silent NSIS installation into sandbox directory `target/sandbox_install_v100` via `/S /D=...`.
   - Verified the complete installed filesystem: main executable `tori-download-manager.exe`, bundled companion binaries (`bin/ffmpeg.exe`, `bin/ffprobe.exe`, `bin/yt-dlp.exe`, `bin/tdm-native-host.exe`, `bin/tdm-cli.exe`), and `LICENSE-THIRD-PARTY.txt`.
   - Audited Win32 PE version metadata: `FileVersion` = `1.0.0`, `ProductVersion` = `1.0.0`.
   - Seeded user SQLite state (`tdm_storage.sqlite`) and an in-progress `.tdm-part` transfer.
   - Executed simulated in-place silent update (`/UPDATE /S /D=...`).
   - Verified 100% data preservation: SQLite database was completely untouched, partial `.tdm-part` downloads were uncorrupted, and Chrome/Edge Native Messaging registry keys and host manifest survived intact.
   - Cleaned up sandbox files via silent uninstaller (`uninstall.exe /S _?=...`).
5. **In-App Safety Guards & Network Resilience:**
   - Active Download Collision Guard: Verified that `installUpdateSafe` blocks update installation and warns the user whenever active downloads exist (`activeCount > 0`).
   - Network Resilience: Tested HTTP 404, HTTP 500, and malformed JSON responses; updater handles errors gracefully without crashing or hanging the application.
   - Version Ordering: Verified SemVer anti-downgrade logic (same version and older versions reject updates, newer versions accept).

---

### Verification Matrix & Test Summary

| Test Category | Suite / Harness | Tests | Result | Status |
|---|---|---|---|---|
| **E2E Updater Audit** | `scripts/verify_gate13_5_1_updater_e2e.js` | 67 | 67 Passed, 0 Failed | **100% VERIFIED** |
| **Rust Cryptography Tests** | `crates/tdm-core/tests/updater_cryptography_tests.rs` | 5 | 5 Passed, 0 Failed | **100% VERIFIED** |
| **Release QA Suite** | `scripts/verify_gate13_5_qa.js` | 61 | 61 Passed, 0 Failed | **100% VERIFIED** |
| **Workspace Test Suite** | `cargo test --workspace` | 146 | 146 Passed, 0 Failed | **100% VERIFIED** |
| **Production Release Guard** | `scripts/verify_production_release.ps1` | 15 | 15 Passed, 0 Failed | **100% VERIFIED** |
| **Clippy & Code Style** | `cargo clippy` & `cargo fmt` | — | 0 Warnings, 0 Errors | **CLEAN** |

---

### Detailed Test Groups Breakdown (`verify_gate13_5_1_updater_e2e.js`)

#### Group 1: Release Identity & Ownership Audit (15/15 Passed)
- `[PASS]` Current Git branch is `master`
- `[PASS]` Current Git commit resolved: `4c8e04c`
- `[PASS]` `Cargo.toml` workspace package version is `1.0.0`
- `[PASS]` `src-tauri/tauri.conf.json` version is `1.0.0`
- `[PASS]` `tauri.conf.json` productName is `TORI Download Manager`
- `[PASS]` `tauri.conf.json` identifier is `com.tori.downloadmanager`
- `[PASS]` `ui/package.json` version is `1.0.0`
- `[PASS]` `extension/manifest.json` version is `1.0.0`
- `[PASS]` `SettingsModal` defines `OFFICIAL_WEBSITE_URL` as null (no invented or placeholder website)
- `[PASS]` `SettingsModal` conditionally renders website link only when `OFFICIAL_WEBSITE_URL` is truthy
- `[PASS]` `SettingsModal` references official GitHub repository homepage
- `[PASS]` `SettingsModal` references official GitHub Releases for downloads and notes
- `[PASS]` `SettingsModal` references official GitHub Issues for bug reports and feedback
- `[PASS]` `CHANGELOG.md` exists in repository root
- `[PASS]` `RELEASE_NOTES.md` exists in repository root

#### Group 2: Updater Artifacts & Cryptographic Verification Audit (16/16 Passed)
- `[PASS]` `tauri.conf.json` has `bundle.createUpdaterArtifacts` set to true
- `[PASS]` Release installer exists: `TORI Download Manager_1.0.0_x64-setup.exe`
- `[PASS]` Installer size (111.38 MB) exceeds 100 MB (bundled binaries included)
- `[PASS]` Detached signature file exists: `TORI Download Manager_1.0.0_x64-setup.exe.sig`
- `[PASS]` Signature file contains non-empty base64 signature envelope
- `[PASS]` Signature is a structured Minisign signature envelope, NOT a raw SHA-256 hash string
- `[PASS]` Signature includes trusted comment with timestamp
- `[PASS]` Signature trusted comment binds strictly to the exact installer filename
- `[PASS]` `target/release/latest.json` exists
- `[PASS]` `latest.json` version is `1.0.0`
- `[PASS]` `latest.json` defines `windows-x86_64` target platform
- `[PASS]` `latest.json` `windows-x86_64` signature matches `.sig` file byte-for-byte
- `[PASS]` `latest.json` download URL points to verified GitHub Releases asset
- `[PASS]` `target/release/SHA256SUMS.txt` exists
- `[PASS]` `SHA256SUMS.txt` records exact SHA-256 for NSIS installer (`011AFF7D60258F39A024F6EFE5EE27BB5B894471B2181472D0ED22C5883EC701`)
- `[PASS]` `SHA256SUMS.txt` records exact SHA-256 for main EXE (`7589D97E95674B3A1747C115286E710840FADD3444A836366136EBAD2E52E5EF`)

#### Group 3: Signing Key Safety & Operational Security (7/7 Passed)
- `[PASS]` Private key safely isolated outside repo at `%USERPROFILE%\.tori-keys\tori-updater.key`
- `[PASS]` Public key safely stored at `%USERPROFILE%\.tori-keys\tori-updater.key.pub`
- `[PASS]` Public key in `tauri.conf.json` matches `%USERPROFILE%\.tori-keys\tori-updater.key.pub` identically
- `[PASS]` Zero private key, password, or PEM files are tracked in Git (found: 0)
- `[PASS]` `.gitignore` blocks `*.key` files
- `[PASS]` `.gitignore` blocks `*.pwd` files
- `[PASS]` `.gitignore` blocks `*.pem` files

#### Group 4: Sandbox Installation & Upgrade Data Preservation (17/17 Passed)
- `[PASS]` Installed `tori-download-manager.exe` exists in sandbox
- `[PASS]` Bundled `ffmpeg.exe` installed into `bin/`
- `[PASS]` Bundled `ffprobe.exe` installed into `bin/`
- `[PASS]` Bundled `yt-dlp.exe` installed into `bin/`
- `[PASS]` Bundled `tdm-native-host.exe` installed into `bin/`
- `[PASS]` Bundled `tdm-cli.exe` installed into `bin/`
- `[PASS]` Third-party license notice installed into root
- `[PASS]` Installed binary `FileVersion` is `1.0.0`
- `[PASS]` Installed binary `ProductVersion` is `1.0.0`
- `[PASS]` SQLite storage database exists at `%APPDATA%\tori-download-manager\tdm_storage.sqlite`
- `[PASS]` Seeded mock `.tdm-part` partial download file
- `[PASS]` Mock `.tdm-part` file remains 100% intact after updater execution
- `[PASS]` `.tdm-part` content verified uncorrupted
- `[PASS]` SQLite database remains intact after update
- `[PASS]` SQLite database size preserved (532,480 bytes)
- `[PASS]` Browser Native Messaging manifest `com.tori.download_manager.json` preserved
- `[PASS]` Chrome Native Messaging registry key preserved
- `[PASS]` Sandbox installation cleaned up cleanly

#### Group 5: In-App Updater Safety & Failure Rejection (12/12 Passed)
- `[PASS]` `installUpdateSafe` correctly blocks update when 3 active downloads exist
- `[PASS]` Informative safety warning provided to user
- `[PASS]` `installUpdateSafe` allows update installation when 0 active downloads exist
- `[PASS]` HTTP 500 server response handled gracefully without crashing
- `[PASS]` HTTP 404 endpoint not found handled gracefully
- `[PASS]` Malformed JSON manifest handled gracefully
- `[PASS]` Same version (1.0.0 vs 1.0.0) -> `available: false` (no false update loops)
- `[PASS]` Older version (0.9.9 vs 1.0.0) -> `available: false` (downgrades rejected)
- `[PASS]` Newer patch version (1.0.1 vs 1.0.0) -> `available: true`
- `[PASS]` Newer minor version (1.1.0 vs 1.0.0) -> `available: true`
- `[PASS]` Newer major version (2.0.0 vs 1.0.0) -> `available: true`

---

### Rust Cryptographic Test Suite Results (`updater_cryptography_tests.rs`)

```text
running 5 tests
test test_corrupted_signature_strictly_rejected ... ok
test test_tampered_payload_strictly_rejected ... ok
test test_latest_json_matches_signature_file ... ok
test test_updater_public_key_decoding_and_format ... ok
test test_installer_signature_cryptographic_verification ... ok

test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 2.04s
```

---

### Key Operational Security & Disaster Recovery Procedures

> [!CAUTION]
> Never commit, print, log, or export the private signing key (`tori-updater.key`) or its encryption password (`tori-updater.key.pwd`).

1. **Storage Location:**  
   The updater private key is stored exclusively on the developer's secure local machine at:  
   `%USERPROFILE%\.tori-keys\tori-updater.key`  
   with its password in:  
   `%USERPROFILE%\.tori-keys\tori-updater.key.pwd`.
2. **Disaster Recovery & Key Backup:**  
   - The `.tori-keys` folder should be backed up onto an encrypted, air-gapped physical storage medium (e.g., an encrypted USB drive in a secure physical location).
   - If the private key is lost, new updates cannot be cryptographically signed with the existing public key, requiring users to manually reinstall a new version with a new embedded public key.
3. **Automated Release Signing:**  
   - Release signing is executed locally via `node scripts/generate_release_metadata.js`, which securely interfaces with `cargo tauri signer sign` without echoing passwords to stdout or logs.

---

### Gate 13.5.1 Conclusion

All milestones for Gate 13.5.1 are complete, and all instructions for the website configuration update have been fully met:
- **No official website is required** for the v1.0.0 release.
- The Website link in the About page is **hidden** until a verified public URL is configured.
- The **GitHub repository** is the primary project homepage.
- **GitHub Releases** is the source for official downloads and updater metadata.
- **GitHub Issues** is the feedback and bug reporting channel.
- The updater has been end-to-end verified across cryptographic, filesystem, runtime, and failure scenarios.
