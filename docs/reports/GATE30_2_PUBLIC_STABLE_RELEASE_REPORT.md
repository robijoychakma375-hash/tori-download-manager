# TORI Download Manager — Gate 30.2 Public Stable Release & Deployment Report

- **Date:** 2026-11-18
- **Final Release Status:** **`SUCCESS`**
- **Desktop Version:** `v1.0.5` (Windows x64 NSIS)
- **Browser Companion Version:** `v1.0.9` (Chrome `157.0.8103.79`, Edge `157.0.4341.60`, Firefox `160.0` Mozilla AMO-signed XPI)
- **Known Owner-Accepted Limitations:** Windows Authenticode PE signing is absent (`NotSigned`); independent clean Windows VM testing was not executed (`NOT TESTED`). Both remain explicitly documented below.

---

## 1. Release Summary & Status

**Status: `SUCCESS`**

Public release of **TORI Download Manager Desktop `v1.0.5`** and **TORI Browser Companion `v1.0.9`** has been completed across GitHub Releases, the Tauri v2 production auto-updater endpoint (`latest.json`), and the production website (`https://toridownload.xyz`) on Cloudflare Pages. All 16 approved GitHub release assets, updater redirects/SemVer rules, live post-release downloads & SHA-256 hashes, live same-origin Mozilla-signed Firefox `.xpi` delivery, live Chromium/Edge `v1.0.9` extension activation, desktop/mobile responsive website layouts, silent installer extraction parity, and user-data preservation checks passed verification.

---

## 2. Desktop Version & Git Commit

| Repository | Branch | Tag / Ref | Commit Hash |
|---|---|---|---|
| `robijoychakma375-hash/tori-download-manager` | `release/v1.0.5` (and `fix/gate27-runtime-fixes`) | `v1.0.5` / `checkpoint-gate30_1-preflight-verified` | `91f883afba2de73e8309ee4399e5a2ccddb58973` |
| Baseline Code Freeze Tag (Preserved) | `fix/gate27-runtime-fixes` | `checkpoint-gate29_5_2-verified` | `7e0f928e9ac1a99b7b6c350e5aaca73ddc6cc898` |
| `robijoychakma375-hash/tori-website-private` | `main` | `HEAD` | `939bc97808157a728292c975fc8c36e240016a17` |

- Zero application source files (`crates/`, `src-tauri/`, `ui/`, `extension/`) or approved frozen binaries (`release/v1.0.5-v1.0.9-final-rc/`) were altered or rebuilt during Gate 30.2.

---

## 3. Browser Companion Version

- **Version:** `v1.0.9` (Manifest V3)
- **Chrome / Edge Package:** `tori-companion-v1.0.9-chromium.zip` (`85,049` B, SHA-256 `dbc345b513795506c30c8300683d99fe1bd4b14d14c012663808bf7a406089ac`)
- **Firefox Signed XPI Package:** `a70ed17e183648a9bcf4-1.0.9.xpi` (hosted on GitHub `v1.0.5` and same-origin on `toridownload.xyz` as `/assets/tori-download-manager-firefox-v1.0.9.xpi`, `101,231` B, SHA-256 `d4e8d6e585ba6dfaf841eb6b37f2ee27beae1cec55badbbe0dd12960ad5943ec`, Gecko ID `tori-download-manager@toridm.org`)
- Unsigned Firefox development ZIP (`tori-companion-v1.0.9-firefox.zip`) was **not** published as an end-user installer.

---

## 4. GitHub Release URL & Release ID

| Field | Value |
|---|---|
| Release Name | `TORI Download Manager v1.0.5` |
| Release ID | `449053824` |
| Tag | `v1.0.5` -> `91f883afba2de73e8309ee4399e5a2ccddb58973` |
| Public URL | `https://github.com/robijoychakma375-hash/tori-download-manager/releases/tag/v1.0.5` |
| Latest Stable (`releases/latest`) | `true` (`v1.0.5`) |
| `draft` / `prerelease` | `false` / `false` |
| Published At (UTC) | `2026-11-17T20:01:40Z` |
| Historical Releases Preserved | `v1.0.4` (`443394435`), `v1.0.3`, `v1.0.2`, `v1.0.1`, `v1.0.0`, `extension-v1.0.5`, `extension-v1.0.4` |

