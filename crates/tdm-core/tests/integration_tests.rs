use std::fs;
use std::io::Read;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use sha2::{Digest, Sha256};
use tempfile::tempdir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

use tdm_core::{Database, DownloadManager, EventBus, JobState};

/// Helper to compute SHA-256 of a file
fn compute_file_sha256(path: &std::path::Path) -> String {
    let mut file = fs::File::open(path).expect("Failed to open file for sha256");
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 8192];
    loop {
        let n = file.read(&mut buf).unwrap();
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    hex::encode(hasher.finalize())
}

/// Helper to wait for a job to reach a terminal state or timeout
async fn wait_for_job_terminal(
    manager: &DownloadManager,
    job_id: &str,
    timeout: Duration,
) -> Result<JobState, String> {
    let start = std::time::Instant::now();
    loop {
        if start.elapsed() > timeout {
            return Err("Timed out waiting for terminal state".to_string());
        }
        if let Ok(Some(job)) = manager.get_download(job_id) {
            if job.state.is_terminal() {
                return Ok(job.state);
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

// =========================================================================
// TEST 1: Standard Multi-Part Range Download (HTTP 206) with SHA-256 Match
// =========================================================================
#[tokio::test]
async fn test_multipart_range_download_success() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();

    // 4MB test payload
    let test_data: Vec<u8> = (0..4 * 1024 * 1024).map(|i| (i % 251) as u8).collect();
    let expected_hash = {
        let mut hasher = Sha256::new();
        hasher.update(&test_data);
        hex::encode(hasher.finalize())
    };

    let shared_data = Arc::new(test_data);
    let cancel = CancellationToken::new();
    let cancel_server = cancel.clone();

    // Mock HTTP server supporting HEAD, GET (Range and full)
    let data_clone = shared_data.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cancel_server.cancelled() => break,
                res = listener.accept() => {
                    let (mut socket, _) = match res {
                        Ok(s) => s,
                        Err(_) => break,
                    };
                    let data = data_clone.clone();

                    tokio::spawn(async move {
                        let mut buf = vec![0u8; 4096];
                        let n = socket.read(&mut buf).await.unwrap_or(0);
                        let req_str = String::from_utf8_lossy(&buf[..n]);

                        let is_head = req_str.starts_with("HEAD");
                        let range_header = req_str.lines().find(|l| l.to_lowercase().starts_with("range:"));

                        let total_len = data.len();
                        if is_head {
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nETag: \"etag-test-1\"\r\nConnection: close\r\n\r\n",
                                total_len
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                        } else if let Some(r) = range_header {
                            // Parse "Range: bytes=start-end"
                            let range_val = r.split(':').nth(1).unwrap().trim();
                            if let Some(bytes_spec) = range_val.strip_prefix("bytes=") {
                                let parts: Vec<&str> = bytes_spec.split('-').collect();
                                let start: usize = parts[0].parse().unwrap_or(0);
                                let end: usize = if parts.len() > 1 && !parts[1].is_empty() {
                                    parts[1].parse().unwrap_or(total_len - 1)
                                } else {
                                    total_len - 1
                                };

                                let slice = &data[start..=end.min(total_len - 1)];
                                let resp = format!(
                                    "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {}-{}/{}\r\nContent-Length: {}\r\nETag: \"etag-test-1\"\r\nConnection: close\r\n\r\n",
                                    start, end, total_len, slice.len()
                                );
                                let _ = socket.write_all(resp.as_bytes()).await;
                                let _ = socket.write_all(slice).await;
                            }
                        } else {
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nETag: \"etag-test-1\"\r\nConnection: close\r\n\r\n",
                                total_len
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                            let _ = socket.write_all(&data).await;
                        }
                    });
                }
            }
        }
    });

    let temp_dir = tempdir().unwrap();
    let db_path = temp_dir.path().join("tdm.sqlite");
    let db = Database::open(&db_path).unwrap();
    let event_bus = EventBus::default();
    let manager = DownloadManager::new(db, event_bus).unwrap();

    let url = format!("http://127.0.0.1:{}/largefile.bin", port);
    let job = manager
        .create_download(&url, temp_dir.path())
        .await
        .unwrap();

    assert!(job.is_resumable);
    assert_eq!(job.total_bytes, Some(4 * 1024 * 1024));
    assert!(job.chunk_count >= 2);

    manager.start_download(&job.id).unwrap();

    let state = wait_for_job_terminal(&manager, &job.id, Duration::from_secs(10))
        .await
        .unwrap();
    let job_info = manager.get_download(&job.id).unwrap().unwrap();
    println!(
        "test_etag_change_triggers_restart ERROR: {:?}",
        job_info.error_message
    );
    assert_eq!(state, JobState::Completed);

    let final_path = std::path::Path::new(&job.target_path);
    assert!(final_path.exists());
    let hash = compute_file_sha256(final_path);
    assert_eq!(hash, expected_hash);

    cancel.cancel();
}

