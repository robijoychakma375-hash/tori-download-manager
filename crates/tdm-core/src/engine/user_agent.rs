use reqwest::header::{HeaderValue, USER_AGENT};
use reqwest::RequestBuilder;

pub const DEFAULT_USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) TORI-Download-Manager/1.0";

/// Maximum permitted length for custom User-Agent strings (1024 bytes).
pub const MAX_USER_AGENT_LEN: usize = 1024;

/// Sanitizes and validates a browser User-Agent header value:
/// 1. Rejects empty, whitespace-only, or overly long inputs (> 1024 characters).
/// 2. Rejects CRLF (\r, \n) to strictly defend against HTTP header injection.
/// 3. Rejects ASCII control characters (0-31 and 127).
/// 4. Validates that the trimmed string conforms to HTTP header value syntax via HeaderValue.
/// 5. Returns Some(trimmed) if valid; None if invalid, empty, or malicious.
pub fn sanitize_and_validate_user_agent(raw_ua: &str) -> Option<String> {
    let trimmed = raw_ua.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_USER_AGENT_LEN {
        return None;
    }

    // Strict rejection of CRLF and ASCII control characters (0..=31, 127)
    if trimmed
        .chars()
        .any(|c| c.is_ascii_control() || c == '\r' || c == '\n')
    {
        return None;
    }

    // Must be valid HTTP header value
    if HeaderValue::from_str(trimmed).is_err() {
        return None;
    }

    Some(trimmed.to_string())
}

/// Applies a sanitized User-Agent header to a reqwest RequestBuilder if provided and valid.
/// If user_agent is None or fails validation, the RequestBuilder is returned unchanged,
/// allowing reqwest's default TORI User-Agent to be transmitted without mutation.
pub fn apply_user_agent(builder: RequestBuilder, user_agent: Option<&str>) -> RequestBuilder {
    if let Some(ua) = user_agent {
        if let Some(clean) = sanitize_and_validate_user_agent(ua) {
            if let Ok(hv) = HeaderValue::from_str(&clean) {
                return builder.header(USER_AGENT, hv);
            }
        }
    }
    builder
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_valid_standard_user_agents() {
        let chrome_ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
        assert_eq!(
            sanitize_and_validate_user_agent(chrome_ua),
            Some(chrome_ua.to_string())
        );

        let edge_ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0";
        assert_eq!(
            sanitize_and_validate_user_agent(edge_ua),
            Some(edge_ua.to_string())
        );

        let firefox_ua =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0";
        assert_eq!(
            sanitize_and_validate_user_agent(firefox_ua),
            Some(firefox_ua.to_string())
        );
    }

    #[test]
    fn test_crlf_injection_rejected() {
        assert!(sanitize_and_validate_user_agent("Mozilla/5.0\r\nInjected: malicious").is_none());
        assert!(sanitize_and_validate_user_agent("Mozilla/5.0\nInjected: malicious").is_none());
        assert!(sanitize_and_validate_user_agent("Mozilla/5.0\rInjected: malicious").is_none());
        assert!(sanitize_and_validate_user_agent("ValidUA\r\n\r\nGET / HTTP/1.1").is_none());
    }

    #[test]
    fn test_control_characters_rejected() {
        assert!(sanitize_and_validate_user_agent("Mozilla/5.0\0NUL").is_none());
        assert!(sanitize_and_validate_user_agent("Mozilla/5.0\x07BELL").is_none());
        assert!(sanitize_and_validate_user_agent("Mozilla/5.0\x1bESC").is_none());
        assert!(sanitize_and_validate_user_agent("Mozilla/5.0\x7fDEL").is_none());
    }

    #[test]
    fn test_empty_and_whitespace_rejected() {
        assert!(sanitize_and_validate_user_agent("").is_none());
        assert!(sanitize_and_validate_user_agent("   ").is_none());
        assert!(sanitize_and_validate_user_agent("\t\r\n").is_none());
    }

    #[test]
    fn test_overly_long_user_agent_rejected() {
        let long_ua = "A".repeat(1025);
        assert!(sanitize_and_validate_user_agent(&long_ua).is_none());

        let max_ua = "A".repeat(1024);
        assert_eq!(sanitize_and_validate_user_agent(&max_ua), Some(max_ua));
    }

    #[test]
    fn test_whitespace_trimming() {
        let ua = "   Mozilla/5.0 (Windows NT 10.0; Win64; x64)   ";
        assert_eq!(
            sanitize_and_validate_user_agent(ua),
            Some("Mozilla/5.0 (Windows NT 10.0; Win64; x64)".to_string())
        );
    }
}
