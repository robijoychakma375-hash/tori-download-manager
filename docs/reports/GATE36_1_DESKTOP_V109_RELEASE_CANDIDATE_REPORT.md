# TORI Download Manager — Gate 36.1 Desktop v1.0.9 Release Candidate Report

**Date:** 2026-11-26  
**Gate:** Gate 36.1 — Desktop `v1.0.9` Release Candidate Preparation  
**Final Verdict:** **`CONDITIONAL GO`** *(All local code integration, cryptographic Tauri Ed25519 signing/verification, 314/314 Rust workspace tests, Clippy/UI builds, 12/12 isolated `v1.0.8` → `v1.0.9` upgrade & live broken-CDN `Content-Range` fallback checks, and 77/77 Public Browser Companion `v1.0.11` compatibility & security checks PASSED; public release remains NOT AUTHORIZED and gated on Clean Windows 10/11 VM verification [`NOT TESTED` locally], Windows Authenticode code signing [`NotSigned`], offline dedicated tools key backup verification [`BACKUP_VERIFICATION_DEFERRED_BY_OWNER`], and explicit separate owner publication authorization).*  
**Public Release Performed:** **NO (NOT AUTHORIZED)**  
**Release Candidate Branch:** `release/gate36_1-desktop-v109-rc` (local only, unpushed)  
**Verified Local Checkpoint:** `checkpoint-gate36_1-desktop-v109-rc-verified`

---

## 1. Executive Summary & Verified Baselines

Gate 36.1 prepared, built, cryptographically signed, and verified the local Windows x64 **TORI Download Manager Desktop `v1.0.9` Release Candidate** under `release/v1.0.9-rc/` without publishing or altering any public release, website, production manifest, signing key, or operator OEM environment.

### Git Lineage & Conflict-Free Integration Audit
- **Base Checkpoint:** `checkpoint-gate35_5-companion-v1011-public-security-hotfix-released` (`169e8641b78d9f35833cb790de3fab52e13c55e4`)
- **Gate 35.1 Hardening Commit:** `cb885d48cfcfc1557489a033984e12037c10ea80` — verified linear ancestor (`git merge-base --is-ancestor` = `True`, `0` conflicts, `0` dropped fixes)
- **Gate 35.2 Bug & Security Fix Commit:** `48184cb2b6d05d25e3ffc47f967f4ca11a82a025` — verified linear ancestor (`git merge-base --is-ancestor` = `True`, `0` conflicts, `0` dropped fixes)
- **External Tools Expiry Monitor (`origin/master` `62715926`):** Verified all 8 files already cleanly present from Gate 33.2 ancestor `848d26c5`.
- **Desktop Version Metadata Updated Consistently to `1.0.9`:**
  - `Cargo.toml` (`[workspace.package].version = "1.0.9"`, inherited by `tdm-core`, `tdm-cli`, `tdm-native-host`, `tori-download-manager`)
  - `src-tauri/tauri.conf.json` (`"version": "1.0.9"`; Tauri updater pubkey `CDC23D8CC8DA5397` unchanged)
  - `ui/package.json` (`"version": "1.0.9"`)
  - `ui/src/components/SettingsModal.tsx` (`appVersion` & `updateStatus.currentVersion` defaults updated to `'1.0.9'`)
  - Verified compiled Windows PE `ProductVersion`: `tori-download-manager.exe` = **`1.0.9`**, `TORI.Download.Manager_1.0.9_x64-setup.exe` = **`1.0.9`**.
  - Browser Companion source (`extension/` & `extension/firefox/`) remained strictly untouched at published `v1.0.11`.

---

## 2. Frozen Desktop `v1.0.9` Release Candidate Artifacts (`release/v1.0.9-rc/`)

