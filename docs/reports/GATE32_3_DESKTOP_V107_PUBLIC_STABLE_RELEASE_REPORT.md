# TORI Download Manager — Gate 32.3 Engineering Report
# Authorized Desktop v1.0.7 Public Stable Release & Production Tools Manifest Activation

- **Release Date:** 2026-11-22 (UTC published `2026-11-22T07:54:22Z`)
- **Gate:** Gate 32.3 — Authorized Desktop `v1.0.7` Public Stable Release & Production Tools Manifest Activation
- **Final Status:** **`SUCCESS` (CONDITIONAL GO ACCEPTED — PUBLICLY RELEASED & LIVE VERIFIED)**
- **Release Scope:** **Desktop-Only Stable Release (`v1.0.7`) + Production External Tools Manifest Activation (`rev 1`)** — Browser Companion **`v1.0.10`** remains completely unchanged.
- **Release Source Commit (`v1.0.7` tag):** `84da0c08256d6abaca253b5612010034237c86f9` (`checkpoint-gate32_2-verified` / `checkpoint-gate32_3-before-publication`)
- **GitHub Release:** `https://github.com/robijoychakma375-hash/tori-download-manager/releases/tag/v1.0.7` (ID `454278227`, Latest Stable)
- **Production Website:** `https://toridownload.xyz` (commit `6dd3ffd7509672f31943e1f46f2ad5f3f54c8f95`, Cloudflare Pages Deployment ID `c7c8f6b1-cb8a-451d-8855-ea40cbb7c087`)

---

## 1. Executive Summary

TORI Download Manager **Desktop `v1.0.7`** has been publicly released as repository-wide **Latest Stable** on GitHub (`robijoychakma375-hash/tori-download-manager`), activated on the production Tauri v2 Desktop Auto-Updater endpoint (`releases/latest/download/latest.json`), paired with the newly promoted **Production Ed25519-Signed External Tools Manifest** (`https://toridownload.xyz/assets/tools/tools-manifest.json` + `.sig`, revision `1`), and deployed to **`https://toridownload.xyz`** via Cloudflare Pages.

