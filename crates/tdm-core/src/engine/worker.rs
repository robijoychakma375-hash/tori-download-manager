use futures_util::StreamExt;
use reqwest::header::{ACCEPT_ENCODING, CONTENT_RANGE, IF_RANGE, RANGE};
use reqwest::Client;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

use crate::db::Database;
use crate::engine::probe::parse_content_range_bounds;
use crate::engine::writer::PartFileWriter;
use crate::error::{EngineError, Result};
use crate::types::ChunkRecord;

const WRITE_BUFFER_CAPACITY: usize = 256 * 1024; // 256 KiB per-worker write buffer
const WRITE_BUFFER_MAX_LATENCY: Duration = Duration::from_millis(200);
const DB_CHECKPOINT_BYTES: u64 = 4 * 1024 * 1024; // 4 MiB SQLite progress checkpoint
const DB_CHECKPOINT_INTERVAL: Duration = Duration::from_millis(2000);
const DISK_SYNC_BYTES: u64 = 32 * 1024 * 1024; // 32 MiB coarse hardware sync threshold
const DISK_SYNC_INTERVAL: Duration = Duration::from_secs(15);
const RESPONSE_HEADER_TIMEOUT: Duration = Duration::from_secs(30);
const STREAM_IDLE_READ_TIMEOUT: Duration = Duration::from_secs(45);
const MAX_PROGRESS_RECONNECTS: u32 = 64;

fn is_transient_error(err: &EngineError) -> bool {
    match err {
        EngineError::HttpStatus(408 | 429 | 500 | 502 | 503 | 504) => true,
        EngineError::Http(e) => e.is_timeout() || e.is_connect() || e.is_request() || e.is_body(),
        EngineError::ContentLengthMismatch { .. } => true,
        EngineError::Other(msg) => {
            msg.contains("timeout") || msg.contains("interrupted") || msg.contains("premature")
        }
        _ => false,
    }
}