Built cleanly on Windows x64 (`cargo build --release -p tdm-native-host -p tdm-cli` in `36.47s`, followed by `scripts/build_nsis_installer.ps1` NSIS bundle + Tauri Ed25519 updater signing in `202.31s`, and `scripts/stage_v1_0_9_rc.ps1` with strict UTF-8 no-BOM JSON encoding):

| Artifact | Bytes | Verified SHA-256 | Notes |
| :--- | ---: | :--- | :--- |
| **`TORI.Download.Manager_1.0.9_x64-setup.exe`** | `118,170,722` | `460f5da00d09267a5f33274645250d92162bbfa3605f0348cc656a39a8a19ead` | Windows PE (`MZ`), ProductVersion `1.0.9`, Authenticode: `NotSigned` |
| **`TORI.Download.Manager_1.0.9_x64-setup.exe.sig`** | `436` | `9fd6f9e8a46e93dd1e1f6212b9d174aba3cc23761c55704f2a407965cb385aa0` | Tauri Ed25519 Minisign signature (`CDC23D8CC8DA5397`), cryptographically verified |
| `tori-download-manager.exe` | `32,290,304` | `94995ea2eae40ec9101dd9f5f08f64ff717662143e8db936aae650f7daf17442` | Embeds Stage 1 dual-key IDs (`CDC23D8CC8DA5397` + `C3FD6626A3718E63`), `0` private key markers |
| `tdm-native-host.exe` | `19,449,344` | `90cbb76fe03c42b03736df78262b3486068f410d604c664d5e22fd4c7247479f` | Includes Gate 35.2 cross-process named spawn mutex (`EngineSpawnMutexGuard`) |
| `tdm-cli.exe` | `17,102,848` | `f25c29376e27d3a1025bbc39d09bae273c21d1fa6da4b62f44e0eea93a6ac368` | Valid Windows PE |
| `draft_latest.json` | `2,014` | `14fcf28af1ef6a41edb5baffb5ef3a965a885cb1505249420761747d730de5ed` | Unpublished draft (`version: "1.0.9"`, UTF-8 no-BOM, exact `.sig` match) |
| `RELEASE_NOTES_v1.0.9.md` | `5,184` | `27d9f8385d987c6f5a62d0157a25444f98c1c558c83eac0b4585432dd56af74c` | Staged copy of `docs/release/GATE36_1_DESKTOP_V109_RELEASE_NOTES.md` |
| `BUILD_METADATA.json` | `2,714` | Verified UTF-8 no-BOM | `published: false`, `stage1_dual_key_active: true`, `dedicated_only_cutover_active: false` |
| `SHA256SUMS.txt` | `664` | Verified UTF-8 no-BOM | Checksums for all 7 RC deliverables |

### Cryptographic & Key Custody Verification
- **Tauri Desktop Updater Signature (`test_gate36_1_v109_release_candidate_cryptographic_and_stage1_dual_key_integrity`):** **PASS (`5.85s`)**
  - Verified `TORI.Download.Manager_1.0.9_x64-setup.exe.sig` against embedded Tauri updater public key `CDC23D8CC8DA5397` (`src-tauri/tauri.conf.json`).
  - Confirmed 1-byte mid-installer tampering is strictly rejected.
  - Confirmed UTF-8 no-BOM `draft_latest.json` parses cleanly via `serde_json`, `1.0.8 < 1.0.9`, and matches `.sig` verbatim. *(Note: During Gate 36.1 staging, this test caught a PowerShell 5.1 UTF-8 BOM in `draft_latest.json`, which was immediately fixed in `scripts/stage_v1_0_9_rc.ps1` using `UTF8Encoding($false)`.)*
  - Confirmed zero `.key` or `.pwd` files inside `release/v1.0.9-rc/` and zero secrets logged or exposed.