Key release milestones executed in strict manifest-first order with zero frozen-RC rebuilds:
1. **Pre-Publication Safety & Out-of-Tree Rollback Anchors:** Created annotated tag `checkpoint-gate32_3-before-publication` (`84da0c08256d6abaca253b5612010034237c86f9`) and archived durable backups under `C:\Users\ritud\.tori-release-backups\gate32_3_pre_pub_20261122\` (online SQLite backup, 5 registry exports, Native Messaging JSONs, OEM DB/binary snapshots, GitHub `v1.0.6` / `latest.json` / `extension-v1.0.10` / `tools-ffmpeg-N-129150-g7ddf7bc8a4` metadata, and previous Cloudflare deployment anchor `e77ad5d1-27a4-4b6a-8d1e-97f9cb9c660d`).
2. **Manifest-First Production Promotion (Phases 4–5):** Deployed the exact Gate 32.2 signed production tools manifest (`rev 1`, `9fa61a38...`) and `.sig` (`e0e23db7...`) first (`tori-website-private` commit `81585e42c9561725f59c80d2f673116d3f7a0c1f`, Cloudflare deployment `8de71e1a-731e-4872-b8e6-046a375476b6`), verified live HTTPS 200 bit-for-bit, and passed **7/7 live production manifest acceptance tests** (`--phase5-prod-manifest`: real 205 MiB HTTPS `FFmpeg`/`FFprobe` download, SHA-256/PE/parity/health self-test, atomic activation, full H.264/AAC/MP4/MKV/HLS/FFprobe pipeline, atomic rollback, post-rollback media verification, live reapply, and SQLite history persistence) using the compiled production default URL (zero staging overrides) BEFORE publishing Desktop `v1.0.7`.
3. **Two-Phase GitHub Publication (Phases 6–8):** Pushed annotated tag `v1.0.7` (`84da0c08256d6abaca253b5612010034237c86f9`), created draft release `454278227`, uploaded all **16 frozen Desktop-only assets**, downloaded and verified critical draft assets bit-for-bit against Gate 32.2 frozen SHA-256 digests, and promoted `v1.0.7` to repository-wide **Latest Stable** (`latest.json` live with `version: 1.0.7` and valid Ed25519 signature).
4. **Website Deployment & Complete Live Post-Release Verification (Phases 9–17):** Updated Desktop-only references on `toridownload.xyz` (`6dd3ffd7509672f31943e1f46f2ad5f3f54c8f95`, Cloudflare deployment `c7c8f6b1-cb8a-451d-8855-ea40cbb7c087`), verified **14/14 PASS** in `scripts/verify_gate32_3_public_release.js --post-release` (including physical isolated `v1.0.6 → live-downloaded public v1.0.7` upgrade, Close-to-Tray, standalone IDM Progress Window, production tools manifest + live OpenPGP `yt-dlp` update/rollback, Native Messaging stdio + permanent Mozilla-signed Firefox Companion `v1.0.10` live MKV capture, warm restart, Desktop/Mobile website layout, and 100% OEM preservation) plus full post-release regressions (`updater_cryptography_tests` `8/8`, `external_tools_updater_tests` `11/11`, Gate 29.1 `20/20`, Gate 29.2 `17/17`, Gate 29.4 `18/18`, Gate 31.4 `15/15`, Gate 31.5 `23/23`).

---

## 2. Authorization and Accepted Limitations

- **Explicit Owner Authorization:** Project owner explicitly authorized promoting the production FFmpeg/FFprobe signed tools manifest, publishing TORI Desktop `v1.0.7` as GitHub Latest Stable, activating Tauri Desktop `v1.0.7` auto-updater (`latest.json`), updating `toridownload.xyz` Desktop download/version references, and executing live post-release verification.
- **Owner-Accepted Environment Limitations (Explicitly Preserved, Never Misrepresented):**
  1. **Windows Authenticode PE Code Signing:** **`NotSigned`** (no commercial OV/EV Authenticode certificate provisioned; manual downloads may display a SmartScreen prompt; in-app Tauri updater and External Tools manifest independently enforce Ed25519 cryptography with key ID `CDC23D8CC8DA5397`).
  2. **Independent Clean Windows VM Verification:** **`NOT TESTED`** (all physical install/upgrade tests executed in strictly isolated same-host environments using `TORI_DATA_DIR`, `TORI_IPC_PIPE`, `WEBVIEW2_USER_DATA_FOLDER`, isolated install directories, and `QaOemStateGuard`).

---

## 3. Pre-Publication Baseline

| Baseline Dimension | Verified Pre-Publication Value |
| :--- | :--- |
| Main Repo Branch / Commit | `release/v1.0.7-rc` @ `84da0c08256d6abaca253b5612010034237c86f9` |
| Gate 32.2 Checkpoint Tag | `checkpoint-gate32_2-verified` -> `84da0c08256d6abaca253b5612010034237c86f9` |
| Gate 32.3 Pre-Pub Safety Tag | `checkpoint-gate32_3-before-publication` -> `84da0c08256d6abaca253b5612010034237c86f9` |
| Previous Public Desktop Release | `v1.0.6` (GitHub Release ID `453599579`, 14 assets, live `latest.json` = `1.0.6`) |
| Browser Companion Release | `extension-v1.0.10` (GitHub Release ID `451270856`, unchanged) |
| FFmpeg Tools Prerelease | `tools-ffmpeg-N-129150-g7ddf7bc8a4` (GitHub Release ID `453686141`, `prerelease=true`) |
| Previous Website Commit / CF Deploy | `8cd035f1df0e6bd486db001340c001e1fa42ce4e` / `e77ad5d1-27a4-4b6a-8d1e-97f9cb9c660d` |
| Production Tools Manifest Before | Absent (SPA HTML fallback `text/html`, `isJson=false`, zero higher revision) |
| Out-of-Tree Rollback Backup | `C:\Users\ritud\.tori-release-backups\gate32_3_pre_pub_20261122\` (verified online SQLite backup `integrity=[('ok',)]`, `42` rows, 5 registry exports, NM JSONs, GitHub/CF snapshots) |
| Gate 32.2 Verified Matrix | 12/12 suites, `433 PASS, 0 FAIL, 0 TIMEOUT, 0 SKIPPED` (Rust workspace `271/271`, Clippy `0` errors, UI lint/build `0` errors) |

---

## 4. Frozen Artifact Verification

Zero rebuilds or binary modifications occurred. Every frozen Gate 32.2 artifact in `release/v1.0.7-rc/` matched `SHA256SUMS.txt` bit-for-bit prior to staging (`scripts/publish_desktop_v1_0_7_release.js` exit `0`) and passed `cargo test --workspace --test updater_cryptography_tests` (`8 passed, 0 failed`, verifying Ed25519 signature, tampered payload rejection, corrupted signature rejection, and production manifest validation):

| Frozen RC Artifact | Size (Bytes) | Verified SHA-256 |
| :--- | ---: | :--- |
| `TORI Download Manager_1.0.7_x64-setup.exe` | `118,097,450` | `142e4528410a70c43cf7166acda87d8b27e293348237113b2350a025467966cb` |
| `TORI Download Manager_1.0.7_x64-setup.exe.sig` | `436` | `945b5efdcc69edf85373c54cfdb603d50976f5ba6be75bef5e130ca5350224e8` |
| `tori-download-manager.exe` | `32,038,912` | `7707261181fdded28aa99e19ab8334f6f9942943338d3bf25b055889f2b9389c` |
| `tdm-native-host.exe` | `19,364,864` | `2a88db0c749dac21cf69fce1580e674cef7d4478d6b98728858277141db60c41` |
| `tdm-cli.exe` | `17,018,368` | `f3a7f78f7d1de67ff3cdfc141387bdafc0380b4a0048bd19f07cfc92f17b7ee4` |

---

## 5. Production Manifest Promotion (Manifest-First)

Promoted cleanly BEFORE Desktop `v1.0.7` GitHub publication while keeping existing Desktop `v1.0.6` links and Browser Companion `v1.0.10` unchanged:

- **Website Commit (Manifest-First):** `81585e42c9561725f59c80d2f673116d3f7a0c1f` (`assets/tools/tools-manifest.json` + `assets/tools/tools-manifest.json.sig` only)
- **Cloudflare Pages Deployment ID:** `8de71e1a-731e-4872-b8e6-046a375476b6` (`status: completed`, `conclusion: success`, `completed_at: 2026-11-22T06:53:26Z`)
- **Live Production URLs:**
  - `https://toridownload.xyz/assets/tools/tools-manifest.json` -> HTTP `200`, `Content-Type: application/json`, `Cache-Control: public, max-age=0, must-revalidate`, `1,380` bytes, exact SHA-256 `9fa61a38bb77bb8cdf05364565db2cf3b2b3ab8d0c7af98dfd7c50b2ee287662`
  - `https://toridownload.xyz/assets/tools/tools-manifest.json.sig` -> HTTP `200`, `Content-Type: application/pgp-signature`, `408` bytes, exact SHA-256 `e0e23db79990f885c0745165299b20befd41f5dc8a73f7b00ca0476502955eb4`
