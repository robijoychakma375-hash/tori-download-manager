use reqwest::header::{
    ACCEPT_ENCODING, CONTENT_DISPOSITION, CONTENT_LENGTH, CONTENT_RANGE, ETAG, LAST_MODIFIED, RANGE,
};
use reqwest::Client;
use url::Url;

use crate::error::{EngineError, Result};

#[derive(Debug, Clone)]
pub struct ProbeResult {
    pub resolved_url: String,
    pub filename: String,
    pub total_bytes: Option<u64>,
    pub supports_ranges: bool,
    pub etag: Option<String>,
    pub is_strong_etag: bool,
    pub last_modified: Option<String>,
}

pub async fn probe_url(client: &Client, raw_url: &str) -> Result<ProbeResult> {
    let trimmed = raw_url.trim();

    // Magnet links
    if trimmed.starts_with("magnet:") {
        let parsed = crate::torrent::parse_magnet_uri(trimmed)?;
        let name = parsed
            .display_name
            .unwrap_or_else(|| format!("magnet_{}", &parsed.info_hash_hex[..8]));
        return Ok(ProbeResult {
            resolved_url: trimmed.to_string(),
            filename: name,
            total_bytes: parsed.exact_length,
            supports_ranges: true,
            etag: None,
            is_strong_etag: false,
            last_modified: None,
        });
    }

    // Local .torrent files (file:// or raw path)
    if trimmed.starts_with("file://")
        || (trimmed.ends_with(".torrent") && std::path::Path::new(trimmed).exists())
    {
        let path = if let Some(stripped) = trimmed.strip_prefix("file:///") {
            stripped
        } else if let Some(stripped) = trimmed.strip_prefix("file://") {
            stripped
        } else {
            trimmed
        };
        if let Ok(meta) = crate::torrent::parse_torrent_file(path) {
            return Ok(ProbeResult {
                resolved_url: trimmed.to_string(),
                filename: meta.name,
                total_bytes: Some(meta.total_bytes),
                supports_ranges: true,
                etag: None,
                is_strong_etag: false,
                last_modified: None,
            });
        }
    }

    // Live stream protocols (RTSP, RTMP, SRT, RIST, RTP, UDP, MMS)
    if let Some(proto) = crate::live::detect_live_protocol(trimmed) {
        let stream_name = if let Ok(u) = Url::parse(trimmed) {
            let path = u.path().trim_matches('/');
            if !path.is_empty() {
                let segment = path.split('/').next_back().unwrap_or("live");
                let clean = sanitize_filename(segment);
                if clean.is_empty() || clean == "_" {
                    format!("{}_stream.mp4", proto.as_str())
                } else if !clean.contains('.') {
                    format!("{}.mp4", clean)
                } else {
                    clean
                }
            } else {
                format!("{}_stream.mp4", proto.as_str())
            }
        } else {
            format!("{}_stream.mp4", proto.as_str())
        };

        return Ok(ProbeResult {
            resolved_url: trimmed.to_string(),
            filename: stream_name,
            total_bytes: None,
            supports_ranges: false,
            etag: None,
            is_strong_etag: false,
            last_modified: None,
        });
    }

    let parsed_url = Url::parse(raw_url).map_err(|e| EngineError::InvalidUrl(e.to_string()))?;
    if parsed_url.scheme() != "http" && parsed_url.scheme() != "https" {
        return Err(EngineError::InvalidUrl(format!(
            "Unsupported protocol '{}', only HTTP, HTTPS, magnet, and live streams (RTSP, RTMP, SRT, RIST, RTP, UDP, MMS) are supported",
            parsed_url.scheme()
        )));
    }

    // Explicitly reject video portal webpage URLs (e.g. YouTube watch pages) that are not direct media streams
    let lower_raw = trimmed.to_lowercase();
    if (lower_raw.contains("youtube.com/watch") || lower_raw.contains("youtu.be/"))
        && !lower_raw.contains(".mp4")
        && !lower_raw.contains(".m3u8")
        && !lower_raw.contains(".mpd")
    {
        return Err(EngineError::InvalidUrl(
            "Video watch page URLs cannot be downloaded directly. TORI requires a direct playable media stream, HLS (.m3u8), or DASH (.mpd) URL."
                .to_string(),
        ));
    }

    // Attempt 1: HEAD request
    let head_response = client
        .head(raw_url)
        .header(ACCEPT_ENCODING, "identity")
        .send()
        .await;

    let mut can_use_head = false;
    let mut resolved_url = raw_url.to_string();
    let mut filename_from_header: Option<String> = None;
    let mut head_content_length: Option<u64> = None;
    let mut head_etag: Option<String> = None;
    let mut head_last_modified: Option<String> = None;
    let mut head_accept_ranges_bytes = false;
    let mut response_content_type: Option<String> = None;

    if let Ok(resp) = head_response {
        let status = resp.status();
        resolved_url = resp.url().to_string();

        if status.is_success() {
            can_use_head = true;
            let headers = resp.headers();

            if let Some(ct) = headers
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
            {
                response_content_type = Some(ct.to_string());
            }

            if let Some(cd) = headers
                .get(CONTENT_DISPOSITION)
                .and_then(|v| v.to_str().ok())
            {
                filename_from_header = parse_content_disposition_filename(cd);
            }

            if let Some(cl) = headers.get(CONTENT_LENGTH).and_then(|v| v.to_str().ok()) {
                head_content_length = cl.trim().parse::<u64>().ok();
            }

            if let Some(et) = headers.get(ETAG).and_then(|v| v.to_str().ok()) {
                head_etag = Some(et.trim().to_string());
            }

            if let Some(lm) = headers.get(LAST_MODIFIED).and_then(|v| v.to_str().ok()) {
                head_last_modified = Some(lm.trim().to_string());
            }

            if let Some(ar) = headers.get("accept-ranges").and_then(|v| v.to_str().ok()) {
                if ar.trim().eq_ignore_ascii_case("bytes") {
                    head_accept_ranges_bytes = true;
                }
            }
        }
    }

    // Now, verify actual byte range support with GET Range: bytes=0-0
    // As mandated by RFC 9110 & TDM architecture: do not rely on Accept-Ranges alone.
    let mut range_attempts = 0;
    let range_probe = loop {
        let req = client
            .get(if can_use_head { &resolved_url } else { raw_url })
            .header(RANGE, "bytes=0-0")
            .header(ACCEPT_ENCODING, "identity");

        match req.send().await {
            Ok(resp)
                if resp.status() == reqwest::StatusCode::TOO_MANY_REQUESTS
                    && range_attempts < 3 =>
            {
                range_attempts += 1;
                tokio::time::sleep(std::time::Duration::from_millis(100 * range_attempts)).await;
            }
            res => break res,
        }
    };

    let mut supports_ranges = false;
    let mut total_bytes = head_content_length;
    let mut final_etag = head_etag;
    let mut final_last_modified = head_last_modified;

    match range_probe {
        Ok(resp) => {
            let status = resp.status();
            resolved_url = resp.url().to_string();
            let headers = resp.headers();

            if let Some(ct) = headers
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
            {
                response_content_type = Some(ct.to_string());
            }

            if filename_from_header.is_none() {
                if let Some(cd) = headers
                    .get(CONTENT_DISPOSITION)
                    .and_then(|v| v.to_str().ok())
                {
                    filename_from_header = parse_content_disposition_filename(cd);
                }
            }

            if let Some(et) = headers.get(ETAG).and_then(|v| v.to_str().ok()) {
                final_etag = Some(et.trim().to_string());
            }

            if let Some(lm) = headers.get(LAST_MODIFIED).and_then(|v| v.to_str().ok()) {
                final_last_modified = Some(lm.trim().to_string());
            }

            if status == reqwest::StatusCode::PARTIAL_CONTENT {
                // HTTP 206! Range is supported!
                supports_ranges = true;

                if let Some(cr) = headers.get(CONTENT_RANGE).and_then(|v| v.to_str().ok()) {
                    if let Some(parsed_total) = parse_content_range_total(cr) {
                        total_bytes = Some(parsed_total);
                    }
                }
            } else if status == reqwest::StatusCode::OK {
                // Server returned 200 OK: ignored Range header, single stream only
                supports_ranges = false;
                if total_bytes.is_none() {
                    if let Some(cl) = headers.get(CONTENT_LENGTH).and_then(|v| v.to_str().ok()) {
                        total_bytes = cl.trim().parse::<u64>().ok();
                    }
                }
            } else if !status.is_success() {
                return Err(EngineError::HttpStatus(status.as_u16()));
            }
        }
        Err(e) => {
            if !can_use_head {
                return Err(EngineError::Http(e));
            }
            // If HEAD worked but range GET failed with network error, consider non-resumable
            supports_ranges = false;
        }
    }

    let is_strong_etag = final_etag
        .as_ref()
        .map(|e| !e.starts_with("W/"))
        .unwrap_or(false);

    let is_hls =
        resolved_url.to_lowercase().contains(".m3u8") || raw_url.to_lowercase().contains(".m3u8");
    let is_dash =
        resolved_url.to_lowercase().contains(".mpd") || raw_url.to_lowercase().contains(".mpd");

    let has_filename_header = filename_from_header.is_some();
    if !is_hls && !is_dash {
        if let Some(ref ct) = response_content_type {
            let lower_ct = ct.to_lowercase();
            let lower_url = resolved_url.to_lowercase();
            let is_html_mime = lower_ct.starts_with("text/html")
                || lower_ct.starts_with("application/xhtml")
                || lower_ct.starts_with("text/vnd.wap.wml");
            let has_explicit_html_ext = lower_url.ends_with(".html") || lower_url.ends_with(".htm");

            if is_html_mime && !has_filename_header && !has_explicit_html_ext {
                return Err(EngineError::InvalidUrl(
                    "URL returned an HTML webpage rather than a direct media stream or downloadable file. Webpage URLs cannot be downloaded directly as media."
                        .to_string(),
                ));
            }
        }
    }

    let filename = filename_from_header.unwrap_or_else(|| extract_filename_from_url(&resolved_url));
    let (final_total_bytes, final_supports_ranges) = if is_hls || is_dash {
        (None, true)
    } else {
        (
            total_bytes,
            (supports_ranges && head_accept_ranges_bytes) || supports_ranges,
        )
    };

    Ok(ProbeResult {
        resolved_url,
        filename: sanitize_filename(&filename),
        total_bytes: final_total_bytes,
        supports_ranges: final_supports_ranges,
        etag: final_etag,
        is_strong_etag,
        last_modified: final_last_modified,
    })
}