- **Stage 1 Dual-Key External Tools Compatibility:** Verified `TrustedToolsKeyring::default_production_transition()` retains both legacy shared key `CDC23D8CC8DA5397` and dedicated active key `C3FD6626A3718E63` (`allow_legacy_shared_key = true`, `keys.len() = 2`, dedicated-only cutover **DISABLED**), and verified live production `https://toridownload.xyz/assets/tools/tools-manifest.json` remains revision 2 (`caa2d4ed2a7e424badcd8662e67b986a3fdfbf2847dded0625ea2b2547663f3a`, detached `.sig` `408` bytes).

---

## 3. Executed Gate 36.1 QA & Regression Matrix (**403 / 403 Automated Checks PASS**)

| Suite / Verification | Command / Script | Result | Count | Duration | Log Path |
| :--- | :--- | :---: | :---: | :---: | :--- |
| UI Lint (`oxlint`) | `npm --prefix ui run lint` | **PASS** | `0` errors (`7` pre-existing warnings) | < 2s | `target/gate36_1_qa_logs/ui_lint.log` |
| UI Production Build (`tsc -b && vite build`) | `npm --prefix ui run build` | **PASS** | 46 modules (`380.89 kB` bundle) | `1.4s` | `target/gate36_1_qa_logs/ui_build.log` |
| Rust Workspace Clippy | `cargo clippy --workspace --all-targets` | **PASS** | `0` errors (`69` pre-existing warnings) | ~45s | `target/gate36_1_qa_logs/cargo_clippy.log` |
| Full Rust Workspace Test Suite | `cargo test --workspace` | **PASS** | **314 / 314** (44 binaries, `0` failed, `0` ignored) | `355.64s` | `target/gate36_1_qa_logs/cargo_test_workspace.log` |
| Signed `v1.0.9` RC Cryptographic & Keyring Test | `cargo test -p tdm-core --test updater_cryptography_tests test_gate36_1_v109...` | **PASS** | **1 / 1** (Ed25519 verify + tamper reject + Stage 1 dual-key) | `5.85s` | `target/gate36_1_qa_logs/verify_v109_crypto.log` |
| Isolated `v1.0.8` → `v1.0.9` Upgrade, Broken-CDN `Content-Range`, Native Host & Tools Rev 2 QA | `node scripts/verify_gate36_1_v109_rc.js` | **PASS** | **12 / 12** (`0` fail) | `6.31s` | `target/gate36_1_qa_logs/v109_upgrade_and_engine_qa.log` |
| Public Companion `v1.0.11` Signed Firefox QA vs Desktop `v1.0.9` RC | `verify_gate35_3_signed_firefox.js` (`TORI_DESKTOP_EXE=v1.0.9-rc`, `TORI_SIGNED_V1011_XPI=public`) | **PASS** | **15 / 15** (`0` fail) | `28.60s` | `target/gate36_1_qa_logs/v109_companion_v1011_signed_firefox.log` |
| Public Companion `v1.0.11` Chrome/Edge/Firefox QA vs Desktop `v1.0.9` RC | `verify_gate35_3_real_browsers.js` (`TORI_DESKTOP_EXE=v1.0.9-rc`, `TORI_CHR_EXT_DIR=public`) | **PASS** | **32 / 32** (`0` fail, `0` blocked) | `37.05s` | `target/gate36_1_qa_logs/v109_companion_v1011_real_browsers.log` |
| `SEC-35-04` Extension Security VM Recheck | `node scripts/verify_gate35_2_extension_security.js` | **PASS** | **30 / 30** (`0` fail) | `0.40s` | `target/gate36_1_qa_logs/v109_extension_security_vm.log` |
| Clean Windows 10 / Windows 11 VM Tests | Host hypervisor audit (`VBoxManage=NONE`, `vmrun=NONE`, `qemu=NONE`, `WindowsSandbox=NONE`, `HyperV_VMs=0`) | **`NOT TESTED`** | `0` VMs available locally | — | Disclosed honestly below |

