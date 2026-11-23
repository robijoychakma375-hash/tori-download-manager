# TORI Download Manager — Gate 34.2 Public Stable Release Report (Desktop v1.0.8)

**Report ID:** `TORI-RPT-GATE34_2-2026-11-23`  
**Release:** TORI Download Manager Desktop **`v1.0.8`** (Public Stable — Stage 1 Dual-Key Trust Rollout)  
**Final Gate 34.2 Status:** **`FULL GO — DESKTOP v1.0.8 PUBLIC STABLE RELEASED & VERIFIED (WITH 3 OWNER-ACCEPTED STAGE 1 LIMITATIONS)`**  
**Publication Timestamp (UTC):** `2026-11-23T08:25:29Z`  
**Verification Completed (UTC):** `2026-11-23T09:44:10Z`  
**Primary Repository:** `https://github.com/robijoychakma375-hash/tori-download-manager`  
**Official Website:** `https://toridownload.xyz` (`robijoychakma375-hash/tori-website-private`)  

---

## 1. Executive Summary

TORI Download Manager Desktop **`v1.0.8`** has been published as the official repository-wide **Latest Stable** Windows release under explicit project-owner authorization, promoting the verified frozen Gate 33.3 Final Release Candidate without rebuilding installer binaries, regenerating keys, mutating Browser Companion `v1.0.10`, or activating dedicated-only External Tools signing.

Key completed outcomes:

- **GitHub Public Stable Release:** Published Release ID **`455125259`** at tag **`v1.0.8`** pointing directly to verified application build source commit **`1a24265d247a43371ab2b637e195425df2c78b82`**, with **16/16** Desktop-only assets verified bit-for-bit against frozen SHA-256 digests.
- **Desktop Auto-Updater Live Activation:** `https://github.com/robijoychakma375-hash/tori-download-manager/releases/latest/download/latest.json` resolves over live HTTPS to version **`1.0.8`** (`pub_date: 2026-11-23T07:55:00.033Z`) with a valid Tauri Ed25519 signature (`CDC23D8CC8DA5397`) and zero draft markers.
- **Official Website Promotion:** `https://toridownload.xyz` updated in commit **`181b3fb7c4d2abb9889d7d988b223fe63e02506f`** and deployed to Cloudflare Pages Deployment **`113c58b9-82c9-42ec-a096-7bc9b62c5b9e`** (`tori-download-manager`), promoting Desktop `v1.0.8` while preserving historical `v1.0.7`, Browser Companion `v1.0.10`, and production External Tools manifest `rev 2`.
- **Real End-to-End Live Verification:** Passed **14/14** live public checks (`scripts/verify_gate34_2_public_release.js`), including a real isolated Desktop `v1.0.7` Tauri `plugin:updater|check` + `plugin:updater|download` (118,110,372 bytes + Rust Ed25519 verification) and in-place upgrade to `v1.0.8`, live production tools manifest `rev 2` verification, live `yt-dlp` OpenPGP & `FFmpeg`/`FFprobe` 205 MiB updates/rollbacks/bundled fallback, Chrome/Edge/Firefox Native Messaging + live Mozilla-signed Firefox Companion `v1.0.10` capture, **10/10** Rust updater cryptography tests, **5/5** External Tools security matrix suites, **18/18** expiry monitor regression checks, and **100%** OEM workstation & user-data preservation.

---

## 2. Owner Authorization

The project owner explicitly authorized **Gate 34.2** public stable publication of Desktop **`v1.0.8`** covering:

1. Publishing the frozen, already-verified Desktop `v1.0.8` Final RC (`release/v1.0.8-final-rc/`) without rebuilding binaries or altering signatures.
2. Promoting GitHub Release `v1.0.8` to repository-wide **Latest Stable**.
3. Activating live Desktop auto-updater metadata at `releases/latest/download/latest.json`.
4. Updating and deploying `https://toridownload.xyz` Desktop release references via Cloudflare Pages.
5. Executing real live HTTPS, cryptographic, isolated `v1.0.7 → v1.0.8` auto-updater/upgrade, External Tools, Browser Companion `v1.0.10`, and OEM preservation verification.

Explicitly **NOT authorized** and strictly preserved untouched:

- No Browser Companion `v1.0.10` changes (`extension-v1.0.10`, Release ID `451270856`).
- No production External Tools manifest `rev 2` changes (`caa2d4ed...`) or new manifest signing.
- No Stage 2 dedicated-only tools signing cutover and no legacy signer (`CDC23D8CC8DA5397`) retirement/revocation.
- No signing key regeneration or rotation.
- No overwrite of `origin/master` (`62715926785da3fd7da811da997279931cc5cad0`) and no creation of reserved tag `checkpoint-gate33_3-final-rc-verified`.
- No silent upgrade or modification of the operator's OEM Desktop installation (`v1.0.6`), SQLite database, or `.tdm-part` files.

---

## 3. Accepted Risk Dispositions

All three Stage 1 operational limitations explicitly accepted by the project owner are recorded accurately below and **NOT** marked resolved:

