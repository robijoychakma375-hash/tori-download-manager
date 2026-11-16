# TORI Download Manager — Gate 29.3 Acceptance Report
## Production-Grade IDM-Style Browser Extension UI Migration (v1.0.9-rc)

- **Branch:** `fix/gate27-runtime-fixes`
- **Baseline commit / tag:** `f38fb44` (`checkpoint-gate29_2-verified`)
- **Pre-migration safety tag:** `checkpoint-gate29_3-before-extension-migration`
- **Desktop engine baseline:** `v1.0.5` (`Bridge API v2.0.0`, untouched per Gate 29.3 scope)
- **Browser Companion target version:** `1.0.9` release candidate (Chrome MV3, Edge MV3, Firefox MV3)
- **Mozilla-signed Firefox XPI (`v1.0.7`):** Preserved untouched (`release/v1.0.7-extension-rc/a70ed17e183648a9bcf4-1.0.7.xpi`, `sha256: b082c8f2f4c8b4ed035fab77d9569622737defb3e02279f20073d3404dda4fa0`)

---

## 1. Executive Summary & Design-to-Component Mapping

TORI Browser Companion (`Chrome`, `Edge`, `Firefox`) has been migrated to the IDM-style design system while retaining every production capability and Gate 27.8 fix.

| Design Reference Asset | Extension Implementation | Key Behavior Implemented |
|---|---|---|
| `design/tori-idm-reference/tori-idm/tokens.css` & `toggle.html` | `extension/shared/tokens.css` (mirrored to `extension/firefox/shared/tokens.css`) | Light & Dark theme variables (`color-scheme`), 4 accent palettes (`indigo`, `ocean`, `emerald`, `rose`), real DOM `.swl` / `.sw-track` / `.sw-knob` toggles with `:focus-visible` outlines and `prefers-reduced-motion` support. |
| `design/tori-idm-reference/tori-extension.html` (Popup) | `extension/popup/popup.html`, `popup.css`, `popup.js` | Compact `320px` popup (`<meta name="color-scheme" content="light dark">`), live 5-state indicator (`Connecting…`, `Connected · :<port>`, `Reconnecting…`, `Disconnected`, `Desktop unavailable`) without trusting stale cached state, `Capture downloads` switch, conditional active-tab detected media list via `resolveActiveTab()` + `GET_ACTIVE_MEDIA_INFO` / `GET_TAB_MEDIA`, bounded `15000ms` download handoff guard, `Open Tori` (`10000ms` guard via `SHOW_DESKTOP`), and Options gear button. |
| `design/tori-idm-reference/tori-extension.html` (Overlay & Picker) | `extension/content.css`, `extension/content.js` | Scoped `.tori-mp` floating accent pill and `.tori-pn` (`356px`) format picker with SVG icons (`.ft-video`, play, copy, download, playlist, info — zero emojis, zero `backdrop-filter`, zero infinite `@keyframes`), `Video` / `Audio only` ARIA tabs (`[data-tab]`), real backend streams (`.tori-fr` rows showing resolution/bitrate, container badge, `HD`/`4K`, `+Audio` merge indicator, codec, estimated/exact size), `positionPanelWithinViewport()`, Gate 27.8 `[data-act="open-playlist"]` + Mix/Radio rejection banner (`[data-act="mix-info"]`), `15000ms` bounded timeouts in `[data-act="download"]` and `triggerDirectDownload()`, sticky-drag fix (`visibilitychange`), debounced `requestAnimationFrame` `MutationObserver`, and `document.hidden`-gated `600ms` SPA URL watchdog. |
| `design/tori-idm-reference/tori-extension-options.html` | `extension/options/options.html`, `options.css`, `options.js` | 6-section sidebar (`role="tablist"` / `role="tab"` + keyboard arrow navigation): **Connection** (5 states, Endpoint, Version, Latency, Native Host status, `Reconnect`, `Open Tori`, `Auto-Pair`, Server Port, API Key show/paste), **Capture** (interception switch, min MB, prompt ask, Alt bypass, Private/Incognito gate, normalized extension chips with accessible `<button class="chip-rm">` removal), **Media** (overlay toggle, corner select, picker toggle, `reset-pos`, Video/Audio default mode, preferred resolution `2160p..360p`, auto-merge toggle), **Sites** (normalized domain exclusions add/remove), **Appearance** (Light/Dark/System + live `matchMedia('(prefers-color-scheme: dark)')` listener, 4 accent swatches, badge switch), **About** (dynamic `chrome.runtime.getManifest().version`, `Bridge API v2.0.0`, `com.tori.download_manager`, dynamic Chrome/Edge/Firefox engine detection, `Open Tori`, `Test Connection`, GitHub repository/releases/issues links, `Restore Defaults`). |
| Background / IPC Bridge | `extension/background.js` | Passive `probeDesktopPassive()` HTTP probe (never invokes Native Messaging auto-launch during passive health checks), `[6800, 6801, 6802, 6803]` candidate sweep, explicit `RECONNECT_DESKTOP` native pairing returning `nativeHost`, single-flight `openDesktopWindowUnified()` for `SHOW_DESKTOP`, incognito capture gate, and live `badge`/`theme`/`accent` sync. |