- **Manifest Metadata:** `schema_version: 2`, `manifest_revision: 1`, `published_at: 2026-11-21T16:00:29.945Z`, `expires_at: 2027-01-05T16:00:29.945Z` (45-day window), `signing_key_id: CDC23D8CC8DA5397`, `min_tori_version: "1.0.6"`, `platform: "windows"`, `architecture: "x86_64"`.

---

## 6. Manifest Signature Verification

- Verified locally via Rust `updater_cryptography_tests` (`8/8 PASS`) over exact raw manifest bytes against embedded production Ed25519 key `CDC23D8CC8DA5397`.
- Verified live over HTTPS from `https://toridownload.xyz/assets/tools/tools-manifest.json` + `.sig` by isolated Desktop `v1.0.7` with **zero manifest URL or key overrides**:
  - Phase 5 (`P5-02`): `checkMs=5906`, `rev=1`, `last_accepted_manifest_sha256=9fa61a38bb77bb8cdf05364565db2cf3b2b3ab8d0c7af98dfd7c50b2ee287662`, `last_signing_key_id=CDC23D8CC8DA5397`.
  - Post-release (`G323-05` & `G323-11`): HTTP `200`, exact SHA-256 parity and Ed25519 verification on live-downloaded public `v1.0.7`.

---

## 7. FFmpeg Artifact Hosting and Provenance

- **GitHub Prerelease Tag:** `tools-ffmpeg-N-129150-g7ddf7bc8a4` (GitHub Release ID `453686141`, `prerelease: true`, `draft: false`, NOT repository Latest Stable).
- **Immutable Public Artifact URL:**  
  `https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/tools-ffmpeg-N-129150-g7ddf7bc8a4/ffmpeg-N-129150-g7ddf7bc8a4-win64-gpl.zip`
- **Verified Size & SHA-256:** `205,445,856` bytes | `03d33066832e7149a8577bed73713c5d5344aed14199063e521b798cf1b60076`.
- **Redirect Trust Audit:** `HEAD` -> HTTP `302` -> trusted `release-assets.githubusercontent.com` -> HTTP `200`, exact `Content-Length: 205445856`.
- **Upstream Provenance:** Reviewed unmodified mirror of `BtbN/FFmpeg-Builds` immutable dated release `autobuild-2026-11-20-12-40` (`N-129150-g7ddf7bc8a4-20261120` static Windows x64 GPL build containing matching `ffmpeg.exe` and `ffprobe.exe`).

---

## 8. GitHub Release Publication (Two-Phase)

Executed via `node scripts/publish_desktop_v1_0_7_release.js --publish` (exit `0`, zero Browser Companion packages):
- **Phase A (Draft):** Created draft release ID **`454278227`** bound to annotated tag `v1.0.7` (`84da0c08256d6abaca253b5612010034237c86f9`), uploaded all **16** Desktop-only assets, verified exact remote sizes, and downloaded critical draft assets (`TORI.Download.Manager_1.0.7_x64-setup.exe`, `.sig`, `latest.json`, `SHA256SUMS.txt`, `tori-download-manager.exe`, `tdm-native-host.exe`) confirming bit-for-bit SHA-256 parity BEFORE promotion.
- **Phase B (Promote):** Published release `454278227` as public non-draft, non-prerelease, repository-wide **Latest Stable** (`published_at: 2026-11-22T07:54:22Z`).

### Complete Published Asset Inventory (16 Desktop-Only Assets)