| Risk ID | Governance Flags | Disposition | Stage 2 / Future Gate Constraint |
|---|---|---|---|
| **`RISK-34-01`** | `BACKUP_VERIFICATION_DEFERRED_BY_OWNER` / `BACKUP_RECOVERY_NOT_VERIFIED` | **`ACCEPTED_FOR_STAGE1_V108_PUBLIC_RELEASE`** | **HARD BLOCKER** for Stage 2 dedicated-only External Tools production signing cutover. Dedicated key `C3FD6626A3718E63` offline encrypted backup and independent recovery test remain mandatory before any production manifest is signed exclusively with `C3FD6626A3718E63`. |
| **`RISK-34-02`** | `CLEAN_WINDOWS_10_11_VM_NOT_TESTED` | **`ACCEPTED_FOR_STAGE1_V108_PUBLIC_RELEASE`** | Clean Windows 10 and Windows 11 VM verification was **NOT PERFORMED** (`0` clean VMs available on host). All runtime validation was executed on Windows 11 under isolated install directories, isolated data/WebView2/browser profiles, and `QaOemStateGuard`. |
| **`RISK-34-03`** | `WINDOWS_AUTHENTICODE_NOT_SIGNED` | **`ACCEPTED_FOR_STAGE1_V108_PUBLIC_RELEASE`** | `Get-AuthenticodeSignature` status is **`NotSigned`** (no OV/EV Authenticode certificate configured). Windows Defender SmartScreen warnings may appear on manual `.exe` downloads. Independent Tauri Ed25519 updater signing (`CDC23D8CC8DA5397`) remains strictly enforced. |

---

## 4. Gate 34.1 Preflight Baseline

Gate 34.2 started cleanly from the verified Gate 34.1 preflight checkpoint:

- **Preflight Checkpoint Tag:** `checkpoint-gate34_1-v108-public-preflight-verified` (`fd193d7f3ec7e307a087895d99f4a1525fb380f2`)
- **Gate 33.3 QA Handover Checkpoint:** `checkpoint-gate33_3-qa-complete-backup-deferred` (`0eba3d1adfba02d22de22f025b1427b4fc6b3dd1`)
- **Verified Build Source Commit:** `1a24265d247a43371ab2b637e195425df2c78b82` (**435/435** automated QA checks passed; `git diff 1a24265d -- crates/ src-tauri/ ui/ extension/` = `0` lines)
- **Pre-Publication Safety Checkpoint:** `checkpoint-gate34_2-before-v108-publication` (`fd193d7f3ec7e307a087895d99f4a1525fb380f2`)
- **Out-of-Repo Pre-Publication Backup Directory:** `C:\Users\ritud\.tori-release-backups\gate34_2_pre_pub_20261123\` (preserving pre-release `v1.0.7` `latest.json`, GitHub release JSON, production tools manifest `rev 2` + `.sig`, pre-release website `index.html` & `sitemap.xml`, and published `v1.0.8` release snapshot `published_v108_release.json`)

---

## 5. Release Source Commit

- **Application Build Source Commit:** `1a24265d247a43371ab2b637e195425df2c78b82`
- **Source Invariance Check:** `git diff 1a24265d247a43371ab2b637e195425df2c78b82 -- crates/ src-tauri/ ui/ extension/` returned **`0` changed lines**, proving the published `v1.0.8` binaries correspond bit-for-bit to the Gate 33.3 verified source tree.
- **No Rebuild Performed:** Frozen artifacts from `release/v1.0.8-final-rc/` were staged without recompilation or re-signing.

---

## 6. Release Tag

- **Public Git Tag:** `v1.0.8` (annotated tag pushed to `origin`)
- **Tag Object SHA:** `b7828cda3a641e0d1c64ec9f6a274da433b64c53`
- **Dereferenced Commit (`refs/tags/v1.0.8^{}`):** `1a24265d247a43371ab2b637e195425df2c78b82`
- **Remote Verification:** Confirmed via `git ls-remote origin refs/tags/v1.0.8^{}` returning `1a24265d247a43371ab2b637e195425df2c78b82`.

---

## 7. Git Branch Topology

| Ref | Commit SHA | Status / Purpose |
|---|---|---|
| `origin/master` | `62715926785da3fd7da811da997279931cc5cad0` | **UNTOUCHED** — Hosts active scheduled read-only manifest expiry monitor (Workflow ID `427101855`). Not overwritten or force-pushed. |
| `refs/tags/v1.0.8^{}` | `1a24265d247a43371ab2b637e195425df2c78b82` | Pushed public release tag pointing directly to the verified `v1.0.8` build commit. |
| `checkpoint-gate34_1-v108-public-preflight-verified` | `fd193d7f3ec7e307a087895d99f4a1525fb380f2` | Preserved Gate 34.1 preflight baseline checkpoint. |
| `checkpoint-gate34_2-before-v108-publication` | `fd193d7f3ec7e307a087895d99f4a1525fb380f2` | Local pre-publication safety checkpoint. |
| `release/gate34_2-v108-public-stable` | Post-release commit (pushed) | Dedicated Gate 34.2 publication automation, verification script, report, and checklist branch. |
| `checkpoint-gate34_2-v108-public-stable-released` | Post-release commit (pushed) | Annotated post-release checkpoint tag. |
| `checkpoint-gate33_3-final-rc-verified` | **NOT CREATED** | Reserved tag intentionally withheld while `RISK-34-01` backup verification remains deferred. |

---

## 8. Artifact Integrity Evidence

All **10/10** frozen artifacts in `release/v1.0.8-final-rc/` were re-verified prior to staging and mapped byte-for-byte into `release/v1.0.8-public/` (normalizing the NSIS space-containing local filename `TORI Download Manager_1.0.8_x64-setup.exe` to the established GitHub dotted asset name `TORI.Download.Manager_1.0.8_x64-setup.exe` without altering a single byte):

- **Installer Local Frozen SHA-256 == Public Uploaded SHA-256 == Live Downloaded SHA-256:**  
  `728d0d253a8fadc3fea5244723237f267dcd13abf65cac49b91a4ec83a3dcffb` (`118,110,372` bytes)
- **Updater Signature Local Frozen SHA-256 == Public Uploaded SHA-256 == Live Downloaded SHA-256:**  
  `8f2bc20bd2c8994ac04d8d2fc84be37b5569f11caeb47b63f369a4c72b44294c` (`436` bytes)
- **Zero Secrets / Private Keys in Release Staging:** Verified zero `.key`, `.pwd`, or private key headers across `release/v1.0.8-public/`.

---

## 9. Tauri Ed25519 Signature

- **Signing Key ID:** `CDC23D8CC8DA5397` (existing Desktop updater public key embedded in `src-tauri/tauri.conf.json`, unchanged)
- **Signature File:** `TORI.Download.Manager_1.0.8_x64-setup.exe.sig` (`436` bytes, SHA-256 `8f2bc20bd2c8994ac04d8d2fc84be37b5569f11caeb47b63f369a4c72b44294c`)
- **Verification Paths Passed:**
  1. Pre-publication staging roundtrip verification (`scripts/publish_desktop_v1_0_8_release.js`).
  2. Live HTTPS downloaded installer & `.sig` verification via Node Ed25519/BLAKE2b-512 Minisign verification (`G342-03`: `ed25519=true`).
  3. Real in-app Rust `minisign-verify` signature check executed inside running Desktop `v1.0.7` during `plugin:updater|download` (`G342-09`: `118,110,372` bytes verified).
  4. Rust cryptographic test suite `cargo test -p tdm-core --test updater_cryptography_tests` (**10/10 PASS**, including tampered-payload and corrupted-signature rejection).

---

## 10. Windows Authenticode Status

- **Observed Status (`Get-AuthenticodeSignature` on live downloaded `TORI.Download.Manager_1.0.8_x64-setup.exe`):** **`NotSigned`**
- **Disposition:** **`RISK-34-03` (`WINDOWS_AUTHENTICODE_NOT_SIGNED` — `ACCEPTED_FOR_STAGE1_V108_PUBLIC_RELEASE`)**
- **Transparency:** Both GitHub release notes (`RELEASE_NOTES_v1.0.8.md`) and `https://toridownload.xyz` honestly state Authenticode signing is pending and explain Windows SmartScreen handling while highlighting SHA-256 and Ed25519 updater verification.

