# TORI Download Manager — Gate 12.4 Execution Plan

## Milestone Objective
Implement Gate 12.4 in two strictly separated, verified phases:
- **Phase A**: User-Resizable Download Toast (native edge/corner resize, preset modes: Compact / Normal / Large / Custom, separate size persistence, safe control regions, DPI invariance).
- **Phase B**: Download Speed Accuracy and Performance Audit (diagnostic audit of speed calculations, multi-connection HTTP benchmarks, managed media vs yt-dlp comparison, bottleneck analysis, and optimization roadmap).

---

## Phase A Plan — User-Resizable Download Toast

### Requirements Breakdown
1. **Preserve Visual Design & Reference Proportions:**
   - Normal reference size remains 470px card (494px window with 12px transparent padding).
   - Bottom-right positioning, transparent window, circular progress ring, category chips/thumbnails, drawer, and action buttons remain pixel-faithful to `design/tori-final/`.
2. **Native Resizing Capabilities & Window Configuration:**
   - Add `"core:window:allow-start-resize-dragging"` capability in `src-tauri/capabilities/default.json`.
   - Update `open_progress_window_internal` in `src-tauri/src/commands.rs`:
     - Set `.resizable(true)` on `progress_toast` window builder.
     - Set `.min_inner_size(384.0, 76.0)` and `.max_inner_size(744.0, 800.0)`.
     - Load preferred width from database setting (`toast_preferred_width`), defaulting to 494.0.
   - Add Tauri commands:
     - `save_toast_size(width: f64)`
     - `get_toast_size() -> Result<Option<f64>, String>`
3. **Safe Edge / Corner Resize Zones:**
   - Add non-intrusive edge resize handle on the West (left) edge and NorthWest (top-left) corner of `.toast-host-container`.
   - On `mousedown` on West handle, trigger `startResizeDragging('West')`.
   - On `mousedown` on NorthWest handle, trigger `startResizeDragging('NorthWest')`.
   - Ensure interactive elements (Pause, Resume, Dismiss, Expand, Drawer) remain 100% clickable with `pointer-events: auto !important;` and `-webkit-app-region: no-drag !important;`.
   - Native dragging via `startDragging()` on row/neutral areas remains intact.
4. **Size Presets & Custom Scaling:**
   - Preset options:
     - **Compact**: 380px card / 404px window
     - **Normal**: 470px card / 494px window (exact reference design)
     - **Large**: 580px card / 604px window
     - **Custom**: mouse-resized width between 384px and 744px
   - Right-click context menu on toast card allowing user to switch presets or reset to Normal.
   - Double-click on left resize border cycles Compact $\to$ Normal $\to$ Large.
   - Dynamic height accommodation: `ResizeObserver` measures rendered content height; height continues to accommodate collapsed/expanded states and stacked cards dynamically.
   - Height never overwrites user's preferred width.
5. **Separate Persistence & Position Independence:**
   - Width is persisted to `toast_preferred_width`.
   - Position is persisted to `toast_window_position` (`{ x, y, is_manual }`).
   - Restoring or changing size does not reset manual position.
   - In default bottom-right mode, $X = \text{workArea.right} - \text{width} - 8.0$, keeping the 20px right margin exact.
6. **Testing & Verification:**
   - Create `scripts/verify_gate12_4_phase_a.js`:
     - Test Compact (404px), Normal (494px), Large (604px), and custom widths.
     - Test window boundaries across 100%, 125%, 150%, 200% scale factors.
     - Test separate persistence of position and size.
     - Verify no clipping of buttons or progress ring.
     - Capture screenshots: `actual_toast_gate12_4_compact.png`, `actual_toast_gate12_4_normal.png`, `actual_toast_gate12_4_large.png`, `actual_toast_gate12_4_expanded_large.png`.
   - Generate `GATE12_4_TOAST_RESIZING_REPORT.md` and commit to Git.

---

## Phase B Plan — Download Speed Accuracy & Audit (COMPLETED & VERIFIED)
- [x] Task 1: Audit speed calculation (monotonic clock backed by QPC, byte aggregation, unit verification).
- [x] Task 2: Controlled direct HTTP benchmarks across 1, 4, 8, 16, 32 connections on 80 MB payload.
- [x] Task 3: Managed media benchmarking against direct yt-dlp baseline on Big Buck Bunny `160+139`.
- [x] Task 4: Independent throughput validation and resumed download byte exclusion test.
- [x] Task 5: Bottleneck analysis and diagnostic recommendations.
- [x] Task 6: Comprehensive verification runner `scripts/audit_speed_and_performance.js` and report `GATE12_4_DOWNLOAD_SPEED_AUDIT_REPORT.md`.