// =========================================================================
// TEST 2: HTTP 200 Single-Stream Fallback (Server ignores Range)
// =========================================================================
#[tokio::test]
async fn test_http_200_stream_fallback() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();

    let test_data: Vec<u8> = (0..500_000).map(|i| (i % 127) as u8).collect();
    let expected_hash = {
        let mut hasher = Sha256::new();
        hasher.update(&test_data);
        hex::encode(hasher.finalize())
    };

    let shared_data = Arc::new(test_data);
    let cancel = CancellationToken::new();
    let cancel_server = cancel.clone();

    // Server always replies with 200 OK, never 206
    let data_clone = shared_data.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cancel_server.cancelled() => break,
                res = listener.accept() => {
                    let (mut socket, _) = match res {
                        Ok(s) => s,
                        Err(_) => break,
                    };
                    let data = data_clone.clone();

                    tokio::spawn(async move {
                        let mut buf = vec![0u8; 2048];
                        let _ = socket.read(&mut buf).await;
                        let resp = format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            data.len()
                        );
                        let _ = socket.write_all(resp.as_bytes()).await;
                        let _ = socket.write_all(&data).await;
                    });
                }
            }
        }
    });

    let temp_dir = tempdir().unwrap();
    let db = Database::open(temp_dir.path().join("tdm.sqlite")).unwrap();
    let manager = DownloadManager::new(db, EventBus::default()).unwrap();

    let url = format!("http://127.0.0.1:{}/streamfile.bin", port);
    let job = manager
        .create_download(&url, temp_dir.path())
        .await
        .unwrap();

    assert!(!job.is_resumable);
    assert_eq!(job.chunk_count, 1);

    manager.start_download(&job.id).unwrap();

    let state = wait_for_job_terminal(&manager, &job.id, Duration::from_secs(10))
        .await
        .unwrap();
    let job_info = manager.get_download(&job.id).unwrap().unwrap();
    println!(
        "test_etag_change_triggers_restart ERROR: {:?}",
        job_info.error_message
    );
    assert_eq!(state, JobState::Completed);

    let final_path = std::path::Path::new(&job.target_path);
    assert!(final_path.exists());
    assert_eq!(compute_file_sha256(final_path), expected_hash);

    cancel.cancel();
}

