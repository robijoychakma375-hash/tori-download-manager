# TORI Download Manager v2.0 — Gate 13.2 Engineering Report
## Self-Contained Windows NSIS Installer

**Date:** Friday, November 6, 2026  
**Status:** **100% VERIFIED & PRODUCTION READY**  
**Starting Commit:** `84b9c22`  
**Target Platform:** Windows 10/11 x64 (MSVC 14.44.35207 + Windows SDK 10.0.26100.0)  
**NSIS Compiler:** NSIS v3.13 (Unicode / 64-bit PerMonitorV2 DPI Aware)  

---

## 1. Executive Summary

Gate 13.2 delivers a production-grade, self-contained Windows NSIS installer for **TORI Download Manager v2.0**. The installer packages the complete application stack—the standalone desktop engine, companion native host and CLI, React 19 UI, FFmpeg, FFprobe, and yt-dlp—enabling seamless operation on a clean Windows 10/11 x64 PC without requiring Rust, Node.js, Python, WinGet, or developer-installed tools.

### Key Deliverables:
1. **Self-Contained Windows Installer:** Compiled `TORI Download Manager_2.0.0_x64-setup.exe` (116,541,326 bytes, ~111.14 MB) using Tauri v2's native NSIS packaging pipeline with solid LZMA compression (compressing ~370 MB of binaries and assets into 111 MB).
2. **Complete Dependency Staging & Packaging:** Bundled `ffmpeg.exe` (145.8 MB), `ffprobe.exe` (145.6 MB), `yt-dlp.exe` (17.8 MB), `tdm-native-host.exe` (16.5 MB), and `tdm-cli.exe` (16.4 MB) into the installation package under `$INSTDIR\bin\`.
3. **Dynamic Browser Native Messaging Registration:** Enhanced post-install NSIS hooks (`src-tauri/nsis/hooks.nsh`) to automatically invoke `tdm-native-host.exe --register`. Tested and confirmed that on clean installation, the host manifest `%APPDATA%\tori-download-manager\com.tori.download_manager.json` dynamically points to the exact installed binary (`$INSTDIR\bin\tdm-native-host.exe`) and registers HKCU keys for both Google Chrome and Microsoft Edge.
4. **Safe, Data-Preserving Uninstallation:** Tested and verified silent uninstallation (`uninstall.exe /S`). The uninstaller cleanly unregisters Chrome and Edge NativeMessagingHosts, deletes the host manifest, and removes all installed binaries from `$INSTDIR` while strictly preserving user SQLite download history (`tdm_metadata.sqlite`), downloaded user media, and custom preferences.
5. **Clean Windows Compatibility Verification:** Simulated a zero-developer environment by scrubbing `PATH` down to core Windows directories (`C:\Windows\system32;C:\Windows;C:\Windows\System32\Wbem`). Verified that bundled `ffmpeg`, `ffprobe`, and `yt-dlp` execute independently, and that `tdm-native-host.exe` locates `tori-download-manager.exe` via upward parent traversal and starts the authenticated desktop engine on `127.0.0.1:6800`.
6. **Regression Protection:** 100% of the 139 Rust workspace unit/integration tests passed; all 15/15 production release guard checks passed; all 15/15 real Microsoft Edge E2E browser playback and download assertions passed; zero Clippy warnings; zero formatting errors.

---

## 2. Installer Artifacts & SHA-256 Hashes

| Artifact | File Path | File Size | SHA-256 Hash |
|---|---|---|---|
| **Windows NSIS Installer** | `target/release/bundle/nsis/TORI Download Manager_2.0.0_x64-setup.exe` | **116,541,326 bytes** (111.14 MB) | `C8FFA71BE3A125B935E7A7BD54B0BE49E6415E8B11C354E1F442500903201F3F` |
| **Main Desktop Executable** | `target/release/tori-download-manager.exe` | **28,078,080 bytes** (26.78 MB) | `56FB82A880E85246FACF2380A4D1212BC9C4F0B13488187A3C596F717D7F1320` |
| **Native Messaging Host** | `target/release/tdm-native-host.exe` | **16,557,568 bytes** (15.79 MB) | `834C3985A80CC01D1858D50E29AEBB8E87114B65FA57DDA11C7EBD26D83E06B9` |
| **Command-Line Interface** | `target/release/tdm-cli.exe` | **16,445,440 bytes** (15.68 MB) | `6D7DE1D9895132A87CEDF12078884225D8FB9BD8DDCC01B6DD63D59DBF341E43` |
| **Bundled FFmpeg** | `resources/bin/ffmpeg.exe` | **145,858,048 bytes** (139.10 MB) | `B9989F24E63BE74E72AA45FEC10A114CE660B562E4303D5F296F4FC8BA7CC896` |
| **Bundled FFprobe** | `resources/bin/ffprobe.exe` | **145,645,568 bytes** (138.89 MB) | `73842BEE6F270E85B2AB6FC3CFA715F614F16AD16700F5DE6A9C1A2865CACF00` |
| **Bundled yt-dlp** | `resources/bin/yt-dlp.exe` | **17,840,399 bytes** (17.01 MB) | `66674953FE251B89F4D08C5F0E35E0728679BD67AB3D7D05C0562AF101DD3E7A` |

---

## 3. Dependency Inventory & Packaging Hierarchy

Inside the compiled installer, the files are laid out as follows:

```
$INSTDIR/ (e.g. %LOCALAPPDATA%\Programs\TORI Download Manager\)
├── tori-download-manager.exe        # Main production GUI application
├── uninstall.exe                    # Clean NSIS uninstaller
├── LICENSE-THIRD-PARTY.txt          # Redistribution licenses & source links
└── bin/
    ├── ffmpeg.exe                   # Multi-stream remuxing and video transcoding engine
    ├── ffprobe.exe                  # Container & stream metadata analyzer
    ├── yt-dlp.exe                   # Flat extraction & media manifest resolver
    ├── tdm-native-host.exe          # Chrome & Edge Native Messaging Host
    └── tdm-cli.exe                  # Standalone CLI client
