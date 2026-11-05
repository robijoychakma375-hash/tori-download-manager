# TORI Download Manager — Gate 12.1 Execution Plan

## Milestone Objective
Resolve critical functional regressions in TORI Download Manager v2.0:
1. **Interactive Download Toast:** Restore real native mouse inputs (Pause, Resume, Retry, Open File, Show in Folder, Dismiss, Expand/Collapse), window dragging from safe non-interactive areas without click hijacking, and prevent instant resurrection on next progress event.
2. **Add URL Media Downloading:** Route video webpage URLs (e.g. YouTube watch URLs) to the managed media resolver (`yt-dlp`) and backend `create_managed_media_download` pipeline rather than the direct HTTP chunk engine (which rejects HTML pages). Include format/resolution selection and support both "Start Download" and "Download Later".
3. **Database & UI Synchronization:** Ensure download records, active filters (All, Finished, Unfinished, Categories), and sidebar badge counts stay accurately synchronized.

---

## Order of Execution

### Phase 1 — Download Toast Interactivity, Dragging & Dismissal Fix
- [ ] Inspect `DownloadToast.tsx`, `DownloadToast.css`, and window creation flags.
- [ ] Remove `data-tauri-drag-region` from `.toast`, `.row`, `.tx`, and `.eta` to prevent Windows `WM_NCHITTEST` `HTCAPTION` click-interception.
- [ ] Apply `-webkit-app-region: no-drag !important;` and `pointer-events: auto !important;` to all interactive controls (`.ib`, `.cx`, `.chip`, `.rg`, `button`, `input`, `a`).
- [ ] Refine `handleDragStart`: initiate `getCurrentWebviewWindow().startDragging()` exclusively on primary mouse down (`e.button === 0`) over safe neutral areas (excluding buttons, thumbnail chips, dismiss button, and drawers).
- [ ] Prevent instant re-creation on progress events: implement `dismissedIdsRef = useRef<Set<string>>(new Set())` so dismissed downloads remain hidden until explicitly reopened.
- [ ] Verify Dismiss (`×`) hides the toast without stopping the download or terminating the process.

### Phase 2 — Add URL Managed Media Integration (Backend & Frontend)
- [ ] Backend: Add `resolve_media(url: String)` Tauri command in `src-tauri/src/commands.rs` wrapping `tdm_core::MediaResolver::new().resolve(&url).await`.
- [ ] Backend: Add `create_media_download(args)` Tauri command in `src-tauri/src/commands.rs` wrapping `state.manager.create_managed_media_download(...)`, supporting `start_immediately: bool` (for Download Later vs Start Download).
- [ ] Backend: Register commands in `src-tauri/src/lib.rs` and update `capabilities/default.json` if needed.
- [ ] Frontend: Update `AddDownloadModal.tsx` to detect media URLs (`isMediaPageUrl`, `isPlaylistUrl`).
- [ ] Frontend: Hide/disable direct HTTP connection slider for managed media downloads.
- [ ] Frontend: Asynchronously fetch available formats/resolutions via `resolve_media`, displaying thumbnail preview, title, and resolution dropdown (`Best Quality`, `1080p`, `720p`, `480p`, `Audio Only`).
- [ ] Frontend: Connect "Start Download" and "Download Later" to `create_media_download` in `App.tsx`.

### Phase 3 — Download List, Category Filtering & Persistence Synchronization
- [ ] Verify `filteredDownloads` logic in `App.tsx` for `all`, `unf`, `fin`, and category filters.
- [ ] Confirm sidebar badge counts match actual SQLite records and in-memory download states.
- [ ] Confirm database persistence across application restarts.

### Phase 4 — Comprehensive Verification & Report
- [ ] Run `cargo test --workspace -- --test-threads=2` (all 107+ tests passing).
- [ ] Run `cargo clippy --workspace --all-targets -- -D warnings`.
- [ ] Run `cargo fmt --all -- --check`.
- [ ] Run `npm --prefix ui run build` (0 TypeScript errors).
- [ ] Build release executable: `cargo tauri build --no-bundle`.
- [ ] Create and execute `scripts/verify_gate12_1.js`:
  - Native mouse input on Toast (Pause, Resume, Drag, Expand, Dismiss).
  - YouTube video download via Add URL with FFprobe validation of playable video/audio.
  - Direct HTTP URL download.
  - Playlist detection & enqueue.
  - Download list persistence & sidebar synchronization.
- [ ] Capture real Windows screenshots for report artifacts.
- [ ] Generate `GATE12_1_TOAST_INTERACTION_AND_ADD_URL_FIX_REPORT.md`.
- [ ] Git commit and status report.