---

## 5. Published Asset Names, IDs & SHA-256 Hashes

All 16 published assets on Release `449053824`:

| Asset Name | Asset ID | Size (Bytes) | Verified SHA-256 |
|---|---|---:|---|
| `TORI.Download.Manager_1.0.5_x64-setup.exe` | `760409097` | `117,783,770` | `cab4156fc85a42ce74d5d4292e2976223ba14ad4c8e7d5bbfea533e4ca72f3cb` |
| `TORI.Download.Manager_1.0.5_x64-setup.exe.sig` | `760254285` | `436` | `d43c0a98b5965cb8415be5062ced9abdbf10da58bf556751f0ff6eb92410e959` |
| `tori-download-manager.exe` | `760332264` | `30,723,072` | `629ebc63afe94a1240a4bc79802502c188bfbf6b8d0f24e0005e350f4a5f0f4a` |
| `tdm-native-host.exe` | `760307283` | `19,385,856` | `0c660aaacb1f2adfc43d2d29188f13317e2cac81bae117644cbfd9743a500d71` |
| `tdm-cli.exe` | `760302320` | `17,055,232` | `66673df965830fbded2d5e6e456a104ad7725fddfdbe62fec513a699e55e52e1` |
| `tori-companion-v1.0.9-chromium.zip` | `760256743` | `85,049` | `dbc345b513795506c30c8300683d99fe1bd4b14d14c012663808bf7a406089ac` |
| `a70ed17e183648a9bcf4-1.0.9.xpi` | `760256812` | `101,231` | `d4e8d6e585ba6dfaf841eb6b37f2ee27beae1cec55badbbe0dd12960ad5943ec` |
| `latest.json` | `760256869` | `2,139` | `893f44d220e6b89a72a4b4f97ea9a1056bdb5ec0f9ce6c64e66853ea7c74c745` |
| `RELEASE_NOTES.md` | `760256936` | `4,391` | `d26993062444760c199189f032c82b7ebf9baec331022fe13019b978857ce3bc` |
| `INSTALLATION_AND_UPGRADE_NOTES.md` | `760257006` | `2,508` | `fd575bfe9b5608ed1f8474224fb4a7d269b0b6adf03d7bb1601b865346b983bb` |
| `SHA256SUMS.txt` | `760257448` | `1,357` | `f4ba61a900502ae7e7370496152d4f12b60458aab02f342a4f9ed1bd08d173bc` |
| `LICENSE` | `760257083` | `1,465` | `55460ef099ce57e32d422427a7a24cd1e09aec677606289e396c2c17d625a598` |
| `LICENSE-MIT` | `760257146` | `1,092` | `dffcef788fe594963f082966daa3b969c7c4f633e612d8f88ee8a3033c4a5144` |
| `LICENSE-APACHE` | `760257221` | `9,899` | `20fe7b00e904ed690e3b9fd6073784d3fc428141dbd10b81c01fd143d0797f58` |
| `LICENSE-GPLv3.txt` | `760257298` | `35,147` | `8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903` |
| `LICENSE-THIRD-PARTY.txt` | `760257391` | `4,421` | `4f05486cb940a151e9b010ff3d033b7fb06370c665d174eb5d54d48433eb6035` |

---

## 6. Updater Manifest URL & Validation Results

- **Production Endpoint:** `https://github.com/robijoychakma375-hash/tori-download-manager/releases/latest/download/latest.json`
- **Redirect & Payload Check:**
  - `302 Found` -> `https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.5/latest.json` -> `200 OK`
  - Valid JSON with `"version": "1.0.5"`, valid RFC3339 `"pub_date": "2026-11-17T16:54:35.770Z"`, both `windows-x86_64` and `windows-x86_64-nsis` platforms pointing to `https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.5/TORI.Download.Manager_1.0.5_x64-setup.exe`, zero stale `1.0.4` references.
  - Note: Verified git tags `release/v1.0.3` and `release/v1.0.4` share the exact same `/releases/latest/download/latest.json` endpoint and Minisign public key ID `CDC23D8CC8DA5397`.
