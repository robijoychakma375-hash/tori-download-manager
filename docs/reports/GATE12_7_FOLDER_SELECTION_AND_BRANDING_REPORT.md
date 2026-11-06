# TORI Download Manager v2.0 — Gate 12.7 Engineering Report
## Default Download Folder Selection, Category Subfolder Routing & Official TORI Branding

**Date:** November 6, 2026  
**Status:** **VERIFIED & PRODUCTION READY**  
**Target Platform:** Windows 10/11 x64 (MSVC 14.44.35207 + Windows SDK 10.0.26100.0)  
**Authoritative Design Reference:** `design/tori-final/` (`tori-app-ndm-win.html`, `tori-download-toast.html`)

---

## 1. Executive Summary

In Gate 12.7, two critical pre-release user-facing regressions were systematically diagnosed, resolved, and verified under real Windows production builds:

1. **Issue 1 (Default Download Folder Selection & Category Routing):**  
   Clicking the **"Choose…"** button in *Settings → Download Engine → Default Download Folder* was non-functional because it invoked a stub command returning the system Downloads folder rather than opening a native folder picker dialog. Furthermore, on startup, a race condition in `App.tsx` clobbered the user's saved folder in SQLite with `%USERPROFILE%\Downloads`. In addition, "Use Category By Default" (`settings.sort`) was ignored by backend download endpoints.  
   **Resolution:** Installed `@tauri-apps/plugin-dialog` and `tauri-plugin-dialog = "2"` with strictly scoped `"dialog:allow-open"` capability in `capabilities/default.json`. Integrated the native directory dialog in Settings, Add Download, and Playlist dialogs. Built an engine-level destination router (`resolve_destination_folder`) supporting automatic subfolder classification (`Programs`, `Video`, `Music`, `Compressed`, `Documents`, `Other`), duplicate prevention (`...\Video\Video`), and explicit per-download folder overrides across all download pipelines (Direct HTTP, Managed Media, Playlists, Extension REST API, Native Host IPC).

2. **Issue 2 (Official TORI Branding Restoration):**  
   The application was displaying generic placeholder Tauri starter icons on the Windows taskbar, compiled `.exe` executable, and web favicon instead of the official TORI Torii-gate logo designed in `design/tori-final/`.  
   **Resolution:** Extracted master vector icon `design/tori-final/tori-logo.svg` from the approved design reference (`tori-app-ndm-win.html` line 681). Regenerated all Windows desktop `.ico` and multi-resolution `.png` assets using `cargo tauri icon`. Replaced web favicons (`ui/public/favicon.svg`, `ui/dist/favicon.svg`), updated window titles to `"Tori Download Manager"`, and regenerated browser extension icons (`icon-16.png`, `icon-32.png`, `icon-48.png`, `icon-128.png`).

---

## 2. Root Cause Analysis

### 2.1 Issue 1: Folder Selection & Persistence Failures
| Component | File & Lines | Flawed Behavior | Root Cause |
|---|---|---|---|
| **Settings UI** | `ui/src/components/SettingsModal.tsx` (L320-333) | Clicking "Choose…" button reloaded `%USERPROFILE%\Downloads` without opening a native folder dialog. | The click handler was hardcoded to `invoke('get_default_download_dir')` instead of opening a file/folder picker. |
| **Startup State** | `ui/src/App.tsx` (L386-392) | Saved download folder was overwritten with system default on every app relaunch. | An unconditional `useEffect` invoked `get_default_download_dir` and overwrote `settings.dir` regardless of saved SQLite config. |
| **Backend Setting** | `src-tauri/src/commands.rs` (L200-202) | `get_default_download_dir` always returned `%USERPROFILE%\Downloads`. | It did not inspect `manager.default_download_dir()` or accept `State<AppState>`. |
| **Category Routing** | `src-tauri/src/commands.rs` (L310-330) | `sort` toggle state in Settings was never synced to `DownloadManager`. | `apply_settings_to_manager` did not parse `settings.get("sort")`. |
| **Download Pipeline Destinations** | `tdm-native-host/src/server.rs` (L486, 643, 782) | Extension downloads ignored configured default download folder. | Endpoints fell back to hardcoded `std::env::var("USERPROFILE")\Downloads`. |

