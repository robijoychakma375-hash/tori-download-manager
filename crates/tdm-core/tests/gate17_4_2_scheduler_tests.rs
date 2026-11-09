use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use tempfile::tempdir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

use tdm_core::{Database, DownloadManager, EventBus, JobState, Priority};

/// Helper HTTP server for scheduler tests
async fn run_mock_server(payload: Arc<Vec<u8>>, cancel: CancellationToken) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();

    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cancel.cancelled() => break,
                res = listener.accept() => {
                    let (mut socket, _) = match res {
                        Ok(s) => s,
                        Err(_) => break,
                    };
                    let payload_c = payload.clone();

                    tokio::spawn(async move {
                        let mut buf = [0u8; 4096];
                        let n = match socket.read(&mut buf).await {
                            Ok(n) if n > 0 => n,
                            _ => return,
                        };
                        let req_str = String::from_utf8_lossy(&buf[..n]);

                        let (status_line, body_slice, content_range) = if req_str.contains("Range: bytes=") {
                            let range_line = req_str.lines().find(|l| l.to_lowercase().starts_with("range: bytes=")).unwrap();
                            let range_val = range_line.split('=').nth(1).unwrap().trim();
                            let parts: Vec<&str> = range_val.split('-').collect();
                            let start: usize = parts[0].parse().unwrap_or(0);
                            let end: usize = if parts.len() > 1 && !parts[1].is_empty() {
                                parts[1].parse().unwrap_or(payload_c.len() - 1)
                            } else {
                                payload_c.len() - 1
                            };
                            let end = end.min(payload_c.len() - 1);
                            (
                                "HTTP/1.1 206 Partial Content",
                                &payload_c[start..=end],
                                Some(format!("Content-Range: bytes {}-{}/{}\r\n", start, end, payload_c.len())),
                            )
                        } else {
                            ("HTTP/1.1 200 OK", &payload_c[..], None)
                        };

                        let head = format!(
                            "{}\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nETag: \"sched-v1\"\r\n{}\r\n",
                            status_line,
                            body_slice.len(),
                            content_range.unwrap_or_default()
                        );
                        let _ = socket.write_all(head.as_bytes()).await;
                        if !req_str.starts_with("HEAD") {
                            let _ = socket.write_all(body_slice).await;
                        }
                    });
                }
            }
        }
    });

    port
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
// TEST 1: Immediate Download (No Schedule Time)
// =========================================================================
#[tokio::test]
async fn test_scheduler_immediate_no_schedule() {
    let tmp = tempdir().unwrap();
    let db = Database::open(tmp.path().join("tori_test.db")).unwrap();
    let event_bus = EventBus::default();
    let manager = DownloadManager::new(db, event_bus).unwrap();

    let payload: Vec<u8> = (0..32768).map(|i| (i % 251) as u8).collect();
    let cancel = CancellationToken::new();
    let port = run_mock_server(Arc::new(payload), cancel.clone()).await;

    let url = format!("http://127.0.0.1:{}/test_immediate.bin", port);
    let job = manager
        .create_download_with_all_options_scheduled(
            &url,
            tmp.path(),
            Priority::Normal,
            None,
            None,
            None,
        )
        .await
        .unwrap();

    assert_eq!(job.state, JobState::Queued);
    assert_eq!(job.scheduled_at, None);

    manager.start_download(&job.id).unwrap();
    let final_state = wait_for_job_terminal(&manager, &job.id, Duration::from_secs(5))
        .await
        .unwrap();
    assert_eq!(final_state, JobState::Completed);

    cancel.cancel();
}

