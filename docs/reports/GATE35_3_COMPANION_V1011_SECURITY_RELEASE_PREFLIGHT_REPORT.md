# TORI Download Manager — Gate 35.3 Browser Companion v1.0.11 Security Release Preflight Report

**Date:** 2026-11-26  
**Gate:** Gate 35.3 — Browser Companion `v1.0.11` (`SEC-35-04`) Security Hotfix Release Preflight & Signed Firefox Verification  
**Branch:** `feat/gate35_2-companion-security-and-triage`  
**Base Preflight Commit / Tag:** `ae27e96637c6b3227f07e2ec071b23bd1a22c956` (`checkpoint-gate35_3-companion-v1011-preflight-verified`, built on Gate 35.2 `48184cb2b6d05d25e3ffc47f967f4ca11a82a025`)  
**Release Action Taken:** **NONE** (strict preflight only; public Companion `v1.0.10`, public Desktop `v1.0.8`, `toridownload.xyz`, production tools manifest revision 2, and signing keys remain 100% untouched)  
**Firefox AMO Signing Status:** **VERIFIED — MOZILLA AMO PRODUCTION SIGNED (`SIGNEDSTATE_SIGNED`)**  
**Final Outcome:** **`GATE 35.3: GO — FIREFOX SIGNED XPI VERIFIED`** *(all Chromium/Edge and Mozilla-signed Firefox `v1.0.11` artifacts, live browser adversarial tests, permanent Firefox installation & restart persistence, `v1.0.10` → `v1.0.11` upgrade migration, Desktop `v1.0.8` Native Messaging compatibility, package integrity, and dedicated-key fingerprint reconciliation checks PASSED; artifacts are ready for separate explicit Gate 35.4 owner public release authorization).*

---

## 1. Executive Summary & Source Commit

Gate 35.3 completed full independent verification and Mozilla AMO signing integration for Browser Companion `v1.0.11` (`SEC-35-04`):

