use std::fs;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};
use tempfile::tempdir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

use std::path::Path;
use tdm_core::engine::planner::plan_chunks_with_concurrency;
use tdm_core::engine::writer::{verify_chunks_complete_and_contiguous, PartFileWriter};
use tdm_core::{Database, DownloadEvent, DownloadManager, EventBus, JobState, Priority};

/// Deterministic pseudo-random byte generator for any 64-bit offset so we can
/// stream and verify multi-gigabyte ranges without allocating multi-GB RAM buffers.
#[inline]
fn pattern_byte_at(offset: u64) -> u8 {
    ((offset.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407)) >> 56) as u8
}

fn fill_pattern_slice(start_offset: u64, buf: &mut [u8]) {
    for (i, b) in buf.iter_mut().enumerate() {
        *b = pattern_byte_at(start_offset + i as u64);
    }
}

/// Starts a high-throughput local HTTP/1.1 Range server capable of serving arbitrary 64-bit
/// `virtual_size` files (100 MB, 1 GB, 5 GB, 10 GB, 50 GB) using deterministic byte generation.
async fn start_virtual_range_server(
    virtual_size: u64,
    probe_delay_ms: u64,
    chunk_delay_ms: u64,
    fail_secondary_range_once: bool,
) -> (u16, CancellationToken, Arc<AtomicUsize>, Arc<AtomicUsize>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let cancel = CancellationToken::new();
    let cancel_srv = cancel.clone();

    let head_requests = Arc::new(AtomicUsize::new(0));
    let range_requests = Arc::new(AtomicUsize::new(0));
    let injected_429 = Arc::new(AtomicBool::new(false));

    let head_c = head_requests.clone();
    let range_c = range_requests.clone();

    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cancel_srv.cancelled() => break,
                res = listener.accept() => {
                    let (mut socket, _) = match res {
                        Ok(s) => s,
                        Err(_) => break,
                    };
                    let head_counter = head_c.clone();
                    let range_counter = range_c.clone();
                    let inj_429 = injected_429.clone();

                    tokio::spawn(async move {
                        let mut buf = [0u8; 2048];
                        let n = socket.read(&mut buf).await.unwrap_or(0);
                        if n == 0 {
                            return;
                        }
                        let req = String::from_utf8_lossy(&buf[..n]);

                        if req.starts_with("HEAD ") {
                            head_counter.fetch_add(1, Ordering::SeqCst);
                            if probe_delay_ms > 0 {
                                tokio::time::sleep(Duration::from_millis(probe_delay_ms)).await;
                            }
                            let hdr = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nETag: \"gate26-etag-{}\"\r\nConnection: close\r\n\r\n",
                                virtual_size, virtual_size
                            );
                            let _ = socket.write_all(hdr.as_bytes()).await;
                            return;
                        }

                        if let Some(r_line) = req.lines().find(|l| l.to_ascii_lowercase().starts_with("range:")) {
                            let r_idx = range_counter.fetch_add(1, Ordering::SeqCst);
                            let spec = r_line
                                .split(':')
                                .nth(1)
                                .unwrap_or("")
                                .trim()
                                .strip_prefix("bytes=")
                                .unwrap_or("0-");
                            let parts: Vec<&str> = spec.split('-').collect();
                            let start: u64 = parts[0].parse().unwrap_or(0);
                            let end: u64 = if parts.len() > 1 && !parts[1].is_empty() {
                                parts[1].parse().unwrap_or(virtual_size - 1)
                            } else {
                                virtual_size - 1
                            };
                            let end = end.min(virtual_size - 1);

                            // Optional: simulate CDN rate-limiting (HTTP 429) on a secondary range worker
                            if fail_secondary_range_once && start > 0 && r_idx >= 2 && !inj_429.swap(true, Ordering::SeqCst) {
                                let hdr = "HTTP/1.1 429 Too Many Requests\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
                                let _ = socket.write_all(hdr.as_bytes()).await;
                                return;
                            }

                            let content_len = end - start + 1;
                            let hdr = format!(
                                "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {}-{}/{}\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nETag: \"gate26-etag-{}\"\r\nConnection: close\r\n\r\n",
                                start, end, virtual_size, content_len, virtual_size
                            );
                            if socket.write_all(hdr.as_bytes()).await.is_err() {
                                return;
                            }

                            let mut offset = start;
                            let mut remaining = content_len;
                            let mut block = vec![0u8; 64 * 1024];
                            while remaining > 0 {
                                let to_send = (remaining as usize).min(block.len());
                                fill_pattern_slice(offset, &mut block[..to_send]);
                                if socket.write_all(&block[..to_send]).await.is_err() {
                                    break;
                                }
                                offset += to_send as u64;
                                remaining -= to_send as u64;
                                if chunk_delay_ms > 0 {
                                    tokio::time::sleep(Duration::from_millis(chunk_delay_ms)).await;
                                }
                            }
                        } else {
                            let hdr = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nETag: \"gate26-etag-{}\"\r\nConnection: close\r\n\r\n",
                                virtual_size, virtual_size
                            );
                            let _ = socket.write_all(hdr.as_bytes()).await;
                        }
                    });
                }
            }
        }
    });

    (port, cancel, head_requests, range_requests)
}