### Highlighted Domain Verification Proof
1. **`Content-Range`, ETag, `416` & Corruption Prevention (Objective 4):**
   - `gate35_2_content_range_tests`: **11 / 11 PASS** (probe `206` mismatch rejection, missing/malformed `Content-Range` corruption block, mid-download `ETag`/`Last-Modified` change corruption block, `416` recovery, bounded single-stream fallback, unrelated `.tdm-part` preservation).
   - Live compiled `v1.0.9` RC test (`G361-08`): Queued a 1 MiB download from a broken-CDN fixture returning `206 bytes 0-1048575/1048576` — `v1.0.9` RC probed once (`range206Hits=1`), immediately switched to single-stream (`full200Hits=1`), completed with exact 1 MiB SHA-256 (`shaMatch=true`), and left pre-existing unrelated `preserved_partial.bin.tdm-part` untouched (`unrelatedPartIntact=true`).
2. **Windows Startup Policy, Hidden Launch, Spawn Mutex & Tray (Objective 5):**
   - `gate35_2_startup_and_tray_tests`: **5 / 5 PASS** (`--minimized` hidden launch, suppression of auto-opened `Failed`/`Cancelled` popups, `force=true` user clicks & Close-to-Tray preserved).
   - `tdm_native_host::ipc::tests`: **2 / 2 PASS** (deterministic pipe-scoped `EngineSpawnMutexGuard` + concurrent serialization).
   - Live `v1.0.9` RC `G361-06`, `G361-09`, `G361-10`: Booted cleanly with `--minimized`, single and 4x concurrent `v1.0.9` `tdm-native-host.exe` stdio `pair` invocations succeeded `4/4` cleanly without spawn stampedes.
3. **Real Isolated `v1.0.8` → `v1.0.9` Upgrade (`G361-03..07`, `G361-12`):**
   - Booted frozen public Desktop `v1.0.8`, seeded `closeToTray=true`, `theme=dark`, `accent=emerald`, completed baseline download, and created pre-existing `preserved_partial.bin.tdm-part` (`128 KiB`).
   - Stopped `v1.0.8` and launched compiled `v1.0.9` RC over the identical `data/` directory — verified SQLite `PRAGMA integrity_check = ok`, all downloads & settings preserved, `preserved_partial.bin.tdm-part` bit-for-bit identical, and post-upgrade downloads cleanly persisted.
4. **Public Browser Companion `v1.0.11` Compatibility Report (Objective 6):**
   - Tested the **actual publicly downloaded** Companion `v1.0.11` Signed Firefox XPI (`4cd6d6fb...`) and Chromium ZIP (`1e77592b...`) against the newly compiled **`release/v1.0.9-rc/tori-download-manager.exe`** + **`release/v1.0.9-rc/tdm-native-host.exe`**:
     - **Signed Firefox (`15 / 15 PASS`):** Permanent `SIGNEDSTATE_SIGNED` upgrade `v1.0.10` → `v1.0.11`, 2 full restarts, cold offline zero-spawn, Native Messaging pairing with Desktop `v1.0.9` RC, popup auth with zero token leak, live adversarial suite blocked, overlay media capture + intercepted download SHA-256 match, dedup, zero stale replay after restart. *(Note: An initial run hit a transient Marionette `WebDriver:NewSession` 15s timeout on restart with `[REG_RESTORE]` succeeding; the subsequent clean run passed `15 / 15` in `28.60s`.)*
     - **Chrome & Edge (`32 / 32 PASS` incl. temp Firefox):** Extension ID `jfnfgmcbgapcpieaonbaolgebjaejcdm` preserved, cold offline startup `nmInvocations=0`, settings migration, Native Messaging pairing with Desktop `v1.0.9` RC, popup/options auth, live adversarial attacks blocked, overlay media capture & intercepted download exact SHA-256, dedup, zero stale history replay across restart, and bit-for-bit HKCU registry restoration.

---

## 4. Production & Operator User-Data Preservation

