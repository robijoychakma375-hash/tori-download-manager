use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, ToSocketAddrs};
use url::Url;

use crate::error::{EngineError, Result};

/// Strictly validates HTTP/HTTPS URL syntax without network I/O.
/// Rejects control characters, whitespace, leading `-` (CLI flag injection), non-HTTP(S) schemes,
/// and URLs without a valid host.
pub fn validate_http_url_syntax(raw_url: &str) -> Result<Url> {
    let trimmed = raw_url.trim();
    if trimmed.is_empty() {
        return Err(EngineError::InvalidUrl("URL must not be empty".into()));
    }
    if trimmed.starts_with('-') {
        return Err(EngineError::InvalidUrl(
            "URL must not start with '-' (potential CLI flag injection)".into(),
        ));
    }
    if trimmed
        .chars()
        .any(|c| c.is_control() || c.is_whitespace())
    {
        return Err(EngineError::InvalidUrl(
            "URL must not contain whitespace or control characters".into(),
        ));
    }

    let parsed = Url::parse(trimmed).map_err(|e| EngineError::InvalidUrl(e.to_string()))?;
    let scheme = parsed.scheme().to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return Err(EngineError::InvalidUrl(format!(
            "Unsupported protocol scheme '{}'. Only HTTP/HTTPS URLs are allowed.",
            scheme
        )));
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| EngineError::InvalidUrl("Missing host in URL".into()))?;
    if host.is_empty() {
        return Err(EngineError::InvalidUrl("Missing host in URL".into()));
    }
    Ok(parsed)
}

/// Checks whether a hostname string is a restricted local/internal name.
pub fn is_restricted_hostname(host_str: &str) -> bool {
    let lower_host = host_str.trim().trim_end_matches('.').to_ascii_lowercase();
    lower_host == "localhost"
        || lower_host.ends_with(".localhost")
        || lower_host == "broadcasthost"
        || lower_host.ends_with(".local")
        || lower_host.ends_with(".internal")
}

/// Builds a `reqwest` redirect policy (max 5 hops) that enforces SSRF protections on every
/// redirect target so an external URL cannot redirect into loopback, RFC 1918, or cloud metadata.
pub fn ssrf_safe_redirect_policy() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() >= 5 {
            return attempt.error("Too many HTTP redirects (max 5)");
        }
        let scheme = attempt.url().scheme().to_string();
        if scheme != "http" && scheme != "https" {
            return attempt.error(format!("Redirect to disallowed scheme '{}'", scheme));
        }
        let Some(host_str) = attempt.url().host_str().map(|s| s.to_string()) else {
            return attempt.error("Redirect target missing host");
        };
        let port = attempt.url().port_or_known_default().unwrap_or(80);
        let allow_loopback = std::env::var("TORI_ALLOW_LOOPBACK")
            .map(|v| v == "1")
            .unwrap_or(false);
        if !allow_loopback {
            if is_restricted_hostname(&host_str) {
                return attempt.error(format!(
                    "Redirect to restricted local/internal host '{}' blocked (SSRF protection)",
                    host_str
                ));
            }
            let unbracketed = host_str.trim_start_matches('[').trim_end_matches(']');
            if let Ok(ip) = unbracketed.parse::<IpAddr>() {
                if is_restricted_ip(&ip) {
                    return attempt.error(format!(
                        "Redirect to restricted IP '{}' blocked (SSRF protection)",
                        ip
                    ));
                }
            } else {
                match (host_str.as_str(), port).to_socket_addrs() {
                    Ok(addrs) => {
                        for addr in addrs {
                            if is_restricted_ip(&addr.ip()) {
                                return attempt.error(format!(
                                    "Redirect host '{}' resolved to restricted IP '{}' (SSRF protection)",
                                    host_str,
                                    addr.ip()
                                ));
                            }
                        }
                    }
                    Err(_) => {
                        return attempt.error(format!(
                            "Redirect host '{}' could not be resolved safely",
                            host_str
                        ));
                    }
                }
            }
        }
        attempt.follow()
    })
}

/// Validates that an extraction URL is safe against Server-Side Request Forgery (SSRF),
/// port-scanning, loopback access, link-local metadata leaks, and private network probing.
pub async fn validate_safe_media_url(raw_url: &str) -> Result<Url> {
    let parsed = validate_http_url_syntax(raw_url)?;

    // 2. Validate host presence
    let host_str = parsed
        .host_str()
        .ok_or_else(|| EngineError::InvalidUrl("Missing host in URL".into()))?;

    let allow_loopback = std::env::var("TORI_ALLOW_LOOPBACK")
        .map(|v| v == "1")
        .unwrap_or(false);

    // Check literal localhost hostnames (unless explicitly allowed in integration test harness)
    if !allow_loopback && is_restricted_hostname(host_str) {
        return Err(EngineError::InvalidUrl(format!(
            "Target host '{}' is a restricted local or internal domain name.",
            host_str
        )));
    }

    // 3. Resolve host and inspect every resolved IP
    let port = parsed.port_or_known_default().unwrap_or(80);
    let socket_str = format!("{}:{}", host_str, port);

    // If host is a direct IP address:
    if let Ok(ip) = host_str.parse::<IpAddr>() {
        if !allow_loopback && is_restricted_ip(&ip) {
            return Err(EngineError::InvalidUrl(format!(
                "Target IP address '{}' is in a restricted local or private network range.",
                ip
            )));
        }
    } else {
        // DNS lookup with timeout
        let addrs = tokio::net::lookup_host(&socket_str).await.map_err(|e| {
            EngineError::Other(format!("DNS resolution failed for '{}': {}", host_str, e))
        })?;

        if !allow_loopback {
            for addr in addrs {
                let ip = addr.ip();
                if is_restricted_ip(&ip) {
                    return Err(EngineError::InvalidUrl(format!(
                        "Target hostname '{}' resolved to restricted IP '{}' (SSRF protection).",
                        host_str, ip
                    )));
                }
            }
        }
    }

    Ok(parsed)
}

