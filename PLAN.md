# Plan — Gate 10.5.3: Fix Manual Download, Audio Popup Layout & Secure Auto-Pairing [COMPLETED]

## Milestone Status: 100% VERIFIED
All 3 user issues resolved, 106 automated tests passing, 10/10 Edge E2E verification steps passing, and all quality gates clean.

## Next Milestone: Gate 10.6 — Production Packaging, NSIS Release & Cross-Browser Verification
- Build and sign/bundle release NSIS installer (`cargo tauri bundle --bundles nsis`).
- Perform clean installer installation, registry inspection, and uninstall verification.
- Smoke-test Chrome and Edge extension compatibility across varied network environments.

---

## Work Breakdown

### Phase 1: Issue 2 — Audio-Only Popup Layout Fix
- Update `crates/tdm-core/src/resolver/pipeline.rs` to format audio `resolution_label` cleanly (e.g. `130k` or `Audio`) matching Design Source A.
- Update `extension/content.js` to parse audio labels cleanly (`q`: bitrate e.g. `130k`, `tg`: container, `cd`: codec/note, `sz`: size).
- Update `extension/content.css`:
  - Enforce `.tori-fr` flexbox spacing and minimum height.
  - Fix `.tori-q` with `overflow: hidden; text-overflow: ellipsis; white-space: nowrap;`.
  - Fix `.tori-cd` with `flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;`.
  - Fix `.tori-sz` with `margin-left: auto; flex: none; font-variant-numeric: tabular-nums;`.
  - Verify layout under different zoom levels (100%, 125%, 150%).

### Phase 2: Issue 3 — Secure One-Time Pairing & State Synchronization
- Update `crates/tdm-native-host/src/protocol.rs` and `lib.rs`:
  - Add `token` and `port` fields to `NativeResponse`.
  - Handle `"pair"` and `"get_pairing_token"` in `handle_message()`, returning active token and port from SQLite.
- Update `crates/tdm-native-host/src/server.rs`:
  - Add `GET /api/v1/pair/status` reporting genuine pairing status.
  - Track `last_extension_ping` in `ServerState` when authenticated extension requests occur.
  - Return `extension_active` in `get_browser_integration_info`.
- Update `extension/background.js`:
  - Default `key: ''`.
  - Implement `initiatePairing()`: uses Native Messaging to fetch genuine token and port, saves to `chrome.storage.local`.
  - Auto-reconnect on startup and token renewal.
- Update `extension/options/options.js`:
  - Show "Pair with TORI" button when unpaired.
  - Clear hardcoded fake token; use real pairing flow.
- Update `extension/popup/popup.js` and `ui/src/components/StatusBar.tsx`:
  - Display synchronized status: "Connected · 127.0.0.1:6800", "Pairing Required", or "Desktop Offline".

### Phase 3: Issue 1 — Trace & Fix Manual User Download Flow
- Update `extension/content.js`:
  - Add button pending state on click (`.pending`, `Sending to Tori…`).
  - Generate correlation ID (`tori_req_...`).
  - Send `START_MEDIA_DOWNLOAD` with `format_id` for all resolved formats.
  - Only show success if backend returns `{ status: 'ok', job_id }`.
  - Handle duplicate jobs and errors with clear user feedback.
- Update `ui/src/App.tsx`:
  - In `download-event` listener: if incoming `Progress` or `StateChanged` event has an `id` not currently in `downloads`, immediately call `loadDownloads()`.
- Update `crates/tdm-core/src/engine/manager.rs`:
  - Ensure `create_managed_media_download` handles duplicate prevention and updates correctly.

### Phase 4: Automated Verification & Testing
- Create `scripts/verify_gate10_5_3.js`:
  - Launch Desktop app and Edge with unpacked extension.
  - Verify secure auto-pairing via Native Messaging (no manual token copy).
  - Verify Extension Options shows paired status.
  - Verify Extension Popup shows connected status.
  - Resolve video media; switch to Audio Only tab; capture screenshot at 100% and 125% zoom; verify zero text overlap.
  - Click Download on a selected format row via DOM click; verify button pending state; verify response contains valid `job_id`.
  - Verify Desktop UI loads and displays the job in real time.
  - Verify FFprobe streams on output file.
  - Verify cancellation and process reaping (0 orphan processes).
- Run full regression suites:
  - `cargo fmt --all -- --check`
  - `cargo clippy --workspace --all-targets -j 2 -- -D warnings`
  - `cargo test --workspace -j 2 -- --test-threads=1`
  - `npm --prefix ui run build`
  - `cargo tauri build --no-bundle`

### Phase 5: Deliverables
- Produce `GATE10_5_3_USER_ISSUES_FIX_REPORT.md`.
- Update `IMPLEMENTATION_STATUS.md`.
- Git commit all changes cleanly.
