use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tempfile::tempdir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

use tdm_core::engine::probe::probe_url_with_options;
use tdm_core::{Database, DownloadManager, EventBus, JobType, Priority};

/// Starts an HTTP test server that responds according to the requested path and query parameters.
async fn start_mkv_test_server() -> (u16, CancellationToken, Arc<AtomicUsize>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let cancel = CancellationToken::new();
    let cancel_srv = cancel.clone();
    let request_count = Arc::new(AtomicUsize::new(0));
    let req_counter = request_count.clone();

    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cancel_srv.cancelled() => break,
                res = listener.accept() => {
                    let (mut socket, _) = match res {
                        Ok(s) => s,
                        Err(_) => break,
                    };
                    let counter = req_counter.clone();

                    tokio::spawn(async move {
                        let mut buf = [0u8; 4096];
                        let n = socket.read(&mut buf).await.unwrap_or(0);
                        if n == 0 {
                            return;
                        }
                        counter.fetch_add(1, Ordering::SeqCst);
                        let req = String::from_utf8_lossy(&buf[..n]);
                        let first_line = req.lines().next().unwrap_or("");
                        let parts: Vec<&str> = first_line.split_whitespace().collect();
                        if parts.len() < 2 {
                            return;
                        }
                        let method = parts[0];
                        let full_path = parts[1];

                        // Scenario 1: Redirect /redirect_mkv -> /final_2_9gb.mkv
                        if full_path.starts_with("/redirect_mkv") {
                            let resp = format!(
                                "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:{}/final_2_9gb.mkv\r\nConnection: close\r\n\r\n",
                                socket.local_addr().map(|a| a.port()).unwrap_or(0)
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                            return;
                        }

                        // Scenario 2: Content-Disposition attachment with filename="avatar_remux_1080p.mkv"
                        if full_path.starts_with("/stream_with_disposition") {
                            let size: u64 = 3_113_851_289; // 2.9 GB
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: video/x-matroska\r\nContent-Disposition: attachment; filename=\"avatar_remux_1080p.mkv\"\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\r\n",
                                size
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                            return;
                        }

                        // Scenario 3: 2.9 GB simulated MKV (3,113,851,289 bytes)
                        if full_path.starts_with("/final_2_9gb.mkv") || full_path.starts_with("/movie_2_9gb.mkv") {
                            let size: u64 = 3_113_851_289;
                            if method == "HEAD" {
                                let resp = format!(
                                    "HTTP/1.1 200 OK\r\nContent-Type: video/x-matroska\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nETag: \"mkv-2.9gb-etag\"\r\nConnection: close\r\n\r\n",
                                    size
                                );
                                let _ = socket.write_all(resp.as_bytes()).await;
                                return;
                            }
                            if req.lines().any(|l| l.to_ascii_lowercase().starts_with("range:")) {
                                let resp = format!(
                                    "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-0/{}\r\nContent-Length: 1\r\nConnection: close\r\n\r\nA",
                                    size
                                );
                                let _ = socket.write_all(resp.as_bytes()).await;
                                return;
                            }
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: video/x-matroska\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\r\n",
                                size
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                            return;
                        }

                        // Scenario 4: 5 GB MKV (5,368,709,120 bytes) - 64-bit verification
                        if full_path.starts_with("/large_5gb.mkv") {
                            let size: u64 = 5_368_709_120;
                            if req.lines().any(|l| l.to_ascii_lowercase().starts_with("range:")) {
                                let resp = format!(
                                    "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-0/{}\r\nContent-Length: 1\r\nConnection: close\r\n\r\nA",
                                    size
                                );
                                let _ = socket.write_all(resp.as_bytes()).await;
                                return;
                            }
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: video/x-matroska\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\r\n",
                                size
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                            return;
                        }

                        // Scenario 5: URL with query parameters and token
                        if full_path.starts_with("/api/v2/download.mkv") {
                            let size: u64 = 104_857_600; // 100 MB
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\r\n",
                                size
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                            return;
                        }

                        // Scenario 6: Raw blob without disposition or extension in URL
                        if full_path.starts_with("/raw_blob_data") {
                            let size: u64 = 1_073_741_824; // 1 GB
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\r\n",
                                size
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                            return;
                        }

                        // Scenario 7: Chunked Matroska stream (No Content-Length)
                        if full_path.starts_with("/chunked_stream.mkv") {
                            let resp = "HTTP/1.1 200 OK\r\nContent-Type: video/x-matroska\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n5\r\nHELLO\r\n0\r\n\r\n";
                            let _ = socket.write_all(resp.as_bytes()).await;
                            return;
                        }

                        // Scenario 8: Server without Accept-Ranges (HTTP 200 only)
                        if full_path.starts_with("/no_range.mkv") {
                            let size: u64 = 52_428_800; // 50 MB
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: video/x-matroska\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                size
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                            return;
                        }

                        // Scenario 9: Unicode and spaces in URL path
                        if full_path.contains("大型") || full_path.contains("%E5%A4%A7%E5%9E%8B") {
                            let size: u64 = 3_113_851_289;
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: video/x-matroska\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\r\n",
                                size
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                            return;
                        }

                        // Fallback 404
                        let _ = socket.write_all(b"HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n").await;
                    });
                }
            }
        }
    });

    (port, cancel, request_count)
}

