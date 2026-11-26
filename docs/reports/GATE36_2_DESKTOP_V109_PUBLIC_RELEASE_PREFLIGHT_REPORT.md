# TORI Download Manager — Gate 36.2 Desktop v1.0.9 Public Release Preflight Report

**Gate:** Gate 36.2 — Desktop `v1.0.9` Public Release Preflight (Non-Publishing)  
**Date:** 2026-11-26  
**Project Root:** `F:\TORI\final tori download manager`  
**Source RC Branch / Commit:** `release/gate36_1-desktop-v109-rc` @ `b60770b1c5124a5a9e5b5c2b883e9a0ecd3fc308` (`checkpoint-gate36_1-desktop-v109-rc-verified`)  
**Gate 36.2 Preparation Branch:** `feat/gate36_2-desktop-v109-prepublish`  
**Target Public Release Tag (NOT YET CREATED/PUSHED):** `v1.0.9`  
**Publication Status:** **LOCAL PREFLIGHT ONLY — PUBLIC RELEASE NOT AUTHORIZED / NOT PERFORMED**  
**Final Verdict:** **`CONDITIONAL GO`** *(All technical, cryptographic, upgrade, Companion `v1.0.11`, staging, dry-run, and preservation checks PASSED; public publication strictly gated on separate explicit owner release authorization and independent disposition of `RISK-36-01`, `RISK-36-02`, and `RISK-36-03`.)*

---

## 1. Executive Summary

Gate 36.2 executed a complete, non-publishing release preflight for **TORI Download Manager Desktop `v1.0.9`** without modifying any live production surface, rebuilding or re-signing the frozen Gate 36.1 Release Candidate (`release/v1.0.9-rc/`), creating remote GitHub drafts/tags, pushing branches/checkpoints, deploying Cloudflare Pages, touching signing keys, or altering operator OEM installations/user data.

### Key Outcomes

