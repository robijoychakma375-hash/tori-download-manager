# TORI Download Manager v1.0.0 — Gate 13.5 Release Preparation Report
## About Page, Dynamic Versioning, GitHub Release Metadata & Signed Auto-Updater

**Date:** 2026-11-06  
**Project:** `F:\TORI\final tori download manager`  
**Baseline Checkpoint:** Commit `db1da21`  
**Target Platform:** Windows 10 & Windows 11 (x64)  
**Verification Status:** **100% VERIFIED** (58/58 Gate 13.5 QA Tests, 141/141 Rust Tests, 15/15 Release Guard Checks, Clean Clippy & Fmt)

---

### Executive Summary

Gate 13.5 prepares TORI Download Manager for its first public GitHub v1.0.0 production release. Prior to this gate, TORI development builds reported experimental version 2.0.0, the About tab rendered hardcoded static strings without dynamic backend linkage, and the application lacked an automated, cryptographically signed update delivery mechanism.

This milestone accomplished five core objectives:
1. **Application Identity & Version Alignment:** Reconciled versions across all project tiers (`Cargo.toml`, `src-tauri/tauri.conf.json`, `ui/package.json`, `extension/manifest.json`) from `2.0.0` to `1.0.0`. Confirmed that no public v2.0.0 releases exist, ensuring forward update monotonicity. Preserved the stable bundle identifier `com.tori.downloadmanager`, data directory `%APPDATA%\tori-download-manager`, and SQLite WAL database.
2. **About Page Dynamic Integration:** Replaced static version text with dynamic IPC retrieval (`get_app_version`). Added developer attribution ("TORI Download Manager Team"), verified GitHub hyperlinks (`open_external_url`), integrated an embedded Third-Party Licenses modal viewer, and a Release Notes modal viewer.
3. **Official Tauri v2 Signed Auto-Updater:** Integrated `tauri-plugin-updater = "2"`, generated an Ed25519 Minisign keypair securely stored outside the repository (`%USERPROFILE%\.tori-keys\tori-updater.key`), configured `bundle.createUpdaterArtifacts = true`, embedded the Minisign public key into `tauri.conf.json`, and strictly prevented private key exposure in Git or build logs.
4. **In-App Update Safety & Download Collision Guard:** Built a user-controlled update workflow supporting manual checking and daily background checks. Enforced an active download collision safety guard via `getActiveDownloadsCount`; update installation and application restart are strictly blocked whenever active downloads are in progress.
5. **Release Metadata & Documentation Automation:** Authored `CHANGELOG.md` and `RELEASE_NOTES.md` for v1.0.0. Created `scripts/generate_release_metadata.js` to sign the NSIS installer with Minisign, assemble `target/release/latest.json`, package the browser extension into `tori-download-manager-extension-v1.0.0.zip`, and compute cryptographic SHA-256 hashes in `target/release/SHA256SUMS.txt`.

> [!IMPORTANT]
> In accordance with Gate 13.5 requirements, no public releases or Git tags have been pushed to external remote servers. All signed artifacts and manifests are prepared and staged locally for authorized deployment.

---

### Phase 1: Project Identity & Version Reconcile

#### Git History & Version Audit
- Audited repository status: `git remote` confirmed empty (no stale or broken remote repository).
- Verified Git tags: only internal development checkpoints (`checkpoint-gate13-start`).
- Confirmed zero public distribution of `2.0.0`. Downgrading the package descriptor to `1.0.0` ensures the first public release is clean, semantic, and adheres to standard SemVer.

#### Synchronized Manifests (All set to `1.0.0`)
- `Cargo.toml`: `[workspace.package] version = "1.0.0"`
- `src-tauri/tauri.conf.json`: `"version": "1.0.0"`
- `ui/package.json`: `"version": "1.0.0"`
- `extension/manifest.json`: `"version": "1.0.0"`

#### Preserved Identifiers & User Storage
- Package Product Name: `TORI Download Manager`
- Bundle Identifier: `com.tori.downloadmanager`
- AppData Directory: `%APPDATA%\tori-download-manager`
- SQLite WAL Database: `tdm_storage.sqlite`
- User Downloads & Partials: `%USERPROFILE%\Downloads`, `.tdm-part`

---

### Phase 2: About Page Enhancement & Dynamic Metadata

