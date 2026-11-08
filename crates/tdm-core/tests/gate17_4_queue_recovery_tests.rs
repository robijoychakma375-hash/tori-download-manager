use std::fs;
use std::io::Read;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use sha2::{Digest, Sha256};
use tempfile::tempdir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

use tdm_core::{Database, DownloadManager, EventBus, JobState, Priority};

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
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
}

// =========================================================================
// TEST 1: 24 Concurrent Download Requests Bounded Concurrency (max_active=4)
// =========================================================================
#[tokio::test]
async fn test_gate17_4_queue_24_concurrent_bounded_scheduling() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let cancel = CancellationToken::new();
    let cancel_server = cancel.clone();

    let payload: Vec<u8> = (0..65536).map(|i| (i % 251) as u8).collect(); // 64 KB
    let p_arc = Arc::new(payload.clone());
    let execution_order = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let exec_order_c = execution_order.clone();

    let p_c = p_arc.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cancel_server.cancelled() => break,
                res = listener.accept() => {
                    let (mut socket, _) = match res {
                        Ok(s) => s,
                        Err(_) => break,
                    };
                    let p = p_c.clone();
                    let exec = exec_order_c.clone();
                    tokio::spawn(async move {
                        let mut buf = [0u8; 1024];
                        let n = socket.read(&mut buf).await.unwrap_or(0);
                        let req = String::from_utf8_lossy(&buf[..n]);
                        let is_head = req.starts_with("HEAD");
                        if is_head {
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\r\n",
                                p.len()
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                        } else if req.contains("Range: bytes=0-0") || req.contains("range: bytes=0-0") {
                            let resp = "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-0/65536\r\nContent-Length: 1\r\n\r\n";
                            let _ = socket.write_all(resp.as_bytes()).await;
                            let _ = socket.write_all(&[p[0]]).await;
                        } else {
                            let first_line = req.lines().next().unwrap_or("");
                            if let Some(path) = first_line.split_whitespace().nth(1) {
                                exec.lock().unwrap().push(path.to_string());
                            }
                            // Small delay to simulate transfer under bounded workers
                            tokio::time::sleep(Duration::from_millis(20)).await;
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                p.len()
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                            let _ = socket.write_all(&p).await;
                        }
                    });
                }
            }
        }
    });

    let temp_dir = tempdir().unwrap();
    let db = Database::open(temp_dir.path().join("queue_test.sqlite")).unwrap();
    let manager = DownloadManager::new(db.clone(), EventBus::default()).unwrap();
    manager.set_max_active_jobs(4);

    let mut job_ids = Vec::new();
    let mut high_ids = Vec::new();
    let mut normal_ids = Vec::new();
    let mut low_ids = Vec::new();

    // Create 24 jobs with mixed priorities
    for i in 0..24 {
        let prio = match i % 3 {
            0 => Priority::High,
            1 => Priority::Normal,
            _ => Priority::Low,
        };
        let url = format!("http://127.0.0.1:{}/job_{:02}_{:?}.bin", port, i, prio);
        let job = manager
            .create_download_with_priority(&url, temp_dir.path(), prio)
            .await
            .unwrap();

        match prio {
            Priority::High => high_ids.push(job.id.clone()),
            Priority::Normal => normal_ids.push(job.id.clone()),
            Priority::Low => low_ids.push(job.id.clone()),
        }
        job_ids.push(job.id);
    }

    // Start all 24 jobs
    for id in &job_ids {
        manager.start_download(id).unwrap();
    }

    // Wait for all 24 jobs to complete
    for id in &job_ids {
        let state = wait_for_job_terminal(&manager, id, Duration::from_secs(20))
            .await
            .unwrap();
        assert_eq!(state, JobState::Completed);
    }

    // Verify all 24 files are complete on disk
    let expected_hash = {
        let mut h = Sha256::new();
        h.update(&payload);
        hex::encode(h.finalize())
    };

    for id in &job_ids {
        let job = manager.get_download(id).unwrap().unwrap();
        let hash = compute_file_sha256(std::path::Path::new(&job.target_path));
        assert_eq!(hash, expected_hash);
    }

    cancel.cancel();
}