---

## 11. GitHub Release ID

- **GitHub Release ID:** **`455125259`**
- **Release URL:** `https://github.com/robijoychakma375-hash/tori-download-manager/releases/tag/v1.0.8`
- **API Status:** `draft: false`, `prerelease: false`, repository-wide `/releases/latest` resolves directly to Release ID `455125259` (`tag_name: "v1.0.8"`).
- **Preserved Historical Releases Confirmed:**
  - Desktop `v1.0.7`: Release ID `454278227` (preserved intact as rollback target)
  - Desktop `v1.0.6`: Release ID `453599579` (preserved intact)
  - Browser Companion `extension-v1.0.10`: Release ID `451270856` (preserved intact)
  - External Tools `tools-ffmpeg-N-129150-g7ddf7bc8a4`: Release ID `453686141` (`prerelease: true`, preserved intact)

---

## 12. GitHub Publication Timestamp

- **GitHub `published_at` (UTC):** `2026-11-23T08:25:29Z`
- **Updater `latest.json` `pub_date` (UTC):** `2026-11-23T07:55:00.033Z`

---

## 13. Release Asset Inventory

Total published assets on GitHub Release `455125259`: **`16` Desktop-only assets** (zero Browser Companion `.xpi`/`.zip` assets, zero External Tools release assets, zero private keys, zero user databases).

- **Installers & Signatures (2):** `TORI.Download.Manager_1.0.8_x64-setup.exe`, `TORI.Download.Manager_1.0.8_x64-setup.exe.sig`
- **Standalone / Companion Desktop Binaries (3):** `tori-download-manager.exe`, `tdm-native-host.exe`, `tdm-cli.exe`
- **Updater & Release Metadata (4):** `latest.json`, `SHA256SUMS.txt`, `BUILD_METADATA.json`, `RELEASE_MANIFEST.json`
- **Release Documentation (2):** `RELEASE_NOTES_v1.0.8.md`, `INSTALLATION_AND_UPGRADE.md`
- **Licenses (5):** `LICENSE`, `LICENSE-MIT`, `LICENSE-APACHE`, `LICENSE-GPLv3.txt`, `LICENSE-THIRD-PARTY.txt`

