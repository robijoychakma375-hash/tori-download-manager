# TORI Download Manager — Gate 31.6 Report
## Desktop v1.0.6 Public Stable Release & Auto-Updater Activation

- **Release Date:** 2026-11-21 (UTC published `2026-11-21T10:35:27Z`)
- **Final Release Status:** **`SUCCESS`**
- **Release Scope:** **Desktop-Only Stable Release (`v1.0.6`)** — Browser Companion **`v1.0.10`** remains completely unchanged
- **Owner-Accepted Documented Limitations:** Windows Authenticode PE code signing remains unavailable (`NotSigned`); independent clean Windows VM testing remains unperformed (`NOT TESTED`). Both remain explicitly documented below.

---

## 1. Executive Summary

TORI Download Manager **Desktop `v1.0.6`** has been publicly released as the repository-wide **Latest Stable** release on GitHub (`robijoychakma375-hash/tori-download-manager`), activated on the production Tauri v2 auto-updater endpoint (`releases/latest/download/latest.json`), and deployed to the official production website (`https://toridownload.xyz`) via Cloudflare Pages.

The release used the **frozen Gate 31.5 RC artifacts** (`release/v1.0.6-rc/`, SHA-256 `c29ee1080b0c3587d29a2e95fd4374524d49fc16055dfa74f9f66554161c6c7c`, `117,794,132` B) with zero source rebuilds and zero modifications to **Browser Companion `v1.0.10`**. All 14 Desktop-only GitHub assets, Ed25519 cryptographic signature checks (`7/7`), live HTTPS downloads, live `latest.json` updater checks, live Cloudflare Pages Desktop (`1440x900`) and Mobile (`390x844`) audits, live Mozilla-signed Firefox `v1.0.10` XPI permanent installation, isolated physical `v1.0.5 → live-downloaded v1.0.6` upgrade and IDM progress window tests, and production user-data preservation checks passed (`13/13 PASS`, `0 FAIL`).

---

## 2. Release Status

**`SUCCESS`**

---

## 3. Git Branch & Exact Commit

| Repository | Branch | Ref / Tag | Exact Commit Hash |
|---|---|---|---|
| `robijoychakma375-hash/tori-download-manager` (Release source) | `fix/gate27-runtime-fixes` & `release/v1.0.6` | `v1.0.6` / `checkpoint-gate31_5-verified` / `checkpoint-gate31_6-before-publication` | `6087db99eb0da4ebf69e2d0d6c489bcf5837ed11` |
| `robijoychakma375-hash/tori-website-private` (Website) | `main` | `HEAD` | `6b3945344838a52ae0f9372b727b4d446dac2ec3` |
| Final Post-Release Checkpoint (main repo) | `fix/gate27-runtime-fixes` | `checkpoint-gate31_6-released` | Recorded in Git & final response |

- No historical branches, releases, or checkpoint tags were deleted or force-pushed.

---

## 4. Release Tag

- **Tag:** `v1.0.6` (annotated tag `cd0c66b22ed84213159b1a8d09d08c2e6628b88d`)
- **Peeled Commit (`refs/tags/v1.0.6^{}`):** `6087db99eb0da4ebf69e2d0d6c489bcf5837ed11`
- **Production Release Branch:** `release/v1.0.6` → `6087db99eb0da4ebf69e2d0d6c489bcf5837ed11`

---

## 5. GitHub Release ID

- **Release ID:** `453599579`
- **Release Name:** `TORI Download Manager v1.0.6`
- **Type:** Stable production release (`draft: false`, `prerelease: false`, repository-wide **Latest Stable**)
- **Published At (UTC):** `2026-11-21T10:35:27Z`

---

## 6. GitHub Release URL

- **Public Release Page:** https://github.com/robijoychakma375-hash/tori-download-manager/releases/tag/v1.0.6
- **Latest Stable Redirect:** https://github.com/robijoychakma375-hash/tori-download-manager/releases/latest
- **Preserved Historical Desktop Release:** `v1.0.5` (ID `449053824`) — untouched
- **Preserved Extension-Only Release:** `extension-v1.0.10` (ID `451270856`) — untouched

---

## 7. Published Asset Inventory (14 Desktop-Only Assets)

All 14 assets uploaded to Release `453599579` with zero Browser Companion packages included:

| # | Asset Name | Asset ID | Size (Bytes) | Verified SHA-256 |
|---:|---|---|---:|---|
| 1 | `TORI.Download.Manager_1.0.6_x64-setup.exe` | `775156231` | `117,794,132` | `c29ee1080b0c3587d29a2e95fd4374524d49fc16055dfa74f9f66554161c6c7c` |
| 2 | `TORI.Download.Manager_1.0.6_x64-setup.exe.sig` | `775190435` | `436` | `2a3f4b217ae381a7a1d1042ca8b395480132d89d5d58c46a2c8dcccba765624a` |
| 3 | `tori-download-manager.exe` | `775190499` | `30,559,232` | `57cce9fd0207b769ff74f4395a07c184b310c0fcc82bdc38ca5924edb4ce9b3d` |
| 4 | `tdm-native-host.exe` | `775198580` | `19,397,632` | `d02da8be8056cd987bd4b5cdca9535a016f60bcb7cbed94fb43d56c042967671` |
| 5 | `tdm-cli.exe` | `775205426` | `17,067,008` | `2d8286a091caed95979893a1c2e7941163a8acf417d916d01bf31d6b72f58e76` |
| 6 | `latest.json` | `775209591` | `2,166` | `b1b759aabfa9fbe0e8bd931388edef2672563a1e083d1cb6462613a9eb34d6d1` |
| 7 | `SHA256SUMS.txt` | `775209630` | `1,144` | `df2f792dad7d510d0a6432ed70211238dab269a6d5b51d1dcbdcc83db181707b` |
| 8 | `RELEASE_NOTES.md` | `775209675` | `3,988` | `91e3b1bf0201bf2a82df6dd448bd64f9fc28693176e379bfc3a23fc331fd7cc0` |
| 9 | `INSTALLATION_AND_UPGRADE_NOTES.md` | `775209705` | `2,224` | `0f03122b9d598d691671617b8b79a6cd3f49620eaa81b2405e3c59a44c3ac5f2` |
| 10 | `LICENSE` | `775209741` | `1,465` | `55460ef099ce57e32d422427a7a24cd1e09aec677606289e396c2c17d625a598` |
| 11 | `LICENSE-MIT` | `775209784` | `1,092` | `dffcef788fe594963f082966daa3b969c7c4f633e612d8f88ee8a3033c4a5144` |
| 12 | `LICENSE-APACHE` | `775209832` | `9,899` | `20fe7b00e904ed690e3b9fd6073784d3fc428141dbd10b81c01fd143d0797f58` |
| 13 | `LICENSE-GPLv3.txt` | `775209870` | `35,147` | `8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903` |
| 14 | `LICENSE-THIRD-PARTY.txt` | `775209922` | `4,421` | `4f05486cb940a151e9b010ff3d033b7fb06370c665d174eb5d54d48433eb6035` |

---

## 8. Installer SHA-256

- **Public Installer Filename:** `TORI.Download.Manager_1.0.6_x64-setup.exe` (filename-only rename from frozen `TORI Download Manager_1.0.6_x64-setup.exe`; bytes identical)
- **Size:** `117,794,132` bytes (`112.3 MB`)
- **Verified Frozen RC & Live HTTPS Download SHA-256:** `c29ee1080b0c3587d29a2e95fd4374524d49fc16055dfa74f9f66554161c6c7c`

---

## 9. Installer Signature Verification

- **Tauri Auto-Updater Ed25519 Signature (`.sig`):** **`VALID`**
  - `cargo test --workspace --test updater_cryptography_tests`: **`7 passed, 0 failed`** (pre-publication and post-publication)
  - Verifies Minisign Ed25519 signature against the production public key embedded in `src-tauri/tauri.conf.json` (`CDC23D8CC8DA5397`) and strictly rejects tampered payloads and corrupted signatures.
  - Live downloaded `TORI.Download.Manager_1.0.6_x64-setup.exe.sig` (`436` B, SHA-256 `2a3f4b217ae381a7a1d1042ca8b395480132d89d5d58c46a2c8dcccba765624a`) matches the frozen RC `.sig` and both platform signature fields in live `latest.json` verbatim.
- **Windows Authenticode PE Code Signature:** **`NotSigned`** (owner-accepted documented limitation; no commercial OV/EV certificate configured).

---

## 10. Live Updater Manifest Verification

- **Production Endpoint:** `https://github.com/robijoychakma375-hash/tori-download-manager/releases/latest/download/latest.json`
- **Live HTTP Verification (`UPD-LIVE-JSON`):**
  - HTTP `200 OK` (redirected cleanly from `releases/latest` to `v1.0.6` asset ID `775209591`)
  - `"version"`: `"1.0.6"`
  - `"pub_date"`: `"2026-11-21T10:09:04.250Z"` (valid RFC3339)
  - `"platforms"`: `windows-x86_64` and `windows-x86_64-nsis` both point to `https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.6/TORI.Download.Manager_1.0.6_x64-setup.exe` with the verified Ed25519 signature.
  - Zero stale `1.0.4` or `1.0.5` references in `latest.json`.

