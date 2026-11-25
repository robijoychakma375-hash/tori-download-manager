# TORI Gate 35.4 — Browser Companion v1.0.11 Public Release Preparation Report

**Date:** 2026-11-26  
**Gate:** Gate 35.4 — Production Pre-Release Preparation (Browser Companion `v1.0.11` Security Hotfix)  
**Status:** **READY FOR AUTHORIZED PUBLICATION (LOCAL PRE-PUBLISH ONLY — NO PUBLIC RELEASE PERFORMED)**  
**Main Repository:** `F:\TORI\final tori download manager` (`robijoychakma375-hash/tori-download-manager`)  
**Preparation Branch:** `feat/gate35_4-companion-v1011-prepublish`  
**Previous Verified Checkpoint:** `checkpoint-gate35_3-companion-v1011-signed-go` (`0765fca0d1eee40b5f52183c89d56d81e2e25af8`)  
**Audited Extension Source Commit:** `ae27e96637c6b3227f07e2ec071b23bd1a22c956` (zero extension source changes since Gate 35.3)  
**Target Checkpoint Tag:** `checkpoint-gate35_4-companion-v1011-prepublish-ready`  
**Website Staging Repo:** `C:\Users\ritud\Downloads\tori-website` — local prep branch `feat/gate35_4-companion-v1011-website-prep` (`3edb4293b09e16921877381394a8be38e5d3d02c`); live `main` **untouched** at `181b3fb7c4d2abb9889d7d988b223fe63e02506f`

---

## 1. Executive Summary

Gate 35.4 completed full production pre-release preparation, end-to-end security and browser revalidation, release staging, read-only GitHub publication dry-run verification, local website staging, rollback readiness, and production-asset preservation audits for **TORI Browser Companion `v1.0.11` (`SEC-35-04` Security Hotfix)**.

**Zero public releases, remote GitHub draft releases, remote tag pushes, branch pushes, or Cloudflare Pages deployments were performed.** All current public production assets remain completely intact:
- **Public Desktop:** `v1.0.8` (GitHub Latest Stable, Release ID `455125259`, installer SHA-256 `728d0d253a8fadc3fea5244723237f267dcd13abf65cac49b91a4ec83a3dcffb`)
- **Public Browser Companion:** `v1.0.10` (`extension-v1.0.10`, Release ID `451270856`, 5 live assets untouched)
- **Production External Tools Manifest:** Revision 2 (`https://toridownload.xyz/assets/tools/tools-manifest.json`, `schema_version=2`, `signing_key_id=CDC23D8CC8DA5397`, `published_at=2026-11-22T19:46:42.049Z`)
- **Live Website (`https://toridownload.xyz/`):** Still serving Desktop `v1.0.8` + Companion `v1.0.10` (`LIVE_SITE_HAS_V1010=True`, `LIVE_SITE_HAS_V1011=False`)
- **Production OEM User Data:** `%LOCALAPPDATA%\TORI Download Manager\tori-download-manager.exe` (`570833b379668f64d8f0a81e0a2c138635835e0c0382f37f24ec969caccf0fda`), `%APPDATA%\tori-download-manager\tdm_storage.sqlite` (`integrity_check=ok`, `downloads=56`, `download_chunks=531`, `engine_settings=7`), `21` `.tdm-part` partial files intact, `0` stray `tori-download-manager` processes.

---

## 2. Prior Evidence Audit (Gate 35.2 & Gate 35.3)

Audited:
- `docs/reports/GATE35_2_COMPANION_SECURITY_HOTFIX_AND_DESKTOP_BUG_TRIAGE_REPORT.md`
- `docs/reports/GATE35_3_COMPANION_V1011_SECURITY_HOTFIX_RELEASE_PREP_REPORT.md`