| Area | Result | Evidence Summary |
| :--- | :---: | :--- |
| Source Integrity & Ancestry | **PASS** | `b60770b1c5124a5a9e5b5c2b883e9a0ecd3fc308` is a verified linear descendant of Gate 35.1 (`cb885d48`), Gate 35.2 (`48184cb2`), and Gate 35.5 (`169e8641`); all Desktop crates (`tdm-core`, `tdm-native-host`, `tdm-cli`, `tori-download-manager`), `tauri.conf.json`, `ui/package.json`, and PE version metadata report `1.0.9`. |
| Frozen RC & Cryptographic Preflight | **PASS** | All 6 frozen RC files untouched bit-for-bit; installer `118,170,722` B (`460f5da0...`); Tauri Ed25519 `.sig` (`9fd6f9e8...`) valid under `CDC23D8CC8DA5397` with 1-byte tamper strictly rejected in both Rust & Node; Stage 1 dual-key keyring active (`C3FD6626A3718E63` + `CDC23D8CC8DA5397`), Stage 2 cutover **DISABLED**; `0` secrets leaked. |
| Rust Security & Reliability Regressions | **PASS** | `74 / 74` focused Gate 36.2 Rust tests passed (`42/42` `tdm-core` security/crypto/Content-Range/startup + `32/32` `tdm-native-host` unit/integration); prior Gate 36.1 full workspace (`314/314`), Clippy (`0` errors), and UI build/lint (`0` errors) hold on identical source commit `b60770b1` (`0` source edits). |
| Isolated `v1.0.8` → `v1.0.9` Upgrade & Engine QA | **PASS** | `12 / 12` passed (`6.82s`): live `v1.0.8` → `v1.0.9` `--minimized` upgrade preserved SQLite `ok`, downloads, `closeToTray`, theme/accent, and `.tdm-part`; broken-CDN `206` mismatch recovered cleanly via single-stream `200 OK` fallback; `4x` concurrent native-host spawn mutex `4/4` succeeded; production tools manifest rev 2 (`caa2d4ed...`) verified. |
| Live Public Companion `v1.0.11` Compatibility | **PASS** | `77 / 77` passed against live `v1.0.9` RC binaries: public Mozilla-signed Firefox `v1.0.11` XPI (`15/15`, `27.70s`), public Chromium `v1.0.11` ZIP across Chrome/Edge/Firefox (`32/32`, `38.17s`), and `SEC-35-04` VM matrix (`30/30`, `0.36s`). |
| Bundled Tools (`ffmpeg`, `ffprobe`, `yt-dlp`) | **PASS** | `ffmpeg.exe` (`145,858,048` B, `N-126374-g089a48eb36-20260831`), `ffprobe.exe` (`145,645,568` B, `N-126374-g089a48eb36-20260831`), and `yt-dlp.exe` (`17,840,399` B, `2026.08.19`) verified intact. |
| GitHub Staging & Read-Only Dry-Run | **PASS** | Exact 16-asset `v1.0.8` convention staged in `release/v1.0.9-public-staging/`; `publish_desktop_v1_0_9.js --dry-run` verified `push=true`, `admin=true`, live `/releases/latest == v1.0.8` (`455125259`), `v1.0.9 == 404`, `extension-v1.0.11 == 200` (`458864802`), `remote_writes_performed: 0`. |
| Local Website Release Prep | **PASS** | Staged locally in `C:\Users\ritud\Downloads\tori-website` on `feat/gate36_2-desktop-v109-website-prep` (`330846d19333a9b98bea83d52bf95c2c3a4a1eef`); `main` untouched at `3edb4293...`; Companion `v1.0.11` XPI/ZIP, rollback XPI `v1.0.10`, and tools manifest rev 2 preserved verbatim; diff archived (`22,699` chars). |
| Clean Windows 10 & 11 OS QA | **OPEN RISK** | **`CLEAN_WINDOWS_QA_NOT_TESTED`** (`0` local VMs/Sandbox; `.github/workflows/clean-windows-release-qa.yml` is `NOT_YET_ON_MASTER`). Tracked as **`RISK-36-02`**. |
| Windows Authenticode Signing | **OPEN RISK** | **`NotSigned`** on installer and all 3 standalone EXEs (commercial cert not configured; WDK test cert prohibited). Tracked as **`RISK-36-03`**. |
| Dedicated Tools Key Backup/Recovery | **OPEN RISK** | Active key `C3FD6626A3718E63` verified **`VALID_PRODUCTION_KEY`** (`ntfsAclOwnerOnly`, scrypt-encrypted, independent of updater key), but offline backup remains **`BACKUP_RECOVERY_NOT_VERIFIED`**. Tracked as **`RISK-36-01`**. |
| Production & Operator OEM Preservation | **PASS** | Live Desktop `v1.0.8` (`455125259`), Companion `v1.0.11` (`458864802`), `toridownload.xyz` (`723c6191...`), tools manifest rev 2 (`caa2d4ed...`), OEM `v1.0.6` (`570833b3...`), SQLite (`ok`, `56` downloads, `531` chunks, `7` settings), `21` `.tdm-part` files, HKCU registry keys, and `0` stray processes all verified intact. |

---

## 2. Source Integrity, Provenance & Branch Topology

### Git Ancestry & Remote State (Read-Only Inspection)

- **Gate 36.1 Verified RC Commit:** `b60770b1c5124a5a9e5b5c2b883e9a0ecd3fc308` (`release/gate36_1-desktop-v109-rc`, tag `checkpoint-gate36_1-desktop-v109-rc-verified`)
- **Gate 36.2 Local Preparation Branch:** `feat/gate36_2-desktop-v109-prepublish` (branched cleanly from `b60770b1c5124a5a9e5b5c2b883e9a0ecd3fc308` with zero source code modifications)
- **Verified Ancestors of `b60770b1`:**
  - Gate 35.1 Security Hardening (`cb885d48cfcfc1557489a033984e12037c10ea80`): **`True`** (`git merge-base --is-ancestor`)
  - Gate 35.2 Companion Security & Desktop Bug Fixes (`48184cb2b6d05d25e3ffc47f967f4ca11a82a025`): **`True`**
  - Gate 35.5 Public Browser Companion `v1.0.11` Release (`169e8641b78d9f35833cb790de3fab52e13c55e4`): **`True`**
- **Remote Repository State (Untouched):**
  - `origin/master`: `62715926785da3fd7da811da997279931cc5cad0` *(untouched; never overwritten or force-pushed)*
  - Remote tag `v1.0.9`: **ABSENT** (`HTTP 404` on `/releases/tags/v1.0.9`)
  - Public Latest Stable: `v1.0.8` (GitHub Release ID `455125259`, `16` assets)
  - Public Browser Companion: `extension-v1.0.11` (GitHub Release ID `458864802`)