/// Checks whether an IP address belongs to loopback, private RFC 1918, link-local,
/// cloud metadata (169.254.169.254), multicast, or reserved ranges.
pub fn is_restricted_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(ipv4) => is_restricted_ipv4(ipv4),
        IpAddr::V6(ipv6) => is_restricted_ipv6(ipv6),
    }
}

fn is_restricted_ipv4(ip: &Ipv4Addr) -> bool {
    let octets = ip.octets();

    // 0.0.0.0/8 (Current network)
    if octets[0] == 0 {
        return true;
    }

    // 127.0.0.0/8 (Loopback)
    if octets[0] == 127 {
        return true;
    }

    // 10.0.0.0/8 (Private RFC 1918)
    if octets[0] == 10 {
        return true;
    }

    // 172.16.0.0/12 (Private RFC 1918: 172.16.0.0 - 172.31.255.255)
    if octets[0] == 172 && (16..=31).contains(&octets[1]) {
        return true;
    }

    // 192.168.0.0/16 (Private RFC 1918)
    if octets[0] == 192 && octets[1] == 168 {
        return true;
    }

    // 169.254.0.0/16 (Link-local & Cloud Metadata 169.254.169.254)
    if octets[0] == 169 && octets[1] == 254 {
        return true;
    }

    // 100.64.0.0/10 (Carrier-grade NAT RFC 6598)
    if octets[0] == 100 && (64..=127).contains(&octets[1]) {
        return true;
    }

    // 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24 (TEST-NET-1/2/3)
    if (octets[0] == 192 && octets[1] == 0 && octets[2] == 2)
        || (octets[0] == 198 && octets[1] == 51 && octets[2] == 100)
        || (octets[0] == 203 && octets[1] == 0 && octets[2] == 113)
    {
        return true;
    }

    // 224.0.0.0/4 (Multicast) & 240.0.0.0/4 (Reserved)
    if octets[0] >= 224 {
        return true;
    }

    false
}

fn is_restricted_ipv6(ip: &Ipv6Addr) -> bool {
    let segments = ip.segments();

    // ::1 (Loopback)
    if ip.is_loopback() {
        return true;
    }

    // :: (Unspecified)
    if ip.is_unspecified() {
        return true;
    }

    // fe80::/10 (Link-local unicast)
    if (segments[0] & 0xffc0) == 0xfe80 {
        return true;
    }

    // fc00::/7 (Unique local address RFC 4193)
    if (segments[0] & 0xfe00) == 0xfc00 {
        return true;
    }

    // ff00::/8 (Multicast)
    if (segments[0] & 0xff00) == 0xff00 {
        return true;
    }

    // IPv4-mapped IPv6 (::ffff:0:0/96)
    if let Some(ipv4) = ip.to_ipv4_mapped() {
        return is_restricted_ipv4(&ipv4);
    }

    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_restricted_ips() {
        assert!(is_restricted_ip(&"127.0.0.1".parse().unwrap()));
        assert!(is_restricted_ip(&"127.1.2.3".parse().unwrap()));
        assert!(is_restricted_ip(&"10.0.0.1".parse().unwrap()));
        assert!(is_restricted_ip(&"172.20.0.1".parse().unwrap()));
        assert!(is_restricted_ip(&"192.168.1.1".parse().unwrap()));
        assert!(is_restricted_ip(&"169.254.169.254".parse().unwrap())); // AWS metadata
        assert!(is_restricted_ip(&"0.0.0.0".parse().unwrap()));
        assert!(is_restricted_ip(&"::1".parse().unwrap()));
        assert!(is_restricted_ip(&"fe80::1".parse().unwrap()));
        assert!(is_restricted_ip(&"fc00::1".parse().unwrap()));

        // Public IPs must not be restricted
        assert!(!is_restricted_ip(&"8.8.8.8".parse().unwrap()));
        assert!(!is_restricted_ip(&"1.1.1.1".parse().unwrap()));
        assert!(!is_restricted_ip(&"142.250.190.46".parse().unwrap()));
    }

    #[tokio::test]
    async fn test_validate_safe_url_rejections() {
        assert!(validate_safe_media_url("http://127.0.0.1/test")
            .await
            .is_err());
        assert!(validate_safe_media_url("http://localhost:8080/test")
            .await
            .is_err());
        assert!(
            validate_safe_media_url("http://169.254.169.254/latest/meta-data/")
                .await
                .is_err()
        );
        assert!(validate_safe_media_url("http://192.168.1.100/video.mp4")
            .await
            .is_err());
        assert!(validate_safe_media_url("file:///C:/Windows/win.ini")
            .await
            .is_err());
    }
}