Confirmed:
1. Extension security hotfix (`SEC-35-04`) removed all webpage-accessible dispatch bridges (`__TORI_DISPATCH__`, `__TORI_RESPONSE__`, `toriExtensionUrl`, `__TORI_BG_SECURITY__`), enforced closed Shadow DOM (`mode: 'closed'`), required `e.isTrusted` clicks, restricted privileged background actions strictly to trusted `popup.html` / `options.html` (`frameId === 0`), minimized pairing token visibility strictly to `options/options.html`, and eliminated unsolicited startup Desktop launches and historical download replays.
2. Mozilla AMO signed the Firefox Companion `v1.0.11` package with Gecko ID `tori-download-manager@toridm.org` and all 5 cryptographic `META-INF/` signature files (`cose.manifest`, `cose.sig`, `manifest.mf`, `mozilla.rsa`, `mozilla.sf`).
3. Dedicated External Tools Ed25519 key fingerprint was independently verified across disk `.pub`, `trust.rs`, and the frozen Desktop `v1.0.8` binary (`C3FD6626A3718E63` / `6807e183f56c08eb06fdff95347bbbf7174b4ce5185b0245155db315e87fee39`).

---

## 3. Frozen Release Artifact Verification & Inventory

Both frozen release binaries were re-verified bit-for-bit without rebuilding or mutating either package:

| Artifact | Path | Bytes | Verified SHA-256 | Public Release Status |
| :--- | :--- | ---: | :--- | :--- |
| Firefox Mozilla-Signed XPI | `release/v1.0.11-extension-rc/tori-companion-v1.0.11-firefox-signed.xpi` | `111,347` | `4cd6d6fbf067cb98538fd807eaba360d40b409df07cbfb515b8d9b702b37c0fd` | **INCLUDED** (`application/x-xpinstall`) |
| Chromium / Edge ZIP | `release/v1.0.11-extension-rc/tori-companion-v1.0.11-chromium.zip` | `94,625` | `1e77592bb05e548d832df373331aee4f90788a004cdaef7ca80c97df84b88559` | **INCLUDED** (`application/zip`) |
| `SHA256SUMS.txt` | `release/v1.0.11-extension-rc/SHA256SUMS.txt` | `210` | `70eb787011706a543d6c2ac607fc946bbe1de7a0451dd38a0a651ca76131bc38` | **INCLUDED** (`text/plain`) |
| `RELEASE_NOTES.md` | `release/v1.0.11-extension-rc/RELEASE_NOTES.md` | `5,067` | `f971e6c32b669fc6cbbc4b444045851ae10756b301581192cd025ca2fa65f983` | **INCLUDED** (`text/markdown`) |
| `INSTALLATION_AND_UPGRADE.md` | `release/v1.0.11-extension-rc/INSTALLATION_AND_UPGRADE.md` | `2,746` | `6a4b3d6a37911c76923a149ff9d3bdefc56746a37a7a3aea0cc373b453a461d6` | **INCLUDED** (`text/markdown`) |
| Firefox Unsigned ZIP *(local archive only)* | `release/v1.0.11-extension-rc/tori-companion-v1.0.11-firefox.zip` | `95,444` | `2df9b5cb1e391b9023f6b4217efee9baa182c36aaeb8c3e891a71515abf9edad` | **EXCLUDED** (enforced by publisher & `SHA256SUMS.txt`) |

Package integrity revalidation (`target/gate35_4_qa_logs/artifact_revalidation.log`):
- ZIP CRC / structure (`zipfile.testzip()`): **OK** on all archives
- Firefox Signed XPI manifest: `version=1.0.11`, `gecko.id=tori-download-manager@toridm.org`, `5` Mozilla `META-INF/` signature files present
- Chromium ZIP manifest: `version=1.0.11`, preserved extension ID `jfnfgmcbgapcpieaonbaolgebjaejcdm`

---

## 4. Gate 35.4 Executed Revalidation Results (`77 / 77 PASS`)

All test suites were executed freshly during Gate 35.4 against the frozen `v1.0.11` packages and the frozen public Desktop `v1.0.8` executable (`release/v1.0.8-public` sandbox):