- **Upgrade Matrix Validation:**
  - `v1.0.3` client -> **Update offered (`1.0.5`)** — **PASS**
  - `v1.0.4` client -> **Update offered (`1.0.5`)** — **PASS**
  - `v1.0.5` client -> **No update offered (up-to-date)** — **PASS**
  - `v1.0.6` (future version) -> **No downgrade offered** — **PASS**
- **Cryptographic Verification:**
  - `cargo test --workspace --test updater_cryptography_tests`: **`6 passed, 0 failed`**, confirming Minisign Ed25519 signature verification against `src-tauri/tauri.conf.json` pubkey (`CDC23D8CC8DA5397`) and strict rejection of tampered payloads/corrupted signatures.
  - Both `windows-x86_64` and `windows-x86_64-nsis` signatures inside live `latest.json` match the live downloaded `TORI.Download.Manager_1.0.5_x64-setup.exe.sig` (`436` B, SHA-256 `d43c0a98...`) verbatim, and the live downloaded `117,783,770`-byte installer matches the cryptographically verified `v1.0.5` RC installer bit-for-bit.

---

## 7. Website Deployment URL & Commit

- **Production Custom Domain:** `https://toridownload.xyz`
- **Cloudflare Pages Deployment URL:** `https://2d5c92f1.tori-download-manager.pages.dev`
- **Cloudflare Deployment ID:** `2d5c92f1-0774-4175-9edf-37853b09de31` (`Environment: Production`, `Branch: main`)
- **Website Git Commit:** `939bc97808157a728292c975fc8c36e240016a17` (`robijoychakma375-hash/tori-website-private`)
- **Updated Files:**
  - `index.html`: Updated JSON-LD (`1.0.5`, `112.3MB`), Hero/Download/Files/Footer labels (`v1.0.5` & `Companion v1.0.9`), GitHub release asset links, fallback release list & asset matching (`findWindowsInstaller`, `findExtensionZip`, filtered release archive excluding `extension-*` tags), SHA-256 verification commands & hashes, and changelog entries.
  - `_headers`: Added `/assets/tori-download-manager-firefox-v1.0.9.xpi` and `/tori-download-manager-firefox-v1.0.9.xpi` with `Content-Type: application/x-xpinstall` and `Access-Control-Allow-Origin: *`.
  - `assets/tori-download-manager-firefox-v1.0.9.xpi`: Added verified Mozilla-signed `1.0.9` XPI (`d4e8d6e5...`), preserving `v1.0.3`–`v1.0.5` archival `.xpi` files.
  - `sitemap.xml`: Updated `<lastmod>2026-11-18</lastmod>`.
- **Responsive Layout Verification (Headless Chrome CDP):**
  - Desktop (`1440x900`) & Mobile (`390x844`): Home (`#top`), Download (`#download`), and Extension (`#extension`) views all rendered `v1.0.5` + `Companion v1.0.9`, zero horizontal overflow (`scrollWidth <= innerWidth`), `brokenImgs = 0`, and zero JS runtime exceptions.

---

## 8. Firefox Signing Verification

- **Browser:** `Mozilla Firefox 160.0` (isolated profile with `xpinstall.signatures.required = true`)
- **Tested Binary:** Downloaded directly from production `https://toridownload.xyz/assets/tori-download-manager-firefox-v1.0.9.xpi` (`HTTP 200`, `Content-Type: application/x-xpinstall`, `101,231` B, SHA-256 `d4e8d6e585ba6dfaf841eb6b37f2ee27beae1cec55badbbe0dd12960ad5943ec`).
- **Verification Results:**
  - Permanent installation (`Addon:Install` with `temporary: false`) succeeded under strict signature enforcement (`xpinstall.signatures.required = true`).
  - `id`: `tori-download-manager@toridm.org`
  - `version`: `1.0.9`
  - `isActive`: `true`
  - `temporarilyInstalled`: `false`
  - `signedState`: `2` (`SIGNEDSTATE_SIGNED`)
  - `popupUrl` resolved cleanly (`moz-extension://.../popup/popup.html`).

---

## 9. Chrome & Edge Extension Verification

