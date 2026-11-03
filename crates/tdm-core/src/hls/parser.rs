use std::collections::HashMap;
use url::Url;

use crate::error::{EngineError, Result};

#[derive(Debug, Clone, PartialEq)]
pub enum HlsKeyMethod {
    None,
    Aes128,
    Unsupported(String),
}

#[derive(Debug, Clone)]
pub struct HlsKey {
    pub method: HlsKeyMethod,
    pub uri: String,
    pub iv: Option<[u8; 16]>,
}

#[derive(Debug, Clone)]
pub struct HlsInitSegment {
    pub uri: String,
    pub byterange: Option<(u64, Option<u64>)>, // length, offset
}

#[derive(Debug, Clone)]
pub struct HlsSegment {
    pub index: usize,
    pub uri: String,
    pub duration: f64,
    pub title: Option<String>,
    pub byterange: Option<(u64, Option<u64>)>, // length, offset
    pub key: Option<HlsKey>,
    pub discontinuity: bool,
    pub sequence_number: u64,
}

#[derive(Debug, Clone)]
pub struct HlsVariant {
    pub bandwidth: u64,
    pub resolution: Option<(u32, u32)>,
    pub codecs: Option<String>,
    pub uri: String,
    pub audio_group: Option<String>,
}

#[derive(Debug, Clone)]
pub struct HlsAudioRendition {
    pub group_id: String,
    pub name: String,
    pub uri: Option<String>,
    pub is_default: bool,
    pub language: Option<String>,
}

#[derive(Debug, Clone)]
pub struct MasterPlaylist {
    pub variants: Vec<HlsVariant>,
    pub audio_renditions: Vec<HlsAudioRendition>,
}

#[derive(Debug, Clone)]
pub struct MediaPlaylist {
    pub target_duration: f64,
    pub media_sequence: u64,
    pub is_vod: bool,
    pub init_segment: Option<HlsInitSegment>,
    pub segments: Vec<HlsSegment>,
    pub total_duration: f64,
}

#[derive(Debug, Clone)]
pub enum ParsedPlaylist {
    Master(MasterPlaylist),
    Media(MediaPlaylist),
}

/// Resolves a relative URI against the playlist's base URL.
pub fn resolve_url(base_url: &str, relative_uri: &str) -> Result<String> {
    if relative_uri.starts_with("http://") || relative_uri.starts_with("https://") {
        return Ok(relative_uri.to_string());
    }

    let base = Url::parse(base_url)
        .map_err(|e| EngineError::InvalidUrl(format!("Invalid base URL '{}': {}", base_url, e)))?;

    let resolved = base.join(relative_uri).map_err(|e| {
        EngineError::InvalidUrl(format!("Failed to join URL '{}': {}", relative_uri, e))
    })?;

    Ok(resolved.to_string())
}

/// Parses an RFC 8216 HLS Master or Media playlist.
pub fn parse_playlist(content: &str, base_url: &str) -> Result<ParsedPlaylist> {
    if !content.contains("#EXTM3U") {
        return Err(EngineError::Other(
            "Not a valid HLS playlist: missing #EXTM3U tag".to_string(),
        ));
    }

    if content.contains("#EXT-X-STREAM-INF") {
        let master = parse_master_playlist(content, base_url)?;
        Ok(ParsedPlaylist::Master(master))
    } else {
        let media = parse_media_playlist(content, base_url)?;
        Ok(ParsedPlaylist::Media(media))
    }
}

