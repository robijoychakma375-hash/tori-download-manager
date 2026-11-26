# TORI Download Manager — Gate 36.3 Desktop v1.0.9 Public Stable Release Report

**Gate:** Gate 36.3 — Authorized Desktop `v1.0.9` Public Stable Release  
**Date:** 2026-11-26  
**Release Channel & Stage:** `PUBLIC STABLE` — `STAGE 1 (LEGACY PRODUCTION SIGNER + DUAL-KEY TRUST COMPATIBILITY)`  
**Final Assessment:** **`FULL GO — STAGE 1 DESKTOP v1.0.9 PUBLIC STABLE RELEASED & LIVE-VERIFIED`**  
**Public Release URL:** `https://github.com/robijoychakma375-hash/tori-download-manager/releases/tag/v1.0.9`  
**GitHub Release ID:** `458899884`  
**Publication Timestamp (UTC):** `2026-11-26T03:35:20Z`  
**Official Website:** `https://toridownload.xyz` (Cloudflare Pages Deployment ID `8b11dde1-a606-4082-b03f-87ba3cca493e`, commit `330846d19333a9b98bea83d52bf95c2c3a4a1eef`)

---

## 1. Explicit Owner Authorization & Risk Governance

Desktop `v1.0.9` Public Stable (Stage 1) was executed under explicit project-owner authorization following review of Gate 36.2 (`checkpoint-gate36_2-desktop-v109-prepublish-ready`). The owner explicitly accepted the following three operational limitations **for Stage 1 Desktop `v1.0.9` Public Stable publication only**:

| Risk ID | Operational Limitation | Measured State | Owner Disposition (Stage 1 `v1.0.9` Only) | Ongoing Boundary |
| :--- | :--- | :--- | :--- | :--- |
| **`RISK-36-01`** | Dedicated External Tools Key (`C3FD6626A3718E63`) Offline Backup & Recovery | `BACKUP_RECOVERY_NOT_VERIFIED` *(active key verified `VALID_PRODUCTION_KEY`, encrypted & preserved)* | `ACCEPTED_FOR_STAGE1_DESKTOP_V109_PUBLIC_RELEASE` | Stage 1.5 / Stage 2 dedicated-key-only manifest signing remains **STRICTLY DISABLED & BLOCKED** until `-Mode VerifyBackup` passes with separate authorization. |
| **`RISK-36-02`** | Clean Windows 10 & Windows 11 OS Installation / Upgrade QA | `CLEAN_WINDOWS_QA_NOT_TESTED` *(`0` local VMs/Sandbox; `.github/workflows/clean-windows-release-qa.yml` not on `origin/master`)* | `ACCEPTED_FOR_STAGE1_DESKTOP_V109_PUBLIC_RELEASE` | Local isolated NSIS sandboxes and browser profiles are explicitly NOT represented as clean Windows 10/11 OS validation. |
| **`RISK-36-03`** | Windows PE Authenticode Commercial Code Signing | `AUTHENTICODE_NOT_SIGNED` (`NotSigned` on installer & standalone EXEs) | `ACCEPTED_FOR_STAGE1_DESKTOP_V109_PUBLIC_RELEASE` | Mandatory Tauri Ed25519 signing (`CDC23D8CC8DA5397`) verified; no WDK test certificate used. |

These three acceptances apply strictly to Stage 1 Desktop `v1.0.9` and do not authorize future releases or Stage 2 signing migration.

---

## 2. Source Provenance, Git Topology & Release Checkpoints

- **Application Source Commit (Built & Signed Frozen `v1.0.9` RC):** `b60770b1c5124a5a9e5b5c2b883e9a0ecd3fc308` (`checkpoint-gate36_1-desktop-v109-rc-verified`)
  - Verified linear ancestors: Gate 35.1 (`cb885d48cfcfc1557489a033984e12037c10ea80`), Gate 35.2 (`48184cb2b6d05d25e3ffc47f967f4ca11a82a025`), Gate 35.5 (`169e8641b78d9f35833cb790de3fab52e13c55e4`).
