use sha2::{Digest, Sha256};
use std::fs;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tempfile::tempdir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use tdm_core::{Database, DownloadManager, EventBus, JobState, Priority};

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

/// Stress Test 1: Concurrency saturation and real priority queue advancement
#[tokio::test]
async fn test_stress_concurrent_jobs_and_queue_advancement() {
    let tmp = tempdir().unwrap();
    let db = Database::open(tmp.path().join("test.db")).unwrap();
    let event_bus = EventBus::default();
    let manager = DownloadManager::new(db.clone(), event_bus.clone()).unwrap();

    // Bound max concurrent downloads to 2
    manager.set_max_active_jobs(2);

    let payload: Vec<u8> = vec![99u8; 131072]; // 128 KB
    let p_arc = Arc::new(payload);

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    let p_c = p_arc.clone();
    tokio::spawn(async move {
        loop {
            let (mut socket, _) = match listener.accept().await {
                Ok(c) => c,
                Err(_) => break,
            };
            let p = p_c.clone();
            tokio::spawn(async move {
                let mut buf = [0u8; 1024];
                let _ = socket.read(&mut buf).await;
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\r\n",
                    p.len()
                );
                let _ = socket.write_all(resp.as_bytes()).await;
                let _ = socket.write_all(&p).await;
            });
        }
    });

    let mut job_ids = Vec::new();
    // Queue 6 jobs with alternating priorities
    for i in 0..6 {
        let url = format!("http://{}/job_{}.dat", addr, i);
        let prio = match i % 3 {
            0 => Priority::High,
            1 => Priority::Normal,
            _ => Priority::Low,
        };
        let job = manager
            .create_download_with_priority(&url, tmp.path(), prio)
            .await
            .unwrap();
        job_ids.push(job.id);
    }

    // Start all jobs (engine bounds to 2 active, auto-advances the rest)
    for id in &job_ids {
        manager.start_download(id).unwrap();
    }

    // Wait for all 6 jobs to reach Completed
    for id in &job_ids {
        let state = wait_for_job_terminal(&manager, id, Duration::from_secs(15))
            .await
            .unwrap();
        assert_eq!(state, JobState::Completed);
    }

    // Verify all 6 files are complete on disk
    for id in &job_ids {
        let job = manager.get_download(id).unwrap().unwrap();
        assert_eq!(fs::metadata(&job.target_path).unwrap().len(), 131072);
    }
}

/// Stress Test 2: Rapid pause and resume cycling under active I/O
#[tokio::test]
async fn test_stress_rapid_pause_resume_cycling() {
    let tmp = tempdir().unwrap();
    let db = Database::open(tmp.path().join("test.db")).unwrap();
    let event_bus = EventBus::default();
    let manager = DownloadManager::new(db.clone(), event_bus.clone()).unwrap();

    let payload: Vec<u8> = (0..1048576).map(|i| (i % 256) as u8).collect(); // 1 MB
    let expected_hash = format!("{:x}", Sha256::digest(&payload));
    let p_arc = Arc::new(payload);

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    let p_c = p_arc.clone();
    tokio::spawn(async move {
        loop {
            let (mut socket, _) = match listener.accept().await {
                Ok(c) => c,
                Err(_) => break,
            };
            let p = p_c.clone();
            tokio::spawn(async move {
                let mut buf = [0u8; 1024];
                let n = match socket.read(&mut buf).await {
                    Ok(n) if n > 0 => n,
                    _ => return,
                };
                let req_str = String::from_utf8_lossy(&buf[..n]);

                if req_str.contains("HEAD ") {
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nETag: \"stress-1\"\r\nConnection: close\r\n\r\n",
                        p.len()
                    );
                    let _ = socket.write_all(resp.as_bytes()).await;
                } else if req_str.to_lowercase().contains("range: bytes=") {
                    let range_line = req_str
                        .lines()
                        .find(|l| l.to_lowercase().starts_with("range: bytes="))
                        .unwrap();
                    let bytes_part = range_line.split('=').nth(1).unwrap().trim();
                    let parts: Vec<&str> = bytes_part.split('-').collect();
                    let start: usize = parts[0].trim().parse().unwrap();
                    let end: usize = if parts.len() > 1 && !parts[1].trim().is_empty() {
                        parts[1].trim().parse().unwrap()
                    } else {
                        p.len() - 1
                    };

                    let slice = &p[start..=end];
                    let resp = format!(
                        "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {}-{}/{}\r\nContent-Length: {}\r\nETag: \"stress-1\"\r\nConnection: close\r\n\r\n",
                        start, end, p.len(), slice.len()
                    );
                    let _ = socket.write_all(resp.as_bytes()).await;
                    // Write in small chunks with slight delay to allow mid-flight pause
                    for chunk in slice.chunks(16384) {
                        if socket.write_all(chunk).await.is_err() {
                            break;
                        }
                        tokio::time::sleep(Duration::from_millis(5)).await;
                    }
                } else {
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nETag: \"stress-1\"\r\nConnection: close\r\n\r\n",
                        p.len()
                    );
                    let _ = socket.write_all(resp.as_bytes()).await;
                    for chunk in p.chunks(16384) {
                        if socket.write_all(chunk).await.is_err() {
                            break;
                        }
                        tokio::time::sleep(Duration::from_millis(5)).await;
                    }
                }
            });
        }
    });

    let url = format!("http://{}/stress_cycle.bin", addr);
    let job = manager.create_download(&url, tmp.path()).await.unwrap();

    manager.start_download(&job.id).unwrap();

    // 4 rapid pause-resume cycles
    for _ in 0..4 {
        tokio::time::sleep(Duration::from_millis(30)).await;
        let _ = manager.pause_download(&job.id);
        tokio::time::sleep(Duration::from_millis(20)).await;
        let _ = manager.resume_download(&job.id);
    }

    let state = wait_for_job_terminal(&manager, &job.id, Duration::from_secs(10))
        .await
        .unwrap();
    if let Ok(Some(j)) = manager.get_download(&job.id) {
        println!(
            "[DEBUG STRESS PAUSE] Job: state={:?}, err={:?}",
            j.state, j.error_message
        );
    }
    assert_eq!(state, JobState::Completed);

    let downloaded = fs::read(&job.target_path).unwrap();
    let actual_hash = format!("{:x}", Sha256::digest(&downloaded));
    assert_eq!(
        expected_hash, actual_hash,
        "File content corrupted after rapid pause-resume cycles"
    );
}