pub fn parse_content_range_total(content_range: &str) -> Option<u64> {
    // Example format: "bytes 0-0/1048576" or "bytes 0-1023/*"
    let parts: Vec<&str> = content_range.split('/').collect();
    if parts.len() == 2 {
        let total_str = parts[1].trim();
        if total_str != "*" {
            return total_str.parse::<u64>().ok();
        }
    }
    None
}

pub fn parse_content_range_bounds(content_range: &str) -> Option<(u64, u64, Option<u64>)> {
    // "bytes 0-499/1234" -> (0, 499, Some(1234))
    let clean = content_range.trim();
    if !clean.starts_with("bytes ") {
        return None;
    }
    let after_bytes = &clean[6..];
    let slash_parts: Vec<&str> = after_bytes.split('/').collect();
    if slash_parts.len() != 2 {
        return None;
    }
    let range_parts: Vec<&str> = slash_parts[0].split('-').collect();
    if range_parts.len() != 2 {
        return None;
    }
    let start = range_parts[0].trim().parse::<u64>().ok()?;
    let end = range_parts[1].trim().parse::<u64>().ok()?;
    let total = if slash_parts[1].trim() == "*" {
        None
    } else {
        slash_parts[1].trim().parse::<u64>().ok()
    };
    Some((start, end, total))
}

