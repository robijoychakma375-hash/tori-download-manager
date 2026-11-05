# TORI Download Manager — Gate 12.3 Execution Plan

## Milestone Objective
Resolve the clipped top of the circular progress ring and enforce exact 20 CSS px bottom-right margins and invariant bottom-edge upward expansion for the native Download Toast window in TORI Download Manager v2.0.

Reference: `design/tori-final/tori-download-toast.html`

### Key Requirements
1. **Fix Clipped Top of Progress Ring:**
   - Root cause: CSS collision between `#main .toast` in `App.css` and `.toast` in `DownloadToast.css`, where `bottom: 34px` with `position: relative` shifted the card upward by 34px (`top: -22px`), clipping the top of the circular progress ring.
   - Resolution: Scope banner styling to `#main .toast` in `App.css`; explicitly reset `.toast` with `top: auto !important; bottom: auto !important; padding: 0 !important; margin: 0 !important; overflow: visible !important;` in `DownloadToast.css`.
   - Compute bounding box union across `.toast, .toast-more, .row, .rg, .chip, .bd, .dr` with `ResizeObserver` and eager `toast-mode` styling on `document.documentElement`.
2. **Exact 20 CSS px Work Area Margins:**
   - Native window host container has 12px transparent outer padding (`padding: 12px !important;`).
   - Window right gap: $20.0 - 12.0 = 8.0$ logical px.
   - Window bottom gap: $20.0 - 12.0 = 8.0$ logical px.
   - $X = \text{workArea.right} - \text{width} - 8.0$
   - $Y = \text{workArea.bottom} - \text{height} - 8.0$
   - Result: Visible card right edge sits at $\text{workArea.right} - 20.0$, and visible card bottom edge sits at $\text{workArea.bottom} - 20.0$.
   - Scale-invariant across 100%, 125%, 150%, 200% DPI.
3. **Upward Expansion with Invariant Bottom Edge:**
   - On detail drawer expansion or collapse, card bottom edge remains pinned at $\text{workArea.bottom} - 20.0$.
   - Window shifts upward by exact drawer expansion height $\Delta h$.
   - Preserve manual user coordinates when `is_manual: true`.
4. **Multi-Card Stacking Geometry:**
   - 10px gaps between stacked cards (`gap: 10px !important;`).
   - Up to 3 stacked cards + "+N more" badge.

---

## Order of Execution
- [x] Phase 1: CSS specificity collision fix in `App.css` and `DownloadToast.css`.
- [x] Phase 2: Exact 8.0px window gap calculation in `src-tauri/src/commands.rs`.
- [x] Phase 3: Dynamic bounds union computation & multi-item demo support in `DownloadToast.tsx`.
- [x] Phase 4: Full compilation, `cargo fmt`, `cargo clippy`, and cargo tests (108 tests passing).
- [x] Phase 5: Complete verification harness `scripts/verify_gate12_3.js` (37 assertions passing).
- [x] Phase 6: Capture production screenshots (`actual_toast_gate12_3_collapsed.png`, `actual_toast_gate12_3_expanded.png`, `actual_toast_gate12_3_stacked_2.png`, `actual_toast_gate12_3_stacked_3.png`).
- [x] Phase 7: Verification report `GATE12_3_TOAST_GEOMETRY_VERIFICATION_REPORT.md` and Git commit.