| # | Asset Name | Asset ID | Size (Bytes) | Verified SHA-256 |
|---:|---|---:|---:|---|
| 1 | `TORI.Download.Manager_1.0.7_x64-setup.exe` | `778275757` | `118,097,450` | `142e4528410a70c43cf7166acda87d8b27e293348237113b2350a025467966cb` |
| 2 | `TORI.Download.Manager_1.0.7_x64-setup.exe.sig` | `778296809` | `436` | `945b5efdcc69edf85373c54cfdb603d50976f5ba6be75bef5e130ca5350224e8` |
| 3 | `tori-download-manager.exe` | `778296858` | `32,038,912` | `7707261181fdded28aa99e19ab8334f6f9942943338d3bf25b055889f2b9389c` |
| 4 | `tdm-native-host.exe` | `778302022` | `19,364,864` | `2a88db0c749dac21cf69fce1580e674cef7d4478d6b98728858277141db60c41` |
| 5 | `tdm-cli.exe` | `778304723` | `17,018,368` | `f3a7f78f7d1de67ff3cdfc141387bdafc0380b4a0048bd19f07cfc92f17b7ee4` |
| 6 | `latest.json` | `778307318` | `2,128` | `45b89af208f792e674419de1438c5a0c3fb8b8972edd1e455f6f30753e0f3c16` |
| 7 | `SHA256SUMS.txt` | `778307369` | `1,319` | `482f8d58d3e426df52476213fae8647d77703b14ef0930ee86de4dcb955a3b07` |
| 8 | `BUILD_METADATA.json` | `778307397` | `1,649` | `20eceb44b125262ce95afc2023e781621700e8b0baf570bfc0d13b88ec8725f4` |
| 9 | `RELEASE_MANIFEST.json` | `778307432` | `2,733` | `e89e33a73cd3ab6eb908f6d66fd9220eb0172b8487827c65b97e91f62b42423e` |
| 10 | `RELEASE_NOTES_v1.0.7.md` | `778307453` | `4,609` | `fdd0e3caf9f0e9261903735663d3a498b626316be634165bbc1479e289314422` |
| 11 | `INSTALLATION_AND_UPGRADE.md` | `778307486` | `2,581` | `f432eebbd58ef7e57362d1d93b46eb9564f72e8a63c473ef794bb0f358fb8e25` |
| 12 | `LICENSE` | `778307533` | `1,465` | `55460ef099ce57e32d422427a7a24cd1e09aec677606289e396c2c17d625a598` |
| 13 | `LICENSE-MIT` | `778307552` | `1,092` | `dffcef788fe594963f082966daa3b969c7c4f633e612d8f88ee8a3033c4a5144` |
| 14 | `LICENSE-APACHE` | `778307598` | `9,899` | `20fe7b00e904ed690e3b9fd6073784d3fc428141dbd10b81c01fd143d0797f58` |
| 15 | `LICENSE-GPLv3.txt` | `778307639` | `35,147` | `8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903` |
| 16 | `LICENSE-THIRD-PARTY.txt` | `778307675` | `4,421` | `4f05486cb940a151e9b010ff3d033b7fb06370c665d174eb5d54d48433eb6035` |

---

## 9. GitHub Latest Stable Status

Verified live (`G323-01` & `G323-02` PASS):
- `GET /repos/robijoychakma375-hash/tori-download-manager/releases/latest` returns **`v1.0.7`** (`id=454278227`, `draft: false`, `prerelease: false`, `assets: 16`, remote tag `refs/tags/v1.0.7^{}` == `84da0c08256d6abaca253b5612010034237c86f9`).
- Preserved untouched: `v1.0.6` (`453599579`), `v1.0.5` (`449053824`), `extension-v1.0.10` (`451270856`), `tools-ffmpeg-N-129150-g7ddf7bc8a4` (`453686141`).

---

## 10. Desktop Auto-Updater Activation

Verified live (`G323-04` PASS):
- **Endpoint:** `https://github.com/robijoychakma375-hash/tori-download-manager/releases/latest/download/latest.json`
- **Live Response:** HTTP `200 OK`, `"version": "1.0.7"`, `"pub_date": "2026-11-22T07:31:00.467Z"`, both `windows-x86_64` and `windows-x86_64-nsis` point to `https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.7/TORI.Download.Manager_1.0.7_x64-setup.exe` with exact matching Ed25519 signature (`945b5efd...`).
- **Upgrade Matrix:** SemVer validated (`1.0.5 → 1.0.7`, `1.0.6 → 1.0.7`, `1.0.7` up-to-date, `>1.0.7` no downgrade); **physical isolated `v1.0.6 → live-downloaded public v1.0.7`** verified in `G323-09`..`G323-13` (separate from SemVer manifest-only checks for `1.0.5 → 1.0.7`).

---

## 11. Website Changes