### Desktop Package & Binary Version Audit

| Component | Path / Artifact | Verified Version |
| :--- | :--- | :---: |
| Cargo Workspace | `Cargo.toml` `[workspace.package]` | `1.0.9` |
| Core Engine Crate | `crates/tdm-core/Cargo.toml` (`version.workspace = true`) | `1.0.9` |
| Native Host Crate | `crates/tdm-native-host/Cargo.toml` (`version.workspace = true`) | `1.0.9` |
| CLI Crate | `crates/tdm-cli/Cargo.toml` (`version.workspace = true`) | `1.0.9` |
| Tauri Desktop Crate | `src-tauri/Cargo.toml` (`version.workspace = true`) | `1.0.9` |
| Tauri Bundle Config | `src-tauri/tauri.conf.json` (`visible: false`, updater `CDC23D8CC8DA5397`) | `1.0.9` |
| Frontend UI Package | `ui/package.json` | `1.0.9` |
| Frozen NSIS Installer PE | `release/v1.0.9-rc/TORI.Download.Manager_1.0.9_x64-setup.exe` | `1.0.9` |
| Frozen Desktop EXE PE | `release/v1.0.9-rc/tori-download-manager.exe` | `1.0.9` |
| Browser Companion Manifests | `extension/manifest.json` & `extension/firefox/manifest.json` | `1.0.11` *(preserved)* |

---

## 3. Frozen Artifact Inventory & Cryptographic Preflight

All frozen Gate 36.1 Release Candidate artifacts in `release/v1.0.9-rc/` were re-hashed and verified untouched (zero rebuilds, zero re-signing):

| File (`release/v1.0.9-rc/`) | Size (Bytes) | SHA-256 | Authenticode | Status |
| :--- | ---: | :--- | :---: | :---: |
| `TORI.Download.Manager_1.0.9_x64-setup.exe` | `118,170,722` | `460f5da00d09267a5f33274645250d92162bbfa3605f0348cc656a39a8a19ead` | `NotSigned` | **VERIFIED** |
| `TORI.Download.Manager_1.0.9_x64-setup.exe.sig` | `436` | `9fd6f9e8a46e93dd1e1f6212b9d174aba3cc23761c55704f2a407965cb385aa0` | N/A (Ed25519) | **VERIFIED** |
| `tori-download-manager.exe` | `32,290,304` | `94995ea2eae40ec9101dd9f5f08f64ff717662143e8db936aae650f7daf17442` | `NotSigned` | **VERIFIED** |
| `tdm-native-host.exe` | `19,449,344` | `90cbb76fe03c42b03736df78262b3486068f410d604c664d5e22fd4c7247479f` | `NotSigned` | **VERIFIED** |
| `tdm-cli.exe` | `17,102,848` | `f25c29376e27d3a1025bbc39d09bae273c21d1fa6da4b62f44e0eea93a6ac368` | `NotSigned` | **VERIFIED** |
| `draft_latest.json` | `2,014` | `14fcf28af1ef6a41edb5baffb5ef3a965a885cb1505249420761747d730de5ed` | N/A (JSON) | **VERIFIED** |

### Cryptographic Verification Evidence

1. **Tauri Ed25519 Installer Signature (`CDC23D8CC8DA5397`):**
   - Verified in **Rust** (`updater_cryptography_tests`, `11/11` PASS, including `test_gate36_1_v109_release_candidate_cryptographic_and_stage1_dual_key_integrity`) AND independently in **Node.js** (`scripts/publish_desktop_v1_0_9.js --dry-run` using `crypto.verify`).
   - Trusted comment: `timestamp:1795660656\tfile:TORI Download Manager_1.0.9_x64-setup.exe`.
   - **Tamper rejection:** Mutating 1 byte in the middle of the installer payload is strictly rejected (`tamper_rejection_verified: true`).