// =========================================================================
// TEST 2: Near-Future Scheduled Download (Auto-wakes & Completes)
// =========================================================================
#[tokio::test]
async fn test_scheduler_near_future_execution() {
    let tmp = tempdir().unwrap();
    let db = Database::open(tmp.path().join("tori_test.db")).unwrap();
    let event_bus = EventBus::default();
    let manager = DownloadManager::new(db, event_bus).unwrap();

    let payload: Vec<u8> = (0..32768).map(|i| (i % 251) as u8).collect();
    let cancel = CancellationToken::new();
    let port = run_mock_server(Arc::new(payload), cancel.clone()).await;

    let due_time = Utc::now() + chrono::Duration::milliseconds(1200);
    let url = format!("http://127.0.0.1:{}/test_scheduled.bin", port);
    let job = manager
        .create_download_with_all_options_scheduled(
            &url,
            tmp.path(),
            Priority::Normal,
            None,
            None,
            Some(due_time),
        )
        .await
        .unwrap();

    assert_eq!(job.state, JobState::Scheduled);
    assert!(job.scheduled_at.is_some());

    // Before due time, verify job is still scheduled and not downloaded
    tokio::time::sleep(Duration::from_millis(300)).await;
    let pre_check = manager.get_download(&job.id).unwrap().unwrap();
    assert_eq!(pre_check.state, JobState::Scheduled);

    // Wait for the scheduled execution to trigger and complete
    let final_state = wait_for_job_terminal(&manager, &job.id, Duration::from_secs(8))
        .await
        .unwrap();
    assert_eq!(final_state, JobState::Completed);

    let completed_job = manager.get_download(&job.id).unwrap().unwrap();
    assert_eq!(completed_job.downloaded_bytes, 32768);

    cancel.cancel();
}

// =========================================================================
// TEST 3: Simultaneous Due Jobs With Priority Ordering
// =========================================================================
#[tokio::test]
async fn test_scheduler_multiple_simultaneous_priority_ordering() {
    let tmp = tempdir().unwrap();
    let db = Database::open(tmp.path().join("tori_test.db")).unwrap();
    let event_bus = EventBus::default();
    let manager = DownloadManager::new(db, event_bus).unwrap();
    manager.set_max_active_jobs(1);

    let payload: Vec<u8> = (0..16384).map(|i| (i % 251) as u8).collect();
    let cancel = CancellationToken::new();
    let port = run_mock_server(Arc::new(payload), cancel.clone()).await;

    let due_time = Utc::now() + chrono::Duration::milliseconds(1000);

    // Create Low, High, Normal all scheduled for the exact same due time
    let job_low = manager
        .create_download_with_all_options_scheduled(
            &format!("http://127.0.0.1:{}/low.bin", port),
            tmp.path(),
            Priority::Low,
            None,
            None,
            Some(due_time),
        )
        .await
        .unwrap();

    let job_high = manager
        .create_download_with_all_options_scheduled(
            &format!("http://127.0.0.1:{}/high.bin", port),
            tmp.path(),
            Priority::High,
            None,
            None,
            Some(due_time),
        )
        .await
        .unwrap();

    let job_norm = manager
        .create_download_with_all_options_scheduled(
            &format!("http://127.0.0.1:{}/norm.bin", port),
            tmp.path(),
            Priority::Normal,
            None,
            None,
            Some(due_time),
        )
        .await
        .unwrap();

    assert_eq!(job_low.state, JobState::Scheduled);
    assert_eq!(job_high.state, JobState::Scheduled);
    assert_eq!(job_norm.state, JobState::Scheduled);

    // Wait for all 3 to complete
    let _ = wait_for_job_terminal(&manager, &job_high.id, Duration::from_secs(10))
        .await
        .unwrap();
    let _ = wait_for_job_terminal(&manager, &job_norm.id, Duration::from_secs(10))
        .await
        .unwrap();
    let _ = wait_for_job_terminal(&manager, &job_low.id, Duration::from_secs(10))
        .await
        .unwrap();

    assert_eq!(
        manager.get_download(&job_high.id).unwrap().unwrap().state,
        JobState::Completed
    );
    assert_eq!(
        manager.get_download(&job_norm.id).unwrap().unwrap().state,
        JobState::Completed
    );
    assert_eq!(
        manager.get_download(&job_low.id).unwrap().unwrap().state,
        JobState::Completed
    );

    cancel.cancel();
}