// =========================================================================
// TEST 3: Unknown Content-Length Streaming
// =========================================================================
#[tokio::test]
async fn test_unknown_content_length_streaming() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();

    let test_data: Vec<u8> = vec![42u8; 150_000];
    let expected_hash = {
        let mut hasher = Sha256::new();
        hasher.update(&test_data);
        hex::encode(hasher.finalize())
    };

    let shared_data = Arc::new(test_data);
    let cancel = CancellationToken::new();
    let cancel_server = cancel.clone();

    // Server returns 200 OK without Content-Length
    let data_clone = shared_data.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cancel_server.cancelled() => break,
                res = listener.accept() => {
                    let (mut socket, _) = match res {
                        Ok(s) => s,
                        Err(_) => break,
                    };
                    let data = data_clone.clone();

                    tokio::spawn(async move {
                        let mut buf = vec![0u8; 2048];
                        let _ = socket.read(&mut buf).await;
                        let resp = "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n";
                        let _ = socket.write_all(resp.as_bytes()).await;
                        let _ = socket.write_all(&data).await;
                    });
                }
            }
        }
    });

    let temp_dir = tempdir().unwrap();
    let db = Database::open(temp_dir.path().join("tdm.sqlite")).unwrap();
    let manager = DownloadManager::new(db, EventBus::default()).unwrap();

    let url = format!("http://127.0.0.1:{}/chunked.bin", port);
    let job = manager
        .create_download(&url, temp_dir.path())
        .await
        .unwrap();

    assert_eq!(job.total_bytes, None);
    assert_eq!(job.chunk_count, 1);

    manager.start_download(&job.id).unwrap();

    let state = wait_for_job_terminal(&manager, &job.id, Duration::from_secs(10))
        .await
        .unwrap();
    let job_info = manager.get_download(&job.id).unwrap().unwrap();
    println!(
        "test_etag_change_triggers_restart ERROR: {:?}",
        job_info.error_message
    );
    assert_eq!(state, JobState::Completed);

    let final_path = std::path::Path::new(&job.target_path);
    assert!(final_path.exists());
    assert_eq!(compute_file_sha256(final_path), expected_hash);

    cancel.cancel();
}

// =========================================================================
// TEST 4: HEAD Unsupported (501 / 405) Fallback to GET
// =========================================================================
#[tokio::test]
async fn test_head_unsupported_fallback() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();

    let test_data = b"HEAD-is-unsupported-but-GET-works-perfectly!";
    let shared_data = Arc::new(test_data.to_vec());
    let cancel = CancellationToken::new();
    let cancel_server = cancel.clone();

    let data_clone = shared_data.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cancel_server.cancelled() => break,
                res = listener.accept() => {
                    let (mut socket, _) = match res {
                        Ok(s) => s,
                        Err(_) => break,
                    };
                    let data = data_clone.clone();

                    tokio::spawn(async move {
                        let mut buf = vec![0u8; 2048];
                        let n = socket.read(&mut buf).await.unwrap_or(0);
                        let req = String::from_utf8_lossy(&buf[..n]);

                        if req.starts_with("HEAD") {
                            // Reject HEAD with 405 Method Not Allowed
                            let resp = "HTTP/1.1 405 Method Not Allowed\r\nAllow: GET\r\nConnection: close\r\n\r\n";
                            let _ = socket.write_all(resp.as_bytes()).await;
                        } else {
                            // Support GET range
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                data.len()
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                            let _ = socket.write_all(&data).await;
                        }
                    });
                }
            }
        }
    });

    let temp_dir = tempdir().unwrap();
    let db = Database::open(temp_dir.path().join("tdm.sqlite")).unwrap();
    let manager = DownloadManager::new(db, EventBus::default()).unwrap();

    let url = format!("http://127.0.0.1:{}/nohead.txt", port);
    let job = manager
        .create_download(&url, temp_dir.path())
        .await
        .unwrap();

    manager.start_download(&job.id).unwrap();

    let state = wait_for_job_terminal(&manager, &job.id, Duration::from_secs(10))
        .await
        .unwrap();
    let job_info = manager.get_download(&job.id).unwrap().unwrap();
    println!(
        "test_etag_change_triggers_restart ERROR: {:?}",
        job_info.error_message
    );
    assert_eq!(state, JobState::Completed);

    let content = fs::read(job.target_path).unwrap();
    assert_eq!(content, test_data);

    cancel.cancel();
}