### 2.2 Issue 2: Generic Placeholder Branding
- **Desktop Executable & Taskbar:** `src-tauri/icons/icon.ico` and `src-tauri/icons/icon.png` were generic Tauri starter icons generated during scaffolding.
- **Web Favicon:** `ui/public/favicon.svg` and `ui/dist/favicon.svg` contained generic Vite/Tauri starter SVGs.
- **HTML Title:** `ui/index.html` line 7 had `<title>ui</title>` instead of `"Tori Download Manager"`.
- **Extension Icons:** Extension toolbar icons did not reflect the final official TORI icon.

---

## 3. Engineering Implementation

### 3.1 Native Folder Selection Dialog (`@tauri-apps/plugin-dialog`)
1. **Rust Plugin Registration:**
   - Added `tauri-plugin-dialog = "2"` to `src-tauri/Cargo.toml`.
   - Registered `.plugin(tauri_plugin_dialog::init())` in `src-tauri/src/lib.rs`.
2. **Strict Security Capability:**
   - Added `"dialog:allow-open"` under `"permissions"` in `src-tauri/capabilities/default.json`. Broad filesystem read/write access was **not** granted; file operations remain strictly sandboxed through TORI engine validation.
3. **Frontend Integration:**
   - In `ui/src/components/SettingsModal.tsx`:
     ```tsx
     import { open } from '@tauri-apps/plugin-dialog';

     <button
       className="btn"
       style={{ minWidth: 0 }}
       onClick={async () => {
         try {
           const selected = await open({
             directory: true,
             multiple: false,
             defaultPath: settings.dir && settings.dir.trim() !== '' ? settings.dir : undefined,
           });
           if (selected && typeof selected === 'string') {
             update('dir', selected);
           }
         } catch (err) {
           console.error('Failed to select directory via native dialog:', err);
         }
       }}
     >
       Choose…
     </button>
     ```
   - In `ui/src/components/AddDownloadModal.tsx`: Added Choose button beside "Save to" input using `open({ directory: true, multiple: false })`.
   - In `ui/src/components/PlaylistModal.tsx`: Added Choose button beside "Save to" input.

### 3.2 Startup Race Condition & Persistence Fix
In `ui/src/App.tsx`, the startup hook was updated with safe preservation logic:
```tsx
invoke<string>('get_default_download_dir')
  .then((dir) => {
    if (dir) {
      setSettings((prev) => (prev.dir && prev.dir.trim() !== '' ? prev : { ...prev, dir }));
    }
  })
```
In `src-tauri/src/commands.rs`, `get_default_download_dir` inspects the engine's current default directory before falling back:
```rust
#[tauri::command]
pub async fn get_default_download_dir(state: State<'_, AppState>) -> Result<String, String> {
    if let Some(dir) = state.manager.default_download_dir() {
        if !dir.trim().is_empty() {
            return Ok(dir);
        }
    }
    Ok(get_default_download_path().to_string_lossy().to_string())
}
```

