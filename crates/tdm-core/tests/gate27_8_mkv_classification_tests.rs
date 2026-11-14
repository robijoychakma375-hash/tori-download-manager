use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use sha2::{Digest, Sha256};
use tempfile::tempdir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

use tdm_core::engine::probe::{parse_content_disposition_filename, probe_url_with_options};
use tdm_core::{Database, DownloadManager, EventBus, JobState, Priority};

fn deterministic_payload(size: usize, seed: u8) -> Vec<u8> {
    (0..size)
        .map(|i| (((i * 31) ^ (i >> 7)) as u8).wrapping_add(seed))
        .collect()
}

fn sha256_hex(data: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(data);
    hex::encode(h.finalize())
}

#[derive(Clone)]
struct MockEntry {
    data: Arc<Vec<u8>>,
    content_type: String,
    content_disposition: Option<String>,
    redirect_to: Option<String>,
    delay_ms_per_chunk: u64,
}

async fn start_fixture_server(
    routes: HashMap<String, MockEntry>,
) -> (u16, CancellationToken) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let cancel = CancellationToken::new();
    let cancel_srv = cancel.clone();
    let routes = Arc::new(routes);

    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cancel_srv.cancelled() => break,
                res = listener.accept() => {
                    let (mut socket, _) = match res {
                        Ok(s) => s,
                        Err(_) => break,
                    };
                    let routes = routes.clone();
                    tokio::spawn(async move {
                        let mut buf = [0u8; 8192];
                        let n = socket.read(&mut buf).await.unwrap_or(0);
                        if n == 0 {
                            return;
                        }
                        let req = String::from_utf8_lossy(&buf[..n]);
                        let first_line = req.lines().next().unwrap_or("");
                        let parts: Vec<&str> = first_line.split_whitespace().collect();
                        if parts.len() < 2 {
                            return;
                        }
                        let method = parts[0];
                        let full_target = parts[1];
                        let path_only = full_target.split('?').next().unwrap_or(full_target);

                        let Some(entry) = routes.get(path_only) else {
                            let _ = socket.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
                            return;
                        };

                        if let Some(ref target_loc) = entry.redirect_to {
                            let loc = target_loc.replace("{PORT}", &port.to_string());
                            let resp = format!(
                                "HTTP/1.1 302 Found\r\nLocation: {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                                loc
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                            return;
                        }

                        let cd_hdr = entry
                            .content_disposition
                            .as_ref()
                            .map(|v| format!("Content-Disposition: {}\r\n", v))
                            .unwrap_or_default();

                        let total = entry.data.len();

                        if method == "HEAD" {
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: {}\r\n{}Content-Length: {}\r\nAccept-Ranges: bytes\r\nETag: \"gate27-8-etag\"\r\nConnection: close\r\n\r\n",
                                entry.content_type, cd_hdr, total
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                            return;
                        }

                        let range_line = req.lines().find(|l| l.to_ascii_lowercase().starts_with("range:"));
                        if let Some(rl) = range_line {
                            if let Some((_, rhs)) = rl.split_once(':') {
                                let rhs = rhs.trim();
                                if let Some(spec) = rhs.strip_prefix("bytes=") {
                                    let (s_str, e_str) = spec.split_once('-').unwrap_or(("0", ""));
                                    let start = s_str.trim().parse::<usize>().unwrap_or(0);
                                    let end = if e_str.trim().is_empty() {
                                        total.saturating_sub(1)
                                    } else {
                                        e_str.trim().parse::<usize>().unwrap_or(total.saturating_sub(1)).min(total.saturating_sub(1))
                                    };
                                    if start <= end && end < total {
                                        let slice = &entry.data[start..=end];
                                        let hdr = format!(
                                            "HTTP/1.1 206 Partial Content\r\nContent-Type: {}\r\n{}Content-Range: bytes {}-{}/{}\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nETag: \"gate27-8-etag\"\r\nConnection: close\r\n\r\n",
                                            entry.content_type,
                                            cd_hdr,
                                            start,
                                            end,
                                            total,
                                            slice.len()
                                        );
                                        if socket.write_all(hdr.as_bytes()).await.is_err() {
                                            return;
                                        }
                                        if entry.delay_ms_per_chunk > 0 && slice.len() > 1 {
                                            for chunk in slice.chunks(32 * 1024) {
                                                if socket.write_all(chunk).await.is_err() {
                                                    return;
                                                }
                                                tokio::time::sleep(Duration::from_millis(entry.delay_ms_per_chunk)).await;
                                            }
                                        } else {
                                            let _ = socket.write_all(slice).await;
                                        }
                                        return;
                                    }
                                }
                            }
                        }

                        let hdr = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: {}\r\n{}Content-Length: {}\r\nAccept-Ranges: bytes\r\nETag: \"gate27-8-etag\"\r\nConnection: close\r\n\r\n",
                            entry.content_type, cd_hdr, total
                        );
                        if socket.write_all(hdr.as_bytes()).await.is_err() {
                            return;
                        }
                        if entry.delay_ms_per_chunk > 0 {
                            for chunk in entry.data.chunks(32 * 1024) {
                                if socket.write_all(chunk).await.is_err() {
                                    return;
                                }
                                tokio::time::sleep(Duration::from_millis(entry.delay_ms_per_chunk)).await;
                            }
                        } else {
                            let _ = socket.write_all(&entry.data).await;
                        }
                    });
                }
            }
        }
    });

    (port, cancel)
}