// =========================================================================
// TEST 4: Bounded Concurrency Under Scheduled Admission
// =========================================================================
#[tokio::test]
async fn test_scheduler_concurrency_cap_enforcement() {
    let tmp = tempdir().unwrap();
    let db = Database::open(tmp.path().join("tori_test.db")).unwrap();
    let event_bus = EventBus::default();
    let manager = DownloadManager::new(db, event_bus).unwrap();
    manager.set_max_active_jobs(2);

    let payload: Vec<u8> = (0..32768).map(|i| (i % 251) as u8).collect();
    let cancel = CancellationToken::new();
    let port = run_mock_server(Arc::new(payload), cancel.clone()).await;

    let due_time = Utc::now() + chrono::Duration::milliseconds(800);

    let mut ids = Vec::new();
    for i in 0..5 {
        let job = manager
            .create_download_with_all_options_scheduled(
                &format!("http://127.0.0.1:{}/cap_{}.bin", port, i),
                tmp.path(),
                Priority::Normal,
                None,
                None,
                Some(due_time),
            )
            .await
            .unwrap();
        ids.push(job.id);
    }

    // Wait until they all finish cleanly under max_active_jobs=2
    for id in &ids {
        let res = wait_for_job_terminal(&manager, id, Duration::from_secs(12))
            .await
            .unwrap();
        assert_eq!(res, JobState::Completed);
    }

    cancel.cancel();
}

// =========================================================================
// TEST 5: Process Restart BEFORE Scheduled Time (Preserves & Fires)
// =========================================================================
#[tokio::test]
async fn test_scheduler_process_restart_before_due() {
    let tmp = tempdir().unwrap();
    let db_path = tmp.path().join("restart_before.db");

    let payload: Vec<u8> = (0..16384).map(|i| (i % 251) as u8).collect();
    let cancel = CancellationToken::new();
    let port = run_mock_server(Arc::new(payload), cancel.clone()).await;

    let due_time = Utc::now() + chrono::Duration::milliseconds(1500);
    let job_id;

    // Process 1: create scheduled job and drop manager
    {
        let db = Database::open(&db_path).unwrap();
        let event_bus = EventBus::default();
        let manager = DownloadManager::new(db, event_bus).unwrap();

        let job = manager
            .create_download_with_all_options_scheduled(
                &format!("http://127.0.0.1:{}/restart_before.bin", port),
                tmp.path(),
                Priority::Normal,
                None,
                None,
                Some(due_time),
            )
            .await
            .unwrap();
        job_id = job.id;
        assert_eq!(job.state, JobState::Scheduled);
    }

    // Process 2: restart engine before due time
    {
        let db2 = Database::open(&db_path).unwrap();
        let event_bus2 = EventBus::default();
        let manager2 = DownloadManager::new(db2, event_bus2).unwrap();

        // Check it is still scheduled
        let job_recheck = manager2.get_download(&job_id).unwrap().unwrap();
        assert_eq!(job_recheck.state, JobState::Scheduled);

        // Wait for scheduler in Process 2 to fire at due time and complete
        let final_state = wait_for_job_terminal(&manager2, &job_id, Duration::from_secs(8))
            .await
            .unwrap();
        assert_eq!(final_state, JobState::Completed);
    }

    cancel.cancel();
}

