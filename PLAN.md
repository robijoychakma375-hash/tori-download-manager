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

## Stage B (Download Toast Popup) — UPCOMING
1. **Toast Component:** Implement `ToastNotification.tsx` matching `tori-download-toast.html`.
2. **Circular Progress Ring:** 52px SVG with dynamic `stroke-dashoffset` for download percentage.
3. **Category Chip Badge:** 30x30 chip centered inside the progress ring.
4. **Expandable Drawer:** Toggle connection meters, source, save-to destination on name/time click.
5. **Non-Focus Window / Popup:** Multi-window toast window positioned at bottom right of screen, never stealing keyboard focus.