Desktop-only edits in `C:\Users\ritud\Downloads\tori-website` (`robijoychakma375-hash/tori-website-private`, branch `main`):
- **Commit 1 (`81585e42c9561725f59c80d2f673116d3f7a0c1f`):** Added `assets/tools/tools-manifest.json` and `assets/tools/tools-manifest.json.sig` (manifest-first promotion).
- **Commit 2 (`6dd3ffd7509672f31943e1f46f2ad5f3f54c8f95`):** Modified ONLY `index.html` and `sitemap.xml` (`lastmod: 2026-11-22`):
  - Updated JSON-LD, Hero pill/button, `#get`, `#download` stats (`1.0.7`, `112.6 MB`, `Nov 22, 2026`), What's New (`v1.0.7` External Tools Auto-Update Manager), `#files` Desktop installer & `SHA256SUMS.txt` links + `142e4528...` PowerShell checksum, footer badge (`v1.0.7 · Windows 10 / 11 (64-bit) · Companion v1.0.10`), JS `CACHE_KEY` (`tori_release_cache_v4`), and `FALLBACK_RELEASE` (`v1.0.7`, archiving `v1.0.6`).
  - Browser Companion `v1.0.10` assets, links, labels, and checksums completely untouched.

---

## 12. Cloudflare Deployment

- **Manifest-First Deployment:** ID `8de71e1a-731e-4872-b8e6-046a375476b6` (`conclusion: success`, `2026-11-22T06:53:26Z`).
- **Final Website Deployment:** ID **`c7c8f6b1-cb8a-451d-8855-ea40cbb7c087`** (`status: completed`, `conclusion: success`, `completed_at: 2026-11-22T07:57:19Z`, commit `6dd3ffd7509672f31943e1f46f2ad5f3f54c8f95`).
- **Live Edge Verification (`G323-07` & `G323-08` PASS):**
  - HTTPS `200` on `/`, `/sitemap.xml` (`2026-11-22`), `/robots.txt`, `/assets/tools/tools-manifest.json`, `/assets/tools/tools-manifest.json.sig`, and `/assets/tori-download-manager-firefox-v1.0.10.xpi` (`application/x-xpinstall`).
  - Headless Edge CDP audit across Desktop (`1440×900`) and Mobile (`390×844`) for `#top`, `#download`, and `#extension`: `layoutsOk: true`, `linksOk: true`, `overflowX: false`, `brokenImgs: 0`, `statVer: "1.0.7"`, `heroPill: "New · v1.0.7 for Windows (Stable)"`, `footerVer: "v1.0.7 · Windows 10 / 11 (64-bit) · Companion v1.0.10"`.

---

## 13. Real Public Installer Verification

Downloaded directly over public HTTPS from `https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.7/TORI.Download.Manager_1.0.7_x64-setup.exe` and `.sig` (`G323-03` PASS):
- Exact size `118,097,450` B | SHA-256 `142e4528410a70c43cf7166acda87d8b27e293348237113b2350a025467966cb`
- Exact `.sig` size `436` B | SHA-256 `945b5efdcc69edf85373c54cfdb603d50976f5ba6be75bef5e130ca5350224e8`
- Installed binary PE `ProductVersion = 1.0.7`, `tdm-native-host.exe` SHA-256 `2a88db0c749dac21cf69fce1580e674cef7d4478d6b98728858277141db60c41`, bundled `yt-dlp` (`2026.08.19`), `ffmpeg` (`N-126374`), and `ffprobe` (`N-126374`) verified.

---

## 14. Physical `v1.0.6 → v1.0.7` Upgrade

Executed in strict isolation using the **actual publicly downloaded `v1.0.7` GitHub installer** over a baseline `v1.0.6` install seeded from the operator's 42-row online SQLite backup + sample `.tdm-part` (`G323-09`, `G323-10`, `G323-13` PASS):
- PE version transitioned `1.0.6 → 1.0.7`; zero `SECONDARY_INSTANCE`; `get_app_version === "1.0.7"`.
- SQLite additive migration preserved all `42` download rows, `dark`/`rose` settings, and `.tdm-part` SHA-256 (`partUnchanged: true`).
- Close-to-Tray (`hiddenOk: true`), standalone IDM Progress Window (`isIdm: true, legacyToast: false`), Pause/Resume (`stPaused: "paused"`), exact SHA-256 download completion, and warm restart (`813 ms`, `44` downloads, `2` tool history entries) all passed.

---

## 15. Browser Companion `v1.0.10` Preservation

Verified live (`G323-06` & `G323-12` PASS):
- GitHub `extension-v1.0.10` (`id=451270856`) untouched.
- Live GitHub & `toridownload.xyz` Firefox XPI SHA-256: **`a93a43872d224426902c49e217e31b2c603263d8c260c429940539b34b2852b8`** (`107,499` B, `Content-Type: application/x-xpinstall`).
- Live GitHub Chromium ZIP SHA-256: **`f220fab2e26fd54ef7f85fd7e40613faad79e7f9a7f44fadf228ccd0edcc22f1`** (`90,964` B, MV3, `content.js` `119,494` B).
- Live permanent Firefox XPI install under strict signature enforcement (`xpinstall.signatures.required=true`): `id=tori-download-manager@toridm.org`, `version=1.0.10`, `signed=true`, `temporary=false`.

---

## 16. `yt-dlp` Updater Verification