/// Parses an RFC 8216 Master Playlist.
pub fn parse_master_playlist(content: &str, base_url: &str) -> Result<MasterPlaylist> {
    let mut variants = Vec::new();
    let mut audio_renditions = Vec::new();

    let lines: Vec<&str> = content
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect();
    let mut i = 0;

    while i < lines.len() {
        let line = lines[i];

        if let Some(rest) = line.strip_prefix("#EXT-X-MEDIA:") {
            let attrs = parse_attributes(rest);
            let media_type = attrs.get("TYPE").cloned().unwrap_or_default();

            if media_type == "AUDIO" {
                let group_id = attrs.get("GROUP-ID").cloned().unwrap_or_default();
                let name = attrs
                    .get("NAME")
                    .cloned()
                    .unwrap_or_else(|| "default".to_string());
                let uri = attrs.get("URI").and_then(|u| resolve_url(base_url, u).ok());
                let is_default = attrs
                    .get("DEFAULT")
                    .map(|v| v.eq_ignore_ascii_case("YES"))
                    .unwrap_or(false);
                let language = attrs.get("LANGUAGE").cloned();

                audio_renditions.push(HlsAudioRendition {
                    group_id,
                    name,
                    uri,
                    is_default,
                    language,
                });
            }
        } else if let Some(rest) = line.strip_prefix("#EXT-X-STREAM-INF:") {
            let attrs = parse_attributes(rest);
            let bandwidth = attrs
                .get("BANDWIDTH")
                .and_then(|b| b.parse::<u64>().ok())
                .unwrap_or(0);

            let resolution = attrs.get("RESOLUTION").and_then(|r| {
                let parts: Vec<&str> = r.split('x').collect();
                if parts.len() == 2 {
                    let w = parts[0].parse::<u32>().ok()?;
                    let h = parts[1].parse::<u32>().ok()?;
                    Some((w, h))
                } else {
                    None
                }
            });

            let codecs = attrs.get("CODECS").cloned();
            let audio_group = attrs.get("AUDIO").cloned();

            // Next line must be the variant URI
            if i + 1 < lines.len() {
                i += 1;
                let uri_line = lines[i];
                if !uri_line.starts_with('#') {
                    let resolved_uri = resolve_url(base_url, uri_line)?;
                    variants.push(HlsVariant {
                        bandwidth,
                        resolution,
                        codecs,
                        uri: resolved_uri,
                        audio_group,
                    });
                }
            }
        }

        i += 1;
    }

    if variants.is_empty() {
        return Err(EngineError::Other(
            "Master playlist contained no valid variants".to_string(),
        ));
    }

    Ok(MasterPlaylist {
        variants,
        audio_renditions,
    })
}

/// Parses an RFC 8216 Media Playlist.
pub fn parse_media_playlist(content: &str, base_url: &str) -> Result<MediaPlaylist> {
    let mut target_duration = 0.0f64;
    let mut media_sequence = 0u64;
    let mut is_vod = false;
    let mut init_segment: Option<HlsInitSegment> = None;
    let mut segments = Vec::new();
    let mut total_duration = 0.0f64;

    let mut current_duration = 0.0f64;
    let mut current_title: Option<String> = None;
    let mut current_byterange: Option<(u64, Option<u64>)> = None;
    let mut current_key: Option<HlsKey> = None;
    let mut current_discontinuity = false;
    let mut current_sequence = 0u64;
    let mut last_byterange_end = 0u64;

    let lines: Vec<&str> = content
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect();

    for line in lines {
        if line == "#EXT-X-ENDLIST" || line.contains("#EXT-X-PLAYLIST-TYPE:VOD") {
            is_vod = true;
        } else if let Some(rest) = line.strip_prefix("#EXT-X-TARGETDURATION:") {
            if let Ok(td) = rest.trim().parse::<f64>() {
                target_duration = td;
            }
        } else if let Some(rest) = line.strip_prefix("#EXT-X-MEDIA-SEQUENCE:") {
            if let Ok(seq) = rest.trim().parse::<u64>() {
                media_sequence = seq;
                current_sequence = seq;
            }
        } else if let Some(rest) = line.strip_prefix("#EXT-X-MAP:") {
            let attrs = parse_attributes(rest);
            if let Some(uri) = attrs.get("URI") {
                let resolved_uri = resolve_url(base_url, uri)?;
                let byterange = attrs
                    .get("BYTERANGE")
                    .and_then(|br| parse_byterange_spec(br));
                init_segment = Some(HlsInitSegment {
                    uri: resolved_uri,
                    byterange,
                });
            }
        } else if let Some(rest) = line.strip_prefix("#EXT-X-KEY:") {
            let attrs = parse_attributes(rest);
            let method_str = attrs
                .get("METHOD")
                .cloned()
                .unwrap_or_else(|| "NONE".to_string());

            if method_str.eq_ignore_ascii_case("NONE") {
                current_key = None;
            } else if method_str.eq_ignore_ascii_case("AES-128") {
                let uri_str = attrs.get("URI").ok_or_else(|| {
                    EngineError::Other("AES-128 key missing required URI attribute".to_string())
                })?;
                let resolved_key_uri = resolve_url(base_url, uri_str)?;

                let iv = attrs.get("IV").and_then(|iv_str| parse_hex_iv(iv_str));

                current_key = Some(HlsKey {
                    method: HlsKeyMethod::Aes128,
                    uri: resolved_key_uri,
                    iv,
                });
            } else {
                // Reject unsupported DRM (SAMPLE-AES, FairPlay, Widevine, PlayReady)
                let drm_msg = format!(
                    "Unsupported protected HLS encryption method '{}'. TORI does not bypass DRM or unauthorized encryption.",
                    method_str
                );
                return Err(EngineError::Other(drm_msg));
            }
        } else if line == "#EXT-X-DISCONTINUITY" {
            current_discontinuity = true;
        } else if let Some(rest) = line.strip_prefix("#EXT-X-BYTERANGE:") {
            let spec = rest.trim();
            if let Some(br) = parse_byterange_spec(spec) {
                current_byterange = Some(br);
            }
        } else if let Some(rest) = line.strip_prefix("#EXTINF:") {
            let rest = rest.trim();
            let parts: Vec<&str> = rest.splitn(2, ',').collect();
            if let Ok(dur) = parts[0].trim().parse::<f64>() {
                current_duration = dur;
            }
            if parts.len() > 1 && !parts[1].trim().is_empty() {
                current_title = Some(parts[1].trim().to_string());
            }
        } else if !line.starts_with('#') {
            // Media Segment URI!
            let resolved_uri = resolve_url(base_url, line)?;

            // Calculate exact byte-range offset if length was specified without offset
            let adjusted_byterange = if let Some((len, opt_offset)) = current_byterange {
                let offset = opt_offset.unwrap_or(last_byterange_end);
                last_byterange_end = offset + len;
                Some((len, Some(offset)))
            } else {
                None
            };

            segments.push(HlsSegment {
                index: segments.len(),
                uri: resolved_uri,
                duration: current_duration,
                title: current_title.take(),
                byterange: adjusted_byterange,
                key: current_key.clone(),
                discontinuity: current_discontinuity,
                sequence_number: current_sequence,
            });

            total_duration += current_duration;
            current_sequence += 1;
            current_discontinuity = false;
            current_byterange = None;
        }
    }

    if segments.is_empty() {
        return Err(EngineError::Other(
            "Media playlist contained no media segments".to_string(),
        ));
    }

    Ok(MediaPlaylist {
        target_duration,
        media_sequence,
        is_vod,
        init_segment,
        segments,
        total_duration,
    })
}