---

## 11. Supported Upgrade Matrix

| Installed Desktop | Expected Result | Verification Basis | Status |
|---|---|---|---|
| `v1.0.3` | Update offered to `v1.0.6` | Shared `latest.json` endpoint + pubkey `CDC23D8CC8DA5397` + SemVer comparison (`UPD-MATRIX`) | **PASS** (SemVer/manifest verified; physical `v1.0.3 -> v1.0.6` client launch `NOT TESTED`) |
| `v1.0.4` | Update offered to `v1.0.6` | Shared `latest.json` endpoint + pubkey `CDC23D8CC8DA5397` + Gate 31.5 production `v1.0.4 -> v1.0.6` upgrade + `REG-RESPAWN-KILL` | **PASS** |
| `v1.0.5` | Update offered to `v1.0.6` | Live `latest.json` + **Physical isolated upgrade** `v1.0.5 -> live-downloaded v1.0.6` (`LIVE-UPG-V105-TO-V106`) | **PASS** |
| `v1.0.6` | Up to date | SemVer `1.0.6 == 1.0.6` (`UPD-MATRIX`) | **PASS** |
| `> v1.0.6` (e.g. `1.0.7`) | No downgrade | SemVer `1.0.6 < 1.0.7` (`UPD-MATRIX`) | **PASS** |

---

## 12. Website Commit & Deployment ID

- **Website Repository:** `robijoychakma375-hash/tori-website-private` (`C:\Users\ritud\Downloads\tori-website`)
- **Production Branch:** `main`
- **Website Commit:** `6b3945344838a52ae0f9372b727b4d446dac2ec3` (`feat(release): update toridownload.xyz to Desktop v1.0.6 (Companion v1.0.10 unchanged)`)
- **Production URL:** https://toridownload.xyz
- **Cloudflare Pages Deployment ID:** `95177f31-8009-4796-a782-88afee599479` (`status: completed`, `conclusion: success`, `completed_at: 2026-11-21T10:37:05Z`)
- **Previous Rollback Deployment ID (preserved):** `9d7f211c-66f0-434c-b7d4-52ad327910c4` (commit `e71450e20f139725d18e33321112ca4ce1b26989`)
- **Modified Website Files (Desktop-only):** `index.html` (JSON-LD `1.0.6`, hero/download/files/footer Desktop labels & links, `v1.0.6` changelog, Desktop SHA-256 `c29ee108...`, `FALLBACK_RELEASE` → `v1.0.6` with `v1.0.5` archived, `CACHE_KEY` bumped to `tori_release_cache_v3`) and `sitemap.xml` (`<lastmod>2026-11-21</lastmod>`). `_headers`, `robots.txt`, and `assets/` (including `tori-download-manager-firefox-v1.0.10.xpi`) were **not modified**.

---

## 13. Live Website Verification

Verified live against `https://toridownload.xyz` (`SITE-HTTPS-META` & `SITE-LIVE-LAYOUT-LINKS`):
- HTTPS `200 OK` on `/`, `/robots.txt`, `/sitemap.xml` (`2026-11-21`), and `/assets/tori-download-manager-firefox-v1.0.10.xpi` (`Content-Type: application/x-xpinstall`).
- Headless Edge CDP audit across **Desktop (`1440x900`)** and **Mobile (`390x844`)** for `#top`, `#download`, and `#extension`:
  - Hero pill: `New · v1.0.6 for Windows (Stable)`
  - Main Desktop download links: `https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.6/TORI.Download.Manager_1.0.6_x64-setup.exe`
  - Stat version: `1.0.6`; Footer badge: `v1.0.6 · Windows 10 / 11 (64-bit) · Companion v1.0.10`
  - Extension links intact: Firefox `/assets/tori-download-manager-firefox-v1.0.10.xpi` & Chrome/Edge `.../extension-v1.0.10/tori-companion-v1.0.10-chromium.zip`
  - Zero horizontal overflow (`scrollWidth <= innerWidth`), `brokenImgs = 0`, zero JS errors.

---

## 14. Installed Desktop v1.0.6 Runtime Evidence

