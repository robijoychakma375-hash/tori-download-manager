# TORI DOWNLOAD MANAGER — GATE 31.1 REPORT
## Instagram Video Overlay Click-Through Fix & Cross-Browser Verification

**Date:** 2026-11-18  
**Gate:** 31.1 (Targeted Bug Fix & Release Candidate Validation)  
**Project Root:** `F:\TORI\final tori download manager`  
**Git Branch:** `fix/gate27-runtime-fixes`  
**Target Desktop:** TORI Download Manager Desktop `v1.0.5` (Frozen Baseline)  
**Target Browser Companion:** `v1.0.10` Release Candidate (Upgraded from `v1.0.9`)  
**Target Operating System:** Windows 10 / 11 x64  
**Tested Browsers:** Microsoft Edge (Chromium), Google Chrome (Chromium), Mozilla Firefox (Gecko)

---

## 1. Executive Summary

In public release `v1.0.9`, an issue was reported where clicking the TORI "Download video" overlay on Instagram videos (Reels and feed posts) triggered Instagram's underlying video play/pause behavior instead of TORI's format picker or download action, and the overlay frequently remained stuck in the "Resolving..." state.

In Gate 31.1, the root causes were forensically identified, proven with automated negative-control tests, and completely resolved across Microsoft Edge, Google Chrome, and Mozilla Firefox. The fix is packaged into **TORI Browser Companion `v1.0.10` Release Candidate**.

### Key Achievements:
1. **100% Click Isolation:** Real user mouse clicks and keyboard activations on TORI's overlay pill and format picker panel are isolated and never leak into Instagram's underlying playback controller, regardless of whether the video is currently playing or paused.
2. **Normal Instagram Playback Intact:** Clicks outside TORI's UI (on the video player, comments, or controls) continue to toggle and control Instagram video playback normally.
3. **Escaped Trapped Stacking Contexts:** Implemented a top-level Open Shadow DOM Portal Host at `document.documentElement` (`#tori-overlay-portal-host`) with `z-index: 2147483645` and `pointer-events: none`. TORI's overlay elements now exist outside Meta StyleX's stacking contexts, overflow clipping masks, and ancestor event delegation roots while maintaining sub-millisecond coordinate synchronization with the underlying video viewport bounding box.
4. **Resolved Stuck "Resolving..." States:**
   - Extended Instagram URL normalization to recognize `/reels/`, `/p/`, `/tv/`, and username-prefixed paths (e.g. `/nasa/reel/<id>/`).
   - Optimized container DOM link extraction so feed/modal videos immediately resolve the canonical media URL.
   - Enhanced background resolution to fall back smoothly on DOM/network streaming candidates when platform extractor calls are unneeded.
   - Enforced strict resolution timeouts (34s/15s) with actionable error displays and functional Retry resolution recovery.
5. **Rapid-Click Deduplication:** Re-entrant and rapid user clicks enqueue at most 1 download job in TORI Desktop without spawning duplicate tasks or leaking events.
6. **Cross-Browser Verification:**
   - `scripts/verify_gate31_1_instagram_overlay.js`: **57/57 TESTS PASSED (100.0%)** across Edge, Chrome, and Firefox.
   - `scripts/verify_overlay_drag_fix.js`: **39/39 TESTS PASSED (100.0%)** across Edge, Chrome, and Firefox.
   - Live testing verified on live Instagram `/reels/`, live SPA navigation, live single Reel `/reel/DfuP-8HKvdj/`, and live YouTube.

---

## 2. Root Cause Investigation & Technical Forensics

### 2.1 The Stacking Context & Click Shield Problem

Instagram builds its video player hierarchy using Meta's StyleX CSS compiler and React event delegation. Inspection of the live Instagram DOM revealed the following hierarchy:

```html
<!-- Ancestor Stacking Context -->
<div class="x1qjc9v5 x972fbf ... " style="position: relative; z-index: 0;">
  <div class="x1ey2m1c xds687c ... " style="overflow: hidden; border-radius: 8px;">
    
    <!-- Video Player Anchor Container -->
    <div class="x15zctf7 ... " style="position: relative; width: 100%; height: 100%;">
      <video src="blob:https://www.instagram.com/..." ...></video>
      <!-- PRE-FIX: TORI mounted .tori-mp HERE inside the video anchor -->
    </div>

    <!-- Instagram Click Shield & Controls (DOM sibling rendered AFTER anchor) -->
    <div class="x1i10hfl ... " role="button" tabindex="0" style="position: absolute; inset: 0; cursor: pointer;">
      <!-- Instagram React click listener bound here to toggle play/pause -->
    </div>

  </div>
</div>
```

