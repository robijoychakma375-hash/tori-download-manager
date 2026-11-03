# Tori Download Manager: design handoff

`tori-app-ndm-pro.html` is the visual reference (open it in a browser). Do not copy its code; rebuild it as components in the app's own framework.

## Rules
- Do not change icons, colours, spacing or radii. Use the ready-made SVGs in `icons/` as-is (open `icons/preview.html` to see them all) and `tokens.css`.
- `icons/chips/`: finished coloured rounded-square icons (gradient + white glyph), used in the sidebar (20px, 19px) and in the file list rows (20px). Use as images, do not recolour.
- `icons/toolbar/`: 24px stroke icons, colour already baked in.
- `icons/settings-tabs/`: 26px, `currentColor` (grey normally, indigo `#6366f1` when the tab is active; dark theme `#a5a8ff`).
- Sidebar: All Downloads, Unfinished, Finished, Video, Music, Compressed, Programs, Documents. File rows use the chip of their category, falling back to `other`.
- No emoji or other icon libraries.
- Light theme = `:root`, dark = `[data-theme="dark"]`, and a "System (auto)" option follows `prefers-color-scheme`.
- Accent: indigo `#6366f1 -> #4f46e5`. Font: SF Pro / Inter / Segoe UI.

## Screens in the reference
Main window (toolbar, sidebar, download list, details pane, status bar), progress window, Add URL, Download File Info, Allow browser, Settings (Appearance, Download Engine, Browser Integration, About), browser page with the Tori button.

## Prompt for the agent
> Implement the Tori Download Manager UI from `design/`. Use `tokens.css` and `icons/` as the single source of truth, and match `tori-app-ndm-pro.html` in both light and dark themes. Build reusable components: toolbar, sidebar item, download row, progress bar, segments bar, details pane, status bar, settings card row with toggle, buttons, inputs. Do not invent new icons or colours. Compare screenshots with the reference when done.

## Later (extension and popup)
Add new demo HTMLs in this folder and keep sharing `tokens.css` and `icons/`.

## Updates
- The bottom details/segments pane is removed from the design. Do not render it (no file name line, no "Segments", no segment bars). The download list fills the space down to the status bar.
- Toggle switch: build it from real elements, not pseudo-elements or a styled native checkbox. Track 40x24, radius 12, knob 18x18 white circle at left 3 / top 3, checked moves the knob by translateX(16px), checked track = linear-gradient(#7679ff, #4f46e5), unchecked track = var(--fline). See `.swl`, `.sw-track`, `.sw-knob` in `tori-app-ndm-pro.html`.

## Extension (tori-extension.html)
- Media pill on the video ("Download video · 1080p") opens the media panel: video/audio-only tabs, format rows (quality, container tag, HD tag, codec, size), save-to line, Copy link and a Download button that shows the selected format and size.
- Toolbar popup (Tori button with badge): connection status, Capture downloads toggle, media on this page, recent downloads, Open Tori, settings.
- Same tokens, chips and toggle as the main app. Light and dark supported.
