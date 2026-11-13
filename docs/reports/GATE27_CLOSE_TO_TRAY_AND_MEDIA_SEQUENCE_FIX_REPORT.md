# TORI Download Manager — Gate 27 Technical Investigation & Fix Report
## Close-to-Tray Default/Persistence & Media Sequence Handoff Matrix

**Project:** `F:\TORI\final tori download manager`  
**Active Branch:** `fix/gate27-runtime-fixes`  
**Base Checkpoint:** `checkpoint-gate27-start` (`30a017b`)  
**Desktop Target:** `v1.0.4`  
**Browser Companion:** `v1.0.5`  
**Date:** November 13, 2026  
**Status:** **FULLY REPAIRED & VERIFIED (16/16 Acceptance Checks PASS, 7/7 Server Tests PASS, 47/47 Core Tests PASS)**

---

## 1. Executive Summary

During Gate 27, we investigated, reproduced, and permanently resolved two critical user-observed production defects that persisted across previous releases:

1. **BUG 1 (Close-to-Tray Non-Functional):**
   - *User Symptom:* When the user closed TORI using the title-bar `X` button, the application exited completely instead of minimizing/hiding to the system tray, even when the user believed Close-to-Tray was enabled.
   - *Investigation Outcome:* The previous automated tests in Gate 26 passed because the test script explicitly launched TORI with the CLI flag `--enable-close-to-tray`. In normal production launches (Start Menu, Desktop shortcut, or Native Messaging auto-spawn), no CLI flag is passed. Because historical QA scripts had populated SQLite with `closeToTray: false`, and `SettingsModal.tsx` lacked a clickable row container and visual feedback, user settings remained locked to `false`.
   - *Resolution:* Added an authoritative SQLite migration in `src-tauri/src/lib.rs` and `ui/src/App.tsx` that ensures `closeToTray: true` by default on initial launch of v1.0.4+ while strictly preserving existing user paths, themes, and concurrency. Enhanced `SettingsModal.tsx` with full-row clickability and immediate toast feedback (`flash()`). User preference `false` is permanently honored once explicitly chosen.

2. **BUG 2 (Audio Download Blocks Subsequent Video Download):**
   - *User Symptom:* After downloading media using the "Audio only" option from a webpage (e.g., YouTube, Vimeo, Twitch), attempting to download a video from the same page URL resulted in `status: "already_exists"` and no download task was added to TORI.
   - *Investigation Outcome:* In `crates/tdm-native-host/src/server.rs`, `handle_create_media_download` deduplicated active jobs using only `(j.url == raw_url || j.url == target_media_url)`. Because `j.url` stores the common canonical webpage URL, an active or completed Audio task (format `140` or `251`) blocked any subsequent Video task (format `18`, `22`, or `137+140`) from the same page.
   - *Resolution:* Updated `handle_create_media_download` to match deduplication on both the canonical page URL and the specific stream format identifier (`format_matches = j.resolved_url.as_deref() == Some(format_id)`). Now, different formats (Audio vs Video, 720p vs 1080p) from the same webpage URL are recognized as distinct jobs and queue cleanly.

---

## 2. Forensic Root Cause Analysis

### 2.1 Bug 1: Close-to-Tray Failure Analysis

```
┌────────────────────────────────────────────────────────────────────────┐
│                        PREVIOUS BROKEN FLOW                            │
└────────────────────────────────────────────────────────────────────────┘
1. User installs TORI or upgrades from v1.0.3 -> v1.0.4.
2. Older QA scripts had written `closeToTray: false` into SQLite `app_settings`.
3. In `src-tauri/src/lib.rs`, the recovery utility was gated behind:
      if std::env::args().any(|a| a == "--enable-close-to-tray") { ... }
   -> Normal user shortcuts NEVER passed this CLI argument!
4. In `ui/src/App.tsx`, `syncSettings` loaded `closeToTray: false` from SQLite.
5. In `ui/src/components/SettingsModal.tsx`, the row `<div className="sr">`
   had no click handler, no label `id`, and only the tiny 40x24 switch had an event.
   Clicking the row label or description failed to toggle the setting.
6. User clicked TitleBar 'X' (`window_close`):
      is_close_to_tray_enabled(&app) returned false!
   -> TORI executed `perform_clean_exit` and terminated.
```