#[tokio::test]
async fn test_gate27_5_probe_2_9gb_mkv_and_chunk_planning() {
    let (port, cancel, _) = start_mkv_test_server().await;
    let url = format!("http://127.0.0.1:{}/movie_2_9gb.mkv", port);

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();

    let probe = probe_url_with_options(&client, &url, None, None)
        .await
        .expect("Probe of 2.9GB MKV should succeed");

    assert_eq!(probe.filename, "movie_2_9gb.mkv");
    assert_eq!(probe.total_bytes, Some(3_113_851_289));
    assert!(probe.supports_ranges);

    // Plan chunks across 8 connections for 2.9 GB file
    let chunks = tdm_core::engine::planner::plan_chunks_with_concurrency("test-job", probe.total_bytes, probe.supports_ranges, 8);
    assert_eq!(chunks.len(), 8);
    assert_eq!(chunks[0].start_byte, 0);
    assert_eq!(chunks[7].end_byte, 3_113_851_288);

    // Verify contiguous chunk coverage
    for i in 0..chunks.len() - 1 {
        assert_eq!(chunks[i].end_byte + 1, chunks[i + 1].start_byte);
    }

    cancel.cancel();
}

#[tokio::test]
async fn test_gate27_5_probe_5gb_mkv_64bit_bounds() {
    let (port, cancel, _) = start_mkv_test_server().await;
    let url = format!("http://127.0.0.1:{}/large_5gb.mkv", port);

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();

    let probe = probe_url_with_options(&client, &url, None, None)
        .await
        .expect("Probe of 5GB MKV should succeed");

    assert_eq!(probe.filename, "large_5gb.mkv");
    assert_eq!(probe.total_bytes, Some(5_368_709_120));
    assert!(probe.supports_ranges);

    cancel.cancel();
}

#[tokio::test]
async fn test_gate27_5_probe_redirect_to_mkv() {
    let (port, cancel, _) = start_mkv_test_server().await;
    let url = format!("http://127.0.0.1:{}/redirect_mkv", port);

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();

    let probe = probe_url_with_options(&client, &url, None, None)
        .await
        .expect("Probe should follow 302 redirect to MKV");

    assert_eq!(probe.filename, "final_2_9gb.mkv");
    assert_eq!(probe.total_bytes, Some(3_113_851_289));
    assert!(probe.supports_ranges);

    cancel.cancel();
}

#[tokio::test]
async fn test_gate27_5_probe_content_disposition_mkv() {
    let (port, cancel, _) = start_mkv_test_server().await;
    let url = format!("http://127.0.0.1:{}/stream_with_disposition", port);

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();

    let probe = probe_url_with_options(&client, &url, None, None)
        .await
        .expect("Probe should extract filename from Content-Disposition");

    assert_eq!(probe.filename, "avatar_remux_1080p.mkv");
    assert!(probe.has_filename_from_header);
    assert_eq!(probe.total_bytes, Some(3_113_851_289));

    cancel.cancel();
}

#[tokio::test]
async fn test_gate27_5_probe_signed_query_param_url() {
    let (port, cancel, _) = start_mkv_test_server().await;
    let url = format!("http://127.0.0.1:{}/api/v2/download.mkv?token=abc123xyz&expires=1794500000", port);

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();

    let probe = probe_url_with_options(&client, &url, None, None)
        .await
        .expect("Probe should strip query params from filename");

    assert_eq!(probe.filename, "download.mkv");
    assert_eq!(probe.total_bytes, Some(104_857_600));

    cancel.cancel();
}