---

## 14. Asset Sizes and Checksums

| Asset Name | GitHub Asset ID | Size (Bytes) | SHA-256 |
|---|---:|---:|---|
| `TORI.Download.Manager_1.0.8_x64-setup.exe` | `782056228` | `118,110,372` | `728d0d253a8fadc3fea5244723237f267dcd13abf65cac49b91a4ec83a3dcffb` |
| `TORI.Download.Manager_1.0.8_x64-setup.exe.sig` | `782094029` | `436` | `8f2bc20bd2c8994ac04d8d2fc84be37b5569f11caeb47b63f369a4c72b44294c` |
| `tori-download-manager.exe` | `782094071` | `32,102,400` | `197d2b6bda12a6a4aa8a71664d0bde8b7db723a836f04980bd48fbccecbb6fbf` |
| `tdm-native-host.exe` | `782102325` | `19,365,888` | `703a901c4b0be3c6f956d726e8d0551ba9fe9ea319a4d8cbd76ca9eefddaacdd` |
| `tdm-cli.exe` | `782108000` | `17,016,832` | `19d09bb948a8940e36e6a97184c0d13534c87a5aea838b6a2f58ca6d959479e2` |
| `latest.json` | `782113345` | `2,042` | `0e1cb2df6d54e80d83e0b2b83b9b716f2670464896295bce8c922e9942979cee` |
| `SHA256SUMS.txt` | `782113395` | `1,319` | `22ab342d4b7c2427ebc59f64d609a5a7dc9c70f47e051659d1b0e96c594f79f0` |
| `BUILD_METADATA.json` | `782113439` | `2,209` | `d8ac8e41d53e7d2994394ade74ef37fec20efd55b363b2b3c59ea0185891300c` |
| `RELEASE_MANIFEST.json` | `782113482` | `3,116` | `e0f10644076f413b1c92d65790c8dc5d3743386036ffadd777e92c76bf183486` |
| `RELEASE_NOTES_v1.0.8.md` | `782113530` | `4,146` | `7daa614659f6b458f9b867b5d78d21ac61e63c59bcc2b3ee6fd9dcae3cba2788` |
| `INSTALLATION_AND_UPGRADE.md` | `782113574` | `2,393` | `adf9cef6dab7c2bb89fd560dd76888741944d84c8219cbac2144c0e70db6a296` |
| `LICENSE` | `782113614` | `1,465` | `55460ef099ce57e32d422427a7a24cd1e09aec677606289e396c2c17d625a598` |
| `LICENSE-MIT` | `782113695` | `1,092` | `dffcef788fe594963f082966daa3b969c7c4f633e612d8f88ee8a3033c4a5144` |
| `LICENSE-APACHE` | `782113738` | `9,899` | `20fe7b00e904ed690e3b9fd6073784d3fc428141dbd10b81c01fd143d0797f58` |
| `LICENSE-GPLv3.txt` | `782113786` | `35,147` | `8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903` |
| `LICENSE-THIRD-PARTY.txt` | `782113830` | `4,421` | `4f05486cb940a151e9b010ff3d033b7fb06370c665d174eb5d54d48433eb6035` |

---

## 15. Desktop `latest.json` Verification

- **Live Endpoint:** `https://github.com/robijoychakma375-hash/tori-download-manager/releases/latest/download/latest.json`
- **HTTP Status:** `200 OK` (clean redirect to GitHub release asset storage)
- **Version:** `1.0.8`
- **Publication Timestamp (`pub_date`):** `2026-11-23T07:55:00.033Z`
- **Platform Entries:** Both `windows-x86_64` and `windows-x86_64-nsis` point to:
  `https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.8/TORI.Download.Manager_1.0.8_x64-setup.exe`
- **Signature Match:** Exact match to `TORI.Download.Manager_1.0.8_x64-setup.exe.sig` (`8f2bc20b...`) and cryptographically verified against the live downloaded installer.
- **Hygiene:** Zero `DRAFT`, `UNPUBLISHED`, `localhost`, or stale `v1.0.7` references (`G342-04 PASS`).
- **SemVer Matrix:** Confirmed `1.0.5 / 1.0.6 / 1.0.7 < 1.0.8 == 1.0.8 < 1.0.9`; live running `v1.0.8` receives `null` (no redundant update loop).

---

## 16. Live Installer Download Verification

- **Public URL Tested:** `https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.8/TORI.Download.Manager_1.0.8_x64-setup.exe`
- **Download Results (`G342-03` & `G342-09`):**
  - Direct HTTPS `curl.exe` download: HTTP `200`, `118,110,372` bytes, SHA-256 `728d0d253a8fadc3fea5244723237f267dcd13abf65cac49b91a4ec83a3dcffb` (exact match to frozen RC).
  - Live Tauri `plugin:updater|download` inside running `v1.0.7`: `118,110,372` bytes downloaded over HTTPS in `256,198 ms` and passed Rust `minisign-verify` Ed25519 signature verification (`CDC23D8CC8DA5397`).

