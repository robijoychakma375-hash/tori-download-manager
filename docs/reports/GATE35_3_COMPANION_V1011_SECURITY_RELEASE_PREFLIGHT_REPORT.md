# TORI Download Manager — Gate 35.3 Browser Companion v1.0.11 Security Release Preflight Report

**Date:** 2026-11-25  
**Gate:** Gate 35.3 — Browser Companion `v1.0.11` (`SEC-35-04`) Security Hotfix Release Preflight  
**Branch:** `feat/gate35_2-companion-security-and-triage`  
**Base Gate 35.2 Commit / Tag:** `48184cb2b6d05d25e3ffc47f967f4ca11a82a025` (`checkpoint-gate35_2-security-hotfix-and-triage-verified`)  
**Release Action Taken:** **NONE** (strict preflight only; public Companion `v1.0.10`, public Desktop `v1.0.8`, `toridownload.xyz`, production tools manifest revision 2, and signing keys remain 100% untouched)  
**Firefox AMO Signing Status:** **`FIREFOX_AMO_SIGNING_BLOCKED`** *(no AMO credentials locally; real Firefox v160 verified `ERROR_SIGNEDSTATE_REQUIRED` on unsigned ZIP)*  
**Final Outcome:** **`CONDITIONAL GO`** *(all security, live browser adversarial, Chrome/Edge/Firefox compatibility, Native Messaging, settings migration, Desktop `v1.0.8` compatibility, package integrity, and dedicated-key fingerprint reconciliation checks PASSED; public release remains gated on Mozilla AMO signing of `tori-companion-v1.0.11-firefox.zip` and explicit separate owner release authorization).*

---

## 1. Executive Summary & Source Commit

Gate 35.3 independently audited Gate 35.2's `SEC-35-04` remediation, discovered and closed three additional defense-in-depth hardening gaps in the extension runtime, executed **live adversarial and compatibility QA inside real Google Chrome (v158), Microsoft Edge (v158), and Mozilla Firefox (v160)** against the **real frozen public Desktop `v1.0.8` binary**, verified Mozilla AMO signing prerequisites, audited final `v1.0.11` RC artifacts, and cryptographically reconciled the dedicated External Tools public-key fingerprint discrepancy.

