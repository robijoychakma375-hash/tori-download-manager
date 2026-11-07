# TORI Download Manager v1.0.1 — Milestone Plan: Gate 14.4.5
## Secure Per-Download Referer Support

### Objective
Implement optional, secure per-download Referer support across TORI's Browser Extension → IPC → Rust Download Engine pipeline. Propagate validated Referer headers strictly to direct HTTP probing, chunk/stream downloads, HLS manifests/segments, and DASH manifests/segments without leaking credentials, query tokens, or headers across cross-origin downgrades/redirects, while preserving all existing behaviors when Referer is omitted.

---

### Specific Measurable Next Milestones

#### Milestone 1: Data Model & IPC Schemas
- [x] Add optional `referer: Option<String>` to `DownloadJob` in `crates/tdm-core/src/types.rs`.
- [x] Update SQLite schema migration in `crates/tdm-core/src/db/schema.rs` (`ALTER TABLE downloads ADD COLUMN referer TEXT`) and update repo methods (`insert_job`, `get_job`, `list_jobs`, `get_next_queued_job`) with backward compatibility.
- [x] Add optional `referer: Option<String>` to `CreateDownloadReq` and `CreateMediaDownloadReq` in `crates/tdm-native-host/src/server.rs`.
- [x] Add optional `referer: Option<String>` to `NativeMessage` in `crates/tdm-native-host/src/protocol.rs`.

#### Milestone 2: Referer Sanitization, Validation & Privacy Enforcement
- [x] Implement `sanitize_and_validate_referer(raw_referer, target_url)` in `crates/tdm-core`:
  - Validate HTTP/HTTPS schemes only (reject `javascript:`, `data:`, `blob:`, `file:`, `chrome:`, etc.).
  - Reject CRLF (`\r`, `\n`) and control characters (header injection defense).
  - Strip userinfo (username:password) and fragments (`#...`).
  - Strip sensitive query parameters or enforce `strict-origin-when-cross-origin`:
    - Downgrade (HTTPS -> HTTP): omit Referer completely (`None`).
    - Cross-origin: truncate to origin (`https://example.com/`).
    - Same-origin: preserve safe path without credentials/fragment.
- [x] Implement corresponding extension referer preparation in `extension/background.js`, `extension/content.js`, and `extension/popup/popup.js`.

#### Milestone 3: Rust Engine Network Propagation
- [x] Pass validated Referer to `probe_url_with_referer` in `crates/tdm-core/src/engine/probe.rs` (for HEAD and GET byte-range probes).
- [x] Pass validated Referer to `download_chunk_with_options` and `download_stream_with_options` in `crates/tdm-core/src/engine/worker.rs`.
- [x] Pass validated Referer to HLS downloader (`crates/tdm-core/src/hls/downloader.rs`) for playlists, keys, and segments.
- [x] Pass validated Referer to DASH downloader (`crates/tdm-core/src/dash/downloader.rs`) for MPD manifest, init segments, and media segments.

#### Milestone 4: Verification & Regression Testing
- [x] Build controlled local HTTP test server verifying actual outgoing HTTP request headers:
  - Direct HTTP download with valid Referer (asserts `Referer` header received).
  - Direct HTTP download without Referer (asserts no `Referer` header sent).
  - HLS manifest and segment requests receive appropriate Referer.
  - DASH manifest and segment requests receive appropriate Referer.
  - Malformed Referer / control chars / CRLF rejected safely.
  - HTTPS -> HTTP downgrade drops Referer.
  - Cross-origin target receives sanitized origin-only Referer.
- [x] Run regression suites: Gate 14.4.4, Gate 14.4.3, Gate 14.4.2, `cargo test -p tdm-native-host`, `cargo test --workspace -j 2`, `cargo clippy`, `cargo fmt`.
- [x] Update `IMPLEMENTATION_STATUS.md` and commit locally.
