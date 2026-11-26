# TORI Download Manager — Gate 35.5 Browser Companion v1.0.11 Public Security Hotfix Release Report

**Date:** 2026-11-26  
**Gate:** Gate 35.5 — Browser Companion `v1.0.11` Public Security Hotfix Release (`SEC-35-04`)  
**Final Verdict:** **`FULL GO — PUBLICLY RELEASED & END-TO-END VERIFIED`**  
**Owner Authorization:** **EXPLICITLY GRANTED** (limited strictly to Browser Companion `v1.0.11` GitHub release with `make_latest=false` + official `toridownload.xyz` Cloudflare Pages promotion)  
**Public Release Performed:** **YES** (`2026-11-26T02:15:39Z`)

---

## 1. Owner Release Authorization & Scope Compliance

The project owner explicitly authorized publishing **TORI Browser Companion `v1.0.11` (Security Hotfix)**, pushing tag `extension-v1.0.11`, publishing the 5 approved public assets to GitHub with `make_latest=false`, promoting the prepared website commit to `robijoychakma375-hash/tori-website-private` `main` / Cloudflare Pages (`https://toridownload.xyz`), verifying live Firefox/Chrome/Edge integration against Desktop `v1.0.8`, and pushing the audited Gate 35.5 release branch and checkpoint.

All unauthorized actions were strictly prohibited and verified untouched:
- Desktop `v1.0.9` was **NOT** published; Desktop `v1.0.8` (ID `455125259`) was **NOT** modified and remains GitHub **Latest Stable**.
- Existing Companion `v1.0.10` (ID `451270856`) and historical `tori-download-manager-firefox-v1.0.10.xpi` were **preserved**.
- Production External Tools manifest **revision 2** (`caa2d4ed2a7e424badcd8662e67b986a3fdfbf2847dded0625ea2b2547663f3a`, `CDC23D8CC8DA5397`) was **NOT** modified; Stage 2 dedicated-only tools signing remains **DISABLED**.
- Signing keys, private key material, frozen signed XPI bytes, Chromium ZIP bytes, extension IDs, `origin/master`, and operator OEM Desktop/user data were **NOT** modified; zero force-pushes occurred.

---

## 2. Gate 35.4 Baseline & Git Provenance

| Reference / Metadata | Verified Value |
| :--- | :--- |
| Audited Extension Source Commit | `ae27e96637c6b3227f07e2ec071b23bd1a22c956` *(zero diffs in `extension/` since this commit)* |
| Gate 35.3 Signed-XPI Handover Commit | `0765fca0d1eee40b5f52183c89d56d81e2e25af8` |
| Gate 35.4 Prepublication Commit | `c75b5697d7416093b8218f6290c192ea151d4d57` (`checkpoint-gate35_4-companion-v1011-prepublish-ready`) |
| Gate 35.5 Pre-Publication Local Checkpoint | `checkpoint-gate35_5-before-v1011-publication` -> `c75b5697d7416093b8218f6290c192ea151d4d57` |
| Gate 35.5 Release Execution Branch | `release/gate35_5-companion-v1011-public-stable` |
| Public Release Tag (`origin`) | `extension-v1.0.11` (annotated tag object `dd4342477518e8eef0f5dd5ebdee22da3717548f`) |
| Release Tag Target Commit | `c75b5697d7416093b8218f6290c192ea151d4d57` |
| Final Gate 35.5 Checkpoint Tag | `checkpoint-gate35_5-companion-v1011-public-security-hotfix-released` |

---

## 3. GitHub Release Publication & Asset Inventory