- **Gate 36.2 Preparation Commit:** `67736af63e7b2d5778e3b86c07915b9bd7078f9a` (`checkpoint-gate36_2-desktop-v109-prepublish-ready`)
- **Pre-Publication Safety Checkpoint:** `checkpoint-gate36_3-before-v109-publication` (pinned to `67736af63e7b2d5778e3b86c07915b9bd7078f9a`)
- **Release Branch:** `release/gate36_3-desktop-v109-public-stable`
- **Public Git Release Tag:** `v1.0.9` (tag object `1c8667ca1338579c2cf9869b8c163538f8ae750e` → verified application source commit **`b60770b1c5124a5a9e5b5c2b883e9a0ecd3fc308`**)
- **Preserved Remote Refs (Untouched, Zero Force-Pushes):**
  - `origin/master`: `62715926785da3fd7da811da997279931cc5cad0` (External Tools expiry monitor workflow intact — 4 consecutive daily `completed/success` runs through `2026-11-25`)
  - `refs/tags/v1.0.8`: `f40fb0db4b4a38943184f7cf01638e3d96231180` → `1a24265d247a43371ab2b637e195425df2c78b82`
  - `refs/tags/extension-v1.0.11`: GitHub Release ID `458864802` (`5` assets untouched)
- **Storage Safety Verified:** Pre-release `F: 36.08 GB` / `C: 62.05 GB` free; post-release `F: 35.32 GB` / `C: 61.74 GB` free.

---

## 3. Published GitHub Release `v1.0.9` & Roundtrip-Verified 16-Asset Inventory

- **Repository:** `robijoychakma375-hash/tori-download-manager`
- **Release Title:** `TORI Download Manager v1.0.9 — Security & Reliability Update`
- **Release ID:** `458899884` (`draft: false`, `prerelease: false`, GitHub **Latest Stable**)
- **Publication Timestamp:** `2026-11-26T03:35:20Z`
- **Evidence Artifacts:** `target/gate36_3_evidence/github_draft_staging_report.json`, `target/gate36_3_evidence/github_publish_report.json`, `target/gate36_3_evidence/phase12_public_updater_verify.json`

Every asset below was uploaded to Draft `458899884` and immediately roundtrip-downloaded from GitHub to verify exact byte count and SHA-256 against the frozen RC/staged files BEFORE publication:

| # | Asset Name | GitHub Asset ID | Bytes | Verified Roundtrip SHA-256 |
| :-: | :--- | ---: | ---: | :--- |
| 1 | `TORI.Download.Manager_1.0.9_x64-setup.exe` | `794121013` | `118,170,722` | `460f5da00d09267a5f33274645250d92162bbfa3605f0348cc656a39a8a19ead` |
| 2 | `TORI.Download.Manager_1.0.9_x64-setup.exe.sig` | `794152178` | `436` | `9fd6f9e8a46e93dd1e1f6212b9d174aba3cc23761c55704f2a407965cb385aa0` |
| 3 | `latest.json` | `794152258` | `1,711` | `04a7fdfa7ec0299e13a43a75687b1ae912517a32fa34eff0eb789d4e65c8d85d` |
| 4 | `tori-download-manager.exe` | `794152403` | `32,290,304` | `94995ea2eae40ec9101dd9f5f08f64ff717662143e8db936aae650f7daf17442` |
| 5 | `tdm-native-host.exe` | `794161801` | `19,449,344` | `90cbb76fe03c42b03736df78262b3486068f410d604c664d5e22fd4c7247479f` |
| 6 | `tdm-cli.exe` | `794167674` | `17,102,848` | `f25c29376e27d3a1025bbc39d09bae273c21d1fa6da4b62f44e0eea93a6ac368` |
| 7 | `SHA256SUMS.txt` | `794173139` | `912` | `bc5e7054734aff2a8c9619ce5a2ff7294225bbf572b825eae32c366bf6d694c0` |
| 8 | `RELEASE_NOTES_v1.0.9.md` | `794173240` | `5,286` | `47d51f356d0eb1422c59784c0e0b81a69c252baa368d6f001e42acac79b7877f` |
| 9 | `INSTALLATION_AND_UPGRADE.md` | `794173335` | `2,096` | `fba2b6fd35ab39ddb51c9e0a7b43c1367da3159136c852d162e9f72519ac80f2` |
| 10 | `BUILD_METADATA.json` | `794173424` | `2,765` | `8f56c1b11b00669be2d2f28730a0fab0a2fd05e527942a6d6dea8b67bd5d4dbd` |
| 11 | `RELEASE_MANIFEST.json` | `794173507` | `1,119` | `c192610bbfbb1d81a2c5b1677e26a462c1afb15fe0cf42a25858f9e83a68c412` |
| 12 | `LICENSE` | `794173582` | `1,465` | `55460ef099ce57e32d422427a7a24cd1e09aec677606289e396c2c17d625a598` |
| 13 | `LICENSE-MIT` | `794173642` | `1,092` | `dffcef788fe594963f082966daa3b969c7c4f633e612d8f88ee8a3033c4a5144` |
| 14 | `LICENSE-APACHE` | `794173708` | `9,899` | `20fe7b00e904ed690e3b9fd6073784d3fc428141dbd10b81c01fd143d0797f58` |
| 15 | `LICENSE-GPLv3.txt` | `794173790` | `35,147` | `8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903` |
| 16 | `LICENSE-THIRD-PARTY.txt` | `794173871` | `4,421` | `4f05486cb940a151e9b010ff3d033b7fb06370c665d174eb5d54d48433eb6035` |