#[tokio::test]
async fn test_gate27_5_probe_unicode_and_spaces_mkv() {
    let (port, cancel, _) = start_mkv_test_server().await;
    let url = format!("http://127.0.0.1:{}/%E5%A4%A7%E5%9E%8B%20Video%202.9GB.mkv", port);

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();

    let probe = probe_url_with_options(&client, &url, None, None)
        .await
        .expect("Probe of Unicode MKV should succeed");

    assert!(probe.filename.contains(".mkv"));
    assert_eq!(probe.total_bytes, Some(3_113_851_289));

    cancel.cancel();
}

#[tokio::test]
async fn test_gate27_5_chunked_streaming_mkv_no_content_length() {
    let (port, cancel, _) = start_mkv_test_server().await;
    let url = format!("http://127.0.0.1:{}/chunked_stream.mkv", port);

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();

    let probe = probe_url_with_options(&client, &url, None, None)
        .await
        .expect("Probe of chunked MKV should succeed");

    assert_eq!(probe.filename, "chunked_stream.mkv");
    assert_eq!(probe.total_bytes, None);

    // Planner handles indeterminate length
    let chunks = tdm_core::engine::planner::plan_chunks_with_concurrency("test-chunked", None, probe.supports_ranges, 8);
    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0].start_byte, 0);
    assert_eq!(chunks[0].end_byte, 0);

    cancel.cancel();
}

#[tokio::test]
async fn test_gate27_5_server_without_range_support() {
    let (port, cancel, _) = start_mkv_test_server().await;
    let url = format!("http://127.0.0.1:{}/no_range.mkv", port);

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();

    let probe = probe_url_with_options(&client, &url, None, None)
        .await
        .expect("Probe of non-range server should succeed");

    assert_eq!(probe.filename, "no_range.mkv");
    assert_eq!(probe.total_bytes, Some(52_428_800));
    assert!(!probe.supports_ranges);

    // Planner yields 1 chunk for non-range server
    let chunks = tdm_core::engine::planner::plan_chunks_with_concurrency("test-no-range", probe.total_bytes, false, 8);
    assert_eq!(chunks.len(), 1);

    cancel.cancel();
}

#[tokio::test]
async fn test_gate27_5_manager_suggested_filename_and_category_classification() {
    let (port, cancel, _) = start_mkv_test_server().await;
    let temp_dir = tempdir().unwrap();
    let db_path = temp_dir.path().join("test_mkv.db");
    let db = Database::open(&db_path).unwrap();
    let manager = Arc::new(DownloadManager::new(db, EventBus::default()).unwrap());

    // Enable categorization
    manager.set_use_category_by_default(true);

    // 1. URL without extension, browser supplies suggested_filename "my_movie_2.9gb.mkv"
    let raw_url = format!("http://127.0.0.1:{}/raw_blob_data", port);
    let dest_dir = manager.resolve_destination_folder("my_movie_2.9gb.mkv", None);
    assert!(dest_dir.to_string_lossy().ends_with("Video"), "MKV destination must be classified into Video folder");

    let (job, already_existed) = manager
        .create_or_coalesce_download_with_filename(
            &raw_url,
            &dest_dir,
            Priority::Normal,
            None,
            None,
            None,
            Some("browser_dl_99991"),
            Some("my_movie_2.9gb.mkv"),
        )
        .await
        .expect("Download creation with suggested filename should succeed");

    assert!(!already_existed);
    assert_eq!(job.filename, "my_movie_2.9gb.mkv");
    assert_eq!(job.total_bytes, Some(1_073_741_824));
    assert_eq!(job.job_type, JobType::HttpFile);

    // 2. Coalescing: Second call with same handoff_id returns existing job immediately
    let (job2, already_existed2) = manager
        .create_or_coalesce_download_with_filename(
            &raw_url,
            &dest_dir,
            Priority::Normal,
            None,
            None,
            None,
            Some("browser_dl_99991"),
            Some("my_movie_2.9gb.mkv"),
        )
        .await
        .expect("Coalesced handoff should return existing job");

    assert!(already_existed2);
    assert_eq!(job.id, job2.id);

    // 3. Authoritative server Content-Disposition overrides suggested filename
    let disp_url = format!("http://127.0.0.1:{}/stream_with_disposition", port);
    let (job_disp, _) = manager
        .create_or_coalesce_download_with_filename(
            &disp_url,
            &dest_dir,
            Priority::Normal,
            None,
            None,
            None,
            Some("browser_dl_99992"),
            Some("weak_suggestion.bin"),
        )
        .await
        .expect("Creation with authoritative Content-Disposition should succeed");

    assert_eq!(job_disp.filename, "avatar_remux_1080p.mkv");
    assert_eq!(job_disp.total_bytes, Some(3_113_851_289));

    cancel.cancel();
}