| Protected Asset | Verified Post-Gate 36.1 State | Status |
| :--- | :--- | :---: |
| Public Desktop `v1.0.8` (GitHub Latest Stable + Local) | Release ID `455125259`, `/releases/latest = v1.0.8`, local installer `728d0d25...` | **INTACT** |
| Public Browser Companion `v1.0.11` (GitHub + Local) | Release ID `458864802`, Signed XPI `4cd6d6fb...`, Chromium ZIP `1e77592b...` | **INTACT** |
| Production External Tools Manifest Rev 2 | `https://toridownload.xyz/assets/tools/tools-manifest.json` (`rev 2`, `CDC23D8CC8DA5397`, `caa2d4ed...`) | **INTACT** |
| Stage 2 Dedicated-Only Tools Signing | `DISABLED` (`allow_legacy_shared_key = true`) | **INTACT** |
| Production Signing Keys (`tori-updater.key`, `tori-tools.key`) | Untouched; never regenerated or printed | **INTACT** |
| Operator OEM Installed Desktop (`v1.0.6`) | `570833b379668f64d8f0a81e0a2c138635835e0c0382f37f24ec969caccf0fda` | **INTACT** |
| Operator SQLite (`tdm_storage.sqlite`) | `PRAGMA integrity_check = ok`, `56` downloads, `531` `download_chunks`, `7` `engine_settings` | **INTACT** |
| Operator `.tdm-part` Partial Downloads | `21` files intact | **INTACT** |
| Operator HKCU `NativeMessagingHosts` (Chrome, Edge, Mozilla) | Restored bit-for-bit to exact pre-Gate 36.1 baseline | **INTACT** |
| Stray `tori-download-manager` Processes | `0` | **CLEAN** |

---

## 5. Security Findings, Risk Register & Rollback Plan

### Security Findings
- **Zero new vulnerabilities introduced** in Desktop `v1.0.9` RC; all 10 Gate 35.1 security hardening tests, 30/30 `SEC-35-04` VM checks, and live Chrome/Edge/Signed Firefox adversarial tests PASSED.
- **Staging Hygiene Catch Resolved:** PowerShell 5.1 UTF-8 BOM in `draft_latest.json` caught by `updater_cryptography_tests` and fixed cleanly via `UTF8Encoding($false)`.
- **Secret Scan:** Clean (`0` real credentials/keys across all staged RC artifacts, scripts, and reports).

### Active Risk Register

| Risk ID | Severity | Description | Current Status / Mitigation |
| :--- | :---: | :--- | :--- |
| `RISK-36-01` | **Medium (Release Gate)** | **Clean Windows 10 & Windows 11 VM QA `NOT TESTED`** (`0` local provisioned VMs). | Execute `.github/workflows/clean-windows-release-qa.yml` (`windows-2022` & `windows-2025`) or clean physical/VM Windows 10 & 11 machines before public Desktop `v1.0.9` release. |
| `RISK-34-02` | **Medium (Known Limitation)** | **Windows Authenticode Code Signing `NotSigned`.** Users see Windows SmartScreen prompt on fresh `.exe` runs. | Signing pipeline already implemented in `scripts/build_nsis_installer.ps1 -SignAuthenticode`; disclose openly until code-signing certificate is provisioned. |
| `RISK-34-01` | **Medium (Stage 2 Blocker)** | **Dedicated External Tools Key (`C3FD6626A3718E63`) Offline Backup Deferred** (`BACKUP_VERIFICATION_DEFERRED_BY_OWNER`). | Mitigated during Stage 1 by retaining legacy key `CDC23D8CC8DA5397`; Stage 2 dedicated-only cutover MUST remain strictly disabled until `-Mode VerifyBackup` passes. |
| `RISK-35-05` | **Low** | **Chromium/Edge Companion `v1.0.11` Unpacked Distribution.** Users must manually update unpacked extension folder. | Mozilla Firefox signed XPI installs permanently; consider Chrome Web Store / Edge Add-ons Store submission in a future gate. |