/// Automatically selects the best compatible variant from a master playlist.
/// Default: highest bandwidth rendition <= 1080p, prioritizing standard H.264/AAC.
pub fn select_default_variant(master: &MasterPlaylist) -> Option<&HlsVariant> {
    if master.variants.is_empty() {
        return None;
    }

    // Filter variants <= 1080p if resolution is known
    let candidates: Vec<&HlsVariant> = master
        .variants
        .iter()
        .filter(|v| match v.resolution {
            Some((_, h)) => h <= 1080,
            None => true,
        })
        .collect();

    let pool = if !candidates.is_empty() {
        candidates
    } else {
        master.variants.iter().collect()
    };

    // Pick highest bandwidth variant from pool
    pool.into_iter().max_by_key(|v| v.bandwidth)
}

/// Parses key=value attributes from an HLS tag (e.g. `NAME="foo",BANDWIDTH=12345,URI="bar"`).
pub fn parse_attributes(attr_str: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let mut chars = attr_str.chars().peekable();

    while chars.peek().is_some() {
        // Skip commas and whitespace
        while let Some(&c) = chars.peek() {
            if c == ',' || c.is_whitespace() {
                chars.next();
            } else {
                break;
            }
        }

        // Parse key
        let mut key = String::new();
        while let Some(&c) = chars.peek() {
            if c == '=' {
                chars.next();
                break;
            }
            key.push(c);
            chars.next();
        }
        let key = key.trim().to_uppercase();

        if key.is_empty() {
            break;
        }

        // Parse value (quoted or unquoted)
        let mut val = String::new();
        if let Some(&'"') = chars.peek() {
            chars.next(); // consume opening quote
            for c in chars.by_ref() {
                if c == '"' {
                    break;
                }
                val.push(c);
            }
        } else {
            while let Some(&c) = chars.peek() {
                if c == ',' || c.is_whitespace() {
                    break;
                }
                val.push(c);
                chars.next();
            }
        }

        map.insert(key, val);
    }

    map
}

/// Parses `#EXT-X-BYTERANGE:<length>[@<offset>]`.
fn parse_byterange_spec(spec: &str) -> Option<(u64, Option<u64>)> {
    let parts: Vec<&str> = spec.split('@').collect();
    let len = parts[0].trim().parse::<u64>().ok()?;
    let offset = if parts.len() > 1 {
        parts[1].trim().parse::<u64>().ok()
    } else {
        None
    };
    Some((len, offset))
}