- **Audited Source Commit (Extension Code):** `ae27e96637c6b3227f07e2ec071b23bd1a22c956` (zero changes to extension source bytes after packaging `tori-companion-v1.0.11-chromium.zip` and `tori-companion-v1.0.11-firefox.zip`).
- **Additional Gate 35.3 Hardening Included in `v1.0.11`:**
  1. **MV3 Cold Service Worker Restart Fix ([`extension/background.js`](file:///F:/TORI/final%20tori%20download%20manager/extension/background.js)):** `GET_CONNECTION_STATUS` and `PING_DESKTOP` await `ensureSettingsLoaded()` before reading `extSettings.port` / `extSettings.key`.
  2. **Runtime Payload Size & Complexity Bounds ([`extension/background.js`](file:///F:/TORI/final%20tori%20download%20manager/extension/background.js)):** `validateRuntimeMessageBounds()` enforces max `65,536` serialized bytes and max `32` keys, rejecting arrays/circular payloads (`PAYLOAD_TOO_LARGE` / `INVALID_MESSAGE`).
  3. **Production Cleanliness & Content Listener Sender Pinning ([`extension/background.js`](file:///F:/TORI/final%20tori%20download%20manager/extension/background.js), [`extension/content.js`](file:///F:/TORI/final%20tori%20download%20manager/extension/content.js)):** Removed `globalThis.__TORI_BG_SECURITY__` from production code and added `sender.id === chrome.runtime.id` checks to both `chrome.runtime.onMessage` listeners in `content.js`.
- **Mozilla AMO Signing Completed & Staged:** Verified Mozilla-signed XPI (`a70ed17e183648a9bcf4-1.0.11.xpi`) staged to `release/v1.0.11-extension-rc/tori-companion-v1.0.11-firefox-signed.xpi` with SHA-256 `4cd6d6fbf067cb98538fd807eaba360d40b409df07cbfb515b8d9b702b37c0fd` (`111,347` bytes) and verified in standard Mozilla Firefox `v160.0.1` under `xpinstall.signatures.required = true` (`15 / 15 PASS`).

### Global Skills Applied (Per Global Skill Usage Policy)
`chrome-extensions`, `security-auditor`, `playwright-skill`, `code-review-checklist`, `systematic-debugging`, and `typescript-expert`.

---

## 2. Security Vulnerability Remediation Evidence (`SEC-35-04`)

### 2.1 Static Source Assertions (Audited Source, Chromium ZIP, Unsigned Firefox ZIP & Signed Firefox XPI)
- **Zero prohibited webpage bridges or debug hooks:** `0` hits for `__TORI_DISPATCH__`, `__TORI_RESPONSE__`, `toriExtensionUrl`, `__TORI_BG_SECURITY__`, `postMessage`, `onMessageExternal`, `onConnectExternal`, `externally_connectable`, `eval(`, `new Function(`, or `debugger` across audited source and all packaged artifacts (including the Mozilla-signed `.xpi`).
- **Closed Shadow DOM & Trusted Input Guards:** Overlay portal uses `host.attachShadow({ mode: 'closed' })`; `pill`, `playlistBtn`, and `dlBtn` click handlers require `e.isTrusted === true`.
- **Content-Script `runtime.onMessage` Hardening:** Both listeners in `content.js` require `sender.id === chrome.runtime.id`.

### 2.2 Isolated Runtime Authorization Suite (`scripts/verify_gate35_2_extension_security.js` — **30 / 30 PASS**)
Executed directly against `extension/background.js` (Chromium/Edge) and `extension/firefox/background.js` (Firefox):

| Security Scenario Tested (Both Chromium/Edge & Firefox) | Result |
| :--- | :---: |
| Content script blocked on ALL 15 privileged actions — zero token leak, zero native-host calls | **PASS** |
| Foreign extension `sender.id`, embedded extension iframe (`frameId > 0`), non-whitelisted extension URL, and cross-origin iframe content script rejected | **PASS** |
| Cross-tab `GET_TAB_MEDIA` spying blocked (content scripts locked to `sender.tab.id`) | **PASS** |
| Content-script `destination` override rejected (`FORBIDDEN_FIELD`); flag-prefixed URLs/`format_id`s, non-HTTP schemes, and path-traversal `job_id`s rejected | **PASS** |
| Token minimization: pairing `token` returned ONLY to `options/options.html` (stripped from `popup/popup.html`) | **PASS** |
| Invalid, array, unknown, wide (>32 keys), and oversized (>64 KiB) payloads rejected (`INVALID_MESSAGE` / `UNKNOWN_ACTION` / `PAYLOAD_TOO_LARGE`) | **PASS** |
| Content-script `START_DOWNLOAD` burst rate limit enforced (`RATE_LIMITED`) | **PASS** |
| Cold MV3 Service Worker restart loads persisted port/key before first `GET_CONNECTION_STATUS` & `PING_DESKTOP` | **PASS** |
| Startup replay of completed/interrupted/paused/stale (>60s) downloads blocked; offline `onStartup` triggers 0 native-host spawns | **PASS** |

---

## 3. Actual Browser-Executed Adversarial Tests (Chrome v158, Edge v158, Signed Firefox v160)

Executed via [`scripts/verify_gate35_3_real_browsers.js`](file:///F:/TORI/final%20tori%20download%20manager/scripts/verify_gate35_3_real_browsers.js) (Edge, Chrome, temp Firefox) and [`scripts/verify_gate35_3_signed_firefox.js`](file:///F:/TORI/final%20tori%20download%20manager/scripts/verify_gate35_3_signed_firefox.js) (permanently installed Mozilla-signed Firefox XPI) against two distinct local HTTP origins (main page + cross-origin iframe) and the **real frozen public Desktop `v1.0.8`** binary:

| Live Browser Attack Vector | Edge `v158.0.4370.33` | Chrome `v158.0.8127.38` | Signed Firefox `v160.0.1` (Permanent XPI) | Observed Proof |
| :--- | :---: | :---: | :---: | :--- |
| Page JS reads `document.documentElement.dataset.toriExtensionUrl` | **PASS** | **PASS** | **PASS** | `null` (absent) |
| Page JS dispatches `CustomEvent('__TORI_DISPATCH__', { action: 'INITIATE_PAIRING' })` | **PASS** | **PASS** | **PASS** | `dispatchResponseReceived=false`, `0` NM calls |
| Page JS probes `document.getElementById('tori-overlay-portal-host').shadowRoot` | **PASS** | **PASS** | **PASS** | `portalExists=true`, `shadowRoot === null` |
| Page JS fires synthetic `.click()` & `new MouseEvent('click')` on `.tori-pill` & `[data-act="download"]` | **PASS** | **PASS** | **PASS** | `jobsDelta=0` (rejected by `e.isTrusted`) |
| Page JS calls `chrome.runtime.sendMessage(extId, ...)` (external messaging) | **PASS** | **PASS** | **PASS** | `externalMsgSucceeded=false` (`externally_connectable` absent) |
| Cross-origin `<iframe>` (`127.0.0.1:25996` / `:26996`) runs `__TORI_DISPATCH__` + `toriExtensionUrl` probe | **PASS** | **PASS** | **PASS** | `iframeResp=false`, `toriExtensionUrl=null` |
| SPA navigation (`history.pushState` + `popstate`) & cross-origin iframe reload re-attack | **PASS** | **PASS** | **PASS** | `dispatchResp=false`, `urlLeak=null`, `jobsDelta=0`, `nmDelta=0` |

---

## 4. Browser Compatibility & Desktop `v1.0.8` Integration Matrix

All live browser tests ran directly against frozen public **`release/v1.0.8-final-rc/tori-download-manager.exe`** (`197d2b6bda12a6a4aa8a71664d0bde8b7db723a836f04980bd48fbccecbb6fbf`) and **`release/v1.0.8-final-rc/tdm-native-host.exe`**. Zero unpublished Desktop `v1.0.9` features were required.

| Compatibility Requirement | Edge `v158` | Chrome `v158` | Signed Firefox `v160` (Permanent XPI) | Evidence |
| :--- | :---: | :---: | :---: | :--- |
| Preserved extension ID (`jfnfgmcbgapcpieaonbaolgebjaejcdm` / `tori-download-manager@toridm.org`) | **PASS** | **PASS** | **PASS** | Exact match with `v1.0.10` |
| Permanent install under `xpinstall.signatures.required=true` (`SIGNEDSTATE_SIGNED`) | N/A | N/A | **PASS** | `sigRequiredPref=true`, `signedState=2`, `temporarilyInstalled=false`, `isActive=true` |
| Full browser restart persistence (without re-install) | **PASS** | **PASS** | **PASS** | Signed `v1.0.11` XPI active & signed across 2 full Firefox restarts |
| Unpaired cold startup / restart when Desktop offline — zero unsolicited Desktop/NM spawns | **PASS** | **PASS** | **PASS** | `nmInvocations=0`, `toriPidsDelta=0` |
| `v1.0.10` → `v1.0.11` settings migration (live signed XPI upgrade in Firefox!) | **PASS** | **PASS** | **PASS** | `theme=dark`, `accent=emerald`, `sites`, `types`, `port` preserved across real `v1.0.10` → `v1.0.11` upgrade |
| Trusted `options.html` Native Messaging pairing (`INITIATE_PAIRING`) with Desktop `v1.0.8` | **PASS** | **PASS** | **PASS** | `ok=true`, exact token & port returned via `v1.0.8` native host |
| Trusted `popup.html` `PING_DESKTOP` + token minimization | **PASS** | **PASS** | **PASS** | `auth=true`, `tokenLeaked=false` |
| Media discovery, overlay mount & real trusted-click user download on Desktop `v1.0.8` | **PASS** | **PASS** | **PASS** | Real pointer click opens `.tori-pn.on` & queues media job |
| Browser download interception completed by Desktop `v1.0.8` with exact SHA-256 | **PASS** | **PASS** | **PASS** | `state=completed`, `shaMatch=true` in all 3 browsers |
| Duplicate download prevention within cooldown window | **PASS** | **PASS** | **PASS** | Repeat click created `0` duplicate jobs |
| Browser restart WITH persisted completed download history — zero stale replay & zero NM spawns | **PASS** | **PASS** | **PASS** | `jobsDelta=0`, `nmDelta=0` across full Edge, Chrome, AND Signed Firefox restarts |

---

## 5. Mozilla AMO Signing & Signed XPI Cryptographic Audit

- **Signed Artifact Location:** `release/v1.0.11-extension-rc/tori-companion-v1.0.11-firefox-signed.xpi` (originally returned by Mozilla AMO as `a70ed17e183648a9bcf4-1.0.11.xpi`)
- **Signed XPI Size:** `111,347` bytes
- **Signed XPI SHA-256:** **`4cd6d6fbf067cb98538fd807eaba360d40b409df07cbfb515b8d9b702b37c0fd`**
- **ZIP Integrity (`testzip`):** `OK`
- **Mozilla Cryptographic Signature Metadata (`META-INF/`):**
  - `META-INF/cose.manifest`
  - `META-INF/cose.sig`
  - `META-INF/manifest.mf`
  - `META-INF/mozilla.rsa` *(verified Mozilla AMO Production Signing Service / Mozilla Corporation / `root-ca-production-amo` / `signingca1.addons.mozilla.org` / subject `tori-download-manager@toridm.org`)*
  - `META-INF/mozilla.sf`
- **Source-to-Signed-XPI Parity:**
  - `35 / 35` application files present (`missing_in_xpi: []`, `extra_in_xpi: []`).
  - **`34 / 34`** non-manifest files (every `.js`, `.html`, `.css`, and icon) match `tori-companion-v1.0.11-firefox.zip` and `extension/firefox/` **100% byte-for-byte**.
  - `manifest.json`: **100% parsed-JSON identical** (`manifest_json_parsed_equal: true`; only AMO whitespace formatting diff).
  - `version`: `"1.0.11"`, Gecko ID: `"tori-download-manager@toridm.org"` (original `v1.0.10` identity preserved), `strict_min_version`: `"142.0"`, permissions unchanged (`downloads`, `nativeMessaging`, `webRequest`, `storage`, `tabs`, `activeTab`).
- **Standard Firefox Runtime Verification (`xpinstall.signatures.required = true`):**
  - Negative control on unsigned ZIP rejected with `ERROR_SIGNEDSTATE_REQUIRED`.
  - Signed XPI accepted permanently (`temporary: false`), verified by Firefox `AddonManager` as `SIGNEDSTATE_SIGNED` (`2`), and persisted active across full browser restarts.

---

## 6. Final `v1.0.11` Release Candidate Artifacts (`release/v1.0.11-extension-rc/`)

| Artifact | Bytes | Entries | SHA-256 | Integrity & Parity | Release Status |
| :--- | ---: | ---: | :--- | :---: | :--- |
| **`tori-companion-v1.0.11-firefox-signed.xpi`** | `111,347` | 40 (35 app + 5 `META-INF/`) | **`4cd6d6fbf067cb98538fd807eaba360d40b409df07cbfb515b8d9b702b37c0fd`** | `testzip=OK`, 34/34 exact + parsed-equal manifest, `SIGNEDSTATE_SIGNED`, 0 forbidden/secrets | **READY FOR GATE 35.4 RELEASE AUTHORIZATION** |
| **`tori-companion-v1.0.11-chromium.zip`** | `94,625` | 35 | **`1e77592bb05e548d832df373331aee4f90788a004cdaef7ca80c97df84b88559`** | `testzip=OK`, 35/35 exact source parity, 0 forbidden/secrets (unchanged since preflight) | **READY FOR GATE 35.4 RELEASE AUTHORIZATION** |
| `tori-companion-v1.0.11-firefox.zip` *(unsigned AMO input archive)* | `95,444` | 35 (42 ZIP records) | `2df9b5cb1e391b9023f6b4217efee9baa182c36aaeb8c3e891a71515abf9edad` | `testzip=OK`, `web-ext lint`: **0 errors** | Archived reference input (do NOT publish unsigned ZIP to end users) |
| `SHA256SUMS.txt` & `verification_metadata.json` | — | — | Updated with signed XPI + Chromium ZIP + unsigned reference ZIP | Verified | Ready |

---

## 7. Dedicated Public-Key Fingerprint Reconciliation (Phase 6)

Independently verified from `%USERPROFILE%\.tori-keys\tori-tools.key.pub` (read-only public key only), [`crates/tdm-core/src/tools/trust.rs`](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-core/src/tools/trust.rs), and compiled `release/v1.0.8-final-rc/tori-download-manager.exe`:

- **Disk `.pub` File == Embedded `trust.rs` Constant == Compiled Desktop `v1.0.8` Binary:** **100% byte-identical** (`152` bytes base64, file SHA-256 `6b734db9b13479ffa9e47bbd22b6542abcc3d4ead17ad2ce0efaa92537320c3f`).
- **Key ID:** `C3FD6626A3718E63`.
- **Canonical Raw 32-Byte Ed25519 Public Key SHA-256 Fingerprint:** **`6807e183f56c08eb06fdff95347bbbf7174b4ce5185b0245155db315e87fee39`** (matches `trust.rs:21`, Gate 33.3 report, and Gate 34.2 report).
- **Gate 35.1 Discrepancy (`GATE35_1_POST_RELEASE_SECURITY_HARDENING_REPORT.md:26`):** `6807e183079787d7d00f889293a27a880b2a346e83556d3d090f28b92a132c9d` is confirmed to be a **documentation transcription error only**, with **zero cryptographic mismatch and zero security impact**.

---

## 8. Executed QA Summary & Preservation Matrix

| Suite | Command | Exit Code | Exact Result | Log File |
| :--- | :--- | :---: | :--- | :--- |
| VM Runtime Authorization & Cold SW Suite | `node scripts/verify_gate35_2_extension_security.js` | `0` | **PASS (30 / 30)** | `target/gate35_3_qa_logs/extension_security_vm_post_sign.log` |
| Live Edge + Chrome + Temp Firefox QA vs Desktop `v1.0.8` | `node scripts/verify_gate35_3_real_browsers.js` | `0` | **PASS (32 / 32)** + unsigned Firefox rejection verified | `target/gate35_3_qa_logs/real_browsers_qa.log` |
| **Live Signed Firefox Permanent Install, Upgrade, Restart Persistence & Adversarial QA vs Desktop `v1.0.8`** | `node scripts/verify_gate35_3_signed_firefox.js` | `0` | **PASS (15 / 15)** (`SIGNEDSTATE_SIGNED`, `temp=false`, 2 full restarts, 0 stale replays, exact SHA-256, HKCU registry restored) | `target/gate35_3_qa_logs/signed_firefox_permanent_qa.log` |
| Package Parity, Mozilla Cert & Secret Audit | Python audit scripts | `0` | **PASS** (`0` mismatches, `0` forbidden strings, `0` secrets) | `target/gate35_3_qa_logs/phase5_package_audit.log` |

### Production & OEM Non-Modification Verification
- Desktop `v1.0.8` Installer (`728d0d25...`): **UNCHANGED**
- Companion `v1.0.10` Chromium ZIP (`f220fab2...`), Signed Firefox XPI (`a93a4387...`), Unsigned Firefox ZIP (`56139a06...`): **UNCHANGED**
- Companion `v1.0.11` Chromium ZIP (`1e77592b...`): **UNCHANGED**
- OEM `v1.0.6` Binary (`570833b3...`), OEM SQLite (`ok`, `56` downloads, `531` chunks), Host HKCU `NativeMessagingHosts` registry: **100% PRESERVED / RESTORED**
- `C:\Users\ritud\Downloads\tori-website`, GitHub Releases, Production Tools Manifest rev 2, Signing Keys: **100% UNCHANGED**

---

## 9. Gate 35.4 Release-Readiness Checklist & Verdict

| Gate 35.4 Prerequisite | Status |
| :--- | :---: |
| `SEC-35-04` fixed & verified in static, VM (30/30), and live Edge/Chrome/Signed Firefox adversarial tests | **DONE** |
| Chromium/Edge `v1.0.11` ZIP packaged & byte-parity verified (`1e77592bb05e548d832df373331aee4f90788a004cdaef7ca80c97df84b88559`) | **DONE** |
| Firefox `v1.0.11` XPI Mozilla AMO signed & permanently verified (`4cd6d6fbf067cb98538fd807eaba360d40b409df07cbfb515b8d9b702b37c0fd`) | **DONE** |
| Original extension IDs & Desktop `v1.0.8` compatibility verified live across all 3 browsers | **DONE** |
| Dedicated tools public-key fingerprint reconciled (`C3FD6626A3718E63` / `6807e183f56c08eb06fdff95347bbbf7174b4ce5185b0245155db315e87fee39`) | **DONE** |
| Zero secrets exposed, zero production releases/website modified | **DONE** |
| **Separate Explicit Owner Release Authorization (Gate 35.4)** | **AWAITING OWNER AUTHORIZATION** |

### Final Result
**`GATE 35.3: GO — FIREFOX SIGNED XPI VERIFIED`**

Ready for Gate 35.4 explicit owner authorization to publish GitHub release `extension-v1.0.11` (`make_latest: "false"`, keeping Desktop `v1.0.8` as repository Latest Stable) with `tori-companion-v1.0.11-firefox-signed.xpi`, `tori-companion-v1.0.11-chromium.zip`, `SHA256SUMS.txt`, and website Companion download link updates.
