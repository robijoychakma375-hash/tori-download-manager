use reqwest::header::{HeaderValue, REFERER};
use reqwest::RequestBuilder;
use url::Url;

/// Sanitizes and validates a Referer URL according to W3C Referrer Policy (strict-origin-when-cross-origin)
/// and security standards:
/// 1. Only http:// and https:// schemes are permitted.
/// 2. CRLF (\r, \n) and control characters are strictly rejected (prevents HTTP header injection).
/// 3. Credentials (username/password) are completely stripped.
/// 4. URL fragments (#fragment) are stripped per RFC 9110 §10.2.
/// 5. Query parameters are stripped to prevent sensitive token/session leaks.
/// 6. HTTPS -> HTTP downgrades emit NO referer (prevent plaintext protocol downgrade leaks).
/// 7. Cross-origin targets receive origin-only (https://example.com/) to shield inner paths from 3rd parties.
/// 8. Same-origin targets receive origin + path (no query/fragment/creds).
/// 9. Returns None if the input is malformed, invalid, or unsafe.
pub fn sanitize_and_validate_referer(raw_referer: &str, target_url: &str) -> Option<String> {
    let trimmed = raw_referer.trim();
    if trimmed.is_empty() || trimmed.len() > 4096 {
        return None;
    }

    // Strict rejection of control characters and CRLF
    if trimmed
        .chars()
        .any(|c| c.is_ascii_control() || c == '\r' || c == '\n')
    {
        return None;
    }

    let Ok(mut ref_url) = Url::parse(trimmed) else {
        return None;
    };

    // Scheme check: only http and https are valid Referer schemes
    if ref_url.scheme() != "http" && ref_url.scheme() != "https" {
        return None;
    }

    ref_url.host_str()?;

    let Ok(target) = Url::parse(target_url.trim()) else {
        return None;
    };

    if target.scheme() != "http" && target.scheme() != "https" {
        return None;
    }

    // Strict-origin-when-cross-origin: HTTPS to HTTP downgrade must omit Referer
    if ref_url.scheme() == "https" && target.scheme() == "http" {
        return None;
    }

    // Strip credentials (userinfo)
    let _ = ref_url.set_username("");
    let _ = ref_url.set_password(None);

    // Strip URL fragment per RFC 9110 §10.2
    ref_url.set_fragment(None);

    // Strip query string to prevent token/session credential leakage
    ref_url.set_query(None);

    // Compare origin: scheme, host, port
    let is_same_origin = ref_url.scheme() == target.scheme()
        && ref_url.host_str() == target.host_str()
        && ref_url.port_or_known_default() == target.port_or_known_default();

    if !is_same_origin {
        // Cross-origin: truncate to origin only
        ref_url.set_path("/");
    }

    let result_str = ref_url.to_string();

    // Verify it parses as a valid ASCII HTTP header value
    if HeaderValue::from_str(&result_str).is_err() {
        return None;
    }

    Some(result_str)
}

/// Applies a sanitized Referer header to a reqwest RequestBuilder if valid.
/// If referer is None or invalid, returns the RequestBuilder unmodified.
pub fn apply_referer(
    req: RequestBuilder,
    referer: Option<&str>,
    target_url: &str,
) -> RequestBuilder {
    if let Some(r) = referer {
        if let Some(clean) = sanitize_and_validate_referer(r, target_url) {
            if let Ok(val) = HeaderValue::from_str(&clean) {
                return req.header(REFERER, val);
            }
        }
    }
    req
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_valid_same_origin_referer() {
        let referer = "https://example.com/watch/video123?token=secret123#timestamp";
        let target = "https://example.com/media/file.mp4";
        let sanitized = sanitize_and_validate_referer(referer, target);
        assert_eq!(
            sanitized,
            Some("https://example.com/watch/video123".to_string())
        );
    }

    #[test]
    fn test_valid_cross_origin_referer_truncated_to_origin() {
        let referer = "https://example.com/watch/video123?token=secret123#timestamp";
        let target = "https://cdn.fastly.com/media/file.mp4";
        let sanitized = sanitize_and_validate_referer(referer, target);
        assert_eq!(sanitized, Some("https://example.com/".to_string()));
    }

    #[test]
    fn test_https_to_http_downgrade_omitted() {
        let referer = "https://secure.example.com/watch";
        let target = "http://insecure.example.com/media/file.mp4";
        let sanitized = sanitize_and_validate_referer(referer, target);
        assert_eq!(sanitized, None);
    }

    #[test]
    fn test_http_to_http_same_origin() {
        let referer = "http://example.com/page";
        let target = "http://example.com/file.mp4";
        let sanitized = sanitize_and_validate_referer(referer, target);
        assert_eq!(sanitized, Some("http://example.com/page".to_string()));
    }

    #[test]
    fn test_credentials_stripped() {
        let referer = "https://admin:supersecret@example.com/page";
        let target = "https://example.com/file.mp4";
        let sanitized = sanitize_and_validate_referer(referer, target);
        assert_eq!(sanitized, Some("https://example.com/page".to_string()));
        assert!(!sanitized.unwrap().contains("supersecret"));
    }

    #[test]
    fn test_crlf_injection_rejected() {
        let referer = "https://example.com/page\r\nEvil-Header: injected";
        let target = "https://example.com/file.mp4";
        assert_eq!(sanitize_and_validate_referer(referer, target), None);

        let referer2 = "https://example.com/page\nEvil: 1";
        assert_eq!(sanitize_and_validate_referer(referer2, target), None);
    }

    #[test]
    fn test_control_characters_rejected() {
        let referer = "https://example.com/page\x00null";
        let target = "https://example.com/file.mp4";
        assert_eq!(sanitize_and_validate_referer(referer, target), None);
    }

    #[test]
    fn test_invalid_schemes_rejected() {
        let target = "https://example.com/file.mp4";
        assert_eq!(
            sanitize_and_validate_referer("javascript:alert(1)", target),
            None
        );
        assert_eq!(
            sanitize_and_validate_referer("chrome-extension://abcdef/popup.html", target),
            None
        );
        assert_eq!(
            sanitize_and_validate_referer("blob:https://example.com/uuid", target),
            None
        );
        assert_eq!(
            sanitize_and_validate_referer("data:text/html,hello", target),
            None
        );
        assert_eq!(
            sanitize_and_validate_referer("file:///C:/passwords.txt", target),
            None
        );
        assert_eq!(sanitize_and_validate_referer("about:blank", target), None);
    }

    #[test]
    fn test_empty_and_whitespace_rejected() {
        let target = "https://example.com/file.mp4";
        assert_eq!(sanitize_and_validate_referer("", target), None);
        assert_eq!(sanitize_and_validate_referer("   ", target), None);
    }
}
