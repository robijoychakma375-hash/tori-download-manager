# Tori Download Manager: IDM-style design handoff (Windows)

## Files
- `tori-app-idm.html`: main app, IDM-style layout. Visual reference only; rebuild as components in the app's own framework.
- `tori-download-popup.html`: the download popup (IDM-style). Also built into the main HTML (double-click a download or the Download popup demo button).
- `tori-extension.html`: compact extension toolbar popup (header + Open Tori + Settings only) and the format picker shown on videos.
- `tori-extension-options.html`: extension options page (Connection, Capture, Media, Sites, Appearance, About).
- `tokens.css`, `toggle.html`, `icons/` (see `icons/preview.html`).
There is no toast popup in this package.

## IDM-style layout
Titlebar (Windows min/max/close, no macOS dots) -> menu bar (Tasks, File, Downloads, View, Help) -> toolbar (Add URL, Resume, Pause, Stop all, Delete, Start queue, Settings, Search) -> left tree (All Downloads with its categories Video, Music, Compressed, Programs, Documents nested under it, then Unfinished, Finished) -> download list (File name, Size, Status, Time left, Transfer rate, Last try date) -> status bar. No bottom details pane.

## Download popup
IDM-style dialog (light: plain divs, no SVG, no blur): titlebar with Minimize (collapses to a thin progress bar) and Close (download continues), tabs Download status / Speed limiter / Options on completion, URL, rows (Status, File size, Downloaded, Transfer rate, Time left, Resume capability), progress bar with percent, "Connections : N" segment bar, footer = hint text on the left, then two fixed 110px slots: left = Cancel or Close, right = primary (Pause, Resume, Open, Retry; indigo except while downloading).

## Rules
- Do not change icons, colours, spacing or radii. Use `icons/` as-is and variables from `tokens.css` (accent themes via `data-accent`: indigo, ocean, emerald, rose; light/dark via `data-theme`). No emoji, no other icon library.
- Toggle: real elements (track 40x24, knob 18x18), not a pseudo-element on a checkbox.
- Settings tabs: Appearance, Download Engine, Browser Integration (on/off, server port, API key), About.
- Font: Segoe UI Variable / Segoe UI / Inter.

## Performance rules
- No blur / backdrop-filter / Acrylic / Mica, no infinite animation, no transitions except toggle (120 ms) and hover colour. Shadows max `0 4px 12px`.
- Virtualize the download list (about 20-30 visible rows). Update progress, speed and time left at most once per second, only changed cells; never rebuild with `innerHTML` per tick.
- Popup: build the DOM once per state; per tick update only text, ring `stroke-dashoffset` and meter heights. Timers run only while downloading and the window is visible.