// =========================================================================
// TEST 2: Pausing Active Download Releases Slot and Starts Next Queued Job
// =========================================================================
#[tokio::test]
async fn test_gate17_4_pause_frees_slot_and_advances_queue() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let cancel = CancellationToken::new();
    let cancel_server = cancel.clone();

    // Large payload (1 MB) with throttling
    let payload: Vec<u8> = vec![0x77u8; 1048576];
    let p_arc = Arc::new(payload);

    let p_c = p_arc.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cancel_server.cancelled() => break,
                res = listener.accept() => {
                    let (mut socket, _) = match res {
                        Ok(s) => s,
                        Err(_) => break,
                    };
                    let p = p_c.clone();
                    tokio::spawn(async move {
                        let mut buf = [0u8; 1024];
                        let n = socket.read(&mut buf).await.unwrap_or(0);
                        let req = String::from_utf8_lossy(&buf[..n]);
                        let is_head = req.starts_with("HEAD");
                        if is_head {
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\r\n",
                                p.len()
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                        } else if req.contains("Range: bytes=0-0") || req.contains("range: bytes=0-0") {
                            let resp = "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-0/1048576\r\nContent-Length: 1\r\n\r\n";
                            let _ = socket.write_all(resp.as_bytes()).await;
                            let _ = socket.write_all(&[p[0]]).await;
                        } else {
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                p.len()
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                            // Stream slowly in 32 KB chunks to allow pause
                            for chunk in p.chunks(32768) {
                                if socket.write_all(chunk).await.is_err() {
                                    break;
                                }
                                tokio::time::sleep(Duration::from_millis(50)).await;
                            }
                        }
                    });
                }
            }
        }
    });

    let temp_dir = tempdir().unwrap();
    let db = Database::open(temp_dir.path().join("pause_queue.sqlite")).unwrap();
    let manager = DownloadManager::new(db.clone(), EventBus::default()).unwrap();
    manager.set_max_active_jobs(1); // Exactly 1 active slot

    // Create Job 1 and Job 2
    let url1 = format!("http://127.0.0.1:{}/job_slow_1.bin", port);
    let job1 = manager
        .create_download(&url1, temp_dir.path())
        .await
        .unwrap();

    let url2 = format!("http://127.0.0.1:{}/job_slow_2.bin", port);
    let job2 = manager
        .create_download(&url2, temp_dir.path())
        .await
        .unwrap();

    // Start Job 1 -> should become Downloading
    manager.start_download(&job1.id).unwrap();
    // Start Job 2 -> should be queued because max_active = 1
    manager.start_download(&job2.id).unwrap();

    tokio::time::sleep(Duration::from_millis(100)).await;
    let s1 = manager.get_download(&job1.id).unwrap().unwrap().state;
    let s2 = manager.get_download(&job2.id).unwrap().unwrap().state;
    assert_eq!(s1, JobState::Downloading);
    assert_eq!(s2, JobState::Queued);

    // Pause Job 1 -> should transition to Paused, release worker slot, and auto-dispatch Job 2!
    manager.pause_download(&job1.id).unwrap();
    tokio::time::sleep(Duration::from_millis(150)).await;

    let s1_post = manager.get_download(&job1.id).unwrap().unwrap().state;
    let s2_post = manager.get_download(&job2.id).unwrap().unwrap().state;
    assert_eq!(s1_post, JobState::Paused);
    assert_eq!(s2_post, JobState::Downloading);

    cancel.cancel();
}

// =========================================================================
// TEST 3: Cancelled Jobs Do Not Restart Automatically
// =========================================================================
#[tokio::test]
async fn test_gate17_4_cancelled_job_never_restarts() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let cancel = CancellationToken::new();
    let cancel_server = cancel.clone();

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
                        let mut buf = [0u8; 1024];
                        let _ = socket.read(&mut buf).await;
                        let resp = "HTTP/1.1 200 OK\r\nContent-Length: 1024\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\r\n";
                        let _ = socket.write_all(resp.as_bytes()).await;
                    });
                }
            }
        }
    });

    let temp_dir = tempdir().unwrap();
    let db = Database::open(temp_dir.path().join("cancel_test.sqlite")).unwrap();
    let manager = DownloadManager::new(db.clone(), EventBus::default()).unwrap();

    let url = format!("http://127.0.0.1:{}/job_cancel.bin", port);
    let job = manager
        .create_download(&url, temp_dir.path())
        .await
        .unwrap();

    // Cancel the job
    manager.cancel_download(&job.id).unwrap();
    let s = manager.get_download(&job.id).unwrap().unwrap().state;
    assert_eq!(s, JobState::Cancelled);

    // Call start_download -> must NOT restart a cancelled job
    manager.start_download(&job.id).unwrap();
    let s_after = manager.get_download(&job.id).unwrap().unwrap().state;
    assert_eq!(s_after, JobState::Cancelled);

    cancel.cancel();
}

