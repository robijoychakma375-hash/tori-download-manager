use std::io::{self, BufReader, BufWriter};
use std::path::PathBuf;
use std::sync::Arc;

use tdm_core::{Database, DownloadManager, EventBus, Priority};

pub mod ipc;
pub mod protocol;
pub mod registry;
pub mod server;

use protocol::{read_message, write_message, NativeMessage, NativeResponse};
pub use registry::{register_host, unregister_host, DEFAULT_EXTENSION_ID, HOST_NAME};

pub async fn run() -> io::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() > 1 {
        match args[1].as_str() {
            "--register" => {
                let custom_ext_id = args.get(2).map(|s| s.as_str());
                return register_host(custom_ext_id);
            }
            "--unregister" => {
                return unregister_host();
            }
            _ => {
                eprintln!(
                    "[TORI Native Host] Started with extension caller: {}",
                    args[1]
                );
            }
        }
    }

    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        let _ = io::stdin().as_raw_handle();
        let _ = io::stdout().as_raw_handle();
    }

    let data_dir = if let Ok(override_dir) = std::env::var("TORI_DATA_DIR") {
        PathBuf::from(override_dir)
    } else if let Ok(app_data) = std::env::var("APPDATA") {
        PathBuf::from(app_data).join("tori-download-manager")
    } else {
        PathBuf::from(".tdm-data")
    };
    let _ = std::fs::create_dir_all(&data_dir);
    let db_path = data_dir.join("tdm_storage.sqlite");

    let db = match Database::open(&db_path) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("[TORI Native Host] Error opening database: {}", e);
            return Err(io::Error::other(e.to_string()));
        }
    };

    let event_bus = EventBus::default();
    let manager = match DownloadManager::new(db.clone(), event_bus) {
        Ok(m) => Arc::new(m),
        Err(e) => {
            eprintln!("[TORI Native Host] Error creating manager: {}", e);
            return Err(io::Error::other(e.to_string()));
        }
    };

    let stdin = io::stdin();
    let mut reader = BufReader::new(stdin.lock());
    let stdout = io::stdout();
    let mut writer = BufWriter::new(stdout.lock());

    // Single Persistent Engine Check: ensure the primary desktop engine is active
    let has_ipc = ipc::ensure_engine_running().await;

    while let Ok(Some(msg)) = read_message(&mut reader) {
        let resp = if has_ipc {
            match ipc::forward_to_persistent_engine(&msg).await {
                Ok(r) => r,
                Err(e) => {
                    eprintln!(
                        "[TORI Native Host] IPC forward error: {}, falling back to local engine",
                        e
                    );
                    handle_message(msg, &manager, &db).await
                }
            }
        } else {
            handle_message(msg, &manager, &db).await
        };

        if let Err(e) = write_message(&mut writer, &resp) {
            eprintln!("[TORI Native Host] Write failed: {}", e);
            break;
        }
    }

    Ok(())
}

