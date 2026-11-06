# TORI Download Manager v2.0 — Final Installer Quality Assurance Report
## Gate 13.2.1: Release Quality Audit & Dependency Provenance Verification

**Date:** 2026-11-06  
**Project Root:** `F:\TORI\final tori download manager`  
**Baseline Checkpoint:** `e0364ba`  
**Execution Environment:** Windows 10/11 x64 (MSVC 14.44.35207, Windows SDK 10.0.26100.0)  
**Status:** **VERIFIED & PASSED** (All Release Blockers Resolved)

---

### Executive Summary

Gate 13.2.1 performed an exhaustive, forensic release-quality audit of the TORI Download Manager v2.0 self-contained NSIS installer. This gate verified packaged binary identity, resolved the exact distribution provenance and licensing obligations of bundled FFmpeg/FFprobe binaries, validated installed runtime execution under a completely scrubbed system environment (zero dev tools, zero PATH dependencies), proved bidirectional browser Native Messaging integration, and confirmed data preservation guarantees during uninstallation.

---

### 1. Packaged Binary Identity & Hash Discrepancy Resolution

#### A. Hash Discrepancy Forensic Investigation
In the initial Gate 13.2 deliverable report, the SHA-256 hash for `tori-download-manager.exe` was inadvertently transcribed from the prior Gate 13.1 release table (`D7399813...`). 

A rigorous byte-level forensic analysis between the newly compiled binary and the packaged NSIS payload revealed:
1. **The Rebuilt Standalone Binary:** Compiling `src-tauri` with version `2.0.0` produced `target/release/tori-download-manager.exe` (`28,078,080 bytes`, `FileVersion: 2.0.0`, `ProductVersion: 2.0.0`).
2. **The Tauri NSIS Bundle Patching Mechanism:** During `cargo tauri build --bundles nsis`, Tauri locates the release executable and performs an in-place patch replacing the bundle type placeholder:
   - Standalone placeholder: `BUNDLE_TYPE_VAR_UNK` (`0x15152a2`)
   - NSIS bundle marker: `BUNDLE_TYPE_VAR_NSS` (`0x15152a2`)
   - Exactly **3 bytes** are altered by Tauri's NSIS packager to inform the runtime of its packaging scheme.
3. **Confirmed Binary Hashes:**
   - Standalone Release EXE (prior to NSIS marker): `D394EC83CEBB5D2598384F4529CFE0B8C5E3381F4915A365F57DF5F931925881`
   - Packaged Installed EXE (`$INSTDIR\tori-download-manager.exe`): `AE0B7541CE47A9E56AE6548FBC4693971147A3323F852133502A5880F4B9F7C8`
   - Rebuilt NSIS Installer: `6E1D8B0A4ABBE2835DD6409CD18C28AC5AD4531301C831EB34E63CBBED880B8B` (`116,488,233 bytes`)

#### B. Embedded Assets & Native Protocol Verification
- Embedded React production assets (`ui/dist`) verified via custom-protocol `http://tauri.localhost/`.
- Verified zero dependency on `localhost:5173` (Vite dev server) or external web hosts.
- Authenticated localhost desktop server verified active on `127.0.0.1:6800`.

---

### 2. FFmpeg Provenance & Licensing Resolution

#### A. Source of Discrepancy
In the Gate 13.2 documentation, conflicting statements arose: the report table referenced a BtbN GPLv3 build, while narrative text referenced Gyan.dev.

