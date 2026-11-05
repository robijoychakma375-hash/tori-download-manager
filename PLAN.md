# TORI Download Manager — Gate 11 Execution Plan

## Milestone Objective
Implement the exact design reproduction from `design/tori-final/` into the TORI React + Tauri 2 desktop application across two orderly stages:
- **Stage A (Completed):** Main Window and Settings Modal exact reproduction.
- **Stage B (Next):** Download Toast popup migration (`tori-download-toast.html`) replacing the legacy modal/window.

---

## Status of Stage A (Main Window & Settings) — COMPLETED
- [x] **Tokens & CSS Variables:** Imported exact `tokens.css` with full light, dark, and accent variables (`--a1` through `--ar` for Indigo, Ocean, Emerald, Rose).
- [x] **Windows 11 Titlebar:** Replaced macOS dots with single flat 32px titlebar, left Tori icon badge, and caption buttons (`_`, `□`, `✕` with red hover `#c42b1c`).
- [x] **Toolbar:** 58px height, exact SVG icons from `/icons/toolbar/`, search input with magnifying glass.
- [x] **Sidebar:** 200px width, Library & Categories, chip SVGs from `/icons/chips/`, tinted selection with 3px vertical accent bar on left.
- [x] **Download Table:** 34px rows, 5px radius, tinted selection with 3px vertical accent bar, inline progress bars with static gradients (no shimmer/animation).
- [x] **Bottom Pane Removal:** Bottom details/segments pane completely removed from layout.
- [x] **Toggle Switches:** Rebuilt using real elements (40x24 track, 18x18 knob, 16px translate, gradient `--a1 -> --a2`).
- [x] **Settings Modal:** 4 tabs (Appearance, Download Engine, Browser Integration, About). Appearance tab features Accent Color swatches (Indigo, Ocean, Emerald, Rose) and Theme selector.
- [x] **Strict Performance Rules:** `backdrop-filter: none`, `animation: none`, solid colors only.
- [x] **Quality Gates:** `cargo test` (98/98 passed), `cargo clippy` (0 warnings), `cargo fmt` (clean), `npm run build` (clean), release binary verified (`target/release/tori-download-manager.exe`).

---

## Status of Stage B (Download Toast Popup) — COMPLETED
- [x] **Toast Component:** Implemented `DownloadToast.tsx` and `DownloadToast.css` matching `tori-download-toast.html` down to the pixel.
- [x] **Circular Progress Ring:** 52px SVG with dynamic `stroke-dashoffset` (`stroke-dasharray="131.95"`), 4.5px stroke width, radius 21.
- [x] **Category Chip & Badge:** 30x30 chip centered inside ring with category SVGs and linear gradients; 18px badge overlay for complete (checkmark) and failed (alert).
- [x] **Tabular Subtext & ETA:** Bold filename with ellipsis, secondary line with downloaded/total and speed, tabular numeric ETA.
- [x] **Action Buttons & Dismissal:** 36px round buttons (`.ib`) for Pause, Resume, Open, Folder, Retry. 24px dismiss button (`.cx`) that dismisses toast without cancelling download.
- [x] **Expandable Drawer:** Toggled on filename/ETA click, shows real connection segment meters, hostname, save-to destination, and connection count / resumable flag.
- [x] **Auto-Dismissal & Hover Pause:** 9-second auto-dismiss on completion; paused while mouse hovers over card.
- [x] **Window Mechanics:** Tauri 2 `WebviewWindow` (`progress_toast`), `always_on_top(true)`, `decorations(false)`, `transparent(true)`, `skip_taskbar(true)`, `focused(false)`, anchored bottom-right above taskbar, dynamically sized via `update_toast_bounds`.
- [x] **Multi-Toast Management:** Up to 3 cards visible simultaneously, with `+N more` indicator when > 3 active downloads.
- [x] **Settings Integration:** "Show download popup: Always / On start only / Never" added to SettingsModal and persisted in SQLite.
- [x] **Verification & Artifacts:** All 10 screenshots captured in brain directory, verified with real byte-range server download and process safety checks. Full workspace tests (105/105 passed), cargo clippy (0 warnings), rustfmt (clean).