#[tokio::test]
async fn test_gate26_1_100mb_full_download_pause_resume_and_sha256() {
    std::env::set_var("TORI_ALLOW_LOOPBACK", "1");
    let size_100mb: u64 = 100 * 1024 * 1024; // 104,857,600 bytes
    let (port, cancel, _heads, ranges) =
        start_virtual_range_server(size_100mb, 0, 0, true).await;

    let temp_dir = tempdir().unwrap();
    let db = Database::open(temp_dir.path().join("test_100mb.sqlite")).unwrap();
    let bus = EventBus::default();
    let mut rx = bus.subscribe();
    let manager = DownloadManager::new(db.clone(), bus).unwrap();

    let url = format!(
        "http://127.0.0.1:{}/archive_100mb.iso?v=1776001&token=presigned100",
        port
    );
    let t_start = Instant::now();
    let job = manager.create_download(&url, temp_dir.path()).await.unwrap();
    assert_eq!(job.total_bytes, Some(size_100mb));
    assert_eq!(job.chunk_count, 16);

    manager.start_download(&job.id).unwrap();

    // Measure time to first progress event
    let mut first_progress_ms: Option<u128> = None;
    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline {
        if let Ok(Ok(ev)) = tokio::time::timeout(Duration::from_millis(200), rx.recv()).await {
            match ev {
                DownloadEvent::Progress(p) if p.id == job.id && p.downloaded_bytes > 0 => {
                    if first_progress_ms.is_none() {
                        first_progress_ms = Some(t_start.elapsed().as_millis());
                    }
                }
                DownloadEvent::StateChanged {
                    id,
                    state: JobState::Completed,
                    ..
                } if id == job.id => break,
                DownloadEvent::StateChanged {
                    id,
                    state: JobState::Failed,
                    error,
                } if id == job.id => {
                    panic!("100MB download failed: {:?}", error);
                }
                _ => {}
            }
        }
        if let Some(j) = manager.get_download(&job.id).unwrap() {
            if j.state == JobState::Completed {
                break;
            }
        }
    }

    let final_job = manager.get_download(&job.id).unwrap().unwrap();
    assert_eq!(final_job.state, JobState::Completed);
    assert_eq!(final_job.downloaded_bytes, size_100mb);
    assert!(
        first_progress_ms.unwrap_or(300) < 2000,
        "First progress event should arrive rapidly"
    );
    assert!(ranges.load(Ordering::SeqCst) >= 16);

    let meta = fs::metadata(&final_job.target_path).unwrap();
    assert_eq!(meta.len(), size_100mb);

    // Spot-check SHA256 of first 1 MiB and last 1 MiB against deterministic pattern
    let mut f = fs::File::open(&final_job.target_path).unwrap();
    use std::io::{Read, Seek, SeekFrom};
    let mut buf_head = vec![0u8; 1024 * 1024];
    f.read_exact(&mut buf_head).unwrap();
    let mut exp_head = vec![0u8; 1024 * 1024];
    fill_pattern_slice(0, &mut exp_head);
    assert_eq!(
        Sha256::digest(&buf_head),
        Sha256::digest(&exp_head),
        "100MB first 1 MiB SHA256 mismatch"
    );

    let tail_offset = size_100mb - 1024 * 1024;
    f.seek(SeekFrom::Start(tail_offset)).unwrap();
    let mut buf_tail = vec![0u8; 1024 * 1024];
    f.read_exact(&mut buf_tail).unwrap();
    let mut exp_tail = vec![0u8; 1024 * 1024];
    fill_pattern_slice(tail_offset, &mut exp_tail);
    assert_eq!(
        Sha256::digest(&buf_tail),
        Sha256::digest(&exp_tail),
        "100MB tail 1 MiB SHA256 mismatch"
    );

    cancel.cancel();
}