---

## 2. Modified & Added Files

- **Shared Extension Sources (`extension/` + parity-verified mirrors in `extension/firefox/`):**
  - `extension/shared/tokens.css`, `extension/firefox/shared/tokens.css` (new)
  - `extension/popup/popup.html`, `extension/popup/popup.css`, `extension/popup/popup.js`
  - `extension/content.css`, `extension/content.js`
  - `extension/options/options.html`, `extension/options/options.css`, `extension/options/options.js`
  - `extension/background.js`
  - `extension/manifest.json` (`"version": "1.0.9"`), `extension/firefox/manifest.json` (`"version": "1.0.9"`)
- **Packaging, QA & Documentation:**
  - `scripts/package_v1_0_9_extensions.js` (new)
  - `scripts/verify_gate29_3_idm_extension_ui.js` (new)
  - `docs/reports/screenshots/gate29_3/01_chrome_popup_light.png` – `11_options_about.png` (new)
  - `docs/reports/GATE29_3_IDM_EXTENSION_UI_MIGRATION_REPORT.md` (this report)

---

## 3. Release Candidate Packaging Metadata & Checksums (`v1.0.9`)

Generated cleanly by `node scripts/package_v1_0_9_extensions.js` (excluded `icons/preview.html` from release ZIPs; POSIX forward-slash paths verified across both ZIPs; byte-level SHA-256 parity verified across all `10` shared Chrome/Edge/Firefox files; local RC only, not published):

| Artifact | Size | Zip Entries | SHA-256 | Signing / Lint Status |
|---|---|---|---|---|
| `release/v1.0.9-extension-rc/tori-companion-v1.0.9-chromium.zip` | `85,022` bytes | `35` | `8dd9064199c55d3b787bd0fc393921c10d31900834b645192e1e2f33c44e3187` | Chrome & Edge unpacked RC (`jfnfgmcbgapcpieaonbaolgebjaejcdm`) |
| `release/v1.0.9-extension-rc/tori-companion-v1.0.9-firefox.zip` | `85,775` bytes | `42` | `943cbb29959e5f03fd67f23af480a09758699068ec2b5cf65a16b347947eb00d` | **Unsigned RC** (`web-ext lint`: `0` errors, `7` warnings, `0` notices); Gecko ID `tori-download-manager@toridm.org` |
| `release/v1.0.7-extension-rc/a70ed17e183648a9bcf4-1.0.7.xpi` *(Preserved)* | — | — | `b082c8f2f4c8b4ed035fab77d9569622737defb3e02279f20073d3404dda4fa0` | Mozilla-signed v1.0.7 XPI verified unmodified |

---

## 4. Cross-Browser End-to-End Verification (`scripts/verify_gate29_3_idm_extension_ui.js`)

Executed in full isolation (`target/gate29_3_qa`, Desktop HTTP API `19960`, WebView2 CDP `19961`, Chrome CDP `19963`, Edge CDP `19964`, Fixture HTTP `19965`, Firefox Marionette `2834`) after final source edits:

- **Tested Browsers:** Google Chrome `157.0.8103.78`, Microsoft Edge `157.0.4341.60`, Mozilla Firefox (built `v1.0.9` RC package loaded temporarily via Marionette `Addon:Install`).
- **Overall Result:** **`23 PASS, 0 FAIL, 0 TIMEOUT, 0 NOT TESTED`**

