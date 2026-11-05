# TORI Download Manager — Gate 12.2 Execution Plan

## Milestone Objective
Implement strictly scoped bug fixes for the native Download Toast window in TORI Download Manager v2.0:
1. **Dynamic Content Sizing & Transparent Margin:**
   - Enforce 12px transparent padding around cards in `.toast-host-container` (`padding: 12px !important;`).
   - Dynamic measurement via `getBoundingClientRect()` on container; size Tauri window to match rendered content + padding (collapsed base: 494x100 logical px).
   - Ensure multi-toasts (up to 3 stacked + "+N more") and expanded drawer fit cleanly without window clipping or scrollbars.
2. **Work-Area & DPI-Aware Positioning:**
   - Position toast by default at bottom-right of primary monitor work area (excluding Windows taskbar), with 20px right margin and 20px bottom margin.
   - Accurately determine monitor work area on Windows via `GetMonitorInfoW` / `SPI_GETWORKAREA`.
   - Scale coordinates correctly across 100%, 125%, 150%, 200% DPI and multi-monitor setups.
   - Invalidate/discard legacy or stale coordinates (e.g. legacy `(240, 180)` or non-manual coordinates) and reset to default bottom-right.
   - Anchor bottom-right on dynamic height expansion (upward expansion).
3. **Safe Native Mouse Dragging & Position Persistence:**
   - Allow dragging from safe neutral areas of the card/row.
   - Keep `-webkit-app-region: no-drag !important;` strictly on interactive controls (`button`, `.ib`, `.cx`, `.chip`, `.rg`, `.dr`).
   - Distinguish click vs drag on text (`.tx`, `.eta`): click toggles details drawer; mousemove drag gesture initiates native window dragging.
   - Persist coordinates to SQLite with `is_manual: true` exclusively on user drag completion; never overwrite on programmatic show or resize.
4. **Unknown-Size Text Formatting & Progress Ring:**
   - Format subtext:
     - Total size known: `${fmtB(downloaded)} of ${fmtB(total)} · ${fmtSp(speed)}`
     - Total size unknown with bytes downloaded: `${fmtB(downloaded)} · ${fmtSp(speed)}`
     - Connecting / starting (0 bytes): `Starting…`
     - Paused: `${fmtB(downloaded)}${total > 0 ? ` of ${fmtB(total)}` : ''} · Paused`
     - Complete: `${fmtB(total || downloaded)} · Download complete`
     - Failed: `job.error_message || 'Connection lost · 3 retries failed'`
   - ETA display:
     - Starting -> `Starting…`
     - Known ETA -> formatted duration (`1m 48s`)
     - Active unknown size -> `Live` / `Unknown size`
     - Paused -> `Paused`
     - Complete -> `Done`
     - Failed -> `Failed`
   - Progress ring: Render empty/unfilled ring (`strokeDashoffset = CIRCUMFERENCE`) for unknown total size; no fake percent, no CPU spin.
   - Enforce single-line ellipsis on title, subtext, and ETA.

---

## Order of Execution

### Phase 1 — Dynamic Sizing & Transparent Margin
- [ ] Update `ui/src/components/DownloadToast.css`:
  - `.toast-host-container`: `padding: 12px !important;` on all sides.
  - Enforce single-line text ellipsis on `.tx b`, `.tx span`, `.eta b`, `.eta span`.
  - Remove `-webkit-app-region: no-drag !important;` from `.toast` and `.row`.
  - Ensure interactive controls retain `-webkit-app-region: no-drag !important;` and `pointer-events: auto !important;`.
- [ ] Update `ui/src/components/DownloadToast.tsx`:
  - Measure rendered content dynamically via `getBoundingClientRect()` on container.
  - Debounce `update_toast_bounds` calls to prevent resize loops.

### Phase 2 — Work-Area & DPI-Aware Native Window Positioning
- [ ] Update `src-tauri/src/commands.rs`:
  - Implement Windows work area retrieval via `GetMonitorInfoW` / `SPI_GETWORKAREA`.
  - Calculate bottom-right work area position: `work_right - width - 20.0`, `work_bottom - height - 20.0`.
  - Add `is_manual: bool` to `ToastPosition`. Discard any saved position lacking `is_manual: true` or matching legacy `(240, 180)`.
  - Anchor bottom edge upward on dynamic height increase when in default position.
  - Update initial toast window builder size to `(494.0, 100.0)`.

### Phase 3 — Safe Dragging & Persistence Logic
- [ ] Update `DownloadToast.tsx`:
  - In `handleDragStart`: initiate dragging on neutral area mousedown.
  - On `.tx` and `.eta`: add pointer down + move detection to distinguish click vs drag.
  - On window move: only save position if `isUserDraggingRef.current` is true, and reset `isUserDraggingRef.current = false` after debounce.

### Phase 4 — Unknown Size Formatting & Progress Ring
- [ ] Update `DownloadToast.tsx`:
  - Implement unknown-size subtext and ETA formatting.
  - For unknown size, render empty ring with `offset = CIRCUMFERENCE`.
  - Prevent empty separators, `0 B ·`, `NaN`, `Infinity`, and `-- left`.

### Phase 5 — Verification, Screenshots & Report
- [ ] Build UI: `npm --prefix ui run build`.
- [ ] Check cargo: `cargo check`, `cargo fmt --all -- --check`, `cargo clippy`, `cargo test --workspace`.
- [ ] Build release executable: `cargo tauri build --no-bundle`.
- [ ] Write and run `scripts/verify_gate12_2.js`:
  - Validate default bottom-right position (20px margins from work-area edge).
  - Validate DPI scaling handling.
  - Validate dragging & position persistence.
  - Validate collapsed (494x100) and expanded bounds.
  - Validate unknown-size formatting.
- [ ] Capture visual screenshots: default pos, expanded, unknown size, paused, done.
- [ ] Generate `GATE12_2_TOAST_LAYOUT_POSITION_DRAG_FIX_REPORT.md` and commit to Git.