// =========================================================================
// TEST 5: Mismatched Content-Range Detection & Handling
// =========================================================================
#[tokio::test]
async fn test_mismatched_content_range_failure() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();

    let cancel = CancellationToken::new();
    let cancel_server = cancel.clone();

    // Server returns incorrect Content-Range header
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cancel_server.cancelled() => break,
                res = listener.accept() => {
                    let (mut socket, _) = match res {
                        Ok(s) => s,
                        Err(_) => break,
                    };

                    tokio::spawn(async move {
                        let mut buf = vec![0u8; 2048];
                        let _ = socket.read(&mut buf).await;
                        // Purposefully send bogus Content-Range offset 999999 when probe asks for 0-0
                        let resp = "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 999999-999999/1000000\r\nContent-Length: 1\r\nConnection: close\r\n\r\nX";
                        let _ = socket.write_all(resp.as_bytes()).await;
                    });
                }
            }
        }
    });

    let temp_dir = tempdir().unwrap();
    let db = Database::open(temp_dir.path().join("tdm.sqlite")).unwrap();
    let manager = DownloadManager::new(db, EventBus::default()).unwrap();

    let url = format!("http://127.0.0.1:{}/corrupt_range.bin", port);
    let job = manager
        .create_download(&url, temp_dir.path())
        .await
        .unwrap();

    // The probe detects Content-Range mismatch or start_download detects it
    let _ = manager.start_download(&job.id);
    let state = wait_for_job_terminal(&manager, &job.id, Duration::from_secs(5))
        .await
        .unwrap();
    assert_eq!(state, JobState::Failed);

    cancel.cancel();
}

// =========================================================================
// TEST 6: Pause and Resume with Byte Continuity Check
// =========================================================================
#[tokio::test]
async fn test_pause_and_resume_continuity() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();

    let test_data: Vec<u8> = (0..3 * 1024 * 1024).map(|i| (i % 233) as u8).collect();
    let expected_hash = {
        let mut hasher = Sha256::new();
        hasher.update(&test_data);
        hex::encode(hasher.finalize())
    };

    let shared_data = Arc::new(test_data);
    let cancel = CancellationToken::new();
    let cancel_server = cancel.clone();

    // Throttled server to allow pausing midway
    let data_clone = shared_data.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cancel_server.cancelled() => break,
                res = listener.accept() => {
                    let (mut socket, _) = match res {
                        Ok(s) => s,
                        Err(_) => break,
                    };
                    let data = data_clone.clone();

                    tokio::spawn(async move {
                        let mut buf = vec![0u8; 4096];
                        let n = socket.read(&mut buf).await.unwrap_or(0);
                        let req = String::from_utf8_lossy(&buf[..n]);

                        let is_head = req.starts_with("HEAD");
                        let range_header = req.lines().find(|l| l.to_lowercase().starts_with("range:"));
                        let total_len = data.len();

                        if is_head {
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nETag: \"etag-pause\"\r\nConnection: close\r\n\r\n",
                                total_len
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                        } else if let Some(r) = range_header {
                            let range_val = r.split(':').nth(1).unwrap().trim();
                            if let Some(bytes_spec) = range_val.strip_prefix("bytes=") {
                                let parts: Vec<&str> = bytes_spec.split('-').collect();
                                let start: usize = parts[0].parse().unwrap_or(0);
                                let end: usize = parts[1].parse().unwrap_or(total_len - 1);
                                let slice = &data[start..=end.min(total_len - 1)];

                                let resp = format!(
                                    "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {}-{}/{}\r\nContent-Length: {}\r\nETag: \"etag-pause\"\r\nConnection: close\r\n\r\n",
                                    start, end, total_len, slice.len()
                                );
                                let _ = socket.write_all(resp.as_bytes()).await;

                                // Send in slow chunks to allow pause
                                for chunk in slice.chunks(64 * 1024) {
                                    if socket.write_all(chunk).await.is_err() {
                                        break;
                                    }
                                    tokio::time::sleep(Duration::from_millis(15)).await;
                                }
                            }
                        }
                    });
                }
            }
        }
    });

    let temp_dir = tempdir().unwrap();
    let db = Database::open(temp_dir.path().join("tdm.sqlite")).unwrap();
    let manager = DownloadManager::new(db, EventBus::default()).unwrap();

    let url = format!("http://127.0.0.1:{}/pauseable.bin", port);
    let job = manager
        .create_download(&url, temp_dir.path())
        .await
        .unwrap();

    manager.start_download(&job.id).unwrap();

    // Wait until some bytes are downloaded
    tokio::time::sleep(Duration::from_millis(150)).await;

    // Pause download
    manager.pause_download(&job.id).unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;

    let paused_job = manager.get_download(&job.id).unwrap().unwrap();
    assert_eq!(paused_job.state, JobState::Paused);

    // Resume download
    manager.resume_download(&job.id).unwrap();

    let state = wait_for_job_terminal(&manager, &job.id, Duration::from_secs(15))
        .await
        .unwrap();
    assert_eq!(state, JobState::Completed);

    let final_path = std::path::Path::new(&job.target_path);
    assert_eq!(compute_file_sha256(final_path), expected_hash);

    cancel.cancel();
}