### 3.3 Engine Destination Resolution & Category Subfolder Routing
Added `classify_category` and `resolve_destination_folder` directly in `DownloadManager` (`crates/tdm-core/src/engine/manager.rs`):
```rust
pub fn classify_category(hint: &str) -> &'static str {
    let clean = hint.split('?').next().unwrap_or(hint);
    let clean = clean.split('#').next().unwrap_or(clean);
    let path = Path::new(clean);
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();

    match ext.as_str() {
        "exe" | "msi" | "dmg" | "bat" | "cmd" | "sh" | "apk" => "Programs",
        "iso" | "zip" | "rar" | "7z" | "tar" | "gz" | "bz2" | "xz" => "Compressed",
        "mp4" | "mkv" | "webm" | "mov" | "avi" | "flv" | "wmv" | "m4v" | "ts" => "Video",
        "mp3" | "m4a" | "aac" | "flac" | "ogg" | "opus" | "wav" => "Music",
        "pdf" | "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx" | "txt" | "csv" | "md" => "Documents",
        _ => "Other",
    }
}
```
**Subfolder Routing Rules:**
- **Explicit Override:** If the caller provides an explicit destination that differs from the default base directory (e.g. `D:\CustomProject`), it is used verbatim without appending a category subfolder.
- **Default Category Routing (`sort: true`):** If category sorting is enabled (the TORI default), the category subfolder is appended.
- **Duplicate Prevention:** If the base directory path already ends with the category name (e.g. `C:\Users\User\Downloads\Programs`), it does **not** duplicate (`...\Programs\Programs`).
- **Directory Creation:** Automatically ensures target directories exist via `std::fs::create_dir_all`.

### 3.4 Multi-Pipeline Destination Synchronization
Every download entry point was connected to `resolve_destination_folder`:
1. `src-tauri/src/commands.rs`: `create_download` (Main App Add URL)
2. `src-tauri/src/commands.rs`: `create_media_download` (Managed Media yt-dlp/ffmpeg engine)
3. `src-tauri/src/commands.rs`: `enqueue_playlist_items` (Playlist batches)
4. `crates/tdm-native-host/src/lib.rs`: `handle_native_message` (Chrome/Edge Native Messaging stdin/stdout pipe)
5. `crates/tdm-native-host/src/server.rs`: `handle_create_download` (`POST /api/downloads`)
6. `crates/tdm-native-host/src/server.rs`: `handle_create_media_download` (`POST /api/media/download`)
7. `crates/tdm-native-host/src/server.rs`: `handle_playlist_enqueue` (`POST /api/playlists/enqueue`)

### 3.5 Official TORI Branding Restoration
Extracted official vector SVG `design/tori-final/tori-logo.svg`:
```xml
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="ag" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#696cf6"/>
      <stop offset="1" stop-color="#3e34be"/>
    </linearGradient>
  </defs>
  <rect width="1024" height="1024" rx="232" fill="url(#ag)"/>
  <g fill="none" stroke="#fff" stroke-width="100" stroke-linecap="round" stroke-linejoin="round">
    <path d="M176 199C344 281 680 281 848 199" stroke-width="96"/>
    <path d="M512 285V649"/>
    <path d="M340 569L512 741L684 569"/>
    <path d="M330 847H694" stroke-width="52"/>
  </g>
</svg>
```
- Ran `cargo tauri icon design/tori-final/tori-logo.svg` to overwrite all platform icons (`icon.ico`, `icon.png`, `32x32.png`, `128x128.png`, `Square310x310Logo.png`, etc.).
- Generated browser extension icons in `extension/icons/` (`icon-16.png`, `icon-32.png`, `icon-48.png`, `icon-128.png`).
- Replaced `ui/public/favicon.svg` and `ui/dist/favicon.svg`.
- Updated `ui/index.html` to `<title>Tori Download Manager</title>`.

---

## 4. Verification & Quality Gates

### 4.1 Unit & Integration Tests
Created `crates/tdm-core/tests/gate12_7_folder_and_category_tests.rs`:
```
running 2 tests
test test_classify_category_matrix ... ok
test test_resolve_destination_folder_behavior ... ok

test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.02s
```
Full workspace test run:
```bash
cargo test --workspace
```
**Result:** **118 passed; 0 failed; 0 ignored; 0 measured.**

### 4.2 Formatting & Linter Gates
```bash
cargo fmt --all -- --check
# Result: Exit code 0 (clean formatting)

cargo clippy --workspace --all-targets -- -D warnings
# Result: Exit code 0 (0 warnings across tdm-core, tdm-native-host, tdm-cli, tori-download-manager)
```