---

## 17. Website Source Commit

- **Website Repository:** `C:\Users\ritud\Downloads\tori-website` (`robijoychakma375-hash/tori-website-private`, branch `main`)
- **Prior Commit:** `2eff4f20a64989c39a75cb6b1739ce3948431048`
- **New Production Commit:** **`181b3fb7c4d2abb9889d7d988b223fe63e02506f`** (`Gate 34.2: promote toridownload.xyz to Desktop v1.0.8 Stable (Companion v1.0.10 & tools rev 2 unchanged)`)
- **Changed Files (2 only):** `index.html` (`+54/-36` lines; updated current Desktop references to `v1.0.8`, SHA-256 `728d0d25...`, `Nov 23, 2026`, `tori_release_cache_v5`, and preserved historical `v1.0.7` in `FALLBACK_RELEASES`) and `sitemap.xml` (`<lastmod>2026-11-23</lastmod>`).
- **Working Tree Status:** Clean (`git status --short` empty; temporary `.wrangler/` removed).

---

## 18. Cloudflare Pages Deployment ID

- **Cloudflare Pages Project:** `tori-download-manager` (Account ID `f903c690199da4b181753ed3370bb658`)
- **Primary Verified Production Deployment ID:** **`113c58b9-82c9-42ec-a096-7bc9b62c5b9e`** (`https://113c58b9.tori-download-manager.pages.dev` -> `https://toridownload.xyz`, Source `181b3fb`)
- **Git-Triggered Companion Production Build ID (same commit `181b3fb`):** `5bc37b77-c69b-4080-97a5-a2e1195f2ca3`

---

## 19. Live Website Verification

- **Multi-Pass Cache-Bypass HTTP Consistency (`G342-07 PASS`):** Two independent cache-bypass passes (`cfRay=a5ef2a43abf3b8f9-DAC` and `a5ef2a517975062f-DAC`, `CF-Cache-Status: DYNAMIC`) verified HTTP `200` on `https://toridownload.xyz/`, `sitemap.xml` (`2026-11-23`), `robots.txt`, GitHub release page, GitHub `/releases/latest` API, `latest.json`, installer HEAD (`118,110,372` B), `.sig`, and production tools manifest `rev 2` + `.sig` with zero CDN inconsistency.
- **Desktop (`1440×900`) & Mobile (`390×844`) Live Browser Rendering (`G342-08 PASS`):** Verified across `#top`, `#download`, and `#extension` in headless Edge:
  - Hero pill: `New · v1.0.8 for Windows (Stable)`
  - Primary & download CTA links: `.../releases/download/v1.0.8/TORI.Download.Manager_1.0.8_x64-setup.exe`
  - Version stat: `1.0.8`; Release Archive top 3: `["v1.0.8", "v1.0.7", "v1.0.6"]`
  - Companion links unchanged (`v1.0.10`), zero horizontal overflow, zero broken images.

---

## 20. Browser Companion Preservation

- **Version:** `v1.0.10` (**UNCHANGED** — Release ID `451270856`, tag `extension-v1.0.10`)
- **Firefox Signed XPI (`G342-06 PASS`):**
  - GitHub & `https://toridownload.xyz/assets/tori-download-manager-firefox-v1.0.10.xpi` both match **`107,499` bytes**, SHA-256 **`a93a43872d224426902c49e217e31b2c603263d8c260c429940539b34b2852b8`**, MIME `application/x-xpinstall`.
  - Installed permanently into Firefox under strict `xpinstall.signatures.required=true` (`signed=true`, `temporary=false`, Gecko ID `tori-download-manager@toridm.org`).
- **Chromium MV3 ZIP (`G342-06` & `G342-12 PASS`):**
  - GitHub `tori-companion-v1.0.10-chromium.zip` matches **`90,964` bytes**, SHA-256 **`f220fab2e26fd54ef7f85fd7e40613faad79e7f9a7f44fadf228ccd0edcc22f1`**, `manifest_version=3`, `version=1.0.10`.
- **Live Browser Integration (`G342-12 PASS`):** Verified end-to-end Firefox Companion `v1.0.10` download interception of `public_v108_capture.mkv` into upgraded public Desktop `v1.0.8` with zero duplicates (`newJobs=1`) and exact SHA-256 match.

---

## 21. Tools Manifest Revision 2 Preservation

- **Live Production Endpoint:** `https://toridownload.xyz/assets/tools/tools-manifest.json` & `.sig`
- **Manifest Revision:** **`2`** (unchanged)
- **Manifest SHA-256:** `caa2d4ed2a7e424badcd8662e67b986a3fdfbf2847dded0625ea2b2547663f3a`
- **Signature SHA-256:** `11efa53f290d3d46fb16915fd3d1e69451de8c654eae8d75844b840ab99bb1c2`
- **Active Production Signer:** Legacy key **`CDC23D8CC8DA5397`** (`dedicated_signing_key_id` absent)
- **Expiration:** `2027-01-21T19:46:42.049Z`
- **Live Expiry Monitor Result:** `HEALTHY` (`59.43` days / `1426.43` hours remaining, `signatureValid=true`, `anomalies=[]`)
- **FFmpeg Artifact Preservation:** `HEAD` HTTP `200`, `205,445,856` bytes unchanged at `tools-ffmpeg-N-129150-g7ddf7bc8a4` (`453686141`).