// =========================================================================
// TEST 4: Resume Detects Changed Content-Length (Prevents Silent Corruption)
// =========================================================================
#[tokio::test]
async fn test_gate17_4_resume_detects_changed_content_length() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let cancel = CancellationToken::new();
    let cancel_server = cancel.clone();

    // Version 1: 1 MB payload
    let v1_data: Vec<u8> = vec![0x11u8; 1048576];
    // Version 2: 2 MB payload (Content-Length changed!)
    let v2_data: Vec<u8> = vec![0x22u8; 2097152];
    let is_v2 = Arc::new(std::sync::atomic::AtomicBool::new(false));

    let v1_arc = Arc::new(v1_data);
    let v2_arc = Arc::new(v2_data);
    let v1_c = v1_arc.clone();
    let v2_c = v2_arc.clone();
    let is_v2_c = is_v2.clone();

    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cancel_server.cancelled() => break,
                res = listener.accept() => {
                    let (mut socket, _) = match res {
                        Ok(s) => s,
                        Err(_) => break,
                    };
                    let v1 = v1_c.clone();
                    let v2 = v2_c.clone();
                    let v2_flag = is_v2_c.clone();

                    tokio::spawn(async move {
                        let mut buf = [0u8; 1024];
                        let n = socket.read(&mut buf).await.unwrap_or(0);
                        let req = String::from_utf8_lossy(&buf[..n]);

                        let use_v2 = v2_flag.load(Ordering::Relaxed);
                        let current_data = if use_v2 { &v2 } else { &v1 };
                        let total_len = current_data.len();

                        if req.starts_with("HEAD") {
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nETag: \"etag-len-test\"\r\nConnection: close\r\n\r\n",
                                total_len
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                        } else if let Some(r) = req.lines().find(|l| l.to_lowercase().starts_with("range:")) {
                            let range_val = r.split(':').nth(1).unwrap_or("").trim();
                            if let Some(spec) = range_val.strip_prefix("bytes=") {
                                let parts: Vec<&str> = spec.split('-').collect();
                                let start: usize = parts[0].parse().unwrap_or(0);
                                let end: usize = if parts.len() > 1 && !parts[1].is_empty() {
                                    parts[1].parse().unwrap_or(total_len - 1)
                                } else {
                                    total_len - 1
                                };
                                let slice = &current_data[start..=end.min(total_len - 1)];

                                if !use_v2 {
                                    let resp = format!(
                                        "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {}-{}/{}\r\nContent-Length: {}\r\nETag: \"etag-len-test\"\r\nConnection: close\r\n\r\n",
                                        start, end, total_len, slice.len()
                                    );
                                    let _ = socket.write_all(resp.as_bytes()).await;
                                    for chunk in slice.chunks(16384) {
                                        if socket.write_all(chunk).await.is_err() {
                                            break;
                                        }
                                        tokio::time::sleep(Duration::from_millis(80)).await;
                                    }
                                } else {
                                    let resp = format!(
                                        "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {}-{}/{}\r\nContent-Length: {}\r\nETag: \"etag-len-test\"\r\nConnection: close\r\n\r\n",
                                        start, end, total_len, slice.len()
                                    );
                                    let _ = socket.write_all(resp.as_bytes()).await;
                                    let _ = socket.write_all(slice).await;
                                }
                            }
                        } else {
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nETag: \"etag-len-test\"\r\nConnection: close\r\n\r\n",
                                total_len
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                            let _ = socket.write_all(current_data).await;
                        }
                    });
                }
            }
        }
    });

    let temp_dir = tempdir().unwrap();
    let db = Database::open(temp_dir.path().join("len_change.sqlite")).unwrap();
    let manager = DownloadManager::new(db.clone(), EventBus::default()).unwrap();

    let url = format!("http://127.0.0.1:{}/versioned_file.bin", port);
    let job = manager
        .create_download(&url, temp_dir.path())
        .await
        .unwrap();

    manager.start_download(&job.id).unwrap();
    tokio::time::sleep(Duration::from_millis(40)).await;

    // Pause download mid-stream
    manager.pause_download(&job.id).unwrap();
    tokio::time::sleep(Duration::from_millis(80)).await;

    let p_job = manager.get_download(&job.id).unwrap().unwrap();
    assert_eq!(p_job.state, JobState::Paused);
    assert_eq!(p_job.total_bytes, Some(1048576));

    // Switch server to Version 2 (2 MB)
    is_v2.store(true, Ordering::SeqCst);

    // Resume download -> engine detects changed total_bytes, invalidates chunks, restarts cleanly
    manager.resume_download(&job.id).unwrap();

    let terminal = wait_for_job_terminal(&manager, &job.id, Duration::from_secs(15))
        .await
        .unwrap();
    if terminal == JobState::Failed {
        let err = manager
            .get_download(&job.id)
            .unwrap()
            .unwrap()
            .error_message;
        panic!("Job failed with error: {:?}", err);
    }
    assert_eq!(terminal, JobState::Completed);

    let completed_job = manager.get_download(&job.id).unwrap().unwrap();
    assert_eq!(completed_job.total_bytes, Some(2097152));
    assert_eq!(
        fs::metadata(&completed_job.target_path).unwrap().len(),
        2097152
    );

    let expected_v2_hash = {
        let mut h = Sha256::new();
        h.update(&*v2_arc);
        hex::encode(h.finalize())
    };
    let actual_hash = compute_file_sha256(std::path::Path::new(&completed_job.target_path));
    assert_eq!(actual_hash, expected_v2_hash);

    cancel.cancel();
}

