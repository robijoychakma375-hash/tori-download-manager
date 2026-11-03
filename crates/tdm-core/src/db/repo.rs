use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;
use std::sync::{Arc, Mutex};

use crate::error::Result;
use crate::types::{ChunkRecord, DownloadJob, JobState, JobType, Priority};

#[derive(Clone)]
pub struct Database {
    conn: Arc<Mutex<Connection>>,
}

impl Database {
    pub fn open<P: AsRef<Path>>(path: P) -> Result<Self> {
        let conn = Connection::open(path)?;
        crate::db::schema::initialize_database(&conn)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        crate::db::schema::initialize_database(&conn)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    pub fn insert_job(&self, job: &DownloadJob) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO downloads (
                id, url, resolved_url, filename, target_path, temp_path,
                total_bytes, downloaded_bytes, state, job_type, priority, etag,
                last_modified, is_resumable, chunk_count, error_message,
                created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)",
            params![
                job.id,
                job.url,
                job.resolved_url,
                job.filename,
                job.target_path,
                job.temp_path,
                job.total_bytes,
                job.downloaded_bytes,
                job.state.as_str(),
                job.job_type.as_str(),
                job.priority.as_str(),
                job.etag,
                job.last_modified,
                job.is_resumable as i32,
                job.chunk_count,
                job.error_message,
                job.created_at.to_rfc3339(),
                job.updated_at.to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    pub fn update_job_state(
        &self,
        id: &str,
        state: JobState,
        error_message: Option<&str>,
    ) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let now = Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE downloads SET state = ?1, error_message = ?2, updated_at = ?3 WHERE id = ?4",
            params![state.as_str(), error_message, now, id],
        )?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn update_probe_metadata(
        &self,
        id: &str,
        resolved_url: Option<&str>,
        total_bytes: Option<u64>,
        etag: Option<&str>,
        last_modified: Option<&str>,
        is_resumable: bool,
        chunk_count: usize,
    ) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let now = Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE downloads SET
                resolved_url = ?1,
                total_bytes = ?2,
                etag = ?3,
                last_modified = ?4,
                is_resumable = ?5,
                chunk_count = ?6,
                updated_at = ?7
             WHERE id = ?8",
            params![
                resolved_url,
                total_bytes,
                etag,
                last_modified,
                is_resumable as i32,
                chunk_count,
                now,
                id,
            ],
        )?;
        Ok(())
    }

    pub fn save_chunks(&self, chunks: &[ChunkRecord]) -> Result<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        for chunk in chunks {
            tx.execute(
                "INSERT INTO download_chunks (
                    download_id, chunk_index, start_byte, end_byte, written_bytes, is_complete
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                ON CONFLICT(download_id, chunk_index) DO UPDATE SET
                    written_bytes = excluded.written_bytes,
                    is_complete = excluded.is_complete",
                params![
                    chunk.download_id,
                    chunk.chunk_index,
                    chunk.start_byte,
                    chunk.end_byte,
                    chunk.written_bytes,
                    chunk.is_complete as i32,
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn get_chunks(&self, download_id: &str) -> Result<Vec<ChunkRecord>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, download_id, chunk_index, start_byte, end_byte, written_bytes, is_complete
             FROM download_chunks
             WHERE download_id = ?1
             ORDER BY chunk_index ASC",
        )?;

        let rows = stmt.query_map(params![download_id], |row| {
            Ok(ChunkRecord {
                id: Some(row.get(0)?),
                download_id: row.get(1)?,
                chunk_index: row.get(2)?,
                start_byte: row.get(3)?,
                end_byte: row.get(4)?,
                written_bytes: row.get(5)?,
                is_complete: row.get::<_, i32>(6)? != 0,
            })
        })?;

        let mut chunks = Vec::new();
        for r in rows {
            chunks.push(r?);
        }
        Ok(chunks)
    }

    pub fn update_chunk_progress(
        &self,
        download_id: &str,
        chunk_index: usize,
        written_bytes: u64,
        is_complete: bool,
    ) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE download_chunks
             SET written_bytes = ?1, is_complete = ?2
             WHERE download_id = ?3 AND chunk_index = ?4",
            params![written_bytes, is_complete as i32, download_id, chunk_index],
        )?;
        Ok(())
    }

    pub fn update_downloaded_bytes(&self, id: &str, downloaded_bytes: u64) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let now = Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE downloads SET downloaded_bytes = ?1, updated_at = ?2 WHERE id = ?3",
            params![downloaded_bytes, now, id],
        )?;
        Ok(())
    }

    pub fn get_job(&self, id: &str) -> Result<Option<DownloadJob>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT
                id, url, resolved_url, filename, target_path, temp_path,
                total_bytes, downloaded_bytes, state, job_type, priority, etag,
                last_modified, is_resumable, chunk_count, error_message,
                created_at, updated_at
             FROM downloads WHERE id = ?1",
        )?;

        let job = stmt
            .query_row(params![id], |row| {
                let state_str: String = row.get(8)?;
                let job_type_str: String = row.get(9)?;
                let priority_str: String = row
                    .get::<_, Option<String>>(10)?
                    .unwrap_or_else(|| "normal".to_string());
                let created_str: String = row.get(16)?;
                let updated_str: String = row.get(17)?;

                Ok(DownloadJob {
                    id: row.get(0)?,
                    url: row.get(1)?,
                    resolved_url: row.get(2)?,
                    filename: row.get(3)?,
                    target_path: row.get(4)?,
                    temp_path: row.get(5)?,
                    total_bytes: row.get(6)?,
                    downloaded_bytes: row.get(7)?,
                    state: state_str.parse().unwrap_or(JobState::Failed),
                    job_type: job_type_str.parse().unwrap_or(JobType::HttpFile),
                    priority: priority_str.parse().unwrap_or(Priority::Normal),
                    etag: row.get(11)?,
                    last_modified: row.get(12)?,
                    is_resumable: row.get::<_, i32>(13)? != 0,
                    chunk_count: row.get(14)?,
                    error_message: row.get(15)?,
                    created_at: chrono::DateTime::parse_from_rfc3339(&created_str)
                        .map(|dt| dt.with_timezone(&Utc))
                        .unwrap_or_else(|_| Utc::now()),
                    updated_at: chrono::DateTime::parse_from_rfc3339(&updated_str)
                        .map(|dt| dt.with_timezone(&Utc))
                        .unwrap_or_else(|_| Utc::now()),
                })
            })
            .optional()?;

        Ok(job)
    }

    pub fn get_next_queued_job(&self) -> Result<Option<DownloadJob>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT
                id, url, resolved_url, filename, target_path, temp_path,
                total_bytes, downloaded_bytes, state, job_type, priority, etag,
                last_modified, is_resumable, chunk_count, error_message,
                created_at, updated_at
             FROM downloads
             WHERE state = 'queued'
             ORDER BY
                CASE priority
                    WHEN 'high' THEN 1
                    WHEN 'normal' THEN 2
                    WHEN 'low' THEN 3
                    ELSE 4
                END ASC,
                created_at ASC
             LIMIT 1",
        )?;

        let job = stmt
            .query_row([], |row| {
                let state_str: String = row.get(8)?;
                let job_type_str: String = row.get(9)?;
                let priority_str: String = row
                    .get::<_, Option<String>>(10)?
                    .unwrap_or_else(|| "normal".to_string());
                let created_str: String = row.get(16)?;
                let updated_str: String = row.get(17)?;

                Ok(DownloadJob {
                    id: row.get(0)?,
                    url: row.get(1)?,
                    resolved_url: row.get(2)?,
                    filename: row.get(3)?,
                    target_path: row.get(4)?,
                    temp_path: row.get(5)?,
                    total_bytes: row.get(6)?,
                    downloaded_bytes: row.get(7)?,
                    state: state_str.parse().unwrap_or(JobState::Queued),
                    job_type: job_type_str.parse().unwrap_or(JobType::HttpFile),
                    priority: priority_str.parse().unwrap_or(Priority::Normal),
                    etag: row.get(11)?,
                    last_modified: row.get(12)?,
                    is_resumable: row.get(13)?,
                    chunk_count: row.get::<_, i64>(14)? as usize,
                    error_message: row.get(15)?,
                    created_at: chrono::DateTime::parse_from_rfc3339(&created_str)
                        .map(|dt| dt.with_timezone(&chrono::Utc))
                        .unwrap_or_else(|_| chrono::Utc::now()),
                    updated_at: chrono::DateTime::parse_from_rfc3339(&updated_str)
                        .map(|dt| dt.with_timezone(&chrono::Utc))
                        .unwrap_or_else(|_| chrono::Utc::now()),
                })
            })
            .optional()?;

        Ok(job)
    }

    pub fn list_jobs(&self) -> Result<Vec<DownloadJob>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT
                id, url, resolved_url, filename, target_path, temp_path,
                total_bytes, downloaded_bytes, state, job_type, priority, etag,
                last_modified, is_resumable, chunk_count, error_message,
                created_at, updated_at
             FROM downloads
             ORDER BY created_at DESC",
        )?;

        let rows = stmt.query_map([], |row| {
            let state_str: String = row.get(8)?;
            let job_type_str: String = row.get(9)?;
            let priority_str: String = row
                .get::<_, Option<String>>(10)?
                .unwrap_or_else(|| "normal".to_string());
            let created_str: String = row.get(16)?;
            let updated_str: String = row.get(17)?;

            Ok(DownloadJob {
                id: row.get(0)?,
                url: row.get(1)?,
                resolved_url: row.get(2)?,
                filename: row.get(3)?,
                target_path: row.get(4)?,
                temp_path: row.get(5)?,
                total_bytes: row.get(6)?,
                downloaded_bytes: row.get(7)?,
                state: state_str.parse().unwrap_or(JobState::Failed),
                job_type: job_type_str.parse().unwrap_or(JobType::HttpFile),
                priority: priority_str.parse().unwrap_or(Priority::Normal),
                etag: row.get(11)?,
                last_modified: row.get(12)?,
                is_resumable: row.get::<_, i32>(13)? != 0,
                chunk_count: row.get(14)?,
                error_message: row.get(15)?,
                created_at: chrono::DateTime::parse_from_rfc3339(&created_str)
                    .map(|dt| dt.with_timezone(&Utc))
                    .unwrap_or_else(|_| Utc::now()),
                updated_at: chrono::DateTime::parse_from_rfc3339(&updated_str)
                    .map(|dt| dt.with_timezone(&Utc))
                    .unwrap_or_else(|_| Utc::now()),
            })
        })?;

        let mut jobs = Vec::new();
        for r in rows {
            jobs.push(r?);
        }
        Ok(jobs)
    }

    pub fn reset_job_for_restart(&self, download_id: &str) -> Result<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        tx.execute(
            "DELETE FROM download_chunks WHERE download_id = ?1",
            params![download_id],
        )?;
        tx.execute(
            "UPDATE downloads SET downloaded_bytes = 0, state = 'queued', error_message = NULL WHERE id = ?1",
            params![download_id],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn delete_job(&self, download_id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM downloads WHERE id = ?1", params![download_id])?;
        Ok(())
    }

    pub fn split_chunk(
        &self,
        download_id: &str,
        original_chunk_index: usize,
        new_chunk_index: usize,
        new_end_for_original: u64,
        split_start: u64,
        original_end: u64,
    ) -> Result<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;

        // 1. Truncate the original chunk's end_byte
        tx.execute(
            "UPDATE download_chunks SET end_byte = ?1 WHERE download_id = ?2 AND chunk_index = ?3",
            params![new_end_for_original, download_id, original_chunk_index],
        )?;

        // 2. Insert the new chunk starting after the new end
        tx.execute(
            "INSERT INTO download_chunks (
                download_id, chunk_index, start_byte, end_byte, written_bytes, is_complete
            ) VALUES (?1, ?2, ?3, ?4, 0, 0)",
            params![download_id, new_chunk_index, split_start, original_end],
        )?;

        // 3. Update chunk_count in downloads
        tx.execute(
            "UPDATE downloads SET chunk_count = chunk_count + 1 WHERE id = ?1",
            params![download_id],
        )?;

        tx.commit()?;
        Ok(())
    }

    pub fn update_priority(&self, download_id: &str, priority: Priority) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let now = Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE downloads SET priority = ?1, updated_at = ?2 WHERE id = ?3",
            params![priority.as_str(), now, download_id],
        )?;
        Ok(())
    }

    pub fn reconcile_on_startup(&self) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        // Any job that was actively downloading, probing or pausing when the process terminated
        // should be safely marked as Paused so the user or scheduler can resume without false completed state.
        conn.execute(
            "UPDATE downloads
             SET state = 'paused'
             WHERE state IN ('downloading', 'probing', 'pausing', 'verifying')",
            [],
        )?;
        Ok(())
    }

    pub fn get_setting(&self, key: &str) -> Result<Option<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT value FROM engine_settings WHERE key = ?1")?;
        let mut rows = stmt.query(params![key])?;
        if let Some(row) = rows.next()? {
            let val: String = row.get(0)?;
            Ok(Some(val))
        } else {
            Ok(None)
        }
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO engine_settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = ?2",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn get_all_settings(&self) -> Result<std::collections::HashMap<String, String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT key, value FROM engine_settings")?;
        let mut rows = stmt.query([])?;
        let mut map = std::collections::HashMap::new();
        while let Some(row) = rows.next()? {
            let k: String = row.get(0)?;
            let v: String = row.get(1)?;
            map.insert(k, v);
        }
        Ok(map)
    }
}