---

## 22. Dedicated-Key Stage 1 Verification

- **Legacy Tools Signer:** `CDC23D8CC8DA5397` (ACTIVE in Stage 1 dual-key keyring; sole production manifest signer)
- **Dedicated Tools Public Key:** `C3FD6626A3718E63` (raw Ed25519 pubkey `6807e183f56c08eb06fdff95347bbbf7174b4ce5185b0245155db315e87fee39`, embedded in `crates/tdm-core/src/tools/trust.rs` and verified present inside the installed public `v1.0.8` `tori-download-manager.exe` binary in `G342-09`)
- **Stage 1 Dual-Key Trust:** **VERIFIED ACTIVE** (`dualKeyBin: { legacy: true, dedicated: true }`, `external_tools_security_matrix_tests` **5/5 PASS** confirming purpose-bound separation, anti-trust-escalation, and revocation handling)
- **Dedicated-Only Production Cutover:** **DISABLED / BLOCKED** (remains blocked pending `RISK-34-01` offline encrypted backup & recovery verification and fleet adoption telemetry).

---

## 23. Real `v1.0.7 → v1.0.8` Upgrade

Executed live in an isolated Windows directory (`target/gate34_2_live_qa/upg_inst`) with zero staging/test overrides (`G342-09`, `G342-10`, `G342-13`):

1. Installed baseline Desktop `v1.0.7` (`142e4528...`) and seeded realistic SQLite state (`42` downloads, `355` chunks, `theme=dark`, `accent=rose`, `closeToTray=true`) plus an incomplete `65,536`-byte `.tdm-part` file.
2. Booted running Desktop `v1.0.7` (`get_app_version === "1.0.7"`).
3. Invoked **real Tauri `plugin:updater|check`** -> discovered live `v1.0.8` from `releases/latest/download/latest.json` (`currentVersion=1.0.7`, `version=1.0.8`, zero draft text).
4. Invoked **real Tauri `plugin:updater|download`** -> streamed all **`118,110,372` bytes** over live HTTPS (`256,198 ms`) and passed Tauri's Rust Ed25519 signature check (`CDC23D8CC8DA5397`).
5. Completed real in-place NSIS upgrade of the isolated installation using the live-downloaded public `TORI.Download.Manager_1.0.8_x64-setup.exe`.
6. Relaunched upgraded Desktop `v1.0.8`:
   - `get_app_version === "1.0.8"`, PE `ProductVersion === "1.0.8"`, `tdm-native-host.exe` SHA-256 `703a901c...`.
   - Post-upgrade `plugin:updater|check` returned `null` (up-to-date, no update loop).
   - SQLite `PRAGMA integrity_check === "ok"`, all `42` pre-upgrade rows & `355` chunks intact, settings preserved (`dark`/`rose`/`closeToTray`), `.tdm-part` SHA-256 unchanged.
   - Close-to-Tray hid main window cleanly; standalone IDM Progress Window handled Pause -> Resume -> Complete with zero legacy toast and exact SHA-256 (`G342-10 PASS`).
   - Warm restart (`850 ms`) preserved `v1.0.8`, all `44` downloads (`42 + 2`), and `4` SQLite tool update history entries (`G342-13 PASS`).

---

## 24. Native Messaging Tests

Verified in `G342-12 PASS`:

- **`tdm-native-host.exe --register` (v1.0.8 binary, `703a901c...`):** Exited `0` and verified valid HKCU Native Messaging keys & manifests for **Chrome**, **Edge**, and **Firefox** (`allowed_origins` for Chromium extensions and `allowed_extensions: ["tori-download-manager@toridm.org"]` for Firefox).
- **Stdio Wire Protocol:** Framing `{"action":"ping"}` over stdin/stdout returned `{"action":"pong"}` cleanly (exit `0`).
- **HTTP Fallback API:** `GET /api/v1/status` returned HTTP `200` with valid auth token; live browser download handoff succeeded with zero duplicate tasks.
- **Registry Restoration:** `QaOemStateGuard` cleanly restored OEM Native Messaging registry values post-test (`G342-14 PASS`).

---

## 25. FFmpeg / FFprobe Tests

Verified live against production manifest `rev 2` on public Desktop `v1.0.8` (`G342-11 PASS`):