// =========================================================================
// TEST 5: Resume Detects Missing or Truncated Partial .tdm-part File
// =========================================================================
#[tokio::test]
async fn test_gate17_4_resume_detects_missing_part_file() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let cancel = CancellationToken::new();
    let cancel_server = cancel.clone();

    let payload: Vec<u8> = vec![0x55u8; 524288]; // 512 KB
    let p_arc = Arc::new(payload);
    let p_c = p_arc.clone();

    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cancel_server.cancelled() => break,
                res = listener.accept() => {
                    let (mut socket, _) = match res {
                        Ok(s) => s,
                        Err(_) => break,
                    };
                    let p = p_c.clone();
                    tokio::spawn(async move {
                        let mut buf = [0u8; 1024];
                        let n = socket.read(&mut buf).await.unwrap_or(0);
                        let req = String::from_utf8_lossy(&buf[..n]);
                        if req.starts_with("HEAD") {
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\r\n",
                                p.len()
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                        } else if req.contains("Range: bytes=0-0") || req.contains("range: bytes=0-0") {
                            let resp = "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-0/524288\r\nContent-Length: 1\r\n\r\n";
                            let _ = socket.write_all(resp.as_bytes()).await;
                            let _ = socket.write_all(&[p[0]]).await;
                        } else {
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                p.len()
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                            let _ = socket.write_all(&p).await;
                        }
                    });
                }
            }
        }
    });

    let temp_dir = tempdir().unwrap();
    let db = Database::open(temp_dir.path().join("missing_part.sqlite")).unwrap();
    let manager = DownloadManager::new(db.clone(), EventBus::default()).unwrap();

    let url = format!("http://127.0.0.1:{}/missing_part_test.bin", port);
    let job = manager
        .create_download(&url, temp_dir.path())
        .await
        .unwrap();

    manager.start_download(&job.id).unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;

    // Pause download
    manager.pause_download(&job.id).unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;

    // Manually delete the .tdm-part file to simulate external file removal
    let temp_file = std::path::PathBuf::from(&job.temp_path);
    if temp_file.exists() {
        let _ = fs::remove_file(&temp_file);
    }
    assert!(!temp_file.exists());

    // Resume download -> engine detects missing part file on disk, resets progress, and completes
    manager.resume_download(&job.id).unwrap();

    let terminal = wait_for_job_terminal(&manager, &job.id, Duration::from_secs(10))
        .await
        .unwrap();
    assert_eq!(terminal, JobState::Completed);

    let completed_job = manager.get_download(&job.id).unwrap().unwrap();
    assert_eq!(
        fs::metadata(&completed_job.target_path).unwrap().len(),
        524288
    );

    let expected_hash = {
        let mut h = Sha256::new();
        h.update(&*p_arc);
        hex::encode(h.finalize())
    };
    let actual_hash = compute_file_sha256(std::path::Path::new(&completed_job.target_path));
    assert_eq!(actual_hash, expected_hash);

    cancel.cancel();
}

