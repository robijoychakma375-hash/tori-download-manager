# TORI Download Manager — Gate 29.1 Acceptance Report
## Production-Grade IDM-Style Desktop UI Migration

- **Branch:** `fix/gate27-runtime-fixes`
- **Pre-migration checkpoint:** `checkpoint-gate29_1-before-ui-migration` (`b353d6d`)
- **Desktop target version:** `1.0.5` (`v1.0.5-rc` local NSIS build, unpublished)
- **Extension / Companion scope:** Untouched (Gate 29.1 Desktop Main Window & Settings UI only)
- **Mozilla-signed Firefox XPI (`v1.0.7`):** Verified untouched (`sha256: b082c8f2f4c8b4ed035fab77d9569622737defb3e02279f20073d3404dda4fa0`)

---

## 1. Executive Summary

TORI Desktop's Main Window and Settings interface were migrated in production React + TypeScript (`ui/`) to the supplied IDM-style design system (`design/tori-idm-reference/tori-idm/`) while preserving existing backend orchestration, Browser Companion integration, YouTube playlist handoff, large MKV capture/classification, tray lifecycle, updater controls, and SQLite settings persistence.

All automated checks passed after the final source edit:
- **Frontend lint (`oxlint` across 10 touched/added UI files):** `0 warnings, 0 errors` (`68ms`)
- **Frontend production build (`tsc -b && vite build`):** Passed (`226ms`)
- **Gate 29.1 live WebView2 + SQLite UI & virtualization suite (`scripts/verify_gate29_1_idm_desktop_ui.js`):** `20 PASS, 0 FAIL`
- **Gate 27.8 YouTube Playlist E2E regression (`scripts/verify_gate27_8_playlist_e2e.js`) against updated NSIS installer:** `12 PASS, 0 FAIL, 0 TIMEOUT, 0 NOT TESTED`
- **Gate 27.8 2.30 GiB MKV & classification E2E regression (`scripts/verify_gate27_8_large_mkv_and_classification.js`) against updated NSIS installer:** `10 PASS, 0 FAIL, 0 TIMEOUT, 0 NOT TESTED`
- **Rust workspace test suite (`cargo test --workspace --no-fail-fast`):** `36` suites, `235 passed, 0 failed, 0 ignored`

---

## 2. Implemented Desktop UI Architecture

### Modified & Added Files
Only frontend `ui/` files, design reference assets, and QA verification/report assets were added or modified (zero changes to `extension/`, `crates/`, `src-tauri/`, `latest.json`, or signed Firefox `v1.0.7` XPI):

- `ui/index.html` — Pre-boot theme & accent script aligned to `#f5f5f8` (light) / `#232326` (dark) with default `'system'` theme and `'indigo'` accent fallback before React mount.
- `ui/src/tokens.css` — Dynamic `--accent`, `--accent-2`, `--accent-grad` mappings bound to theme accent tokens (`indigo`, `ocean`, `emerald`, `rose`) for consistent styling across modals and main shell.
- `ui/src/types.ts` — Added typed UI state structures (`CategoryCounts`, `SortField`, `SortDirection`).
- `ui/src/components/Icons.tsx` *(new)* — Inline SVG icon components (`CategoryChip`, `ToolbarIcon`, `SettingsTabIcon`, `ToriLogoIcon`) matching the IDM SVG icon set without SVG gradient ID collisions.
- `ui/src/components/TitleBar.tsx` — Windows 11 frameless caption bar (`32px`, `Minimize`, `Maximize`/`Restore`, `Close`), zero macOS window dots.
- `ui/src/components/MenuBar.tsx` *(new)* — Interactive `Tasks | File | Downloads | View | Help` menu bar with keyboard shortcuts, selection-aware action enablement, `Escape`/outside `mousedown`/`click`/`focusin` dismissal, and automatic dismissal when any modal opens (`isModalOpen`).
- `ui/src/components/ToolBar.tsx` — 7 action toolbar buttons (`Add URL`, `Resume`, `Pause`, `Stop all`, `Delete`, `Start queue`, `Settings`) plus search input `#q`.
- `ui/src/components/SideBar.tsx` — Collapsible hierarchical sidebar tree (`All Downloads` toggleable `.tch` chevron with nested `Video`, `Music`, `Compressed`, `Programs`, `Documents`, followed by top-level `Unfinished` and `Finished`) displaying live item counts.
- `ui/src/components/DownloadTable.tsx` — Fixed-row-height (`ROW_HEIGHT = 34`, `OVERSCAN = 5`) virtualized 6-column table (`File name`, `Size`, `Status`, `Time left`, `Transfer rate`, `Last try date`) with interactive asc/desc sorting, memoized `TableRow` & `RowThumb`, keyboard focus auto-scroll, and progress click inspection, with bottom `#det` details panel hidden (`display: none`).
- `ui/src/components/StatusBar.tsx` — Memoized footer showing active download count, speed summary, visible/total item count, and right-aligned `Extension connected` / connection state indicator.
- `ui/src/components/SettingsModal.tsx` — 4-tab modal (`Appearance`, `Download Engine`, `Browser Integration`, `About`) in `820x650` viewport-clamped layout using `.scard`/`.sr` cards and `ToggleSwitch`, displaying exact `Version 1.0.5` metadata and pinned Chromium (`jfnfgmcbgapcpieaonbaolgebjaejcdm`) & Firefox (`tori-download-manager@toridm.org`) extension IDs.
- `ui/src/App.css` & `ui/src/App.tsx` — Shell layout, column grid, IDM visual hierarchy, `1 Hz` trailing-edge progress batching (`pendingProgressRef`), `data-reduce-motion` support, serialized settings writes (`settingsWriteQueueRef`), preserved YouTube Playlist handoff / `PlaylistModal` listeners, tray lifecycle, and zero `backdrop-filter` glass blur.