#[tokio::test]
async fn test_gate26_1_1gb_sparse_allocation_and_pause_resume_recovery() {
    std::env::set_var("TORI_ALLOW_LOOPBACK", "1");
    let size_1gb: u64 = 1024 * 1024 * 1024; // 1,073,741,824 bytes
    let (port, cancel, _heads, _ranges) =
        start_virtual_range_server(size_1gb, 0, 2, false).await;

    let temp_dir = tempdir().unwrap();
    let db_path = temp_dir.path().join("test_1gb.sqlite");
    let db = Database::open(&db_path).unwrap();
    let bus = EventBus::default();
    let manager = DownloadManager::new(db.clone(), bus).unwrap();

    let url = format!("http://127.0.0.1:{}/dataset_1gb.bin", port);
    let job = manager.create_download(&url, temp_dir.path()).await.unwrap();
    assert_eq!(job.total_bytes, Some(size_1gb));

    let t0 = Instant::now();
    manager.start_download(&job.id).unwrap();

    // Wait until at least 8 MiB has been written across multiple chunks
    let mut progressed = false;
    for _ in 0..80 {
        tokio::time::sleep(Duration::from_millis(50)).await;
        let chunks = db.get_chunks(&job.id).unwrap();
        let sum: u64 = chunks.iter().map(|c| c.written_bytes).sum();
        if sum >= 8 * 1024 * 1024 {
            progressed = true;
            break;
        }
    }
    let elapsed_to_8mb = t0.elapsed();
    assert!(
        progressed,
        "1 GB download must make multi-MB progress within 4s without NTFS zero-fill stall"
    );
    assert!(
        elapsed_to_8mb < Duration::from_secs(4),
        "1 GB high-offset writes took too long: {:?}",
        elapsed_to_8mb
    );

    // Pause and verify downloaded_bytes is persisted to SQLite
    manager.pause_download(&job.id).unwrap();
    tokio::time::sleep(Duration::from_millis(150)).await;

    let paused_job = manager.get_download(&job.id).unwrap().unwrap();
    assert_eq!(paused_job.state, JobState::Paused);
    let chunks_at_pause = db.get_chunks(&job.id).unwrap();
    let chunk_sum: u64 = chunks_at_pause.iter().map(|c| c.written_bytes).sum();
    assert!(chunk_sum > 0);
    assert_eq!(
        paused_job.downloaded_bytes, chunk_sum,
        "Paused job downloaded_bytes in SQLite must match sum of chunk written_bytes"
    );

    cancel.cancel();
}

