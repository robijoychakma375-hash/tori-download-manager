use crate::error::Result;
use reqwest::header::{HeaderMap, HeaderValue, USER_AGENT};
use reqwest::Client;
use std::time::Duration;

pub fn build_http_client() -> Result<Client> {
    let mut default_headers = HeaderMap::new();
    default_headers.insert(
        USER_AGENT,
        HeaderValue::from_static(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) TORI-Download-Manager/1.0",
        ),
    );

    // Note: Do NOT set `.timeout(...)` on the global Client because in reqwest `.timeout(...)`
    // enforces a hard wall-clock deadline across the entire response body stream, which aborts
    // multi-gigabyte downloads after 60 seconds even while actively transferring bytes.
    // Instead, use `.connect_timeout` + `.read_timeout` (per-read idle timeout) and explicit
    // header/idle-progress timeouts in probe.rs and worker.rs.
    let client = Client::builder()
        .default_headers(default_headers)
        .redirect(reqwest::redirect::Policy::limited(10))
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(45))
        .pool_idle_timeout(Duration::from_secs(90))
        .pool_max_idle_per_host(16)
        .tcp_keepalive(Duration::from_secs(30))
        .build()?;

    Ok(client)
}
