use std::sync::Arc;
use std::time::{Duration, Instant};

use tempfile::tempdir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

use tdm_core::{
    Database, DownloadCompletionOptions, DownloadManager, EventBus, JobState, Priority,
};

async fn start_range_server(payload: Arc<Vec<u8>>) -> (u16, CancellationToken) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let cancel = CancellationToken::new();
    let cancel_srv = cancel.clone();

    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cancel_srv.cancelled() => break,
                accepted = listener.accept() => {
                    let (mut stream, _) = match accepted {
                        Ok(s) => s,
                        Err(_) => break,
                    };
                    let data = payload.clone();
                    tokio::spawn(async move {
                        let mut buf = [0u8; 4096];
                        let n = match stream.read(&mut buf).await {
                            Ok(n) if n > 0 => n,
                            _ => return,
                        };
                        let req = String::from_utf8_lossy(&buf[..n]);
                        let first_line = req.lines().next().unwrap_or("");
                        let method = first_line.split_whitespace().next().unwrap_or("GET");
                        let total = data.len();

                        let mut range_bounds: Option<(usize, usize)> = None;
                        for line in req.lines() {
                            if let Some((k, v)) = line.split_once(':') {
                                if k.trim().eq_ignore_ascii_case("Range") {
                                    if let Some(spec) = v.trim().strip_prefix("bytes=") {
                                        if let Some((s_str, e_str)) = spec.split_once('-') {
                                            if let Ok(start) = s_str.trim().parse::<usize>() {
                                                let end = e_str
                                                    .trim()
                                                    .parse::<usize>()
                                                    .ok()
                                                    .unwrap_or_else(|| total.saturating_sub(1))
                                                    .min(total.saturating_sub(1));
                                                if start <= end && start < total {
                                                    range_bounds = Some((start, end));
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        if let Some((start, end)) = range_bounds {
                            let slice = &data[start..=end];
                            let hdr = format!(
                                "HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes {}-{}/{}\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\r\n",
                                slice.len(),
                                start,
                                end,
                                total
                            );
                            let _ = stream.write_all(hdr.as_bytes()).await;
                            if method != "HEAD" {
                                let _ = stream.write_all(slice).await;
                            }
                        } else {
                            let hdr = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\r\n",
                                total
                            );
                            let _ = stream.write_all(hdr.as_bytes()).await;
                            if method != "HEAD" {
                                let _ = stream.write_all(&data).await;
                            }
                        }
                        let _ = stream.flush().await;
                    });
                }
            }
        }
    });

    (port, cancel)
}

#[tokio::test]
async fn test_completion_options_and_job_speed_limit_persistence_and_cleanup() {
    let tmp = tempdir().unwrap();
    let db = Database::open(tmp.path().join("test.sqlite")).unwrap();
    let bus = EventBus::default();
    let mgr = DownloadManager::new(db, bus).unwrap();

    let payload = Arc::new(vec![0x5Au8; 64 * 1024]);
    let (port, cancel) = start_range_server(payload).await;
    let url = format!("http://127.0.0.1:{}/sample.bin", port);
    let job = mgr
        .create_download_with_all_options_scheduled(&url, tmp.path(), Priority::Normal, None, None, None)
        .await
        .unwrap();

    mgr.set_job_speed_limit(&job.id, 128_000).unwrap();
    assert_eq!(mgr.job_speed_limit(&job.id), 128_000);

    let opts = DownloadCompletionOptions {
        close_on_complete: true,
        notify_on_complete: true,
        open_on_complete: false,
    };
    mgr.set_completion_options(&job.id, &opts).unwrap();
    let loaded = mgr.get_completion_options(&job.id);
    assert!(loaded.close_on_complete);
    assert!(loaded.notify_on_complete);
    assert!(!loaded.open_on_complete);

    let details = mgr.get_download_status_details(&job.id).unwrap();
    assert_eq!(details.job_speed_limit_bps, 128_000);
    assert!(!details.chunks.is_empty());

    mgr.delete_download(&job.id, true).unwrap();
    assert_eq!(mgr.job_speed_limit(&job.id), 0);
    let after_del = mgr.get_completion_options(&job.id);
    assert!(!after_del.close_on_complete && !after_del.notify_on_complete && !after_del.open_on_complete);

    cancel.cancel();
}

#[tokio::test]
async fn test_per_download_speed_limiter_throttles_without_affecting_global() {
    let tmp = tempdir().unwrap();
    let db = Database::open(tmp.path().join("throttle.sqlite")).unwrap();
    let bus = EventBus::default();
    let mgr = DownloadManager::new(db, bus).unwrap();

    // 700 KB payload: at 200_000 B/s (with ~200 KB initial bucket), remaining 500 KB takes ~2.5s
    let payload = Arc::new(vec![0xA5u8; 700 * 1024]);
    let (port, cancel) = start_range_server(payload.clone()).await;
    let url = format!("http://127.0.0.1:{}/limited.bin", port);
    let job = mgr
        .create_download_with_all_options_scheduled(&url, tmp.path(), Priority::Normal, None, None, None)
        .await
        .unwrap();

    mgr.set_job_speed_limit(&job.id, 200_000).unwrap();
    assert_eq!(mgr.speed_limit(), 0, "Global limiter must remain unlimited (0)");

    let started = Instant::now();
    mgr.start_download(&job.id).unwrap();

    let mut saw_active_details = false;
    let mut completed = false;
    for _ in 0..100 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        if let Ok(d) = mgr.get_download_status_details(&job.id) {
            if d.active_connections > 0 {
                saw_active_details = true;
            }
        }
        if let Ok(Some(j)) = mgr.get_download(&job.id) {
            if j.state == JobState::Completed {
                completed = true;
                break;
            }
        }
    }

    let elapsed = started.elapsed();
    assert!(completed, "Download should complete within timeout");
    assert!(
        elapsed.as_secs_f64() >= 1.8,
        "Per-download limiter (200 KB/s on 700 KB) should throttle duration (>=1.8s), got {:.2}s",
        elapsed.as_secs_f64()
    );
    assert!(saw_active_details, "Live status details must report >0 active connections during transfer");

    let disk_bytes = std::fs::read(&job.target_path).unwrap();
    assert_eq!(disk_bytes.len(), payload.len());
    cancel.cancel();
}