#[tokio::test]
async fn test_gate26_1_5gb_10gb_50gb_sparse_high_offset_and_gap_verification() {
    std::env::set_var("TORI_ALLOW_LOOPBACK", "1");
    std::env::set_var("TORI_ALLOW_SPARSE_OVERCOMMIT", "1");

    let sizes: &[(&str, u64)] = &[
        ("5GB_over_fat32", 5 * 1024 * 1024 * 1024),   // 5,368,709,120 bytes
        ("10GB_large", 10 * 1024 * 1024 * 1024),      // 10,737,418,240 bytes
        ("50GB_ultra", 50 * 1024 * 1024 * 1024),      // 53,687,091,200 bytes
    ];

    for &(label, total_size) in sizes {
        let (port, cancel, _heads, _ranges) =
            start_virtual_range_server(total_size, 0, 5, true).await;

        let temp_dir = tempdir().unwrap();
        let db_path = temp_dir.path().join(format!("{}.sqlite", label));
        let db = Database::open(&db_path).unwrap();
        let bus = EventBus::default();
        let manager = DownloadManager::new(db.clone(), bus).unwrap();

        let url = format!(
            "http://127.0.0.1:{}/{}.iso?v=1776002&token=signed_{}",
            port, label, label
        );
        let job = manager.create_download(&url, temp_dir.path()).await.unwrap();
        assert_eq!(
            job.total_bytes,
            Some(total_size),
            "{}: 64-bit Content-Length must be preserved exactly",
            label
        );
        assert_eq!(job.chunk_count, 16);

        // Verify chunk 15 starts above 4 GiB for 5GB/10GB/50GB
        let initial_chunks = db.get_chunks(&job.id).unwrap();
        assert_eq!(initial_chunks.len(), 16);
        assert!(initial_chunks[15].start_byte > 4_294_967_295);
        assert_eq!(initial_chunks[15].end_byte, total_size - 1);

        // Start download and verify rapid first-byte progress on sparse .tdm-part file
        let t_start = Instant::now();
        manager.start_download(&job.id).unwrap();

        let mut written_sum = 0u64;
        for _ in 0..80 {
            tokio::time::sleep(Duration::from_millis(50)).await;
            let ch = db.get_chunks(&job.id).unwrap();
            written_sum = ch.iter().map(|c| c.written_bytes).sum();
            if written_sum >= 4 * 1024 * 1024 {
                break;
            }
        }
        let elapsed = t_start.elapsed();
        assert!(
            written_sum >= 4 * 1024 * 1024,
            "{}: failed to write >= 4 MiB quickly (wrote {} bytes in {:?})",
            label,
            written_sum,
            elapsed
        );
        assert!(
            elapsed < Duration::from_secs(4),
            "{}: sparse file allocation + high-offset write stalled ({:?})",
            label,
            elapsed
        );

        // Pause and verify integrity check rejects incomplete sparse file
        manager.pause_download(&job.id).unwrap();
        tokio::time::sleep(Duration::from_millis(150)).await;

        let paused_chunks = db.get_chunks(&job.id).unwrap();
        {
            let writer = PartFileWriter::open_or_create_for_job(
                &job.temp_path,
                Some(total_size),
                Some(job.id.clone()),
                None,
            )
            .unwrap();
            assert!(
                writer.is_sparse(),
                "{}: NTFS .tdm-part file must be marked sparse",
                label
            );

            // Confirm high-offset write at the very end of the file (e.g. 49.99 GiB) completes in < 100ms
            let high_offset = total_size - 65536;
            let mut tail_block = vec![0u8; 65536];
            fill_pattern_slice(high_offset, &mut tail_block);
            let t_high = Instant::now();
            writer.write_at(high_offset, &tail_block).unwrap();
            assert!(
                t_high.elapsed() < Duration::from_millis(500),
                "{}: write at offset {} stalled ({:?})",
                label,
                high_offset,
                t_high.elapsed()
            );

            // Confirm verify_chunks_complete_and_contiguous REJECTS partial sparse file even though file.len() == total_size
            let verify_res = verify_chunks_complete_and_contiguous(
                &paused_chunks,
                Some(total_size),
                Path::new(&job.temp_path),
            );
            assert!(
                verify_res.is_err(),
                "{}: unwritten sparse gaps must never pass completion verification",
                label
            );

            // Confirm verify_chunks_complete_and_contiguous SUCCEEDS when all 16 chunks cover 0..total_size-1 completely
            let mut full_chunks =
                plan_chunks_with_concurrency(&job.id, Some(total_size), true, 16);
            for c in &mut full_chunks {
                c.written_bytes = c.end_byte - c.start_byte + 1;
                c.is_complete = true;
            }
            verify_chunks_complete_and_contiguous(
                &full_chunks,
                Some(total_size),
                Path::new(&job.temp_path),
            )
            .expect("Contiguous complete chunks must pass verification");
        }

        // Simulate crash + startup reconciliation (`reconcile_on_startup`)
        db.update_job_state(&job.id, JobState::Downloading, None)
            .unwrap();
        db.update_downloaded_bytes(&job.id, 0).unwrap();
        db.reconcile_on_startup().unwrap();
        let reconciled = db.get_job(&job.id).unwrap().unwrap();
        assert_eq!(reconciled.state, JobState::Paused);
        let expected_sum: u64 = db
            .get_chunks(&job.id)
            .unwrap()
            .iter()
            .map(|c| c.written_bytes)
            .sum();
        assert_eq!(
            reconciled.downloaded_bytes, expected_sum,
            "{}: reconcile_on_startup must restore downloaded_bytes from chunk sum",
            label
        );

        cancel.cancel();
    }
}

