# TORI DOWNLOAD MANAGER — GATE 34 PREFLIGHT PLAN
## DESKTOP v1.0.8 PUBLIC STABLE RELEASE (STAGE 1 DUAL-KEY ROLLOUT)

**Plan ID:** `TORI-PLAN-GATE34-V108-PUB-001`  
**Prepared At:** `2026-11-23T07:36:00Z` (Gate 33.3 QA Handover)  
**Authorization Status:** **`NOT AUTHORIZED — PREFLIGHT PLAN ONLY (NO PUBLIC RELEASE PERFORMED)`**  
**Source Baseline:** Verified commit `1a24265d247a43371ab2b637e195425df2c78b82` on `feat/gate33_3-dedicated-key-v108-final-rc` (Handover tag `checkpoint-gate33_3-qa-complete-backup-deferred`)  
**Scope Boundary:** Publishes Desktop `v1.0.8` (Stage 1 Dual-Key Trust) ONLY. **Does NOT** perform dedicated-key production manifest cutover, **does NOT** alter production tools manifest `rev 2`, and **does NOT** rebuild or modify Browser Companion `v1.0.10`.

---

## 1. Frozen Release Candidate Artifact Inventory (`release/v1.0.8-final-rc/`)

Do **not** rebuild unless source code changes or verification detects a real inconsistency. Promote these exact verified files:

| File | Size (Bytes) | SHA-256 | Purpose |
|---|---:|---|---|
| `TORI Download Manager_1.0.8_x64-setup.exe` | `118,110,372` | `728d0d253a8fadc3fea5244723237f267dcd13abf65cac49b91a4ec83a3dcffb` | Windows x64 NSIS Installer (Stage 1 Dual-Key: `C3FD6626A3718E63` + `CDC23D8CC8DA5397`) |
| `TORI Download Manager_1.0.8_x64-setup.exe.sig` | `436` | `8f2bc20bd2c8994ac04d8d2fc84be37b5569f11caeb47b63f369a4c72b44294c` | Detached Tauri Ed25519 Signature (`CDC23D8CC8DA5397`) |
| `tori-download-manager.exe` | `32,102,400` | `197d2b6bda12a6a4aa8a71664d0bde8b7db723a836f04980bd48fbccecbb6fbf` | Standalone Desktop PE Reference |
| `tdm-native-host.exe` | `19,365,888` | `703a901c4b0be3c6f956d726e8d0551ba9fe9ea319a4d8cbd76ca9eefddaacdd` | Chrome / Edge / Firefox Native Messaging Host |
| `tdm-cli.exe` | `17,016,832` | `19d09bb948a8940e36e6a97184c0d13534c87a5aea838b6a2f58ca6d959479e2` | CLI Companion Binary |
| `draft_latest.json` | `1,966` | `0a6b220510b1a226516f25257a97bbbd7f2f78abdfcedc480d787f06d76962b5` | Template for `latest.json` (verify GitHub asset filename URL matches exact uploaded asset name before publishing!) |
| `SHA256SUMS.txt` | `918` | Verified | Complete SHA-256 Checksum Ledger |
| `BUILD_METADATA.json` / `RELEASE_MANIFEST.json` / `RELEASE_NOTES_v1.0.8.md` / `INSTALLATION_AND_UPGRADE.md` | — | Verified | Release Metadata & Operator Documentation |

**Verified QA Evidence Carried Forward (Zero Regressions):**
- Rust workspace: **282/282 PASS** (41 targets, `0 failed`, `0 ignored`), `cargo clippy`: `0 errors`, UI lint/build: `0 errors`.
- Sequential Node E2E & Security suites: **153/153 PASS** across all 10 suites (`Gate 33.3` `10/10`, `Gate 33.2` `9/9`, `Gate 33.1` `20/20`, `Expiry Monitor` `18/18`, `Gate 33` `14/14`, `Gate 32.3` `14/14`, `Gate 32.1` `19/19`, `Gate 32` `18/18`, `Gate 31.5` `23/23`, `Gate 29.4` `18/18` on `v1.0.8-final-rc`).

---

## 2. Explicit Release Risk Register (Mandatory Owner Sign-Off Before Gate 34)