| Check ID | Scope / Phase 11 Mapping | Browser(s) | Status | Observed Evidence |
|---|---|---|---|---|
| `POP-5STATES` | Toolbar popup 5 states + Light/Dark | Chrome | **PASS** | `Connected · :19960`, `unpaired`, `unavailable`, `RECONNECT_DESKTOP` -> `ok`; Light & Dark screenshots |
| `T01-MKV` | Direct `.mkv` capture | Chrome | **PASS** | Completed in `Video/gate29_3_direct.mkv`, SHA-256 exact match |
| `T02-LARGE-MKV` | Large `>105 MiB` `Content-Disposition` extensionless MKV | Chrome | **PASS** | `110,100,617` bytes completed in `Video/gate29_3_large_movie.mkv`, full SHA-256 verified |
| `T03-MP4` | Direct `.mp4` capture | Chrome | **PASS** | Completed in `Video/gate29_3_capture.mp4`, SHA-256 exact match |
| `T04-YT-QUAL` | Live YouTube quality detection | Chrome, Edge | **PASS** | Resolved `12` real formats (`1080p WEBM HD +Audio vp09 ~122 MB`, `720p MP4 HD +Audio avc1 ~33.7 MB`, etc.) |
| `T05-YT-AUD` | Live YouTube Audio-only download | Chrome | **PASS** | Completed `Music/WING IT! - Blender Open Movie.m4a` on disk via `[data-tab="Audio"]` |
| `T06-YT-VID` | Live YouTube Video download | Chrome | **PASS** | Completed merged container `Video/WING IT! - Blender Open Movie.webm.mkv` (`11,803,755` bytes) on disk |
| `T07-PLAYLIST` | Playlist Download handoff (`OPEN_PLAYLIST`) | Chrome | **PASS** | Mounted `#playlist-modal` (`17` items) in Desktop |
| `T08-PL-MODAL` | Playlist Selection dialog resolution | Chrome | **PASS** | Resolved `17` checkbox items inside `#playlist-modal` |
| `T09-TRAY-HANDOFF` | Hidden/tray Desktop restore on handoff | Chrome | **PASS** | Win32 `IsWindowVisible` confirmed `wasVisible=false -> after=true` (`hide_main_window` restored on click) |
| `T10-NATIVE` | Native Messaging IPC (`com.tori.download_manager`) | Chrome | **PASS** | `INITIATE_PAIRING` matched token & `RECONNECT_DESKTOP` returned `nativeHost=true` |
| `T11-HTTP-FALLBACK` | HTTP API fallback with Native Host broken | Chrome | **PASS** | Passive ping stayed healthy (`status=ok`) over HTTP `19960` |
| `T12-RECOVERY` | Offline error + recovery on Desktop restart | Chrome | **PASS** | Reported `unavailable` when stopped; recovered to `ok` after restart |
| `T13-DRAG` | Overlay drag & zero sticky drag after `mouseup` | Edge | **PASS** | Pill moved `(706.7, 80)` -> `(616.7, 150)` during drag and stayed `(616.7, 150)` after subsequent cursor motion |
| `T14-SITES` | Domain exclusion normalization & suppression | Chrome | **PASS** | Normalized `https://localhost:19965/video.html` -> `localhost`; `.tori-mp` count = `0` on `localhost`, restored on removal |
| `T15-THEME` | Light/Dark + Accent persistence & propagation | Chrome | **PASS** | `dark` + `ocean` persisted cleanly across Options `Page.reload()` and synced with Popup |
| `T16-OPTS` | Options persistence across reload | Chrome | **PASS** | Settings (`port=19960`, exclusions, capture chips, media defaults) persisted cleanly |
| `T17-RAPID` | Rapid repeated Download click guard | Chrome | **PASS** | `3x` rapid clicks created strictly `1` backend download job (`addedJobs=1`) |
| `T18-SPA` | YouTube SPA transitions + Mix rejection | Chrome | **PASS** | `6` rapid `pushState` + `yt-navigate-finish` cycles -> `overlays=1`, `hasPlaylistBtn=true`; Mix URL displayed `[data-act="mix-info"]` |
| `EDGE-UI` | Independent Edge IDM Format Picker | Edge | **PASS** | Rendered `.tori-pn.on` (`height=384.2px`, `12` real formats) cleanly over live YouTube |
| `FF-E2E` | Independent Firefox `v1.0.9` E2E verification | Firefox | **PASS** | Installed Gecko ID `tori-download-manager@toridm.org`, paired `19960` (`62 ms`), injected picker, queued & completed `sample.mp4` (`Toast: Download queued in Tori (Blender Open Movie — Fixture Stream.mp4)`) |
| `PRESERVE-DB` | Production `%APPDATA%` SQLite untouched | Host | **PASS** | SHA-256 unchanged (`hash_match=true`) |
| `PRESERVE-XPI` | Signed Firefox `v1.0.7` XPI untouched | Host | **PASS** | SHA-256 `b082c8f2f4c8b4ed035fab77d9569622737defb3e02279f20073d3404dda4fa0` |

### Rust Engine Non-Regression (`cargo test --workspace --quiet`)
- **Result:** Passed with exit code `0` (`37` test suites, `238` passed, `0` failed, `0` ignored).

---

## 5. Visual Verification & Fixes Applied (`docs/reports/screenshots/gate29_3/`)

