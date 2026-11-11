# TORI Download Manager — Gate 23 Bugfix & Verification Progress Report

**Date:** 2026-11-11  
**Target Release:** v1.0.3  
**Branch:** `release/v1.0.3`  
**Platform:** Windows 10/11 x64  
**Status:** Verification Passed (14/14 Crate & Extension Validations OK, Workspace Tests 100% Passed)

---

## 1. Executive Summary

Gate 23 addresses four critical user-observed desktop stability and browser extension issues in TORI Download Manager without compromising the core download engine, existing release tags (v1.0.0, v1.0.1, v1.0.2), or the active public updater.

All four issues have been diagnosed to their root causes and resolved across desktop and extension codebases.

---

## 2. Root Cause Analysis & Implemented Fixes

### FIX 1: Startup White-Flash Elimination
- **Root Cause:**
  1. In `src-tauri/tauri.conf.json`, window `"main"` defaulted to `"visible": true` and had no theme specification. Tauri displayed the Win32 window immediately upon creation.
  2. In `ui/index.html`, `<html>` and `<body>` had no background color CSS and no synchronous inline theme restoration script. The Chromium/WebView2 canvas defaulted to solid white (`#FFFFFF`) while loading scripts and React modules.
  3. `ui/src/App.tsx` only applied `data-theme` inside a React `useEffect`, which executed after initial rendering, causing a visible white flash before dark theme styling applied.
- **Implemented Fix:**
  1. `src-tauri/tauri.conf.json`: Configured `"visible": false` and `"theme": "Dark"` on window `"main"`.
  2. `ui/index.html`: Injected synchronous zero-dependency `<style>` in `<head>` setting `background-color: #232326` (dark) and `#f8fafc` (light). Injected synchronous `<script>` in `<head>` reading `localStorage.getItem('tori_settings_v2')` before DOM construction to configure `dataset.theme` and background color immediately.
  3. `ui/src/App.tsx`: Added an initial mount effect invoking `frontend_ready` once theme and initial layout render.
  4. `src-tauri/src/commands.rs` & `src-tauri/src/lib.rs`: Added `frontend_ready` command to display the window cleanly when visual readiness is confirmed, plus a 1500ms fallback safety timer task so the window can never hang or deadlock if the frontend encounters an unexpected script error.

### FIX 2: Close-to-Tray & Single-Instance Reliability
- **Root Cause:**
  1. In TORI v1.0.2, clicking (X) in TitleBar or system close triggered `window.hide()`, successfully minimizing to tray. However, when users subsequently clicked "TORI Download Manager" in the Windows Start Menu or Desktop shortcut, a *second* process was spawned.
  2. Without Tauri's official single-instance plugin, the secondary process attempted to bind the local integration server on port 6800 (which conflicted with `os error 10048`), opened duplicate SQLite connections, or failed to bring the hidden primary window to the foreground, confusing users into believing TORI had crashed or failed to stay open in the background.
- **Implemented Fix:**
  1. `src-tauri/Cargo.toml` & `Cargo.lock`: Integrated `tauri-plugin-single-instance = "2"` (`v2.5.5`).
  2. `src-tauri/src/lib.rs`: Initialized `tauri_plugin_single_instance` in `tauri::Builder`. When a secondary instance launches, Tauri's single-instance mutex catches it, extracts command-line arguments, calls `w.unminimize(); w.show(); w.set_focus();` on the primary instance, and immediately terminates the secondary process without port or database conflicts.
  3. Background Native Host compatibility: When launched with `--minimized` (e.g. from browser native messaging), foreground window focusing is bypassed to keep background operations silent.
  4. Close-to-Tray confirmation: Explicit Exit checks active downloads via `count_active_downloads(&state.manager)` and presents a confirmation dialog to pause downloads cleanly before termination.

### FIX 3: Draggable Browser Video Overlay
- **Root Cause:**
  1. In `extension/content.js` and `extension/firefox/content.js`, `.tori-mp` was statically pinned via CSS classes (`.pos-top-right`, `.pos-bottom-right`, etc.) with no mouse or pointer dragging logic.
  2. Users watching videos with subtitles or overlays in the top/bottom corners were unable to reposition the control without obstructing video subtitles or player UI.
- **Implemented Fix:**
  1. `extension/content.js` & `extension/firefox/content.js`: Implemented standard PointerEvent dragging (`pointerdown`, `pointermove`, `pointerup`, `pointercancel`) on the `.tori-pill` element.
  2. Distinguishing click vs drag: Implemented a 5px movement threshold (`Math.hypot(dx, dy) >= 5`). Jitter below 5px preserves normal click-to-download / panel toggle. When dragged >= 5px, `wasDragged` flag suppresses the click event.
  3. Bounds containment: Clamped overlay coordinates to `[4, anchorWidth - mpWidth - 4]` and `[4, anchorHeight - mpHeight - 4]` on every move and on window resize.
  4. Position persistence: Saved relative position ratios (`rx = left / anchorWidth`, `ry = top / anchorHeight`) in `chrome.storage.local` under `tori_custom_overlay_pos` to restore preferred placement across video players and page navigations.
  5. `extension/content.css` & `extension/firefox/content.css`: Added `.tori-mp.tori-dragging` styling with `cursor: grabbing !important; touch-action: none;` and grab cursor.