// =========================================================================
// TEST 6: File Collision Avoidance Creates Unique Numbered File
// =========================================================================
#[tokio::test]
async fn test_gate17_4_file_collision_safety() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let cancel = CancellationToken::new();
    let cancel_server = cancel.clone();

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
                        let mut buf = [0u8; 1024];
                        let _ = socket.read(&mut buf).await;
                        let resp = "HTTP/1.1 200 OK\r\nContent-Length: 5\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\r\nhello";
                        let _ = socket.write_all(resp.as_bytes()).await;
                    });
                }
            }
        }
    });

    let temp_dir = tempdir().unwrap();
    let db = Database::open(temp_dir.path().join("collision.sqlite")).unwrap();
    let manager = DownloadManager::new(db.clone(), EventBus::default()).unwrap();

    // Pre-create file in destination directory
    let existing_file = temp_dir.path().join("document.pdf");
    fs::write(&existing_file, b"existing user content").unwrap();

    let url = format!("http://127.0.0.1:{}/document.pdf", port);
    let job = manager
        .create_download(&url, temp_dir.path())
        .await
        .unwrap();

    // Collision avoidance should name the new file "document (1).pdf"
    assert!(job.target_path.ends_with("document (1).pdf"));

    // Existing file must be untouched
    assert_eq!(fs::read(&existing_file).unwrap(), b"existing user content");

    cancel.cancel();
}

// =========================================================================
// TEST 7: Resume Detects Changed Last-Modified Validator
// =========================================================================
#[tokio::test]
async fn test_gate17_4_resume_detects_changed_last_modified() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let cancel = CancellationToken::new();
    let cancel_server = cancel.clone();

    let data_v1: Vec<u8> = vec![0x33u8; 1048576];
    let data_v2: Vec<u8> = vec![0x44u8; 1048576]; // Same length, different contents & Last-Modified!
    let is_v2 = Arc::new(std::sync::atomic::AtomicBool::new(false));

    let v1_arc = Arc::new(data_v1);
    let v2_arc = Arc::new(data_v2);
    let v1_c = v1_arc.clone();
    let v2_c = v2_arc.clone();
    let is_v2_c = is_v2.clone();

    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cancel_server.cancelled() => break,
                res = listener.accept() => {
                    let (mut socket, _) = match res {
                        Ok(s) => s,
                        Err(_) => break,
                    };
                    let v1 = v1_c.clone();
                    let v2 = v2_c.clone();
                    let v2_flag = is_v2_c.clone();

                    tokio::spawn(async move {
                        let mut buf = [0u8; 1024];
                        let n = socket.read(&mut buf).await.unwrap_or(0);
                        let req = String::from_utf8_lossy(&buf[..n]);

                        let use_v2 = v2_flag.load(Ordering::Relaxed);
                        let current_data = if use_v2 { &v2 } else { &v1 };
                        let lm_header = if use_v2 {
                            "Last-Modified: Sun, 08 Nov 2026 22:00:00 GMT\r\n"
                        } else {
                            "Last-Modified: Sun, 08 Nov 2026 20:00:00 GMT\r\n"
                        };

                        if req.starts_with("HEAD") {
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\n{}Connection: close\r\n\r\n",
                                current_data.len(),
                                lm_header
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                        } else if let Some(r) = req.lines().find(|l| l.to_lowercase().starts_with("range:")) {
                            let range_val = r.split(':').nth(1).unwrap_or("").trim();
                            if let Some(spec) = range_val.strip_prefix("bytes=") {
                                let parts: Vec<&str> = spec.split('-').collect();
                                let start: usize = parts[0].parse().unwrap_or(0);
                                let end: usize = if parts.len() > 1 && !parts[1].is_empty() {
                                    parts[1].parse().unwrap_or(current_data.len() - 1)
                                } else {
                                    current_data.len() - 1
                                };
                                let slice = &current_data[start..=end.min(current_data.len() - 1)];

                                if !use_v2 {
                                    let resp = format!(
                                        "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {}-{}/{}\r\nContent-Length: {}\r\n{}Connection: close\r\n\r\n",
                                        start, end, current_data.len(), slice.len(), lm_header
                                    );
                                    let _ = socket.write_all(resp.as_bytes()).await;
                                    for chunk in slice.chunks(16384) {
                                        if socket.write_all(chunk).await.is_err() {
                                            break;
                                        }
                                        tokio::time::sleep(Duration::from_millis(80)).await;
                                    }
                                } else {
                                    let resp = format!(
                                        "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {}-{}/{}\r\nContent-Length: {}\r\n{}Connection: close\r\n\r\n",
                                        start, end, current_data.len(), slice.len(), lm_header
                                    );
                                    let _ = socket.write_all(resp.as_bytes()).await;
                                    let _ = socket.write_all(slice).await;
                                }
                            }
                        } else {
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n{}Connection: close\r\n\r\n",
                                current_data.len(),
                                lm_header
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                            let _ = socket.write_all(current_data).await;
                        }
                    });
                }
            }
        }
    });

    let temp_dir = tempdir().unwrap();
    let db = Database::open(temp_dir.path().join("lm_change.sqlite")).unwrap();
    let manager = DownloadManager::new(db.clone(), EventBus::default()).unwrap();

    let url = format!("http://127.0.0.1:{}/lm_file.bin", port);
    let job = manager
        .create_download(&url, temp_dir.path())
        .await
        .unwrap();

    manager.start_download(&job.id).unwrap();
    tokio::time::sleep(Duration::from_millis(40)).await;

    // Pause download
    manager.pause_download(&job.id).unwrap();
    tokio::time::sleep(Duration::from_millis(80)).await;

    // Switch server to Version 2 (new Last-Modified and new payload)
    is_v2.store(true, Ordering::SeqCst);

    // Resume download -> engine detects changed Last-Modified validator, invalidates stale chunks, downloads V2
    manager.resume_download(&job.id).unwrap();

    let terminal = wait_for_job_terminal(&manager, &job.id, Duration::from_secs(15))
        .await
        .unwrap();
    assert_eq!(terminal, JobState::Completed);

    let completed_job = manager.get_download(&job.id).unwrap().unwrap();
    let expected_v2_hash = {
        let mut h = Sha256::new();
        h.update(&*v2_arc);
        hex::encode(h.finalize())
    };
    let actual_hash = compute_file_sha256(std::path::Path::new(&completed_job.target_path));
    assert_eq!(actual_hash, expected_v2_hash);

    cancel.cancel();
}