All `11` screenshots were inspected directly:
1. `01_chrome_popup_light.png` & `02_chrome_popup_dark.png`: Crisp `320px` popup layout showing `Connected · :19960`, capture switch, detected active-page `Blender Open Movie` MP4 row, `Open Tori`, and settings gear button.
2. `03_edge_format_picker.png`: Edge live YouTube IDM Format Picker with `1080p WEBM HD +Audio vp09 ~122 MB` and `720p MP4 HD +Audio avc1 ~33.7 MB`. *(Visual fix applied during review: initially `vp09 · +Audio merge` truncated codecs to `v...`/`avc...`; widened `.tori-pn` to `356px` and removed redundant merge text beside the `+Audio` badge, resolving truncation cleanly.)*
3. `04_firefox_format_picker.png`: Mozilla Firefox fixture player displaying floating `Download` pill and crisp IDM picker (`Original MP4 26.2 KB`).
4. `05_playlist_download_state.png`: YouTube playlist watch page displaying `.tori-pn` with `Playlist available` banner and `Download Playlist` button alongside resolved `1080p`/`720p` streams.
5. `06_options_connection.png` – `11_options_about.png`: All 6 Options panels (`Connection`, `Capture`, `Media`, `Sites`, `Appearance` shown in Dark + Ocean, and `About` showing `1.0.9`, `Connected (v2.0.0)`, `com.tori.download_manager`, `Google Chrome MV3`, and verified GitHub project links). *(Test fix applied during review: added `data-tori-ready="1"` after async storage hydration & event binding in `options.js` so `11_options_about.png` waited reliably for listener binding after reload.)*

---

## 6. Performance Observations & Resource Impact

- **Process Working Set & Cumulative CPU (`target/gate29_3_results.json`):**
  - Isolated TORI Desktop (`tori-download-manager.exe` main + WebView2 baseline at completion): `32.3 MB` WS, `0.281s` CPU.
  - Google Chrome browser process tree during active multi-tab QA + YouTube SPA: `183.4 MB` WS, `12.031s` CPU.
  - Microsoft Edge browser process tree during active YouTube + drag QA: `225.4 MB` WS, `18.969s` CPU.
- **Chrome Active YouTube Watch Tab (`Memory.getDOMCounters` after `6` rapid SPA transitions):** `documents: 7`, `nodes: 15894`, `jsEventListeners: 3690`; zero duplicate `.tori-mp` overlays (`overlays === 1`).
- **Runtime Hygiene:** Zero `backdrop-filter` blur passes, zero infinite CSS keyframes, `document.hidden` gate on the `600ms` SPA URL watchdog, `120ms` + `requestAnimationFrame` debounced video DOM `MutationObserver`, and passive localhost pings without triggering native host subprocesses.

---

## 7. Outstanding Limitations & Notes

1. **Firefox `v1.0.9` Signing State:** `release/v1.0.9-extension-rc/tori-companion-v1.0.9-firefox.zip` is an **unsigned** Mozilla ZIP release candidate pending AMO submission/signing after operator approval; `release/v1.0.7-extension-rc/a70ed17e183648a9bcf4-1.0.7.xpi` remains preserved unmodified.
2. **`web-ext lint` Warnings (`0` errors, `7` warnings):** Two expected `UNSUPPORTED_API` warnings for `downloads.onDeterminingFilename` (Feature-detected for Chromium only) and five `UNSAFE_VAR_ASSIGNMENT` notices on escaped UI HTML templates inside `popup/popup.js` and `content.js`. Options page (`options/options.js`) uses pure DOM node construction with zero `innerHTML` warnings.
3. **Merged YouTube Container Filename Suffix:** When `tdm-core` merges incompatible WebM video (`vp9`) + M4A audio via `--merge-output-format mp4/mkv/webm` (Gate 29.3 Rust freeze untouched), `yt-dlp` writes `<title>.webm.mkv` while SQLite retains `<title>.webm` and locates it via `locate_actual_output_file`. `T06-YT-VID` confirmed the merged `.webm.mkv` (`11,803,755` bytes) completed cleanly on disk.
4. **Standalone Legacy Gate 27.8 Scripts:** Prior `scripts/verify_gate27_8_*.js` harnesses target `v1.0.7`/`v1.0.8` directories directly and were left unchanged; full MKV, YouTube, and Playlist coverage against `v1.0.9` ran in `scripts/verify_gate29_3_idm_extension_ui.js`.

---

## 8. Final Assessment

**PASS** — Gate 29.3 IDM-style Browser Extension UI migration is complete and verified across Google Chrome, Microsoft Edge, and Mozilla Firefox (`23 PASS, 0 FAIL, 0 TIMEOUT, 0 NOT TESTED`; `cargo test --workspace` `238` passed, `0` failed; `web-ext lint` `0` errors). All changes remain local only pending operator review.
