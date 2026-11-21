use rusqlite::{Connection, Result};

pub const SCHEMA_VERSION: i32 = 1;

pub fn initialize_database(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA foreign_keys = ON;
         PRAGMA busy_timeout = 5000;",
    )?;

    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            applied_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS downloads (
            id TEXT PRIMARY KEY,
            url TEXT NOT NULL,
            resolved_url TEXT,
            filename TEXT NOT NULL,
            target_path TEXT NOT NULL,
            temp_path TEXT NOT NULL,
            total_bytes INTEGER,
            downloaded_bytes INTEGER NOT NULL DEFAULT 0,
            state TEXT NOT NULL,
            job_type TEXT NOT NULL DEFAULT 'http_file',
            priority TEXT NOT NULL DEFAULT 'normal',
            etag TEXT,
            last_modified TEXT,
            is_resumable INTEGER NOT NULL DEFAULT 0,
            chunk_count INTEGER NOT NULL DEFAULT 1,
            error_message TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS download_chunks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            download_id TEXT NOT NULL REFERENCES downloads(id) ON DELETE CASCADE,
            chunk_index INTEGER NOT NULL,
            start_byte INTEGER NOT NULL,
            end_byte INTEGER NOT NULL,
            written_bytes INTEGER NOT NULL DEFAULT 0,
            is_complete INTEGER NOT NULL DEFAULT 0,
            UNIQUE(download_id, chunk_index)
        );

        CREATE TABLE IF NOT EXISTS engine_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS format_metadata_cache (
            cache_key TEXT PRIMARY KEY,
            platform TEXT NOT NULL,
            video_id TEXT NOT NULL,
            canonical_url TEXT NOT NULL,
            metadata_json TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL,
            last_accessed_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_downloads_state ON downloads(state);
        CREATE INDEX IF NOT EXISTS idx_download_chunks_lookup ON download_chunks(download_id, chunk_index);
        CREATE INDEX IF NOT EXISTS idx_format_cache_expires ON format_metadata_cache(expires_at);
        CREATE INDEX IF NOT EXISTS idx_format_cache_platform_id ON format_metadata_cache(platform, video_id);

        CREATE TABLE IF NOT EXISTS external_tools_registry (
            tool_id TEXT PRIMARY KEY,
            display_name TEXT NOT NULL,
            installed_version TEXT,
            available_version TEXT,
            active_binary_path TEXT,
            source TEXT NOT NULL DEFAULT 'bundled',
            platform TEXT NOT NULL DEFAULT 'windows',
            architecture TEXT NOT NULL DEFAULT 'x86_64',
            artifact_sha256 TEXT,
            installed_at TEXT,
            last_checked_at TEXT,
            last_updated_at TEXT,
            last_successful_version TEXT,
            update_status TEXT NOT NULL DEFAULT 'up_to_date',
            last_error TEXT,
            rollback_available INTEGER NOT NULL DEFAULT 0,
            rollback_version TEXT,
            rollback_binary_path TEXT,
            pending_version TEXT,
            pending_binary_path TEXT,
            failed_versions_json TEXT NOT NULL DEFAULT '[]'
        );

        CREATE TABLE IF NOT EXISTS external_tool_update_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tool_id TEXT NOT NULL,
            action TEXT NOT NULL,
            from_version TEXT,
            to_version TEXT,
            status TEXT NOT NULL,
            source TEXT,
            artifact_sha256 TEXT,
            trust_level TEXT,
            message TEXT,
            created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_ext_tools_history_created ON external_tool_update_history(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_ext_tools_history_tool ON external_tool_update_history(tool_id, created_at DESC);"
    )?;

    // Backward-compatible schema migration
    let _ = conn.execute(
        "ALTER TABLE downloads ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal'",
        [],
    );
    let _ = conn.execute("ALTER TABLE downloads ADD COLUMN thumbnail_url TEXT", []);
    let _ = conn.execute("ALTER TABLE downloads ADD COLUMN referer TEXT", []);
    let _ = conn.execute("ALTER TABLE downloads ADD COLUMN user_agent TEXT", []);
    let _ = conn.execute("ALTER TABLE downloads ADD COLUMN scheduled_at TEXT", []);
    let _ = conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_downloads_scheduled_at ON downloads(scheduled_at)",
        [],
    );

    Ok(())
}