2. **Updater Metadata Parity (`latest.json`):**
   - Staged `release/v1.0.9-public-staging/latest.json` (`1,692` B, UTF-8 no-BOM, SHA-256 `5eb975dba32daa36cbaa381bff0c949ea02fb850ea35897f66d64a4d5bd2b70f`).
   - Exact signature string matches `TORI.Download.Manager_1.0.9_x64-setup.exe.sig` byte-for-byte.
   - URL matches GitHub's dotted upload normalization (`https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.9/TORI.Download.Manager_1.0.9_x64-setup.exe`) across both `windows-x86_64` and `windows-x86_64-nsis` platform keys (matching `v1.0.8` convention).
   - SemVer ordering verified: `1.0.8 < 1.0.9`.
3. **Stage 1 Dual-Key External Tools Keyring & Purpose Separation:**
   - Binary inspection (`G361-01`) + Rust tests (`external_tools_security_matrix_tests`, `5/5`) confirm `tori-download-manager.exe` embeds both `C3FD6626A3718E63` (dedicated tools public key, SHA-256 `6807e183f56c08eb06fdff95347bbbf7174b4ce5185b0245155db315e87fee39`) and `CDC23D8CC8DA5397` (legacy shared key) with `allow_legacy_shared_key = true`.
   - Production External Tools manifest at `https://toridownload.xyz/assets/tools/tools-manifest.json` remains **revision 2** (`schema_version=2`, signed by `CDC23D8CC8DA5397`, SHA-256 `caa2d4ed2a7e424badcd8662e67b986a3fdfbf2847dded0625ea2b2547663f3a`, detached `.sig` `408` B). Stage 2 dedicated-key-only cutover remains **DISABLED**.
4. **Zero Signing Secrets:**
   - Automated scan across `release/v1.0.9-rc/`, `release/v1.0.9-public-staging/`, publisher script, checklist, runbook, and website patch returned **`0` secret patterns** and `0` `.key`/`.pwd`/`.pfx` files (`no_secrets_in_staging: true`).

---

## 4. Executed Regression, Upgrade & Compatibility Verification

Every test count below was executed directly during Gate 36.2 with bounded timeouts and archived logs in `target/gate36_2_qa_logs/`:

| Suite / Command | Scope | Executed Result | Duration |
| :--- | :--- | :---: | ---: |
| `cargo test -p tdm-core --test external_tools_security_matrix_tests` | Stage 1 dual-key keyring, rev 2 manifest continuity, cross-purpose signature rejection | **5 / 5 PASS** | `16.05s` |
| `cargo test -p tdm-core --test gate35_2_content_range_tests` | Valid/malformed `Content-Range`, `200 OK` fallback, `206` mismatch (`0-(N-1)/N`), ETag & `Last-Modified` change, HTTP `416` recovery, restart/resume, corruption prevention, partial preservation | **11 / 11 PASS** | `0.38s` |
| `cargo test -p tdm-core --test gate35_2_startup_and_tray_tests` | Hidden `--minimized` startup, startup popup suppression, close-to-tray, progress window behavior | **5 / 5 PASS** | `0.00s` |
| `cargo test -p tdm-core --test gate35_security_hardening_tests` | Gate 35.1 security hardening controls (URL/path/protocol/auth boundaries) | **10 / 10 PASS** | `11.76s` |
| `cargo test -p tdm-core --test updater_cryptography_tests` | Ed25519 installer signature, tamper rejection, SemVer upgrade checks, Stage 1 dual-key integrity | **11 / 11 PASS** | `5.80s` |
| `cargo test -p tdm-native-host` | Native-host unit tests (`12`), spawn-mutex serialization, CORS/origin allowlist, DNS rebinding, framing, coalescing (`8`), server security (`8`), perf/API/referer/UA (`4`) | **32 / 32 PASS** | `51.69s` |
| `node scripts/verify_gate36_1_v109_rc.js` | Real isolated `v1.0.8` → `v1.0.9` upgrade, SQLite/settings/partial preservation, live broken-CDN `206` → `200` single-stream recovery, `4x` concurrent native-host mutex, rev 2 manifest | **12 / 12 PASS** | `6.82s` |
| `node scripts/verify_gate35_3_signed_firefox.js` *(vs `v1.0.9` RC)* | Live Public Mozilla-signed Firefox Companion `v1.0.11` XPI (`4cd6d6fb...`): `v1.0.10` → `v1.0.11` upgrade, permanent `SIGNEDSTATE_SIGNED`, offline no-spawn, pairing, overlay/intercept download, adversarial blocking, restart no-replay | **15 / 15 PASS** | `27.70s` |
| `node scripts/verify_gate35_3_real_browsers.js` *(vs `v1.0.9` RC)* | Live Public Chromium `v1.0.11` ZIP (`1e77592b...`) across Chrome, Edge, and Firefox against `v1.0.9` RC: offline startup, migration, Native Messaging pairing, live adversarial blocks, overlay/intercept SHA-256 downloads, dedup, restart no-replay, HKCU registry restore | **32 / 32 PASS** | `38.17s` |
| `node scripts/verify_gate35_2_extension_security.js` | `SEC-35-04` boundary enforcement VM matrix (Chromium + Firefox), zero `__TORI_DISPATCH__`, closed Shadow DOM, `isTrusted` guards, no `externally_connectable` | **30 / 30 PASS** | `0.36s` |
| `node scripts/publish_desktop_v1_0_9.js --dry-run` | 16-asset local staging, Ed25519 & tamper check, secret scan, read-only GitHub API checks (`0` remote writes) | **PASS (0 writes)** | `3.98s` |
| Bundled Tool Binary Check (`resources/bin/`) | `ffmpeg.exe` (`N-126374-g089a48eb36-20260831`), `ffprobe.exe` (`N-126374-g089a48eb36-20260831`), `yt-dlp.exe` (`2026.08.19`) | **3 / 3 PASS** | `<1s` |