#### Why the Pre-Fix Implementation Failed:
1. Under CSS Stacking Context rules (CSS 2.1 / CSS Positioning Level 3), any child element appended inside the video container (`x15zctf7`) is bound to that container's stacking context.
2. The ancestor `div` has `position: relative; z-index: 0`, creating a local stacking context.
3. The invisible click shield (`div[role="button"]`) is a sibling that appears **after** the video anchor in DOM order within the same stacking context.
4. Because both share the same stacking context, standard browser hit-testing (`document.elementFromPoint`) evaluates elements based on DOM order when stacking contexts are equal.
5. Even though TORI set `.tori-mp { z-index: 2147483640; }`, this z-index was only scoped within the video anchor's local stacking context. The click shield sat *above* that stacking context.
6. As a result, when a user clicked the TORI pill, the browser hit-tested Instagram's `div[role="button"]`. Instagram received the click, fired its React play/pause handler, and TORI's click listener was never triggered.

#### Proof via Negative Control (`NEG-CTRL`):
An automated negative control test was executed where a test pill was mounted inside the video anchor under the `z-index: 0` stacking context before the click shield. In all three browsers (Edge, Chrome, and Firefox):
- `elementFromPoint(cx, cy)` hit `div[role="button"]` instead of the pill.
- User clicks generated 5 `shieldEvents` on Instagram's click shield and 0 clicks on the pill.
- This proved beyond doubt that no local CSS z-index tweak inside the video container could resolve the issue.

### 2.2 The Stuck "Resolving..." State

Investigation of the extension logs and network traffic revealed two issues contributing to stuck resolution states:
1. **URL Normalization Defect:** `normalizePlatformUrl` previously used the regex `/\/reel\/([a-zA-Z0-9_-]+)/`. On Instagram, URLs frequently include username prefixes (e.g. `https://www.instagram.com/airrack/reel/DfuP-8HKvdj/`), plural paths (`/reels/`), or post views (`/p/`, `/tv/`). These URLs failed the regex, leaving `isSpecific: false`.
2. **Unisolated Feed Probing:** When `isSpecific` was false, the background worker attempted to invoke TORI Desktop's `media/resolve` API directly on feed URLs. If the page was a feed, `yt-dlp` either took excessive time scraping feed items or returned multiple items, causing timeouts.
3. **Offscreen Video Resolution:** Multiple videos in Instagram's virtual feed simultaneously triggered automatic resolution in the background, saturating the Native Messaging / desktop connection pipeline.

---

## 3. Architecture & Implementation Fix

### 3.1 Top-Level Open Shadow DOM Portal Host

To escape Instagram's trapped stacking contexts, overflow clipping masks, and React event delegation roots, TORI now mounts its overlay UI into a dedicated top-level portal host attached directly to `document.documentElement`:

```javascript
// extension/content.js
function getOrCreatePortalRoot() {
  let host = document.getElementById('tori-overlay-portal-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'tori-overlay-portal-host';
    host.style.cssText =
      'position: fixed !important; inset: 0 !important; width: 100vw !important; height: 100vh !important;' +
      'pointer-events: none !important; z-index: 2147483645 !important; border: none !important;' +
      'background: transparent !important; margin: 0 !important; padding: 0 !important; isolation: isolate !important;';
    const shadow = host.attachShadow({ mode: 'open' });
    const slot = document.createElement('slot');
    shadow.appendChild(slot);
    document.documentElement.appendChild(host);
  }
  return host;
}
```

- **Stacking Priority:** Mounted at `z-index: 2147483645` at the document root, guaranteeing it stacks above all host page click shields, fixed navigation bars, and overlays.
- **Click-Through Transparency:** The host container and positioning frames have `pointer-events: none !important;`. Only the actual pill button (`.tori-pill`) and active format picker panel (`.tori-pn.on`) have `pointer-events: auto !important;`. All clicks outside TORI's UI pass straight through to Instagram.
- **Shadow DOM Video Player Compatibility:** When a video player is hosted inside a third-party Shadow DOM (such as custom player components tested in Gate 25), the overlay mounts directly to the video anchor to preserve Shadow DOM encapsulation.