#### Dynamic Rust Commands (`src-tauri/src/commands.rs` & `lib.rs`)
- `get_app_version()`: Returns dynamic version string from Cargo package metadata (`"1.0.0"`).
- `get_active_downloads_count()`: Queries `DownloadManager::active_downloads_count()` to report active downloading jobs.
- `open_external_url(url: String)`: Validates `http://` or `https://` prefix, then launches URL via silent `rundll32 url.dll,FileProtocolHandler` with `CREATE_NO_WINDOW` (`0x08000000`).
- `get_third_party_licenses()`: Reads bundled `resources/LICENSE-THIRD-PARTY.txt` (with static fallback via `include_str!`) returning third-party license notices.

#### User Interface Updates (`ui/src/components/SettingsModal.tsx`)
- Dynamic version label: `Version {appVersion} (Production Release)`.
- Verified Developer attribution: `TORI Download Manager Team`.
- Verified Hyperlinks: Repository link (`https://github.com/tori-download-manager/tori-download-manager`) and Issues tracker.
- Modal Viewers:
  - Third-Party Licenses modal: Scrollable viewer displaying FFmpeg (GPLv3), yt-dlp (Unlicense), and Rust component licenses.
  - Release Notes modal: Full markdown viewer displaying release notes for v1.0.0.
- Daily Auto-Check Toggle: User preference `autoCheckUpdates` persisted in SQLite `app_settings`.
- Strict fidelity to `design/tori-final/` design tokens, geometries, and accent color themes (Indigo, Ocean, Emerald, Rose).

---

### Phase 3: Official Tauri v2 Signed Auto-Updater

#### Plugin Integration
- Added `tauri-plugin-updater = "2"` to `src-tauri/Cargo.toml`.
- Added `@tauri-apps/plugin-updater = "^2.14.1"` to `ui/package.json`.
- Registered plugin in `src-tauri/src/lib.rs`: `.plugin(tauri_plugin_updater::Builder::new().build())`.
- Granted updater capabilities in `src-tauri/capabilities/default.json`:
  - `"updater:default"`
  - `"core:app:allow-version"`