#### Why Automated Gate 26 Tests Passed:
In [`scripts/verify_gate26_1_runtime.js`](file:///F:/TORI/final%20tori%20download%20manager/scripts/verify_gate26_1_runtime.js#L509):
```javascript
const uiProc = spawn(MAIN_EXE, ['--enable-close-to-tray'], { ... });
```
The test harness had explicitly passed `--enable-close-to-tray` on the command line! This masked the failure for normal desktop users who launched the executable directly without flags.

### 2.2 Bug 2: Media Sequence Deduplication Analysis

```
┌────────────────────────────────────────────────────────────────────────┐
│                        PREVIOUS BROKEN FLOW                            │
└────────────────────────────────────────────────────────────────────────┘
1. User visits YouTube video URL: `https://www.youtube.com/watch?v=...`
2. Extension sends POST /api/v1/media/download with format_id: "251" (Audio).
3. Backend creates Job:
      job.url = "https://www.youtube.com/watch?v=..."
      job.resolved_url = "251"
4. User clicks "Download Video" (format_id: "18" - 360p or "137+140" - 1080p).
5. Backend checks deduplication in `handle_create_media_download`:
      j.url == raw_url || j.url == target_media_url
   -> MATCH FOUND! (Both URLs equal the YouTube watch URL).
6. Backend returns HTTP 200:
      {"status": "already_exists", "job_id": "<audio_job_id>"}
7. Frontend Extension assumes task already exists and drops the video request.
   -> RESULT: No video task is ever created or downloaded!
```

---

## 3. Targeted Code Modifications

### 3.1 Backend Media Deduplication Fix
**File:** [`crates/tdm-native-host/src/server.rs`](file:///F:/TORI/final%20tori%20download%20manager/crates/tdm-native-host/src/server.rs#L858-L873)

```rust
    // Duplicate check for media download: match by canonical URL and format identifier
    if let Ok(jobs) = state.db.list_jobs() {
        if let Some(existing) = jobs.iter().find(|j| {
            let url_matches = j.url == raw_url || j.url == target_media_url;
            let format_matches = match j.resolved_url.as_deref() {
                Some(existing_fmt) => existing_fmt == format_id,
                None => format_id == "best" || format_id.is_empty(),
            };
            url_matches
                && format_matches
                && (j.state != tdm_core::JobState::Failed
                    && j.state != tdm_core::JobState::Cancelled)
        }) {
            return Json(serde_json::json!({
                "status": "already_exists",
                "message": "Media download already exists in TORI",
                "job_id": existing.id,
                "filename": existing.filename,
                "state": existing.state
            }));
        }
    }
```

### 3.2 Backend Close-to-Tray Migration & Observability
**File:** [`src-tauri/src/lib.rs`](file:///F:/TORI/final%20tori%20download%20manager/src-tauri/src/lib.rs#L103-L128)

```rust
    let already_migrated_tray = db
        .get_setting("close_to_tray_migrated_v104")
        .ok()
        .flatten()
        .is_some();

    if !already_migrated_tray || force_enable_close_to_tray {
        let mut settings_obj = db
            .get_setting("app_settings")
            .ok()
            .flatten()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
            .unwrap_or_else(|| serde_json::json!({}));
        if let Some(map) = settings_obj.as_object_mut() {
            map.insert("closeToTray".to_string(), serde_json::Value::Bool(true));
        }
        if let Ok(serialized) = serde_json::to_string(&settings_obj) {
            let _ = db.set_setting("app_settings", &serialized);
            let _ = db.set_setting("close_to_tray_migrated_v104", "true");
            lifecycle::log_event(
                "APP",
                "CLOSE_TO_TRAY_ENABLED",
                "Default v1.0.4 closeToTray migration activated in app_settings without resetting other settings",
            );
        }
    }
```

**File:** [`src-tauri/src/commands.rs`](file:///F:/TORI/final%20tori%20download%20manager/src-tauri/src/commands.rs#L543-L562)
```rust
    if let Some(close_to_tray) = settings.get("closeToTray").and_then(|v| v.as_bool()) {
        crate::lifecycle::log_event(
            "SETTINGS",
            "CLOSE_TO_TRAY_UPDATED",
            &format!("enabled={}", close_to_tray),
        );
    }
```

### 3.3 Frontend React Settings & UI Clickability
**File:** [`ui/src/App.tsx`](file:///F:/TORI/final%20tori%20download%20manager/ui/src/App.tsx#L377-L415)
- Added `tori_settings_v104_tray_migrated` check in `syncSettings()`.
- On initial launch of v1.0.4, defaults `closeToTray: true` in state and SQLite while preserving all existing user configuration.

**File:** [`ui/src/components/SettingsModal.tsx`](file:///F:/TORI/final%20tori%20download%20manager/ui/src/components/SettingsModal.tsx#L504-L530)
- Wrapped `<div className="sr">` with `cursor: pointer` and `onClick={() => { update('closeToTray', nextVal); flash(...); }}`.
- Added `id="setting-close-to-tray"` and `flash()` visual feedback.
- Used `e.stopPropagation()` on switch container to prevent double toggling.

---

## 4. Verification Evidence & Test Results

### 4.1 Automated Acceptance Suite (`scripts/verify_gate27_close_to_tray_and_media.js`)
Executed against isolated environment (`TORI_DATA_DIR` in `target/test_gate27_...`) without CLI flags:

| Check ID | Description | Status | Evidence |
| :--- | :--- | :---: | :--- |
| **PHASE 1.1** | Native Host auto-spawns desktop engine | **PASS** | `status: "ok", action: "pong"` |
| **PHASE 1.2** | Desktop HTTP API authenticated and online | **PASS** | `status: 200, authenticated: true, port: 16860` |
| **PHASE 1.3** | Initial Video download (format 18) succeeds | **PASS** | `status: "ok", job_id: "8099b9ca-..."` |
| **PHASE 1.4** | Duplicate Video download returns `already_exists` | **PASS** | `status: "already_exists", job_id: "8099b9ca-..."` |
| **PHASE 1.5** | **[BUG 2 FIX] Audio download from SAME URL succeeds** | **PASS** | `status: "ok", job_id: "318a8d56-..."` (distinct!) |
| **PHASE 1.6** | Duplicate Audio download returns `already_exists` | **PASS** | `status: "already_exists", job_id: "318a8d56-..."` |
| **PHASE 1.7** | Alternative Video format (137+140) succeeds | **PASS** | `status: "ok", job_id: "326c74cc-..."` (distinct!) |
| **PHASE 1.8** | All 3 distinct formats coexist in downloads state | **PASS** | `totalJobs: 3` (Video 360p, Audio opus, Video 1080p) |
| **PHASE 2.1** | Desktop launches cleanly without flags (zero CLI flags) | **PASS** | `PID: 20728, HTTP API online` |
| **PHASE 2.2** | WebView2 CDP remote debugging connection established | **PASS** | `cdpConnected: true` |
| **PHASE 2.3** | **[BUG 1 FIX] SQLite migration sets `closeToTray: true`** | **PASS** | `closeToTray: true, [APP] CLOSE_TO_TRAY_ENABLED` |
| **PHASE 2.4** | **[BUG 1 FIX] Clicking X hides window; process survives** | **PASS** | `isPidAlive: true, [WINDOW] HIDE_MAIN` |
| **PHASE 2.5** | **[BUG 1 FIX] Disabling Close-to-Tray saves to SQLite** | **PASS** | `closeToTray: false, [SETTINGS] CLOSE_TO_TRAY_UPDATED` |
| **PHASE 2.6** | **[BUG 1 FIX] Clicking X when disabled triggers clean exit** | **PASS** | `isPidAlive: false, [APP] EXIT_CLEAN` |
| **PHASE 2.7** | **[BUG 1 FIX] User setting `false` persists across reboots** | **PASS** | `closeToTray: false, migrationCount: 1` |
| **PHASE 2.8** | Clean shutdown leaves zero orphan processes | **PASS** | `isPidAlive: false` |

**Suite Result:** **16/16 PASSED (100%)**  
**Detailed Report Saved:** [`target/gate27_acceptance_result.json`](file:///F:/TORI/final%20tori%20download%20manager/target/gate27_acceptance_result.json)

### 4.2 Rust Integration & Unit Tests
- `cargo test -p tdm-native-host --test server_tests`: **7/7 PASSED** (including format sequence matrix in `test_server_media_endpoints`).
- `cargo test -p tdm-core`: **47/47 PASSED** (0 regressions).
- `cargo check --workspace`: **PASS (0 warnings, 0 errors)**.
- `ui`: `npm run build`: **PASS (built in 543ms)**.

---

## 5. Safety and Preservation Guarantee
- **User Database:** `%APPDATA%\tori-download-manager\tdm_storage.sqlite` was preserved intact without mutation.
- **Installed Production App:** User instance `C:\Users\ritud\AppData\Local\TORI Download Manager\tori-download-manager.exe` was paused solely during the isolated test run and restored immediately afterwards.
- **Release Assets:** No versions were bumped, no tags created, and no public releases or website files were published, adhering strictly to the Gate 27 instructions.

---

## 6. Recommendations & Next Steps
Both user-observed production defects have been identified forensically, repaired with minimal targeted changes, and verified under controlled automated tests.
When the operator authorizes the next release preparation:
1. Stage a Desktop `v1.0.5` release candidate containing these fixes.
2. Build the production Windows NSIS installer.
3. Validate upgrade acceptance from `v1.0.4` to `v1.0.5`.