1. **Repaired Production Workstation Installation (`%LOCALAPPDATA%\TORI Download Manager\`):**
   - `tori-download-manager.exe` PE `ProductVersion = 1.0.6` (`30,559,232` B, SHA-256 `570833b379668f64d8f0a81e0a2c138635835e0c0382f37f24ec969caccf0fda`, exact 3-byte Tauri NSIS `_NSS` patch).
   - `bin\tdm-native-host.exe` (`d02da8be8056cd987bd4b5cdca9535a016f60bcb7cbed94fb43d56c042967671`), `HKCU\Software\tori\TORI Download Manager`, `Uninstall\TORI Download Manager`, Chrome/Edge/Firefox `NativeMessagingHosts`, and OneDrive Desktop + Start Menu shortcuts verified with `100%` parity (`SAFETY-OEM-PARITY PASS`).
2. **Physical Isolated Upgrade from `v1.0.5` → Live-Downloaded `v1.0.6` (`LIVE-UPG-V105-TO-V106 PASS`):**
   - Installed `v1.0.5` (`verBefore=1.0.5`), launched it (`v105Online=true`), ran live-downloaded `TORI.Download.Manager_1.0.6_x64-setup.exe` over it (`verAfter=1.0.6`, `tdm-native-host.exe` SHA-256 match), booted upgraded `v1.0.6` (`upgAppVer=1.0.6`), confirmed Close-to-Tray (`hiddenOk=true`), standalone IDM progress window, Pause/Resume, and download completion with exact SHA-256 (`liveDlShaOk=true`).

---

## 15. IDM Progress Window Verification

Verified in both pre-publication Phase 2 (`verify_gate31_5_install_repair_and_preflight.js`, `23/23 PASS`) and post-publication Phase 10 (`verify_gate31_6_live_release.js`, `LIVE-UPG-V105-TO-V106 PASS`):
- Standalone native window (`label: progress_<uuid>`) opens across manual, browser-captured, Native Messaging, queued, and YouTube downloads.
- Verified all 3 tabs (`Download status`, `Speed limiter`, `Options on completion`), live speed/ETA/connections/segments, Pause/Resume, Compact mode (`365px → 38px`), Always-on-Top (`true`), close-without-canceling, tray-hidden capture, zero duplicates, and `showDownloadPopup=never` respect.

---

## 16. Legacy Toast Elimination

- **`legacyToast: false`** across all Phase 2 (`23/23`) and Phase 10 (`LIVE-UPG-V105-TO-V106`) runtime inspections on Desktop `v1.0.6`.
- Windows download completion notifications (`notify_on_complete`) remain functional and preserved separately.

---

## 17. Browser Companion v1.0.10 Preservation (Phase 11)

- **GitHub Extension Release (`extension-v1.0.10`, ID `451270856`):** Preserved completely untouched; does **not** hold Latest Stable (`releases/latest` is `v1.0.6`).
- **Firefox Signed XPI (`tori-companion-v1.0.10-firefox-signed.xpi` & `/assets/tori-download-manager-firefox-v1.0.10.xpi`):**
  - Size: `107,499` B | Live GitHub & Website SHA-256: **`a93a43872d224426902c49e217e31b2c603263d8c260c429940539b34b2852b8`** (EXACT match)
  - Live Website `Content-Type`: `application/x-xpinstall`
  - Live Firefox permanent installation (`xpinstall.signatures.required=true`): **`PASS`** (`id: tori-download-manager@toridm.org`, `version: 1.0.10`, `signed: true`, `temporary: false`, `active: true`)
- **Chromium ZIP (`tori-companion-v1.0.10-chromium.zip`):**
  - Size: `90,964` B | Live GitHub SHA-256: **`f220fab2e26fd54ef7f85fd7e40613faad79e7f9a7f44fadf228ccd0edcc22f1`** (EXACT match)
- **Live Companion `v1.0.10` ↔ Installed Desktop `v1.0.6` Integration:** Verified in Phase 2 (`S12A-COMPANION-CHROME PASS` & `S12B-COMPANION-FIREFOX PASS`).

---

## 18. SQLite & Partial-File Preservation

- **Production SQLite DB (`%APPDATA%\tori-download-manager\tdm_storage.sqlite`):** `PRAGMA integrity_check = ok`, all **`42`** downloads preserved (`29 completed`, `11 failed`, `2 paused`), operator settings (`dark`/`rose`, `showDownloadPopup=always`, `alwaysOnTop=true`, `closeToTray=true`, `port=6800`) intact, hash unchanged across Gate 31.6 live QA (`SAFETY-PROD-INTEGRITY PASS`).
- **Operator `.tdm-part` Files:** All **`11`** incomplete `.tdm-part` files verified bit-for-bit identical against Phase 0 SHA-256 hashes (`allPartsOk=true`).
- **Physical Upgrade Simulation DB & `.tdm-part`:** Preserved all `42` rows, `dark`/`rose` settings, and `.tdm-part` SHA-256 across `v1.0.5 → live v1.0.6` (`partUnchanged=true`).

---

## 19. Final Gate 31.6 Verification Test Matrix

| Check / Suite | Scope | Result | Details |
|---|---|---|---|
| `cargo test --workspace --test updater_cryptography_tests` (Pre & Post) | Ed25519 signature validation & tamper rejection | **PASS** | `7 passed, 0 failed` |
| `scripts/verify_gate31_5_install_repair_and_preflight.js` (Phase 2) | Frozen `v1.0.6` + Companion `v1.0.10` + 5 install-path regressions | **PASS** | `23 PASS, 0 FAIL, 0 TIMEOUT` |
| `scripts/publish_desktop_v1_0_6_release.js` (Phases 4–7) | Frozen staging, draft upload, pre-publish download SHA-256, Latest Stable promotion | **PASS** | `14/14` assets uploaded & verified |
| `scripts/verify_gate31_6_live_release.js` (Phases 10–11) | Live GitHub, `latest.json`, website Desktop/Mobile, Companion `v1.0.10` preservation, physical `v1.0.5 → live v1.0.6` upgrade | **PASS** | `13 PASS, 0 FAIL` |
| Independent Clean Windows VM Install Test | External clean Windows 10/11 VM | **NOT TESTED** | Owner-accepted documented limitation |
| Physical `v1.0.3 -> v1.0.6` Live Client Auto-Update Run | Historical `v1.0.3` binary auto-updater UI execution | **NOT TESTED** | Manifest/pubkey/SemVer verified (`UPD-MATRIX PASS`) |

---

## 20. Known Limitations

Explicitly documented and unchanged from owner sign-off:
1. **Windows Authenticode Code Signing Unavailable (`NotSigned`):** `TORI.Download.Manager_1.0.6_x64-setup.exe` and Windows PE binaries do not carry a commercial OV/EV Authenticode signature. Windows Defender SmartScreen prompts may appear on manual downloads until a certificate is provisioned. *(Note: Tauri's in-app Ed25519 updater signature is valid and separate from Windows Authenticode.)*
2. **Independent Clean Windows VM Testing Not Performed (`NOT TESTED`):** Verification was executed on the operator's Windows 11 host using isolated QA directories, isolated browser profiles, and physical `v1.0.5 → v1.0.6` isolated upgrades.
3. **Paid DRM-Protected Media Unsupported:** Encrypted DRM streams remain out of scope.

---

## 21. Rollback Status

- **Status:** **`NOT TRIGGERED` (Rollback Anchors Verified & Intact)**
- **Preserved Rollback Anchors:**
  - GitHub Release `v1.0.5` (ID `449053824`) and all 16 `v1.0.5` assets remain live and untouched.
  - Pre-publication GitHub API & `v1.0.5` `latest.json` snapshots archived locally in `target/gate31_6_prepub_backup/`.
  - Previous Cloudflare Pages production deployment `9d7f211c-66f0-434c-b7d4-52ad327910c4` (website commit `e71450e20f139725d18e33321112ca4ce1b26989`) remains available for instant rollback.
  - Pre-publication Git checkpoint tag `checkpoint-gate31_6-before-publication` (`6087db99eb0da4ebf69e2d0d6c489bcf5837ed11`) and pre-repair workstation backup (`target/gate31_5_rollback_backup/`) remain preserved.

---

## 22. Remaining Defects

- **Zero blocking defects** in Desktop `v1.0.6` or Browser Companion `v1.0.10`.
- **Minor Operational Observation Resolved During Execution:** Initial draft-to-publish `PATCH` required passing `tag_name: "v1.0.6"` explicitly so GitHub bound Release `453599579` to tag `v1.0.6` instead of the temporary `untagged-*` draft label; immediately corrected and codified in [publish_desktop_v1_0_6_release.js](file:///F:/TORI/final%20tori%20download%20manager/scripts/publish_desktop_v1_0_6_release.js).

---

## 23. Recommended Next Development Step

1. Provision a commercial OV/EV **Windows Authenticode** code-signing certificate in the Windows release pipeline to eliminate SmartScreen unknown-publisher warnings on manual downloads.
2. Provision a clean **Windows 10/11 VM** for independent clean-machine install/upgrade/uninstall QA on future Desktop releases.
3. Submit **Browser Companion `v1.0.10`** (`tori-companion-v1.0.10-chromium.zip`) to the Chrome Web Store and Microsoft Edge Add-ons store (Mozilla AMO signing is already complete and live).
4. Monitor live Desktop `v1.0.5 → v1.0.6` in-app auto-updater adoption and GitHub release feedback.
