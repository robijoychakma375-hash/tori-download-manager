# TORI Download Manager v2.0
## GATE 12.4 PHASE A REPORT — USER-RESIZABLE DOWNLOAD TOAST

**Date:** 2026-11-05  
**Target Environment:** Windows 11 x64 (MSVC 14.44.35207, Windows SDK 10.0.26100.0, Tauri 2.12.5, React 19)  
**Binary Location:** `target\release\tori-download-manager.exe`  
**Reference Design:** `design/tori-final/tori-download-toast.html`  
**Status:** **100% VERIFIED — ALL 40 AUTOMATED ASSERTIONS PASSING & NATIVE RESIZING OPERATIONAL**

---

## 1. Phase A Summary & Capabilities

Gate 12.4 Phase A delivers native window resizing for the floating Download Toast (`progress_toast`), enabling the user to customize the width of the card while maintaining the exact visual styling, proportions, progress indicators, and controls.

### Core Capabilities Delivered
1. **Window Configuration & Permissions:**
   - Granted Tauri 2 permission `"core:window:allow-start-resize-dragging"` in `src-tauri/capabilities/default.json`.
   - Updated `progress_toast` window builder in `src-tauri/src/commands.rs` to `.resizable(true)` with strict size bounds:
     - `min_inner_size(384.0, 76.0)`
     - `max_inner_size(744.0, 800.0)`
   - The main application window configuration remains unaffected.
2. **Safe Edge Resize Zones:**
   - Implemented an unobtrusive West (left edge) resize handle (`.toast-resize-handle-w`) with cursor `ew-resize`.
   - Implemented a NorthWest (top-left corner) resize handle (`.toast-resize-handle-nw`) with cursor `nwse-resize`.
   - On `mousedown` on these handles, native Tauri window resize dragging is initiated:
     `getCurrentWebviewWindow().startResizeDragging('West')`
     `getCurrentWebviewWindow().startResizeDragging('NorthWest')`
   - Zero permanent visible handle clutters the UI; handles feature subtle hover indicators (`color-mix(in srgb, var(--a3) 35%, transparent)`).
   - Handles are strictly placed on the outer transparent border ($X: 2..12$), avoiding any overlap with interactive buttons.
3. **Preset Sizes & Custom Scaling:**
   - **Compact:** 380px card / 404px window. Preserves progress ring, title, ETA, and buttons without overlap (136px title space, single-line ellipsis).
   - **Normal (Default):** 470px card / 494px window. Exact reference design reproduction.
   - **Large:** 580px card / 604px window. Expanded horizontal layout providing 336px for file titles.
   - **Custom:** User mouse-dragged width anywhere between 360px and 720px card width (384px to 744px window width).
   - Double-clicking the resize handle cycles: Compact $\to$ Normal $\to$ Large $\to$ Compact.
   - Right-clicking the card neutral background opens a clean context menu allowing instant switching between Compact, Normal, Large, and Reset Position.
4. **Independent Persistence:**
   - Saved width is stored in SQLite setting `"toast_preferred_width"` via new commands `save_toast_size` and `get_toast_size`.
   - Stored position remains independent in `"toast_window_position"` (`{ x, y, is_manual }`).
   - Changing width does not overwrite manual position coordinates.
5. **Work Area Margin Invariance Across Multi-DPI:**
   - In default bottom-right mode, $X = \text{workArea.right} - \text{width} - 8.0$.
   - Regardless of whether the card is Compact (380px), Normal (470px), Large (580px), or custom, the visible card right margin is **identically 20.0 CSS px** from the usable monitor work area across 100%, 125%, 150%, and 200% display scaling.

---

## 2. Verification Harness Results (`verify_gate12_4_phase_a.js`)

Command: `node scripts/verify_gate12_4_phase_a.js`

```
=================================================================
TOTAL ASSERTIONS: 40
PASSED: 40
FAILED: 0
=================================================================
>>> ALL GATE 12.4 PHASE A VERIFICATIONS COMPLETED SUCCESSFULLY <<<
```

### Geometric Measurements via Chrome DevTools Protocol

| Preset | Card Width | Card Height | Text Space | Ring Clearance | Button Clearance | Margin from Work Area |
|---|---|---|---|---|---|---|
| **Compact** | `380.0px` | `76.0px` | `136.0px` | `24.0px` | `12.0px` | `20.0px` |
| **Normal** | `470.0px` | `76.0px` | `226.0px` | `24.0px` | `12.0px` | `20.0px` |
| **Large** | `580.0px` | `76.0px` | `336.0px` | `24.0px` | `12.0px` | `20.0px` |
| **Custom (544w)** | `520.0px` | `76.0px` | `276.0px` | `24.0px` | `12.0px` | `20.0px` |

---

## 3. Production Visual Proof

Captured real Windows visual screenshots:
1. `actual_toast_gate12_4_compact.png` — Compact mode (380px card) with all elements cleanly aligned without overlap.
2. `actual_toast_gate12_4_normal.png` — Normal reference mode (470px card).
3. `actual_toast_gate12_4_large.png` — Large mode (580px card) with extended filename title area.
4. `actual_toast_gate12_4_expanded_large.png` — Large mode expanded drawer with chunk map and download details.