// =========================================================================
// TEST 7: ETag Change During Resume (Triggers Clean Restart)
// =========================================================================
#[tokio::test]
async fn test_etag_change_triggers_restart() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();

    let data_v1 = vec![1u8; 1024 * 1024];
    let data_v2 = vec![2u8; 1024 * 1024]; // Modified file!
    let expected_hash_v2 = {
        let mut hasher = Sha256::new();
        hasher.update(&data_v2);
        hex::encode(hasher.finalize())
    };

    let shared_v1 = Arc::new(data_v1);
    let shared_v2 = Arc::new(data_v2);
    let server_version = Arc::new(AtomicUsize::new(1));

    let cancel = CancellationToken::new();
    let cancel_server = cancel.clone();

    let v1 = shared_v1.clone();
    let v2 = shared_v2.clone();
    let ver = server_version.clone();

    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cancel_server.cancelled() => break,
                res = listener.accept() => {
                    let (mut socket, _) = match res {
                        Ok(s) => s,
                        Err(_) => break,
                    };
                    let cur_ver = ver.load(Ordering::SeqCst);
                    let data = if cur_ver == 1 { v1.clone() } else { v2.clone() };
                    let etag = if cur_ver == 1 { "\"v1\"" } else { "\"v2\"" };

                    tokio::spawn(async move {
                        let mut buf = vec![0u8; 4096];
                        let n = socket.read(&mut buf).await.unwrap_or(0);
                        let req = String::from_utf8_lossy(&buf[..n]);

                        let is_head = req.starts_with("HEAD");
                        let range_header = req.lines().find(|l| l.to_lowercase().starts_with("range:"));
                        let total_len = data.len();

                        if is_head {
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nETag: {}\r\nConnection: close\r\n\r\n",
                                total_len, etag
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                        } else if let Some(r) = range_header {
                            let range_val = r.split(':').nth(1).unwrap().trim();
                            if let Some(bytes_spec) = range_val.strip_prefix("bytes=") {
                                let parts: Vec<&str> = bytes_spec.split('-').collect();
                                let start: usize = parts[0].parse().unwrap_or(0);
                                let end: usize = parts[1].parse().unwrap_or(total_len - 1);
                                let slice = &data[start..=end.min(total_len - 1)];

                                let resp = format!(
                                    "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {}-{}/{}\r\nContent-Length: {}\r\nETag: {}\r\nConnection: close\r\n\r\n",
                                    start, end, total_len, slice.len(), etag
                                );
                                let _ = socket.write_all(resp.as_bytes()).await;
                                let _ = socket.write_all(slice).await;
                            }
                        } else {
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nETag: {}\r\nConnection: close\r\n\r\n",
                                total_len, etag
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                            let _ = socket.write_all(&data).await;
                        }
                    });
                }
            }
        }
    });

    let temp_dir = tempdir().unwrap();
    let db = Database::open(temp_dir.path().join("tdm.sqlite")).unwrap();
    let manager = DownloadManager::new(db, EventBus::default()).unwrap();

    let url = format!("http://127.0.0.1:{}/mutable.bin", port);
    let job = manager
        .create_download(&url, temp_dir.path())
        .await
        .unwrap();

    // Start with V1
    manager.start_download(&job.id).unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    manager.pause_download(&job.id).unwrap();

    // Now change server version to V2
    server_version.store(2, Ordering::SeqCst);

    // Resume: manager detects ETag mismatch, resets chunks, and downloads V2 cleanly!
    manager.resume_download(&job.id).unwrap();

    let state = wait_for_job_terminal(&manager, &job.id, Duration::from_secs(10))
        .await
        .unwrap();
    let job_info = manager.get_download(&job.id).unwrap().unwrap();
    println!(
        "test_etag_change_triggers_restart ERROR: {:?}",
        job_info.error_message
    );
    assert_eq!(state, JobState::Completed);

    let final_path = std::path::Path::new(&job.target_path);
    assert_eq!(compute_file_sha256(final_path), expected_hash_v2);

    cancel.cancel();
}

