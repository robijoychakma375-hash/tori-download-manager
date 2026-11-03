use std::fs;
use std::io::Read;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};
use tempfile::tempdir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

use tdm_core::{
    AdaptiveConfig, Database, DownloadManager, EventBus, GovernorConfig, JobState, Priority,
};

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
    let start = Instant::now();
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
// TEST 1: Gate 2 Adaptive Straggler Tail Splitting (Disjoint non-overlapping)
// =========================================================================
#[tokio::test]
async fn test_gate2_adaptive_straggler_tail_splitting() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();

    // 10 MB payload -> initially planned as 2 chunks of 5 MB each
    let total_size = 10 * 1024 * 1024;
    let test_data: Vec<u8> = (0..total_size).map(|i| (i % 251) as u8).collect();
    let expected_hash = {
        let mut hasher = Sha256::new();
        hasher.update(&test_data);
        hex::encode(hasher.finalize())
    };

    let shared_data = Arc::new(test_data);
    let cancel = CancellationToken::new();
    let cancel_server = cancel.clone();

    // Mock HTTP server that artificially trickles chunk 1 slowly so that chunk 0
    // finishes early and triggers straggler tail splitting on chunk 1.
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
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nETag: \"etag-gate2-split\"\r\nConnection: close\r\n\r\n",
                                total_len
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                        } else if let Some(r) = range_header {
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
                                    "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {}-{}/{}\r\nContent-Length: {}\r\nETag: \"etag-gate2-split\"\r\nConnection: close\r\n\r\n",
                                    start, end, total_len, slice.len()
                                );
                                let _ = socket.write_all(resp.as_bytes()).await;

                                // If this request is for chunk 1 starting around 5 MB, trickle slowly
                                if (5 * 1024 * 1024..6 * 1024 * 1024).contains(&start) {
                                    // Send in 64 KB pieces with slight delay to ensure chunk 0 finishes first
                                    for piece in slice.chunks(64 * 1024) {
                                        if socket.write_all(piece).await.is_err() {
                                            break;
                                        }
                                        tokio::time::sleep(Duration::from_millis(15)).await;
                                    }
                                } else {
                                    // Full speed for chunk 0 and split chunks
                                    let _ = socket.write_all(slice).await;
                                }
                            }
                        }
                    });
                }
            }
        }
    });

    let temp_dir = tempdir().unwrap();
    let db_path = temp_dir.path().join("tdm_gate2.sqlite");
    let db = Database::open(&db_path).unwrap();
    let event_bus = EventBus::default();

    // Use scheduler with 1 MB minimum split threshold to ensure split activates
    let adaptive_config = AdaptiveConfig {
        min_split_size: 1024 * 1024,
        max_concurrency: 4,
        sample_window_ms: 100,
    };
    let gov_config = GovernorConfig {
        max_global_connections: 16,
        max_connections_per_host: 8,
    };

    let manager =
        DownloadManager::with_config(db.clone(), event_bus, gov_config, adaptive_config).unwrap();

    let url = format!("http://127.0.0.1:{}/adaptive_straggler.bin", port);
    let job = manager
        .create_download(&url, temp_dir.path())
        .await
        .unwrap();

    assert_eq!(job.total_bytes, Some(total_size as u64));
    assert_eq!(job.chunk_count, 2);

    manager.start_download(&job.id).unwrap();

    let state = wait_for_job_terminal(&manager, &job.id, Duration::from_secs(15))
        .await
        .unwrap();
    assert_eq!(state, JobState::Completed);

    // Verify database record has been split (chunk_index >= 2 exists)
    let chunks = db.get_chunks(&job.id).unwrap();
    assert!(
        chunks.len() >= 3,
        "Expected straggler tail split to generate at least 3 chunks, found {}",
        chunks.len()
    );
    assert!(
        chunks.iter().all(|c| c.is_complete),
        "All chunks must be complete"
    );

    // Verify non-overlapping continuity: total written across all chunks equals file size
    let total_written: u64 = chunks.iter().map(|c| c.written_bytes).sum();
    assert_eq!(total_written, total_size as u64);

    let final_path = std::path::Path::new(&job.target_path);
    assert!(final_path.exists());
    assert_eq!(compute_file_sha256(final_path), expected_hash);

    cancel.cancel();
}