- **Tested Binary:** Extracted directly from live GitHub Release `https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.5/tori-companion-v1.0.9-chromium.zip` (`85,049` B, SHA-256 `dbc345b513795506c30c8300683d99fe1bd4b14d14c012663808bf7a406089ac`, `manifest_version: 3`, `version: "1.0.9"`).
- **Google Chrome `157.0.8103.79`:** Installed unpacked & verified via `chrome.developerPrivate.getExtensionsInfo`: ID `jfnfgmcbgapcpieaonbaolgebjaejcdm`, `version: "1.0.9"`, `state: "ENABLED"`, `manifestErrors: 0`, `runtimeErrors: 0`.
- **Microsoft Edge `157.0.4341.60`:** Installed unpacked & verified via `chrome.developerPrivate.getExtensionsInfo`: ID `jfnfgmcbgapcpieaonbaolgebjaejcdm`, `version: "1.0.9"`, `state: "ENABLED"`, `manifestErrors: 0`, `runtimeErrors: 0`.

---

## 10. Real Post-Release Download & Installation Checks

- **`verify_gate30_2_live.js --phase=github` (`31 PASSED, 0 FAILED`):** Downloaded all 7 core binaries/extensions + `latest.json` + `SHA256SUMS.txt` over HTTPS from GitHub Release `v1.0.5` and verified exact byte counts and SHA-256 hashes against the approved RC manifests.
- **`verify_gate30_2_live.js --phase=site` (`9 PASSED, 0 FAILED`):** Verified `https://toridownload.xyz/`, `https://toridownload.xyz/assets/tori-download-manager-firefox-v1.0.9.xpi` (`application/x-xpinstall`, exact SHA-256), and `https://toridownload.xyz/sitemap.xml`.
- **Live NSIS Installer Payload Extraction & Silent Install Check (`verify_live_install_and_preservation.py`):**
  - Ran the live-downloaded `TORI.Download.Manager_1.0.5_x64-setup.exe` silently (`/S /D=%TEMP%\tori_g30_2_install_qa\desktop_install`).
  - Verified exact PE `ProductVersion = 1.0.5` and `diffs = 0` on `tdm-native-host.exe`, `tdm-cli.exe`, `ffmpeg.exe`, `ffprobe.exe`, and `yt-dlp.exe`.
  - Verified `tori-download-manager.exe` (`30,723,072` B, SHA-256 `f4121f9e4b2b9026e22239c49bd212f67f2a16e188399892f8fed28a84bad46f`) is byte-identical to standalone RC `629ebc63afe94a1240a4bc79802502c188bfbf6b8d0f24e0005e350f4a5f0f4a` aside from Tauri's expected 3-byte NSIS bundle-type tag patch (`__TAURI_BUNDLE_TYPE_VAR_UNK` -> `__TAURI_BUNDLE_TYPE_VAR_NSS` at offsets `24212850..24212852`).

---

## 11. User-Data Preservation Evidence

- **Isolated Live Install Upgrade Simulation:**
  - Seeded isolated `TORI_DATA_DIR` using SQLite online backup of the 33-row database, dark/ocean theme `app_settings`, and a test `.tdm-part` partial file (`SHA-256: 150203fc919c2a657b441072868d8fbbcd83eb3dd3992e694b781764f90ad631`).
  - Installed and booted the live-downloaded `v1.0.5` `tori-download-manager.exe --minimized` against that `TORI_DATA_DIR`.
  - Confirmed `/api/v1/ping` responded (`status: ok`, `authenticated: true`, `engine_active: true`, API protocol `2.0.0`) and `/api/v1/downloads` preserved all **`33`** existing jobs intact.
  - Confirmed `.tdm-part` partial file SHA-256 and user theme/accent settings remained unchanged after shutdown.
- **Production OEM Installation & Database Preservation:**
  - Operator SQLite database (`%APPDATA%\tori-download-manager\tdm_storage.sqlite`) verified intact (`PRAGMA integrity_check = ok`, `downloads = 33`, `SHA-256 = 5772a3450181ceadf64bbe7e7fb85f5607d312121345bb15506d04a670df34a2` before & after Gate 30.2 QA; `com.tori.download_manager*.json` Native Messaging manifests and minimized tray process restored).