// =========================================================================
// TEST 8: App Crash / Restart Recovery from SQLite Checkpoints
// =========================================================================
#[tokio::test]
async fn test_crash_and_restart_recovery() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();

    let test_data: Vec<u8> = (0..2 * 1024 * 1024).map(|i| (i % 199) as u8).collect();
    let expected_hash = {
        let mut hasher = Sha256::new();
        hasher.update(&test_data);
        hex::encode(hasher.finalize())
    };

    let shared_data = Arc::new(test_data);
    let cancel = CancellationToken::new();
    let cancel_server = cancel.clone();

    let data_clone = shared_data.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cancel_server.cancelled() => break,
                res = listener.accept() => {
                    let (mut socket, _) = match res {
                        Ok(s) => s,
                        Err(_) => break,
                    };
                    let data = data_clone.clone();

                    tokio::spawn(async move {
                        let mut buf = vec![0u8; 4096];
                        let n = socket.read(&mut buf).await.unwrap_or(0);
                        let req = String::from_utf8_lossy(&buf[..n]);

                        let is_head = req.starts_with("HEAD");
                        let range_header = req.lines().find(|l| l.to_lowercase().starts_with("range:"));
                        let total_len = data.len();

                        if is_head {
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nETag: \"etag-crash\"\r\nConnection: close\r\n\r\n",
                                total_len
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                        } else if let Some(r) = range_header {
                            let range_val = r.split(':').nth(1).unwrap().trim();
                            if let Some(bytes_spec) = range_val.strip_prefix("bytes=") {
                                let parts: Vec<&str> = bytes_spec.split('-').collect();
                                let start: usize = parts[0].parse().unwrap_or(0);
                                let end: usize = parts[1].parse().unwrap_or(total_len - 1);
                                let slice = &data[start..=end.min(total_len - 1)];

                                let resp = format!(
                                    "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {}-{}/{}\r\nContent-Length: {}\r\nETag: \"etag-crash\"\r\nConnection: close\r\n\r\n",
                                    start, end, total_len, slice.len()
                                );
                                let _ = socket.write_all(resp.as_bytes()).await;

                                for chunk in slice.chunks(32 * 1024) {
                                    if socket.write_all(chunk).await.is_err() {
                                        break;
                                    }
                                    tokio::time::sleep(Duration::from_millis(20)).await;
                                }
                            }
                        }
                    });
                }
            }
        }
    });

    let temp_dir = tempdir().unwrap();
    let db_path = temp_dir.path().join("tdm_crash.sqlite");
    let job_id: String;

    // Phase 1: Start download in first manager instance and simulate sudden crash
    {
        let db = Database::open(&db_path).unwrap();
        let manager = DownloadManager::new(db, EventBus::default()).unwrap();

        let url = format!("http://127.0.0.1:{}/crash_recovery.bin", port);
        let job = manager
            .create_download(&url, temp_dir.path())
            .await
            .unwrap();
        job_id = job.id.clone();

        manager.start_download(&job_id).unwrap();

        // Let it run for a moment so some chunks are written and checkpointed
        tokio::time::sleep(Duration::from_millis(200)).await;

        // Simulate abrupt process crash: drop manager without clean shutdown!
        drop(manager);
    }

    // Phase 2: Start new process with same database
    {
        let db2 = Database::open(&db_path).unwrap();
        let manager2 = DownloadManager::new(db2, EventBus::default()).unwrap();

        // Check that startup reconciliation safely marked active jobs as Paused
        let recovered_job = manager2.get_download(&job_id).unwrap().unwrap();
        assert_eq!(recovered_job.state, JobState::Paused);

        // Resume download
        manager2.resume_download(&job_id).unwrap();

        let state = wait_for_job_terminal(&manager2, &job_id, Duration::from_secs(15))
            .await
            .unwrap();
        assert_eq!(state, JobState::Completed);

        let final_path = std::path::Path::new(&recovered_job.target_path);
        assert!(final_path.exists());
        assert_eq!(compute_file_sha256(final_path), expected_hash);
    }

    cancel.cancel();
}