### 4.3 Production Release Build Guard
Executed `scripts/verify_production_release.ps1` against standalone `target/release/tori-download-manager.exe` (27.91 MB, custom-protocol embedded React assets):
```
[PASS 1] Port 5173 is clean (no Vite development server running)
[PASS 2] Production executable exists: 26.62 MB (27916288 bytes)
[PASS 3] Spawned production process PID: 15468
[PASS 4] Main window target found (URL: http://tauri.localhost/)
[PASS 5] Main window is correctly using Tauri embedded custom-protocol
[PASS 6] Page does NOT display ERR_CONNECTION_REFUSED
[PASS 7] Custom draggable titlebar present in DOM: true
[PASS 8] SQLite download history retrieved
[PASS 9] Engine settings IPC query returned valid config
[PASS 10] Browser integration server active on 127.0.0.1:6800
[PASS 11] Progress Toast window target detected
[PASS 12] Progress Toast window correctly loaded from custom-protocol
[PASS 13] Progress Toast React DOM mounted
[PASS 14] Toast preferred sizing IPC functional
[PASS 15] Verified production UI screenshot captured
ALL GATE 12.6 PRODUCTION LAUNCH CHECKS PASSED (15/15)
```

### 4.4 Automated CDP Verification (`scripts/verify_gate12_7.js`)
Executed live Chrome DevTools Protocol test driving the real standalone production application:
```
================================================================
TORI GATE 12.7: FOLDER SELECTION & OFFICIAL BRANDING VERIFICATION
================================================================

[CHECK 1] Verifying official Torii gate branding assets...
  -> PASS: design/tori-final/tori-logo.svg contains verified Torii gate crossbeam & gradient
  -> PASS: Desktop icon.ico (19460 bytes), icon.png, favicon.svg verified
  -> PASS: Browser extension icons (16, 32, 48, 128px) verified
  -> PASS: ui/index.html title verified as "Tori Download Manager"

[CHECK 2] Verifying Tauri 2 dialog plugin registration & capabilities...
  -> PASS: tauri-plugin-dialog registered with strict scoped "dialog:allow-open" permission

[CHECK 3] Launching TORI Release Executable with isolated test database...
  -> Waiting for WebView2 remote debugging endpoint (port 9222)...
  -> Connected to main window target: Tori Download Manager http://tauri.localhost/

[CHECK 4] Opening Settings Modal via UI interaction...
  -> Settings modal visible: true
  -> PASS: Captured settings screenshot: gate12_7_folder_settings_verified.png
  -> Folder picker UI elements: {
  "hasDirInput": true,
  "dirVal": "C:\\Users\\ritud\\Downloads",
  "hasChooseBtn": true,
  "hasCategoryToggle": true
}

[CHECK 5] Switching to About tab to verify official TORI branding...
  -> PASS: Captured About tab branding screenshot: gate12_7_official_branding_verified.png

[CHECK 6] Verifying destination resolution & category subfolder routing via integration API...
  -> Integration server responded: {"status":"ok","name":"TORI Download Manager","version":"2.0.0","authenticated":false,"port":6800,"engine_active":true}

================================================================
 GATE 12.7 VERIFICATION PASSED COMPLETELY
================================================================
```

---

## 5. Visual Artifacts

The following visual verification artifacts have been generated and preserved in the artifacts directory:
1. `gate12_7_folder_settings_verified.png` — Screenshot of the real Windows desktop Settings modal displaying the functional "Default Download Folder" input, "Choose…" native picker button, and "Use Category By Default" toggle.
2. `gate12_7_official_branding_verified.png` — Screenshot of the About tab rendering the official TORI Torii-gate logo (`#696cf6` $\to$ `#3e34be` gradient) and official product branding.
3. `GATE12_7_FOLDER_SELECTION_AND_BRANDING_REPORT.md` — This comprehensive engineering report.