- Verified live on publicly downloaded `v1.0.7` (`G323-11` PASS) and Gate 32 (`G32-04/06/08/09/10/11/13` PASS): OpenPGP RSA-4096 (`AC0CBBE6848D6A873464AF4E57CF65933B5A7581`) + SHA-256 upgrade `2026.08.19 → 2026.10.26`, live YouTube video/merge/playlist extraction, and manual rollback back to `2026.08.19`.

---

## 17. `FFmpeg` / `FFprobe` Updater Verification

- Verified live against **production** `https://toridownload.xyz/assets/tools/tools-manifest.json` (zero overrides!) in Phase 5 (`P5-02`..`P5-06` PASS, `302.6 s` real 205 MiB HTTPS download, Ed25519 + SHA-256 + PE32+ x64 + version parity + H.264/AAC/MP4/MKV/HLS/FFprobe pipeline, atomic rollback & reapply) and post-release `G323-11` PASS.
- Direct unsigned upstream `BtbN/FFmpeg-Builds` strictly blocked as `source_untrusted` when no signed manifest is configured (`external_tools_updater_tests::test_02_untrusted_upstream_ffmpeg_blocked_honestly` PASS).

---

## 18. Active Download Protection

- Verified across `external_tools_updater_tests::test_20_to_23_active_usage_deferral_and_concurrency_guards` (post-release `11/11 PASS`) and frozen-RC Gate 32.2 `G322-11` (concurrent HTTP + YouTube transfers complete intact during `yt-dlp` update & rollback; RAII leases held across all `yt-dlp`, `ffmpeg`, and `ffprobe` execution sites including hardened `extractor.rs`).

---

## 19. Automatic Rollback and Fallback

- Manual atomic paired `FFmpeg`+`FFprobe` rollback verified live on production manifest (`P5-05` PASS -> bundled `N-126374` + media verification) and clean reapply (`P5-06` PASS).
- Manual `yt-dlp` rollback verified live on publicly downloaded `v1.0.7` (`G323-11` PASS).
- Automatic post-activation failure rollback, version quarantine, bundled fallback, and higher-revision emergency signed rollback (`allow_rollback_to: true`) verified in post-release `external_tools_updater_tests` (`11/11 PASS`).

---

## 20. IDM Progress-Window Verification

- Verified live on publicly downloaded `v1.0.7` (`G323-10` PASS: `isIdm: true, legacyToast: false, label: "progress_..."`), Gate 29.2 (`17/17 PASS`), Gate 31.4 (`15/15 PASS` on `v1.0.7`), and Gate 31.5 (`23/23 PASS`). Legacy dark floating download toast remains absent across all pathways.

---

## 21. User Data Preservation

Verified with `QaOemStateGuard` + WAL-safe logical SQLite & `.tdm-part` snapshots across every QA phase (`P5-07` PASS, `G323-14` PASS, `G294-SAFETY-DB` PASS, final audit):
- Installed production `%LOCALAPPDATA%\TORI Download Manager\tori-download-manager.exe`: untouched `v1.0.6` (exact SHA-256 `570833b379668f64d8f0a81e0a2c138635835e0c0382f37f24ec969caccf0fda`).
- Production `%APPDATA%\tori-download-manager\tdm_storage.sqlite`: `PRAGMA integrity_check = ok`, `42` downloads (`downloadsHash: 8c54fcee...`), `355` chunks (`chunksHash: 79a5094e...`), `5` protected settings (`protectedSettingsHash: 3345a44d...`), `11` `.tdm-part` files (`partFilesHash: e701b86a...`).
- Windows Registry (`HKCU\Software\tori\TORI Download Manager`, `Uninstall`, Chrome/Edge/Firefox `NativeMessagingHosts`) & shortcuts restored with 100% parity (`regOk: true`).

---

## 22. Native Messaging Verification

- Public `v1.0.7` `tdm-native-host.exe` stdio ping (`pong`, exit `0`) and live **Mozilla-signed Firefox Companion `v1.0.10`** end-to-end Native Messaging MKV capture (`newJobs=1, shaOk=true`, zero duplicates) verified in `G323-12` PASS.
- Chrome Companion `v1.0.10` live capture verified in post-release Gate 31.5 `S12A-COMPANION-CHROME` PASS; Firefox `PlaylistModal` + MKV verified in post-release Gate 29.4 `G294-FF-MKV` / `G294-FF-PLAYLIST` PASS.

---

## 23. Full Regression Test Matrix

