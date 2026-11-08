# TORI Download Manager v1.0.1 — Milestone Plan: Gate 15.1
## Safe Unified SQLite Format Metadata Cache

### Objective
Improve repeat platform media format-list responsiveness by adding a safe, bounded metadata cache using TORI's existing SQLite database (`tdm_storage.sqlite`). Store only sanitized public display metadata (never raw yt-dlp dumps, signed stream URLs, or auth headers). Maintain strict separation between display metadata and fresh download URL acquisition.

---

### Specific Measurable Milestones

#### Milestone 1: Database Schema & Cache Repository
- [x] In `crates/tdm-core/src/db/schema.rs`:
  - Add `format_metadata_cache` table with WAL mode and indexes on `expires_at` and `(platform, video_id)`.
- [x] In `crates/tdm-core/src/db/repo.rs`:
  - Implement `get_format_cache(cache_key)` (returns unexpired cached `MediaMetadata`).
  - Implement `set_format_cache(cache_key, platform, video_id, canonical_url, metadata, ttl_secs)` (sanitizes, serializes, bounds max 500 entries).
  - Implement `invalidate_format_cache(cache_key)`.
  - Implement `purge_expired_format_cache()`.
- [x] In `crates/tdm-core/src/resolver/models.rs`:
  - Add `#[serde(default, skip_serializing_if = "Option::is_none")] pub is_cached: Option<bool>` to `MediaMetadata`.

#### Milestone 2: Normalization, Sanitization & Cache Module
- [x] Create `crates/tdm-core/src/resolver/cache.rs`:
  - Implement `normalize_cache_key(raw_url)` returning platform, video ID, canonical URL, and collision-free cache key.
  - Implement `sanitize_for_cache(meta)` stripping `direct_stream_url`, `http_headers`, tokens, and private fields.
  - Implement `is_cacheable(meta)`.
- [x] Register `pub mod cache;` in `crates/tdm-core/src/resolver/mod.rs`.

#### Milestone 3: Resolver Integration & Display/Download Separation
- [x] In `crates/tdm-core/src/resolver/pipeline.rs`:
  - Add `db: Option<Database>` and `with_database(mut self, db: Database) -> Self` to `MediaResolver`.
  - In `MediaResolver::resolve()`: Check cache before yt-dlp; store sanitized metadata on miss.
- [x] In `crates/tdm-core/src/resolver/orchestrator.rs`:
  - In `DiscoveryOrchestrator::resolve_multi_strategy()`: Check cache before running platform extractor when `!req.force_refresh`.
- [x] In `crates/tdm-native-host/src/server.rs`:
  - Wire `state.db` into `MediaResolver::new().with_database(db.clone())`.
  - In `handle_create_media_download()`: Ensure download initiates with fresh playable URL acquisition via `download_managed_media()`.

#### Milestone 4: Extension UI Cache State & Refresh Action
- [x] In `extension/popup/popup.js`:
  - Display `[Cached]` badge when `meta.is_cached === true`.
  - Provide a "Refresh" button triggering `force_refresh: true`.
  - Ensure download handoff proceeds cleanly with fresh URL resolution.

#### Milestone 5: Automated Testing, Performance Benchmark & Verification
- [x] Create `crates/tdm-core/tests/gate15_1_format_cache_tests.rs`:
  - Unit tests for cache hit/miss, TTL expiration, bounded LRU/FIFO eviction, sanitization (no URLs/headers), malformed JSON recovery, collision avoidance, and force refresh.
- [x] Execute `cargo test --workspace`.
- [x] Execute `cargo clippy --workspace --all-targets -- -D warnings`.
- [x] Execute `cargo fmt --all -- --check`.
- [x] Run latency benchmark to measure repeat metadata cache lookup (<1ms SQLite query).
- [x] Update `IMPLEMENTATION_STATUS.md`.
- [x] Create local Git commit if all tests pass.