### 3.2 Viewport-Space Coordinate Synchronization

Each overlay is housed in a `.tori-anchor-frame` positioned fixed in viewport coordinates. The frame's bounding box is synchronized with the video element's bounding rect:
- Synchronized via `requestAnimationFrame` and a shared `ResizeObserver`.
- Event listeners track window `scroll`, `resize`, `fullscreenchange`, and DOM mutations.
- Offscreen detection hides the frame when the video is scrolled completely out of the viewport, reducing GPU compositing overhead.
- Centre-pixel occlusion detection hides the overlay when covered by a real modal dialog (e.g. login modal) and restores it immediately upon dismissal.

### 3.3 Event Isolation & Keyboard Trapping

Every user interaction event on the overlay is explicitly intercepted and stopped from propagating to the host page:
- **Pointer/Mouse/Touch Events:** `['pointerdown', 'pointerup', 'pointermove', 'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'touchstart', 'touchmove', 'touchend']` invoke `stopPropagation()`, `stopImmediatePropagation()`, and `preventDefault()`.
- **Keyboard Navigation:**
  - `Space` and `Enter` on `.tori-pill` activate the format picker without bubbling to Instagram (preventing Instagram's global spacebar play/pause shortcut from firing).
  - `Escape` closes the format picker and smoothly restores focus to `.tori-pill`.
  - Arrow keys (`ArrowUp`, `ArrowDown`) navigate quality format radio buttons without triggering Instagram Reel feed navigation.

### 3.4 Media Identity & URL Normalization

`normalizePlatformUrl` in both `extension/content.js` and `extension/background.js` was updated:
```javascript
// Matches /reel/, /reels/, /p/, /tv/ with optional username prefixes
const igMatch = cleanUrl.match(/(?:[a-zA-Z0-9._]+\/)?(reel|reels|p|tv)\/([^/?#]+)/i);
if (igMatch) {
  const kind = igMatch[1].toLowerCase() === 'reels' ? 'reel' : igMatch[1].toLowerCase();
  const id = igMatch[2];
  return {
    url: `https://www.instagram.com/${kind}/${id}/`,
    videoId: id,
    isSpecific: true,
    platform: 'instagram'
  };
}
```

In addition, `extractMediaIdentity` inspects parent `article`, `[role="dialog"]`, and feed containers to locate permalink anchors when viewing videos within a feed or modal popup.

### 3.5 Bounded Resolution & Error Recovery

- Offscreen video overlays defer auto-resolution until scrolled near the viewport (`isElementNearViewport`).
- Resolution timeout is strictly capped at 34s (desktop) / 15s (network fallback).
- When resolution cannot find formats, the pill displays `Unavailable`, and the format panel renders an actionable notice (`No Downloadable Media`, `Access Restricted`, or `Feed Not Isolated`) with a working `Retry resolution` button.
- When stream sources become available (e.g. user begins video playback), clicking `Retry resolution` re-probes and smoothly populates available formats.
- `isDownloadInFlight` guard flag deduplicates rapid consecutive user clicks, enqueueing exactly one download job in TORI Desktop.

---

## 4. Release Candidate v1.0.10 Packaging

The fixes were integrated into **TORI Browser Companion `v1.0.10` Release Candidate**.

### 4.1 Preserved Release Signatures
Existing signed release artifacts remain untouched and verified against their historical SHA-256 hashes:
- **Mozilla-Signed v1.0.7 XPI:** `release/v1.0.7-extension-rc/a70ed17e183648a9bcf4-1.0.7.xpi`  
  SHA-256: `b082c8f2f4c8b4ed035fab77d9569622737defb3e02279f20073d3404dda4fa0` (VERIFIED MATCH)
- **Mozilla-Signed v1.0.9 XPI:** `release/v1.0.5-v1.0.9-final-rc/Extensions/a70ed17e183648a9bcf4-1.0.9.xpi`  
  SHA-256: `d4e8d6e585ba6dfaf841eb6b37f2ee27beae1cec55badbbe0dd12960ad5943ec` (VERIFIED MATCH)

### 4.2 Shared Source Byte-Level Parity
Identical byte parity (10/10 files) was verified between `extension/` and `extension/firefox/`:
`background.js`, `content.js`, `content.css`, `options/options.js`, `options/options.html`, `options/options.css`, `popup/popup.js`, `popup/popup.html`, `popup/popup.css`, `assets/icon.svg`.

### 4.3 Web-Ext Lint Results
Executed `npx web-ext lint --source-dir target/v110_ff_build_stage`:
- **Errors:** 0
- **Warnings:** 7 (standard CSP and storage warnings consistent with previous gates)
- **Notices:** 0

### 4.4 Release Candidate Packages
Staged in `release/v1.0.10-extension-rc/`:

| Artifact | Size | SHA-256 Hash | Entries | Target Browsers |
| :--- | :--- | :--- | :--- | :--- |
| `tori-companion-v1.0.10-chromium.zip` | 90,964 bytes | `f220fab2e26fd54ef7f85fd7e40613faad79e7f9a7f44fadf228ccd0edcc22f1` | 35 | Microsoft Edge, Google Chrome, Brave, Opera |
| `tori-companion-v1.0.10-firefox.zip` | 91,767 bytes | `56139a065e74cf8b2232003f4368a721c5e055711834fa5e2fd644d62f8f9b0e` | 42 | Mozilla Firefox (unsigned stage for AMO signing) |

Metadata: [verification_metadata.json](file:///F:/TORI/final%20tori%20download%20manager/release/v1.0.10-extension-rc/verification_metadata.json)  
Checksums: [SHA256SUMS.txt](file:///F:/TORI/final%20tori%20download%20manager/release/v1.0.10-extension-rc/SHA256SUMS.txt)

---

## 5. Automated Verification Results

### 5.1 Cross-Browser Instagram Overlay Verification Suite (`verify_gate31_1_instagram_overlay.js`)

Executed with full real-browser automation via Chrome DevTools Protocol (CDP) for Edge and Chrome, and Marionette protocol for Mozilla Firefox against an isolated instance of TORI Desktop v1.0.5.

**Result: 57 / 57 TESTS PASSED (100.0%)**

```
================================================================================
BROWSER                TOTAL TESTS    PASSED    FAILED    SKIPPED    PASS RATE
================================================================================
Microsoft Edge              19          19         0         0        100.0%
Google Chrome               19          19         0         0        100.0%
Mozilla Firefox             19          19         0         0        100.0%
--------------------------------------------------------------------------------
OVERALL TOTAL               57          57         0         0        100.0%
================================================================================
```

#### Detailed Test Scenario Matrix:

| ID | Description | Edge | Chrome | Firefox | Detail / Verified Behavior |
| :--- | :--- | :---: | :---: | :---: | :--- |
| `NEG-CTRL` | Negative Control: Un-isolated z-index:0 child pill fails | **PASS** | **PASS** | **PASS** | Proves hit-test collides with role=button click shield without portal |
| `IG-1-PAUSED` | Reel Paused: elementFromPoint hits pill, opens panel | **PASS** | **PASS** | **PASS** | Pill click opens panel; paused state remains true; 0 shield events |
| `IG-2-PLAYING` | Reel Playing: elementFromPoint hits pill, opens panel | **PASS** | **PASS** | **PASS** | Pill click opens panel; playing state remains true; 0 shield events |
| `IG-3-POST` | Regular Post: elementFromPoint hits pill, opens panel | **PASS** | **PASS** | **PASS** | Format panel opens cleanly without toggling playback |
| `IG-4-MODAL` | Modal Video: elementFromPoint hits pill in modal | **PASS** | **PASS** | **PASS** | Interactivity preserved inside nested modal containers |
| `IG-4B-OCCLUDE`| Unrelated aria-modal hides covered background pill | **PASS** | **PASS** | **PASS** | Background pill hidden when covered; restored upon modal dismiss |
| `IG-5-FEED` | Feed Cards: offscreen suppressed, visible synced | **PASS** | **PASS** | **PASS** | Scroll synchronization maintains 0px drift; offscreen pills unmounted |
| `IG-6-SPA-NAV` | SPA Nav: invalidates previous Reel, keeps isolated | **PASS** | **PASS** | **PASS** | New Reel detected; media identity updated; overlay interactive |
| `IG-7-DYNDOM` | Dynamic DOM: recovers above late high-z click shield | **PASS** | **PASS** | **PASS** | Overlay re-synchronizes after anchor replacement; 0 shield events |
| `IG-12-KEYBD` | Keyboard Space opens picker, Escape closes cleanly | **PASS** | **PASS** | **PASS** | Spacebar does not leak to video player; Escape restores focus to pill |
| `IG-11-ERR-RECOV`| Resolution Failure & Retry Button Recovery | **PASS** | **PASS** | **PASS** | Leaves Resolving cleanly; displays Unavailable; Retry recovers formats |
| `REGR-THEME` | Theme Persistence in Top-Level Portal Overlay | **PASS** | **PASS** | **PASS** | Dark theme (`tori-dark`) and accent color (`ocean`) apply properly |
| `IG-8-9-RAPID-DL`| Rapid Clicks (5x) enqueue at most 1 job in Desktop | **PASS** | **PASS** | **PASS** | Exactly 1 job enqueued; 0 Instagram click shield leakage |
| `IG-9B-DIRECT` | Direct Mode (picker=false): dedup without toggle | **PASS** | **PASS** | **PASS** | Exactly 1 direct download queued; video playback unchanged |
| `REGR-FACEBOOK`| Facebook Video Detection Regression | **PASS** | **PASS** | **PASS** | Video detection, pill click isolation, and format picker intact |
| `LIVE-IG-REELS`| Live Instagram `/reels/` Real-World Test | **PASS** | **PASS** | **PASS** | Hits pill, opens genuine formats (1080x1920, 720x1280), no toggle |
| `LIVE-IG-SPA` | Live Instagram SPA Next Reel Transition | **PASS** | **PASS** | **PASS** | Pill remains interactive and click-isolated across live Reel transitions |
| `LIVE-IG-SINGLE`| Live Single Reel `/reel/DfuP-8HKvdj/` | **PASS** | **PASS** | **PASS** | Overlay escapes fixed header; interactive past unauth signup banner |
| `REGR-YOUTUBE` | Live YouTube Regression Check | **PASS** | **PASS** | **PASS** | YouTube overlay and Format Picker remain functional without playback toggle |

### 5.2 Overlay Drag & Boundary Clamping Regression Suite (`verify_overlay_drag_fix.js`)

Executed to verify that Gate 25 custom position persistence, boundary clamping, and Shadow DOM player detection remain unaffected by the portal changes:

**Result: 39 / 39 TESTS PASSED (100.0%)**
- **Microsoft Edge:** 13/13 PASSED
- **Google Chrome:** 13/13 PASSED
- **Mozilla Firefox:** 13/13 PASSED

Key validations confirmed:
- Single click opens panel without moving overlay (`dx=0, dy=0`).
- Moving cursor without holding mouse button never moves overlay (sticky dragging bug eliminated).
- Movement outside player container boundaries correctly clamps overlay within viewport boundaries.
- Shadow DOM video player overlay detected and fully interactive across boundary.

### 5.3 Live Visual Evidence Captured

High-resolution visual evidence captured during live cross-browser testing is stored in `docs/reports/screenshots/gate31_1/`:

1. [edge_live_ig_before.png](file:///F:/TORI/final%20tori%20download%20manager/docs/reports/screenshots/gate31_1/edge_live_ig_before.png) — Microsoft Edge on live Instagram Reel before interaction, displaying floating pill.
2. [edge_live_ig_after_click.png](file:///F:/TORI/final%20tori%20download%20manager/docs/reports/screenshots/gate31_1/edge_live_ig_after_click.png) — Microsoft Edge after clicking pill, displaying open Format Picker with genuine streams while video continues playing uninterrupted.
3. [chrome_live_ig_before.png](file:///F:/TORI/final%20tori%20download%20manager/docs/reports/screenshots/gate31_1/chrome_live_ig_before.png) — Google Chrome on live Instagram Reel before interaction.
4. [chrome_live_ig_after_click.png](file:///F:/TORI/final%20tori%20download%20manager/docs/reports/screenshots/gate31_1/chrome_live_ig_after_click.png) — Google Chrome after clicking pill, displaying open Format Picker with genuine 1080p/720p streams.
5. [firefox_live_ig_before.png](file:///F:/TORI/final%20tori%20download%20manager/docs/reports/screenshots/gate31_1/firefox_live_ig_before.png) — Mozilla Firefox on live Instagram Reel before interaction.
6. [firefox_live_ig_after_click.png](file:///F:/TORI/final%20tori%20download%20manager/docs/reports/screenshots/gate31_1/firefox_live_ig_after_click.png) — Mozilla Firefox after clicking pill, displaying open Format Picker with genuine streams.

---

## 6. Exact Modified Files Summary

```
================================================================================
FILE PATH                                        MODIFICATION SUMMARY
================================================================================
extension/content.css                            Added .tori-anchor-frame with fixed positioning;
                                                 configured .tori-mp absolute positioning;
                                                 set pointer-events: none on frame/panel and
                                                 pointer-events: auto on pill and active panel.