| Field | Verified Live Value |
| :--- | :--- |
| GitHub Release ID | **`458864802`** |
| Release Tag | **`extension-v1.0.11`** |
| Release Title | **`TORI Browser Companion v1.0.11 — Security Hotfix`** |
| Publication Timestamp | **`2026-11-26T02:15:39Z`** |
| Public Release URL | `https://github.com/robijoychakma375-hash/tori-download-manager/releases/tag/extension-v1.0.11` |
| Release State | `draft=false`, `prerelease=false`, `make_latest="false"` |
| GitHub `/releases/latest` (API) | **`v1.0.8`** (Release ID **`455125259`**) — preserved without needing restore (`latest_stable_restored=false`) |
| GitHub `/releases/latest` (Web Redirect) | `HTTP 302` → `https://github.com/robijoychakma375-hash/tori-download-manager/releases/tag/v1.0.8` |

### Published Asset Inventory (5 Approved Assets — All Roundtrip Verified Twice: Draft + Public)

Unsigned `tori-companion-v1.0.11-firefox.zip` was **excluded** from upload and `SHA256SUMS.txt`.

| # | Asset Filename | GitHub Asset ID | Size (Bytes) | Verified SHA-256 (Local == Draft Roundtrip == Public Download) | Public Download URL |
| :-: | :--- | ---: | ---: | :--- | :--- |
| 1 | `tori-companion-v1.0.11-firefox-signed.xpi` | `793972984` | `111,347` | `4cd6d6fbf067cb98538fd807eaba360d40b409df07cbfb515b8d9b702b37c0fd` | `.../releases/download/extension-v1.0.11/tori-companion-v1.0.11-firefox-signed.xpi` |
| 2 | `tori-companion-v1.0.11-chromium.zip` | `793973057` | `94,625` | `1e77592bb05e548d832df373331aee4f90788a004cdaef7ca80c97df84b88559` | `.../releases/download/extension-v1.0.11/tori-companion-v1.0.11-chromium.zip` |
| 3 | `SHA256SUMS.txt` | `793973137` | `210` | `70eb787011706a543d6c2ac607fc946bbe1de7a0451dd38a0a651ca76131bc38` | `.../releases/download/extension-v1.0.11/SHA256SUMS.txt` |
| 4 | `RELEASE_NOTES.md` | `793973160` | `5,067` | `f971e6c32b669fc6cbbc4b444045851ae10756b301581192cd025ca2fa65f983` | `.../releases/download/extension-v1.0.11/RELEASE_NOTES.md` |
| 5 | `INSTALLATION_AND_UPGRADE.md` | `793973210` | `2,746` | `6a4b3d6a37911c76923a149ff9d3bdefc56746a37a7a3aea0cc373b453a461d6` | `.../releases/download/extension-v1.0.11/INSTALLATION_AND_UPGRADE.md` |

---

## 4. Cryptographic, Mozilla AMO Signature & Package Integrity Verification

Verified freshly in Phase 2 (`target/gate35_5_qa_logs/phase2_integrity_gate.log`) and re-verified on publicly downloaded packages in Phases 10–12:
- **Firefox Mozilla-Signed XPI (`tori-companion-v1.0.11-firefox-signed.xpi`):**
  - Exact frozen bytes (`111,347`) and SHA-256 (`4cd6d6fbf067cb98538fd807eaba360d40b409df07cbfb515b8d9b702b37c0fd`), `zipfile.testzip() == OK`.
  - All 5 Mozilla AMO signature files intact: `META-INF/cose.manifest`, `META-INF/cose.sig`, `META-INF/manifest.mf`, `META-INF/mozilla.rsa`, `META-INF/mozilla.sf`.
  - Manifest: `manifest_version=3`, `version="1.0.11"`, `browser_specific_settings.gecko.id="tori-download-manager@toridm.org"`, `strict_min_version="142.0"`, permissions `['downloads', 'nativeMessaging', 'webRequest', 'storage', 'tabs', 'activeTab']`.
  - Non-signing parity: `34/34` non-manifest application files byte-identical to `extension/firefox/`, `manifest.json` parsed-JSON identical.
  - Standard Firefox verification (`xpinstall.signatures.required=true`): **`SIGNEDSTATE_SIGNED` (`2`)**, `temporarilyInstalled=false`, `isActive=true`.