#### B. Empirical Binary Inspection & Provenance
Direct execution and string extraction from `resources/bin/ffmpeg.exe`:
```
ffmpeg version N-126374-g089a48eb36-20260831 Copyright (c) 2000-2026 the FFmpeg developers
built with gcc 15.2.0 (crosstool-NG 1.28.0.23_185f348)
configuration: --prefix=/ffbuild/prefix --pkg-config-flags=--static --cross-prefix=x86_64-w64-mingw32- --arch=x86_64 --target-os=mingw32 --enable-gpl --enable-version3 ...
```
1. **Package Source:** Windows Package Manager package `yt-dlp.FFmpeg` (`yt-dlp.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe`), installed from `https://github.com/yt-dlp/FFmpeg-Builds/releases/download/autobuild-2026-08-31-.../ffmpeg-N-126374-g089a48eb36-win64-gpl.zip`.
2. **Upstream Lineage:** `yt-dlp/FFmpeg-Builds` is a specialized autobuild fork of **BtbN / FFmpeg-Builds** (`github.com/BtbN/FFmpeg-Builds`), built inside containerized Linux cross-compilation environments using `--prefix=/ffbuild/prefix`.
3. **Erronous Gyan.dev Reference:** Resolved. Gyan.dev was an erroneous assumption in early documentation; the bundled binary is definitively the yt-dlp / BtbN autobuild.

#### C. Redistribution Obligations & Legal Compliance
1. **License:** GNU General Public License v3 (GPLv3).
2. **Mere Aggregation:** TORI Download Manager interacts with `ffmpeg.exe` and `ffprobe.exe` exclusively as standalone subprocesses via OS process pipes (`std::process::Command` / `tokio::process::Command`), fulfilling the FSF "mere aggregation" doctrine. No C libraries (`libavcodec`, `libavformat`, etc.) are linked into TORI binaries.
3. **Corresponding Source Access:** `resources/LICENSE-THIRD-PARTY.txt` has been updated with exact source repository URLs:
   - Upstream FFmpeg: `https://ffmpeg.org/` (Git snapshot commit `089a48eb36`)
   - Build scripts and recipes: `https://github.com/yt-dlp/FFmpeg-Builds`
   - Base build definitions: `https://github.com/BtbN/FFmpeg-Builds`
4. **License Delivery:** Bundled directly with every installation at `$INSTDIR\LICENSE-THIRD-PARTY.txt`.

---

### 3. Actual Installed Runtime Dependency Verification

Verification was executed directly inside a temporary installation sandbox (`target/qa_install_test`) under a strictly **scrubbed system PATH** (`PATH = C:\Windows\system32;C:\Windows;C:\Windows\System32\Wbem`):