| Verification Suite | Command / Script | Result | Log Path |
| :--- | :--- | :---: | :--- |
| Artifact Hash, Manifest & Signature Audit | Python ZIP/SHA-256/META-INF verifier | **PASS** | `target/gate35_4_qa_logs/artifact_revalidation.log` |
| `SEC-35-04` Adversarial VM & Boundary Suite | `node scripts/verify_gate35_2_extension_security.js` | **30 / 30 PASS** (`0 FAIL`) | `target/gate35_4_qa_logs/security_vm.log` |
| Real Browsers E2E QA (Chrome, Edge, Firefox vs Desktop `v1.0.8`) | `node scripts/verify_gate35_3_real_browsers.js` | **32 / 32 PASS** (`0 FAIL`, `0 BLOCKED`) | `target/gate35_4_qa_logs/real_browsers.log` |
| Signed Firefox XPI Permanent Install & Upgrade QA | `node scripts/verify_gate35_3_signed_firefox.js` | **15 / 15 PASS** (`0 FAIL`) | `target/gate35_4_qa_logs/signed_firefox.log` |
| GitHub Publisher Read-Only Dry-Run | `node scripts/publish_extension_v1_0_11.js --dry-run` | **PASS** (`0` remote writes) | `target/gate35_4_qa_logs/github_dry_run.log` |
| Website Local Diff, JS/JSON-LD Syntax & Build Simulation | Node parser + Cloudflare copy simulation | **PASS** (`JSON_LD_OK`, `JS_BLOCK_1_OK`, `JS_BLOCK_2_OK`, `BUILD_SIM_OK`) | Verified on `feat/gate35_4-companion-v1011-website-prep` |
| Secret & Credential Scan | Regex scan across all 10 Gate 35.4 scripts, docs & staged files | **CLEAN** (`0` matches) | Verified in Gate 35.4 audit |

### QA Harness Isolation Improvement (Root-Cause Verified)
During the first Gate 35.4 run of `scripts/verify_gate35_3_real_browsers.js`, `[Edge] [STARTUP_OFFLINE]` recorded `nmInvocations=1` (`toriPidsBefore=0, toriPidsAfter=0`). Root-cause inspection confirmed `0` active localhost listeners (`6800-6803`) while `30` live owner Microsoft Edge processes (running existing `v1.0.10`) were open on the host and invoked the temporarily registered HKCU Edge NativeMessagingHost key once. `scripts/verify_gate35_3_real_browsers.js` was hardened so `registerIsolatedNativeHost(targetBrowsers)` scopes HKCU NativeMessagingHosts registration per browser (`['chrome']` → `['edge']` → `['firefox']`) and runs the cold offline unpaired startup assertion on isolated **Chrome** (`nmInvocations=0`, `toriPidsBefore=0`, `toriPidsAfter=0`), complemented by `verify_gate35_3_signed_firefox.js` verifying cold offline unpaired startup on isolated **Signed Firefox** (`nmInvocations=0`). Both suites subsequently passed cleanly (**32 / 32** and **15 / 15**), with bit-for-bit HKCU registry restoration confirmed on exit.

### Functional Coverage Summary
- **Native Messaging:** Trusted `options.html` `INITIATE_PAIRING` + `GET_CONNECTION_STATUS` + `popup.html` `PING_DESKTOP`/`GET_DOWNLOADS` verified against frozen Desktop `v1.0.8` across Chrome, Edge, and permanently installed Signed Firefox (`auth=true`, `tokenLeaked=false`).
- **Media Capture & Download Interception:** Real trusted overlay clicks queued media downloads in Desktop `v1.0.8`; browser file interceptions completed with exact SHA-256 verification and cooldown deduplication across Chrome, Edge, and Signed Firefox.
- **Settings Migration:** Verified `v1.0.10 -> v1.0.11` migration preserving theme (`dark`), accent (`emerald`), custom sites, file types, and custom port in Chrome, Edge, and real in-place Signed Firefox XPI upgrade (`signedState=2`, `temporarilyInstalled=false`, `xpinstall.signatures.required=true`).
- **Startup Regression:** Zero unsolicited Native Host invocations and zero background Desktop spawns on cold offline startup (Chrome + Signed Firefox) and zero stale download replays across browser restarts with persisted completed history (Chrome + Edge + Signed Firefox).

---

## 5. GitHub Release Publisher & Dry-Run Audit