// =========================================================================
// TEST 9: Redownload Completed Download without Breaking Duplicate Prevention
// =========================================================================
#[tokio::test]
async fn test_redownload_completed_download() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();

    let test_data: Vec<u8> = (0..512 * 1024).map(|i| (i % 251) as u8).collect();
    let expected_hash = {
        let mut hasher = Sha256::new();
        hasher.update(&test_data);
        hex::encode(hasher.finalize())
    };

    let shared_data = Arc::new(test_data);
    let cancel = CancellationToken::new();
    let cancel_server = cancel.clone();

    let data_clone = shared_data.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cancel_server.cancelled() => break,
                res = listener.accept() => {
                    let (mut socket, _) = match res {
                        Ok(s) => s,
                        Err(_) => break,
                    };
                    let data = data_clone.clone();

                    tokio::spawn(async move {
                        let mut buf = vec![0u8; 4096];
                        let n = socket.read(&mut buf).await.unwrap_or(0);
                        let req_str = String::from_utf8_lossy(&buf[..n]);

                        let is_head = req_str.starts_with("HEAD");
                        let total_len = data.len();

                        if is_head {
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\r\n",
                                total_len
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                        } else {
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\r\n",
                                total_len
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                            let _ = socket.write_all(&data).await;
                        }
                    });
                }
            }
        }
    });

    let temp_dir = tempdir().unwrap();
    let db_path = temp_dir.path().join("redownload_test.sqlite");
    let db = Database::open(&db_path).unwrap();
    let manager = DownloadManager::new(db, EventBus::default()).unwrap();

    let url = format!("http://127.0.0.1:{}/test_file.bin", port);
    let job = manager
        .create_download(&url, temp_dir.path())
        .await
        .unwrap();

    // 1. Initial download
    manager.start_download(&job.id).unwrap();
    let state = wait_for_job_terminal(&manager, &job.id, Duration::from_secs(10))
        .await
        .unwrap();
    assert_eq!(state, JobState::Completed);

    let target_path = std::path::Path::new(&job.target_path);
    assert!(target_path.exists());
    assert_eq!(compute_file_sha256(target_path), expected_hash);

    // 2. Intentionally redownload completed job using retry_download action
    manager
        .retry_download(&job.id)
        .expect("Redownload of completed job should succeed");

    let redownload_state = wait_for_job_terminal(&manager, &job.id, Duration::from_secs(10))
        .await
        .unwrap();
    assert_eq!(redownload_state, JobState::Completed);

    // 3. Verify target file exists and hash is valid
    assert!(target_path.exists());
    assert_eq!(compute_file_sha256(target_path), expected_hash);

    cancel.cancel();
}