- **Gate 35.2 Baseline Commit:** `48184cb2b6d05d25e3ffc47f967f4ca11a82a025`
- **Gate 35.3 Preflight Hardening Changes (committed at Gate 35.3 checkpoint):**
  1. **MV3 Cold Service Worker Restart Fix ([`extension/background.js`](file:///F:/TORI/final%20tori%20download%20manager/extension/background.js)):** Moved `ensureSettingsLoaded()` before reading `extSettings.port` / `extSettings.key` in both `GET_CONNECTION_STATUS` and `PING_DESKTOP` so a freshly woken Service Worker never sends empty default credentials on its first status check.
  2. **Runtime Payload Size & Complexity Bounds ([`extension/background.js`](file:///F:/TORI/final%20tori%20download%20manager/extension/background.js)):** Added `validateRuntimeMessageBounds()` inside `authorizeRuntimeMessage()` rejecting payloads > `65,536` bytes, > `32` keys, arrays, or non-serializable/circular objects (`PAYLOAD_TOO_LARGE` / `INVALID_MESSAGE`).
  3. **Production Cleanliness & Content Listener Sender Pinning ([`extension/background.js`](file:///F:/TORI/final%20tori%20download%20manager/extension/background.js), [`extension/content.js`](file:///F:/TORI/final%20tori%20download%20manager/extension/content.js)):** Removed the `globalThis.__TORI_BG_SECURITY__` global hook from production code (zero test/debug globals shipped; enforced by `package_v1_0_11_extensions.js`), and added `sender.id === chrome.runtime.id` checks to both `chrome.runtime.onMessage` listeners in `content.js`.
  4. **Synced to `extension/firefox/` & Repackaged `release/v1.0.11-extension-rc/`** with 100% byte-for-byte parity.

### Global Skills Applied (Per Global Skill Usage Policy)
`chrome-extensions`, `security-auditor`, `playwright-skill` (read for browser automation safety boundaries; native Chrome/Edge CDP and Firefox Marionette harnesses executed directly with zero unapproved package installs), `code-review-checklist`, `systematic-debugging`, and `typescript-expert`.

---

## 2. Security Vulnerability Remediation Evidence (`SEC-35-04`)

Evidence is strictly separated by verification layer to distinguish static inspection from runtime authorization tests and real browser execution:

### 2.1 Static Source Assertions (Audited Source & Packaged ZIPs)
- **Zero prohibited webpage bridges:** `0` hits for `__TORI_DISPATCH__`, `__TORI_RESPONSE__`, `toriExtensionUrl`, `postMessage`, `onMessageExternal`, `onConnectExternal`, `externally_connectable`, `eval(`, `new Function(`, `debugger`, or `__TORI_BG_SECURITY__` across `extension/`, `extension/firefox/`, `tori-companion-v1.0.11-chromium.zip`, and `tori-companion-v1.0.11-firefox.zip`.
- **Closed Shadow DOM & Trusted Input Guards:** Overlay portal uses `host.attachShadow({ mode: 'closed' })`; `pill`, `playlistBtn`, and `dlBtn` click handlers require `e.isTrusted === true`.
- **Content-Script `runtime.onMessage` Hardening:** Both listeners in `content.js` verify `sender.id === chrome.runtime.id`.
- **Manifest Hardening:** Neither Chromium nor Firefox `manifest.json` declares `externally_connectable`; extension IDs and permissions remain unchanged from `v1.0.10`.

### 2.2 Isolated Runtime Authorization Suite (`scripts/verify_gate35_2_extension_security.js` — **30 / 30 PASS**)
Executed directly against real `extension/background.js` (Chromium/Edge) and `extension/firefox/background.js` (Firefox):

| Security Scenario Tested (Both Chromium/Edge & Firefox) | Result |
| :--- | :---: |
| Content script blocked on ALL 15 privileged actions (`INITIATE_PAIRING`, `RECONNECT_DESKTOP`, `PING_DESKTOP`, `GET_CONNECTION_STATUS`, `GET_ALL_MEDIA`, `GET_DOWNLOADS`, `PAUSE/RESUME/CANCEL/RETRY_DOWNLOAD`, `SHOW_DESKTOP`, `OPEN_OPTIONS`, `OPEN_POPUP_TAB`, `RESOLVE_PLAYLIST`, `ENQUEUE_PLAYLIST`) — zero token leak, zero native-host calls | **PASS** |
| Foreign extension `sender.id` rejected for privileged & content actions | **PASS** |
| Embedded extension iframe (`frameId > 0`) and non-whitelisted extension URL rejected | **PASS** |
| Cross-origin iframe content script rejected on privileged actions | **PASS** |
| Cross-tab `GET_TAB_MEDIA` spying blocked (content scripts locked to `sender.tab.id`) | **PASS** |
| Content-script `destination` override rejected (`FORBIDDEN_FIELD`); flag-prefixed URLs/format_ids and non-HTTP schemes rejected | **PASS** |
| Path-traversal `job_id` rejected on download control endpoints | **PASS** |
| Token minimization: pairing `token` returned ONLY to `options/options.html` (stripped from `popup/popup.html`) | **PASS** |
| Invalid, array, unknown (`EXPORT_SECRET_TOKEN`), wide (>32 keys), and oversized (>64 KiB) payloads rejected (`INVALID_MESSAGE` / `UNKNOWN_ACTION` / `PAYLOAD_TOO_LARGE`) | **PASS** |
| Content-script `START_DOWNLOAD` burst rate limit enforced (`RATE_LIMITED`) | **PASS** |
| Cold MV3 Service Worker restart loads persisted port/key before first `GET_CONNECTION_STATUS` & `PING_DESKTOP` | **PASS** |
| Startup replay of completed/interrupted/paused/stale (>60s) downloads blocked; offline `onStartup` triggers 0 native-host spawns | **PASS** |

---

## 3. Actual Browser-Executed Adversarial Tests (Chrome v158, Edge v158, Firefox v160)

Executed via [`scripts/verify_gate35_3_real_browsers.js`](file:///F:/TORI/final%20tori%20download%20manager/scripts/verify_gate35_3_real_browsers.js) inside isolated real browser profiles against **two distinct local HTTP origins** (`http://127.0.0.1:25995` main page + `http://127.0.0.1:25996` cross-origin iframe) and the **real frozen Desktop `v1.0.8`** binary (`target/gate35_3_qa_logs/real_browsers_qa.log`):

| Live Browser Attack Vector | Microsoft Edge `v158.0.4370.33` | Google Chrome `v158.0.8127.38` | Mozilla Firefox `v160.0.1` | Observed Proof |
| :--- | :---: | :---: | :---: | :--- |
| Page JS reads `document.documentElement.dataset.toriExtensionUrl` | **PASS** | **PASS** | **PASS** | `null` (absent) in all 3 browsers |
| Page JS dispatches `CustomEvent('__TORI_DISPATCH__', { action: 'INITIATE_PAIRING' })` | **PASS** | **PASS** | **PASS** | `dispatchResponseReceived=false`, `0` native-host calls |
| Page JS probes `document.getElementById('tori-overlay-portal-host').shadowRoot` | **PASS** | **PASS** | **PASS** | `portalExists=true`, `shadowRoot === null` (closed Shadow DOM) |
| Page JS fires synthetic `.click()` & `new MouseEvent('click')` on `.tori-pill` & `[data-act="download"]` | **PASS** | **PASS** | **PASS** | `jobsDelta=0` (rejected by `e.isTrusted`) |
| Page JS calls `chrome.runtime.sendMessage(extId, { action: 'INITIATE_PAIRING' })` (external messaging) | **PASS** | **PASS** | **PASS** | `externalMsgSucceeded=false` (`externally_connectable` absent) |
| Cross-origin `<iframe>` (`127.0.0.1:25996`) runs `__TORI_DISPATCH__` + `toriExtensionUrl` probe | **PASS** | **PASS** | **PASS** | `iframeResp=false`, `toriExtensionUrl=null` |
| SPA navigation (`history.pushState` + `popstate`) & cross-origin iframe reload re-attack | **PASS** | **PASS** | **PASS** | `dispatchResp=false`, `urlLeak=null`, `jobsDelta=0`, `nmDelta=0` |

---

## 4. Browser Compatibility & Desktop `v1.0.8` Integration Matrix

All live browser tests ran directly against frozen public **`release/v1.0.8-final-rc/tori-download-manager.exe`** (SHA-256 `197d2b6bda12a6a4aa8a71664d0bde8b7db723a836f04980bd48fbccecbb6fbf`) and **`release/v1.0.8-final-rc/tdm-native-host.exe`**. Zero unpublished Desktop `v1.0.9` features were used or required.

| Compatibility Requirement | Edge `v158` | Chrome `v158` | Firefox `v160` | Evidence / Notes |
| :--- | :---: | :---: | :---: | :--- |
| Extension load & preserved ID (`jfnfgmcbgapcpieaonbaolgebjaejcdm` / `tori-download-manager@toridm.org`) | **PASS** | **PASS** | **PASS** *(temp)* | Permanent Firefox install **BLOCKED** pending AMO signing (see §5) |
| Unpaired startup with Desktop offline — zero unsolicited Desktop/Native-Host spawn | **PASS** | **PASS** *(VM + restart)* | **PASS** *(VM)* | Live Edge cold unpaired startup: `nmInvocations=0`, `toriPidsBefore=0`, `toriPidsAfter=0` |
| `v1.0.10` → `v1.0.11` settings migration (`theme`, `accent`, `sites`, `types`, `port`) | **PASS** | **PASS** | **PASS** | All migrated settings persisted across options reload |
| Trusted `options.html` Native Messaging pairing (`INITIATE_PAIRING`) with Desktop `v1.0.8` | **PASS** | **PASS** | **PASS** | `ok=true`, exact token & port `25991` returned via `v1.0.8` `tdm-native-host.exe` |
| Trusted `options.html` `GET_CONNECTION_STATUS` with Desktop `v1.0.8` | **PASS** | **PASS** | **PASS** *(VM)* | `state=connected`, Bridge API `v2.0.0` |
| Trusted `popup.html` `PING_DESKTOP` + token minimization | **PASS** | **PASS** | **PASS** | `auth=true`, `tokenLeaked=false` in all 3 browsers |
| Media discovery, overlay mount & real trusted-click user download on Desktop `v1.0.8` | **PASS** | **PASS** | **PASS** | Trusted pointer click opens `.tori-pn.on` & queues media job in Desktop `v1.0.8` |
| Browser download interception (`sample_archive.zip`, 256 KiB) completed by Desktop `v1.0.8` | **PASS** | **PASS** | **PASS** | `state=completed`, exact SHA-256 `8f2144a274ead978258dbbcc0b62c5b0ee7335eb2bf729fbb5ca4026af0f0a14` in all 3 browsers |
| Duplicate download prevention within cooldown window | **PASS** | **PASS** | **PASS** | Repeat click produced `0` duplicate jobs in all 3 browsers |
| Browser restart with completed download history — zero stale replay & zero unsolicited NM spawn | **PASS** | **PASS** | **NOT TESTED** *(temp add-on does not persist across Firefox restart until AMO-signed)* | Edge & Chrome restart: `jobsDelta=0`, `nmDelta=0`; Firefox stale-replay logic verified in VM suite (**PASS**) |

---

## 5. Phase 4 — Mozilla AMO Signing Status: `FIREFOX_AMO_SIGNING_BLOCKED`

1. **Existing Approved Signing Workflow Inspected:** Historical releases (`v1.0.7`, `v1.0.9`, `v1.0.10` — confirmed via `scripts/audit_gate31_2_signed_xpi.js` and `release/v1.0.10-extension-rc/verification_metadata.json`) were signed by the project owner submitting the unsigned `web-ext build` ZIP (`tori-companion-vX.Y.Z-firefox.zip`) to Mozilla Add-ons (AMO) and returning the Mozilla-signed `.xpi` for local audit & verification.
2. **Local AMO Credential Presence Audit (Boolean Check Only — Zero Secrets Read or Printed):**
   - `AMO_JWT_ISSUER = False`, `AMO_JWT_SECRET = False`, `WEB_EXT_API_KEY = False`, `WEB_EXT_API_SECRET = False`, `MOZILLA_API_KEY = False`, `MOZILLA_API_SECRET = False`, `AMO_API_KEY = False`, `AMO_API_SECRET = False`.
   - `~/.web-ext-config.{js,cjs,json}`, `%APPDATA%\web-ext\config.json`, `.env`, and `web-ext-config.js` are all absent (`False`).
3. **Live Firefox Permanent-Install Negative Proof (`xpinstall.signatures.required = true`):**
   - Real Mozilla Firefox `v160.0.1` rejected `Addon:Install(tori-companion-v1.0.11-firefox.zip, temporary: false)` with:
     `ERROR_SIGNEDSTATE_REQUIRED: The addon must be signed and isn't.`
4. **Honest Status:** **`FIREFOX_AMO_SIGNING_BLOCKED`**. `tori-companion-v1.0.11-firefox.zip` passes `web-ext lint` with **0 errors** (7 warnings, 0 notices) and is ready for owner AMO submission, but is **NOT** production-ready for permanent Firefox installation until Mozilla signs it into a verified `.xpi`.

---

## 6. Phase 5 — Final `v1.0.11` Release Candidate Artifacts & Integrity Audit

Verified via `node scripts/package_v1_0_11_extensions.js` and Phase 5 Python byte-parity/secret audit (`target/gate35_3_qa_logs/phase5_package_audit.log`):

| Artifact (`release/v1.0.11-extension-rc/`) | Bytes | Files | SHA-256 | Source Parity | Forbidden / Debug / Secrets | Signing / Release Status |
| :--- | ---: | ---: | :--- | :---: | :---: | :--- |
| **`tori-companion-v1.0.11-chromium.zip`** | `94,625` | 35 | **`1e77592bb05e548d832df373331aee4f90788a004cdaef7ca80c97df84b88559`** | **100% EXACT** (`0` diffs, `0` backslashes, `testzip=OK`) | `0` / `0` / `0` | **READY** (Chrome & Edge MV3; unpublished local RC) |
| `tori-companion-v1.0.11-chromium/` (unpacked) | — | 35 | Parity verified | **100% EXACT** | `0` / `0` / `0` | **READY** (Developer Mode / QA) |
| **`tori-companion-v1.0.11-firefox.zip`** *(unsigned AMO candidate)* | `95,444` | 35 (42 ZIP records) | **`2df9b5cb1e391b9023f6b4217efee9baa182c36aaeb8c3e891a71515abf9edad`** | **100% EXACT** (`0` diffs, `0` backslashes, `testzip=OK`, `web-ext lint`: **0 errors**) | `0` / `0` / `0` | **`FIREFOX_AMO_SIGNING_BLOCKED`** (`META-INF/` absent; unsigned) |
| Signed Firefox `.xpi` | — | — | **NOT AVAILABLE** *(pending AMO signing)* | — | — | **`FIREFOX_AMO_SIGNING_BLOCKED`** |

- **Manifest & Permissions Audit:** Both manifests are version `1.0.11`, preserve exact extension IDs (`jfnfgmcbgapcpieaonbaolgebjaejcdm` & `tori-download-manager@toridm.org`), keep identical permissions to `v1.0.10` (`downloads`, `nativeMessaging`, `webRequest`, `storage`, `tabs`, `activeTab`), and omit `externally_connectable`.
- **No Unrelated Desktop Binaries Repackaged:** Desktop `v1.0.8` installer and binaries were not rebuilt or modified.

---

## 7. Phase 6 — Dedicated Public-Key Fingerprint Audit & Reconciliation

Independently inspected **only the public key file** (`%USERPROFILE%\.tori-keys\tori-tools.key.pub`), [`crates/tdm-core/src/tools/trust.rs`](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/src/tools/trust.rs), the compiled frozen binary `release/v1.0.8-final-rc/tori-download-manager.exe`, and the Gate 33.3, Gate 34.2, and Gate 35.1 reports (no private key read, modified, or rotated):

| Cryptographic Artifact / Derivation | Exact Verified Value |
| :--- | :--- |
| Disk Public Key File (`%USERPROFILE%\.tori-keys\tori-tools.key.pub`) | `152` bytes (base64-encoded minisign public key box); SHA-256 of `.pub` file: `6b734db9b13479ffa9e47bbd22b6542abcc3d4ead17ad2ce0efaa92537320c3f` |
| Embedded Constant `TORI_DEDICATED_TOOLS_ED25519_PUBKEY_B64` (`trust.rs:24-26`) | **100% byte-for-byte identical** to `%USERPROFILE%\.tori-keys\tori-tools.key.pub` (SHA-256 `6b734db9b13479ffa9e47bbd22b6542abcc3d4ead17ad2ce0efaa92537320c3f`) |
| Compiled Public Desktop `v1.0.8` Binary (`release/v1.0.8-final-rc/tori-download-manager.exe`) | Contains the exact 152-byte base64 public key string & Key ID `C3FD6626A3718E63` verbatim (`true`), alongside legacy key `CDC23D8CC8DA5397` (`true`) |
| Decoded Minisign Box (`114` bytes) | Line 1: `untrusted comment: minisign public key: C3FD6626A3718E63`; Line 2: `RWRjjnGjJmb9w6jUa600IrWjSMaszdRM8vcvOnzuKPfHqReck4SksezM`; SHA-256 of box: `53f9c961df07efa22777ea3a4e7adccb718cbc42a0008a056e6a117f40bd0c4c` |
| Decoded 42-Byte Minisign Binary (`RW` + 8-byte Key ID + 32-byte Ed25519 pubkey) | Key ID (little-endian): **`C3FD6626A3718E63`**; SHA-256 of 42-byte blob: `ad4dec8ce74929f7924e45ffa5938c25f20c15444625f554b5f55bf0f2edf15d` |
| **Canonical Raw 32-Byte Ed25519 Public Key SHA-256 Fingerprint** | **`6807e183f56c08eb06fdff95347bbbf7174b4ce5185b0245155db315e87fee39`** |

### Reconciliation Across Historical Reports
- **`crates/tdm-core/src/tools/trust.rs:21`:** `6807e183f56c08eb06fdff95347bbbf7174b4ce5185b0245155db315e87fee39` — **EXACT MATCH**
- **Gate 33.3 Report (`docs/reports/GATE33_3_DEDICATED_TOOLS_KEY_AND_V108_FINAL_RC_REPORT.md:21,87,106`):** `6807e183f56c08eb06fdff95347bbbf7174b4ce5185b0245155db315e87fee39` — **EXACT MATCH**
- **Gate 34.2 Report (`docs/reports/GATE34_2_...md:269`):** `6807e183f56c08eb06fdff95347bbbf7174b4ce5185b0245155db315e87fee39` — **EXACT MATCH**
- **Gate 35.1 Report (`docs/reports/GATE35_1_POST_RELEASE_SECURITY_HARDENING_REPORT.md:26`):** `6807e183079787d7d00f889293a27a880b2a346e83556d3d090f28b92a132c9d` — **DOCUMENTATION TRANSCRIPTION ERROR ONLY** (shares the `6807e183` prefix with a mistyped suffix; matches none of the `.pub`, box, 42-byte, or 32-byte hashes).

**Security Impact Verdict:** **NONE.** The production disk public key, the Rust source constant, and the published Desktop `v1.0.8` binary are **100% cryptographically identical** (`C3FD6626A3718E63` / `6807e183f56c08eb06fdff95347bbbf7174b4ce5185b0245155db315e87fee39`).

---

## 8. Final QA Matrix & Strict Preservation Evidence

| QA Suite | Command | Exit Code | Result | Log File |
| :--- | :--- | :---: | :--- | :--- |
| v1.0.11 RC Packaging & `web-ext lint` | `node scripts/package_v1_0_11_extensions.js` | `0` | **PASS** (`0` lint errors, 5 preserved artifacts intact) | `target/gate35_3_qa_logs/package_v1_0_11.log` |
| VM Runtime Authorization & Cold SW Suite | `node scripts/verify_gate35_2_extension_security.js` | `0` | **PASS (30 / 30)** | `target/gate35_3_qa_logs/extension_security_vm.log` |
| Live Real-Browser Adversarial & Compatibility Suite (Edge + Chrome + Firefox vs Desktop `v1.0.8`) | `node scripts/verify_gate35_3_real_browsers.js` | `0` | **PASS (32 / 32, 0 FAIL, 0 BLOCKED)** + bit-for-bit HKCU NM registry restore | `target/gate35_3_qa_logs/real_browsers_qa.log` |
| Phase 5 ZIP Parity, Secret Scan & Preservation Audit | Python audit script | `0` | **PASS** (`0` source mismatches, `0` forbidden strings, `0` secrets) | `target/gate35_3_qa_logs/phase5_package_audit.log` |
| Firefox Permanent-Install Signing Gate | Live Firefox v160 `Addon:Install(temporary:false)` | — | **BLOCKED (`FIREFOX_AMO_SIGNING_BLOCKED`)** — rejected with `ERROR_SIGNEDSTATE_REQUIRED` as expected | `target/gate35_3_qa_logs/real_browsers_qa.log` |

### Strict Non-Modification & OEM Preservation Verification
- Frozen Desktop `v1.0.8` Installer (`728d0d25...`): **UNCHANGED (`true`)**
- Public Companion `v1.0.10` Chromium ZIP (`f220fab2...`), Signed Firefox XPI (`a93a4387...`), Firefox ZIP (`56139a06...`): **UNCHANGED (`true`)**
- OEM `v1.0.6` Binary (`570833b3...`), OEM SQLite (`PRAGMA integrity_check = ok`, `56` downloads, `531` chunks), Host HKCU `NativeMessagingHosts` registry snapshot: **100% PRESERVED / RESTORED**
- Official Website repo (`C:\Users\ritud\Downloads\tori-website`), GitHub Releases, Production Tools Manifest rev 2, and Signing Keys: **100% UNCHANGED**

---

## 9. Remaining Blockers & Exact Next Release Steps

### Remaining Blockers
1. **`FIREFOX_AMO_SIGNING_BLOCKED`:** Mozilla AMO signing credentials are not present locally. The unsigned `tori-companion-v1.0.11-firefox.zip` cannot be permanently installed in standard Firefox until signed by Mozilla AMO into a verified `.xpi`.
2. **Explicit Owner Release Authorization:** Separate explicit authorization is required before creating/publishing GitHub release `extension-v1.0.11` or updating `toridownload.xyz`.

### Exact Next Steps for Public Companion `v1.0.11` Security Hotfix Release
1. **Owner AMO Submission:** Upload `release/v1.0.11-extension-rc/tori-companion-v1.0.11-firefox.zip` (SHA-256 `2df9b5cb1e391b9023f6b4217efee9baa182c36aaeb8c3e891a71515abf9edad`) to Mozilla Add-ons Developer Hub (Self-Distribution / Unlisted) and download the Mozilla-signed `.xpi`.
2. **Signed XPI Verification Gate:** Place the Mozilla-signed `.xpi` into `release/v1.0.11-extension-rc/tori-companion-v1.0.11-firefox-signed.xpi`, verify `META-INF/` signatures + byte parity against `tori-companion-v1.0.11-firefox.zip`, and execute real Firefox `Addon:Install(temporary: false)` + restart persistence check under `xpinstall.signatures.required = true`.
3. **Owner Release Authorization:** After signed Firefox verification passes, issue explicit authorization to publish GitHub tag/release `extension-v1.0.11` (`make_latest: "false"` so Desktop `v1.0.8` remains repository Latest Stable) and update `toridownload.xyz` Companion links.

### Final Outcome: **`CONDITIONAL GO`**
- **Chromium / Edge (`tori-companion-v1.0.11-chromium.zip`):** **Technically READY** (all live adversarial, compatibility, migration, and Desktop `v1.0.8` checks passed).
- **Firefox (`tori-companion-v1.0.11-firefox.zip`):** **`FIREFOX_AMO_SIGNING_BLOCKED`** until Mozilla-signed `.xpi` is produced and verified under `xpinstall.signatures.required = true`.