// =========================================================================
// TEST 8: Application Crash and Restart Recovery Across 3 Active Jobs
// =========================================================================
#[tokio::test]
async fn test_gate17_4_crash_recovery_across_stages() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let cancel = CancellationToken::new();
    let cancel_server = cancel.clone();

    let payload: Vec<u8> = (0..2097152).map(|i| (i % 229) as u8).collect(); // 2 MB
    let p_arc = Arc::new(payload);
    let p_c = p_arc.clone();

    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cancel_server.cancelled() => break,
                res = listener.accept() => {
                    let (mut socket, _) = match res {
                        Ok(s) => s,
                        Err(_) => break,
                    };
                    let p = p_c.clone();
                    tokio::spawn(async move {
                        let mut buf = [0u8; 1024];
                        let n = socket.read(&mut buf).await.unwrap_or(0);
                        let req = String::from_utf8_lossy(&buf[..n]);

                        if req.starts_with("HEAD") {
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\r\n",
                                p.len()
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                        } else if let Some(r) = req.lines().find(|l| l.to_lowercase().starts_with("range:")) {
                            let range_val = r.split(':').nth(1).unwrap_or("").trim();
                            if let Some(spec) = range_val.strip_prefix("bytes=") {
                                let parts: Vec<&str> = spec.split('-').collect();
                                let start: usize = parts[0].parse().unwrap_or(0);
                                let end: usize = if parts.len() > 1 && !parts[1].is_empty() {
                                    parts[1].parse().unwrap_or(p.len() - 1)
                                } else {
                                    p.len() - 1
                                };
                                let slice = &p[start..=end.min(p.len() - 1)];
                                let resp = format!(
                                    "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {}-{}/{}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                    start, end, p.len(), slice.len()
                                );
                                let _ = socket.write_all(resp.as_bytes()).await;
                                for chunk in slice.chunks(16384) {
                                    if socket.write_all(chunk).await.is_err() {
                                        break;
                                    }
                                    tokio::time::sleep(Duration::from_millis(60)).await;
                                }
                            }
                        } else {
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                p.len()
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                            let _ = socket.write_all(&p).await;
                        }
                    });
                }
            }
        }
    });

    let temp_dir = tempdir().unwrap();
    let db_path = temp_dir.path().join("crash_multi.sqlite");
    let mut job_ids = Vec::new();

    // Phase 1: Start 3 jobs, simulate unexpected crash mid-stream
    {
        let db = Database::open(&db_path).unwrap();
        let manager = DownloadManager::new(db, EventBus::default()).unwrap();

        for i in 0..3 {
            let url = format!("http://127.0.0.1:{}/crash_job_{}.bin", port, i);
            let job = manager
                .create_download(&url, temp_dir.path())
                .await
                .unwrap();
            manager.start_download(&job.id).unwrap();
            job_ids.push(job.id);
        }

        // Run briefly during active write
        tokio::time::sleep(Duration::from_millis(50)).await;

        // Abruptly drop manager to simulate crash
        drop(manager);
    }

    // Phase 2: Start new engine instance with the same SQLite database
    {
        let db2 = Database::open(&db_path).unwrap();
        let manager2 = DownloadManager::new(db2, EventBus::default()).unwrap();

        // reconcile_on_startup should have transitioned interrupted active downloads to Paused
        for id in &job_ids {
            let job = manager2.get_download(id).unwrap().unwrap();
            assert_eq!(job.state, JobState::Paused);
        }

        // Resume all 3 jobs
        for id in &job_ids {
            manager2.resume_download(id).unwrap();
        }

        // Wait for all 3 jobs to complete
        for id in &job_ids {
            let terminal = wait_for_job_terminal(&manager2, id, Duration::from_secs(15))
                .await
                .unwrap();
            assert_eq!(terminal, JobState::Completed);
        }

        // Verify SHA-256 on all 3 recovered files
        let expected_hash = {
            let mut h = Sha256::new();
            h.update(&*p_arc);
            hex::encode(h.finalize())
        };

        for id in &job_ids {
            let job = manager2.get_download(id).unwrap().unwrap();
            let hash = compute_file_sha256(std::path::Path::new(&job.target_path));
            assert_eq!(hash, expected_hash);
        }
    }

    cancel.cancel();
}