| Risk ID | Risk | Current Status | Impact & Operational Mitigation | Required Gate 34 Decision |
|---|---|---|---|---|
| **RISK-34-01** | **Deferred Offline Encrypted Key Backup & Recovery (`tori-tools.key`, Key ID `C3FD6626A3718E63`)** | **`BACKUP_VERIFICATION_DEFERRED_BY_OWNER`** / **`BACKUP_RECOVERY_NOT_VERIFIED`** (`PRODUCTION_KEY_LOSS_RISK_ACCEPTED_FOR_CONTINUED DEVELOPMENT`) | **Single-point-of-failure risk for `C3FD6626A3718E63`:** If the primary workstation disk fails before an encrypted offline backup is created and verified, private key `C3FD6626A3718E63` is permanently lost. **Stage 1 Mitigation:** Because Desktop `v1.0.8` ships in **Stage 1 Dual-Key mode** (keeping legacy key `CDC23D8CC8DA5397` active and keeping production manifest `rev 2` signed by `CDC23D8CC8DA5397`), loss of `C3FD6626A3718E63` does **NOT** brick `v1.0.8` updates or External Tools updates — a future Desktop release signed by `CDC23D8CC8DA5397` can simply revoke `C3FD6626A3718E63` and embed a new dedicated key. **Hard Guardrail:** Stage 2 dedicated-key production cutover (signing production manifests exclusively with `C3FD6626A3718E63` or retiring `CDC23D8CC8DA5397`) is **STRICTLY PROHIBITED** until `BACKUP_VERIFIED` (`passphraseRoundtripOk: true`) passes. | Owner must either **(a)** complete `-Mode VerifyBackup -BackupDir "<OFFLINE_PATH>" -VerifyPassphrase` before Gate 34 publication, OR **(b)** explicitly accept `RISK-34-01` for Stage 1 dual-key `v1.0.8` publication while keeping Stage 2 cutover strictly blocked. |
| **RISK-34-02** | **Clean Windows 10 & Windows 11 Guest VM QA Unavailable** | **`NOT TESTED`** (`provisionedWindowsVmCount: 0`) | Isolated clean-install, upgrade, repair, uninstall, and Native Messaging checks passed on the host Windows 11 workstation under `QaOemStateGuard`, but were not executed on independent zero-prior-state Windows 10/11 VMs. | Owner must run clean VM QA or explicitly accept limitation (matching Gate 32.3 precedent). |
| **RISK-34-03** | **Windows Authenticode Code Signing Unavailable** | **`NotSigned (Pipeline Ready)`** | Windows SmartScreen may show "Unknown Publisher" on first run. Tauri Ed25519 updater signature (`CDC23D8CC8DA5397`) independently protects auto-updates. | Owner must accept limitation (matching Gate 32.3 precedent) or provide a commercial Authenticode certificate and rebuild. |

---

## 3. Mandatory Preservation Invariants During Gate 34

The following production components MUST remain **100% unchanged** during Gate 34:
1. **Desktop `v1.0.7` GitHub Release (ID `454278227`):** Remain intact and downloadable as the immediate rollback target (`TORI.Download.Manager_1.0.7_x64-setup.exe`, SHA-256 `142e4528410a70c43cf7166acda87d8b27e293348237113b2350a025467966cb`).
2. **Browser Companion `v1.0.10` (`extension-v1.0.10`, ID `451270856`):** Zero rebuilds, zero XPI/ZIP changes (`a93a4387...`, `f220fab2...`).
3. **Production External Tools Manifest `rev 2`:** Remain live, unchanged, and signed by `CDC23D8CC8DA5397` (`caa2d4ed2a7e424badcd8662e67b986a3fdfbf2847dded0625ea2b2547663f3a`, expires `2027-01-21T19:46:42.049Z`).
4. **GitHub Actions Expiry Monitor (Workflow ID `427101855`):** Remain active and read-only on `master`.
5. **Operator Workstation OEM Installation & User Data:** OEM `v1.0.6` binary (`570833b3...`), SQLite DB (`42` rows, `355` chunks, `5` protected settings), `11` `.tdm-part` files, and `%USERPROFILE%\.tori-keys\` untouched.

---

## 4. Gate 34 Execution Procedure (ONLY After Explicit Owner Authorization)

### Phase A — Pre-Publication Safety Snapshot & Integrity Verification
1. Take an out-of-repo pre-publication backup into `%USERPROFILE%\.tori-release-backups\gate34_pre_release\`:
   - Current live `latest.json` (`1.0.7`)
   - Current live `toridownload.xyz` website commit (`2eff4f20a64989c39a75cb6b1739ce3948431048`) & Cloudflare Deployment ID (`449b84d7-4ec8-4a63-b0ec-5f7d3a6a7ebe`)
   - Current live production `tools-manifest.json` + `.sig` (`rev 2`)
2. Re-verify `release/v1.0.8-final-rc/` hashes against `SHA256SUMS.txt` and run `cargo test -p tdm-core --test updater_cryptography_tests` (`10/10 PASS`).
3. Confirm `git status` clean and merge/fast-forward approved release commit into `master` (or release branch per repository policy) and create signed/annotated release tag `v1.0.8`.

### Phase B — GitHub Release `v1.0.8` Publication & `latest.json` Activation
1. Create GitHub Release `v1.0.8` (Draft first) on `robijoychakma375-hash/tori-download-manager`.
2. Upload verified `release/v1.0.8-final-rc/` desktop assets (`TORI.Download.Manager_1.0.8_x64-setup.exe`, `.sig`, `SHA256SUMS.txt`, `RELEASE_NOTES_v1.0.8.md`, `BUILD_METADATA.json`, `RELEASE_MANIFEST.json`, `INSTALLATION_AND_UPGRADE.md`) — **NEVER** upload Browser Companion assets or private keys to the Desktop release.
3. Verify the exact uploaded installer asset download URL matches `draft_latest.json` (`platforms.windows-x86_64.url` & `windows-x86_64-nsis.url`), upload `latest.json`, and verify `.sig` parity.
4. Promote GitHub Release `v1.0.8` from Draft to **Latest Stable** (`draft=false`, `prerelease=false`, `make_latest="true"`).

### Phase C — Website Update (`C:\Users\ritud\Downloads\tori-website`) & Cloudflare Pages Deploy
1. Update **ONLY** Desktop version labels, installer download links (`v1.0.8`), installer SHA-256 (`728d0d253a8fadc3fea5244723237f267dcd13abf65cac49b91a4ec83a3dcffb`), footer, and sitemap/metadata in `C:\Users\ritud\Downloads\tori-website`.
2. Verify **ZERO diff** to `assets/tools/tools-manifest.json`, `assets/tools/tools-manifest.json.sig`, and Browser Companion `v1.0.10` links/files.
3. Deploy via Cloudflare Pages (`wrangler pages deploy`) and verify cache-bypassed live HTTPS responses on `https://toridownload.xyz` (Desktop `1440x900` + Mobile `390x844`).