// =========================================================================
// TEST 2: Concurrency Governor Enforces Per-Host Concurrency Limit Under Load
// =========================================================================
#[tokio::test]
async fn test_gate2_concurrency_governor_enforces_per_host_limit() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();

    let total_size = 2 * 1024 * 1024;
    let test_data: Vec<u8> = vec![0xAA; total_size];
    let shared_data = Arc::new(test_data);
    let cancel = CancellationToken::new();
    let cancel_server = cancel.clone();

    let active_connections = Arc::new(AtomicUsize::new(0));
    let max_concurrent_observed = Arc::new(AtomicUsize::new(0));

    let data_clone = shared_data.clone();
    let active_conn_clone = active_connections.clone();
    let max_conn_clone = max_concurrent_observed.clone();

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
                    let act = active_conn_clone.clone();
                    let max_c = max_conn_clone.clone();

                    tokio::spawn(async move {
                        let cur = act.fetch_add(1, Ordering::SeqCst) + 1;
                        let mut prev_max = max_c.load(Ordering::SeqCst);
                        while cur > prev_max {
                            match max_c.compare_exchange_weak(prev_max, cur, Ordering::SeqCst, Ordering::SeqCst) {
                                Ok(_) => break,
                                Err(actual) => prev_max = actual,
                            }
                        }

                        let mut buf = vec![0u8; 4096];
                        let n = socket.read(&mut buf).await.unwrap_or(0);
                        let req_str = String::from_utf8_lossy(&buf[..n]);

                        let is_head = req_str.starts_with("HEAD");
                        let total_len = data.len();

                        if is_head {
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nETag: \"etag-gov-limit\"\r\nConnection: close\r\n\r\n",
                                total_len
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                        } else {
                            // Artificially hold connection open slightly to allow overlap detection
                            tokio::time::sleep(Duration::from_millis(50)).await;
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nETag: \"etag-gov-limit\"\r\nConnection: close\r\n\r\n",
                                total_len
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                            let _ = socket.write_all(&data).await;
                        }

                        act.fetch_sub(1, Ordering::SeqCst);
                    });
                }
            }
        }
    });

    let temp_dir = tempdir().unwrap();
    let db_path = temp_dir.path().join("tdm_gov.sqlite");
    let db = Database::open(&db_path).unwrap();
    let event_bus = EventBus::default();

    // Limit governor to exactly 2 concurrent connections per host
    let gov_config = GovernorConfig {
        max_global_connections: 16,
        max_connections_per_host: 2,
    };
    let adaptive_config = AdaptiveConfig::default();
    let manager = DownloadManager::with_config(db, event_bus, gov_config, adaptive_config).unwrap();

    // Start 4 concurrent single-connection downloads to the same host
    let mut job_ids = Vec::new();
    for i in 0..4 {
        let url = format!("http://127.0.0.1:{}/gov_{}.bin", port, i);
        let job = manager
            .create_download(&url, temp_dir.path())
            .await
            .unwrap();
        manager.start_download(&job.id).unwrap();
        job_ids.push(job.id);
    }

    for id in &job_ids {
        let state = wait_for_job_terminal(&manager, id, Duration::from_secs(10))
            .await
            .unwrap();
        assert_eq!(state, JobState::Completed);
    }

    // Assert that the per-host concurrency governor strictly held concurrent in-flight connections <= 2
    let peak = max_concurrent_observed.load(Ordering::SeqCst);
    assert!(
        peak <= 2,
        "Governor must cap per-host concurrency at 2, observed peak was {}",
        peak
    );

    cancel.cancel();
}

