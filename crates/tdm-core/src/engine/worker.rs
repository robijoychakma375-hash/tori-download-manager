use futures_util::StreamExt;
use reqwest::header::{ACCEPT_ENCODING, CONTENT_RANGE, IF_RANGE, RANGE};
use reqwest::Client;
use std::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::db::Database;
use crate::engine::probe::parse_content_range_bounds;
use crate::engine::writer::PartFileWriter;
use crate::error::{EngineError, Result};
use crate::types::ChunkRecord;

const CHECKPOINT_FLUSH_BYTES: u64 = 1024 * 1024; // 1 MB adaptive flush threshold

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

fn is_transient_error(err: &EngineError) -> bool {
    match err {
        EngineError::HttpStatus(429 | 500 | 502 | 503 | 504) => true,
        EngineError::Http(e) => e.is_timeout() || e.is_connect() || e.is_request(),
        _ => false,
    }
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
    mut on_bytes_written: F,
) -> Result<()>
where
    F: FnMut(u64),
{
    let mut retries = 0;
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
            chunk.is_complete = true;
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

        // Standards-compliant If-Range: strong ETag or Last-Modified
        if let Some(tag) = etag {
            if !tag.starts_with("W/") {
                req = req.header(IF_RANGE, tag);
            }
        } else if let Some(lm) = last_modified {
            req = req.header(IF_RANGE, lm);
        }

        let resp_res = req.send().await;
        let resp = match resp_res {
            Ok(r) => r,
            Err(e) => {
                let err = EngineError::Http(e);
                if is_transient_error(&err)
                    && retries < max_retry_count
                    && !cancel_token.is_cancelled()
                {
                    retries += 1;
                    let backoff = std::time::Duration::from_millis(100 * (1 << retries));
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

        if status == reqwest::StatusCode::TOO_MANY_REQUESTS || status.is_server_error() {
            let err = EngineError::HttpStatus(status.as_u16());
            if retries < max_retry_count && !cancel_token.is_cancelled() {
                retries += 1;
                let backoff = std::time::Duration::from_millis(100 * (1 << retries));
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
        let mut uncheckpointed_bytes: u64 = 0;
        let mut last_checkpoint_time = Instant::now();
        let mut stream_error: Option<EngineError> = None;

        while let Some(item) = tokio::select! {
            _ = cancel_token.cancelled() => {
                let _ = writer.sync();
                let _ = db.update_chunk_progress(
                    &chunk.download_id,
                    chunk.chunk_index,
                    chunk.written_bytes,
                    false,
                );
                return Err(EngineError::Cancelled);
            }
            res = stream.next() => res,
        } {
            let bytes = match item {
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

            let write_offset = chunk.start_byte + chunk.written_bytes;
            if write_offset > current_bound {
                break;
            }

            let max_allowed = (current_bound + 1).saturating_sub(write_offset) as usize;
            let actual_bytes = if bytes.len() > max_allowed {
                &bytes[..max_allowed]
            } else {
                &bytes[..]
            };

            if !actual_bytes.is_empty() {
                if let Some(l) = limiter {
                    l.acquire(actual_bytes.len() as u64).await;
                }
                writer.write_at(write_offset, actual_bytes)?;
                let len = actual_bytes.len() as u64;
                chunk.written_bytes += len;
                if let Some(p) = progress_atomic.as_ref() {
                    p.store(chunk.written_bytes, Ordering::SeqCst);
                }
                uncheckpointed_bytes += len;
                on_bytes_written(len);
            }

            if chunk.start_byte + chunk.written_bytes > current_bound {
                break;
            }

            if uncheckpointed_bytes >= CHECKPOINT_FLUSH_BYTES
                || last_checkpoint_time.elapsed().as_millis() >= 1000
            {
                writer.sync()?;
                db.update_chunk_progress(
                    &chunk.download_id,
                    chunk.chunk_index,
                    chunk.written_bytes,
                    false,
                )?;
                uncheckpointed_bytes = 0;
                last_checkpoint_time = Instant::now();
            }
        }

        // Always commit downloaded bytes so far
        let _ = writer.sync();
        let _ = db.update_chunk_progress(
            &chunk.download_id,
            chunk.chunk_index,
            chunk.written_bytes,
            false,
        );

        if let Some(err) = stream_error {
            if is_transient_error(&err) && retries < max_retry_count && !cancel_token.is_cancelled()
            {
                retries += 1;
                let backoff = std::time::Duration::from_millis(100 * (1 << retries));
                tokio::select! {
                    _ = cancel_token.cancelled() => return Err(EngineError::Cancelled),
                    _ = tokio::time::sleep(backoff) => {}
                }
                continue;
            }
            return Err(err);
        }

        // Finished stream for this chunk
        let final_bound = end_bound
            .as_ref()
            .map(|b| b.load(Ordering::SeqCst))
            .unwrap_or(chunk.end_byte);
        chunk.end_byte = final_bound;
        if chunk.start_byte + chunk.written_bytes > final_bound {
            chunk.is_complete = true;
        }

        writer.sync()?;
        db.update_chunk_progress(
            &chunk.download_id,
            chunk.chunk_index,
            chunk.written_bytes,
            chunk.is_complete,
        )?;

        return Ok(());
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
    mut on_bytes_written: F,
) -> Result<u64>
where
    F: FnMut(u64),
{
    let mut retries = 0;
    let max_retry_count = max_retries.unwrap_or(3);
    let mut total_written: u64 = 0;

    // Check if there is existing progress for resume
    if let Ok(chunks) = db.get_chunks(download_id) {
        if let Some(c) = chunks.into_iter().next() {
            total_written = c.written_bytes;
        }
    }

    loop {
        let mut req = client.get(url).header(ACCEPT_ENCODING, "identity");
        if total_written > 0 {
            req = req.header(RANGE, format!("bytes={}-", total_written));
        }

        let resp = match req.send().await {
            Ok(r) => r,
            Err(e) => {
                let err = EngineError::Http(e);
                if is_transient_error(&err)
                    && retries < max_retry_count
                    && !cancel_token.is_cancelled()
                {
                    retries += 1;
                    let backoff = std::time::Duration::from_millis(100 * (1 << retries));
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
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS || status.is_server_error() {
            let err = EngineError::HttpStatus(status.as_u16());
            if retries < max_retry_count && !cancel_token.is_cancelled() {
                retries += 1;
                let backoff = std::time::Duration::from_millis(100 * (1 << retries));
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
        let mut uncheckpointed_bytes: u64 = 0;
        let mut last_checkpoint_time = Instant::now();
        let mut stream_interrupted = false;

        while let Some(item) = tokio::select! {
            _ = cancel_token.cancelled() => {
                let _ = writer.sync();
                let _ = db.update_chunk_progress(download_id, 0, total_written, false);
                let _ = db.update_downloaded_bytes(download_id, total_written);
                return Err(EngineError::Cancelled);
            }
            res = stream.next() => res,
        } {
            let bytes = match item {
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

            writer.write_at(total_written, &bytes)?;
            total_written += len;
            uncheckpointed_bytes += len;
            on_bytes_written(len);

            if uncheckpointed_bytes >= CHECKPOINT_FLUSH_BYTES
                || last_checkpoint_time.elapsed().as_millis() >= 1000
            {
                writer.sync()?;
                let _ = db.update_chunk_progress(download_id, 0, total_written, false);
                db.update_downloaded_bytes(download_id, total_written)?;
                uncheckpointed_bytes = 0;
                last_checkpoint_time = Instant::now();
            }
        }

        if stream_interrupted {
            if retries < max_retry_count && !cancel_token.is_cancelled() {
                retries += 1;
                let backoff = std::time::Duration::from_millis(100 * (1 << retries));
                tokio::select! {
                    _ = cancel_token.cancelled() => return Err(EngineError::Cancelled),
                    _ = tokio::time::sleep(backoff) => {}
                }
                continue;
            }
            return Err(EngineError::Other("Download stream interrupted".into()));
        }

        writer.sync()?;
        let _ = db.update_chunk_progress(download_id, 0, total_written, true);
        db.update_downloaded_bytes(download_id, total_written)?;
        return Ok(total_written);
    }
}