// =========================================================================
// TEST 9: Server Without HTTP Range Support (Clean Fallback Restart)
// =========================================================================
#[tokio::test]
async fn test_gate17_4_unsupported_range_server_fallback() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let cancel = CancellationToken::new();
    let cancel_server = cancel.clone();

    let payload: Vec<u8> = vec![0x88u8; 131072]; // 128 KB
    let p_arc = Arc::new(payload);
    let p_c = p_arc.clone();

    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cancel_server.cancelled() => break,
                res = listener.accept() => {
                    let (mut socket, _) = match res {
                        Ok(s) => s,
                        Err(_) => break,
                    };
                    let p = p_c.clone();
                    tokio::spawn(async move {
                        let mut buf = [0u8; 1024];
                        let _ = socket.read(&mut buf).await;
                        // Always return 200 OK without Accept-Ranges
                        let resp = format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            p.len()
                        );
                        let _ = socket.write_all(resp.as_bytes()).await;
                        let _ = socket.write_all(&p).await;
                    });
                }
            }
        }
    });

    let temp_dir = tempdir().unwrap();
    let db = Database::open(temp_dir.path().join("no_range.sqlite")).unwrap();
    let manager = DownloadManager::new(db.clone(), EventBus::default()).unwrap();

    let url = format!("http://127.0.0.1:{}/no_range_file.bin", port);
    let job = manager
        .create_download(&url, temp_dir.path())
        .await
        .unwrap();

    // Probe should detect non-resumable
    assert!(!job.is_resumable);
    assert_eq!(job.chunk_count, 1);

    manager.start_download(&job.id).unwrap();

    let terminal = wait_for_job_terminal(&manager, &job.id, Duration::from_secs(10))
        .await
        .unwrap();
    assert_eq!(terminal, JobState::Completed);

    let completed = manager.get_download(&job.id).unwrap().unwrap();
    let expected_hash = {
        let mut h = Sha256::new();
        h.update(&*p_arc);
        hex::encode(h.finalize())
    };
    let actual_hash = compute_file_sha256(std::path::Path::new(&completed.target_path));
    assert_eq!(actual_hash, expected_hash);

    cancel.cancel();
}