fn parse_content_disposition_filename(cd: &str) -> Option<String> {
    // filename="example.mp4" or filename*=UTF-8''example.mp4
    for part in cd.split(';') {
        let part = part.trim();
        if let Some(stripped) = part.strip_prefix("filename*=") {
            let clean = stripped.trim_matches('"');
            if let Some(idx) = clean.find("''") {
                let name = &clean[idx + 2..];
                if let Ok(decoded) = urlencoding_decode(name) {
                    return Some(decoded);
                }
                return Some(name.to_string());
            }
        } else if let Some(stripped) = part.strip_prefix("filename=") {
            let clean = stripped.trim_matches('"').trim_matches('\'');
            return Some(clean.to_string());
        }
    }
    None
}

fn urlencoding_decode(s: &str) -> std::result::Result<String, ()> {
    url::form_urlencoded::parse(s.as_bytes())
        .next()
        .map(|(k, _)| k.to_string())
        .ok_or(())
}

fn extract_filename_from_url(url_str: &str) -> String {
    if let Ok(parsed) = Url::parse(url_str) {
        if let Some(mut segments) = parsed.path_segments() {
            if let Some(last) = segments.rfind(|s| !s.is_empty()) {
                return last.to_string();
            }
        }
    }
    "download.bin".to_string()
}