#### Cryptographic Keypair Generation & Out-of-Repo Storage
- Private and public keys were generated using `cargo tauri signer generate`.
- Key storage location: Strictly outside the repository at `%USERPROFILE%\.tori-keys\`:
  - Private key: `C:\Users\ritud\.tori-keys\tori-updater.key` (permission-restricted).
  - Public key: `C:\Users\ritud\.tori-keys\tori-updater.key.pub`.
  - Passphrase file: `C:\Users\ritud\.tori-keys\tori-updater.key.pwd`.
- Public key embedded into `src-tauri/tauri.conf.json`:
  ```json
  "plugins": {
    "updater": {
      "pubkey": "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IENEQzIzRDhDQzhEQTUzOTcKUldTWFU5cklqRDNDelRBOVAzOSs1L0RXN0FFLy9YWGFJc2NnUStaNktxSkNOQ1ZCeG01MjFTZzQK",
      "endpoints": [
        "https://github.com/tori-download-manager/tori-download-manager/releases/latest/download/latest.json"
      ]
    }
  }
  ```
- Confirmed zero private keys are tracked or visible in Git (`git status --porcelain` contains no `.key` files).

---

### Phase 4: In-App Update Experience & Download Collision Safety

#### Update Management Service (`ui/src/updater.ts`)
- `check()`: Contacts updater endpoint, parses release version and notes.
- `downloadUpdate(onProgress)`: Streams update payload with chunk progress tracking (`downloaded / totalBytes`).
- `installUpdateSafe()`:
  - Invokes `get_active_downloads_count()`.
  - If active downloads > 0, throws an explicit exception: `"Cannot install update while active downloads are in progress. Please pause or wait for downloads to complete."`
  - Sets update state to `blocked_active_downloads`.
  - If active downloads == 0, executes `update.install()`.

#### Foreground & Background Integration
- **Settings Modal (About tab):**
  - Interactive "Check for Updates" button with rich status badges: `Idle`, `Checking...`, `Up to date (v1.0.0)`, `Update available (v1.0.1)`, `Downloading update (45%)`, `Ready to install`, `Update blocked (Active downloads)`, `Error`.
  - Actions for available updates: "Download & Install", "Remind Me Later" (suppresses prompts for 24h), and "View on GitHub".
- **Application Banner (`ui/src/App.tsx`):**
  - Background 24-hour update check on application startup respecting user toggle.
  - Floating banner notification in top-right when update is available, opening the About tab on click.
  - Graceful fallback: If GitHub endpoint is unreachable (e.g., offline or pre-release), updater logs a diagnostic warning and continues application operation without interrupting the user.

---

### Phase 5: Release Documentation & Metadata Automation

#### Release Notes & Documentation
- `CHANGELOG.md`: Detailed chronicle of features, architecture milestones, and security capabilities for v1.0.0.
- `RELEASE_NOTES.md`: Markdown summary for GitHub release body and in-app update changelog viewer.

#### Release Metadata Generator (`scripts/generate_release_metadata.js`)
Automates the generation of release artifacts:
1. Discovers `TORI Download Manager_1.0.0_x64-setup.exe` in `target/release/bundle/nsis/`.
2. Signs the installer with Minisign using the isolated private key.
3. Packages the Chrome/Edge extension into `tori-download-manager-extension-v1.0.0.zip`.
4. Outputs Tauri v2 `target/release/latest.json`:
   ```json
   {
     "version": "1.0.0",
     "notes": "...",
     "pub_date": "2026-11-06T15:51:33.381Z",
     "platforms": {
       "windows-x86_64": {
         "signature": "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkK...",
         "url": "https://github.com/tori-download-manager/tori-download-manager/releases/download/v1.0.0/TORI%20Download%20Manager_1.0.0_x64-setup.exe"
       }
     }
   }
   ```
5. Computes SHA-256 checksums of all release deliverables into `target/release/SHA256SUMS.txt`.
6. Enforces strict cryptographic discrimination: asserts that Minisign signatures (multi-line Base64) are never confused with 64-character hexadecimal SHA-256 checksums.

---

### Release Deliverables & Cryptographic Inventory

| Deliverable Artifact | File Size | Cryptographic SHA-256 Checksum | Signature Type |
|---|---|---|---|
| `TORI Download Manager_1.0.0_x64-setup.exe` | 116,792,223 bytes (111.38 MB) | `011AFF7D60258F39A024F6EFE5EE27BB5B894471B2181472D0ED22C5883EC701` | Minisign Ed25519 (`.sig`) |
| `tori-download-manager.exe` (Standalone) | 29,296,128 bytes (27.94 MB) | `61491F79156BCDFA9E25FE78F21360A94988ACB6E97B80109D04F837D8F6659C` | PE32+ MSVC x64 |
| `tdm-native-host.exe` (Companion) | 16,557,568 bytes (15.79 MB) | `A77FB8F3E679A756F925B15A113184A06D0FEF34A38BD2223B47332A95042583` | PE32+ MSVC x64 |
| `tdm-cli.exe` (Companion) | 16,445,440 bytes (15.68 MB) | `2B82CEFE1418854D99039EE67DE0AC7F13B04FFD9A329F3FAFB79DA5D2049141` | PE32+ MSVC x64 |
| `tori-download-manager-extension-v1.0.0.zip` | 27,624 bytes (26.98 KB) | `6D5BD9D11B54F2D8C61C3D15302E71DA338B528026612AAE26AE2C98A671175C` | ZIP Archive (MV3) |
| `latest.json` (Updater Manifest) | 2,752 bytes (2.69 KB) | `5D367AD717127EFE6B4B3BE06FE21BDD1226176CE553DDA97E2596AC8863A1D7` | JSON UTF-8 |
| `SHA256SUMS.txt` | 557 bytes | (Records all hashes above) | Plain Text UTF-8 |

---

### Verification & Quality Assurance Summary

| Verification Suite | Target | Executed Command | Results |
|---|---|---|---|
| **Gate 13.5 QA Suite** | Release metadata, version alignment, updater keys, download safety guard | `node scripts/verify_gate13_5_qa.js` | **58/58 PASSED (100%)** |
| **Rust Code Formatting** | All workspace crates | `cargo fmt --all -- --check` | **0 diffs (100% clean)** |
| **Rust Compiler Warnings** | All workspace targets | `cargo clippy --workspace --all-targets -- -D warnings` | **0 warnings (100% clean)** |
| **Rust Unit & Integration Tests** | Engine, HLS, DASH, Torrent, Live, Resolvers, Native Host, Server | `cargo test --workspace` | **141/141 PASSED (0 failed)** |
| **Production Release Guard** | Standalone launch, embedded custom protocol, SQLite history, CDP audit | `powershell -ExecutionPolicy Bypass -File scripts\verify_production_release.ps1` | **15/15 PASSED (100%)** |
| **Metadata Generation** | Signing, extension packaging, SHA-256 calculation | `node scripts/generate_release_metadata.js` | **SUCCESS** |

---

### Conclusion & Readiness

Gate 13.5 is fully complete and verified. The application version has been cleanly unified to `1.0.0`, the About tab provides dynamic metadata and license notices, the official Tauri v2 signed auto-updater is configured with out-of-repo keys and active download collision guards, and all release metadata (`latest.json`, `SHA256SUMS.txt`, extension ZIP, NSIS setup EXE) have been generated and validated.