| Suite / Command | Timing | Exit Code | Result | Details |
|---|---|---:|---|---|
| `node scripts/verify_gate32_3_public_release.js --phase5-prod-manifest` | Gate 32.3 Phase 5 (live prod manifest) | `0` | **PASS (7/7)** | Real 205 MiB production manifest FFmpeg/FFprobe update, media matrix, rollback, reapply, OEM parity |
| `node scripts/verify_gate32_3_public_release.js --post-release` | Gate 32.3 Post-Release (live public v1.0.7) | `0` | **PASS (14/14)** | Live GitHub v1.0.7, public installer SHA-256, `latest.json`, prod manifest, Companion v1.0.10, live site Desktop/Mobile, physical `v1.0.6 → v1.0.7` upgrade, IDM window, Native Messaging + Firefox MKV capture, warm restart, OEM parity |
| `cargo test --workspace --test updater_cryptography_tests` | Post-Release | `0` | **PASS (8/8)** | Ed25519 signature, tamper rejection, `v1.0.7` RC + prod manifest |
| `cargo test --workspace --test external_tools_updater_tests -j 2` | Post-Release | `0` | **PASS (11/11)** | Unsigned upstream FFmpeg block (`test_02`), anti-replay, expiry, rollback, quarantine, deferral, fallback |
| `node scripts/verify_gate29_1_idm_desktop_ui.js` | Post-Release | `0` | **PASS (20/20)** | `Version 1.0.7`, 1,200-row virtualized table, Dark/Ocean persistence |
| `node scripts/verify_gate29_2_idm_progress_window.js` | Post-Release | `0` | **PASS (17/17)** | Standalone IDM Progress Window, `<= 1 Hz` throttle, Compact, Limiter, Completion options |
| `node scripts/verify_gate29_4_final_integration.js` | Post-Release | `0` | **PASS (18/18)** | Clean `v1.0.7` NSIS install, DB migration, crash recovery, concurrency, YouTube 360p–1080p, Firefox MKV/Playlist, `6×16 MiB` load |
| `node scripts/verify_gate31_4_toast_replacement.js` | Post-Release | `0` | **PASS (15/15)** | Packaged `v1.0.7` IDM progress window (no legacy toast) across HTTP/MKV/YouTube/Queue/Tray |
| `node scripts/verify_gate31_5_install_repair_and_preflight.js` | Post-Release | `0` | **PASS (23/23)** | OEM `v1.0.6`, single-instance, Companion `v1.0.10` Chrome/Firefox, NSIS respawn kill, stale QA guard |
| `node scripts/verify_gate32_external_tools_updater.js` | Post-Release | `1`* | **17/18 (Expected Prod-Manifest Delta)** | *`G32-05` expected pre-promotion `source_untrusted`; now observes `update_available (N-129150-g7ddf7bc8a4-20261120)` because production signed manifest is live by default! Direct unsigned upstream block independently verified PASS in `external_tools_updater_tests::test_02`. Zero functional/security regression.* |
| Frozen RC `cargo test --workspace -j 2 --no-fail-fast` | Gate 32.2 (`84da0c08`, unchanged Rust/UI code) | `0` | **PASS (271/271)** | Preserved frozen-RC evidence (zero source edits since `84da0c08`) |
| Frozen RC `cargo clippy --workspace --all-targets` & `npm --prefix ui run lint && build` | Gate 32.2 (`84da0c08`) | `0` | **PASS (0 errors)** | Preserved frozen-RC evidence |
| Frozen RC Gate 32.1 (`19/19`) & Gate 32.2 (`19/19`) | Gate 32.2 (`84da0c08`) | `0` | **PASS (38/38)** | Preserved frozen-RC evidence (`G322-04` verified pre-pub `latest.json == 1.0.6`) |
| Independent Clean Windows VM Install Test | N/A | N/A | **NOT TESTED** | Owner-accepted documented limitation |

---

## 24. Known Limitations

Explicitly documented and unchanged from owner sign-off:
1. **Windows Authenticode PE Code Signing:** `NotSigned` (SmartScreen warning possible on manual downloads until commercial OV/EV certificate is configured).
2. **Independent Clean Windows VM Verification:** `NOT TESTED` (verified via isolated same-host installs/upgrades).
3. **Paid DRM-Protected Media:** Intentionally unsupported.
4. **Upstream `BtbN/FFmpeg-Builds` Detached Signatures:** None published upstream; trust rests on TORI maintainer provenance review, immutable GitHub mirror SHA-256, and TORI Ed25519 manifest signature (`CDC23D8CC8DA5397`).
5. **Shared Production Ed25519 Key (`CDC23D8CC8DA5397`):** Currently shared between Desktop Auto-Updater and External Tools Manifest (runtime config already supports future dedicated `tori-tools.key` rotation).

---

## 25. Security Considerations

- Zero private keys, passphrases, or GitHub tokens committed, logged, or exposed.
- Exact-bytes Ed25519 verification precedes JSON parsing on both Desktop updater and External Tools manifest.
- Anti-replay monotonic `manifest_revision` persisted in SQLite; duplicate JSON keys rejected; expiry enforced; HTTPS-only host allowlist with cross-origin redirect header stripping enforced; Zip-Slip/symlink/zip-bomb checks active; direct unsigned upstream FFmpeg builds strictly blocked when no signed manifest is present.

---

## 26. Incident or Recovery Actions