pub async fn handle_message(
    msg: NativeMessage,
    manager: &DownloadManager,
    db: &Database,
) -> NativeResponse {
    let action = msg.action.to_lowercase();
    match action.as_str() {
        "ping" => NativeResponse {
            status: "ok".to_string(),
            action: "pong".to_string(),
            version: Some("2.0.0".to_string()),
            message: Some("TORI Download Manager native host is active and responsive".to_string()),
            supported: Some(vec![
                "http".to_string(),
                "https".to_string(),
                "hls".to_string(),
                "dash".to_string(),
                "torrent".to_string(),
                "magnet".to_string(),
                "rtsp".to_string(),
                "rtmp".to_string(),
                "rtmps".to_string(),
                "srt".to_string(),
                "rist".to_string(),
                "rtp".to_string(),
                "udp".to_string(),
                "mms".to_string(),
                "live".to_string(),
            ]),
            ..Default::default()
        },

        "pair" | "get_pairing_token" => {
            let token = server::get_or_create_token(db);
            let port = server::get_configured_port(db);
            let active_port = db
                .get_setting("active_server_port")
                .ok()
                .flatten()
                .and_then(|p| p.parse::<u16>().ok())
                .unwrap_or(port);

            NativeResponse {
                status: "ok".to_string(),
                action: "pair".to_string(),
                version: Some("2.0.0".to_string()),
                message: Some("Paired securely via Native Messaging".to_string()),
                token: Some(token),
                port: Some(active_port),
                ..Default::default()
            }
        },

        "show_window" => {
            manager.event_bus().emit(tdm_core::DownloadEvent::ShowWindow);
            NativeResponse {
                status: "ok".to_string(),
                action: "show_window".to_string(),
                version: Some("1.0.1".to_string()),
                message: Some("Window focus request emitted to persistent desktop engine".to_string()),
                ..Default::default()
            }
        },

        "hide_window" => {
            manager.event_bus().emit(tdm_core::DownloadEvent::HideWindow);
            NativeResponse {
                status: "ok".to_string(),
                action: "hide_window".to_string(),
                version: Some("1.0.1".to_string()),
                message: Some("Window hide request emitted to persistent desktop engine".to_string()),
                ..Default::default()
            }
        },

        "open_progress" => {
            if let Some(id) = msg.job_id {
                manager
                    .event_bus()
                    .emit(tdm_core::DownloadEvent::OpenProgressWindow { id: id.clone() });
                NativeResponse {
                    status: "ok".to_string(),
                    action: "open_progress".to_string(),
                    job_id: Some(id),
                    version: Some("1.0.1".to_string()),
                    message: Some("Progress toast window requested".to_string()),
                    ..Default::default()
                }
            } else {
                NativeResponse {
                    status: "error".to_string(),
                    action: "open_progress".to_string(),
                    message: Some("Missing 'job_id'".to_string()),
                    ..Default::default()
                }
            }
        },

        "delete_download" => {
            if let Some(id) = msg.job_id {
                let _ = manager.delete_download(&id, false);
                NativeResponse {
                    status: "ok".to_string(),
                    action: "delete_download".to_string(),
                    job_id: Some(id),
                    state: Some("deleted".to_string()),
                    version: Some("1.0.1".to_string()),
                    message: Some("Download deleted".to_string()),
                    ..Default::default()
                }
            } else {
                NativeResponse {
                    status: "error".to_string(),
                    action: "delete_download".to_string(),
                    message: Some("Missing 'job_id'".to_string()),
                    ..Default::default()
                }
            }
        },

        "detect_capability" => NativeResponse {
            status: "ok".to_string(),
            action: "capability".to_string(),
            version: Some("2.0.0".to_string()),
            message: Some(
                "Direct HTTP/HTTPS, RFC 8216 HLS VOD, ISO/IEC 23009-1 MPEG-DASH VOD, BitTorrent/Magnet, and Live Streams (RTSP, RTMP, SRT, RIST, RTP, UDP, MMS) supported."
                    .to_string(),
            ),
            supported: Some(vec![
                "http".to_string(),
                "https".to_string(),
                "hls".to_string(),
                "dash".to_string(),
                "torrent".to_string(),
                "magnet".to_string(),
                "rtsp".to_string(),
                "rtmp".to_string(),
                "rtmps".to_string(),
                "srt".to_string(),
                "rist".to_string(),
                "rtp".to_string(),
                "udp".to_string(),
                "mms".to_string(),
                "live".to_string(),
            ]),
            ..Default::default()
        },

        "start_download" => {
            let Some(raw_url) = msg.url else {
                return NativeResponse {
                    status: "error".to_string(),
                    action: "start_download".to_string(),
                    message: Some("Missing 'url' parameter".to_string()),
                    ..Default::default()
                };
            };

            let trimmed_url = raw_url.trim();

            let is_supported_scheme = trimmed_url.starts_with("http://")
                || trimmed_url.starts_with("https://")
                || trimmed_url.starts_with("magnet:")
                || trimmed_url.starts_with("rtsp://")
                || trimmed_url.starts_with("rtmp://")
                || trimmed_url.starts_with("rtmps://")
                || trimmed_url.starts_with("srt://")
                || trimmed_url.starts_with("rist://")
                || trimmed_url.starts_with("rtp://")
                || trimmed_url.starts_with("udp://")
                || trimmed_url.starts_with("mms://")
                || trimmed_url.starts_with("mmsh://");

            if !is_supported_scheme {
                return NativeResponse {
                    status: "error".to_string(),
                    action: "start_download".to_string(),
                    message: Some("Only http:// and https:// (or magnet:/live streams) URLs can be downloaded directly. Blob, data, and file URLs are rejected.".to_string()),
                    ..Default::default()
                };
            }

            if let Ok(jobs) = db.list_jobs() {
                if let Some(existing) = jobs.iter().find(|j| {
                    j.url == trimmed_url
                        && (j.state != tdm_core::JobState::Failed
                            && j.state != tdm_core::JobState::Cancelled)
                }) {
                    return NativeResponse {
                        status: "already_exists".to_string(),
                        action: "start_download".to_string(),
                        job_id: Some(existing.id.clone()),
                        filename: Some(existing.filename.clone()),
                        state: Some(existing.state.as_str().to_string()),
                        message: Some(format!(
                            "Job for this URL already exists (state: {})",
                            existing.state.as_str()
                        )),
                        ..Default::default()
                    };
                }
            }

            let dest_dir = manager
                .resolve_destination_folder(trimmed_url, msg.destination.as_deref());

            let priority = match msg.priority.as_deref() {
                Some("high") => Priority::High,
                Some("low") => Priority::Low,
                _ => Priority::Normal,
            };

            let clean_referer = msg
                .referer
                .as_deref()
                .and_then(|r| tdm_core::sanitize_and_validate_referer(r, trimmed_url));

            let clean_user_agent = msg
                .user_agent
                .as_deref()
                .and_then(tdm_core::sanitize_and_validate_user_agent);

            let parsed_sched = msg
                .scheduled_at
                .as_deref()
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .map(|dt| dt.with_timezone(&chrono::Utc));

            match manager
                .create_download_with_all_options_scheduled(
                    trimmed_url,
                    &dest_dir,
                    priority,
                    clean_referer,
                    clean_user_agent,
                    parsed_sched,
                )
                .await
            {
                Ok(job) => {
                    if job.state != tdm_core::JobState::Scheduled {
                        let _ = manager.start_download(&job.id);
                    }
                    NativeResponse {
                        status: "ok".to_string(),
                        action: "start_download".to_string(),
                        job_id: Some(job.id),
                        filename: Some(job.filename),
                        state: Some(job.state.as_str().to_string()),
                        message: Some(if job.state == tdm_core::JobState::Scheduled {
                            "Download scheduled successfully".to_string()
                        } else {
                            "Download created and started successfully".to_string()
                        }),
                        ..Default::default()
                    }
                }
                Err(e) => NativeResponse {
                    status: "error".to_string(),
                    action: "start_download".to_string(),
                    message: Some(format!("Failed to probe and start download: {}", e)),
                    ..Default::default()
                },
            }
        }

        "get_downloads" => match db.list_jobs() {
            Ok(jobs) => {
                let json_jobs: Vec<serde_json::Value> = jobs
                    .iter()
                    .map(|j| {
                        serde_json::json!({
                            "id": j.id,
                            "url": j.url,
                            "filename": j.filename,
                            "state": j.state.as_str(),
                            "scheduled_at": j.scheduled_at.map(|t| t.to_rfc3339()),
                            "total_bytes": j.total_bytes,
                            "downloaded_bytes": j.downloaded_bytes,
                            "priority": j.priority.as_str(),
                            "chunk_count": j.chunk_count,
                        })
                    })
                    .collect();

                NativeResponse {
                    status: "ok".to_string(),
                    action: "get_downloads".to_string(),
                    jobs: Some(json_jobs),
                    ..Default::default()
                }
            }
            Err(e) => NativeResponse {
                status: "error".to_string(),
                action: "get_downloads".to_string(),
                message: Some(e.to_string()),
                ..Default::default()
            },
        },

        "stop_recording" => {
            if let Some(id) = msg.job_id {
                let _ = manager.stop_recording(&id);
                NativeResponse {
                    status: "ok".to_string(),
                    action: "stop_recording".to_string(),
                    job_id: Some(id),
                    state: Some("completed".to_string()),
                    ..Default::default()
                }
            } else {
                NativeResponse {
                    status: "error".to_string(),
                    action: "stop_recording".to_string(),
                    message: Some("Missing 'job_id'".to_string()),
                    ..Default::default()
                }
            }
        }

        "pause_download" => {
            if let Some(id) = msg.job_id {
                let _ = manager.pause_download(&id);
                NativeResponse {
                    status: "ok".to_string(),
                    action: "pause_download".to_string(),
                    job_id: Some(id),
                    state: Some("paused".to_string()),
                    ..Default::default()
                }
            } else {
                NativeResponse {
                    status: "error".to_string(),
                    action: "pause_download".to_string(),
                    message: Some("Missing 'job_id'".to_string()),
                    ..Default::default()
                }
            }
        }

        "resume_download" => {
            if let Some(id) = msg.job_id {
                let _ = manager.resume_download(&id);
                NativeResponse {
                    status: "ok".to_string(),
                    action: "resume_download".to_string(),
                    job_id: Some(id),
                    state: Some("downloading".to_string()),
                    ..Default::default()
                }
            } else {
                NativeResponse {
                    status: "error".to_string(),
                    action: "resume_download".to_string(),
                    message: Some("Missing 'job_id'".to_string()),
                    ..Default::default()
                }
            }
        }

        "cancel_download" => {
            if let Some(id) = msg.job_id {
                let _ = manager.cancel_download(&id);
                NativeResponse {
                    status: "ok".to_string(),
                    action: "cancel_download".to_string(),
                    job_id: Some(id),
                    state: Some("cancelled".to_string()),
                    ..Default::default()
                }
            } else {
                NativeResponse {
                    status: "error".to_string(),
                    action: "cancel_download".to_string(),
                    message: Some("Missing 'job_id'".to_string()),
                    ..Default::default()
                }
            }
        }

        "reschedule_download" => {
            let Some(ref id) = msg.job_id else {
                return NativeResponse {
                    status: "error".to_string(),
                    action: "reschedule_download".to_string(),
                    message: Some("Missing 'job_id'".to_string()),
                    ..Default::default()
                };
            };
            let parsed_sched = msg
                .scheduled_at
                .as_deref()
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .map(|dt| dt.with_timezone(&chrono::Utc));

            match manager.reschedule_download(id, parsed_sched) {
                Ok(_) => NativeResponse {
                    status: "ok".to_string(),
                    action: "reschedule_download".to_string(),
                    job_id: Some(id.clone()),
                    state: Some(if parsed_sched.is_some() {
                        "scheduled".to_string()
                    } else {
                        "queued".to_string()
                    }),
                    message: Some("Download rescheduled successfully".to_string()),
                    ..Default::default()
                },
                Err(e) => NativeResponse {
                    status: "error".to_string(),
                    action: "reschedule_download".to_string(),
                    job_id: Some(id.clone()),
                    message: Some(format!("Failed to reschedule download: {}", e)),
                    ..Default::default()
                },
            }
        }

        unknown => NativeResponse {
            status: "error".to_string(),
            action: unknown.to_string(),
            message: Some(format!("Unknown action '{}'", unknown)),
            ..Default::default()
        },
    }
}