### FIX 4: Media Detection "Unavailable" Resolution
- **Root Cause:**
  1. In `extension/content.js`, `extractDomMediaCandidates(videoEl)` constructed a JavaScript `Set`. When passed into `chrome.runtime.sendMessage({ action: 'RESOLVE_MEDIA', candidates: domCandidates })`, a `Set` serialized to `{}` (empty object) across the messaging boundary. In `background.js`, `Array.isArray(message.candidates)` evaluated to `false`, discarding all DOM `<source>` tags and direct stream URLs!
  2. On asynchronous video players (SPAs, modern HLS/DASH players), `<video>` elements are often inserted into the DOM before their sources or network requests begin. The initial scan executed when `tabMediaCandidates` was empty, returning `No direct media stream or manifest detected` and setting `resolveError = 'Unavailable'`.
  3. In `background.js`, `recordCandidate()` intercepted web requests and cached them in `tabMediaCache`, but never notified the active tab's content script. Once `resolveError` was set, the content script never cleared it even after the video buffered or played.
- **Implemented Fix:**
  1. `extension/content.js` & `extension/firefox/content.js`: Updated candidate extraction to guarantee array serialization via `Array.from(extractDomMediaCandidates(videoEl))`.
  2. `extension/background.js` & `extension/firefox/background.js`: Added proactive tab notification `chrome.tabs.sendMessage(tabId, { action: 'MEDIA_CANDIDATE_RECORDED', candidate })` whenever a new stream or manifest is captured.
  3. `extension/content.js` & `extension/firefox/content.js`: Added `MEDIA_CANDIDATE_RECORDED` message handler that dynamically updates `tabMediaCandidates`, clears stale resolution errors, and updates format tags.
  4. Video player observer: Added dynamic event listeners for `play`, `playing`, `loadedmetadata`, and `loadeddata` on `<video>` with a bounded 3-retry backoff (600ms, 1200ms, 1800ms) to re-evaluate DOM and tab streams as players initialize.
  5. DRM boundaries: Maintained strict non-circumvention of DRM-protected content (Widevine, PlayReady, FairPlay, Plex) while cleanly identifying public HLS, DASH, and direct MP4/WebM streams.

---

## 3. Exact Modified Files

| File | Change Description |
|---|---|
| `Cargo.lock` | Pinned `tauri-plugin-single-instance v2.5.5` and subdependencies |
| `src-tauri/Cargo.toml` | Added `tauri-plugin-single-instance = "2"` |
| `src-tauri/src/state.rs` | Added `is_minimized_launch: Arc<AtomicBool>` to `AppState` |
| `src-tauri/src/commands.rs` | Added `frontend_ready` Tauri command |
| `src-tauri/src/lib.rs` | Single-instance plugin registration, fallback safety timer (1500ms), early minimized check |
| `src-tauri/tauri.conf.json` | Configured window `"main"` with `"visible": false` and `"theme": "Dark"` |
| `ui/index.html` | Inline opaque background styling and synchronous head script for saved theme |
| `ui/src/App.tsx` | Emitting `frontend_ready` on mount |
| `extension/content.css` | Draggable grab/grabbing cursor and dragging state styles |
| `extension/firefox/content.css` | Exact parity for Firefox extension |
| `extension/content.js` | Draggable pointer logic, drag threshold, candidate array serialization, dynamic observers |
| `extension/firefox/content.js` | Exact parity for Firefox content script |
| `extension/background.js` | Broadcasting `MEDIA_CANDIDATE_RECORDED` to active tab |
| `extension/firefox/background.js` | Exact parity for Firefox background script |

---

## 4. Verification Test Results

| Verification Suite | Scope | Result | Evidence |
|---|---|---|---|
| **Rust Workspace Compilation** | `cargo check --workspace` | **PASS** | 0 errors, 0 warnings (2.53s) |
| **Rust Workspace Unit & Integration Tests** | `cargo test --workspace` | **PASS** | All tests passed (44 core unit tests, 9 integration, 7 host, 7 server, 5 updater crypto, 3 speed audit, etc.) |
| **UI Production Build** | `npm run build` in `ui/` | **PASS** | `tsc -b && vite build` succeeded in 261ms (44 modules transformed) |
| **Extension Syntax & JSON Validation** | Node.js parser on all 6 JS/CSS files | **PASS** | 100% valid JS syntax, identical parity across Chrome and Firefox |
| **Draggable Overlay Simulation** | `test_overlay_drag.js` | **PASS** | Click preserved below 5px threshold; drag suppresses click; bounded within anchor [4, maxL/maxT] |
| **Startup Theme Initialization Simulation** | `test_startup_theme.js` | **PASS** | Dark mode default (#232326), saved light mode (#f8fafc), system theme evaluation, corrupted storage fallback |
| **Live Updater Status** | `verify_gate22_1_live_activation.js` | **PASS** | 14/14 checks passed; production `v1.0.2` latest.json untouched |
| **Physical In-Place Windows Upgrade** | Separate physical PC | **NOT TESTED** | Pending operator physical test execution |

---

## 5. Release Readiness Recommendation

All four Gate 23 bug fixes have been successfully implemented and verified with clean automated test passes and zero regressions.

The project is **READY** for Phase 6: v1.0.3 Release Packaging (updating manifests to 1.0.3, compiling the NSIS installer, packaging browser extensions, generating cryptographic signatures, and preparing the physical QA kit).