- **Chromium / Edge Package (`tori-companion-v1.0.11-chromium.zip`):**
  - Exact frozen bytes (`94,625`) and SHA-256 (`1e77592bb05e548d832df373331aee4f90788a004cdaef7ca80c97df84b88559`), `zipfile.testzip() == OK`.
  - Manifest V3, `version="1.0.11"`, fixed public key preserved (`jfnfgmcbgapcpieaonbaolgebjaejcdm`), `35/35` files byte-identical to `extension/`, zero forbidden dispatch bridges, debug hooks, or embedded credentials.
  - Note: Distributed via GitHub & `toridownload.xyz` unpacked MV3 package (Chrome Web Store / Edge Add-ons Store submission is outside Gate 35.5 scope).

---

## 5. Official Website Deployment (`https://toridownload.xyz`) & Live Endpoints

| Website / Cloudflare Field | Verified Value |
| :--- | :--- |
| Website Repository | `robijoychakma375-hash/tori-website-private` |
| Previous Production Website Commit | `181b3fb7c4d2abb9889d7d988b223fe63e02506f` |
| Previous Cloudflare Deployment ID | `5bc37b77-c69b-4080-97a5-a2e1195f2ca3` |
| Promoted Production Website Commit (`main`) | **`3edb4293b09e16921877381394a8be38e5d3d02c`** (fast-forward from `feat/gate35_4-companion-v1011-website-prep`, 3 files: `_headers`, `index.html`, `assets/tori-download-manager-firefox-v1.0.11.xpi`) |
| New Cloudflare Pages Deployment ID | **`723c6191-1b46-41b4-aa1b-bd55ae938357`** (`status=completed`, `conclusion=success`) |
| Cloudflare Pages Deployment URL | `https://dash.cloudflare.com/?to=/f903c690199da4b181753ed3370bb658/pages/view/tori-download-manager/723c6191-1b46-41b4-aa1b-bd55ae938357` |

### Fresh Live Public Endpoint Verification Matrix (`16 / 16 PASS`, `6.14s`)

Source log: `target/gate35_5_qa_logs/phase10_live_endpoints.log` & `phase10_live_endpoints_report.json`.

| Endpoint | HTTP Status | Content-Type / Cache | Verified Details | Result |
| :--- | :---: | :--- | :--- | :---: |
| GitHub API `/releases/tags/extension-v1.0.11` | `200` | `application/json` | ID `458864802`, `draft=false`, `prerelease=false`, `5` assets | **PASS** |
| GitHub `tori-companion-v1.0.11-firefox-signed.xpi` | `200` | `application/x-xpinstall` | Redirect `release-assets.githubusercontent.com`, `111,347` B, `4cd6d6fb...` | **PASS** |
| GitHub `tori-companion-v1.0.11-chromium.zip` | `200` | `application/octet-stream` | `94,625` B, `1e77592b...`, clean CRC unzip | **PASS** |
| GitHub `SHA256SUMS.txt` / `RELEASE_NOTES.md` / `INSTALLATION_AND_UPGRADE.md` | `200` | `application/octet-stream` | `210` B (`70eb7870...`), `5,067` B (`f971e6c3...`), `2,746` B (`6a4b3d6a...`) | **PASS** |
| GitHub `/releases/latest` (API + Web) | `200` / `302` | — | Desktop **`v1.0.8`** (ID `455125259`), redirects to `/releases/tag/v1.0.8` | **PASS** |
| Desktop `v1.0.8/latest.json` & Installer | `200` / `200` | — | `version="1.0.8"`, Ed25519 signature `436` chars, `SHA256SUMS.txt` matches `728d0d25...` | **PASS** |
| GitHub `/releases/tags/extension-v1.0.10` | `200` | `application/json` | Preserved ID `451270856`, `5` assets intact | **PASS** |
| `https://toridownload.xyz/` | `200` | `text/html; charset=utf-8` (`cf-cache-status: DYNAMIC`) | Serves Companion `v1.0.11` (`4cd6d6fb...`, `1e77592b...`) + Desktop `v1.0.8` (`728d0d25...`), `0` active `v1.0.10` download links | **PASS** |
| `https://toridownload.xyz/assets/tori-download-manager-firefox-v1.0.11.xpi` | `200` | `application/x-xpinstall` (`max-age=0, must-revalidate`) | `111,347` B, exact SHA-256 `4cd6d6fb...` (byte-identical to GitHub XPI) | **PASS** |
| `https://toridownload.xyz/assets/tori-download-manager-firefox-v1.0.10.xpi` | `200` | `application/x-xpinstall` | Rollback asset preserved: `107,499` B, `a93a4387...` | **PASS** |
| `https://toridownload.xyz/assets/tools/tools-manifest.json` + `.sig` | `200` / `200` | `max-age=0, must-revalidate` | `manifest_revision=2`, `schema_version=2`, `CDC23D8CC8DA5397`, exact SHA-256 `caa2d4ed2a7e424badcd8662e67b986a3fdfbf2847dded0625ea2b2547663f3a`, `.sig` `408` B | **PASS** |