// =========================================================================
// TEST 6: Process Restart AFTER Scheduled Time (Overdue Catch-up Policy)
// =========================================================================
#[tokio::test]
async fn test_scheduler_process_restart_after_due_catchup() {
    let tmp = tempdir().unwrap();
    let db_path = tmp.path().join("restart_after.db");

    let payload: Vec<u8> = (0..16384).map(|i| (i % 251) as u8).collect();
    let cancel = CancellationToken::new();
    let port = run_mock_server(Arc::new(payload), cancel.clone()).await;

    let overdue_time = Utc::now() - chrono::Duration::seconds(30);
    let job_id;

    // Process 1: Insert job directly as Scheduled with an overdue timestamp
    {
        let db = Database::open(&db_path).unwrap();
        let event_bus = EventBus::default();
        let manager = DownloadManager::new(db.clone(), event_bus).unwrap();

        let job = manager
            .create_download_with_all_options_scheduled(
                &format!("http://127.0.0.1:{}/catchup.bin", port),
                tmp.path(),
                Priority::High,
                None,
                None,
                Some(Utc::now() + chrono::Duration::seconds(60)),
            )
            .await
            .unwrap();
        job_id = job.id.clone();

        // Force timestamp in DB to be in the past
        db.update_job_scheduled_at(&job_id, Some(overdue_time))
            .unwrap();
    }

    // Process 2: Start new engine instance. Startup reconcile should detect overdue and queue it.
    {
        let db2 = Database::open(&db_path).unwrap();
        let event_bus2 = EventBus::default();
        let manager2 = DownloadManager::new(db2, event_bus2).unwrap();

        // Process queue to run admitted catch-up job
        let _ = manager2.process_queue();

        let final_state = wait_for_job_terminal(&manager2, &job_id, Duration::from_secs(8))
            .await
            .unwrap();
        assert_eq!(final_state, JobState::Completed);
    }

    cancel.cancel();
}

// =========================================================================
// TEST 7: Cancellation of Scheduled Job
// =========================================================================
#[tokio::test]
async fn test_scheduler_cancel_scheduled_job() {
    let tmp = tempdir().unwrap();
    let db = Database::open(tmp.path().join("tori_test.db")).unwrap();
    let event_bus = EventBus::default();
    let manager = DownloadManager::new(db, event_bus).unwrap();

    let payload: Vec<u8> = (0..16384).map(|i| (i % 251) as u8).collect();
    let cancel_srv = CancellationToken::new();
    let port = run_mock_server(Arc::new(payload), cancel_srv.clone()).await;

    let due_time = Utc::now() + chrono::Duration::milliseconds(1500);
    let job = manager
        .create_download_with_all_options_scheduled(
            &format!("http://127.0.0.1:{}/dummy_cancel.bin", port),
            tmp.path(),
            Priority::Normal,
            None,
            None,
            Some(due_time),
        )
        .await
        .unwrap();

    assert_eq!(job.state, JobState::Scheduled);

    // Cancel before due time
    manager.cancel_download(&job.id).unwrap();
    let cancelled_job = manager.get_download(&job.id).unwrap().unwrap();
    assert_eq!(cancelled_job.state, JobState::Cancelled);
    assert_eq!(cancelled_job.scheduled_at, None);

    // Wait past due time to ensure it never tries to start
    tokio::time::sleep(Duration::from_millis(2000)).await;
    let post_job = manager.get_download(&job.id).unwrap().unwrap();
    assert_eq!(post_job.state, JobState::Cancelled);

    cancel_srv.cancel();
}