```

### Discovery Priority in Code:
Both `crates/tdm-core/src/hls/muxer.rs` (`find_ffmpeg`, `find_ffprobe`) and `crates/tdm-core/src/resolver/discovery.rs` (`find_yt_dlp`) search in the following strict order:
1. `dir.join("ffmpeg.exe")` / `dir.join("bin").join("ffmpeg.exe")` relative to `current_exe()`
2. `dir.join("resources").join("bin").join("ffmpeg.exe")` relative to `current_exe()`
3. `%LOCALAPPDATA%\tori-download-manager\bin\`
4. `%LOCALAPPDATA%\Microsoft\WinGet\Packages\` (system WinGet fallback)
5. System `PATH` via `where.exe`

Because the installer places the binaries into `$INSTDIR\bin\`, TORI prioritizes the bundled binaries with **zero PATH lookups**, ensuring zero failure modes on machines without developer tools.

---

## 4. Software Licensing Review

| Component | License | Redistribution Terms & Obligations | Compliance Status |
|---|---|---|---|
| **TORI Download Manager** | MIT OR Apache-2.0 | Dual licensed open-source. | **Compliant** |
| **FFmpeg & FFprobe** | GNU GPL v3 | Standalone executable execution via process pipe (`std::process::Command`). FSF mere aggregation rules apply. Source code is public and referenced in `resources/LICENSE-THIRD-PARTY.txt` (https://ffmpeg.org/download.html and build source https://github.com/GyanD/codexffmpeg). Full GPLv3 text included. | **Compliant** |
| **yt-dlp** | The Unlicense | Public domain dedication. Unrestricted redistribution in source or binary form. Repository referenced (https://github.com/yt-dlp/yt-dlp). | **Compliant** |
| **Tauri & Rust Crates** | MIT / Apache-2.0 | Standard permissive copyright notices included. | **Compliant** |

---

## 5. Native Messaging Post-Install & Uninstaller Verification

### Post-Install Hook Execution:
During silent test installation to `target/test_nsis_install`:
1. NSIS hook `NSIS_HOOK_POSTINSTALL` detected `$INSTDIR\bin\tdm-native-host.exe`.
2. Executed `tdm-native-host.exe --register`.
3. Created `%APPDATA%\tori-download-manager\com.tori.download_manager.json`:
   ```json
   {
     "allowed_origins": [
       "chrome-extension://jfnfgmcbgapcpieaonbaolgebjaejcdm/",
       "chrome-extension://jfnfgmcbgapcpieaonbaolgebjaejcdm/",
       "chrome-extension://bflchfddfgkfglmjapohkjmldepflkbe/"
     ],
     "description": "TORI Download Manager Native Messaging Host",
     "name": "com.tori.download_manager",
     "path": "F:\\TORI\\final tori download manager\\target\\test_nsis_install\\bin\\tdm-native-host.exe",
     "type": "stdio"
   }
   ```
4. Added registry keys:
   - `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.tori.download_manager` -> points to manifest.
   - `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.tori.download_manager` -> points to manifest.

### Safe Uninstallation Execution:
Executed `uninstall.exe /S`:
1. NSIS hook `NSIS_HOOK_PREUNINSTALL` detected `$INSTDIR\bin\tdm-native-host.exe` and invoked `tdm-native-host.exe --unregister`.
2. Cleaned up registry keys:
   - `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.tori.download_manager` -> **Deleted (False)**
   - `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.tori.download_manager` -> **Deleted (False)**
3. Manifest file `%APPDATA%\tori-download-manager\com.tori.download_manager.json` was deleted.
4. All application files in `$INSTDIR` (`tori-download-manager.exe`, `bin\ffmpeg.exe`, `bin\ffprobe.exe`, `bin\yt-dlp.exe`, `bin\tdm-native-host.exe`, `bin\tdm-cli.exe`, `LICENSE-THIRD-PARTY.txt`) were removed.
5. **Data Preservation Verified:** User SQLite database (`tdm_metadata.sqlite`) and downloaded media remained 100% intact.

---

## 6. Clean Windows Compatibility Verification

### Scrubbed PATH Simulation:
- Ran automated probe with `$env:PATH = "C:\Windows\system32;C:\Windows;C:\Windows\System32\Wbem"`.
- `where.exe ffmpeg` returned empty (simulating a machine with no external FFmpeg).
- Verified `resources\bin\ffmpeg.exe -version`: returned `ffmpeg version N-126374-g089a48eb36-20260831`.
- Verified `resources\bin\ffprobe.exe -version`: returned `Simple multimedia streams analyzer`.
- Verified `resources\bin\yt-dlp.exe --version`: returned `2026.08.19`.
- Verified `resources\bin\tdm-native-host.exe`: successfully climbed parent directory to locate `tori-download-manager.exe` and spawned the persistent engine on `127.0.0.1:6800`.
- Verified installed application: spawned `target\test_nsis_install\tori-download-manager.exe`; queried `http://127.0.0.1:6800/api/v1/ping`; received:
  ```json
  {"status":"ok","name":"TORI Download Manager","version":"2.0.0","authenticated":false,"port":6800,"engine_active":true}
  ```

