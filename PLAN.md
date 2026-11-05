# TORI Download Manager — Gate 12.7 Execution Plan
## Fix Download Folder Selection & Restore Official TORI Branding

### Milestone Objective
Deliver a verified, production-quality fix for Gate 12.7:
1. Enable native folder selection in Settings → Download Engine → Default Download Folder via Tauri 2 native dialog.
2. Persist chosen folder across sessions, restore on startup without clobbering, and honor it across all download pipelines (Direct HTTP, Managed Media, Browser Extension, Playlists).
3. Support "Use Category By Default" (`settings.sort`): dynamically route downloads into category subfolders (`Programs`, `Video`, `Music`, `Compressed`, `Documents`, `Other`) beneath the base directory without duplicating category names, while preserving explicit "Save To" overrides.
4. Replace default Tauri starter icons with the official TORI Download Manager branding across the Windows executable (`icon.ico`), taskbar, browser extension, and Web UI.

---

### Phase 1: Folder Selection & Destination Routing Engine

#### 1.1 Tauri 2 Dialog Integration
- Add `tauri-plugin-dialog = "2"` to `src-tauri/Cargo.toml`.
- Register `.plugin(tauri_plugin_dialog::init())` in `src-tauri/src/lib.rs`.
- Grant `"dialog:allow-open"` in `src-tauri/capabilities/default.json`.
- Add `@tauri-apps/plugin-dialog` to `ui/package.json`.
- Wire `open({ directory: true, multiple: false, defaultPath: settings.dir })` to the "Choose…" button in `SettingsModal.tsx`.
- Handle path cancellation safely without mutating existing state.

#### 1.2 Settings Persistence & Clashing Fix
- In `src-tauri/src/commands.rs`: update `get_default_download_dir` to return `manager.default_download_dir()`, falling back to `get_default_download_path()`.
- In `ui/src/App.tsx`: remove the clobbering call in `useEffect` that reset `settings.dir` to system default; ensure `syncSettings()` loads and preserves saved directory from SQLite `get_engine_settings`.
- In `apply_settings_to_manager`: sync both `dir` and `sort` into `DownloadManager`.

#### 1.3 Destination Folder & Category Routing
- In `crates/tdm-core/src/engine/manager.rs`:
  - Add `use_category_by_default: Arc<Mutex<bool>>` and getters/setters.
  - Implement `resolve_destination_folder(&self, filename: &str, explicit_dest: Option<&str>) -> PathBuf`.
  - Handle category classification matching `ui/src/utils.ts` (Video, Music, Compressed, Programs, Documents, Other).
  - Prevent duplicate category folder names (e.g. if base dir already ends with `Video`, do not append `Video\Video`).
  - Auto-create destination folder if needed via `std::fs::create_dir_all`.
- In `src-tauri/src/commands.rs` and `crates/tdm-native-host/src/server.rs`:
  - Route all download creation endpoints (`create_download`, `create_media_download`, `enqueue_playlist_items`, `handle_create_download`, `handle_create_media_download`, `handle_playlist_enqueue`) through `resolve_destination_folder`.

---

### Phase 2: Official TORI Branding Restoration

#### 2.1 Master Vector Logo
- Source official TORI logo from `design/tori-final/tori-app-ndm-win.html` (Torii gate + download arrow, `#696cf6` -> `#3e34be` rounded rectangle).
- Save clean master SVG: `design/tori-final/tori-logo.svg` and `ui/public/favicon.svg`.

#### 2.2 Native Application Icons
- Generate Windows multi-resolution `src-tauri/icons/icon.ico` and PNG assets via `cargo tauri icon`.
- Update extension icons (`extension/icons/icon-16.png`, `icon-32.png`, `icon-48.png`, `icon-128.png`).
- Set `<title>Tori Download Manager</title>` in `ui/index.html`.

---

### Phase 3: Verification & Acceptance
- Run `cargo fmt --all -- --check`.
- Run `cargo clippy --workspace --all-targets -- -D warnings`.
- Run `cargo test --workspace`.
- Run `npm --prefix ui run build`.
- Create and execute `scripts/verify_gate12_7.js`:
  - Choose and save a custom directory.
  - Relaunch application and verify persistence.
  - Test download destination with category sorting enabled vs disabled.
  - Verify explicit per-download Save To override.
  - Verify executable and taskbar icon branding.
- Generate `GATE12_7_FOLDER_SELECTION_AND_BRANDING_REPORT.md`.
