use chrono::{DateTime, Utc};
use rusqlite::{params, OptionalExtension};

use crate::db::Database;
use crate::error::Result;
use crate::tools::types::{
    ExternalToolHistoryEntry, ExternalToolRecord, ExternalToolsSettings, ManifestAntiReplayState,
    SchedulerState, ToolId, ToolUpdateStatus,
};

const SETTINGS_KEY: &str = "external_tools_settings";
const SCHEDULER_STATE_KEY: &str = "external_tools_scheduler_state";
const MANIFEST_STATE_KEY: &str = "external_tools_manifest_state";

fn parse_dt(s: Option<String>) -> Option<DateTime<Utc>> {
    s.and_then(|v| {
        DateTime::parse_from_rfc3339(&v)
            .ok()
            .map(|dt| dt.with_timezone(&Utc))
    })
}

pub fn load_settings(db: &Database) -> ExternalToolsSettings {
    db.get_setting(SETTINGS_KEY)
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str::<ExternalToolsSettings>(&raw).ok())
        .map(ExternalToolsSettings::normalized)
        .unwrap_or_default()
}

pub fn save_settings(db: &Database, settings: &ExternalToolsSettings) -> Result<ExternalToolsSettings> {
    let normalized = settings.clone().normalized();
    let json = serde_json::to_string(&normalized)
        .map_err(|e| crate::error::EngineError::Other(e.to_string()))?;
    db.set_setting(SETTINGS_KEY, &json)?;
    Ok(normalized)
}

pub fn load_scheduler_state(db: &Database) -> SchedulerState {
    db.get_setting(SCHEDULER_STATE_KEY)
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str::<SchedulerState>(&raw).ok())
        .unwrap_or_default()
}

pub fn save_scheduler_state(db: &Database, state: &SchedulerState) -> Result<()> {
    let json = serde_json::to_string(state)
        .map_err(|e| crate::error::EngineError::Other(e.to_string()))?;
    db.set_setting(SCHEDULER_STATE_KEY, &json)?;
    Ok(())
}

pub fn load_manifest_state(db: &Database) -> ManifestAntiReplayState {
    db.get_setting(MANIFEST_STATE_KEY)
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str::<ManifestAntiReplayState>(&raw).ok())
        .unwrap_or_default()
}

pub fn save_manifest_state(db: &Database, state: &ManifestAntiReplayState) -> Result<()> {
    let json = serde_json::to_string(state)
        .map_err(|e| crate::error::EngineError::Other(e.to_string()))?;
    db.set_setting(MANIFEST_STATE_KEY, &json)?;
    Ok(())
}

pub fn upsert_tool_record(db: &Database, rec: &ExternalToolRecord) -> Result<()> {
    let failed_json = serde_json::to_string(&rec.failed_versions).unwrap_or_else(|_| "[]".into());
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO external_tools_registry (
                tool_id, display_name, installed_version, available_version, active_binary_path,
                source, platform, architecture, artifact_sha256,
                installed_at, last_checked_at, last_updated_at, last_successful_version,
                update_status, last_error, rollback_available, rollback_version, rollback_binary_path,
                pending_version, pending_binary_path, failed_versions_json
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5,
                ?6, ?7, ?8, ?9,
                ?10, ?11, ?12, ?13,
                ?14, ?15, ?16, ?17, ?18,
                ?19, ?20, ?21
            )
            ON CONFLICT(tool_id) DO UPDATE SET
                display_name = excluded.display_name,
                installed_version = excluded.installed_version,
                available_version = excluded.available_version,
                active_binary_path = excluded.active_binary_path,
                source = excluded.source,
                platform = excluded.platform,
                architecture = excluded.architecture,
                artifact_sha256 = excluded.artifact_sha256,
                installed_at = excluded.installed_at,
                last_checked_at = excluded.last_checked_at,
                last_updated_at = excluded.last_updated_at,
                last_successful_version = excluded.last_successful_version,
                update_status = excluded.update_status,
                last_error = excluded.last_error,
                rollback_available = excluded.rollback_available,
                rollback_version = excluded.rollback_version,
                rollback_binary_path = excluded.rollback_binary_path,
                pending_version = excluded.pending_version,
                pending_binary_path = excluded.pending_binary_path,
                failed_versions_json = excluded.failed_versions_json",
            params![
                rec.tool_id.as_str(),
                rec.display_name,
                rec.installed_version,
                rec.available_version,
                rec.active_binary_path,
                rec.source,
                rec.platform,
                rec.architecture,
                rec.artifact_sha256,
                rec.installed_at.map(|d| d.to_rfc3339()),
                rec.last_checked_at.map(|d| d.to_rfc3339()),
                rec.last_updated_at.map(|d| d.to_rfc3339()),
                rec.last_successful_version,
                rec.update_status.as_str(),
                rec.last_error,
                rec.rollback_available as i32,
                rec.rollback_version,
                rec.rollback_binary_path,
                rec.pending_version,
                rec.pending_binary_path,
                failed_json,
            ],
        )?;
        Ok(())
    })
}