---

## 6. Executed Pre-Release & Post-Release QA Matrix

All suites below were executed freshly during Gate 35.5 with bounded per-suite execution and saved logs under `target/gate35_5_qa_logs/`. Phases 11 & 12 executed directly against the **PUBLICLY DOWNLOADED** GitHub/Website `v1.0.11` XPI and Chromium ZIP (`target/gate35_5_public_dl/`) paired with frozen public Desktop `v1.0.8` in isolated sandboxes.

| Phase / Suite | Artifact Tested | Executed Result | Count | Duration | Log Path |
| :--- | :--- | :---: | :---: | :---: | :--- |
| Phase 2 — Cryptographic & Parity Integrity Gate | Frozen `release/v1.0.11-extension-rc/` | **PASS** | 5 assets + parity | < 1s | `target/gate35_5_qa_logs/phase2_integrity_gate.log` |
| Phase 3A — Pre-Pub `SEC-35-04` VM Suite | Audited `extension/` + `extension/firefox/` | **PASS** | **30 / 30** | < 1s | `target/gate35_5_qa_logs/phase3_security_vm.log` |
| Phase 3B — Pre-Pub Real Browsers E2E | Local frozen RC vs Desktop `v1.0.8` | **PASS** | **32 / 32** | ~37s | `target/gate35_5_qa_logs/phase3_real_browsers.log` |
| Phase 3C — Pre-Pub Signed Firefox QA | Local frozen signed XPI vs Desktop `v1.0.8` | **PASS** | **15 / 15** | ~27s | `target/gate35_5_qa_logs/phase3_signed_firefox.log` |
| Phase 4 — GitHub Publisher Dry-Run | `scripts/publish_extension_v1_0_11.js --dry-run` | **PASS** | 5 assets, `0` writes | ~2s | `target/gate35_5_qa_logs/phase4_github_dry_run.log` |
| Phase 10 — Live Public Endpoints & Downloads | Live GitHub + `toridownload.xyz` + Tools rev 2 | **PASS** | **16 / 16** | `6.14s` | `target/gate35_5_qa_logs/phase10_live_endpoints.log` |
| **Phase 11 — Post-Release Public Signed Firefox QA** | **Publicly downloaded `tori-companion-v1.0.11-firefox-signed.xpi`** vs frozen Desktop `v1.0.8` | **PASS** | **15 / 15** | `27.33s` | `target/gate35_5_qa_logs/phase11_public_signed_firefox.log` |
| **Phase 12 — Post-Release Public Chrome, Edge & Firefox QA** | **Publicly downloaded `tori-companion-v1.0.11-chromium.zip` (unpacked)** vs frozen Desktop `v1.0.8` | **PASS** | **32 / 32** | `36.57s` | `target/gate35_5_qa_logs/phase12_public_real_browsers.log` |
| **Phase 13 — Post-Release `SEC-35-04` Runtime VM Suite** | `verify_gate35_2_extension_security.js` | **PASS** | **30 / 30** | `0.35s` | `target/gate35_5_qa_logs/phase13_postrelease_security_vm.log` |
| **Phase 14 — Preservation, Registry & Secret Audit** | OEM binary/SQLite/parts, frozen artifacts, HKCU reg, 10-file secret scan | **PASS** | All checks PASS (`0` secrets) | < 2s | `target/gate35_5_qa_logs/phase14_preservation_and_secrets.log` |