#[tokio::test]
async fn test_gate26_1_duplicate_handoff_timeout_coalesces_to_single_job() {
    std::env::set_var("TORI_ALLOW_LOOPBACK", "1");
    let size_50gb: u64 = 54_676_684_800; // Exact size of the user's 50.9 GB file
    // Simulate a 600ms CDN probe where fallback arrives at 150ms
    let (port, cancel, head_count, _range_count) =
        start_virtual_range_server(size_50gb, 600, 10, false).await;

    let temp_dir = tempdir().unwrap();
    let db = Database::open(temp_dir.path().join("handoff_dedup.sqlite")).unwrap();
    let manager = Arc::new(DownloadManager::new(db.clone(), EventBus::default()).unwrap());

    let url = format!(
        "http://127.0.0.1:{}/Setup_Part1.rar?v=1776063401-I2c5nG0q&token=cdn_sig_1",
        port
    );

    // 1. Primary handoff (simulating HTTP POST /api/v1/downloads)
    let m1 = manager.clone();
    let u1 = url.clone();
    let d1 = temp_dir.path().to_path_buf();
    let t1 = tokio::spawn(async move {
        m1.create_or_coalesce_download(
            &u1,
            &d1,
            Priority::Normal,
            None,
            None,
            None,
            Some("ext_101_1776063401"),
        )
        .await
    });

    // 2. Secondary handoff 150ms later while probe is in-flight (simulating Native Messaging fallback after HTTP timeout)
    tokio::time::sleep(Duration::from_millis(150)).await;
    let m2 = manager.clone();
    let u2 = url.clone();
    let d2 = temp_dir.path().to_path_buf();
    let t2 = tokio::spawn(async move {
        m2.create_or_coalesce_download(
            &u2,
            &d2,
            Priority::Normal,
            None,
            None,
            None,
            None, // Even without handoff_id (e.g. published Extension v1.0.5), URL coalescing catches it!
        )
        .await
    });

    let (r1, r2) = tokio::join!(t1, t2);
    let (job1, existed1) = r1.unwrap().unwrap();
    let (job2, existed2) = r2.unwrap().unwrap();

    assert!(!existed1, "Primary handoff should create the job");
    assert!(existed2, "Fallback handoff should coalesce into existing job");
    assert_eq!(job1.id, job2.id, "Both handoffs must resolve to the exact same job_id");
    assert_eq!(
        head_count.load(Ordering::SeqCst),
        1,
        "In-flight probe coalescing must issue only 1 HEAD probe"
    );

    let jobs = db.list_jobs().unwrap();
    assert_eq!(jobs.len(), 1, "Database must contain exactly 1 download job");
    assert!(!job1.filename.contains("(1)"), "Filename must not be suffixed with (1)");

    cancel.cancel();
}