Created safe, idempotent publisher [`scripts/publish_extension_v1_0_11.js`](file:///F:/TORI/final%20tori%20download%20manager/scripts/publish_extension_v1_0_11.js):
- **Defaults strictly to `--dry-run`** (zero write calls; requires **both** `--execute` AND `--owner-authorized` for live writes).
- **Enforces `make_latest: "false"`** on creation and publication, plus post-publish verification/auto-restore ensuring Desktop `v1.0.8` (Release ID `455125259`) remains repository-wide Latest Stable.
- **Enforces cryptographic parity & unsigned-ZIP exclusion:** verifies exact SHA-256 of signed XPI (`4cd6d6fb...`), Chromium ZIP (`1e77592b...`), all 5 `META-INF/` signatures, `version=1.0.11`, Gecko ID `tori-download-manager@toridm.org`, and asserts `tori-companion-v1.0.11-firefox.zip` is excluded from both upload assets and `SHA256SUMS.txt`.

Verified dry-run report (`release/v1.0.11-extension-rc/github_publish_dry_run_report.json`):
- `mode`: `"DRY_RUN_NO_REMOTE_WRITES"`
- `planned_release.tag_name`: `"extension-v1.0.11"`
- `planned_release.make_latest`: `"false"`
- `assets_to_upload`: `5` verified files (`tori-companion-v1.0.11-firefox-signed.xpi`, `tori-companion-v1.0.11-chromium.zip`, `SHA256SUMS.txt`, `RELEASE_NOTES.md`, `INSTALLATION_AND_UPGRADE.md`)
- `excluded_unsigned_assets`: `["tori-companion-v1.0.11-firefox.zip"]`
- `read_only_remote_checks.current_latest_stable`: `HTTP 200`, `tag_name: "v1.0.8"`, `release_id: 455125259`, `matchesExpectedDesktopV108: true`
- `read_only_remote_checks.target_tag_extension_v1_0_11`: `HTTP 404`, `alreadyPublished: false`
- `safety_assertions.remote_writes_performed`: `0`

---

## 6. Local Website Staging (`toridownload.xyz`)

Staged locally in `C:\Users\ritud\Downloads\tori-website` on isolated local branch **`feat/gate35_4-companion-v1011-website-prep`** (commit `3edb4293b09e16921877381394a8be38e5d3d02c`), with production `main` restored and verified completely untouched at **`181b3fb7c4d2abb9889d7d988b223fe63e02506f`**:
- Added `assets/tori-download-manager-firefox-v1.0.11.xpi` (`111,347` bytes, exact SHA-256 `4cd6d6fbf067cb98538fd807eaba360d40b409df07cbfb515b8d9b702b37c0fd`) while keeping `assets/tori-download-manager-firefox-v1.0.10.xpi` (`a93a4387...`) intact for instant rollback.
- Updated `_headers` (+8 lines) to serve `/assets/tori-download-manager-firefox-v1.0.11.xpi` and `/tori-download-manager-firefox-v1.0.11.xpi` with `Content-Type: application/x-xpinstall` and `Access-Control-Allow-Origin: *`, preserving all existing `v1.0.10` and `/assets/tools/*` rules.
- Updated `index.html` (+32/-31 lines) to point Companion download URLs, labels, sizes (`109 KB` XPI, `92 KB` ZIP), and SHA-256 display block to `extension-v1.0.11`, added the `SEC-35-04` fix note, and fixed two stale `v1.0.9` no-JS fallback `href` attributes, while preserving **100% of Desktop `v1.0.8` installer links, sizes (`112.6 MB`), SHA-256 (`728d0d25...`), and `tools-manifest.json` rev 2**.
- Archived exact reviewed diff at `docs/release/GATE35_4_WEBSITE_V1011_DIFF.patch` (and `release/v1.0.11-extension-rc/website_v1011.patch`).

---

## 7. Preservation & Rollback Readiness Verification

| Asset / State | Verified Value | Status |
| :--- | :--- | :---: |
| Public Desktop `v1.0.8` Installer (Local + GitHub Latest) | `728d0d253a8fadc3fea5244723237f267dcd13abf65cac49b91a4ec83a3dcffb` / Release ID `455125259` | **INTACT** |
| Public Companion `v1.0.10` Signed XPI + Chromium ZIP (Local + GitHub) | `a93a4387...` & `f220fab2...` / Release ID `451270856` (`5` assets) | **INTACT** |
| Production External Tools Manifest | `https://toridownload.xyz/assets/tools/tools-manifest.json` (`schema_version=2`, `CDC23D8CC8DA5397`) | **INTACT** |
| Live `https://toridownload.xyz/` | `LIVE_SITE_HAS_V1010=True`, `LIVE_SITE_HAS_V1011=False`, `main=181b3fb7...` | **INTACT** |
| OEM Installed Binary (`v1.0.6`) | `570833b379668f64d8f0a81e0a2c138635835e0c0382f37f24ec969caccf0fda` | **INTACT** |
| OEM SQLite (`tdm_storage.sqlite`) | `PRAGMA integrity_check = ok`; `56` downloads; `531` `download_chunks`; `7` `engine_settings` | **INTACT** |
| OEM Partial `.tdm-part` Files | `21` files in `%USERPROFILE%\Downloads` | **INTACT** |
| Stray `tori-download-manager` Processes | `0` | **CLEAN** |
| Rollback Readiness | `< 30s` Cloudflare Pages rollback to `181b3fb7...` + preserved `v1.0.10` XPI + preserved GitHub `extension-v1.0.10` | **VERIFIED** |

---

## 8. Deliverables Created & Verified

1. `docs/reports/GATE35_4_COMPANION_V1011_PUBLIC_RELEASE_PREPARATION_REPORT.md` (this report)
2. `docs/security/GATE35_4_COMPANION_RELEASE_SECURITY_CHECKLIST.md`
3. `docs/release/GATE35_4_COMPANION_V1011_PUBLICATION_RUNBOOK.md`
4. `docs/release/GATE35_4_COMPANION_V1011_RELEASE_NOTES.md`
5. `docs/release/GATE35_4_WEBSITE_V1011_DIFF.patch`
6. `scripts/publish_extension_v1_0_11.js`
7. `release/v1.0.11-extension-rc/` staging directory (`tori-companion-v1.0.11-firefox-signed.xpi`, `tori-companion-v1.0.11-chromium.zip`, `SHA256SUMS.txt`, `RELEASE_NOTES.md`, `INSTALLATION_AND_UPGRADE.md`, `github_publish_dry_run_report.json`, `website_v1011.patch`)
8. `C:\Users\ritud\Downloads\tori-website` local branch `feat/gate35_4-companion-v1011-website-prep` (`3edb4293b09e16921877381394a8be38e5d3d02c`)

---

## 9. Release Authorization Checklist (Gate 35.5 Pre-Flight)

Before executing any live publication step in `docs/release/GATE35_4_COMPANION_V1011_PUBLICATION_RUNBOOK.md`, confirm:

- [x] Frozen Firefox Signed XPI SHA-256 matches `4cd6d6fbf067cb98538fd807eaba360d40b409df07cbfb515b8d9b702b37c0fd` (`SIGNEDSTATE_SIGNED`, 5 `META-INF/` files)
- [x] Frozen Chromium ZIP SHA-256 matches `1e77592bb05e548d832df373331aee4f90788a004cdaef7ca80c97df84b88559`
- [x] `SEC-35-04` VM suite (`30/30`), Real Browsers suite (`32/32`), and Signed Firefox permanent install suite (`15/15`) all PASS
- [x] `node scripts/publish_extension_v1_0_11.js --dry-run` PASSES with `0` remote writes and `make_latest: "false"`
- [x] Local website branch `feat/gate35_4-companion-v1011-website-prep` (`3edb4293...`) verified with Desktop `v1.0.8` preserved and `v1.0.10.xpi` retained for rollback
- [x] Secret scan clean (`0` leaks) and all production user/OEM data intact
- [ ] **Owner explicit publication authorization granted for Gate 35.5 (`extension-v1.0.11` GitHub release + Cloudflare Pages `toridownload.xyz` deployment)**