- **Default Endpoint Detection:** Fetched `https://toridownload.xyz/assets/tools/tools-manifest.json` (`rev 2`, `caa2d4ed...`, verified by `CDC23D8CC8DA5397`, `mStatVerif=verified`) with zero env overrides; detected `N-129150-g7ddf7bc8a4-20261120` for both `FFmpeg` and `FFprobe`.
- **Live 205 MiB Update & Atomic Paired Activation:** Downloaded, verified (SHA-256, Windows x64 PE32+, paired version parity, self-test), and atomically activated `N-129150-g7ddf7bc8a4-20261120` in `396,434 ms`.
- **Live Media Compatibility Matrix:** Executed real H.264/AAC encoding, MP4 muxing with metadata (`+faststart`), MKV remuxing, HLS segmenting & remuxing, and FFprobe JSON stream/duration/tag verification on updated `N-129150-g7ddf7bc8a4-20261120` — all passed.
- **Atomic Rollback & Bundled Fallback Media Matrix:** Rolled back both `FFmpeg` and `FFprobe` atomically to bundled `N-126374-g089a48eb36-20260831` and re-ran the full media compatibility matrix on bundled binaries — all passed.

---

## 26. `yt-dlp` Tests

Verified live on public Desktop `v1.0.8` (`G342-11 PASS`):

- **OpenPGP RSA-4096 Verified Update:** Updated `yt-dlp` live from bundled `2026.08.19` to `2026.10.26` (`source: "managed"`) with pure-Rust RFC 4880 signature & SHA-256 verification.
- **Atomic Rollback:** Rolled back `yt-dlp` cleanly to bundled `2026.08.19` (`source: "bundled"`), persisted to SQLite update history.

---

## 27. Rollback and Fallback Readiness

- **Desktop Rollback Target Preserved:** GitHub Release `v1.0.7` (Release ID `454278227`, installer `142e4528...`, `.sig` `945b5efd...`) and pre-publication `latest.json` backup (`C:\Users\ritud\.tori-release-backups\gate34_2_pre_pub_20261123\live_v107_latest.json`) are preserved intact.
- **Important Tauri Rollback Invariant:** Pointing `latest.json` back to `v1.0.7` halts *new* `v1.0.7 → v1.0.8` auto-upgrades, but does **not** automatically downgrade already-upgraded `v1.0.8` clients (SemVer requires a properly signed corrective `v1.0.9` release for automatic forward recovery).
- **External Tools Rollback & Bundled Fallback:** Verified live for both `yt-dlp` and paired `FFmpeg`/`FFprobe` in `G342-11` and supported by emergency higher-revision (`rev 3`) signed manifest procedures.

---

## 28. Production User-Data Preservation

Verified by `QaOemStateGuard` + `snapshotOemDatabase` before and after live QA (`G342-14 PASS`):

- **OEM Installed Binary (`%LOCALAPPDATA%\TORI Download Manager\tori-download-manager.exe`):** `v1.0.6` (`570833b3...`) — **100% UNCHANGED** (`oemExeMatch=true`).
- **OEM SQLite Database (`%APPDATA%\tori-download-manager\tdm_storage.sqlite`):** `PRAGMA integrity_check = ok`, **`42` downloads**, **`355` chunks**, **`5` protected settings** — **100% LOGICALLY IDENTICAL** (`dbOk=true`; note raw `.sqlite` bytes rotated normally on WAL volatile heartbeat upon OEM restart while every user download, chunk, and protected setting hash matched bit-for-bit).
- **OEM Partial Downloads (`.tdm-part`):** **`11` files**, 100% SHA-256 identical.
- **OEM Registry & Native Messaging:** Chrome, Edge, Firefox, Uninstall, and TORI HKCU keys restored with exact parity (`regOk=true`).

---

## 29. Post-Release Regression

| Suite / Verification | Scope | Mode | Result |
|---|---|---|---|
| `scripts/verify_gate34_2_public_release.js` | Live GitHub `v1.0.8`, `latest.json`, Website Desktop/Mobile, Multi-pass CDN, Real `v1.0.7→v1.0.8` Updater, External Tools `rev 2` / `yt-dlp` / `FFmpeg` / `FFprobe`, Companion `v1.0.10`, OEM Guard | **LIVE PRODUCTION** | **14 / 14 PASS** (`0 FAIL`) |
| `cargo test -p tdm-core --test updater_cryptography_tests` | Desktop `v1.0.8` Final RC + historical `v1.0.5..v1.0.7` Ed25519 signature & tamper/corruption rejection | Local Crypto | **10 / 10 PASS** (`0 FAIL`) |
| `cargo test -p tdm-core --test external_tools_security_matrix_tests` | 25+ Stage 1 dual-key, key separation, revocation, anti-escalation, replay, equivocation & recovery scenarios | Local Security | **5 / 5 PASS** (`0 FAIL`) |
| `scripts/monitor_tools_manifest_expiry.js` (live URL) | Live production `https://toridownload.xyz/assets/tools/tools-manifest.json` (`rev 2`) | **LIVE PRODUCTION** | **`HEALTHY`** (`59.43d`, `0` anomalies) |
| `scripts/verify_gate33_1_expiry_monitor_matrix.js` | 18-scenario expiry monitor & alert matrix (`MON-01..MON-18`) | Local Regression | **18 / 18 PASS** (`0 FAIL`) |
| Frozen Build Source Baseline (Gate 33.3 @ `1a24265d`, `0` code lines changed) | Complete Rust workspace (`282/282`) + 10 Node E2E suites (`153/153`: Gate 33.3, Gate 33.2, Gate 33, Gate 32.3, Gate 32.1, Gate 32, Gate 31.5, Gate 29.4, Expiry Monitor) | Verified Frozen Baseline | **435 / 435 PASS** (`0 FAIL`) |
| Clean Windows 10 / Windows 11 VM QA | Independent fresh VM host testing | N/A | **`NOT TESTED`** (`RISK-34-02`, owner-accepted) |