| Test Case | Method | Observed Result | Status |
|---|---|---|---|
| **yt-dlp Standalone Launch** | `bin\yt-dlp.exe --version` under scrubbed PATH | Exit 0; returned version `2026.08.19` | **PASS** |
| **FFmpeg Standalone Launch** | `bin\ffmpeg.exe -version` under scrubbed PATH | Exit 0; returned version `N-126374-g089a48eb36-20260831` | **PASS** |
| **FFprobe Standalone Launch** | `bin\ffprobe.exe -version` under scrubbed PATH | Exit 0; returned version `N-126374-g089a48eb36-20260831` | **PASS** |
| **tdm-cli Standalone Launch** | `bin\tdm-cli.exe --help` under scrubbed PATH | Exit 0; returned `TORI Download Manager CLI v2.0.0` | **PASS** |
| **Synthetic Video Encoding & Remux** | Generated 1s colorbars + audio via `bin\ffmpeg.exe` | Produced valid MP4 container (`14,681 bytes`) | **PASS** |
| **FFprobe Streams Validation** | Probed synthetic MP4 via `bin\ffprobe.exe` | Verified streams: `video=h264`, `audio=aac` | **PASS** |
| **Public HTTP MP4 Download** | Downloaded MDN `flower.mp4` via `bin\tdm-cli.exe` | Downloaded 100%; verified `960x540` H.264 + AAC | **PASS** |
| **Runtime Engine Dependency Discovery** | Queried `/api/v1/media/status` on running engine | Discovered all 3 binaries in `$INSTDIR\bin\` with 0ms overhead | **PASS** |

Zero developer tools (Rust `cargo`/`rustc`, Node.js `node`/`npm`, Python, WinGet) were accessible during these tests.

---

### 4. Browser Integration & Native Messaging Verification

1. **Manifest File Generation:**
   - On installation, `$INSTDIR\bin\tdm-native-host.exe --register` writes `%APPDATA%\tori-download-manager\com.tori.download_manager.json`.
   - Manifest `path` dynamically points to `$INSTDIR\bin\tdm-native-host.exe`. Zero development paths (`C:` or `F:`) persist in the installed manifest.
2. **Registry Configuration:**
   - Chrome: `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.tori.download_manager` -> `%APPDATA%\...\com.tori.download_manager.json`
   - Edge: `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.tori.download_manager` -> `%APPDATA%\...\com.tori.download_manager.json`
3. **IPC Handshake Verification:**
   - Sent 4-byte length-prefixed `{"action":"ping"}` to `$INSTDIR\bin\tdm-native-host.exe` via stdin.
   - Received length-prefixed response: `{"status":"ok","action":"pong","version":"2.0.0",...}` via stdout.
4. **Persistent Desktop Engine Auto-Spawn:**
   - Verified that when `tdm-native-host.exe` receives browser requests while the desktop app is closed, it climbs parent directories and automatically launches `$INSTDIR\tori-download-manager.exe`.
5. **Port 6800 Pairing Authentication:**
   - Authenticated endpoints (`/api/v1/downloads`, `/api/v1/media/resolve`, etc.) reject requests lacking valid `x-tori-token` or Bearer header with HTTP 401 Unauthorized.
   - Unauthenticated health endpoints (`/api/v1/ping`, `/api/v1/status`) allow the browser extension to verify server status.

---

### 5. Safe Uninstallation & Data Preservation Verification

Executed silent uninstallation via `$INSTDIR\uninstall.exe /S`:

1. **Clean Application Removal:**
   - Installed binaries (`tori-download-manager.exe`, `bin\*.exe`) and third-party notices removed.
2. **Registry Cleanup:**
   - `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.tori.download_manager` deleted.
   - `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.tori.download_manager` deleted.
   - **Isolation Guarantee:** Unrelated Native Messaging keys (e.g. 1Password, Adobe) remain completely untouched.
3. **Host Manifest Removal:**
   - `%APPDATA%\tori-download-manager\com.tori.download_manager.json` deleted.
4. **User Data Strictly Preserved:**
   - `%APPDATA%\tori-download-manager\tdm_storage.sqlite` **PRESERVED** (all download history intact).
   - `%APPDATA%\tori-download-manager\thumbnails\` **PRESERVED** (all cached media thumbnails intact).
   - User download directories (`%USERPROFILE%\Downloads\...`) **PRESERVED**.

---

### 6. Clean Windows VM Manual Verification Checklist

For independent verification on an isolated Windows 10/11 x64 virtual machine:

- [ ] **Prerequisites:** Pristine Windows 10/11 x64 VM without Visual Studio, Rust, Node.js, Python, or Git. Ensure Windows Evergreen WebView2 Runtime is installed (default on modern Win 10/11).
- [ ] **Step 1 — Installation:**
  1. Transfer `TORI Download Manager_2.0.0_x64-setup.exe` to the VM.
  2. Run installer. Verify official Torii-gate icon, publisher notice, and install destination.
  3. Verify Start Menu and optional Desktop shortcuts are created with correct icons.
- [ ] **Step 2 — Launch & Startup:**
  1. Launch TORI from Start Menu.
  2. Confirm main window loads immediately without connection errors or missing UI assets.
  3. Confirm dark/light theme toggle, toolbar buttons, and settings dialog open properly.
- [ ] **Step 3 — Dependency Check:**
  1. Open TORI Settings -> Diagnostics / Media Engine.
  2. Confirm FFmpeg, FFprobe, and yt-dlp are all reported as "Available" with green status indicators pointing to `C:\Program Files\TORI Download Manager\bin\...`.
- [ ] **Step 4 — Direct HTTP Download:**
  1. Paste `https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4` into Add URL.
  2. Click Download. Verify progress toast, transfer speed, and completion notification.
  3. Click "Open Folder" and verify the downloaded file plays in Windows Media Player / Movies & TV.
- [ ] **Step 5 — Browser Integration:**
  1. Open Microsoft Edge / Google Chrome.
  2. Load unpacked extension from the extension package.
  3. Verify extension popup indicates "Connected to TORI Desktop".
  4. Browse to a video page and click "Download with TORI" on the video overlay.
- [ ] **Step 6 — Uninstallation:**
  1. Go to Windows Settings -> Apps -> Installed Apps -> TORI Download Manager -> Uninstall.
  2. Confirm application files are removed from Program Files.
  3. Confirm previously downloaded files and `%APPDATA%\tori-download-manager\tdm_storage.sqlite` are preserved.

---

### 7. Verification Summary Matrix

| Verification Suite | Target | Result |
|---|---|---|
| **Gate 13.2.1 Installer QA Suite** | `scripts/verify_gate13_2_1_qa.js` | **15/15 Passed** (100%) |
| **Workspace Unit & Integration Tests** | `cargo test --workspace` | **139/139 Passed** (100%) |
| **Production Release Guard** | `scripts/verify_production_release.ps1` | **15/15 Passed** (100%) |
| **Browser E2E Integration Test** | `scripts/verify_gate12_9_2_browser_e2e.js` | **15/15 Passed** (100%) |
| **Rust Formatting Check** | `cargo fmt --all -- --check` | **0 Errors** (Clean) |
| **Rust Clippy Warnings Check** | `cargo clippy --workspace --all-targets -- -D warnings` | **0 Warnings** (Clean) |

---

### 8. Release Artifact Hashes

| Artifact | Size | SHA-256 Checksum |
|---|---|---|
| `TORI Download Manager_2.0.0_x64-setup.exe` | 116,488,233 bytes | `6E1D8B0A4ABBE2835DD6409CD18C28AC5AD4531301C831EB34E63CBBED880B8B` |
| `tori-download-manager.exe` (Standalone) | 28,078,080 bytes | `D394EC83CEBB5D2598384F4529CFE0B8C5E3381F4915A365F57DF5F931925881` |
| `tori-download-manager.exe` (Installed) | 28,078,080 bytes | `AE0B7541CE47A9E56AE6548FBC4693971147A3323F852133502A5880F4B9F7C8` |
| `tdm-native-host.exe` | 16,557,568 bytes | `834C3985A80CC01D1858D50E29AEBB8E87114B65FA57DDA11C7EBD26D83E06B9` |
| `tdm-cli.exe` | 16,132,096 bytes | `C0D167DFD7835E3AA844451BDC83E52154AAAE16BCFDA2439D97DB654073DDB6` |
| `ffmpeg.exe` | 145,858,048 bytes | `B9989F24E63BE74E72AA45FEC10A114CE660B562E4303D5F296F4FC8BA7CC896` |
| `ffprobe.exe` | 145,645,568 bytes | `73842BEE6F270E85B2AB6FC3CFA715F614F16AD16700F5DE6A9C1A2865CACF00` |
| `yt-dlp.exe` | 17,840,399 bytes | `66674953FE251B89F4D08C5F0E35E0728679BD67AB3D7D05C0562AF101DD3E7A` |
| `LICENSE-THIRD-PARTY.txt` | 2,893 bytes | `7F6E7CF09062A562D50EC8FD4F23D9A162B512F4DA351147983637FA64C723FB` |

---

### Conclusion & Readiness

Gate 13.2.1 has addressed and resolved all questions concerning executable identity, packaging mechanisms, FFmpeg distribution source and license obligations, installed runtime viability under clean system paths, and safe browser Native Messaging registration/unregistration. The installer bundle is verified and ready for release staging.
