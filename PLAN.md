# TORI Download Manager v1.0.1 — Milestone Plan: Gate 14.4.6
## Secure Per-Download User-Agent Support

### Objective
Implement optional, secure per-download browser User-Agent propagation across TORI's Browser Extension → IPC → Rust Download Engine pipeline. Propagate validated User-Agent headers strictly to direct HTTP probing, chunk/stream downloads, HLS manifests/segments, and DASH manifests/segments without mutating global Reqwest client defaults, while preserving the existing TORI User-Agent fallback when omitted and preserving all existing Referer context from Gate 14.4.5.

---

### Specific Measurable Next Milestones

#### Milestone 1: Data Model & IPC Schemas
- [x] Add optional `user_agent: Option<String>` to `DownloadJob` in `crates/tdm-core/src/types.rs`.
- [x] Update SQLite schema migration in `crates/tdm-core/src/db/schema.rs` (`ALTER TABLE downloads ADD COLUMN user_agent TEXT`) and update repo methods (`insert_job`, `get_job`, `list_jobs`, `get_next_queued_job`) with backward compatibility.
- [x] Add optional `user_agent: Option<String>` to `CreateMediaDownloadReq` in `crates/tdm-native-host/src/server.rs` (preserve existing `CreateDownloadReq.user_agent`).
- [x] Add optional `user_agent: Option<String>` to `NativeMessage` in `crates/tdm-native-host/src/protocol.rs`.
- [x] Update `create_download` in `src-tauri/src/commands.rs` to accept optional `user_agent: Option<String>`.
- [x] Update existing struct literals across test files (`gate12_5_multisite_tests.rs`, `gate6_torrent_tests.rs`, `gate7_live_tests.rs`, `gate8_protocol_matrix_tests.rs`, `host_tests.rs`, `src-tauri/src/lib.rs`).

#### Milestone 2: User-Agent Sanitization, Validation & Extension Propagation
- [x] Create `crates/tdm-core/src/engine/user_agent.rs`:
  - Reject CRLF (`\r`, `\n`) and ASCII control characters (0-31, 127).
  - Enforce bounded length limit (<= 1024 chars).
  - Validate against `HeaderValue::from_str`.
  - Expose `apply_user_agent(builder, user_agent)` attaching the header only when present and valid, leaving Reqwest default as fallback.
  - Unit tests for valid browser UAs, CRLF injection, control characters, excess length, empty strings, and fallback.
- [x] Implement `getSafeUserAgent(customUserAgent)` in `extension/background.js`:
  - Read `navigator.userAgent` safely in background service worker.
  - Forward `user_agent: browserUserAgent` in `START_DOWNLOAD` (direct HTTP, CDN reroute, Native Messaging).
  - Forward `user_agent: browserUserAgent` in `START_MEDIA_DOWNLOAD`.
- [x] Update `extension/popup/popup.js` and `extension/content.js` to optionally pass `user_agent: navigator.userAgent`.

#### Milestone 3: Rust Engine Network Propagation
- [x] Pass validated User-Agent to `probe_url_with_options` in `crates/tdm-core/src/engine/probe.rs` (attached to HEAD and GET byte-range probes).
- [x] Pass validated User-Agent to `download_chunk_with_options` and `download_stream_with_options` in `crates/tdm-core/src/engine/worker.rs`.
- [x] Pass validated User-Agent in `crates/tdm-core/src/engine/manager.rs`:
  - `create_download_with_all_options` & `create_managed_media_download_with_options`.
  - Re-probing on resume.
  - Multi-chunk worker tasks and tail splitting.
  - Single-stream worker task.
- [x] Pass validated User-Agent to `crates/tdm-core/src/hls/downloader.rs` (master playlist, variant playlist, audio rendition, init segment, AES-128 key, media TS segments).
- [x] Pass validated User-Agent to `crates/tdm-core/src/dash/downloader.rs` (MPD manifest, video/audio init segments, media fragments).
- [x] Sanitize and forward `user_agent` in `crates/tdm-native-host/src/server.rs` (`handle_create_download`, `handle_create_media_download`) and `crates/tdm-native-host/src/lib.rs` (Native Messaging `start_download`).

#### Milestone 4: Verification & Regression Testing
- [x] Build controlled local HTTP test server verifying actual outgoing HTTP request headers (`crates/tdm-native-host/tests/user_agent_tests.rs`):
  - Direct HTTP download with custom User-Agent.
  - Direct HTTP download without User-Agent (verifies default TORI User-Agent fallback).
  - HLS manifest, variant, and segment requests receive custom User-Agent.
  - DASH manifest, init, and segment requests receive custom User-Agent.
  - Invalid User-Agent / CRLF injection rejected safely and falls back to default TORI User-Agent.
  - Concurrent downloads with different User-Agents maintain per-job isolation without leaking.
  - Pause and resume preserves User-Agent on re-probe and chunk resumption.
  - Referer preservation alongside User-Agent.
- [x] Create `scripts/verify_gate14_4_6_user_agent_support.js` verifying extension payloads and sanitization.
- [x] Run regression suites: Gate 14.4.5, Gate 14.4.4, Gate 14.4.3, Gate 14.4.2, `cargo test -p tdm-native-host`, `cargo test -p tdm-core -j 2`, `cargo clippy`, `cargo fmt`.
- [x] Update `IMPLEMENTATION_STATUS.md` and commit locally.