*Note on Phase 0 hygiene catch:* Gate 36.1's `GATE36_1_DESKTOP_V109_RELEASE_NOTES.md` and Gate 36.2's `BUILD_METADATA.json`/`RELEASE_MANIFEST.json` contained pre-release `LOCAL RELEASE CANDIDATE — UNPUBLISHED` / `published: false` markers; Phase 0 caught this before upload and produced clean Public Stable metadata (`docs/release/GATE36_3_DESKTOP_V109_PUBLIC_RELEASE_NOTES.md`) without rebuilding or modifying any frozen binary or signature byte.

---

## 4. Live Auto-Updater (`latest.json`) & Official Website Deployment

### Public Auto-Updater Verification (Phase 12)

- **Endpoint:** `https://github.com/robijoychakma375-hash/tori-download-manager/releases/latest/download/latest.json`
- **Fresh Unauthenticated HTTPS Check:** `HTTP 200`, `1,711` bytes, UTF-8 without BOM, SHA-256 `04a7fdfa7ec0299e13a43a75687b1ae912517a32fa34eff0eb789d4e65c8d85d`, `version = "1.0.9"`, `pub_date = "2026-11-26T02:40:02.335Z"`, zero draft/localhost/staging markers.
- **Public Installer Download via `latest.json` URL:** `HTTP 200`, `118,170,722` bytes, SHA-256 `460f5da00d09267a5f33274645250d92162bbfa3605f0348cc656a39a8a19ead`.
- **Tauri Ed25519 Signature Verification:** **VALID** under embedded `tauri.conf.json` public key `CDC23D8CC8DA5397` (`trusted comment: timestamp:1795660656\tfile:TORI Download Manager_1.0.9_x64-setup.exe`); 1-byte tamper strictly rejected in both Rust and Node.js.
- **Historical Preservation:** Desktop `v1.0.8` (ID `455125259`, `16` assets) and Browser Companion `v1.0.11` (ID `458864802`, `5` assets) verified untouched.

### Official Website Deployment & Live Endpoints (Phases 13–14)

