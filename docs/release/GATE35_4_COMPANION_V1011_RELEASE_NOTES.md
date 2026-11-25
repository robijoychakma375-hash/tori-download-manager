# TORI Browser Companion v1.0.11 — Security Hotfix Release Notes

**Release Date:** November 26, 2026  
**Component:** TORI Browser Companion (Browser Extension)  
**Version:** `1.0.11`  
**Release Type:** Security Hotfix (Recommended for All Users)  
**Compatible Desktop:** TORI Download Manager Desktop `v1.0.8` (Latest Stable)  
**Supported Browsers:**  
- Mozilla Firefox (Manifest V3 — Official Mozilla AMO Signed XPI, `tori-download-manager@toridm.org`)  
- Google Chrome (Manifest V3 — `jfnfgmcbgapcpieaonbaolgebjaejcdm`)  
- Microsoft Edge (Manifest V3 — `jfnfgmcbgapcpieaonbaolgebjaejcdm`)  
- Brave, Vivaldi, Opera, and other Chromium-based browsers

---

## Overview

TORI Browser Companion `v1.0.11` is a high-priority security and reliability hotfix update that remediates **`SEC-35-04`** (removing webpage-accessible extension dispatch bridges and enforcing strict runtime sender authentication/authorization), eliminates unwanted background Desktop auto-spawning and stale download replay on Windows/browser startup, and fixes MV3 cold service-worker status checks.

This release preserves 100% compatibility with **TORI Download Manager Desktop `v1.0.8`**, retains existing browser extension IDs, and migrates all `v1.0.10` settings seamlessly without requiring any unpublished Desktop features.

---

## Security Fixes

### 1. Remediation of `SEC-35-04` (Webpage-to-Extension Privilege Boundary)
- **Removed Webpage Dispatch Bridge:** Completely removed the webpage-callable `__TORI_DISPATCH__` / `__TORI_RESPONSE__` CustomEvent listener and removed `document.documentElement.dataset.toriExtensionUrl` from content scripts.
- **Strict Runtime Sender Authentication & Authorization:** All privileged background actions (`INITIATE_PAIRING`, `RECONNECT_DESKTOP`, `PING_DESKTOP`, `GET_CONNECTION_STATUS`, `GET_ALL_MEDIA`, `GET_DOWNLOADS`, `PAUSE/RESUME/CANCEL/RETRY_DOWNLOAD`, `SHOW_DESKTOP`, `OPEN_OPTIONS`, `OPEN_POPUP_TAB`, `RESOLVE_PLAYLIST`, `ENQUEUE_PLAYLIST`) now require browser-enforced `sender.id === chrome.runtime.id`, exact extension origin/URL match, top-level frame (`frameId === 0`), and restriction to `popup/popup.html` or `options/options.html`.
- **Pairing Token Minimization:** Desktop API pairing tokens are returned exclusively to `options/options.html` and are never exposed to webpage scripts, content scripts, or `popup/popup.html`.
- **Cross-Tab Isolation & Schema Hardening:** Content scripts are strictly locked to `sender.tab.id` on `GET_TAB_MEDIA` and `RECORD_MEDIA_FROM_DOM`, prohibited from passing custom `destination` paths (`FORBIDDEN_FIELD`), validated against flag-prefixed URLs / `format_id`s and path-traversal `job_id`s, protected by payload size/key bounds (`64 KiB` / `32` keys), and governed by per-tab burst rate limits.
- **Closed Shadow DOM & Trusted Input Guards:** Switched the overlay portal to `attachShadow({ mode: 'closed' })`, enforced `e.isTrusted` on pill, playlist, and download clicks to block synthetic page-script triggers, and added `sender.id` verification on content-script message listeners.

---

## Reliability & Startup Fixes

### 2. Eliminated Unwanted Browser Startup Spawns & Historical Download Replay
- **Active-Only Download Interception:** Browser download interception now verifies `state === 'in_progress'`, `paused !== true`, absence of `endTime`, and recency (`startTime` within 60 seconds), preventing browsers such as Microsoft Edge from replaying historical completed downloads on Windows startup.
- **Passive Startup Behavior:** `onStartup` and `onInstalled` now probe TORI Desktop passively over localhost HTTP and never invoke Native Messaging when TORI Desktop is offline.

### 3. MV3 Cold Service Worker Restart Reliability
- `GET_CONNECTION_STATUS` and `PING_DESKTOP` now await `ensureSettingsLoaded()` before reading persisted port and API key settings, eliminating false `Pairing Required` states immediately after an MV3 service worker wake-up.

---

## Verified Release Artifacts

| Package | Filename | Size | SHA-256 Checksum |
| :--- | :--- | ---: | :--- |
| **Firefox (Mozilla AMO Signed XPI)** | `tori-companion-v1.0.11-firefox-signed.xpi` | `111,347` bytes | `4cd6d6fbf067cb98538fd807eaba360d40b409df07cbfb515b8d9b702b37c0fd` |
| **Chromium (Chrome / Edge ZIP)** | `tori-companion-v1.0.11-chromium.zip` | `94,625` bytes | `1e77592bb05e548d832df373331aee4f90788a004cdaef7ca80c97df84b88559` |

All release checksums are published in `SHA256SUMS.txt`.

### Upgrading from v1.0.10
- **Firefox:** Install `tori-companion-v1.0.11-firefox-signed.xpi` directly (drag-and-drop or `about:addons` → *Install Add-on From File...*). Because the official Gecko ID (`tori-download-manager@toridm.org`) is preserved, Firefox upgrades in place and retains all existing settings.
- **Chrome / Edge:** Extract `tori-companion-v1.0.11-chromium.zip` over your existing unpacked folder and click **Reload** in `chrome://extensions` or `edge://extensions` (or load unpacked as new). Extension ID `jfnfgmcbgapcpieaonbaolgebjaejcdm` and all saved settings are preserved.