### Phase D — Live Post-Release End-to-End Verification
1. Download `TORI.Download.Manager_1.0.8_x64-setup.exe`, `.sig`, and `latest.json` directly from public GitHub `/releases/latest/download/` and verify byte-for-byte SHA-256 + Ed25519 parity.
2. Verify live `https://toridownload.xyz/assets/tools/tools-manifest.json` (`rev 2`, `caa2d4ed...`) remains untouched.
3. Execute isolated `v1.0.7 -> live-downloaded public v1.0.8` in-place NSIS upgrade, confirm `1.0.8` boots cleanly, preserves SQLite + `.tdm-part`, verifies live `rev 2`, and works with Browser Companion `v1.0.10`.
4. Confirm OEM workstation `v1.0.6`, SQLite DB, `.tdm-part` files, and Registry remain 100% preserved.

---

## 5. Emergency Rollback Plan (If Any Post-Release Defect Appears)

1. **GitHub Latest & Auto-Updater Revert (< 2 minutes):** Mark GitHub Release `v1.0.7` (`454278227`) back as `make_latest="true"` and mark `v1.0.8` as prerelease/draft so `/releases/latest/download/latest.json` immediately serves `1.0.7` again.
2. **Website Instant Rollback (< 1 minute):** Roll back Cloudflare Pages production deployment directly to saved Deployment ID `449b84d7-4ec8-4a63-b0ec-5f7d3a6a7ebe` (`tori-website` @ `2eff4f20a64989c39a75cb6b1739ce3948431048`).
3. **User Downgrade Safety:** Because `v1.0.8` SQLite schema is 100% backward-compatible with `v1.0.7`, users can reinstall `v1.0.7` cleanly without data loss.
4. **External Tools Independence:** Production tools manifest `rev 2` (`CDC23D8CC8DA5397`) remains unaffected by any Desktop rollback.

---

## 6. Post-Gate 34 Prerequisite Before Any Future Dedicated-Key Cutover (Gate 35+)

Before signing **any** production tools manifest with `C3FD6626A3718E63` (`.tools.sig` dual-signing or Stage 2 cutover):
1. Operator **MUST** complete offline encrypted backup of `%USERPROFILE%\.tori-keys\tori-tools.key` + `tori-tools.key.pub` and verify `BACKUP_VERIFIED` (`passphraseRoundtripOk: true`) via:
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\provision_dedicated_tools_key.ps1 -Mode VerifyBackup -BackupDir "<OFFLINE_BACKUP_PATH>" -VerifyPassphrase
   ```
2. Record `checkpoint-gate33_3-final-rc-verified` (or Gate 34 backup-certification addendum).
3. Maintain legacy `.sig` (`CDC23D8CC8DA5397`) alongside `.tools.sig` (`C3FD6626A3718E63`) during dual-signing until legacy `v1.0.7` fleet adoption drops below the retirement threshold defined in `docs/security/EXTERNAL_TOOLS_SIGNING_KEY_MIGRATION_SPEC.md`.