### Rollback Plan (For Future Authorized Desktop `v1.0.9` Publication)
1. **Preserve Desktop `v1.0.8` (ID `455125259`)** permanently on GitHub Releases (never delete or overwrite `v1.0.8` assets or `TORI.Download.Manager_1.0.8_x64-setup.exe`).
2. **Instant Auto-Updater & GitHub Latest Rollback:** If a critical regression occurs after publishing `v1.0.9`, mark `v1.0.9` as `prerelease: true` (or `draft: true`) and set Desktop `v1.0.8` (ID `455125259`) back to `make_latest: "true"` so `/releases/latest` and `/releases/latest/download/latest.json` immediately revert to `v1.0.8`.
3. **Website Rollback:** Revert `tori-website-private` `main` or roll back Cloudflare Pages deployment to the prior verified `v1.0.8` + Companion `v1.0.11` deployment (`723c6191-1b46-41b4-aa1b-bd55ae938357`).
4. **External Tools Continuity:** Production tools manifest revision 2 (`CDC23D8CC8DA5397`) works identically with both `v1.0.8` and `v1.0.9`, requiring zero tools-manifest rollback.

---

## 6. Public-Release Readiness Checklist (Before Any Future Gate 36.2 Publication)

- [x] Gate 35.1 + Gate 35.2 fixes integrated cleanly on `release/gate36_1-desktop-v109-rc` (zero conflicts, zero dropped fixes)
- [x] Desktop version metadata consistently set to `1.0.9` (Rust workspace, Tauri config, UI package/Settings, Windows PE version)
- [x] `cargo test --workspace` (**314/314 PASS**), `cargo clippy` (`0` errors), UI lint/build (`0` errors)
- [x] Windows x64 `v1.0.9` NSIS installer built, Ed25519 signed (`CDC23D8CC8DA5397`), tamper-rejected, and staged in `release/v1.0.9-rc/`
- [x] Isolated `v1.0.8` → `v1.0.9` upgrade, live broken-CDN `Content-Range` fallback, `v1.0.9` native host + 4x concurrent spawn, and live Tools rev 2 verified (**12/12 PASS**)
- [x] Public Browser Companion `v1.0.11` compatibility verified live across Signed Firefox (`15/15`), Chrome/Edge/Firefox (`32/32`), and `SEC-35-04` VM (`30/30`)
- [x] Production Desktop `v1.0.8`, Companion `v1.0.11`, Tools rev 2, signing keys, OEM Desktop/SQLite/parts & HKCU registry 100% preserved
- [ ] **Clean Windows 10 & Windows 11 VM QA (`NOT TESTED` locally — run `.github/workflows/clean-windows-release-qa.yml` or clean VM before public release)**
- [ ] **Windows Authenticode Code Signing (optional owner decision; disclose `NotSigned` if releasing without certificate)**
- [ ] **Explicit Separate Project Owner Authorization for Public Desktop `v1.0.9` Release**

---

## 7. Final Verdict & Next Recommended Gate

- **Final Verdict:** **`CONDITIONAL GO`** (Technical `v1.0.9` RC build, cryptographic signature, upgrade, `Content-Range` recovery, startup hardening, Stage 1 dual-key tools rev 2, and Companion `v1.0.11` compatibility are **100% verified locally**; public publication is **NOT AUTHORIZED** and remains conditional on Clean Windows 10/11 VM QA, Authenticode signing/waiver decision, and explicit separate owner release authorization).
- **Next Recommended Gate:** **Gate 36.2 — Clean Windows 10/11 VM Preflight & Authorized Desktop `v1.0.9` Public Release Preparation** (execute clean Windows runner/VM QA on `TORI.Download.Manager_1.0.9_x64-setup.exe`, prepare Desktop `v1.0.9` GitHub/website dry-run, and await explicit owner release authorization).