---

## 3. Defects Discovered & Resolved During Live Verification

1. **Rapid Settings Overwrite Race (`SettingsModal.tsx` & `App.tsx`)**
   - *Symptom caught by Gate 29.1 QA:* Changing Accent (`Ocean`) and Theme (`Dark`) rapidly inside Settings caused the second `update()` call to read a stale `settings` closure prop, reverting `accent` back to `indigo`.
   - *Fix:* Updated `SettingsModal.tsx` `update()` to mutate and read `settingsRef.current` synchronously before invoking `onUpdateRef.current(updated)`, and updated `App.tsx` `handleUpdateSettings()` to sync `settingsRef.current` immediately and serialize SQLite `update_engine_settings` IPC writes via `settingsWriteQueueRef`.

2. **MenuBar Dropdown Persistence Across Programmatic Clicks & Modal Open (`MenuBar.tsx`)**
   - *Symptom caught by visual screenshot inspection:* A stray `Tasks` dropdown remained open behind the Settings modal and Dark screenshot when triggered via `.click()` rather than pointer `mousedown`.
   - *Fix:* Added `isModalOpen`-driven reset using render-time `prevModalOpen` state reconciliation (zero `react(set-state-in-effect)` lint warnings) and registered outside `click` and `focusin` listeners alongside `mousedown` and `Escape`.

3. **Cold-Start Seeded `queued` Jobs & `/api/v1/downloads` Response Shape in QA Harness (`scripts/verify_gate29_1_idm_desktop_ui.js`)**
   - *Observation:* During initial QA harness setup, seeding mock rows directly into SQLite with `state="queued"` caused `DownloadManager::new()` (`crates/tdm-core/src/engine/manager.rs`) to invoke `process_queue()` -> `tokio::spawn` before Tauri's Tokio runtime started, panicking on mock `cdn.example.org` rows; additionally `GET /api/v1/downloads` returns `{ status, jobs }` (`JobListResp`) rather than a top-level array.
   - *Resolution:* Updated `seedQaDatabase()` in `verify_gate29_1_idm_desktop_ui.js` to seed mock rows in `paused`/`completed`/`failed` states (matching Unfinished/Finished distribution while keeping active HTTP transfer testing live against the running engine), adjusted React async click timing waits (`100ms–200ms`), and read `st.data.jobs` in the harness. Rust backend was kept unmodified.

---

## 4. Verification & Performance Metrics

### Gate 29.1 Live Desktop UI Suite (`scripts/verify_gate29_1_idm_desktop_ui.js`) — `20 PASS, 0 FAIL`

