# TORI Download Manager v2.0
## GATE 12.3 VERIFICATION REPORT — TOAST CLIPPING ELIMINATION, MARGIN GEOMETRY & UPWARD EXPANSION

**Date:** 2026-11-05  
**Target Environment:** Windows 11 x64 (MSVC 14.44.35207, Windows SDK 10.0.26100.0, Tauri 2.12.5, React 19)  
**Binary Location:** `target\release\tori-download-manager.exe`  
**Reference Design:** `design/tori-final/tori-download-toast.html`  
**Status:** **100% VERIFIED — ALL 37 HARNESS ASSERTIONS PASSING & ZERO CLIPPING**

---

## 1. Executive Summary & Root Cause Resolution

In Gate 12.2, screenshots revealed that the top of the circular progress ring was clipped off by several pixels, and the card was positioned slightly too close to the screen edges.

### The "Smoking Gun" Root Cause of Progress Ring Clipping
Through Edge CDP DOM evaluation of rendered computed styles, we uncovered a CSS specificity collision between:
1. `ui/src/App.css` (lines 1210-1225): A global `.toast` rule intended for in-app alert banners:
   ```css
   .toast {
     position: fixed;
     bottom: 34px;
     left: 50%;
     transform: translateX(-50%);
     padding: 8px 18px;
     ...
   }
   ```
2. `ui/src/components/DownloadToast.css`: Defined `.toast` with `position: relative`, but did NOT reset `bottom: auto`.
3. In CSS relative positioning, an inherited `bottom: 34px` instructs the rendering engine to displace the element **34 pixels UPWARD** relative to its normal flow (`top = -22px`).
4. This unwanted upward displacement forced the top 22 pixels of the Toast card—including the top arc of the circular progress ring—outside the viewport, causing visible top clipping.

### The Fix
1. **Scoped Banner CSS (`App.css`):** Scoped the in-app banner selector to `#main .toast`, preventing any style leakage into the Download Toast window.
2. **Hard CSS Override (`DownloadToast.css`):** Explicitly reset `.toast` with:
   ```css
   .toast {
     position: relative !important;
     top: auto !important;
     bottom: auto !important;
     left: auto !important;
     right: auto !important;
     transform: none !important;
     padding: 0 !important;
     margin: 0 !important;
     overflow: visible !important;
     ...
   }
   ```
3. **Union Bounds Measurement (`DownloadToast.tsx`):**
   Enhanced `updateBounds` to query the union of bounding client rects across `.toast`, `.toast-more`, `.row`, `.rg`, `.chip`, `.bd`, `.dr`, accurately sizing the native window to enclose all children without scrollbars or clipping.
4. **Immediate Transparency (`App.tsx`):**
   Added synchronous `document.documentElement.classList.add('toast-mode')` upon window initialization, ensuring transparent `#root` and zero background flash.

---

## 2. Real DOM Geometry & Clipping Verification

Measured via Chromium/Edge Chrome DevTools Protocol (`Runtime.evaluate` on rendered DOM):

| Element | Measured Top | Measured Bottom | Measured Height | Clearance / Margin | Status |
|---|---|---|---|---|---|
| **Toast Window Host** (`.toast-host-container`) | `0.0px` | `100.0px` | `100.0px` | `12px` transparent outer padding on all 4 sides | **PASS** |
| **Visible Toast Card** (`.toast`) | `12.0px` | `88.0px` | `76.0px` | Sits at exact 12px outer offset; `height: 76px` reference | **PASS** |
| **Circular Progress Ring** (`.toast .rg`) | `24.0px` | `76.0px` | `52.0px` | **24.0px top clearance** from top edge of window | **PASS (0% CLIPPING)** |
| **Circular Ring Indicator** (`.toast .rp`) | `27.0px` | `73.0px` | `46.0px` | **27.0px top clearance** from top edge of window | **PASS (0% CLIPPING)** |
| **Category Chip Icon** (`.toast .chip`) | `35.0px` | `65.0px` | `30.0px` | Centered within circular progress ring | **PASS** |

### Scanline Pixel Verification
Decompressing PNG scanlines of `actual_toast_gate12_3_collapsed.png` confirmed:
- Scanlines `0` through `11`: Zero card content pixels (faint `0 6px 18px rgba(0,0,0,0.28)` ambient shadow safely enclosed within the 12px padding).
- Scanlines `12` through `88`: Exact 76px card body.
- Scanlines `27` through `73`: Exact circular progress ring with full 360-degree perimeter.
- Top clipping is **100% eliminated**.

---

## 3. Work Area & Margin Offsets (Exact 20 CSS px Visible Margin)

### The Mathematical Formula
Given:
- Transparent host padding: $P = 12.0\text{px}$
- Desired visible card margin: $M = 20.0\text{px}$
- Native window gap: $G = M - P = 20.0 - 12.0 = 8.0\text{px}$

For a monitor with work area $[\text{work\_left}, \text{work\_top}, \text{work\_right}, \text{work\_bottom}]$:
$$\text{Window } X = \max(\text{work\_left} + 8.0, \text{work\_right} - \text{width} - 8.0)$$
$$\text{Window } Y = \max(\text{work\_top} + 8.0, \text{work\_bottom} - \text{height} - 8.0)$$

### Visible Card Margin Proof
$$\text{Card Right} = X + P + \text{Card Width} = (\text{work\_right} - \text{width} - 8.0) + 12.0 + 470.0$$
Since $\text{width} = 470.0 + 2 \times 12.0 = 494.0$:
$$\text{Card Right} = \text{work\_right} - 494.0 - 8.0 + 482.0 = \text{work\_right} - 20.0\text{ px}$$
$$\text{Visible Card Right Margin} = \text{work\_right} - \text{Card Right} = \mathbf{20.0\text{ px}}$$