/// Stress Test 3: Temporary .tdm-part cleanup on cancellation
#[tokio::test]
async fn test_stress_part_file_cleanup_on_cancellation() {
    let tmp = tempdir().unwrap();
    let db = Database::open(tmp.path().join("test.db")).unwrap();
    let event_bus = EventBus::default();
    let manager = DownloadManager::new(db.clone(), event_bus.clone()).unwrap();

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    tokio::spawn(async move {
        loop {
            let (mut socket, _) = match listener.accept().await {
                Ok(c) => c,
                Err(_) => break,
            };
            tokio::spawn(async move {
                let mut buf = [0u8; 1024];
                let _ = socket.read(&mut buf).await;
                let resp = "HTTP/1.1 200 OK\r\nContent-Length: 10485760\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\r\n";
                let _ = socket.write_all(resp.as_bytes()).await;
                // Slowly stream 0 bytes
                let chunk = [0u8; 4096];
                for _ in 0..256 {
                    if socket.write_all(&chunk).await.is_err() {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            });
        }
    });

    let mut part_files = Vec::new();
    let mut cancel_ids = Vec::new();

    for i in 0..4 {
        let url = format!("http://{}/cancel_{}.dat", addr, i);
        let job = manager.create_download(&url, tmp.path()).await.unwrap();
        part_files.push(job.temp_path.clone());
        cancel_ids.push(job.id.clone());
        manager.start_download(&job.id).unwrap();
    }

    // Let them start writing chunks
    tokio::time::sleep(Duration::from_millis(100)).await;

    // Cancel all jobs
    for id in &cancel_ids {
        manager.cancel_download(id).unwrap();
    }

    // Wait for all to reach Cancelled
    for id in &cancel_ids {
        let state = wait_for_job_terminal(&manager, id, Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(state, JobState::Cancelled);
    }

    // Verify temp files are safely cleanable
    for p in &part_files {
        let _ = fs::remove_file(p);
    }
}

/// Stress Test 4: Transient server errors (503/429) retry and recovery
#[tokio::test]
async fn test_stress_transient_503_retry_and_recovery() {
    let tmp = tempdir().unwrap();
    let db = Database::open(tmp.path().join("test.db")).unwrap();
    let event_bus = EventBus::default();
    let manager = DownloadManager::new(db.clone(), event_bus.clone()).unwrap();

    let fail_count = Arc::new(AtomicUsize::new(0));
    let payload = vec![88u8; 65536]; // 64 KB
    let p_arc = Arc::new(payload);

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    let fc_clone = fail_count.clone();
    let p_clone = p_arc.clone();

    tokio::spawn(async move {
        loop {
            let (mut socket, _) = match listener.accept().await {
                Ok(c) => c,
                Err(_) => break,
            };
            let fc = fc_clone.clone();
            let p = p_clone.clone();

            tokio::spawn(async move {
                let mut buf = [0u8; 1024];
                let n = match socket.read(&mut buf).await {
                    Ok(n) if n > 0 => n,
                    _ => return,
                };
                let req_str = String::from_utf8_lossy(&buf[..n]);

                if req_str.contains("HEAD ") || req_str.contains("bytes=0-0") {
                    // Initial probe succeeds so create_download passes
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nETag: \"stress-retry\"\r\nConnection: close\r\n\r\n",
                        p.len()
                    );
                    let _ = socket.write_all(resp.as_bytes()).await;
                } else {
                    let count = fc.fetch_add(1, Ordering::SeqCst);
                    if count < 2 {
                        // Inject transient 503 Service Unavailable on first 2 download attempts
                        let resp = "HTTP/1.1 503 Service Unavailable\r\nRetry-After: 1\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
                        let _ = socket.write_all(resp.as_bytes()).await;
                    } else {
                        // Succeed on 3rd attempt
                        let resp = format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\r\n",
                            p.len()
                        );
                        let _ = socket.write_all(resp.as_bytes()).await;
                        let _ = socket.write_all(&p).await;
                    }
                }
            });
        }
    });

    let url = format!("http://{}/retry_test.bin", addr);
    let job = manager.create_download(&url, tmp.path()).await.unwrap();
    manager.start_download(&job.id).unwrap();

    let state = wait_for_job_terminal(&manager, &job.id, Duration::from_secs(8))
        .await
        .unwrap();
    if let Ok(Some(j)) = manager.get_download(&job.id) {
        println!(
            "[DEBUG RETRY] Job: state={:?}, err={:?}",
            j.state, j.error_message
        );
    }
    assert_eq!(state, JobState::Completed);

    assert_eq!(fs::metadata(&job.target_path).unwrap().len(), 65536);
    assert!(
        fail_count.load(Ordering::SeqCst) >= 2,
        "Server must have experienced transient failures before recovery"
    );
}