fn flush_worker_buffer<F>(
    writer: &PartFileWriter,
    chunk: &mut ChunkRecord,
    buf_start_offset: &mut u64,
    write_buf: &mut Vec<u8>,
    progress_atomic: Option<&Arc<AtomicU64>>,
    uncheckpointed_bytes: &mut u64,
    unflushed_disk_bytes: &mut u64,
    bytes_in_attempt: &mut u64,
    on_bytes_written: &mut F,
) -> Result<()>
where
    F: FnMut(u64),
{
    if write_buf.is_empty() {
        return Ok(());
    }
    writer.write_at(*buf_start_offset, write_buf)?;
    let len = write_buf.len() as u64;
    chunk.written_bytes += len;
    *buf_start_offset = chunk.start_byte + chunk.written_bytes;
    write_buf.clear();

    if let Some(p) = progress_atomic {
        p.store(chunk.written_bytes, Ordering::SeqCst);
    }
    *uncheckpointed_bytes += len;
    *unflushed_disk_bytes += len;
    *bytes_in_attempt += len;
    on_bytes_written(len);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub async fn download_chunk<F>(
    client: &Client,
    url: &str,
    etag: Option<&str>,
    last_modified: Option<&str>,
    chunk: &mut ChunkRecord,
    writer: &PartFileWriter,
    db: &Database,
    cancel_token: &CancellationToken,
    end_bound: Option<Arc<AtomicU64>>,
    progress_atomic: Option<Arc<AtomicU64>>,
    on_bytes_written: F,
) -> Result<()>
where
    F: FnMut(u64),
{
    download_chunk_with_options(
        client,
        url,
        etag,
        last_modified,
        chunk,
        writer,
        db,
        cancel_token,
        end_bound,
        progress_atomic,
        None,
        None,
        None,
        None,
        on_bytes_written,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub async fn download_chunk_with_options<F>(
    client: &Client,
    url: &str,
    etag: Option<&str>,
    last_modified: Option<&str>,
    chunk: &mut ChunkRecord,
    writer: &PartFileWriter,
    db: &Database,
    cancel_token: &CancellationToken,
    end_bound: Option<Arc<AtomicU64>>,
    progress_atomic: Option<Arc<AtomicU64>>,
    limiter: Option<&Arc<crate::engine::limiter::BandwidthLimiter>>,
    max_retries: Option<u32>,
    referer: Option<&str>,
    user_agent: Option<&str>,
    mut on_bytes_written: F,
) -> Result<()>
where
    F: FnMut(u64),
{
    let mut retries = 0u32;
    let mut progress_reconnects = 0u32;
    let max_retry_count = max_retries.unwrap_or(3);

    loop {
        if chunk.is_complete {
            return Ok(());
        }

        let fetch_start = chunk.start_byte + chunk.written_bytes;
        let fetch_end = end_bound
            .as_ref()
            .map(|b| b.load(Ordering::SeqCst))
            .unwrap_or(chunk.end_byte);

        if fetch_start > fetch_end {
            chunk.end_byte = fetch_end;
            chunk.is_complete = true;
            let _ = writer.sync_async().await;
            db.update_chunk_progress(
                &chunk.download_id,
                chunk.chunk_index,
                chunk.written_bytes,
                true,
            )?;
            return Ok(());
        }

        let range_header_val = format!("bytes={}-{}", fetch_start, fetch_end);
        let mut req = client
            .get(url)
            .header(RANGE, &range_header_val)
            .header(ACCEPT_ENCODING, "identity");
        req = crate::engine::referer::apply_referer(req, referer, url);
        req = crate::engine::user_agent::apply_user_agent(req, user_agent);

        // Standards-compliant If-Range: strong ETag or Last-Modified
        if let Some(tag) = etag {
            if !tag.starts_with("W/") {
                req = req.header(IF_RANGE, tag);
            }
        } else if let Some(lm) = last_modified {
            req = req.header(IF_RANGE, lm);
        }

        let send_fut = tokio::time::timeout(RESPONSE_HEADER_TIMEOUT, req.send());
        let resp_res = tokio::select! {
            _ = cancel_token.cancelled() => return Err(EngineError::Cancelled),
            r = send_fut => r,
        };

        let resp = match resp_res {
            Ok(Ok(r)) => r,
            Ok(Err(e)) => {
                let err = EngineError::Http(e);
                if is_transient_error(&err)
                    && retries < max_retry_count
                    && !cancel_token.is_cancelled()
                {
                    retries += 1;
                    let backoff = Duration::from_millis((200u64 * (1 << retries.min(5))).min(5000));
                    tokio::select! {
                        _ = cancel_token.cancelled() => return Err(EngineError::Cancelled),
                        _ = tokio::time::sleep(backoff) => {}
                    }
                    continue;
                }
                return Err(err);
            }
            Err(_elapsed) => {
                let err = EngineError::Other("HTTP response header timeout".to_string());
                if retries < max_retry_count && !cancel_token.is_cancelled() {
                    retries += 1;
                    let backoff = Duration::from_millis((200u64 * (1 << retries.min(5))).min(5000));
                    tokio::select! {
                        _ = cancel_token.cancelled() => return Err(EngineError::Cancelled),
                        _ = tokio::time::sleep(backoff) => {}
                    }
                    continue;
                }
                return Err(err);
            }
        };

        let status = resp.status();

        if status == reqwest::StatusCode::PRECONDITION_FAILED {
            return Err(EngineError::ETagMismatch {
                expected: etag.map(String::from),
                actual: None,
            });
        }

        if status == reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
            return Err(EngineError::HttpStatus(416));
        }

        if status == reqwest::StatusCode::TOO_MANY_REQUESTS
            || status == reqwest::StatusCode::REQUEST_TIMEOUT
            || status.is_server_error()
        {
            let err = EngineError::HttpStatus(status.as_u16());
            if retries < max_retry_count && !cancel_token.is_cancelled() {
                retries += 1;
                let backoff = Duration::from_millis((250u64 * (1 << retries.min(5))).min(5000));
                tokio::select! {
                    _ = cancel_token.cancelled() => return Err(EngineError::Cancelled),
                    _ = tokio::time::sleep(backoff) => {}
                }
                continue;
            }
            return Err(err);
        }

        if status == reqwest::StatusCode::OK {
            // Server returned 200 OK instead of 206 Partial Content
            if fetch_start > 0 {
                // We asked for a resume/sub-range, but server sent entire file from 0
                return Err(EngineError::ETagMismatch {
                    expected: etag.map(String::from),
                    actual: None,
                });
            }
        } else if status != reqwest::StatusCode::PARTIAL_CONTENT {
            return Err(EngineError::HttpStatus(status.as_u16()));
        }

        // Validate Content-Range header if 206
        if status == reqwest::StatusCode::PARTIAL_CONTENT {
            if let Some(cr) = resp
                .headers()
                .get(CONTENT_RANGE)
                .and_then(|v| v.to_str().ok())
            {
                if let Some((start, _end, _total)) = parse_content_range_bounds(cr) {
                    if start != fetch_start {
                        return Err(EngineError::MismatchedContentRange {
                            expected_start: fetch_start,
                            actual_range: cr.to_string(),
                        });
                    }
                }
            }
        }

        let mut stream = resp.bytes_stream();
        let mut write_buf: Vec<u8> = Vec::with_capacity(WRITE_BUFFER_CAPACITY);
        let mut buf_start_offset: u64 = chunk.start_byte + chunk.written_bytes;
        let mut has_flushed_first_bytes = chunk.written_bytes > 0;
        let mut last_buf_flush = Instant::now();
        let mut uncheckpointed_bytes: u64 = 0;
        let mut unflushed_disk_bytes: u64 = 0;
        let mut bytes_in_attempt: u64 = 0;
        let mut last_checkpoint_time = Instant::now();
        let mut last_disk_sync = Instant::now();
        let mut stream_error: Option<EngineError> = None;

        loop {
            let next_item = tokio::select! {
                _ = cancel_token.cancelled() => {
                    let _ = flush_worker_buffer(
                        writer,
                        chunk,
                        &mut buf_start_offset,
                        &mut write_buf,
                        progress_atomic.as_ref(),
                        &mut uncheckpointed_bytes,
                        &mut unflushed_disk_bytes,
                        &mut bytes_in_attempt,
                        &mut on_bytes_written,
                    );
                    let _ = db.update_chunk_progress(
                        &chunk.download_id,
                        chunk.chunk_index,
                        chunk.written_bytes,
                        false,
                    );
                    let _ = writer.sync_async().await;
                    return Err(EngineError::Cancelled);
                }
                res = tokio::time::timeout(STREAM_IDLE_READ_TIMEOUT, stream.next()) => {
                    match res {
                        Ok(Some(item)) => item,
                        Ok(None) => break,
                        Err(_elapsed) => {
                            stream_error = Some(EngineError::Other(
                                "Stream idle read timeout (no bytes received for 45s)".to_string(),
                            ));
                            break;
                        }
                    }
                }
            };

            let bytes = match next_item {
                Ok(b) => b,
                Err(e) => {
                    stream_error = Some(EngineError::Http(e));
                    break;
                }
            };

            let current_bound = end_bound
                .as_ref()
                .map(|b| b.load(Ordering::SeqCst))
                .unwrap_or(chunk.end_byte);

            let logical_offset = chunk.start_byte + chunk.written_bytes + (write_buf.len() as u64);
            if logical_offset > current_bound {
                break;
            }

            let max_allowed = (current_bound + 1).saturating_sub(logical_offset) as usize;
            let actual_bytes = if bytes.len() > max_allowed {
                &bytes[..max_allowed]
            } else {
                &bytes[..]
            };

            if !actual_bytes.is_empty() {
                if let Some(l) = limiter {
                    l.acquire(actual_bytes.len() as u64).await;
                }
                write_buf.extend_from_slice(actual_bytes);

                let reached_bound =
                    chunk.start_byte + chunk.written_bytes + (write_buf.len() as u64)
                        > current_bound;
                let is_first_flush = !has_flushed_first_bytes;
                if is_first_flush
                    || write_buf.len() >= WRITE_BUFFER_CAPACITY
                    || last_buf_flush.elapsed() >= WRITE_BUFFER_MAX_LATENCY
                    || reached_bound
                {
                    flush_worker_buffer(
                        writer,
                        chunk,
                        &mut buf_start_offset,
                        &mut write_buf,
                        progress_atomic.as_ref(),
                        &mut uncheckpointed_bytes,
                        &mut unflushed_disk_bytes,
                        &mut bytes_in_attempt,
                        &mut on_bytes_written,
                    )?;
                    if is_first_flush {
                        let _ = db.update_chunk_progress(
                            &chunk.download_id,
                            chunk.chunk_index,
                            chunk.written_bytes,
                            false,
                        );
                        uncheckpointed_bytes = 0;
                        last_checkpoint_time = Instant::now();
                    }
                    has_flushed_first_bytes = true;
                    last_buf_flush = Instant::now();
                }
            }

            if chunk.start_byte + chunk.written_bytes > current_bound {
                break;
            }

            if uncheckpointed_bytes >= DB_CHECKPOINT_BYTES
                || last_checkpoint_time.elapsed() >= DB_CHECKPOINT_INTERVAL
            {
                flush_worker_buffer(
                    writer,
                    chunk,
                    &mut buf_start_offset,
                    &mut write_buf,
                    progress_atomic.as_ref(),
                    &mut uncheckpointed_bytes,
                    &mut unflushed_disk_bytes,
                    &mut bytes_in_attempt,
                    &mut on_bytes_written,
                )?;
                db.update_chunk_progress(
                    &chunk.download_id,
                    chunk.chunk_index,
                    chunk.written_bytes,
                    false,
                )?;
                uncheckpointed_bytes = 0;
                last_checkpoint_time = Instant::now();
            }

            if unflushed_disk_bytes >= DISK_SYNC_BYTES
                && last_disk_sync.elapsed() >= DISK_SYNC_INTERVAL
            {
                writer.sync_async().await?;
                unflushed_disk_bytes = 0;
                last_disk_sync = Instant::now();
            }
        }

        // Flush any remaining buffered bytes from this stream attempt
        flush_worker_buffer(
            writer,
            chunk,
            &mut buf_start_offset,
            &mut write_buf,
            progress_atomic.as_ref(),
            &mut uncheckpointed_bytes,
            &mut unflushed_disk_bytes,
            &mut bytes_in_attempt,
            &mut on_bytes_written,
        )?;

        let final_bound = end_bound
            .as_ref()
            .map(|b| b.load(Ordering::SeqCst))
            .unwrap_or(chunk.end_byte);
        chunk.end_byte = final_bound;

        if chunk.start_byte + chunk.written_bytes > final_bound {
            chunk.is_complete = true;
            writer.sync_async().await?;
            db.update_chunk_progress(
                &chunk.download_id,
                chunk.chunk_index,
                chunk.written_bytes,
                true,
            )?;
            return Ok(());
        }

        // Chunk is not yet complete: persist partial progress before deciding retry
        let _ = writer.sync_async().await;
        let _ = db.update_chunk_progress(
            &chunk.download_id,
            chunk.chunk_index,
            chunk.written_bytes,
            false,
        );

        let err = stream_error.unwrap_or_else(|| {
            let expected_len = final_bound.saturating_sub(chunk.start_byte) + 1;
            EngineError::ContentLengthMismatch {
                expected: expected_len,
                actual: chunk.written_bytes,
            }
        });

        if is_transient_error(&err) && !cancel_token.is_cancelled() {
            if bytes_in_attempt > 0 && progress_reconnects < MAX_PROGRESS_RECONNECTS {
                // Forward progress was made before stream interruption; reconnect without burning no-progress retries
                progress_reconnects += 1;
                retries = 0;
            } else if retries < max_retry_count {
                retries += 1;
            } else {
                return Err(err);
            }

            let backoff = Duration::from_millis((200u64 * (1 << retries.min(5))).min(5000));
            tokio::select! {
                _ = cancel_token.cancelled() => return Err(EngineError::Cancelled),
                _ = tokio::time::sleep(backoff) => {}
            }
            continue;
        }

        return Err(err);
    }
}

pub async fn download_stream<F>(
    client: &Client,
    url: &str,
    writer: &PartFileWriter,
    db: &Database,
    download_id: &str,
    cancel_token: &CancellationToken,
    on_bytes_written: F,
) -> Result<u64>
where
    F: FnMut(u64),
{
    download_stream_with_options(
        client,
        url,
        writer,
        db,
        download_id,
        cancel_token,
        None,
        None,
        None,
        None,
        on_bytes_written,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub async fn download_stream_with_options<F>(
    client: &Client,
    url: &str,
    writer: &PartFileWriter,
    db: &Database,
    download_id: &str,
    cancel_token: &CancellationToken,
    limiter: Option<&Arc<crate::engine::limiter::BandwidthLimiter>>,
    max_retries: Option<u32>,
    referer: Option<&str>,
    user_agent: Option<&str>,
    mut on_bytes_written: F,
) -> Result<u64>
where
    F: FnMut(u64),
{
    let mut retries = 0u32;
    let mut progress_reconnects = 0u32;
    let max_retry_count = max_retries.unwrap_or(3);
    let mut total_written: u64 = 0;
    let mut expected_total: Option<u64> = None;

    if let Ok(Some(job)) = db.get_job(download_id) {
        expected_total = job.total_bytes;
    }

    // Check if there is existing progress for resume
    if let Ok(chunks) = db.get_chunks(download_id) {
        if let Some(c) = chunks.into_iter().next() {
            total_written = c.written_bytes;
        }
    }

    loop {
        if let Some(exp) = expected_total {
            if exp > 0 && total_written >= exp {
                writer.sync_async().await?;
                let _ = db.update_chunk_progress(download_id, 0, total_written, true);
                db.update_downloaded_bytes(download_id, total_written)?;
                return Ok(total_written);
            }
        }

        let mut req = client.get(url).header(ACCEPT_ENCODING, "identity");
        if total_written > 0 {
            req = req.header(RANGE, format!("bytes={}-", total_written));
        }
        req = crate::engine::referer::apply_referer(req, referer, url);
        req = crate::engine::user_agent::apply_user_agent(req, user_agent);

        let send_fut = tokio::time::timeout(RESPONSE_HEADER_TIMEOUT, req.send());
        let resp_res = tokio::select! {
            _ = cancel_token.cancelled() => return Err(EngineError::Cancelled),
            r = send_fut => r,
        };

        let resp = match resp_res {
            Ok(Ok(r)) => r,
            Ok(Err(e)) => {
                let err = EngineError::Http(e);
                if is_transient_error(&err)
                    && retries < max_retry_count
                    && !cancel_token.is_cancelled()
                {
                    retries += 1;
                    let backoff = Duration::from_millis((200u64 * (1 << retries.min(5))).min(5000));
                    tokio::select! {
                        _ = cancel_token.cancelled() => return Err(EngineError::Cancelled),
                        _ = tokio::time::sleep(backoff) => {}
                    }
                    continue;
                }
                return Err(err);
            }
            Err(_elapsed) => {
                let err = EngineError::Other("HTTP response header timeout".to_string());
                if retries < max_retry_count && !cancel_token.is_cancelled() {
                    retries += 1;
                    let backoff = Duration::from_millis((200u64 * (1 << retries.min(5))).min(5000));
                    tokio::select! {
                        _ = cancel_token.cancelled() => return Err(EngineError::Cancelled),
                        _ = tokio::time::sleep(backoff) => {}
                    }
                    continue;
                }
                return Err(err);
            }
        };

        let status = resp.status();
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS
            || status == reqwest::StatusCode::REQUEST_TIMEOUT
            || status.is_server_error()
        {
            let err = EngineError::HttpStatus(status.as_u16());
            if retries < max_retry_count && !cancel_token.is_cancelled() {
                retries += 1;
                let backoff = Duration::from_millis((250u64 * (1 << retries.min(5))).min(5000));
                tokio::select! {
                    _ = cancel_token.cancelled() => return Err(EngineError::Cancelled),
                    _ = tokio::time::sleep(backoff) => {}
                }
                continue;
            }
            return Err(err);
        }

        if !status.is_success() {
            return Err(EngineError::HttpStatus(status.as_u16()));
        }

        // If server responded 200 OK to a range request, it rewound and streams from 0
        if status == reqwest::StatusCode::OK && total_written > 0 {
            total_written = 0;
        }

        let mut stream = resp.bytes_stream();
        let mut write_buf: Vec<u8> = Vec::with_capacity(WRITE_BUFFER_CAPACITY);
        let mut buf_start_offset: u64 = total_written;
        let mut has_flushed_first_bytes = total_written > 0;
        let mut last_buf_flush = Instant::now();
        let mut uncheckpointed_bytes: u64 = 0;
        let mut unflushed_disk_bytes: u64 = 0;
        let mut bytes_in_attempt: u64 = 0;
        let mut last_checkpoint_time = Instant::now();
        let mut last_disk_sync = Instant::now();
        let mut stream_interrupted = false;

        loop {
            let next_item = tokio::select! {
                _ = cancel_token.cancelled() => {
                    if !write_buf.is_empty() {
                        let _ = writer.write_at(buf_start_offset, &write_buf);
                        let len = write_buf.len() as u64;
                        total_written += len;
                        write_buf.clear();
                        on_bytes_written(len);
                    }
                    let _ = writer.sync_async().await;
                    let _ = db.update_chunk_progress(download_id, 0, total_written, false);
                    let _ = db.update_downloaded_bytes(download_id, total_written);
                    return Err(EngineError::Cancelled);
                }
                res = tokio::time::timeout(STREAM_IDLE_READ_TIMEOUT, stream.next()) => {
                    match res {
                        Ok(Some(item)) => item,
                        Ok(None) => break,
                        Err(_elapsed) => {
                            tracing::warn!("Stream idle read timeout for {}", download_id);
                            stream_interrupted = true;
                            break;
                        }
                    }
                }
            };

            let bytes = match next_item {
                Ok(b) => b,
                Err(e) => {
                    tracing::warn!("Stream read error: {}", e);
                    stream_interrupted = true;
                    break;
                }
            };

            let len = bytes.len() as u64;
            if let Some(l) = limiter {
                l.acquire(len).await;
            }

            write_buf.extend_from_slice(&bytes);

            if !has_flushed_first_bytes
                || write_buf.len() >= WRITE_BUFFER_CAPACITY
                || last_buf_flush.elapsed() >= WRITE_BUFFER_MAX_LATENCY
            {
                let flush_len = write_buf.len() as u64;
                writer.write_at(buf_start_offset, &write_buf)?;
                total_written += flush_len;
                buf_start_offset = total_written;
                write_buf.clear();

                uncheckpointed_bytes += flush_len;
                unflushed_disk_bytes += flush_len;
                bytes_in_attempt += flush_len;
                on_bytes_written(flush_len);
                has_flushed_first_bytes = true;
                last_buf_flush = Instant::now();
            }

            if uncheckpointed_bytes >= DB_CHECKPOINT_BYTES
                || last_checkpoint_time.elapsed() >= DB_CHECKPOINT_INTERVAL
            {
                if !write_buf.is_empty() {
                    let flush_len = write_buf.len() as u64;
                    writer.write_at(buf_start_offset, &write_buf)?;
                    total_written += flush_len;
                    buf_start_offset = total_written;
                    write_buf.clear();
                    unflushed_disk_bytes += flush_len;
                    bytes_in_attempt += flush_len;
                    on_bytes_written(flush_len);
                }
                let _ = db.update_chunk_progress(download_id, 0, total_written, false);
                db.update_downloaded_bytes(download_id, total_written)?;
                uncheckpointed_bytes = 0;
                last_checkpoint_time = Instant::now();
            }

            if unflushed_disk_bytes >= DISK_SYNC_BYTES
                && last_disk_sync.elapsed() >= DISK_SYNC_INTERVAL
            {
                writer.sync_async().await?;
                unflushed_disk_bytes = 0;
                last_disk_sync = Instant::now();
            }
        }

        if !write_buf.is_empty() {
            let flush_len = write_buf.len() as u64;
            writer.write_at(buf_start_offset, &write_buf)?;
            total_written += flush_len;
            write_buf.clear();
            bytes_in_attempt += flush_len;
            on_bytes_written(flush_len);
        }

        if let Some(exp) = expected_total {
            if total_written < exp {
                stream_interrupted = true;
            }
        }

        if stream_interrupted {
            let _ = writer.sync_async().await;
            let _ = db.update_chunk_progress(download_id, 0, total_written, false);
            let _ = db.update_downloaded_bytes(download_id, total_written);

            if !cancel_token.is_cancelled() {
                if bytes_in_attempt > 0 && progress_reconnects < MAX_PROGRESS_RECONNECTS {
                    progress_reconnects += 1;
                    retries = 0;
                } else if retries < max_retry_count {
                    retries += 1;
                } else {
                    return Err(EngineError::Other(
                        "Download stream interrupted before completion".into(),
                    ));
                }

                let backoff = Duration::from_millis((200u64 * (1 << retries.min(5))).min(5000));
                tokio::select! {
                    _ = cancel_token.cancelled() => return Err(EngineError::Cancelled),
                    _ = tokio::time::sleep(backoff) => {}
                }
                continue;
            }
            return Err(EngineError::Other("Download stream interrupted".into()));
        }

        writer.sync_async().await?;
        let _ = db.update_chunk_progress(download_id, 0, total_written, true);
        db.update_downloaded_bytes(download_id, total_written)?;
        return Ok(total_written);
    }
}