pub fn sanitize_filename(name: &str) -> String {
    let forbidden = ['/', '\\', ':', '*', '?', '"', '<', '>', '|'];
    let mut clean: String = name
        .chars()
        .map(|c| {
            if forbidden.contains(&c) || (c as u32) < 32 {
                '_'
            } else {
                c
            }
        })
        .collect();

    // Trim whitespace and trailing dots (illegal on Windows)
    clean = clean.trim().trim_end_matches('.').trim().to_string();
    if clean.is_empty() {
        return "download.bin".to_string();
    }

    // Windows reserved device names
    let reserved = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];

    let stem = match clean.find('.') {
        Some(idx) => &clean[..idx],
        None => &clean[..],
    };

    if reserved.iter().any(|&r| stem.eq_ignore_ascii_case(r)) {
        clean = format!("_{}", clean);
    }

    if clean.len() > 255 {
        clean.truncate(255);
    }

    clean
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sanitize_filename_windows_reserved_and_illegal() {
        assert_eq!(sanitize_filename("CON.txt"), "_CON.txt");
        assert_eq!(sanitize_filename("prn.tar.gz"), "_prn.tar.gz");
        assert_eq!(
            sanitize_filename("my:video*file?.mp4"),
            "my_video_file_.mp4"
        );
        assert_eq!(sanitize_filename("trailing_dots..."), "trailing_dots");
        assert_eq!(sanitize_filename("   "), "download.bin");
        assert_eq!(sanitize_filename("nul"), "_nul");
    }

    #[tokio::test]
    async fn test_probe_rejects_youtube_watch_urls() {
        let client = reqwest::Client::new();
        let res = probe_url(&client, "https://www.youtube.com/watch?v=dQw4w9WgXcQ").await;
        assert!(res.is_err());
        let err = res.err().unwrap().to_string();
        assert!(err.contains("Video watch page URLs cannot be downloaded directly"));
    }

    #[tokio::test]
    async fn test_probe_rejects_html_webpage_responses() {
        use tokio::io::AsyncWriteExt;
        use tokio::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();

        tokio::spawn(async move {
            use tokio::io::AsyncReadExt;
            while let Ok((mut socket, _)) = listener.accept().await {
                let mut buf = [0u8; 1024];
                let _ = socket.read(&mut buf).await;
                let html = "<!DOCTYPE html><html><body>Article Page</body></html>";
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    html.len(),
                    html
                );
                let _ = socket.write_all(response.as_bytes()).await;
                let _ = socket.shutdown().await;
            }
        });

        let client = reqwest::Client::new();
        let test_url = format!("http://127.0.0.1:{}/article_news_item", port);
        let res = probe_url(&client, &test_url).await;
        assert!(res.is_err());
        let err = res.err().unwrap().to_string();
        assert!(err.contains("URL returned an HTML webpage rather than a direct media stream"));
    }
}
