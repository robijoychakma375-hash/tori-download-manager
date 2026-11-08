use sha2::{Digest, Sha256};
use url::Url;

use crate::resolver::models::MediaMetadata;

pub const DEFAULT_CACHE_TTL_SECS: u64 = 900; // 15 minutes
pub const MAX_CACHE_ENTRIES: usize = 500;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CacheIdentity {
    pub cache_key: String,
    pub platform: String,
    pub video_id: String,
    pub canonical_url: String,
}

/// Normalizes media URLs into collision-resistant, platform-scoped cache keys.
/// Excludes local/internal IPs, direct media files (.mp4, .m3u8, .mpd, etc.), and private/authenticated queries.
pub fn normalize_cache_key(raw_url: &str) -> Option<CacheIdentity> {
    let clean = raw_url.trim();
    if clean.is_empty() {
        return None;
    }

    let parsed = Url::parse(clean).ok()?;
    let scheme = parsed.scheme();
    if scheme != "http" && scheme != "https" {
        return None;
    }

    let host = parsed.host_str()?.to_lowercase();
    let host_clean = host.trim_start_matches("www.");

    // Exclude localhost / loopback / private IP ranges from format cache
    if host_clean == "localhost"
        || host_clean == "127.0.0.1"
        || host_clean.starts_with("192.168.")
        || host_clean.starts_with("10.")
        || host_clean.starts_with("172.")
    {
        return None;
    }

    let path = parsed.path();
    let lower_path = path.to_lowercase();

    // Direct media files with static extensions should not enter the platform format cache
    if lower_path.ends_with(".mp4")
        || lower_path.ends_with(".m4v")
        || lower_path.ends_with(".webm")
        || lower_path.ends_with(".mp3")
        || lower_path.ends_with(".m3u8")
        || lower_path.ends_with(".mpd")
        || lower_path.ends_with(".ts")
        || lower_path.ends_with(".m4s")
        || lower_path.ends_with(".aac")
        || lower_path.ends_with(".ogg")
        || lower_path.ends_with(".flac")
    {
        return None;
    }

    // 1. YouTube
    if host_clean.contains("youtube.com") || host_clean.contains("youtu.be") {
        let mut video_id = None;

        if host_clean.contains("youtu.be") {
            let seg = path.trim_matches('/');
            if !seg.is_empty() && !seg.contains('/') {
                video_id = Some(seg.to_string());
            }
        } else if path.starts_with("/watch") {
            for (k, v) in parsed.query_pairs() {
                if k == "v" && !v.is_empty() {
                    video_id = Some(v.to_string());
                    break;
                }
            }
        } else if path.starts_with("/shorts/")
            || path.starts_with("/embed/")
            || path.starts_with("/v/")
        {
            let segs: Vec<&str> = path.trim_matches('/').split('/').collect();
            if segs.len() >= 2 && !segs[1].is_empty() {
                video_id = Some(segs[1].to_string());
            }
        }

        if let Some(id) = video_id {
            let clean_id: String = id
                .chars()
                .take_while(|c| c.is_alphanumeric() || *c == '-' || *c == '_')
                .collect();
            if !clean_id.is_empty() && clean_id.len() >= 6 {
                return Some(CacheIdentity {
                    cache_key: format!("yt:{}", clean_id),
                    platform: "youtube".to_string(),
                    video_id: clean_id.clone(),
                    canonical_url: format!("https://www.youtube.com/watch?v={}", clean_id),
                });
            }
        }
        return None;
    }

    // 2. Facebook
    if host_clean.contains("facebook.com") || host_clean.contains("fb.watch") {
        let mut video_id = None;

        if host_clean.contains("fb.watch") {
            let seg = path.trim_matches('/');
            if !seg.is_empty() {
                video_id = Some(seg.to_string());
            }
        } else if let Some((_, v_val)) = parsed.query_pairs().find(|(k, _)| k == "v") {
            if !v_val.is_empty() {
                video_id = Some(v_val.to_string());
            }
        } else {
            let segments: Vec<&str> = path.trim_matches('/').split('/').collect();
            for (idx, seg) in segments.iter().enumerate() {
                if (*seg == "reel"
                    || *seg == "reels"
                    || *seg == "videos"
                    || *seg == "watch"
                    || *seg == "p")
                    && idx + 1 < segments.len()
                {
                    let id = segments[idx + 1];
                    if id != "audio" && !id.is_empty() {
                        video_id = Some(id.to_string());
                        break;
                    }
                }
                if (*seg == "r" || *seg == "v")
                    && idx > 0
                    && segments[idx - 1] == "share"
                    && idx + 1 < segments.len()
                {
                    let id = segments[idx + 1];
                    if !id.is_empty() {
                        video_id = Some(id.to_string());
                        break;
                    }
                }
            }
        }

        if let Some(id) = video_id {
            let clean_id: String = id
                .chars()
                .take_while(|c| c.is_alphanumeric() || *c == '-' || *c == '_')
                .collect();
            if !clean_id.is_empty() {
                return Some(CacheIdentity {
                    cache_key: format!("fb:{}", clean_id),
                    platform: "facebook".to_string(),
                    video_id: clean_id.clone(),
                    canonical_url: format!("https://www.facebook.com/watch/?v={}", clean_id),
                });
            }
        }
        return None;
    }

    // 3. TikTok
    if host_clean.contains("tiktok.com") {
        let segments: Vec<&str> = path.trim_matches('/').split('/').collect();
        for (idx, seg) in segments.iter().enumerate() {
            if *seg == "video" && idx + 1 < segments.len() {
                let id = segments[idx + 1];
                let clean_id: String = id.chars().take_while(|c| c.is_ascii_digit()).collect();
                if !clean_id.is_empty() {
                    return Some(CacheIdentity {
                        cache_key: format!("tt:{}", clean_id),
                        platform: "tiktok".to_string(),
                        video_id: clean_id.clone(),
                        canonical_url: format!("https://www.tiktok.com/video/{}", clean_id),
                    });
                }
            }
        }
    }

    // 4. Instagram
    if host_clean.contains("instagram.com") {
        let segments: Vec<&str> = path.trim_matches('/').split('/').collect();
        for (idx, seg) in segments.iter().enumerate() {
            if (*seg == "p" || *seg == "reel" || *seg == "reels" || *seg == "tv")
                && idx + 1 < segments.len()
            {
                let id = segments[idx + 1];
                let clean_id: String = id
                    .chars()
                    .take_while(|c| c.is_alphanumeric() || *c == '-' || *c == '_')
                    .collect();
                if !clean_id.is_empty() {
                    return Some(CacheIdentity {
                        cache_key: format!("ig:{}", clean_id),
                        platform: "instagram".to_string(),
                        video_id: clean_id.clone(),
                        canonical_url: format!("https://www.instagram.com/reel/{}/", clean_id),
                    });
                }
            }
        }
    }

    // 5. Twitter / X
    if host_clean.contains("twitter.com") || host_clean.contains("x.com") {
        let segments: Vec<&str> = path.trim_matches('/').split('/').collect();
        for (idx, seg) in segments.iter().enumerate() {
            if *seg == "status" && idx + 1 < segments.len() {
                let id = segments[idx + 1];
                let clean_id: String = id.chars().take_while(|c| c.is_ascii_digit()).collect();
                if !clean_id.is_empty() {
                    return Some(CacheIdentity {
                        cache_key: format!("tw:{}", clean_id),
                        platform: "twitter".to_string(),
                        video_id: clean_id.clone(),
                        canonical_url: format!("https://x.com/i/status/{}", clean_id),
                    });
                }
            }
        }
    }

    // 6. Vimeo
    if host_clean.contains("vimeo.com") {
        let segments: Vec<&str> = path.trim_matches('/').split('/').collect();
        if let Some(last) = segments.last() {
            let clean_id: String = last.chars().take_while(|c| c.is_ascii_digit()).collect();
            if !clean_id.is_empty() && clean_id.len() >= 4 {
                return Some(CacheIdentity {
                    cache_key: format!("vm:{}", clean_id),
                    platform: "vimeo".to_string(),
                    video_id: clean_id.clone(),
                    canonical_url: format!("https://vimeo.com/{}", clean_id),
                });
            }
        }
    }

    // 7. Generic Platform Fallback
    // Strip tracking query parameters to form canonical representation
    let mut canonical = parsed.clone();
    let clean_pairs: Vec<(String, String)> = canonical
        .query_pairs()
        .filter(|(k, _)| {
            let lower = k.to_lowercase();
            !lower.starts_with("utm_")
                && lower != "fbclid"
                && lower != "gclid"
                && lower != "ref"
                && lower != "ref_src"
                && lower != "t"
                && lower != "time_continue"
        })
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();

    canonical.set_query(None);
    if !clean_pairs.is_empty() {
        let mut serializer = canonical.query_pairs_mut();
        for (k, v) in &clean_pairs {
            serializer.append_pair(k, v);
        }
    }

    let canonical_str = canonical.to_string();
    let mut hasher = Sha256::new();
    hasher.update(canonical_str.as_bytes());
    let hash = hex::encode(hasher.finalize());

    Some(CacheIdentity {
        cache_key: format!("gen:{}", &hash[..32]),
        platform: "generic".to_string(),
        video_id: hash[..16].to_string(),
        canonical_url: canonical_str,
    })
}

/// Sanitizes a MediaMetadata object for safe caching:
/// - Sets `is_cached = Some(true)`
/// - Strips all `direct_stream_url` fields (forces fresh playable URL retrieval on download)
/// - Strips all `http_headers` fields (never persists tokens, cookies, auth credentials)
pub fn sanitize_for_cache(meta: &MediaMetadata) -> MediaMetadata {
    let mut sanitized = meta.clone();
    sanitized.is_cached = Some(true);

    for f in &mut sanitized.formats {
        f.direct_stream_url = None;
        f.http_headers = None;
    }

    sanitized
}

/// Determines whether a MediaMetadata object is safe and eligible for caching.
/// Excludes empty results, direct media streams, and private/restricted responses.
pub fn is_cacheable(meta: &MediaMetadata) -> bool {
    if meta.formats.is_empty() || meta.is_direct_media {
        return false;
    }

    let title_lower = meta.title.to_lowercase();
    if title_lower.contains("private video")
        || title_lower.contains("sign in")
        || title_lower.contains("login required")
        || title_lower.contains("members-only")
    {
        return false;
    }

    true
}