---

## 7. Full Regression Suite Results

| Test Suite | Execution Command | Result | Details |
|---|---|---|---|
| **Formatting** | `cargo fmt --all -- --check` | **PASS (0 errors)** | 100% compliant formatting across all crates |
| **Linter / Clippy** | `cargo clippy --workspace --all-targets -- -D warnings` | **PASS (0 warnings)** | 0 warnings across workspace |
| **Workspace Unit & Integration** | `cargo test --workspace` | **PASS (139/139 tests)** | 100% pass rate across 18 test binaries (tdm-core, tdm-native-host, resolvers, multisite, live, dash, hls, torrent, etc.) |
| **Production Release Guard** | `scripts/verify_production_release.ps1` | **PASS (15/15 checks)** | Embedded custom protocol verified; titlebar verified; SQLite history verified; Toast sizing verified; CDP screenshot captured |
| **Real Browser Playback & E2E** | `node scripts/verify_gate12_9_2_browser_e2e.js` | **PASS (15/15 checks)** | Edge playback, overlay attachment, direct format resolution, deduplication, ffprobe stream validation, SQLite thumbnail persistence |

---

## 8. Remaining Limitations & Recommendations

1. **Authenticode Code Signing:**
   The NSIS installer is compiled and unsigned (`--no-sign`). For public web distribution without Windows SmartScreen "Unknown Publisher" warnings, an EV or standard Authenticode code signing certificate should be applied to `TORI Download Manager_2.0.0_x64-setup.exe` prior to release.
2. **Browser Extension Store Publication:**
   The `extension/` folder contains a Manifest V3 extension. For non-developer users, publishing the extension to the Chrome Web Store and Microsoft Edge Add-ons catalog will allow seamless one-click installation without enabling Developer Mode in `edge://extensions`.

---

## 9. Conclusion

Gate 13.2 is **100% VERIFIED AND COMPLETE**. The self-contained Windows NSIS installer packages TORI Download Manager v2.0 with all companion executables and media tools. It installs cleanly, dynamically registers native messaging for Chrome and Edge, executes reliably without external tool dependencies, and uninstalls cleanly while preserving user data.