/// Parses a 128-bit hex IV (e.g. `0x1234567890abcdef1234567890abcdef`).
fn parse_hex_iv(iv_str: &str) -> Option<[u8; 16]> {
    let clean = iv_str.trim().strip_prefix("0x").unwrap_or(iv_str.trim());
    if clean.len() != 32 {
        return None;
    }
    let bytes = hex::decode(clean).ok()?;
    if bytes.len() == 16 {
        let mut arr = [0u8; 16];
        arr.copy_from_slice(&bytes);
        Some(arr)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_master_playlist_variants_and_renditions() {
        let content = r#"#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-main",NAME="English",DEFAULT=YES,URI="audio/en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2",AUDIO="audio-main"
low/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="audio-main"
mid/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="avc1.4d4028,mp4a.40.2",AUDIO="audio-main"
high/index.m3u8
"#;

        let base = "https://cdn.example.com/hls/master.m3u8";
        let parsed = parse_playlist(content, base).unwrap();

        match parsed {
            ParsedPlaylist::Master(master) => {
                assert_eq!(master.variants.len(), 3);
                assert_eq!(master.audio_renditions.len(), 1);

                assert_eq!(master.audio_renditions[0].name, "English");
                assert_eq!(
                    master.audio_renditions[0].uri.as_deref(),
                    Some("https://cdn.example.com/hls/audio/en.m3u8")
                );

                let default_var = select_default_variant(&master).unwrap();
                assert_eq!(default_var.bandwidth, 5000000);
                assert_eq!(default_var.resolution, Some((1920, 1080)));
                assert_eq!(
                    default_var.uri,
                    "https://cdn.example.com/hls/high/index.m3u8"
                );
            }
            _ => panic!("Expected Master Playlist"),
        }
    }

    #[test]
    fn test_parse_media_playlist_byterange_init_and_keys() {
        let content = r#"#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:100
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-MAP:URI="init.mp4",BYTERANGE="720@0"
#EXT-X-KEY:METHOD=AES-128,URI="https://cdn.example.com/key.bin",IV=0x0102030405060708090a0b0c0d0e0f10
#EXTINF:5.000,Segment 100
#EXT-X-BYTERANGE:100000@720
seg_100.m4s
#EXT-X-DISCONTINUITY
#EXTINF:4.500,Segment 101
#EXT-X-BYTERANGE:95000
seg_101.m4s
#EXT-X-ENDLIST
"#;

        let base = "https://cdn.example.com/hls/media.m3u8";
        let parsed = parse_playlist(content, base).unwrap();

        match parsed {
            ParsedPlaylist::Media(media) => {
                assert!(media.is_vod);
                assert_eq!(media.target_duration, 6.0);
                assert_eq!(media.media_sequence, 100);
                assert_eq!(media.segments.len(), 2);

                // Init segment
                let init = media.init_segment.unwrap();
                assert_eq!(init.uri, "https://cdn.example.com/hls/init.mp4");
                assert_eq!(init.byterange, Some((720, Some(0))));

                // Seg 0
                let s0 = &media.segments[0];
                assert_eq!(s0.sequence_number, 100);
                assert_eq!(s0.byterange, Some((100000, Some(720))));
                assert_eq!(s0.uri, "https://cdn.example.com/hls/seg_100.m4s");
                let key0 = s0.key.as_ref().unwrap();
                assert_eq!(key0.method, HlsKeyMethod::Aes128);
                assert_eq!(key0.uri, "https://cdn.example.com/key.bin");
                assert_eq!(
                    key0.iv,
                    Some([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])
                );

                // Seg 1 (continuous byterange & discontinuity)
                let s1 = &media.segments[1];
                assert_eq!(s1.sequence_number, 101);
                assert!(s1.discontinuity);
                assert_eq!(s1.byterange, Some((95000, Some(100720))));
            }
            _ => panic!("Expected Media Playlist"),
        }
    }

    #[test]
    fn test_parse_media_playlist_rejects_drm() {
        let content = r#"#EXTM3U
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://drm.example.com/license"
#EXTINF:4.0,
seg1.ts
"#;
        let res = parse_playlist(content, "https://example.com/vod.m3u8");
        assert!(res.is_err());
        assert!(res
            .unwrap_err()
            .to_string()
            .contains("Unsupported protected HLS encryption method 'SAMPLE-AES'"));
    }
}