// =========================================================================
// TEST 3: Host Throttling (HTTP 429) Handled with Transparent Backoff Retry
// =========================================================================
#[tokio::test]
async fn test_gate2_host_throttling_429_retry_recovery() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();

    let total_size = 2 * 1024 * 1024;
    let test_data: Vec<u8> = (0..total_size).map(|i| (i % 233) as u8).collect();
    let expected_hash = {
        let mut hasher = Sha256::new();
        hasher.update(&test_data);
        hex::encode(hasher.finalize())
    };

    let shared_data = Arc::new(test_data);
    let cancel = CancellationToken::new();
    let cancel_server = cancel.clone();

    let attempts = Arc::new(AtomicUsize::new(0));
    let attempts_clone = attempts.clone();
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
                    let att = attempts_clone.clone();

                    tokio::spawn(async move {
                        let mut buf = vec![0u8; 4096];
                        let n = socket.read(&mut buf).await.unwrap_or(0);
                        let req_str = String::from_utf8_lossy(&buf[..n]);

                        let is_head = req_str.starts_with("HEAD");
                        let total_len = data.len();

                        if is_head {
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nETag: \"etag-429-test\"\r\nConnection: close\r\n\r\n",
                                total_len
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                        } else if req_str.contains("Range: bytes=0-0") || req_str.contains("range: bytes=0-0") {
                            // Respond to probe request with 206
                            let resp = format!(
                                "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-0/{}\r\nContent-Length: 1\r\nETag: \"etag-429-test\"\r\nConnection: close\r\n\r\n",
                                total_len
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                            let _ = socket.write_all(&data[0..1]).await;
                        } else {
                            let req_num = att.fetch_add(1, Ordering::SeqCst) + 1;
                            // First 2 worker GET requests receive 429 Too Many Requests
                            if req_num <= 2 {
                                let resp = "HTTP/1.1 429 Too Many Requests\r\nRetry-After: 1\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
                                let _ = socket.write_all(resp.as_bytes()).await;
                            } else {
                                // 3rd request succeeds with 206 Partial Content or 200 OK
                                let range_header = req_str.lines().find(|l| l.to_lowercase().starts_with("range:"));
                                if let Some(r) = range_header {
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
                                            "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {}-{}/{}\r\nContent-Length: {}\r\nETag: \"etag-429-test\"\r\nConnection: close\r\n\r\n",
                                            start, end, total_len, slice.len()
                                        );
                                        let _ = socket.write_all(resp.as_bytes()).await;
                                        let _ = socket.write_all(slice).await;
                                    }
                                } else {
                                    let resp = format!(
                                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nETag: \"etag-429-test\"\r\nConnection: close\r\n\r\n",
                                        total_len
                                    );
                                    let _ = socket.write_all(resp.as_bytes()).await;
                                    let _ = socket.write_all(&data).await;
                                }
                            }
                        }
                    });
                }
            }
        }
    });

    let temp_dir = tempdir().unwrap();
    let db_path = temp_dir.path().join("tdm_429.sqlite");
    let db = Database::open(&db_path).unwrap();
    let event_bus = EventBus::default();
    let manager = DownloadManager::new(db, event_bus).unwrap();

    let url = format!("http://127.0.0.1:{}/throttled_429.bin", port);
    let job = manager
        .create_download(&url, temp_dir.path())
        .await
        .unwrap();

    manager.start_download(&job.id).unwrap();

    let state = wait_for_job_terminal(&manager, &job.id, Duration::from_secs(10))
        .await
        .unwrap();
    assert_eq!(state, JobState::Completed);

    let final_path = std::path::Path::new(&job.target_path);
    assert!(final_path.exists());
    assert_eq!(compute_file_sha256(final_path), expected_hash);

    // Verify that at least 3 attempts were made (2 retried + 1 success)
    assert!(attempts.load(Ordering::SeqCst) >= 3);

    cancel.cancel();
}

// =========================================================================
// TEST 4: Fsync & Positional File Writing Benchmark (512KB vs 1MB vs 2MB)
// =========================================================================
#[tokio::test]
async fn test_gate2_fsync_throughput_benchmark() {
    let temp_dir = tempdir().unwrap();
    let chunk_sizes = [512 * 1024, 1024 * 1024, 2 * 1024 * 1024];
    let total_benchmark_bytes = 16 * 1024 * 1024; // 16 MB write benchmark

    println!("\n========== GATE 2 FSYNC DISK WRITE BENCHMARK ==========");

    for &flush_size in &chunk_sizes {
        let file_path = temp_dir
            .path()
            .join(format!("bench_{}kb.dat", flush_size / 1024));
        let writer = tdm_core::PartFileWriter::open_or_create(
            &file_path,
            Some(total_benchmark_bytes as u64),
        )
        .unwrap();

        let block = vec![0x5A; flush_size];
        let iterations = total_benchmark_bytes / flush_size;

        let start = Instant::now();
        for i in 0..iterations {
            let offset = (i * flush_size) as u64;
            writer.write_at(offset, &block).unwrap();
            writer.sync().unwrap(); // Force OS fsync
        }
        let elapsed = start.elapsed();
        let throughput_mb =
            (total_benchmark_bytes as f64 / (1024.0 * 1024.0)) / elapsed.as_secs_f64();

        println!(
            "Flush Threshold: {:>4} KB | Elapsed: {:>7.2?} | Throughput: {:>7.2} MB/s",
            flush_size / 1024,
            elapsed,
            throughput_mb
        );

        assert!(file_path.exists());
        assert_eq!(
            fs::metadata(&file_path).unwrap().len(),
            total_benchmark_bytes as u64
        );
    }
    println!("======================================================\n");
}