- **Gate 36.2 Executed Total:** **`163 / 163` automated assertions PASS, `0` FAIL, `0` BLOCKED** (complementing Gate 36.1's `314/314` full Rust workspace tests, `cargo clippy` `0` errors, and `ui` lint/build `0` errors on identical commit `b60770b1`).
- **Real Isolated `v1.0.8` → `v1.0.9` Upgrade Details (`G361-03`..`G361-12`):**
  - Booted frozen public `v1.0.8` in an isolated AppData/download sandbox, completed baseline download (`shaMatch=true`), snapshotted SQLite (`downloads=1, chunks=1, closeToTray=true`), planted a pre-existing `.tdm-part` file, then booted frozen `v1.0.9` RC in `--minimized` mode over the same data directory.
  - Verified SQLite `PRAGMA integrity_check == ok`, baseline download retained, `closeToTray == true`, theme/accent intact, and pre-existing `.tdm-part` file bit-for-bit untouched.
  - Executed a live download against an adversarial mock CDN returning mismatched `206` (`bytes 0-(N-1)/N`); `v1.0.9` RC cleanly fell back to safe single-stream `200 OK` (`range206Hits=1, full200Hits=1`), produced exact SHA-256 (`shaMatch=true`), and left unrelated `.tdm-part` intact.
  - Executed `4x` concurrent `v1.0.9` `tdm-native-host.exe` stdio requests simultaneously against live `v1.0.9` RC (`okCount=4/4`, zero spawn stampede).

---

## 5. Clean Windows 10 & Windows 11 OS QA Assessment

### Host & CI Environment Audit

- **Local Clean Virtualization Inventory:**
  - VirtualBox (`VBoxManage`): `NONE`
  - VMware (`vmrun`): `NONE`
  - QEMU (`qemu-system-x86_64`): `NONE`
  - Windows Sandbox (`WindowsSandbox.exe`): `NONE`
  - Hyper-V VMs (`Get-VM`): `0`
- **GitHub Actions CI Workflow Audit:**
  - `.github/workflows/clean-windows-release-qa.yml` exists on the Gate 35.1+ release lineage (`feat/gate36_2-desktop-v109-prepublish`), configured for `windows-2022` and `windows-2025` runners, but is **`NOT_YET_ON_MASTER`** (`origin/master` @ `62715926` predates Gate 35.1). Because GitHub's `workflow_dispatch` requires the workflow file to reside on the default branch, CI-based clean Windows runner validation cannot be triggered without first landing the workflow on `master` (prohibited in Gate 36.2 without separate owner authorization).

### Classification & Risk Assessment

- **Windows 10 Clean OS QA:** **`CLEAN_WINDOWS_QA_NOT_TESTED`**
- **Windows 11 Clean OS QA:** **`CLEAN_WINDOWS_QA_NOT_TESTED`**
- Isolated sandboxes and browser profiles on the operator's development Windows host are explicitly **NOT** counted as clean operating-system validation.
- **Residual Risk (`RISK-36-02`):** Fresh NSIS installer first-run UX (WebView2 runtime bootstrapping on clean Windows 10, Windows Defender/SmartScreen behavioral heuristics on unsigned binary, clean-machine `HKCU` Native Messaging host registration, and Windows 10/11 startup registry behavior) has not yet been executed on virgin Windows 10/11 OS images. Mitigated partially by unchanged NSIS `hooks.nsh` structure from `v1.0.8` and verified isolated `v1.0.8` → `v1.0.9` binary upgrade, but still requires explicit owner testing or formal risk disposition before public release.

---

## 6. Windows Authenticode & Key Custody Audit

### Authenticode Status

- `Get-AuthenticodeSignature` executed on all four frozen `v1.0.9` PE binaries:
  - `TORI.Download.Manager_1.0.9_x64-setup.exe`: **`NotSigned`**
  - `tori-download-manager.exe`: **`NotSigned`**
  - `tdm-native-host.exe`: **`NotSigned`**
  - `tdm-cli.exe`: **`NotSigned`**
- No commercial EV/OV Windows Authenticode certificate is configured; WDK/self-signed test certificates are strictly prohibited for production releases. Tracked independently as **`RISK-36-03`**.

### Dedicated External Tools Signing Key Custody

- Executed `scripts/provision_dedicated_tools_key.ps1 -Mode VerifyProductionKey`:
  - Result: **`VALID_PRODUCTION_KEY`**
  - Key ID: `C3FD6626A3718E63`
  - Public Key SHA-256: `6807e183f56c08eb06fdff95347bbbf7174b4ce5185b0245155db315e87fee39`
  - Controls verified: `encryptedScryptKey=true`, `ntfsAclOwnerOnly=true`, `noPlaintextPwdFile=true`, `independentFromUpdater=true`.
- **Offline Backup & Recovery Status:** **`BACKUP_RECOVERY_NOT_VERIFIED`** (existing key preserved untouched; never regenerated or rotated; Stage 2 dedicated-key-only cutover remains strictly disabled and blocked until `-Mode VerifyBackup` passes). Tracked independently as **`RISK-36-01`**.

---

## 7. GitHub Release Preparation & Dry-Run Results

Audited live Desktop `v1.0.8` (GitHub Release ID `455125259`) and mirrored its exact **16-asset** contract into `release/v1.0.9-public-staging/` via `scripts/publish_desktop_v1_0_9.js --dry-run` (safe dry-run default; `0` remote writes):

| # | Staged Asset (`release/v1.0.9-public-staging/`) | Bytes | SHA-256 |
| :-: | :--- | ---: | :--- |
| 1 | `TORI.Download.Manager_1.0.9_x64-setup.exe` | `118,170,722` | `460f5da00d09267a5f33274645250d92162bbfa3605f0348cc656a39a8a19ead` |
| 2 | `TORI.Download.Manager_1.0.9_x64-setup.exe.sig` | `436` | `9fd6f9e8a46e93dd1e1f6212b9d174aba3cc23761c55704f2a407965cb385aa0` |
| 3 | `latest.json` | `1,692` | `5eb975dba32daa36cbaa381bff0c949ea02fb850ea35897f66d64a4d5bd2b70f` |
| 4 | `tori-download-manager.exe` | `32,290,304` | `94995ea2eae40ec9101dd9f5f08f64ff717662143e8db936aae650f7daf17442` |
| 5 | `tdm-native-host.exe` | `19,449,344` | `90cbb76fe03c42b03736df78262b3486068f410d604c664d5e22fd4c7247479f` |
| 6 | `tdm-cli.exe` | `17,102,848` | `f25c29376e27d3a1025bbc39d09bae273c21d1fa6da4b62f44e0eea93a6ac368` |
| 7 | `SHA256SUMS.txt` | `912` | `109b3aeff047043ee6e1c98412495e17639438c1f70cbed4b585d5aac45d13af` |
| 8 | `RELEASE_NOTES_v1.0.9.md` | `5,184` | `27d9f8385d987c6f5a62d0157a25444f98c1c558c83eac0b4585432dd56af74c` |
| 9 | `INSTALLATION_AND_UPGRADE.md` | `2,096` | `fba2b6fd35ab39ddb51c9e0a7b43c1367da3159136c852d162e9f72519ac80f2` |
| 10 | `BUILD_METADATA.json` | `2,662` | `bfb58e6ed1dc790f12a1437f5d2cbdcc23d98370736439b8385ed46a09d433e2` |
| 11 | `RELEASE_MANIFEST.json` | `974` | `38dbcf5a5186ca4c482299b1fb7e025529e0fc6d02239142c5123157da6ad14d` |
| 12 | `LICENSE` | `1,465` | `55460ef099ce57e32d422427a7a24cd1e09aec677606289e396c2c17d625a598` |
| 13 | `LICENSE-MIT` | `1,092` | `dffcef788fe594963f082966daa3b969c7c4f633e612d8f88ee8a3033c4a5144` |
| 14 | `LICENSE-APACHE` | `9,899` | `20fe7b00e904ed690e3b9fd6073784d3fc428141dbd10b81c01fd143d0797f58` |
| 15 | `LICENSE-GPLv3.txt` | `35,147` | `8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903` |
| 16 | `LICENSE-THIRD-PARTY.txt` | `4,421` | `4f05486cb940a151e9b010ff3d033b7fb06370c665d174eb5d54d48433eb6035` |

### Read-Only Remote API Verification (`release/v1.0.9-public-staging/github_publish_dry_run_report.json`)

- `github_permissions`: `httpStatus: 200`, `push: true`, `admin: true`
- `current_latest_stable`: `tag_name: "v1.0.8"`, `release_id: 455125259`, `desktopV108Preserved: true`
- `target_tag_v1_0_9`: `httpStatus: 404`, `alreadyPublished: false`
- `public_companion_v1_0_11`: `httpStatus: 200`, `release_id: 458864802`, `intact: true`
- `safety_assertions`: `frozen_rc_untouched: true`, `exact_v108_asset_convention_matched: true`, `no_secrets_in_staging: true`, **`remote_writes_performed: 0`**

---

## 8. Local Website Release Preparation (`toridownload.xyz`)

- **Local Repository:** `C:\Users\ritud\Downloads\tori-website`
- **Production `main` Branch (UNTOUCHED & CHECKED OUT):** `3edb4293b09e16921877381394a8be38e5d3d02c` (live Cloudflare Pages Deployment ID `723c6191-1b46-41b4-aa1b-bd55ae938357`)
- **Staged Local Prep Branch (NOT PUSHED / NOT DEPLOYED):** `feat/gate36_2-desktop-v109-website-prep` @ **`330846d19333a9b98bea83d52bf95c2c3a4a1eef`** (`index.html`, `+50 / -37` lines)
- **Archived Patch:** `docs/release/GATE36_2_WEBSITE_DESKTOP_V109_DIFF.patch` (mirrored to `release/v1.0.9-public-staging/website_desktop_v109.patch`, `22,699` chars)
- **Verified Scope & Preservation Assertions (`ALL_WEBSITE_ASSERTIONS_PASS`):**
  - Updates Desktop hero/installer download links, size (`112.7 MB`), SHA-256 (`460f5da0...`), JSON-LD (`softwareVersion: "1.0.9"`, `JSON_LD_OK`), and JS blocks (`JS_BLOCK_1_OK`, `JS_BLOCK_2_OK`) to `v1.0.9`, adding `v1.0.8` to `FALLBACK_RELEASES`.
  - Preserves **100%** of Public Browser Companion `v1.0.11` (`extension-v1.0.11`, signed Firefox XPI `4cd6d6fb...`, Chromium ZIP `1e77592b...`), historical rollback Firefox XPI `v1.0.10`, and External Tools Manifest revision 2 (`caa2d4ed...`) + detached `.sig`.

---

## 9. Release Risk Register (Independent Desktop v1.0.9 Governance)

None of the risks below are inherited as accepted from Desktop `v1.0.8`. Public release requires separate explicit owner release authorization and recorded disposition for each unresolved risk:

| Risk ID | Title | Current Measured State | Severity | Required Owner Disposition Before Publish |
| :--- | :--- | :--- | :---: | :--- |
| **`RISK-36-01`** | Dedicated External Tools Key (`C3FD6626A3718E63`) Offline Backup & Recovery Unverified | **`BACKUP_RECOVERY_NOT_VERIFIED`** *(key itself is `VALID_PRODUCTION_KEY`; Stage 2 cutover disabled)* | High (for Stage 2) / Medium (for Stage 1) | Verify offline backup via `provision_dedicated_tools_key.ps1 -Mode VerifyBackup` OR record explicit owner Stage 1 waiver (Stage 2 cutover remains strictly blocked). |
| **`RISK-36-02`** | Clean Windows 10 & Windows 11 OS Installation / Upgrade QA Not Executed | **`CLEAN_WINDOWS_QA_NOT_TESTED`** *(`0` local VMs/Sandbox; CI workflow not yet on `origin/master`)* | High | Execute clean Windows 10 & 11 installation/upgrade QA (physical/VM or CI after landing workflow on `master`) OR record explicit owner waiver. |
| **`RISK-36-03`** | Windows Authenticode Commercial Code Signing Missing | **`NotSigned`** *(installer + all 3 EXEs unsigned; WDK test cert prohibited)* | Medium–High | Provision commercial EV/OV Authenticode cert & sign release binaries OR record explicit owner waiver with SmartScreen user guidance. |
| **`RISK-36-04`** | `v1.0.9`-Specific Regression or Packaging Defects | **Resolved / No Open Defects** *(UTF-8 BOM observed in PowerShell-generated `draft_latest.json` caught and eliminated in UTF-8 no-BOM `latest.json`)* | Closed | Verified fixed (`latest.json` valid UTF-8 no-BOM, exact Ed25519 parity, `163/163` QA assertions passed). |

---

## 10. Rollback, Incident Containment & Preservation Evidence

- **Publication & Rollback Runbook:** `docs/release/GATE36_2_DESKTOP_V109_PUBLICATION_RUNBOOK.md`
  - **GitHub & Auto-Updater Instant Rollback:** Mark `v1.0.9` as `prerelease: true` / `draft: true`, patch `v1.0.8` (ID `455125259`) with `make_latest: "true"`, verify `/releases/latest` and `/releases/latest/download/latest.json` immediately revert to `1.0.8`. Never delete or overwrite `v1.0.8` signed artifacts; SQLite schema changes are strictly additive.
  - **Website Instant Rollback:** Roll back Cloudflare Pages directly to verified deployment **`723c6191-1b46-41b4-aa1b-bd55ae938357`** (`3edb4293b09e16921877381394a8be38e5d3d02c`, Desktop `v1.0.8` + Companion `v1.0.11`) or revert `main` on `tori-website-private`.
- **Operator & Production Preservation Verified Post-QA:**
  - Public Desktop: `v1.0.8` (GitHub Release ID `455125259`, Latest Stable untouched)
  - Public Browser Companion: `v1.0.11` (GitHub Release ID `458864802`, live on `toridownload.xyz` untouched)
  - Production External Tools Manifest: revision 2 (`caa2d4ed2a7e424badcd8662e67b986a3fdfbf2847dded0625ea2b2547663f3a`, untouched)
  - Operator OEM Desktop `v1.0.6` (`570833b379668f64d8f0a81e0a2c138635835e0c0382f37f24ec969caccf0fda`), OEM SQLite (`ok`, `56` downloads, `531` `download_chunks`, `7` `engine_settings`), `21` `.tdm-part` files, all 3 HKCU `NativeMessagingHosts` keys (`Chrome`, `Edge`, `Mozilla`), and `0` stray `tori-download-manager` processes verified intact.

---

## 11. Final Gate 36.2 Verdict

**`CONDITIONAL GO`** — Desktop `v1.0.9` has passed every authorized local preflight, cryptographic, regression, upgrade, Companion `v1.0.11` compatibility, GitHub 16-asset dry-run staging, website staging, and preservation check with zero technical failures and zero remote mutations. Public release remains **NOT PERFORMED** pending separate explicit owner authorization and explicit disposition of **`RISK-36-01`**, **`RISK-36-02`**, and **`RISK-36-03`**.
