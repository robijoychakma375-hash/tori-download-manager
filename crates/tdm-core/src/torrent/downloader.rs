use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use librqbit::{AddTorrent, AddTorrentOptions, AddTorrentResponse, Session};
use reqwest::Client;
use tokio_util::sync::CancellationToken;

use crate::db::Database;
use crate::engine::{DownloadEvent, EventBus};
use crate::error::{EngineError, Result};
use crate::types::{DownloadJob, DownloadProgress, JobState};

/// Download an engine torrent job (either magnet URI or .torrent file) using librqbit.
pub async fn download_torrent(
    client: &Client,
    session: &Arc<Session>,
    job: &DownloadJob,
    db: &Database,
    event_bus: &EventBus,
    cancel_token: &CancellationToken,
) -> Result<()> {
    // 1. Prepare AddTorrent source
    let url_str = job.url.trim();
    let add_torrent = if url_str.starts_with("magnet:") {
        AddTorrent::from_cli_argument(url_str)
            .map_err(|e| EngineError::InvalidUrl(format!("Invalid magnet URI: {}", e)))?
    } else if url_str.starts_with("http://") || url_str.starts_with("https://") {
        let resp = client.get(url_str).send().await?;
        if !resp.status().is_success() {
            return Err(EngineError::HttpStatus(resp.status().as_u16()));
        }
        let bytes = resp.bytes().await?;
        AddTorrent::TorrentFileBytes(bytes)
    } else {
        // Local file path
        let path = if let Some(stripped) = url_str.strip_prefix("file:///") {
            stripped
        } else if let Some(stripped) = url_str.strip_prefix("file://") {
            stripped
        } else {
            url_str
        };
        let bytes = std::fs::read(path)?;
        AddTorrent::TorrentFileBytes(bytes.into())
    };

    // 2. Determine target output folder
    let target_path = PathBuf::from(&job.target_path);
    let output_folder = if target_path.is_dir() {
        target_path.clone()
    } else {
        target_path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .to_path_buf()
    };

    if !output_folder.exists() {
        std::fs::create_dir_all(&output_folder)?;
    }

    let output_folder_str = output_folder.to_string_lossy().to_string();

    let add_opts = AddTorrentOptions {
        overwrite: true,
        output_folder: Some(output_folder_str),
        paused: false,
        ..Default::default()
    };

    // 3. Add to librqbit session with cooperative cancellation
    let add_res = tokio::select! {
        _ = cancel_token.cancelled() => {
            return Err(EngineError::Cancelled);
        }
        res = session.add_torrent(add_torrent, Some(add_opts)) => {
            res.map_err(|e| EngineError::Other(format!("Failed to add torrent to session: {}", e)))?
        }
    };

    let handle = match add_res {
        AddTorrentResponse::Added(_, h) => h,
        AddTorrentResponse::AlreadyManaged(_, h) => {
            let _ = session.unpause(&h).await;
            h
        }
        AddTorrentResponse::ListOnly(_) => {
            return Err(EngineError::Other("Unexpected ListOnly response".into()));
        }
    };

    // 4. Progress and monitoring loop
    let mut last_checkpoint = Instant::now();
    let mut last_bytes = 0u64;
    let start_time = Instant::now();
    let metadata_timeout = std::time::Duration::from_secs(60);

    loop {
        if cancel_token.is_cancelled() {
            let _ = session.pause(&handle).await;
            let _ = session.delete(handle.id().into(), false).await;
            return Err(EngineError::Cancelled);
        }

        let stats = handle.stats();
        if let Some(err) = stats.error {
            let _ = session.delete(handle.id().into(), false).await;
            return Err(EngineError::Other(format!("Torrent error: {}", err)));
        }

        let downloaded = stats.progress_bytes;
        let total = if stats.total_bytes > 0 {
            Some(stats.total_bytes)
        } else {
            job.total_bytes
        };

        // Determine if we are still probing/fetching metadata
        let is_probing = (total.is_none() || total == Some(0)) && downloaded == 0;

        if is_probing && start_time.elapsed() >= metadata_timeout {
            let _ = session.pause(&handle).await;
            let _ = session.delete(handle.id().into(), false).await;
            return Err(EngineError::Other(
                "Metadata resolution timed out. No active seeders or DHT peers responded for this magnet link.".into(),
            ));
        }

        let current_state = if is_probing {
            JobState::Probing
        } else {
            JobState::Downloading
        };

        let elapsed = last_checkpoint.elapsed();
        if elapsed.as_millis() >= 250 {
            let speed = if elapsed.as_secs_f64() > 0.0 && downloaded >= last_bytes {
                ((downloaded - last_bytes) as f64 / elapsed.as_secs_f64()) as u64
            } else {
                0
            };
            last_checkpoint = Instant::now();
            last_bytes = downloaded;

            let _ = db.update_downloaded_bytes(&job.id, downloaded);
            let _ = db.update_job_state(&job.id, current_state, None);
            event_bus.emit(DownloadEvent::Progress(DownloadProgress {
                id: job.id.clone(),
                downloaded_bytes: downloaded,
                total_bytes: total,
                speed_bps: speed,
                eta_seconds: total.and_then(|tot| {
                    if speed > 0 && tot > downloaded {
                        Some((tot - downloaded) / speed)
                    } else {
                        None
                    }
                }),
                state: current_state,
                error_message: if is_probing {
                    Some("Connecting to peers and retrieving metadata...".to_string())
                } else {
                    None
                },
            }));
        }

        if stats.finished {
            break;
        }

        tokio::select! {
            _ = cancel_token.cancelled() => {
                let _ = session.pause(&handle).await;
                let _ = session.delete(handle.id().into(), false).await;
                return Err(EngineError::Cancelled);
            }
            _ = tokio::time::sleep(std::time::Duration::from_millis(200)) => {}
        }
    }

    // 5. Completion
    let stats = handle.stats();
    let final_bytes = if stats.total_bytes > 0 {
        stats.total_bytes
    } else {
        stats.progress_bytes
    };

    db.update_downloaded_bytes(&job.id, final_bytes)?;
    db.update_job_state(&job.id, JobState::Completed, None)?;
    event_bus.emit(DownloadEvent::StateChanged {
        id: job.id.clone(),
        state: JobState::Completed,
        error: None,
    });

    Ok(())
}