Historical pre-`v1.0.8` scripts (such as `verify_gate32_3_public_release.js` and `verify_gate33_2_production_manifest_renewal.js` which assert historical `latest.json == 1.0.7`) were preserved unmodified per Gate 34.2 policy.

---

## 30. Known Limitations

1. **Dedicated Tools Key Offline Backup & Recovery Deferred (`RISK-34-01`):** `BACKUP_VERIFICATION_DEFERRED_BY_OWNER` / `BACKUP_RECOVERY_NOT_VERIFIED`. Dedicated production key `C3FD6626A3718E63` exists on operator workstation only; Stage 2 dedicated-only tools signing remains blocked until encrypted offline backup and independent recovery succeed.
2. **Clean Windows 10 & Windows 11 VM Verification Not Performed (`RISK-34-02`):** `CLEAN_WINDOWS_10_11_VM_NOT_TESTED`.
3. **Windows Authenticode PE Code Signing Unavailable (`RISK-34-03`):** `WINDOWS_AUTHENTICODE_NOT_SIGNED` (`NotSigned`); SmartScreen warning expected on manual downloads until commercial OV/EV signing is configured.
4. **Paid DRM-Protected Media:** Intentionally unsupported.

---

## 31. Remaining Operational Risks

- **Single-Host Custody of Dedicated Key `C3FD6626A3718E63`:** Loss of the operator workstation before completing an encrypted offline backup would require regenerating a new dedicated key and shipping a new Desktop client release (`v1.0.9+`) before Stage 2 cutover. No immediate impact to live production tools updates while legacy key `CDC23D8CC8DA5397` signs `rev 2`.
- **Tools Manifest `rev 2` Expiration Horizon:** Expires `2027-01-21T19:46:42.049Z` (`59.43` days remaining); guarded by the active daily scheduled expiry monitor workflow (`427101855`) on `origin/master`.
- **SmartScreen Friction:** Manual installer downloads remain unsigned (`NotSigned`) until an Authenticode certificate is provisioned.

---

## 32. Emergency Recovery Plan

If a critical post-release defect is discovered in Desktop `v1.0.8`:

1. **Contain Exposure:** Mark GitHub Release `455125259` (`v1.0.8`) as prerelease or restore `v1.0.7` (`454278227`) as repository Latest Stable, and revert `tori-website` to commit `2eff4f20a64989c39a75cb6b1739ce3948431048` (`449b84d7-4ec8-4a63-b0ec-5f7d3a6a7ebe`) to immediately restore `v1.0.7` for new downloads and pending `v1.0.7` updater checks.
2. **Preserve Immutability:** Never silently mutate or re-upload bytes under `v1.0.8`; preserve all logs, release JSONs, and backups in `C:\Users\ritud\.tori-release-backups\gate34_2_pre_pub_20261123\`.
3. **Forward Remediation for Already-Upgraded `v1.0.8` Clients:** Because Tauri SemVer updater does **not** auto-downgrade `v1.0.8 → v1.0.7`, ship a properly signed corrective Desktop `v1.0.9` release for automatic client remediation.
4. **External Tools Emergency Recovery:** Issue a signed `manifest_revision: 3` pointing to a known-good FFmpeg/FFprobe bundle or rely on built-in automatic rollback and bundled fallback (`N-126374-g089a48eb36-20260831`).

---

## 33. Final Release Status

**`FULL GO — DESKTOP v1.0.8 PUBLIC STABLE RELEASED & VERIFIED (WITH 3 OWNER-ACCEPTED STAGE 1 LIMITATIONS)`**

All **20/20** Gate 34.2 acceptance criteria passed with zero critical or high-severity failures, while accurately recording `RISK-34-01`, `RISK-34-02`, and `RISK-34-03` as owner-accepted Stage 1 limitations and maintaining the Stage 2 dedicated-only cutover block.

---

## 34. Next Recommended Gate

**Gate 35 — Dedicated External Tools Key Offline Encrypted Backup & Recovery Verification, Clean Windows 10/11 VM QA, Commercial Authenticode Code Signing & Stage 2 Dual-Signed Manifest Readiness**

1. Provision external offline storage and complete verified encrypted backup + independent recovery test for dedicated production key `C3FD6626A3718E63` (clearing `RISK-34-01` and unblocking Stage 2).
2. Track `v1.0.8+` fleet adoption and keep `rev 2` monitored ahead of its `2027-01-21` expiry (30-day renewal window begins `2026-12-22`).
3. Execute independent clean Windows 10 and Windows 11 VM installation/upgrade QA (closing `RISK-34-02`) and optionally onboard OV/EV Authenticode signing (closing `RISK-34-03`).
