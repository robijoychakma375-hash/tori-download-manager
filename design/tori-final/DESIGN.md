# Tori Download Manager: design handoff (Windows)

## Files
- `tori-app-ndm-win.html`: main app, the visual reference. Open in a browser. Rebuild it as components in the app's own framework; do not copy the demo code.
- `tori-download-toast.html`: download popup (toast) shown at the bottom-right of the screen.
- `tokens.css`: colours (light and dark), accent themes, radius, font.
- `toggle.html`: exact toggle switch reference.
- `icons/`: ready-made SVGs. Open `icons/preview.html` to see all.

## Rules
- Do not change icons, colours, spacing or radii. Use `icons/` as-is and the variables in `tokens.css`. No emoji, no other icon library, no hard-coded indigo hex (use `--a1..--a7`).
- Windows only: one flat titlebar with minimize / maximize / close. No macOS dots.
- Light theme = `:root`, dark = `[data-theme="dark"]`; Settings → Appearance also has "System (auto)".
- Accent themes: Indigo (default), Ocean, Emerald, Rose via `data-accent` on `<html>`. Chosen in Settings → Appearance → Accent Color.
- Font: Segoe UI Variable / Segoe UI / Inter.
- `icons/chips/`: coloured rounded-square icons for the sidebar and file rows (by category, fallback `other`). `icons/toolbar/`: colour baked in. `icons/settings-tabs/`: `currentColor`.
- Toggle: build from real elements (track 40x24, knob 18x18 white circle, checked = `translateX(16px)`, gradient `--a1 -> --a2`). Never a pseudo-element on a native checkbox.

## Main window
Toolbar (Add URL, Resume, Pause, Stop all, Delete, Start queue, Settings, Search), sidebar (Library: All Downloads, Unfinished, Finished; Categories: Video, Music, Compressed, Programs, Documents), download list (File name, Size, Status, Time left, Speed, Added), status bar. No bottom details/segments pane.
Settings tabs: Appearance, Download Engine (folder, speed limiter, threads, concurrent downloads, retries, dynamic parts, min part size, per-host, proxy, DNS, user agent, SSL, last-modified, track deleted files), Browser Integration (on/off, server port, API key), About.

## Toast popup behaviour
- Downloading: stays while the download runs; the × only hides the toast (download continues).
- Complete: shown 8-10 s, then hides; hover pauses the timer.
- Failed: stays until Retry or ×. Paused: stays.
- Never steal keyboard focus. Hide while another app is fullscreen. Show at most 3 toasts, then "+N more".
- Setting: Show download popup = Always / On start only / Never.
- Click the name or time-left to expand (connection meters, source, save to).

## Performance rules (important)
- No `backdrop-filter`, blur, Acrylic or Mica inside the app; solid colours only.
- No infinite animations (no shimmer, no spinners per row). Progress bars are static gradients, only the width changes.
- No transitions except the toggle (120 ms) and simple hover colour.
- Shadows: at most `0 4px 12px` on menus and popups.
- Download list: virtualize (render only visible rows, about 20-30). Update progress, speed and time left at most once per second and only the cells that changed; never rebuild with `innerHTML` per tick.
- Toast: build the DOM once per state; each tick update only text, ring `stroke-dashoffset` and meter widths. Run the timer only while downloading and the window is visible; pause timers when minimized.
- Memory mostly depends on the framework (Electron is heavy; Tauri / WebView2 is much lighter), not on these visuals.
