use std::time::Instant;
use tdm_core::resolver::extractor::{
    clean_ytdlp_error, execute_yt_dlp_dump, GENERIC_RESOLVER_TIMEOUT,
};
use tdm_core::resolver::pipeline::is_known_platform_domain;
use tdm_core::MediaResolver;

#[test]
fn test_gate12_8_is_known_platform_domain_classification() {
    // Known video platforms
    assert!(is_known_platform_domain(
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    ));
    assert!(is_known_platform_domain("https://youtu.be/dQw4w9WgXcQ"));
    assert!(is_known_platform_domain(
        "https://www.facebook.com/reel/10153231379946729"
    ));
    assert!(is_known_platform_domain("https://fb.watch/xyz123/"));
    assert!(is_known_platform_domain(
        "https://www.instagram.com/reel/C7p8q1Lg8i9/"
    ));
    assert!(is_known_platform_domain(
        "https://www.tiktok.com/@user/video/7123456789012345678"
    ));
    assert!(is_known_platform_domain(
        "https://twitter.com/user/status/1234567890"
    ));
    assert!(is_known_platform_domain(
        "https://x.com/user/status/1234567890"
    ));
    assert!(is_known_platform_domain("https://vimeo.com/76979871"));
    assert!(is_known_platform_domain(
        "https://www.dailymotion.com/video/x8abcdef"
    ));
    assert!(is_known_platform_domain(
        "https://www.twitch.tv/videos/123456789"
    ));
    assert!(is_known_platform_domain(
        "https://soundcloud.com/artist/track"
    ));

    // Generic websites (must NOT be treated as platforms)
    assert!(!is_known_platform_domain("https://fprime.at/watch/123"));
    assert!(!is_known_platform_domain("https://flaxjoy.app/player/test"));
    assert!(!is_known_platform_domain(
        "https://zetmoon.live/stream/live"
    ));
    assert!(!is_known_platform_domain("https://example.com/video.html"));
    assert!(!is_known_platform_domain(
        "https://generic-news.org/article"
    ));
}

#[tokio::test]
async fn test_gate12_8_unsupported_webpage_fast_fail() {
    let resolver = MediaResolver::new();
    let start = Instant::now();

    // Resolving an unsupported generic webpage URL must fail fast (< 12 seconds)
    // rather than hanging for 30s or 35s.
    let res = resolver.resolve("https://fprime.at/nonexistent_test").await;
    let elapsed = start.elapsed();

    println!(
        "[Gate 12.8 Test] Unsupported URL resolve elapsed: {:?}",
        elapsed
    );
    assert!(
        elapsed < std::time::Duration::from_secs(12),
        "Unsupported webpage URL resolve should fast-fail within 12s, took {:?}",
        elapsed
    );

    assert!(
        res.is_err(),
        "Expected resolve error for unsupported webpage URL"
    );
    let err_msg = res.unwrap_err().to_string();
    println!("[Gate 12.8 Test] Fast-fail error output: {}", err_msg);

    // Verify error taxonomy contains meaningful terminal explanation
    assert!(
        err_msg.contains("No supported media extractor")
            || err_msg.contains("timed out")
            || err_msg.contains("unsupported")
            || err_msg.contains("network")
            || err_msg.contains("connection"),
        "Unexpected error message: {}",
        err_msg
    );
}

#[test]
fn test_gate12_8_error_cleaning_and_taxonomy() {
    // 1. Unsupported URL
    let cleaned = clean_ytdlp_error("ERROR: Unsupported URL: https://fprime.at/\n");
    assert_eq!(
        cleaned,
        "No supported media extractor found for this webpage URL."
    );

    let cleaned_no_extractor =
        clean_ytdlp_error("ERROR: no suitable extractor found for https://flaxjoy.app/\n");
    assert_eq!(
        cleaned_no_extractor,
        "No supported media extractor found for this webpage URL."
    );

    // 2. Protected DRM
    let cleaned_drm =
        clean_ytdlp_error("ERROR: This video is DRM protected and cannot be downloaded.\n");
    assert!(cleaned_drm.contains("Digital Rights Management (DRM)"));

    let cleaned_plex = clean_ytdlp_error("ERROR: watch.plex.tv is restricted\n");
    assert!(cleaned_plex.contains("watch.plex.tv content is DRM-protected"));

    // 3. Access Restricted / Auth
    let cleaned_auth = clean_ytdlp_error("ERROR: Login required to view this media.\n");
    assert!(cleaned_auth.contains("Authentication required on the host platform"));

    let cleaned_forbidden = clean_ytdlp_error("ERROR: HTTP Error 403: Forbidden\n");
    assert!(cleaned_forbidden.contains("Remote server denied access (HTTP 403 Forbidden)"));

    let cleaned_private = clean_ytdlp_error("ERROR: Private video. Sign in to view.\n");
    assert!(cleaned_private
        .contains("This media is private and cannot be accessed without authorization"));

    // 4. Rate Limited
    let cleaned_rate = clean_ytdlp_error("ERROR: HTTP Error 429: Too Many Requests\n");
    assert!(cleaned_rate.contains("Rate limited by the host platform (HTTP 429)"));

    // 5. Network Error
    let cleaned_conn = clean_ytdlp_error("ERROR: Connection reset by peer\n");
    assert!(cleaned_conn.contains("Connection interrupted"));
}

#[tokio::test]
async fn test_gate12_8_generic_resolver_timeout_enforced() {
    // Verify GENERIC_RESOLVER_TIMEOUT is bounded to 10s
    assert_eq!(GENERIC_RESOLVER_TIMEOUT.as_secs(), 10);

    // Calling execute_yt_dlp_dump with explicit timeout parameter
    let start = Instant::now();
    let res = execute_yt_dlp_dump(
        "https://flaxjoy.app/",
        Some(std::time::Duration::from_secs(5)),
    )
    .await;
    let elapsed = start.elapsed();

    println!("[Gate 12.8 Test] Bounded dump elapsed: {:?}", elapsed);
    assert!(elapsed < std::time::Duration::from_secs(7));
    assert!(res.is_err());
}