fn row_to_tool_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<ExternalToolRecord> {
    let tool_id_str: String = row.get(0)?;
    let tool_id = tool_id_str.parse::<ToolId>().unwrap_or(ToolId::YtDlp);
    let status_str: String = row.get(13)?;
    let failed_json: String = row
        .get::<_, Option<String>>(20)?
        .unwrap_or_else(|| "[]".to_string());
    let failed_versions = serde_json::from_str::<Vec<String>>(&failed_json).unwrap_or_default();

    Ok(ExternalToolRecord {
        tool_id,
        display_name: row.get(1)?,
        installed_version: row.get(2)?,
        available_version: row.get(3)?,
        active_binary_path: row.get(4)?,
        source: row.get(5)?,
        platform: row.get(6)?,
        architecture: row.get(7)?,
        artifact_sha256: row.get(8)?,
        installed_at: parse_dt(row.get(9)?),
        last_checked_at: parse_dt(row.get(10)?),
        last_updated_at: parse_dt(row.get(11)?),
        last_successful_version: row.get(12)?,
        update_status: status_str
            .parse::<ToolUpdateStatus>()
            .unwrap_or(ToolUpdateStatus::UpToDate),
        last_error: row.get(14)?,
        rollback_available: row.get::<_, i32>(15)? != 0,
        rollback_version: row.get(16)?,
        rollback_binary_path: row.get(17)?,
        pending_version: row.get(18)?,
        pending_binary_path: row.get(19)?,
        failed_versions,
    })
}

pub fn get_tool_record(db: &Database, tool_id: ToolId) -> Result<Option<ExternalToolRecord>> {
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT
                tool_id, display_name, installed_version, available_version, active_binary_path,
                source, platform, architecture, artifact_sha256,
                installed_at, last_checked_at, last_updated_at, last_successful_version,
                update_status, last_error, rollback_available, rollback_version, rollback_binary_path,
                pending_version, pending_binary_path, failed_versions_json
             FROM external_tools_registry WHERE tool_id = ?1",
        )?;
        stmt.query_row(params![tool_id.as_str()], row_to_tool_record)
            .optional()
    })
}

pub fn list_tool_records(db: &Database) -> Result<Vec<ExternalToolRecord>> {
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT
                tool_id, display_name, installed_version, available_version, active_binary_path,
                source, platform, architecture, artifact_sha256,
                installed_at, last_checked_at, last_updated_at, last_successful_version,
                update_status, last_error, rollback_available, rollback_version, rollback_binary_path,
                pending_version, pending_binary_path, failed_versions_json
             FROM external_tools_registry
             ORDER BY CASE tool_id
                WHEN 'yt-dlp' THEN 1
                WHEN 'ffmpeg' THEN 2
                WHEN 'ffprobe' THEN 3
                ELSE 4
             END ASC",
        )?;
        let rows = stmt.query_map([], row_to_tool_record)?;
        let mut list = Vec::new();
        for r in rows {
            list.push(r?);
        }
        Ok(list)
    })
}

#[allow(clippy::too_many_arguments)]
pub fn insert_history_entry(
    db: &Database,
    tool_id: &str,
    action: &str,
    from_version: Option<&str>,
    to_version: Option<&str>,
    status: &str,
    source: Option<&str>,
    artifact_sha256: Option<&str>,
    trust_level: Option<&str>,
    message: Option<&str>,
) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO external_tool_update_history (
                tool_id, action, from_version, to_version, status, source,
                artifact_sha256, trust_level, message, created_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                tool_id,
                action,
                from_version,
                to_version,
                status,
                source,
                artifact_sha256,
                trust_level,
                message,
                now,
            ],
        )?;
        // Cap update history table to latest 500 entries so DB size stays bounded
        let _ = conn.execute(
            "DELETE FROM external_tool_update_history
             WHERE id NOT IN (
                SELECT id FROM external_tool_update_history
                ORDER BY id DESC LIMIT 500
             )",
            [],
        );
        Ok(())
    })
}

pub fn list_history_entries(db: &Database, limit: usize) -> Result<Vec<ExternalToolHistoryEntry>> {
    let clamped = limit.clamp(1, 500) as i64;
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT
                id, tool_id, action, from_version, to_version, status,
                source, artifact_sha256, trust_level, message, created_at
             FROM external_tool_update_history
             ORDER BY id DESC
             LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![clamped], |row| {
            let created_str: String = row.get(10)?;
            Ok(ExternalToolHistoryEntry {
                id: row.get(0)?,
                tool_id: row.get(1)?,
                action: row.get(2)?,
                from_version: row.get(3)?,
                to_version: row.get(4)?,
                status: row.get(5)?,
                source: row.get(6)?,
                artifact_sha256: row.get(7)?,
                trust_level: row.get(8)?,
                message: row.get(9)?,
                created_at: DateTime::parse_from_rfc3339(&created_str)
                    .map(|dt| dt.with_timezone(&Utc))
                    .unwrap_or_else(|_| Utc::now()),
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    })
}