async fn wait_for_completion(manager: &DownloadManager, job_id: &str, timeout_secs: u64) -> tdm_core::DownloadJob {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(timeout_secs);
    loop {
        if let Some(job) = manager.get_download(job_id).unwrap() {
            match job.state {
                JobState::Completed => return job,
                JobState::Failed | JobState::Cancelled => {
                    panic!("Job {} failed unexpectedly: {:?}", job_id, job.error_message);
                }
                _ => {}
            }
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "Timed out waiting for job {} completion",
            job_id
        );
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
}

#[test]
fn test_gate27_8_content_disposition_parser_rfc6266_and_security() {
    // RFC 5987 filename* wins even when plain filename appears first
    assert_eq!(
        parse_content_disposition_filename(
            "attachment; filename=\"fallback.dat\"; filename*=UTF-8''Example_Movie.mkv"
        ),
        Some("Example_Movie.mkv".to_string())
    );

    // Case-insensitive attribute, language tag, and spaces around '='
    assert_eq!(
        parse_content_disposition_filename(
            "ATTACHMENT; FILENAME = \"wrong.bin\"; FILENAME* = utf-8'en'Test%20Film%20%E5%A4%A7%E5%9E%8B.mkv"
        ),
        Some("Test Film 大型.mkv".to_string())
    );

    // Semicolon inside quoted filename
    assert_eq!(
        parse_content_disposition_filename("attachment; filename=\"Part1;Final.mkv\"; size=42"),
        Some("Part1;Final.mkv".to_string())
    );

    // Malicious path traversal & drive letter prefixes stripped to safe basename
    assert_eq!(
        parse_content_disposition_filename("attachment; filename=\"../../outside/evil.mkv\""),
        Some("evil.mkv".to_string())
    );
    assert_eq!(
        parse_content_disposition_filename(
            "attachment; filename=\"C:\\\\Users\\\\victim\\\\Movie.mkv\""
        ),
        Some("Movie.mkv".to_string())
    );

    // Pure traversal or NUL byte injection rejected cleanly
    assert_eq!(
        parse_content_disposition_filename("attachment; filename=\"../../..\""),
        None
    );
    assert_eq!(
        parse_content_disposition_filename("attachment; filename*=UTF-8''evil%00.mkv"),
        None
    );
}

#[test]
fn test_gate27_8_category_matrix_and_content_type_safety() {
    // Video container formats
    for file in [
        "movie.mkv",
        "clip.mp4",
        "stream.webm",
        "camera.mov",
        "archive.avi",
        "broadcast.ts",
        "bluray.m2ts",
    ] {
        assert_eq!(
            DownloadManager::classify_category(file),
            "Video",
            "Expected Video for {}",
            file
        );
    }

    // Normal categories preserved
    assert_eq!(DownloadManager::classify_category("track.mp3"), "Music");
    assert_eq!(DownloadManager::classify_category("lossless.flac"), "Music");
    assert_eq!(DownloadManager::classify_category("bundle.zip"), "Compressed");
    assert_eq!(DownloadManager::classify_category("archive.7z"), "Compressed");
    assert_eq!(DownloadManager::classify_category("spec.pdf"), "Documents");
    assert_eq!(DownloadManager::classify_category("draft.docx"), "Documents");
    assert_eq!(DownloadManager::classify_category("setup.exe"), "Programs");

    // Content-Type fallback ONLY trusts unambiguous media types without overriding explicit unknown extension
    assert_eq!(
        DownloadManager::classify_category_with_content_type("cd_blob", Some("video/x-matroska")),
        "Video"
    );
    assert_eq!(
        DownloadManager::classify_category_with_content_type(
            "cd_blob",
            Some("application/octet-stream")
        ),
        "Other"
    );
    assert_eq!(
        DownloadManager::classify_category_with_content_type(
            "movie.mkv",
            Some("application/octet-stream")
        ),
        "Video"
    );
    assert_eq!(
        DownloadManager::classify_category_with_content_type(
            "opaque.dat",
            Some("video/x-matroska")
        ),
        "Other"
    );
}

#[tokio::test]
async fn test_gate27_8_post_probe_classification_and_e2e_routing() {
    let mut routes = HashMap::new();

    let payload_direct = Arc::new(deterministic_payload(256 * 1024, 1));
    let payload_cd = Arc::new(deterministic_payload(300 * 1024, 2));
    let payload_redir = Arc::new(deterministic_payload(220 * 1024, 3));
    let payload_unicode = Arc::new(deterministic_payload(180 * 1024, 4));
    let payload_octet_mkv = Arc::new(deterministic_payload(200 * 1024, 5));
    let payload_rfc5987 = Arc::new(deterministic_payload(190 * 1024, 6));
    let payload_unknown = Arc::new(deterministic_payload(128 * 1024, 7));
    let payload_evil = Arc::new(deterministic_payload(64 * 1024, 8));
    let payload_mp4 = Arc::new(deterministic_payload(150 * 1024, 9));
    let payload_mp3 = Arc::new(deterministic_payload(110 * 1024, 10));
    let payload_zip = Arc::new(deterministic_payload(130 * 1024, 11));
    let payload_pdf = Arc::new(deterministic_payload(90 * 1024, 12));
    let payload_mime_video = Arc::new(deterministic_payload(140 * 1024, 13));

    // 1. Direct .mkv URL
    routes.insert(
        "/direct_movie.mkv".to_string(),
        MockEntry {
            data: payload_direct.clone(),
            content_type: "video/x-matroska".to_string(),
            content_disposition: None,
            redirect_to: None,
            delay_ms_per_chunk: 0,
        },
    );

    // 2. Extensionless /cd_blob with Content-Disposition filename="Example_Movie.mkv"
    routes.insert(
        "/cd_blob".to_string(),
        MockEntry {
            data: payload_cd.clone(),
            content_type: "video/x-matroska".to_string(),
            content_disposition: Some("attachment; filename=\"Example_Movie.mkv\"".to_string()),
            redirect_to: None,
            delay_ms_per_chunk: 0,
        },
    );

    // 3. Redirected + signed URL ending in .mkv
    routes.insert(
        "/redir_entry".to_string(),
        MockEntry {
            data: Arc::new(Vec::new()),
            content_type: "text/plain".to_string(),
            content_disposition: None,
            redirect_to: Some(
                "http://127.0.0.1:{PORT}/signed/Signed_Cut_4K.mkv?X-Amz-Signature=deadbeef&Expires=1999999999"
                    .to_string(),
            ),
            delay_ms_per_chunk: 0,
        },
    );
    routes.insert(
        "/signed/Signed_Cut_4K.mkv".to_string(),
        MockEntry {
            data: payload_redir.clone(),
            content_type: "video/x-matroska".to_string(),
            content_disposition: None,
            redirect_to: None,
            delay_ms_per_chunk: 0,
        },
    );

    // 4. Unicode MKV filename
    routes.insert(
        "/unicode_cd".to_string(),
        MockEntry {
            data: payload_unicode.clone(),
            content_type: "video/x-matroska".to_string(),
            content_disposition: Some(
                "attachment; filename*=UTF-8''Test%20Film%20%E5%A4%A7%E5%9E%8B%20%E6%98%A0%E7%94%BB%20%282026%29.mkv"
                    .to_string(),
            ),
            redirect_to: None,
            delay_ms_per_chunk: 0,
        },
    );

    // 5. application/octet-stream WITH valid MKV filename via Content-Disposition
    routes.insert(
        "/octet_mkv_blob".to_string(),
        MockEntry {
            data: payload_octet_mkv.clone(),
            content_type: "application/octet-stream".to_string(),
            content_disposition: Some("attachment; filename=\"Octet_Wrapped_Movie.mkv\"".to_string()),
            redirect_to: None,
            delay_ms_per_chunk: 0,
        },
    );

    // 6. Content-Disposition with filename* overriding filename
    routes.insert(
        "/rfc5987_priority".to_string(),
        MockEntry {
            data: payload_rfc5987.clone(),
            content_type: "application/octet-stream".to_string(),
            content_disposition: Some(
                "attachment; filename=\"wrong_fallback.bin\"; filename*=UTF-8'en'Priority_Film_1080p.mkv"
                    .to_string(),
            ),
            redirect_to: None,
            delay_ms_per_chunk: 0,
        },
    );

    // 7/8. Unknown file type -> Other/ (octet-stream without MKV filename/extension)
    routes.insert(
        "/unknown_blob".to_string(),
        MockEntry {
            data: payload_unknown.clone(),
            content_type: "application/octet-stream".to_string(),
            content_disposition: None,
            redirect_to: None,
            delay_ms_per_chunk: 0,
        },
    );

    // 8b. Extensionless video/x-matroska MIME without Content-Disposition -> Video/
    routes.insert(
        "/raw_matroska_stream".to_string(),
        MockEntry {
            data: payload_mime_video.clone(),
            content_type: "video/x-matroska".to_string(),
            content_disposition: None,
            redirect_to: None,
            delay_ms_per_chunk: 0,
        },
    );

    // 9. Malicious Content-Disposition path traversal & NUL injection
    routes.insert(
        "/traversal_cd".to_string(),
        MockEntry {
            data: payload_evil.clone(),
            content_type: "video/x-matroska".to_string(),
            content_disposition: Some(
                "attachment; filename=\"..\\..\\outside\\Traversal_Movie.mkv\"".to_string(),
            ),
            redirect_to: None,
            delay_ms_per_chunk: 0,
        },
    );
    routes.insert(
        "/nul_cd.mkv".to_string(),
        MockEntry {
            data: payload_evil.clone(),
            content_type: "video/x-matroska".to_string(),
            content_disposition: Some("attachment; filename*=UTF-8''evil%00payload.exe".to_string()),
            redirect_to: None,
            delay_ms_per_chunk: 0,
        },
    );

    // Normal category regression URLs
    routes.insert(
        "/media/sample.mp4".to_string(),
        MockEntry {
            data: payload_mp4.clone(),
            content_type: "video/mp4".to_string(),
            content_disposition: None,
            redirect_to: None,
            delay_ms_per_chunk: 0,
        },
    );
    routes.insert(
        "/audio/track.mp3".to_string(),
        MockEntry {
            data: payload_mp3.clone(),
            content_type: "audio/mpeg".to_string(),
            content_disposition: None,
            redirect_to: None,
            delay_ms_per_chunk: 0,
        },
    );
    routes.insert(
        "/archive/bundle.zip".to_string(),
        MockEntry {
            data: payload_zip.clone(),
            content_type: "application/zip".to_string(),
            content_disposition: None,
            redirect_to: None,
            delay_ms_per_chunk: 0,
        },
    );
    routes.insert(
        "/docs/manual.pdf".to_string(),
        MockEntry {
            data: payload_pdf.clone(),
            content_type: "application/pdf".to_string(),
            content_disposition: None,
            redirect_to: None,
            delay_ms_per_chunk: 0,
        },
    );

    let (port, cancel) = start_fixture_server(routes).await;
    let base_url = format!("http://127.0.0.1:{}", port);

    let tmp = tempdir().unwrap();
    let default_dl = tmp.path().join("Downloads");
    let custom_dl = tmp.path().join("CustomMovies");
    let db_path = tmp.path().join("gate27_8_test.sqlite");
    let db = Database::open(&db_path).unwrap();
    let manager = Arc::new(DownloadManager::new(db, EventBus::default()).unwrap());
    manager.set_default_download_dir(Some(default_dl.to_str().unwrap().to_string()));
    manager.set_use_category_by_default(true);

    // Check probe_url metadata on octet-stream + CD
    let probed_cd = probe_url_with_options(
        &reqwest::Client::new(),
        &format!("{}/octet_mkv_blob", base_url),
        None,
        None,
    )
    .await
    .unwrap();
    assert_eq!(probed_cd.filename, "Octet_Wrapped_Movie.mkv");
    assert_eq!(
        probed_cd.content_type.as_deref(),
        Some("application/octet-stream")
    );

    // Test cases routed into default Downloads/<Category>
    let cases: Vec<(&str, Option<&str>, Option<&str>, &str, &str, &[u8])> = vec![
        // (path, explicit_dest, suggested_filename, expected_subdir, expected_filename, expected_bytes)
        ("/direct_movie.mkv", None, None, "Video", "direct_movie.mkv", payload_direct.as_slice()),
        ("/cd_blob", None, Some("cd_blob"), "Video", "Example_Movie.mkv", payload_cd.as_slice()),
        ("/redir_entry", None, Some("redir_entry"), "Video", "Signed_Cut_4K.mkv", payload_redir.as_slice()),
        ("/unicode_cd", None, None, "Video", "Test Film 大型 映画 (2026).mkv", payload_unicode.as_slice()),
        ("/octet_mkv_blob", None, None, "Video", "Octet_Wrapped_Movie.mkv", payload_octet_mkv.as_slice()),
        ("/rfc5987_priority", None, Some("rfc5987_priority"), "Video", "Priority_Film_1080p.mkv", payload_rfc5987.as_slice()),
        ("/unknown_blob", None, None, "Other", "unknown_blob", payload_unknown.as_slice()),
        ("/raw_matroska_stream", None, None, "Video", "raw_matroska_stream", payload_mime_video.as_slice()),
        ("/traversal_cd", None, None, "Video", "Traversal_Movie.mkv", payload_evil.as_slice()),
        // NUL header rejected safely -> falls back to safe URL name nul_cd.mkv -> Video/
        ("/nul_cd.mkv", None, None, "Video", "nul_cd.mkv", payload_evil.as_slice()),
        // Regression checks
        ("/media/sample.mp4", None, None, "Video", "sample.mp4", payload_mp4.as_slice()),
        ("/audio/track.mp3", None, None, "Music", "track.mp3", payload_mp3.as_slice()),
        ("/archive/bundle.zip", None, None, "Compressed", "bundle.zip", payload_zip.as_slice()),
        ("/docs/manual.pdf", None, None, "Documents", "manual.pdf", payload_pdf.as_slice()),
    ];

    for (path, explicit_dest, suggested, expected_sub, expected_name, expected_bytes) in cases {
        let url = format!("{}{}", base_url, path);
        let (job, already) = manager
            .create_or_coalesce_download_to_destination(
                &url,
                explicit_dest,
                Priority::Normal,
                None,
                None,
                None,
                None,
                suggested,
            )
            .await
            .unwrap_or_else(|e| panic!("create failed for {}: {}", path, e));
        assert!(!already);
        assert_eq!(job.filename, expected_name, "filename mismatch for {}", path);

        let expected_dir = default_dl.join(expected_sub);
        let target_parent = Path::new(&job.target_path).parent().unwrap();
        assert_eq!(
            target_parent,
            expected_dir.as_path(),
            "folder mismatch for {} (target_path={})",
            path,
            job.target_path
        );
        assert_eq!(
            Path::new(&job.temp_path).parent().unwrap(),
            expected_dir.as_path(),
            "temp_path folder mismatch for {}",
            path
        );

        manager.start_download(&job.id).unwrap();
        let done = wait_for_completion(&manager, &job.id, 10).await;
        let disk_bytes = std::fs::read(&done.target_path).unwrap();
        assert_eq!(disk_bytes.len(), expected_bytes.len(), "byte size mismatch for {}", path);
        assert_eq!(
            sha256_hex(&disk_bytes),
            sha256_hex(expected_bytes),
            "sha256 mismatch for {}",
            path
        );
    }

    // Explicit custom destination folder override must NOT append Video/
    let (custom_job, _) = manager
        .create_or_coalesce_download_to_destination(
            &format!("{}/cd_blob?custom=1", base_url),
            Some(custom_dl.to_str().unwrap()),
            Priority::Normal,
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();
    assert_eq!(custom_job.filename, "Example_Movie.mkv");
    assert_eq!(
        Path::new(&custom_job.target_path).parent().unwrap(),
        custom_dl.as_path()
    );
    manager.start_download(&custom_job.id).unwrap();
    let custom_done = wait_for_completion(&manager, &custom_job.id, 10).await;
    assert_eq!(std::fs::read(&custom_done.target_path).unwrap(), *payload_cd);

    // Malicious explicit destination path traversal must be rejected before creating files
    let bad_dest_res = manager
        .create_download_to_destination(
            &format!("{}/cd_blob?bad_dest=1", base_url),
            Some("..\\..\\Windows\\System32"),
            Priority::Normal,
            None,
            None,
            None,
        )
        .await;
    assert!(
        bad_dest_res.is_err(),
        "Directory traversal in explicit destination must return Err"
    );

    cancel.cancel();
}

#[tokio::test]
async fn test_gate27_8_pause_resume_preserves_resolved_mkv_video_folder() {
    let payload_large = Arc::new(deterministic_payload(8 * 1024 * 1024, 0x5A)); // 8 MiB
    let mut routes = HashMap::new();
    routes.insert(
        "/pause_cd_blob".to_string(),
        MockEntry {
            data: payload_large.clone(),
            content_type: "application/octet-stream".to_string(),
            content_disposition: Some(
                "attachment; filename=\"Pause_Resume_Test_Movie.mkv\"".to_string(),
            ),
            redirect_to: None,
            delay_ms_per_chunk: 80,
        },
    );

    let (port, cancel) = start_fixture_server(routes).await;
    let tmp = tempdir().unwrap();
    let default_dl = tmp.path().join("Downloads");
    let db = Database::open(tmp.path().join("pause_resume.sqlite")).unwrap();
    let manager = Arc::new(DownloadManager::new(db, EventBus::default()).unwrap());
    manager.set_default_download_dir(Some(default_dl.to_str().unwrap().to_string()));
    manager.set_use_category_by_default(true);

    let mut rx = manager.event_bus().subscribe();

    let job = manager
        .create_download_to_destination(
            &format!("http://127.0.0.1:{}/pause_cd_blob", port),
            None,
            Priority::Normal,
            None,
            None,
            None,
        )
        .await
        .unwrap();

    let expected_video_dir = default_dl.join("Video");
    assert_eq!(job.filename, "Pause_Resume_Test_Movie.mkv");
    assert_eq!(
        Path::new(&job.target_path).parent().unwrap(),
        expected_video_dir.as_path()
    );
    assert_eq!(
        Path::new(&job.temp_path).parent().unwrap(),
        expected_video_dir.as_path()
    );

    manager.start_download(&job.id).unwrap();

    // Wait for first live progress event and confirm .tdm-part exists inside Video/ before pausing
    let start_wait = tokio::time::Instant::now();
    loop {
        if let Ok(Ok(ev)) = tokio::time::timeout(Duration::from_millis(100), rx.recv()).await {
            if let tdm_core::DownloadEvent::Progress(p) = ev {
                if p.id == job.id && p.downloaded_bytes > 0 && Path::new(&job.temp_path).exists() {
                    break;
                }
            }
        }
        assert!(
            start_wait.elapsed() < Duration::from_secs(10),
            "Timed out waiting for initial partial bytes"
        );
    }

    manager.pause_download(&job.id).unwrap();
    let paused_wait = tokio::time::Instant::now();
    let paused_job = loop {
        let cur = manager.get_download(&job.id).unwrap().unwrap();
        if cur.state == JobState::Paused {
            break cur;
        }
        assert!(
            paused_wait.elapsed() < Duration::from_secs(10),
            "Timed out waiting for Paused state"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    };

    assert!(
        Path::new(&paused_job.temp_path).exists(),
        ".tdm-part must be preserved on pause inside Video/"
    );
    assert_eq!(
        Path::new(&paused_job.target_path).parent().unwrap(),
        expected_video_dir.as_path()
    );

    manager.start_download(&job.id).unwrap();
    let completed = wait_for_completion(&manager, &job.id, 15).await;
    assert_eq!(
        Path::new(&completed.target_path),
        expected_video_dir.join("Pause_Resume_Test_Movie.mkv").as_path()
    );
    assert!(!Path::new(&completed.temp_path).exists());

    let disk_bytes = std::fs::read(&completed.target_path).unwrap();
    assert_eq!(disk_bytes.len(), payload_large.len());
    assert_eq!(sha256_hex(&disk_bytes), sha256_hex(&payload_large));

    cancel.cancel();
}

#[tokio::test]
async fn test_gate27_8_handoff_id_scoped_per_url_across_browsers() {
    std::env::set_var("TORI_ALLOW_LOOPBACK", "1");

    let payload_a = Arc::new(deterministic_payload(256 * 1024, 0x31));
    let payload_b = Arc::new(deterministic_payload(256 * 1024, 0x62));

    let mut routes = HashMap::new();
    routes.insert(
        "/chrome_first.mkv".to_string(),
        MockEntry {
            data: payload_a.clone(),
            content_type: "video/x-matroska".to_string(),
            content_disposition: None,
            redirect_to: None,
            delay_ms_per_chunk: 0,
        },
    );
    routes.insert(
        "/edge_cd_blob".to_string(),
        MockEntry {
            data: payload_b.clone(),
            content_type: "application/octet-stream".to_string(),
            content_disposition: Some("attachment; filename=\"Edge_Second_Movie.mkv\"".to_string()),
            redirect_to: None,
            delay_ms_per_chunk: 0,
        },
    );

    let (port, cancel) = start_fixture_server(routes).await;
    let tmp = tempdir().unwrap();
    let default_dl = tmp.path().join("Downloads");
    let db = Database::open(tmp.path().join("handoff_scope.sqlite")).unwrap();
    let manager = Arc::new(DownloadManager::new(db, EventBus::default()).unwrap());
    manager.set_default_download_dir(Some(default_dl.to_str().unwrap().to_string()));
    manager.set_use_category_by_default(true);

    let url_a = format!("http://127.0.0.1:{}/chrome_first.mkv", port);
    let url_b = format!("http://127.0.0.1:{}/edge_cd_blob", port);

    // 1. Chrome download #1 (`browser_dl_1`) completes
    let (job_a, existed_a) = manager
        .create_or_coalesce_download_to_destination(
            &url_a,
            None,
            Priority::Normal,
            None,
            None,
            None,
            Some("browser_dl_1"),
            Some("chrome_first.mkv"),
        )
        .await
        .unwrap();
    assert!(!existed_a);

    // 2. Fallback/retry with SAME handoff_id AND SAME url must still coalesce
    let (job_a_dup, existed_a_dup) = manager
        .create_or_coalesce_download_to_destination(
            &url_a,
            None,
            Priority::Normal,
            None,
            None,
            None,
            Some("browser_dl_1"),
            Some("chrome_first.mkv"),
        )
        .await
        .unwrap();
    assert!(existed_a_dup);
    assert_eq!(job_a.id, job_a_dup.id);

    // 3. Different browser (`Edge` / `Firefox`) with its own `browser_dl_1` on a DIFFERENT URL
    //    must NOT falsely coalesce onto Chrome's job_a!
    let (job_b, existed_b) = manager
        .create_or_coalesce_download_to_destination(
            &url_b,
            None,
            Priority::Normal,
            None,
            None,
            None,
            Some("browser_dl_1"),
            Some("Edge_Second_Movie.mkv"),
        )
        .await
        .unwrap();
    assert!(!existed_b, "Different URL with same browser_dl_1 must create a distinct job");
    assert_ne!(job_a.id, job_b.id);
    assert_eq!(job_b.filename, "Edge_Second_Movie.mkv");
    assert_eq!(
        Path::new(&job_b.target_path).parent().unwrap(),
        default_dl.join("Video").as_path()
    );

    cancel.cancel();
}