- **No public rollback required (`NOT TRIGGERED`).**
- **Transient Upload Retry Handled Cleanly:** During GitHub draft upload of the `118 MB` installer, `curl.exe` encountered 2 transient TCP resets (`curlExit=55`) and succeeded cleanly on attempt 3/6 (`HTTP 201`, Asset ID `778275757`), subsequently verified bit-for-bit by draft re-download SHA-256 check prior to promotion.
- **Test Harness Refinements (Zero Binary/Source Changes):** Fixed IPC field names/command typos in new Gate 32.3 test harness (`scripts/verify_gate32_3_public_release.js`) and wired isolated Firefox Native Messaging wrapper for `G323-12`; subsequent runs passed `7/7` (Phase 5) and `14/14` (Post-Release).
- **Verified Rollback Anchors Preserved:**
  - Out-of-tree backup: `C:\Users\ritud\.tori-release-backups\gate32_3_pre_pub_20261122\`
  - GitHub Release `v1.0.6` (ID `453599579`) and `v1.0.5` (ID `449053824`) intact
  - Previous Cloudflare deployments `e77ad5d1-27a4-4b6a-8d1e-97f9cb9c660d` (`8cd035f`) and `8de71e1a-731e-4872-b8e6-046a375476b6` (`81585e4`) intact
  - Higher-revision signed tools manifest emergency rollback (`manifest_revision: 2`, `allow_rollback_to: true`) ready via `scripts/publish_trusted_tools_manifest.js --rollback-manifest`.

---

## 27. Git Commit and Tag Evidence

| Repository | Ref / Tag | Exact Commit SHA | Status |
|---|---|---|---|
| `robijoychakma375-hash/tori-download-manager` | `v1.0.7` / `release/v1.0.7` / `checkpoint-gate32_2-verified` / `checkpoint-gate32_3-before-publication` | `84da0c08256d6abaca253b5612010034237c86f9` | Pushed to `origin` |
| `robijoychakma375-hash/tori-download-manager` | `release/v1.0.7-rc` & `checkpoint-gate32_3-released` | Recorded in Phase 20 final commit & output | Pushed to `origin` |
| `robijoychakma375-hash/tori-website-private` | `main` (Manifest-First) | `81585e42c9561725f59c80d2f673116d3f7a0c1f` | Deployed (`8de71e1a-731e-4872-b8e6-046a375476b6`) |
| `robijoychakma375-hash/tori-website-private` | `main` (Desktop `v1.0.7` Website) | `6dd3ffd7509672f31943e1f46f2ad5f3f54c8f95` | Deployed (`c7c8f6b1-cb8a-451d-8855-ea40cbb7c087`) |

---

## 28. Final Public URLs

- **GitHub Release `v1.0.7` (Latest Stable):** https://github.com/robijoychakma375-hash/tori-download-manager/releases/tag/v1.0.7
- **GitHub Latest Redirect:** https://github.com/robijoychakma375-hash/tori-download-manager/releases/latest
- **Public Installer:** https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.7/TORI.Download.Manager_1.0.7_x64-setup.exe
- **Public Installer Signature:** https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.7/TORI.Download.Manager_1.0.7_x64-setup.exe.sig
- **Live Desktop Auto-Updater Endpoint:** https://github.com/robijoychakma375-hash/tori-download-manager/releases/latest/download/latest.json
- **Production External Tools Manifest:** https://toridownload.xyz/assets/tools/tools-manifest.json
- **Production External Tools Signature:** https://toridownload.xyz/assets/tools/tools-manifest.json.sig
- **Immutable Production FFmpeg Archive:** https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/tools-ffmpeg-N-129150-g7ddf7bc8a4/ffmpeg-N-129150-g7ddf7bc8a4-win64-gpl.zip
- **Official Website:** https://toridownload.xyz
- **Browser Companion `v1.0.10` (Unchanged):** https://github.com/robijoychakma375-hash/tori-download-manager/releases/tag/extension-v1.0.10 & https://toridownload.xyz/assets/tori-download-manager-firefox-v1.0.10.xpi

---

## 29. Final Verdict: GO (PUBLISHED & LIVE VERIFIED)

**Verdict:** **`GO — PUBLIC STABLE RELEASE COMPLETED AND LIVE VERIFIED`** (subject to the two owner-accepted documented limitations: Windows Authenticode `NotSigned` and independent clean Windows VM `NOT TESTED`). All 14 public release criteria in Phase 17 are verified live over HTTPS against actual production endpoints and downloaded bytes.

---

## 30. Next Recommended Engineering Gate

1. **Dedicated Tools Signing Key Separation & Rotation Plan (Gate 33):** Rotate External Tools Manifest signing onto a dedicated out-of-repo `tori-tools.key` (separate from Desktop Updater key `CDC23D8CC8DA5397`) with dual-key transition support and automated manifest expiry alerting (before `2027-01-05`).
2. **Commercial Windows Authenticode Code Signing:** Provision an OV/EV Authenticode certificate in the Windows NSIS release pipeline to eliminate Windows Defender SmartScreen prompts.
3. **Clean Windows 10/11 VM Automated Release Verification:** Add an isolated clean Windows VM job to pre-release QA.
4. **Upgrade Operator Workstation (`v1.0.6 → v1.0.7`) via Live Auto-Updater:** Operator may now safely test/accept the live in-app Tauri `v1.0.6 → v1.0.7` update on their production workstation when ready.