Similarly for the bottom edge:
$$\text{Card Bottom} = Y + P + \text{Card Height} = (\text{work\_bottom} - \text{height} - 8.0) + 12.0 + 76.0$$
Since $\text{height} = 76.0 + 2 \times 12.0 = 100.0$:
$$\text{Card Bottom} = \text{work\_bottom} - 100.0 - 8.0 + 88.0 = \text{work\_bottom} - 20.0\text{ px}$$
$$\text{Visible Card Bottom Margin} = \text{work\_bottom} - \text{Card Bottom} = \mathbf{20.0\text{ px}}$$

### Multi-DPI Verification Matrix

| Windows Scale | Work Area (Physical) | Work Area (Logical) | Window Position $(X, Y)$ | Visible Card Position | Exact Margins (Right, Bottom) | Status |
|---|---|---|---|---|---|---|
| **100%** (1.0) | `(0, 0, 1920, 1032)` | `(0, 0, 1920, 1032)` | `(1418.0, 924.0)` | `(1430.0, 936.0, 1900.0, 1012.0)` | `(20.0px, 20.0px)` | **PASS** |
| **125%** (1.25) | `(0, 0, 1920, 1032)` | `(0, 0, 1536, 825.6)` | `(1034.0, 717.6)` | `(1046.0, 729.6, 1516.0, 805.6)` | `(20.0px, 20.0px)` | **PASS** |
| **150%** (1.5) | `(0, 0, 1920, 1032)` | `(0, 0, 1280, 688)` | `(778.0, 580.0)` | `(790.0, 592.0, 1260.0, 668.0)` | `(20.0px, 20.0px)` | **PASS** |
| **200%** (2.0) | `(0, 0, 1920, 1032)` | `(0, 0, 960, 516)` | `(458.0, 408.0)` | `(470.0, 420.0, 940.0, 496.0)` | `(20.0px, 20.0px)` | **PASS** |

---

## 4. Upward Expansion & Invariant Bottom Edge

When the user clicks the Toast to open the detail drawer:
- **Collapsed:** Window size $494 \times 100$, window $Y = 924.0\text{px}$.  
  Visible card bottom edge: $Y + 100.0 - 12.0 = \mathbf{1012.0\text{px}}$.
- **Expanded:** Window size $494 \times 218$, window $Y = 806.0\text{px}$.  
  Visible card bottom edge: $Y + 218.0 - 12.0 = \mathbf{1012.0\text{px}}$.
- **Bottom Edge Drift:** $\mathbf{0.0\text{ px}}$ (Identical to 10 decimal places).
- The window expands purely **upward** by $\Delta h = 118\text{px}$.
- The bottom edge remains locked at $\text{work\_bottom} - 20.0\text{px}$, safely above the Windows taskbar.
- The expanded drawer stays comfortably within the monitor work area ($806.0\text{px} \ge \text{work\_top} + 8.0\text{px}$).

---

## 5. Multi-Card Stacking Geometry (10px Gaps)

Multi-toasts stack vertically with an exact 10px gap (`gap: 10px !important;` in `.toast-host-container`):

| Stacking Level | Cards Rendered | Content Height | Padding | Total Window Height | Card-to-Card Gap | Bottom Edge Anchored |
|---|---|---|---|---|---|---|
| **1 Card** | 1 | $76\text{px}$ | $24\text{px}$ | $100\text{px}$ | N/A | $\text{work\_bottom} - 20.0$ |
| **2 Cards** | 2 | $76 + 10 + 76 = 162\text{px}$ | $24\text{px}$ | $186\text{px}$ | **10.0px** | $\text{work\_bottom} - 20.0$ |
| **3 Cards** | 3 | $76 + 10 + 76 + 10 + 76 = 248\text{px}$ | $24\text{px}$ | $272\text{px}$ | **10.0px, 10.0px** | $\text{work\_bottom} - 20.0$ |
| **3 + More** | 3 + `+N more` pill | $248 + 10 + 29 = 287\text{px}$ | $24\text{px}$ | $311\text{px}$ | **10.0px** | $\text{work\_bottom} - 20.0$ |

All stacked cards expand upward, maintaining the identical bottom edge position for the primary toast.

---

## 6. Manual Drag Coordinate Preservation

- **User Drag:** When `is_manual: true`, the user's custom $(X, Y)$ coordinates are strictly preserved and clamped within visible monitor work area bounds.
- **Stale Rejection:** Stale coordinates matching legacy test runs (e.g. $240 \times 180$) are rejected and cleanly reset to default bottom-right.
- **Programmatic Resizes:** Programmatic bounds updates (`update_toast_bounds`) never overwrite manual coordinates with default bottom-right.

---

## 7. Artifacts & Visual Proof

The following production screenshots were generated and saved:
1. `actual_toast_gate12_3_collapsed.png` — Collapsed single toast, showing the entire circular progress ring with 27px top clearance and zero clipping.
2. `actual_toast_gate12_3_expanded.png` — Expanded single toast with chunk map, download speed, ETA, and details drawer, expanded upward.
3. `actual_toast_gate12_3_stacked_2.png` — Two stacked download toasts with exact 10px vertical gap.
4. `actual_toast_gate12_3_stacked_3.png` — Three stacked download toasts with exact 10px vertical gaps.

---

## 8. Verification Harness Results

Command: `node scripts/verify_gate12_3.js`
```
=================================================================
TOTAL ASSERTIONS: 37
PASSED: 37
FAILED: 0
=================================================================
>>> ALL GATE 12.3 VERIFICATIONS COMPLETED SUCCESSFULLY <<<
```

Cargo Test Command: `cargo test --workspace -- --test-threads=2`
```
test result: ok. 108 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 55.3s
```