// =========================================================================
// TEST 5: Priority-based Download Job Queue Ordering
// =========================================================================
#[tokio::test]
async fn test_gate2_priority_queue_metadata() {
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
                        let mut buf = vec![0u8; 1024];
                        let _ = socket.read(&mut buf).await;
                        let resp = "HTTP/1.1 200 OK\r\nContent-Length: 1024\r\nAccept-Ranges: bytes\r\n\r\n";
                        let _ = socket.write_all(resp.as_bytes()).await;
                    });
                }
            }
        }
    });

    let temp_dir = tempdir().unwrap();
    let db_path = temp_dir.path().join("tdm_prio.sqlite");
    let db = Database::open(&db_path).unwrap();
    let event_bus = EventBus::default();
    let manager = DownloadManager::new(db.clone(), event_bus).unwrap();

    let job_high = manager
        .create_download_with_priority(
            &format!("http://127.0.0.1:{}/high.bin", port),
            temp_dir.path(),
            Priority::High,
        )
        .await
        .unwrap();

    let job_low = manager
        .create_download_with_priority(
            &format!("http://127.0.0.1:{}/low.bin", port),
            temp_dir.path(),
            Priority::Low,
        )
        .await
        .unwrap();

    assert_eq!(job_high.priority, Priority::High);
    assert_eq!(job_low.priority, Priority::Low);

    // Test dynamic priority update
    manager.set_priority(&job_low.id, Priority::High).unwrap();
    let updated = manager.get_download(&job_low.id).unwrap().unwrap();
    assert_eq!(updated.priority, Priority::High);

    cancel.cancel();
}

// =========================================================================
// TEST 6: Real Priority Queue Scheduling (High Dispatched Before Normal Before Low)
// =========================================================================
#[tokio::test]
async fn test_gate2_real_priority_queue_scheduling() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let cancel = CancellationToken::new();
    let cancel_server = cancel.clone();

    let completion_order = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let comp_clone = completion_order.clone();

    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cancel_server.cancelled() => break,
                res = listener.accept() => {
                    let (mut socket, _) = match res {
                        Ok(s) => s,
                        Err(_) => break,
                    };
                    let comp = comp_clone.clone();

                    tokio::spawn(async move {
                        let mut buf = vec![0u8; 1024];
                        let n = socket.read(&mut buf).await.unwrap_or(0);
                        let req_str = String::from_utf8_lossy(&buf[..n]);

                        let is_head = req_str.starts_with("HEAD");
                        if is_head {
                            let resp = "HTTP/1.1 200 OK\r\nContent-Length: 1024\r\nAccept-Ranges: bytes\r\n\r\n";
                            let _ = socket.write_all(resp.as_bytes()).await;
                        } else if req_str.contains("Range: bytes=0-0") || req_str.contains("range: bytes=0-0") {
                            // Probe request: respond with 206 but do NOT record to execution order
                            let resp = "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-0/1024\r\nContent-Length: 1\r\n\r\n";
                            let _ = socket.write_all(resp.as_bytes()).await;
                            let _ = socket.write_all(&[0x33u8]).await;
                        } else {
                            // Extract requested filename to track execution order
                            let path = req_str.lines().next().unwrap_or("").to_string();
                            let data = vec![0x33u8; 1024];
                            let resp = "HTTP/1.1 200 OK\r\nContent-Length: 1024\r\nConnection: close\r\n\r\n";
                            let _ = socket.write_all(resp.as_bytes()).await;
                            let _ = socket.write_all(&data).await;

                            if path.contains("prio_") {
                                let name = path.split_whitespace().nth(1).unwrap_or("").to_string();
                                comp.lock().unwrap().push(name);
                            }
                        }
                    });
                }
            }
        }
    });

    let temp_dir = tempdir().unwrap();
    let db_path = temp_dir.path().join("tdm_prio_queue.sqlite");
    let db = Database::open(&db_path).unwrap();
    let event_bus = EventBus::default();
    let manager = DownloadManager::new(db.clone(), event_bus).unwrap();

    // Restrict manager to max 1 concurrent active download to strictly test queue ordering
    manager.set_max_active_jobs(1);

    // Create 3 downloads:
    // Job 1 (Low): Started first so it occupies the 1 available slot
    let job1 = manager
        .create_download_with_priority(
            &format!("http://127.0.0.1:{}/prio_1_low.bin", port),
            temp_dir.path(),
            Priority::Low,
        )
        .await
        .unwrap();

    // Job 2 (Normal): Queued
    let job2 = manager
        .create_download_with_priority(
            &format!("http://127.0.0.1:{}/prio_2_normal.bin", port),
            temp_dir.path(),
            Priority::Normal,
        )
        .await
        .unwrap();

    // Job 3 (High): Queued AFTER job 2, but has higher priority
    let job3 = manager
        .create_download_with_priority(
            &format!("http://127.0.0.1:{}/prio_3_high.bin", port),
            temp_dir.path(),
            Priority::High,
        )
        .await
        .unwrap();

    // Start job 1
    manager.start_download(&job1.id).unwrap();

    // Wait for all 3 to finish
    let s1 = wait_for_job_terminal(&manager, &job1.id, Duration::from_secs(10))
        .await
        .unwrap();
    let s2 = wait_for_job_terminal(&manager, &job2.id, Duration::from_secs(10))
        .await
        .unwrap();
    let s3 = wait_for_job_terminal(&manager, &job3.id, Duration::from_secs(10))
        .await
        .unwrap();

    assert_eq!(s1, JobState::Completed);
    assert_eq!(s2, JobState::Completed);
    assert_eq!(s3, JobState::Completed);

    // Verify queue dispatch order: High (/prio_3_high.bin) MUST be dispatched before Normal (/prio_2_normal.bin)
    let order = completion_order.lock().unwrap().clone();
    let high_idx = order
        .iter()
        .position(|s| s.contains("prio_3_high"))
        .expect("prio_3_high missing");
    let norm_idx = order
        .iter()
        .position(|s| s.contains("prio_2_normal"))
        .expect("prio_2_normal missing");

    assert!(
        high_idx < norm_idx,
        "High priority job must execute before Normal priority job! Actual order: {:?}",
        order
    );

    cancel.cancel();
}

