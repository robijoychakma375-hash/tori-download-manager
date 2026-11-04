# Plan — Gate 10.5.3.1: Automatic Port Connection, True Live Status & Dynamic Video Switching (COMPLETED)

## Milestone Objective
Implement & Verify:
1. Automatic localhost port connection and true live connection status across TORI Desktop and Edge extension (default port 6800, port discovery fallback `[6800..6803]`, auto-reconnection across restarts using stored pairing credentials, true four-state status model: `Connecting`, `Connected`, `Disconnected`, `Pairing Required`, zero hardcoded green status).
2. Dynamic video switching and per-tab media identity model on SPA websites (YouTube, Facebook, Instagram) without webpage refresh. When navigating from Video A to Video B, immediately clear stale formats and title, display "Resolving new video...", resolve Video B's genuine formats/sizes, and guarantee downloads use Video B's identity while preserving in-flight downloads from Video A.
3. Race condition prevention (generation counters, debouncing, obsolete response dropping).

---

## Work Breakdown & Status

### Phase 1: Requirement 1 — Connection State Model & Port Discovery [COMPLETED]
- **Backend & Native Host (`crates/tdm-native-host/src/lib.rs`, `server.rs`):**
  - Verified `pair` action reads `active_server_port` from SQLite and returns `{ status: "ok", token, port }`.
  - Ensured status/ping endpoints return `{ status: "ok", authenticated: bool, port: u16, version: "2.0.0" }`.
  - Prevented routine status pings and query fallbacks from auto-launching the desktop app when stopped.
- **Background SW (`extension/background.js`):**
  - Implemented robust `PING_DESKTOP` with port discovery and true 4-state reporting (`ok`, `unpaired`, `disconnected`).
  - Removed unprompted Native Messaging fallbacks from routine background queries (`GET_DOWNLOADS`, `PAUSE`, `RESUME`, `CANCEL`) to eliminate phantom auto-spawning.
  - Persisted authorized pairing credentials in `chrome.storage.local`.
- **Popup & Options UI (`extension/popup/`, `extension/options/`):**
  - In `popup.html`: initial pill state set to `<div class="st wait" id="statusPill"><i id="statusDot"></i><span id="statusText">Connecting…</span></div>`.
  - In `popup.js`: implemented `setStatus(state)` reflecting `connecting` (amber), `connected` (green), `disconnected` (red), `unpaired` (amber). Added one-click auto-pairing on status pill click.
  - Added periodic bounded health polling while popup is open; cleaned up on `unload`.
  - In `options.js`: synced connection banner with live status model.
- **Desktop UI (`ui/src/App.tsx`):**
  - Defaulted `isExtensionConnected` to `false` instead of `true`; updated via `check_extension_status`.

### Phase 2: Requirement 2 — SPA Dynamic Navigation & Media Identity [COMPLETED]
- **Media Identity & Generation Model in `extension/content.js`:**
  - Defined `extractMediaIdentity(url)` returning `{ url, videoId }`.
  - Introduced `currentGeneration` counter for each video overlay.
  - Implemented `handleVideoNavigation(reason)`:
    - Checks if `videoId` or `url` changed.
    - Increments `currentGeneration`.
    - Clears old title, format rows, selected index, and `resolvedMeta`.
    - Updates pill to indicate `"Resolving…"`.
    - Renders `"Resolving new video…"` in panel, triggers `RESOLVE_MEDIA` for new URL with `generation: currentGeneration`.
    - Discards any responses where `response.generation !== currentGeneration`.
- **Event Listeners in `extension/content.js`:**
  - Hooked YouTube `yt-navigate-finish`, `yt-page-data-updated`.
  - Wrapped `history.pushState` and `history.replaceState`.
  - Hooked `popstate`.
  - Hooked `<video>` element `loadstart`, `emptied`, `loadedmetadata`, `durationchange`.
  - URL change polling watchdog (600ms) for arbitrary dynamic SPAs.
  - Listened for `chrome.runtime.onMessage` (`MEDIA_NAVIGATED`, `GET_ACTIVE_MEDIA_INFO`).
- **Background Coordination in `extension/background.js`:**
  - Hooked `chrome.webNavigation.onHistoryStateUpdated`:
    - Clears `tabMediaCache` for that `tabId`.
    - Increments `tabGenerations.set(tabId, gen)`.
    - Notifies tab via `chrome.tabs.sendMessage({ action: 'MEDIA_NAVIGATED' })`.
  - In `RESOLVE_MEDIA`: accepts `generation` and deduplicates in-flight requests.
- **Toolbar Popup Synchronization (`extension/popup/popup.js`):**
  - On open, queries active tab's media identity via `GET_ACTIVE_MEDIA_INFO`.
  - Displays current video's formats/title immediately if available.
  - Re-renders if navigation occurs while popup is open.

### Phase 3: Automated Verification [COMPLETED]
- Created and executed `scripts/verify_gate10_5_3_1.js`:
  1. Tested connection state transitions: `Connecting` / `Pairing Required` -> `Connected · 127.0.0.1:6800`.
  2. Tested desktop shutdown: verified `PING_DESKTOP` returned `disconnected`, and verified ZERO silent auto-spawning occurred.
  3. Tested desktop restart: automatic reconnection with saved token verified without manual key entry.
  4. Tested invalid token: verified `unpaired` (`Pairing Required`) reported.
  5. Tested YouTube dynamic navigation:
     - Big Buck Bunny resolved with 28 formats, captured `design/edge_video_a_resolved.png`.
     - Queued download for Video A (`jobIdA`).
     - Client-side navigated to Caminandes without page reload (`pushState`).
     - Verified Video A UI cleared, Caminandes detected and resolved with 24 formats, captured `design/edge_video_b_resolved.png`.
     - Dispatched download for Video B (`jobIdB`) and verified correct Video B URL in desktop engine.
     - Verified in-flight download for Video A was preserved and NOT cancelled by navigation (`downloaded_bytes: 3545491`).
     - Navigated back to Video A without reload; identity restored.
     - Tested rapid A -> B -> C navigation with generation counter safely dropping obsolete responses.
     - Verified zero duplicate overlays in DOM.
- Full quality gates:
  - `cargo fmt --all -- --check` (Passed)
  - `cargo clippy --workspace --all-targets -j 2 -- -D warnings` (Passed, 0 warnings)
  - `cargo test --workspace -j 2 -- --test-threads=1` (Passed, 105 passed, 0 failed)
  - `npm --prefix ui run build` (Passed in 352ms)
  - `node -c` syntax check on all JS files (Passed)

### Phase 4: Documentation & Final Deliverables [COMPLETED]
- Produced `GATE10_5_3_1_CONNECTION_AND_SPA_FIX_REPORT.md` (and artifact).
- Updated `IMPLEMENTATION_STATUS.md`.
- Staged and committed changes cleanly to git.