- **Repository:** `robijoychakma375-hash/tori-website-private`
- **Deployed Commit (`main` fast-forward from `3edb4293...`):** `330846d19333a9b98bea83d52bf95c2c3a4a1eef`
- **Cloudflare Pages Deployment ID:** `8b11dde1-a606-4082-b03f-87ba3cca493e` (`status=completed`, `conclusion=success`)
- **Live `https://toridownload.xyz/` Verification (`target/gate36_3_evidence/phase13_14_website_and_endpoints.json`):**
  - `GET https://toridownload.xyz/`: `HTTP 200` (`75,372` B), JSON-LD `softwareVersion: "1.0.9"`, `112.7 MB`, SHA-256 `460f5da0...`, historical `v1.0.8` preserved.
  - `HEAD` on website Desktop download link: `HTTP 200`, `Content-Length: 118,170,722`.
  - `GET https://toridownload.xyz/assets/tori-download-manager-firefox-v1.0.11.xpi`: `HTTP 200`, `111,347` B, `application/x-xpinstall`, SHA-256 `4cd6d6fbf067cb98538fd807eaba360d40b409df07cbfb515b8d9b702b37c0fd`.
  - `GET` GitHub Companion `v1.0.11` Chromium ZIP: `HTTP 200`, `94,625` B, SHA-256 `1e77592bb05e548d832df373331aee4f90788a004cdaef7ca80c97df84b88559`.
  - `GET https://toridownload.xyz/assets/tools/tools-manifest.json` + `.sig`: `HTTP 200`, `manifest_revision=2`, `signing_key_id=CDC23D8CC8DA5397`, `expires_at=2027-01-21T19:46:42.049Z`, manifest SHA-256 `caa2d4ed2a7e424badcd8662e67b986a3fdfbf2847dded0625ea2b2547663f3a`, detached `.sig` SHA-256 `11efa53f290d3d46fb16915fd3d1e69451de8c654eae8d75844b840ab99bb1c2`.
  - `GET https://toridownload.xyz/sitemap.xml`: `HTTP 200` (`267` B).

---

## 5. Executed Post-Release QA Matrix (Phases 5 & 15–22 — **189 / 189 PASS**)

Every suite below was executed freshly during Gate 36.3 with explicit watchdogs and archived individual logs (`target/gate36_3_qa_logs/`):

| Suite | Start UTC | End UTC | Total | PASS | FAIL | TIMEOUT | NOT TESTED | Exit | Log Path |
| :--- | :--- | :--- | ---: | ---: | ---: | ---: | ---: | :-: | :--- |
| `RUST_CONTENT_RANGE` (`gate35_2_content_range_tests`) | `03:10:52Z` | `03:10:54Z` | 11 | 11 | 0 | 0 | 0 | 0 | `target/gate36_3_qa_logs/p5_content_range.log` |
| `RUST_STARTUP_TRAY` (`gate35_2_startup_and_tray_tests`) | `03:10:54Z` | `03:10:55Z` | 5 | 5 | 0 | 0 | 0 | 0 | `target/gate36_3_qa_logs/p5_startup_tray.log` |
| `RUST_SECURITY_HARDENING` (`gate35_security_hardening_tests`) | `03:10:55Z` | `03:11:07Z` | 10 | 10 | 0 | 0 | 0 | 0 | `target/gate36_3_qa_logs/p5_security_hardening.log` |
| `RUST_TOOLS_MATRIX` (`external_tools_security_matrix_tests`) | `03:11:07Z` | `03:11:22Z` | 5 | 5 | 0 | 0 | 0 | 0 | `target/gate36_3_qa_logs/p5_tools_matrix.log` |
| `RUST_UPDATER_CRYPTO` (`updater_cryptography_tests`) | `03:11:22Z` | `03:11:29Z` | 11 | 11 | 0 | 0 | 0 | 0 | `target/gate36_3_qa_logs/p5_updater_crypto.log` |
| `RUST_NATIVE_HOST` (`cargo test -p tdm-native-host`) | `03:11:29Z` | `03:11:38Z` | 32 | 32 | 0 | 0 | 0 | 0 | `target/gate36_3_qa_logs/p5_native_host.log` |
| `P15_16_17_19_LIVE_UPGRADE_ENGINE_TOOLS` (`verify_gate36_3_live_release.js`) | `03:49:54Z` | `03:50:39Z` | 20 | 20 | 0 | 0 | 0 | 0 | `target/gate36_3_qa_logs/p15_16_17_19_live_upgrade.log` |
| `P18A_COMPANION_V1011_SIGNED_FIREFOX` (live public XPI vs `v1.0.9`) | `03:50:39Z` | `03:51:05Z` | 15 | 15 | 0 | 0 | 0 | 0 | `target/gate36_3_qa_logs/p18_companion_v1011_signed_firefox.log` |
| `P18B_COMPANION_V1011_CHROME_EDGE_FIREFOX` (live public ZIP vs `v1.0.9`) | `03:51:05Z` | `03:51:43Z` | 32 | 32 | 0 | 0 | 0 | 0 | `target/gate36_3_qa_logs/p18_companion_v1011_real_browsers.log` |
| `P18C_EXTENSION_SECURITY_VM` (`SEC-35-04`) | `03:51:43Z` | `03:51:43Z` | 30 | 30 | 0 | 0 | 0 | 0 | `target/gate36_3_qa_logs/p18_extension_security_vm.log` |
| `P19B_RUST_EXTERNAL_TOOLS_ROLLBACK_UNIT` (`tdm-core --lib tools`) | `03:51:43Z` | `03:52:05Z` | 7 | 7 | 0 | 0 | 0 | 0 | `target/gate36_3_qa_logs/p19_tools_rollback_tests.log` |
| `P19C_TOOLS_UPDATER_ROLLBACK` (`external_tools_updater_tests`) | `03:52:51Z` | `03:54:06Z` | 11 | 11 | 0 | 0 | 0 | 0 | `target/gate36_3_qa_logs/p19c_tools_updater_rollback_integration.log` |
| `P20_22_OEM_PRESERVATION_AND_SECRETS` | `03:52:05Z` | `03:52:21Z` | — | PASS | 0 | 0 | 0 | 0 | `target/gate36_3_qa_logs/p20_22_oem_preservation_and_secrets.log` |
| Clean Windows 10 & Windows 11 OS VM QA | — | — | 0 | 0 | 0 | 0 | **2** | — | Owner-accepted via `RISK-36-02` |

