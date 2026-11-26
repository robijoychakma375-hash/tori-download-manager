# TORI Download Manager v1.0.9 — Security & Reliability Update

**Version:** `1.0.9` (`Public Stable — Stage 1`)  
**Platform:** Windows 10 / 11 (64-bit `x86_64` NSIS Installer)  
**Compatible Browser Companion:** TORI Browser Companion `v1.0.11` (`extension-v1.0.11`, Security Hotfix)  
**Production External Tools Compatibility:** Stage 1 Dual-Key Trust (`CDC23D8CC8DA5397` legacy production key + `C3FD6626A3718E63` dedicated active public key) — 100% compatible with live External Tools Manifest Revision 2 (`Stage 2 dedicated-only cutover remains disabled`)

---

## Highlights & Fixes in v1.0.9

### 1. Download Engine HTTP `Content-Range` Reliability & Data-Corruption Prevention
- **Strict `Range: bytes=0-0` Probe Validation:** Prevents servers and CDNs that ignore `Range: bytes=0-0` and return `206` with full-file bounds from being misclassified as multi-chunk resumable; enforces strict `start <= end < total` bounds checking.
- **Strict `206 Content-Range`, `ETag` & `Last-Modified` Validation:** Rejects missing or malformed `Content-Range` headers (`InvalidRangeHeader`), mismatched range start offsets, and mid-download upstream validator changes (`ETagMismatch`) before writing a single byte, preventing silent file corruption.
- **Safe Bounded Single-Stream Fallback:** When a broken CDN responds with `MismatchedContentRange` (such as `206 bytes 0-(N-1)/N`), `InvalidRangeHeader`, `200 OK` Range fallback, `ETagMismatch`, or `HTTP 416`, TORI cleanly drains active chunk workers, performs a bounded single-stream full-body fallback with target-only `.tdm-part` truncation and SQLite chunk-bound update, verifies completion integrity, and preserves all unrelated `.tdm-part` files untouched.

### 2. Windows Startup Popup Elimination & Native Messaging Spawn Hardening
- **Cross-Process Native-Host Spawn Mutex:** Adds a pipe-scoped Windows named mutex (`Local\TORI_DM_EngineSpawn_<fnv1a64>`) with double-checked IPC connect around `ensure_engine_running()`, eliminating concurrent Desktop spawn stampedes during OS or browser startup.
- **Silent `--minimized` Tray Startup:** `--minimized` launches keep the main window hidden in the system tray rather than flashing onto the taskbar.
- **No Unsolicited Failed-Download Popups:** Suppresses automatic progress-popup openings for already-`Failed` or `Cancelled` downloads while preserving explicit user clicks, active download progress popups, and Close-to-Tray preferences.

### 3. Security Hardening & Ecosystem Compatibility
- **Gate 35.1 Security Hardening:** Retains URL/format CLI injection guards, SSRF redirect protections, bidirectional filename sanitization, and hardened External Tools rollback/state persistence.
- **Browser Companion `v1.0.11` Compatibility:** Preserves full localhost HTTP API and Native Messaging compatibility with Mozilla-signed Firefox and Chromium/Edge Browser Companion `v1.0.11` (`SEC-35-04`) without requiring extension reinstallation or re-pairing.
- **External Tools Manifest Revision 2 Continuity:** Maintains Stage 1 dual-key trust (`CDC23D8CC8DA5397` + `C3FD6626A3718E63`) with bundled `FFmpeg`, `FFprobe`, and `yt-dlp` fallback.

---

## Verification Checksums (SHA-256)

| Artifact | Size (Bytes) | SHA-256 |
| :--- | ---: | :--- |
| `TORI.Download.Manager_1.0.9_x64-setup.exe` | `118,170,722` | `460f5da00d09267a5f33274645250d92162bbfa3605f0348cc656a39a8a19ead` |
| `TORI.Download.Manager_1.0.9_x64-setup.exe.sig` | `436` | `9fd6f9e8a46e93dd1e1f6212b9d174aba3cc23761c55704f2a407965cb385aa0` |
| `tori-download-manager.exe` | `32,290,304` | `94995ea2eae40ec9101dd9f5f08f64ff717662143e8db936aae650f7daf17442` |
| `tdm-native-host.exe` | `19,449,344` | `90cbb76fe03c42b03736df78262b3486068f410d604c664d5e22fd4c7247479f` |
| `tdm-cli.exe` | `17,102,848` | `f25c29376e27d3a1025bbc39d09bae273c21d1fa6da4b62f44e0eea93a6ac368` |

In-app updates are cryptographically verified via Tauri Ed25519 signature (`CDC23D8CC8DA5397`).

---

## Upgrade & Preservation Notes (`v1.0.8` → `v1.0.9`)

- Additive SQLite schema preserves existing download history, `download_chunks`, `engine_settings`, themes, Close-to-Tray settings, incomplete `.tdm-part` files, and External Tools state.
- Full compatibility with Browser Companion `v1.0.11` across Firefox, Chrome, and Edge.

---

## Known Limitations (Disclosed for Stage 1 Public Stable)

- **Windows Authenticode Code Signing:** The Windows installer and standalone binaries are currently **not Authenticode-signed** (`NotSigned`). Windows SmartScreen may prompt **"More info" → "Run anyway"** on fresh manual downloads; in-app updates independently verify Tauri Ed25519 signatures (`CDC23D8CC8DA5397`).
- **Clean Windows 10 / 11 OS Testing:** Clean virgin Windows 10/11 VM installation QA has not been executed for this release (`CLEAN_WINDOWS_QA_NOT_TESTED`); verification was performed via isolated upgrade sandboxes, automated Rust/Node regression suites, and live browser compatibility suites.
- **Dedicated External Tools Key Stage 1 Status:** Dedicated External Tools public key `C3FD6626A3718E63` is embedded for Stage 1 dual-key readiness while production tools manifest revision 2 continues signing with `CDC23D8CC8DA5397`; Stage 2 dedicated-only cutover remains disabled pending offline backup recovery verification.