**Post-Release Summary:** **93 / 93 automated post-release checks PASSED (`0` FAIL, `0` TIMEOUT, `0` BLOCKED)**.

### Functional & Security Verification Highlights (Post-Release Public Assets)
- **Signed Firefox Permanent Installation & Upgrade (Phase 11):** Installed baseline signed `v1.0.10` permanently under `xpinstall.signatures.required=true`, upgraded in-place to the publicly downloaded signed `v1.0.11` XPI (`signedState=2`, `temporarilyInstalled=false`, `id=tori-download-manager@toridm.org`, `version=1.0.11`), verified settings migration (`theme=dark`, `accent=emerald`, `port=26991`), verified active persistence across 2 full Firefox restarts, verified `0` unsolicited Native Messaging spawns on cold offline startup, verified Desktop `v1.0.8` Native Messaging pairing, verified overlay media capture & intercepted download SHA-256 match, verified duplicate prevention, verified `0` stale download replays across full restart with completed history, and blocked all live webpage/shadow-DOM/synthetic-click/iframe/SPA attacks.
- **Chrome & Edge Compatibility (Phase 12):** Loaded publicly downloaded unpacked `v1.0.11` MV3 extension (`id=jfnfgmcbgapcpieaonbaolgebjaejcdm`), verified cold offline unpaired startup (`nmInvocations=0`, `toriPidsBefore=0`, `toriPidsAfter=0`), verified `v1.0.10 -> v1.0.11` settings migration, trusted `options.html` Native Messaging pairing & `popup.html` auth with zero token leak (`tokenLeaked=false`), all live adversarial attacks blocked (`jobsDelta=0`, `nmDelta=0`), trusted overlay media download, real browser download interception with exact SHA-256 match, cooldown deduplication, and zero stale history replays after restart.
- **`SEC-35-04` Final Status:** **REMEDIATED & VERIFIED IN PRODUCTION** — zero `__TORI_DISPATCH__`, zero `__TORI_RESPONSE__`, zero `toriExtensionUrl`, closed Shadow DOM, strict runtime sender identity checks, pairing token isolated strictly to `options.html`, cross-origin iframe & synthetic click defenses verified live across Firefox, Chrome, and Edge.

---

## 7. Production Asset & Operator User-Data Preservation