### Key Live Post-Release Findings

1. **Real Public `v1.0.8` → `v1.0.9` NSIS + Live Auto-Updater Upgrade (`P15-01..P15-09`):**
   - Installed public `TORI.Download.Manager_1.0.8_x64-setup.exe` silently into isolated `target/gate36_3_live_upgrade/install` (`peVersion=1.0.8`), booted, created baseline download (`state=completed`) + settings + `preserved_partial.bin.tdm-part`.
   - Exercised **live `window.__TAURI__.core.invoke('plugin:updater|check')`** on installed `v1.0.8` against the real public GitHub `latest.json` endpoint: verified `v1.0.8` offered **`version = "1.0.9"`** (`date = "2026-11-26T02:40:02.335Z"`).
   - Ran real in-place NSIS upgrade using the live-downloaded public `TORI.Download.Manager_1.0.9_x64-setup.exe` (`460f5da0...`); verified upgraded `tori-download-manager.exe` (`32,290,304` B, PE `1.0.9`, Stage 1 dual-key embedded, `0` private key markers; NSIS-packed SHA-256 `65ee31cc...` differs from standalone `94995ea2...` solely by Tauri v2's 3-byte `TAURI_BUNDLE_TYPE_VAR` `UNK` → `NSS` bundle tag at offset `25498034`).
   - Verified upgraded `v1.0.9` reports `get_app_version = "1.0.9"`, `plugin:updater|check` returns `null` (up-to-date, zero downgrade), SQLite `integrity=ok`, download history, `closeToTray=true`, theme/accent, and `.tdm-part` preserved; isolated `uninstall.exe /S` removed binaries while leaving isolated SQLite & `.tdm-part` intact.
2. **Live `Content-Range` Broken-CDN Regressions (`P16-01..P16-05` + `11/11` Rust):**
   - Verified against live installed `v1.0.9`: exact broken-CDN `206 bytes 0-(N-1)/N` fallback (`P16-01`), Range-ignored `200 OK` fallback (`P16-02`), malformed `206` rejection & recovery (`P16-03`), mid-download `ETag` change recovery (`P16-04`), and `HTTP 416` recovery (`P16-05`) — all completed with exact SHA-256 and untouched unrelated `.tdm-part`.
3. **Live Startup, Hidden Tray, Zero Failed-Job Popup & Spawn Mutex (`P17-01..P17-04` + `5/5` + `32/32` Rust):**
   - Verified `--minimized` keeps main window hidden (`mainWindowVisible=false`), deliberate failed job auto-opened **`0`** progress popups (`progressPopups=0`), `4x` concurrent installed `v1.0.9` `tdm-native-host.exe` stdio pairing calls succeeded `4/4` without spawn stampede, and clean shutdown/restart preserved `closeToTray=true` and all downloads (`integrity=ok`).
4. **Live Public Browser Companion `v1.0.11` Compatibility (`77 / 77 PASS`):**
   - Exercised freshly downloaded public Mozilla-signed Firefox XPI (`4cd6d6fb...`, `15/15`) and public Chromium ZIP (`1e77592b...`, `32/32` across Chrome/Edge/Firefox) + `SEC-35-04` VM (`30/30`) against `v1.0.9`: permanent Mozilla signing (`SIGNEDSTATE_SIGNED`), offline no-spawn, Native Messaging pairing, zero token leak, adversarial attacks blocked, overlay & intercepted downloads exact SHA-256, dedup, and restart zero stale replay.
5. **Live External Tools Rev 2 & Rollback Continuity (`P19-01..02` + `5/5` + `7/7` + `11/11` Rust):**
   - Verified installed bundled `FFmpeg` (`N-126374-g089a48eb36-20260831`), `FFprobe`, and `yt-dlp` (`2026.08.19`), live `get_external_tools_status` + `check_external_tools_updates` against rev 2 (`CDC23D8CC8DA5397`, Stage 1 dual-key `C3FD6626A3718E63` active, Stage 2 cutover **DISABLED**), and atomic paired activation/quarantine/rollback integration tests (`11/11`).

---

## 6. Operator Production-Data Preservation (Phase 20)

Verified bit-for-bit against pre-release snapshot `target/gate36_3_evidence/pre_release_baseline_snapshot.json`:

| Protected Operator Asset | Pre-Release Baseline | Post-Release Measured State | Status |
| :--- | :--- | :--- | :---: |
| Installed OEM Desktop (`v1.0.6`) | `570833b379668f64d8f0a81e0a2c138635835e0c0382f37f24ec969caccf0fda` | Identical SHA-256 | **PRESERVED** |
| Operator SQLite (`tdm_storage.sqlite`) | `4a2d77719d965d651e9fdb0fb84777b20a0eeb4d4482715673400ff125ce9f66` (`ok`, `56` downloads, `531` chunks, `7` settings) | Identical SHA-256, `ok`, `56` / `531` / `7` | **PRESERVED** |
| Operator `.tdm-part` Files | `21` files (individually hashed) | `21 / 21` bit-for-bit identical | **PRESERVED** |
| HKCU `NativeMessagingHosts` (Chrome, Edge, Mozilla) | Exact pre-release snapshot values | Restored & verified bit-for-bit | **PRESERVED** |
| Stray `tori-download-manager` Processes | `0` | `0` | **CLEAN** |
| Secret Scan (all Gate 36.3 scripts, notes & evidence) | `0` secrets | `0` secrets | **CLEAN** |

---

## 7. Incident Response, Rollback Readiness & Next Recommended Gate

- **GitHub / Auto-Updater Containment:** Desktop `v1.0.8` (ID `455125259`, `16` assets) remains intact and unaltered; if an incident occurs, mark `v1.0.9` as `prerelease: true` / `draft: true` and re-promote `v1.0.8` (`make_latest: "true"`) so new updater checks stop promoting `v1.0.9` (noting that re-pointing Latest Stable does not auto-downgrade already-upgraded `v1.0.9` clients; a signed corrective release would be required for installed clients). Never replace signed installer bytes in place.
- **Website Rollback:** Prior verified Cloudflare Pages deployment **`723c6191-1b46-41b4-aa1b-bd55ae938357`** (`3edb4293b09e16921877381394a8be38e5d3d02c`) remains preserved for instant Cloudflare dashboard rollback or `git revert` on `tori-website-private`.
- **Companion & External Tools Continuity:** Companion `v1.0.11` (`458864802`) and External Tools manifest revision 2 (`caa2d4ed...`) require zero rollback and remain fully compatible across both `v1.0.8` and `v1.0.9`.
- **Final Verdict:** **`FULL GO`** (All 24 Gate 36.3 acceptance criteria verified live; owner-accepted `RISK-36-01`, `RISK-36-02`, and `RISK-36-03` recorded strictly for Stage 1 Desktop `v1.0.9`).
- **Next Recommended Gate:** **Gate 37.1 — Clean Windows 10/11 OS QA (Land CI Workflow / Provision Clean VMs), Dedicated Tools Key Offline Backup Recovery Verification (`-Mode VerifyBackup`), and Commercial Authenticode Provisioning** (required prerequisites before any Stage 1.5/Stage 2 External Tools signing migration).