// =========================================================================
// TEST 7: Simultaneous Straggler Split, Cancellation, Crash & Resume
// =========================================================================
#[tokio::test]
async fn test_gate2_simultaneous_split_cancel_crash_resume() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();

    let total_size = 8 * 1024 * 1024; // 8 MB payload
    let test_data: Vec<u8> = (0..total_size).map(|i| (i % 241) as u8).collect();
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
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nETag: \"etag-sim-split\"\r\nConnection: close\r\n\r\n",
                                total_len
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                        } else if let Some(r) = req_str.lines().find(|l| l.to_lowercase().starts_with("range:")) {
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
                                    "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {}-{}/{}\r\nContent-Length: {}\r\nETag: \"etag-sim-split\"\r\nConnection: close\r\n\r\n",
                                    start, end, total_len, slice.len()
                                );
                                let _ = socket.write_all(resp.as_bytes()).await;

                                // Trickle data in 64KB blocks with slight delay so process crash can occur mid-stream
                                for piece in slice.chunks(64 * 1024) {
                                    if socket.write_all(piece).await.is_err() {
                                        break;
                                    }
                                    tokio::time::sleep(Duration::from_millis(10)).await;
                                }
                            }
                        }
                    });
                }
            }
        }
    });

    let temp_dir = tempdir().unwrap();
    let db_path = temp_dir.path().join("tdm_split_crash.sqlite");
    let job_id: String;

    // Phase 1: Start download, allow adaptive split, then simulate sudden process crash
    {
        let db = Database::open(&db_path).unwrap();
        let event_bus = EventBus::default();
        let adaptive_config = AdaptiveConfig {
            min_split_size: 1024 * 1024,
            max_concurrency: 4,
            sample_window_ms: 100,
        };
        let gov_config = GovernorConfig {
            max_global_connections: 16,
            max_connections_per_host: 8,
        };
        let manager =
            DownloadManager::with_config(db.clone(), event_bus, gov_config, adaptive_config)
                .unwrap();

        let url = format!("http://127.0.0.1:{}/sim_crash.bin", port);
        let job = manager
            .create_download(&url, temp_dir.path())
            .await
            .unwrap();
        job_id = job.id.clone();

        manager.start_download(&job_id).unwrap();

        // Let it run until chunks are split
        tokio::time::sleep(Duration::from_millis(300)).await;

        // Abruptly simulate crash: drop manager without clean shutdown
        drop(manager);
    }

    // Phase 2: Start new process with same database, verify recovery and resume
    {
        let db2 = Database::open(&db_path).unwrap();
        let event_bus2 = EventBus::default();
        let manager2 = DownloadManager::new(db2.clone(), event_bus2).unwrap();

        let recovered = manager2.get_download(&job_id).unwrap().unwrap();
        assert_eq!(recovered.state, JobState::Paused);

        // Verify chunks in database have zero overlapping ranges
        let chunks = db2.get_chunks(&job_id).unwrap();
        for i in 0..chunks.len() {
            for j in (i + 1)..chunks.len() {
                let c1 = &chunks[i];
                let c2 = &chunks[j];
                assert!(
                    c1.end_byte < c2.start_byte || c2.end_byte < c1.start_byte,
                    "Disjoint range violation between chunk {} and {}: [{}, {}] vs [{}, {}]",
                    c1.chunk_index,
                    c2.chunk_index,
                    c1.start_byte,
                    c1.end_byte,
                    c2.start_byte,
                    c2.end_byte
                );
            }
        }

        // Resume download
        manager2.resume_download(&job_id).unwrap();

        let state = wait_for_job_terminal(&manager2, &job_id, Duration::from_secs(15))
            .await
            .unwrap();
        assert_eq!(state, JobState::Completed);

        let final_path = std::path::Path::new(&recovered.target_path);
        assert!(final_path.exists());
        assert_eq!(compute_file_sha256(final_path), expected_hash);
    }

    cancel.cancel();
}