---

## 12. Known Limitations

Accepted by the project owner prior to publication and preserved verbatim:
1. **No Windows Authenticode Code Signing:** The NSIS installer (`TORI.Download.Manager_1.0.5_x64-setup.exe`) and bundled/standalone Windows executables (`tori-download-manager.exe`, `tdm-native-host.exe`, `tdm-cli.exe`) do not carry a commercial Authenticode signature (`NotSigned`). Windows Defender SmartScreen and UAC may prompt users with an unknown publisher warning until an OV/EV code-signing certificate is applied.
2. **Independent Clean Windows VM Testing Not Performed:** Clean-machine install/upgrade/uninstall testing on an isolated Windows 10/11 VM was not conducted (`0` Hyper-V VMs configured on the host; host isolated QA directories and profiles were used instead).
3. **Additional Non-Blocking Notes:** Chrome Web Store and Microsoft Edge Add-ons store listing submissions were not performed in this CLI release (Chromium `v1.0.9` is published as an unpacked ZIP alongside the release); `app.security.csp` in `src-tauri/tauri.conf.json` remains `null`; paid DRM-protected media streams are unsupported.

---

## 13. Failed or Unperformed Checks

- **Unperformed:**
  - Independent Clean Windows 10/11 VM Validation (`NOT TESTED` — accepted risk).
  - Commercial Windows Authenticode Signing (`NotSigned` — accepted risk).
  - Automated Chrome Web Store / Edge Add-ons portal submission (Chromium `v1.0.9` verified locally via live GitHub ZIP in Chrome `157` and Edge `157`).
- **Resolved Intermediate Issues During Execution (All Final Post-Fix Checks Passed):**
  - Initial upload attempts encountered upstream `ECONNRESET` TCP resets at ~1.5 Mbps until `upload_installer_only.py` (`curl -X POST -T --http1.1` retry loop) uploaded and digest-verified `TORI.Download.Manager_1.0.5_x64-setup.exe` cleanly on Attempt 4 (`654.2s`, `HTTP 201`).
  - Temporary verification script adjustments (`MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1`, Win32 `#32770` child-window lookup for Chrome `loadUnpacked()`, space-free temp `/D=` for NSIS silent path parsing, and verifying Tauri's 3-byte `__TAURI_BUNDLE_TYPE_VAR_NSS` binary patch + `/api/v1/ping` API protocol `'2.0.0'` vs PE `ProductVersion = '1.0.5'`) were solely inside Gate 30.2 scratch scripts; zero repository or release artifacts were modified.

---

## 14. Rollback Status

- **Status:** **`NOT TRIGGERED` (Rollback Readiness Verified & Preserved)**
- **Retained Rollback Anchors:**
  - Historical GitHub Releases (`v1.0.4` ID `443394435`, `v1.0.3`, `v1.0.2`, `v1.0.1`, `v1.0.0`, `extension-v1.0.5`, `extension-v1.0.4`) remain untouched and live.
  - Pre-release GitHub API & `latest.json` (`1.0.4`) snapshots stored locally in `scratch/gate30_2_rollback_snapshot/`.
  - Previous production Cloudflare Pages deployment `ede57dc2-7ec9-4b53-b02f-b796fa0741be` (`a569761` in `tori-website-private`) remains available for immediate rollback if ever required.

---

## 15. Recommended Next Development Gate

**Gate 31 / Post-Release Hardening & Distribution Readiness:**
1. Acquire and configure a commercial EV/OV Windows Authenticode certificate (`signtool`) in the build/release pipeline to eliminate SmartScreen unknown-publisher prompts.
2. Provision a clean Windows 10/11 VM image to perform independent clean-machine install, live `v1.0.4 -> v1.0.5` GUI auto-update, and uninstall verification.
3. Package and submit **Browser Companion `v1.0.9`** (`tori-companion-v1.0.9-chromium.zip`) to the Chrome Web Store and Microsoft Edge Add-ons store (Mozilla AMO Firefox `v1.0.9` XPI signing is already complete).
4. Set an explicit strict `app.security.csp` policy in `src-tauri/tauri.conf.json`.