| Protected Production Asset | Pre-Release Baseline | Post-Release Verified State | Status |
| :--- | :--- | :--- | :---: |
| Public Desktop Version & Latest Stable | `v1.0.8` (ID `455125259`) | `v1.0.8` (ID `455125259`) | **PRESERVED** |
| Desktop `v1.0.8` Installer SHA-256 | `728d0d253a8fadc3fea5244723237f267dcd13abf65cac49b91a4ec83a3dcffb` | Exact match | **PRESERVED** |
| Desktop `latest.json` | `version=1.0.8`, Tauri Ed25519 sig | `version=1.0.8`, sig `436` chars | **PRESERVED** |
| Previous Companion `v1.0.10` (GitHub + Website XPI) | ID `451270856` (`5` assets), XPI `a93a4387...`, ZIP `f220fab2...` | All intact & HTTP `200` | **PRESERVED** |
| Production External Tools Manifest | Rev `2`, `CDC23D8CC8DA5397`, `caa2d4ed2a7e424badcd8662e67b986a3fdfbf2847dded0625ea2b2547663f3a` | Exact match + `.sig` `408` B | **PRESERVED** |
| Stage 2 Dedicated-Only Tools Signing | `DISABLED` | `DISABLED` | **PRESERVED** |
| Production Signing Keys | Unchanged (`CDC23D8CC8DA5397` / `C3FD6626A3718E63`) | Untouched | **PRESERVED** |
| Operator Installed OEM Desktop (`v1.0.6`) | `570833b379668f64d8f0a81e0a2c138635835e0c0382f37f24ec969caccf0fda` | Exact match | **PRESERVED** |
| Operator SQLite (`tdm_storage.sqlite`) | `ok`, `56` downloads, `531` `download_chunks`, `7` `engine_settings` | Exact match (`ok`, `56`, `531`, `7`) | **PRESERVED** |
| Operator Partial `.tdm-part` Files | `21` files | `21` files | **PRESERVED** |
| Operator HKCU `NativeMessagingHosts` (Chrome, Edge, Mozilla) | Snapshotted in Phase 1 | Restored bit-for-bit across all 3 keys | **PRESERVED** |
| Stray `tori-download-manager` Processes | `0` | `0` | **CLEAN** |

---

## 8. Rollback Readiness & Unresolved Risks

### Rollback Readiness (Verified Live)
- **Website Rollback:** Cloudflare Pages deployment `5bc37b77-c69b-4080-97a5-a2e1195f2ca3` (`181b3fb7c4d2abb9889d7d988b223fe63e02506f`) and live `https://toridownload.xyz/assets/tori-download-manager-firefox-v1.0.10.xpi` (`a93a4387...`) remain intact for rollback via Cloudflare Pages dashboard or `git revert` on `tori-website-private` `main`. Note: reverting website links stops new downloads of `v1.0.11` and does not automatically downgrade already-installed browser extensions.
- **GitHub Containment:** `extension-v1.0.10` (ID `451270856`) and Desktop `v1.0.8` (ID `455125259`) remain completely intact and downloadable; `extension-v1.0.11` (ID `458864802`) can be marked `prerelease` or `draft` without disturbing `v1.0.8` or `v1.0.10`.

### Unresolved / Carried-Forward Non-Blocking Risks
1. **Unpacked Distribution for Chromium/Edge:** Browser Companion `v1.0.11` for Chrome and Edge is currently distributed as an unpacked MV3 ZIP via GitHub and `toridownload.xyz` (not yet submitted to Chrome Web Store or Microsoft Edge Add-ons Store). Existing Chrome/Edge users must extract and reload `v1.0.11` to receive the `SEC-35-04` fix.
2. **Desktop `v1.0.9` Carried-Forward Work (Outside Gate 35.5 Scope):** Desktop-side fixes from Gate 35.2 (Priority 2 `Content-Range` fallback and Priority 3 native-host spawn mutex / minimized-tray handling) remain staged in source awaiting future Desktop `v1.0.9` release gating (clean Win10/Win11 VM QA, Authenticode signing `RISK-34-02`, offline key backup `RISK-34-01`, and Stage 2 dedicated tools signing cutover).
3. **Host Operator Native Messaging Registry Note:** The operator's host HKCU `NativeMessagingHosts` keys remained untouched at their pre-existing Gate 35.2 state (`target\_oem_state_backups\gate34_2_live_25300_1795622594846\nm_*_blocked.json`, preserved bit-for-bit per non-mutation rules).

---

## 9. Final Verdict & Next Recommended Gate

- **Final Verdict:** **`GATE 35.5: FULL GO`** (all 26 acceptance criteria satisfied with executed live evidence).
- **Next Recommended Gate:** **Gate 36.1 — Desktop `v1.0.9` Release Preparation & Clean Windows 10/11 VM QA** (incorporating Gate 35.2 `Content-Range` + startup-popup Desktop fixes, optional Chrome Web Store / Edge Add-ons Store packaging for Companion `v1.0.11`, and Stage 2 External Tools dedicated-key cutover readiness).
