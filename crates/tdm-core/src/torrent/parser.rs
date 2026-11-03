use std::path::{Path, PathBuf};
use url::Url;

use crate::error::{EngineError, Result};

#[derive(Debug, Clone)]
pub struct ParsedMagnet {
    pub info_hash_hex: String,
    pub display_name: Option<String>,
    pub trackers: Vec<String>,
    pub exact_length: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct TorrentFileInfo {
    pub path: PathBuf,
    pub length: u64,
}

#[derive(Debug, Clone)]
pub struct ParsedTorrentMeta {
    pub info_hash_hex: String,
    pub name: String,
    pub piece_length: u32,
    pub pieces_count: usize,
    pub total_bytes: u64,
    pub files: Vec<TorrentFileInfo>,
}

/// Parse a magnet: URI string and extract parameters according to BEP 0009 / BEP 0053.
pub fn parse_magnet_uri(raw: &str) -> Result<ParsedMagnet> {
    let trimmed = raw.trim();
    if !trimmed.starts_with("magnet:?") {
        return Err(EngineError::InvalidUrl(
            "Magnet URI must begin with 'magnet:?'".to_string(),
        ));
    }

    let url = Url::parse(trimmed).map_err(|e| EngineError::InvalidUrl(e.to_string()))?;
    let mut info_hash_hex: Option<String> = None;
    let mut display_name: Option<String> = None;
    let mut trackers = Vec::new();
    let mut exact_length: Option<u64> = None;

    for (k, v) in url.query_pairs() {
        match k.as_ref() {
            "xt" => {
                let val = v.as_ref();
                if let Some(rest) = val.strip_prefix("urn:btih:") {
                    // Could be 40-hex or 32-char base32
                    if rest.len() == 40 && rest.chars().all(|c| c.is_ascii_hexdigit()) {
                        info_hash_hex = Some(rest.to_lowercase());
                    } else if rest.len() == 32 {
                        // Decode base32 to 20 bytes -> hex
                        if let Ok(bytes) = decode_base32_to_20_bytes(rest) {
                            info_hash_hex = Some(hex::encode(bytes));
                        }
                    }
                }
            }
            "dn" => {
                if !v.is_empty() {
                    display_name = Some(v.to_string());
                }
            }
            "tr" => {
                if !v.is_empty() {
                    trackers.push(v.to_string());
                }
            }
            "xl" => {
                if let Ok(len) = v.parse::<u64>() {
                    exact_length = Some(len);
                }
            }
            _ => {}
        }
    }

    let hash = info_hash_hex.ok_or_else(|| {
        EngineError::InvalidUrl("Missing or invalid xt=urn:btih: parameter in magnet URI".into())
    })?;

    Ok(ParsedMagnet {
        info_hash_hex: hash,
        display_name,
        trackers,
        exact_length,
    })
}

fn decode_base32_to_20_bytes(s: &str) -> std::result::Result<[u8; 20], ()> {
    let s = s.to_ascii_uppercase();
    let mut bits = 0u64;
    let mut bit_count = 0;
    let mut out = Vec::with_capacity(20);

    for ch in s.chars() {
        let val = match ch {
            'A'..='Z' => ch as u8 - b'A',
            '2'..='7' => ch as u8 - b'2' + 26,
            _ => return Err(()),
        } as u64;

        bits = (bits << 5) | val;
        bit_count += 5;

        while bit_count >= 8 {
            bit_count -= 8;
            out.push((bits >> bit_count) as u8);
            bits &= (1 << bit_count) - 1;
        }
    }

    if out.len() == 20 {
        let mut arr = [0u8; 20];
        arr.copy_from_slice(&out);
        Ok(arr)
    } else {
        Err(())
    }
}

/// Parse a .torrent file from bytes using librqbit metainfo parser.
pub fn parse_torrent_bytes(bytes: &[u8]) -> Result<ParsedTorrentMeta> {
    let parsed = librqbit::torrent_from_bytes(bytes)
        .map_err(|e| EngineError::Other(format!("Failed to parse torrent metainfo: {}", e)))?;

    let info_hash_hex = parsed.info_hash.as_string();
    let name = parsed
        .info
        .data
        .name
        .as_ref()
        .map(|b| String::from_utf8_lossy(b.as_ref()).to_string())
        .unwrap_or_else(|| format!("torrent_{}", &info_hash_hex[..8]));

    let piece_length = parsed.info.data.piece_length as u32;
    let pieces_count = parsed.info.data.pieces.0.len() / 20;

    let mut total_bytes = 0u64;
    let mut files = Vec::new();

    if let Some(len) = parsed.info.data.length {
        // Single-file torrent
        total_bytes = len;
        files.push(TorrentFileInfo {
            path: PathBuf::from(&name),
            length: len,
        });
    } else if let Some(files_list) = &parsed.info.data.files {
        // Multi-file torrent
        for f in files_list {
            let mut file_path = PathBuf::from(&name);
            for p in &f.path {
                file_path.push(String::from_utf8_lossy(p.as_ref()).as_ref());
            }
            total_bytes += f.length;
            files.push(TorrentFileInfo {
                path: file_path,
                length: f.length,
            });
        }
    }

    Ok(ParsedTorrentMeta {
        info_hash_hex,
        name,
        piece_length,
        pieces_count,
        total_bytes,
        files,
    })
}

/// Parse a .torrent file from a local path.
pub fn parse_torrent_file<P: AsRef<Path>>(path: P) -> Result<ParsedTorrentMeta> {
    let bytes = std::fs::read(path.as_ref()).map_err(EngineError::Io)?;
    parse_torrent_bytes(&bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_magnet_uri_hex() {
        let uri = "magnet:?xt=urn:btih:c12fe1c06bba254a9dc9f519b335380dc1f74c38&dn=Ubuntu+ISO&tr=http%3A%2F%2Ftracker.example.com%2Fannounce&xl=1048576";
        let parsed = parse_magnet_uri(uri).unwrap();
        assert_eq!(
            parsed.info_hash_hex,
            "c12fe1c06bba254a9dc9f519b335380dc1f74c38"
        );
        assert_eq!(parsed.display_name.as_deref(), Some("Ubuntu ISO"));
        assert_eq!(parsed.trackers, vec!["http://tracker.example.com/announce"]);
        assert_eq!(parsed.exact_length, Some(1048576));
    }

    #[test]
    fn test_parse_magnet_uri_base32() {
        // 20 zero bytes in base32 is 32 A's
        let uri = "magnet:?xt=urn:btih:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&dn=Test";
        let parsed = parse_magnet_uri(uri).unwrap();
        assert_eq!(
            parsed.info_hash_hex,
            "0000000000000000000000000000000000000000"
        );
        assert_eq!(parsed.display_name.as_deref(), Some("Test"));
    }

    #[test]
    fn test_parse_invalid_magnet() {
        assert!(parse_magnet_uri("http://example.com").is_err());
        assert!(parse_magnet_uri("magnet:?dn=NoHash").is_err());
        assert!(parse_magnet_uri("magnet:?xt=urn:sha1:123").is_err());
    }
}
