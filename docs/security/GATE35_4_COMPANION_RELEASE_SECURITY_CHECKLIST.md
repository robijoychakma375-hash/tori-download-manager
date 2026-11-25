# TORI Gate 35.4 — Browser Companion v1.0.11 Release Security Checklist

**Target Release:** `extension-v1.0.11` (TORI Browser Companion `v1.0.11` Security Hotfix)  
**Compatible Public Desktop:** `v1.0.8` (Latest Stable, release ID `455125259`)  
**Security Fix Scope:** `SEC-35-04` (Webpage-to-Extension Privilege Boundary Hardening) + Priority 3 Startup Hardening  
**Preparation Branch:** `feat/gate35_4-companion-v1011-prepublish`  
**Publication Status:** **PRE-PUBLISH LOCAL STAGING ONLY — NOT PUBLISHED**

---

## 1. Cryptographic & Artifact Integrity Controls

| # | Security Control | Requirement | Verified Status | Evidence |
| :-: | :--- | :--- | :---: | :--- |
| 1 | Frozen Firefox Signed XPI Hash | `4cd6d6fbf067cb98538fd807eaba360d40b409df07cbfb515b8d9b702b37c0fd` (`111,347` bytes) | **PASS** | `release/v1.0.11-extension-rc/tori-companion-v1.0.11-firefox-signed.xpi` |
| 2 | Frozen Chromium/Edge ZIP Hash | `1e77592bb05e548d832df373331aee4f90788a004cdaef7ca80c97df84b88559` (`94,625` bytes) | **PASS** | `release/v1.0.11-extension-rc/tori-companion-v1.0.11-chromium.zip` |
| 3 | Mozilla AMO Production Signature | 5 `META-INF/` files (`cose.manifest`, `cose.sig`, `manifest.mf`, `mozilla.rsa`, `mozilla.sf`), `SIGNEDSTATE_SIGNED` (`2`) under `xpinstall.signatures.required=true` | **PASS** | Verified in live standard Firefox `v160.0.1` (`temporarilyInstalled=false`) |
| 4 | Extension Identity Preservation | Gecko ID `tori-download-manager@toridm.org`; Chromium ID `jfnfgmcbgapcpieaonbaolgebjaejcdm` | **PASS** | Exact match with `v1.0.10`; real in-place Firefox upgrade verified |
| 5 | Source-to-Package Byte Parity | 35/35 Chromium files byte-identical; 34/34 non-manifest Firefox XPI files byte-identical + parsed-equal `manifest.json` | **PASS** | Zero extra/missing files; `testzip=OK` |
| 6 | Unsigned Firefox ZIP Excluded from Public Release | `tori-companion-v1.0.11-firefox.zip` MUST NOT be uploaded as a user-facing release asset | **PASS** | Excluded in `scripts/publish_extension_v1_0_11.js` & `SHA256SUMS.txt` |

---

## 2. `SEC-35-04` Privilege Boundary & Adversarial Controls

| # | Security Control | Verification Layer | Verified Status |
| :-: | :--- | :--- | :---: |
| 7 | Zero `__TORI_DISPATCH__`, `__TORI_RESPONSE__`, `toriExtensionUrl`, `__TORI_BG_SECURITY__`, `externally_connectable`, `onMessageExternal`, `postMessage` bridges | Static + Packaged ZIP/XPI Audit | **PASS** |
| 8 | Strict `chrome.runtime.onMessage` sender authentication (`sender.id`, `sender.origin`, `sender.url`, `frameId === 0`) & 15 privileged actions restricted to `popup.html` / `options.html` | VM Suite (30/30) + Live Browsers | **PASS** |
| 9 | Pairing token minimization — returned ONLY to `options/options.html` (never to `popup.html`, content scripts, or webpages) | VM Suite + Live Chrome/Edge/Signed Firefox | **PASS** |
| 10 | Closed Shadow DOM (`shadowRoot === null`) + `e.isTrusted` click enforcement on overlay pill, playlist, and download buttons | Live Chrome, Edge & Signed Firefox | **PASS** |
| 11 | Cross-origin `<iframe>` & SPA navigation (`pushState`/`popstate`) cannot reach privileged handlers or exfiltrate pairing credentials | Live Chrome, Edge & Signed Firefox | **PASS** |
| 12 | Cross-tab `GET_TAB_MEDIA` isolation, content-script `destination` rejection (`FORBIDDEN_FIELD`), payload bounds (`64 KiB` / `32` keys), rate limiting, and MV3 cold SW restart credential loading | VM Suite (30/30) | **PASS** |
| 13 | Unsolicited background Desktop spawn & historical download replay eliminated | VM Suite + Live Chrome/Edge/Signed Firefox restarts | **PASS** |

---

## 3. Supply-Chain, Key Custody & Release Isolation Controls

| # | Security Control | Requirement | Verified Status |
| :-: | :--- | :--- | :---: |
| 14 | Secret & Credential Scan | Zero private keys, GitHub PATs, Cloudflare tokens, or AMO secrets in repo or staged release files | **PASS** |
| 15 | Dedicated External Tools Public Key Fingerprint Reconciled | Disk `.pub` == `trust.rs` == Desktop `v1.0.8` binary (`C3FD6626A3718E63` / `6807e183f56c08eb06fdff95347bbbf7174b4ce5185b0245155db315e87fee39`) | **PASS** |
| 16 | GitHub Latest Stable Preservation | `extension-v1.0.11` MUST set `make_latest: "false"` so Desktop `v1.0.8` (ID `455125259`) stays Latest Stable | **PASS** *(enforced in `publish_extension_v1_0_11.js`)* |
| 17 | Public Production Assets Untouched During Prep | Desktop `v1.0.8`, Companion `v1.0.10`, tools manifest rev 2, live `toridownload.xyz`, OEM binary/SQLite/parts 100% preserved | **PASS** |
| 18 | Explicit Owner Release Authorization Gate | Separate owner authorization required before invoking `--execute --owner-authorized` or Cloudflare Pages deploy | **PENDING OWNER AUTHORIZATION** |