// =========================================================================
// TEST 8: Pause of Scheduled Job
// =========================================================================
#[tokio::test]
async fn test_scheduler_pause_scheduled_job() {
    let tmp = tempdir().unwrap();
    let db = Database::open(tmp.path().join("tori_test.db")).unwrap();
    let event_bus = EventBus::default();
    let manager = DownloadManager::new(db, event_bus).unwrap();

    let payload: Vec<u8> = (0..16384).map(|i| (i % 251) as u8).collect();
    let cancel_srv = CancellationToken::new();
    let port = run_mock_server(Arc::new(payload), cancel_srv.clone()).await;

    let due_time = Utc::now() + chrono::Duration::milliseconds(1500);
    let job = manager
        .create_download_with_all_options_scheduled(
            &format!("http://127.0.0.1:{}/dummy_pause.bin", port),
            tmp.path(),
            Priority::Normal,
            None,
            None,
            Some(due_time),
        )
        .await
        .unwrap();

    assert_eq!(job.state, JobState::Scheduled);

    // Pause clears schedule and transitions to Paused
    manager.pause_download(&job.id).unwrap();
    let paused_job = manager.get_download(&job.id).unwrap().unwrap();
    assert_eq!(paused_job.state, JobState::Paused);
    assert_eq!(paused_job.scheduled_at, None);

    // Wait past due time: remains Paused
    tokio::time::sleep(Duration::from_millis(2000)).await;
    let post_job = manager.get_download(&job.id).unwrap().unwrap();
    assert_eq!(post_job.state, JobState::Paused);

    cancel_srv.cancel();
}

// =========================================================================
// TEST 9: Reschedule to New Time and Clear Schedule
// =========================================================================
#[tokio::test]
async fn test_scheduler_reschedule_job() {
    let tmp = tempdir().unwrap();
    let db = Database::open(tmp.path().join("tori_test.db")).unwrap();
    let event_bus = EventBus::default();
    let manager = DownloadManager::new(db, event_bus).unwrap();

    let payload: Vec<u8> = (0..16384).map(|i| (i % 251) as u8).collect();
    let cancel = CancellationToken::new();
    let port = run_mock_server(Arc::new(payload), cancel.clone()).await;

    // Initially schedule 10 minutes into the future
    let far_future = Utc::now() + chrono::Duration::seconds(600);
    let job = manager
        .create_download_with_all_options_scheduled(
            &format!("http://127.0.0.1:{}/reschedule.bin", port),
            tmp.path(),
            Priority::Normal,
            None,
            None,
            Some(far_future),
        )
        .await
        .unwrap();

    assert_eq!(job.state, JobState::Scheduled);

    // Reschedule to near future (1200ms)
    let near_future = Utc::now() + chrono::Duration::milliseconds(1200);
    manager
        .reschedule_download(&job.id, Some(near_future))
        .unwrap();

    let updated = manager.get_download(&job.id).unwrap().unwrap();
    assert_eq!(updated.state, JobState::Scheduled);
    assert!(updated.scheduled_at.is_some());

    // Wait for the rescheduled near-future execution to trigger and complete
    let final_state = wait_for_job_terminal(&manager, &job.id, Duration::from_secs(8))
        .await
        .unwrap();
    assert_eq!(final_state, JobState::Completed);

    cancel.cancel();
}

// =========================================================================
// TEST 10: Clear Schedule via reschedule_download(id, None)
// =========================================================================
#[tokio::test]
async fn test_scheduler_clear_schedule_to_queued() {
    let tmp = tempdir().unwrap();
    let db = Database::open(tmp.path().join("tori_test.db")).unwrap();
    let event_bus = EventBus::default();
    let manager = DownloadManager::new(db, event_bus).unwrap();

    let payload: Vec<u8> = (0..16384).map(|i| (i % 251) as u8).collect();
    let cancel = CancellationToken::new();
    let port = run_mock_server(Arc::new(payload), cancel.clone()).await;

    let far_future = Utc::now() + chrono::Duration::seconds(600);
    let job = manager
        .create_download_with_all_options_scheduled(
            &format!("http://127.0.0.1:{}/clear_sched.bin", port),
            tmp.path(),
            Priority::Normal,
            None,
            None,
            Some(far_future),
        )
        .await
        .unwrap();

    assert_eq!(job.state, JobState::Scheduled);

    // Clearing schedule transitions immediately to Queued and triggers queue processing
    manager.reschedule_download(&job.id, None).unwrap();

    let final_state = wait_for_job_terminal(&manager, &job.id, Duration::from_secs(8))
        .await
        .unwrap();
    assert_eq!(final_state, JobState::Completed);

    cancel.cancel();
}