| Check ID | Verification Target | Observed Result |
|---|---|---|
| `PERF-IDLE` | Idle Memory & Process Footprint | `WorkingSet=371.49MB`, `Private=198.15MB`, `Procs=7` |
| `UI-CHROME` | Windows Titlebar & NO macOS dots | `wbarH=32`, controls `["Minimize","Maximize","Close"]`, `hasMacDot=false` |
| `UI-MENU` | IDM MenuBar | `["Tasks","File","Downloads","View","Help"]` |
| `UI-TOOL` | IDM Toolbar Buttons & Search | 7 buttons (`Add URL`, `Resume`, `Pause`, `Stop all`, `Delete`, `Start queue`, `Settings`) + search |
| `UI-SIDE` | Hierarchical Sidebar Tree & Counts | Top `["all","unf","fin"]`, nested `["Video","Music","Compressed","Programs","Documents"]`, counts `all=9, unf=5, fin=4` |
| `UI-TABLE` | 6-Column Table & No Bottom Details Panel | `["File name","Size","Status","Time left","Transfer rate","Last try date"]`, `hasDet=false`, `rowCount=9` |
| `UI-PERF-STYLE` | Zero `backdrop-filter` across DOM | `blurCount=0` |
| `ACT-MENU` | MenuBar open & clean dismissal | `open=5, afterClose=0` |
| `ACT-SIDE` | Tree collapse/expand & category filter | `collapsedKids=0`, `expandedKids=5`, `videoRows=2`, `allRows=9` |
| `ACT-SORT` | Column sorting (asc/desc) | `Architecture_Whitepaper.pdf` <-> `ubuntu-24.04-amd64.iso` |
| `UI-SET-INT` | Settings Browser Integration IDs & Key | `hasKey=true`, Chromium & Firefox pinned IDs visible |
| `UI-SET-ABOUT` | Settings About version accuracy | `Version 1.0.5` displayed (`hasFalseDev=false`) |
| `UI-DARK` | Live Dark Theme + Ocean Accent | `theme="dark"`, `accent="ocean"` applied immediately |
| `UI-MINVP` | Minimum Viewport `800x540` overflow | `sw=800, iw=800, sh=540, ih=540` |
| `ACT-TRAY` | Close button hides to tray with engine alive | `/api/v1/ping` `authenticated=true`, `engine_active=true` |
| `PERSIST-01` | Dark + Ocean SQLite persistence across restart | `afterRestart={"theme":"dark","accent":"ocean"}`, `dbTheme="dark"`, `dbAccent="ocean"` |
| `ACT-DL-ADD` | Live throttled HTTP transfer enqueued | `throttled_stream.bin` queued and started |
| `PERF-THROTTLE` | Real transfer completion & throttled DOM updates | `completed=true`, `diskBytes=921600`, `mutations3.2s=4` (~1.25/s), `activeWs=373.55MB`, `cpuSec=2.391s` |
| `PERF-VIRT` | 1,200-row table virtualization | Top `rendered=22` (`scrollH=40800`), mid scroll (`firstIdx=583..609`) `rendered=27`, `virtWsMb=358.43MB` |
| `SAFETY-OEM` | Production `%APPDATA%` SQLite untouched | Identical SHA-256 `c2bb1ada2d3966837aa22f37f2e6a21d10687a88a726e26693f68929f2d91679` before & after |

### Visual Screenshot Inspection (`docs/reports/screenshots/gate29_1/`)
All six screenshots generated by the final verified build were inspected directly:
- `01_main_light.png` — Light main window showing frameless Windows 11 chrome, menu bar, toolbar, expanded category tree, 6-column virtualized download table, progress bars, and green status indicator.
- `02_main_dark.png` — Dark theme + Ocean accent (`File name ▼` active sort, clean selection highlight, zero stray open menus, high-contrast rows).
- `03_settings_appearance.png` — Appearance tab with Indigo/Ocean/Emerald/Rose swatches, Theme selector, and Reduce Animations switch.
- `04_settings_engine.png` — Download Engine tab showing folder selector, category toggle, popup policy, close-to-tray switch, speed limiter, and thread count cards.
- `05_settings_integration.png` — Browser Integration tab displaying Server Port (`19940`), masked API Key controls, Native Host registration control, and pinned Chromium/Firefox IDs.
- `06_settings_about.png` — About tab showing `96x96` vector TORI logo, `Version 1.0.5`, daily update toggle, and action buttons (`Check for updates`, `Open data folder`, `View Licenses`, `Release Notes`).

---

## 5. Regression Suites & Packaging Safety

After bundling the updated `ui/dist` into `TORI Download Manager_1.0.5_x64-setup.exe` (preserving prior RC assets in `release/checkpoints/v1.0.5-rc-pre-gate29_1/`):

- **`scripts/verify_gate27_8_playlist_e2e.js` (`12 PASS, 0 FAIL`):**
  - Verified NSIS silent install, cold native-messaging launch to `#playlist-modal`, hide-to-tray restore on Chrome YouTube `Download Playlist` click, SPA navigation detection, 17-item playlist resolution & real MKV download (`WING IT! - Blender Open Movie.mkv`, `10,677,366` bytes into `Video/`), Edge identical-URL reopen & Mix rejection (`422`), Mozilla-signed Firefox `v1.0.7` XPI playlist handoff, and offline error recovery.
- **`scripts/verify_gate27_8_large_mkv_and_classification.js` (`10 PASS, 0 FAIL`):**
  - Verified full `2,469,606,195`-byte (2.30 GiB) MKV end-to-end download via Chrome companion into `Video/` with mid-transfer pause/resume (`.tdm-part` preserved), exact SHA-256 match, migrated WebView2 UI completion display, SQLite completion, zero duplicates, and multi-browser classification across Chrome, Edge, and signed Firefox `v1.0.7` XPI.
- **`cargo test --workspace --no-fail-fast`:** All `36` suites / `235` tests passed (`0` failed, `0` ignored).
- **Release safety:** No remote git pushes, GitHub releases, `latest.json` modifications, website updates, or extension package alterations were performed.