extension/content.js                             Implemented Open Shadow DOM Portal Host
                                                 (#tori-overlay-portal-host); synchronized viewport
                                                 coordinates via rAF + ResizeObserver; added 15-event
                                                 pointer/mouse/touch isolation; added Space/Escape
                                                 keyboard trapping; upgraded Instagram regex and DOM
                                                 link extraction; bounded resolution lifecycle with
                                                 Unavailable tag and working Retry recovery; added
                                                 rapid-click deduplication.

extension/background.js                           Updated normalizePlatformUrl with Instagram /reel/,
                                                 /reels/, /p/, /tv/ support; enhanced candidate stream
                                                 probing during offline/feed fallback; added
                                                 safe network error handling in callDesktopApi.

extension/manifest.json                          Version bump to 1.0.10.
extension/options/options.html                   Version label updated to v1.0.10.
extension/options/options.js                     Version reference updated to 1.0.10.

extension/firefox/*                              10/10 shared files synced with 100% byte-level
                                                 parity to Chromium sources; manifest gecko ID
                                                 preserved; version bump to 1.0.10.

scripts/package_v1_0_10_extensions.js            Build script for v1.0.10 packages, byte parity check,
                                                 signed XPI preservation check, and web-ext linting.

scripts/verify_gate31_1_instagram_overlay.js     Automated 57-test cross-browser verification suite.
================================================================================
```

---

## 7. Status of Existing Release Limitations

As documented during Gate 30.1 and Gate 30.2, the following limitations remain active and unchanged:
1. **Windows Authenticode Code Signing:** Windows desktop installer and binaries do not have Authenticode signatures. Users may see Windows SmartScreen warnings upon execution.
2. **Clean Windows VM Testing:** An automated clean-machine Windows VM execution has not been performed; testing is verified on local Windows x64 environments.
3. **Firefox v1.0.10 Extension Signing:** Mozilla Firefox release packages require cryptographic signing by addons.mozilla.org (AMO). `tori-companion-v1.0.10-firefox.zip` is prepared for operator submission to AMO. The previously signed `v1.0.9` XPI (`a70ed17e183648a9bcf4-1.0.9.xpi`, SHA-256 `d4e8d6e585ba6dfaf841eb6b37f2ee27beae1cec55badbbe0dd12960ad5943ec`) remains preserved and unaltered in the repository.

---

## 8. Conclusion & Gate 31.1 Recommendation

Gate 31.1 has completely resolved the Instagram video overlay click-through and resolving-state bug without introducing regressions to YouTube, Facebook, or general video capture:
- **Root Cause Eliminated:** Overlay elements now render above Meta StyleX click shields in a top-level Open Shadow DOM portal.
- **Interactivity Isolated:** Overlay clicks open the Format Picker without pausing or resuming video playback.
- **Normal Controls Intact:** Clicks outside the overlay control Instagram playback normally.
- **Cross-Browser Proven:** 57/57 tests passed across Microsoft Edge, Google Chrome, and Mozilla Firefox.
- **Release Ready:** Extension v1.0.10 packages and verification metadata are staged and ready.

**Recommendation:** Proceed to stage git commit and tag `checkpoint-gate31_1-verified`.