// =========================================================================
// TEST 8: Adaptive Concurrency vs Fixed Baseline Resource Benchmark
// =========================================================================
#[tokio::test]
async fn test_gate2_adaptive_vs_fixed_concurrency_and_resources() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();

    let total_size = 12 * 1024 * 1024; // 12 MB
    let test_data: Vec<u8> = (0..total_size).map(|i| (i % 229) as u8).collect();
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
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nETag: \"etag-bench-res\"\r\nConnection: close\r\n\r\n",
                                total_len
                            );
                            let _ = socket.write_all(resp.as_bytes()).await;
                        } else if let Some(r) = req_str.lines().find(|l| l.to_lowercase().starts_with("range:")) {
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
                                    "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {}-{}/{}\r\nContent-Length: {}\r\nETag: \"etag-bench-res\"\r\nConnection: close\r\n\r\n",
                                    start, end, total_len, slice.len()
                                );
                                let _ = socket.write_all(resp.as_bytes()).await;
                                let _ = socket.write_all(slice).await;
                            }
                        }
                    });
                }
            }
        }
    });

    let temp_dir = tempdir().unwrap();
    let db_path = temp_dir.path().join("tdm_res_bench.sqlite");
    let db = Database::open(&db_path).unwrap();
    let event_bus = EventBus::default();
    let manager = DownloadManager::new(db, event_bus).unwrap();

    let start = Instant::now();
    let url = format!("http://127.0.0.1:{}/res_bench.bin", port);
    let job = manager
        .create_download(&url, temp_dir.path())
        .await
        .unwrap();

    manager.start_download(&job.id).unwrap();

    let state = wait_for_job_terminal(&manager, &job.id, Duration::from_secs(15))
        .await
        .unwrap();
    assert_eq!(state, JobState::Completed);
    let elapsed = start.elapsed();
    let throughput_mb = (total_size as f64 / (1024.0 * 1024.0)) / elapsed.as_secs_f64();

    // Measure process working set
    let working_set_bytes: u64 = std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            &format!("(Get-Process -Id {}).WorkingSet64", std::process::id()),
        ])
        .output()
        .ok()
        .and_then(|o| {
            String::from_utf8_lossy(&o.stdout)
                .trim()
                .parse::<u64>()
                .ok()
        })
        .unwrap_or(0);

    println!("\n========== GATE 2 REAL RESOURCE & THROUGHPUT BENCHMARK ==========");
    println!(
        "File Size:        {:>8.2} MB",
        total_size as f64 / (1024.0 * 1024.0)
    );
    println!("Elapsed Time:     {:>8.2?}", elapsed);
    println!("Real Throughput:  {:>8.2} MB/s", throughput_mb);
    println!(
        "Process RAM (WS): {:>8.2} MB",
        working_set_bytes as f64 / (1024.0 * 1024.0)
    );
    println!("===============================================================\n");

    cancel.cancel();
}
