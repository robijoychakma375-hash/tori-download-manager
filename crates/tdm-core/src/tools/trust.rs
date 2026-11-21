use base64::Engine as _;
use rsa::{BigUint, Pkcs1v15Sign, RsaPublicKey};
use sha1::Sha1;
use sha2::{Digest, Sha256, Sha384, Sha512};
use std::fs::File;
use std::io::Read;
use std::path::Path;
use url::Url;

use crate::error::{EngineError, Result};

/// TORI official Ed25519 minisign public key (matches src-tauri/tauri.conf.json key ID CDC23D8CC8DA5397).
pub const TORI_ED25519_PUBKEY_B64: &str =
    "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IENEQzIzRDhDQzhEQTUzOTcKUldTWFU5cklqRDNDelRBOVAzOSs1L0RXN0FFLy9YWGFJc2NnUStaNktxSkNOQ1ZCeG01MjFTZzQK";

/// Official yt-dlp OpenPGP RSA-4096 signing key (Simon Sawicki <contact@grub4k.xyz>).
pub const YTDLP_PGP_PUBKEY_ASC: &str = include_str!("ytdlp_pubkey.asc");
pub const YTDLP_PGP_FINGERPRINT_HEX: &str = "AC0CBBE6848D6A873464AF4E57CF65933B5A7581";

/// Strict HTTPS allowlist for official upstream external-tool hosts and GitHub release asset CDNs.
const ALLOWED_HTTPS_HOSTS: &[&str] = &[
    "api.github.com",
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
    "github-releases.githubusercontent.com",
    "www.gyan.dev",
    "gyan.dev",
    "toridownload.xyz",
];

/// Validates that a URL uses HTTPS on an allowlisted official host (or strictly `127.0.0.1` ONLY in test mode).
pub fn validate_trusted_url(raw_url: &str, allow_loopback_http: bool) -> Result<Url> {
    let parsed = Url::parse(raw_url.trim())
        .map_err(|e| EngineError::InvalidUrl(format!("Invalid tool update URL: {}", e)))?;

    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(EngineError::Other(
            "Rejected URL containing embedded credentials".to_string(),
        ));
    }

    let host = parsed
        .host_str()
        .ok_or_else(|| EngineError::InvalidUrl("Tool update URL missing host".to_string()))?
        .to_ascii_lowercase();

    if allow_loopback_http && host == "127.0.0.1" && matches!(parsed.scheme(), "http" | "https") {
        return Ok(parsed);
    }

    if parsed.scheme() != "https" {
        return Err(EngineError::Other(format!(
            "Untrusted insecure URL scheme '{}': HTTPS is strictly required",
            parsed.scheme()
        )));
    }

    if !ALLOWED_HTTPS_HOSTS.iter().any(|allowed| *allowed == host) {
        return Err(EngineError::Other(format!(
            "Untrusted download host '{}': not in official external-tools allowlist",
            host
        )));
    }

    Ok(parsed)
}

/// Builds a hardened reqwest HTTP client that validates every redirect hop against the trusted host allowlist.
pub fn build_trusted_http_client(
    timeout_secs: u64,
    allow_loopback_http: bool,
) -> Result<reqwest::Client> {
    let redirect_policy = reqwest::redirect::Policy::custom(move |attempt| {
        if attempt.previous().len() >= 8 {
            return attempt.error("Too many HTTP redirects while fetching external tool");
        }
        match validate_trusted_url(attempt.url().as_str(), allow_loopback_http) {
            Ok(_) => attempt.follow(),
            Err(e) => attempt.error(e.to_string()),
        }
    });

    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(timeout_secs))
        .connect_timeout(std::time::Duration::from_secs(15))
        .redirect(redirect_policy)
        .user_agent("TORI-Download-Manager/1.0.6 (ExternalToolsUpdater)")
        .build()
        .map_err(|e| EngineError::Other(format!("Failed building trusted HTTP client: {}", e)))
}

/// Computes lowercase SHA-256 hex digest of a file using streaming 64 KiB reads.
pub fn compute_file_sha256(path: &Path) -> Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 65536];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

/// Verifies that a file is a valid Windows x86_64 (AMD64) PE executable.
/// Rejects scripts, ELF binaries, ARM64/x86 PE files, truncated files, and malformed headers.
pub fn validate_windows_x64_pe_file(path: &Path) -> Result<()> {
    let mut file = File::open(path)?;
    let meta = file.metadata()?;
    if meta.len() < 512 {
        return Err(EngineError::Other(format!(
            "Executable '{}' is too small ({} bytes) to be a valid Windows x64 PE binary",
            path.display(),
            meta.len()
        )));
    }

    let mut header = [0u8; 4096];
    let n = file.read(&mut header)?;
    validate_windows_x64_pe_bytes(&header[..n])
}

pub fn validate_windows_x64_pe_bytes(data: &[u8]) -> Result<()> {
    if data.len() < 0x40 || &data[0..2] != b"MZ" {
        return Err(EngineError::Other(
            "Invalid executable format: missing Windows PE 'MZ' header".to_string(),
        ));
    }
    let e_lfanew = u32::from_le_bytes([data[0x3C], data[0x3D], data[0x3E], data[0x3F]]) as usize;
    if e_lfanew + 26 > data.len() {
        return Err(EngineError::Other(
            "Invalid Windows PE executable: corrupted e_lfanew offset".to_string(),
        ));
    }
    if &data[e_lfanew..e_lfanew + 4] != b"PE\0\0" {
        return Err(EngineError::Other(
            "Invalid executable format: missing 'PE\\0\\0' signature".to_string(),
        ));
    }
    let machine = u16::from_le_bytes([data[e_lfanew + 4], data[e_lfanew + 5]]);
    if machine != 0x8664 {
        return Err(EngineError::Other(format!(
            "Unsupported Windows PE architecture 0x{:04X}: expected x86_64 (0x8664)",
            machine
        )));
    }
    let opt_magic = u16::from_le_bytes([data[e_lfanew + 24], data[e_lfanew + 25]]);
    if opt_magic != 0x020B {
        return Err(EngineError::Other(format!(
            "Invalid PE32+ optional header magic 0x{:04X}: expected 0x020B",
            opt_magic
        )));
    }
    Ok(())
}

/// Verifies a TORI Minisign Ed25519 detached signature over `payload`.
/// Supports both base64-encoded minisign pubkey boxes (like `tauri.conf.json`) and raw two-line minisign boxes.
pub fn verify_minisign_ed25519(
    pubkey_input: &str,
    payload: &[u8],
    sig_text: &str,
) -> Result<()> {
    let trimmed_key = pubkey_input.trim();
    let pk = if trimmed_key.contains('\n') || trimmed_key.starts_with("untrusted comment:") {
        minisign_verify::PublicKey::decode(trimmed_key)
    } else if let Ok(decoded_bytes) = base64::engine::general_purpose::STANDARD.decode(trimmed_key)
    {
        if let Ok(decoded_str) = String::from_utf8(decoded_bytes) {
            if decoded_str.contains("untrusted comment:") {
                minisign_verify::PublicKey::decode(&decoded_str)
            } else {
                minisign_verify::PublicKey::from_base64(trimmed_key)
            }
        } else {
            minisign_verify::PublicKey::from_base64(trimmed_key)
        }
    } else {
        minisign_verify::PublicKey::from_base64(trimmed_key)
    }
    .map_err(|e| EngineError::Other(format!("Invalid Ed25519 public key: {}", e)))?;

    let trimmed_sig = sig_text.trim();
    let decoded_sig_text = if trimmed_sig.contains('\n')
        || trimmed_sig.starts_with("untrusted comment:")
    {
        trimmed_sig.to_string()
    } else if let Ok(raw) = base64::engine::general_purpose::STANDARD.decode(trimmed_sig) {
        String::from_utf8(raw).unwrap_or_else(|_| trimmed_sig.to_string())
    } else {
        trimmed_sig.to_string()
    };

    let sig = minisign_verify::Signature::decode(&decoded_sig_text)
        .map_err(|e| EngineError::Other(format!("Invalid Ed25519 signature format: {}", e)))?;

    pk.verify(payload, &sig, true)
        .map_err(|e| EngineError::Other(format!("Ed25519 signature verification failed: {}", e)))
}

// ============================================================================
// Pure-Rust RFC 4880 V4 OpenPGP RSA Detached Signature Verifier (for yt-dlp)
// ============================================================================

fn crc24_openpgp(data: &[u8]) -> u32 {
    const INIT: u32 = 0x00B7_04CE;
    const POLY: u32 = 0x0186_4CFB;
    let mut crc = INIT;
    for &b in data {
        crc ^= (b as u32) << 16;
        for _ in 0..8 {
            crc <<= 1;
            if (crc & 0x0100_0000) != 0 {
                crc ^= POLY;
            }
        }
    }
    crc & 0x00FF_FFFF
}

fn decode_pgp_armor(input: &str) -> Result<Vec<u8>> {
    let mut in_body = false;
    let mut b64 = String::new();
    let mut expected_crc: Option<u32> = None;

    for raw_line in input.lines() {
        let line = raw_line.trim();
        if line.starts_with("-----BEGIN PGP ") {
            in_body = false;
            continue;
        }
        if line.starts_with("-----END PGP ") {
            break;
        }
        if !in_body {
            if line.is_empty() {
                in_body = true;
            }
            continue;
        }
        if let Some(crc_b64) = line.strip_prefix('=') {
            let crc_bytes = base64::engine::general_purpose::STANDARD
                .decode(crc_b64.trim())
                .map_err(|e| EngineError::Other(format!("Invalid OpenPGP CRC24 base64: {}", e)))?;
            if crc_bytes.len() == 3 {
                expected_crc = Some(
                    ((crc_bytes[0] as u32) << 16)
                        | ((crc_bytes[1] as u32) << 8)
                        | (crc_bytes[2] as u32),
                );
            }
            break;
        }
        b64.push_str(line);
    }

    let decoded = base64::engine::general_purpose::STANDARD
        .decode(b64.as_bytes())
        .map_err(|e| EngineError::Other(format!("Invalid OpenPGP armored payload: {}", e)))?;

    if let Some(exp) = expected_crc {
        let actual = crc24_openpgp(&decoded);
        if actual != exp {
            return Err(EngineError::Other(
                "OpenPGP ASCII armor CRC-24 checksum mismatch".to_string(),
            ));
        }
    }

    Ok(decoded)
}

fn parse_openpgp_packets(bytes: &[u8]) -> Result<Vec<(u8, Vec<u8>)>> {
    let mut packets = Vec::new();
    let mut pos = 0;

    while pos < bytes.len() {
        let ptag = bytes[pos];
        pos += 1;
        if (ptag & 0x80) == 0 {
            return Err(EngineError::Other(
                "Invalid OpenPGP packet header bit 7".to_string(),
            ));
        }

        let (tag, body_len) = if (ptag & 0x40) != 0 {
            // New packet format (RFC 4880 Section 4.2.2)
            let tag = ptag & 0x3F;
            if pos >= bytes.len() {
                return Err(EngineError::Other("Truncated OpenPGP packet length".to_string()));
            }
            let first = bytes[pos] as usize;
            pos += 1;
            let len = if first < 192 {
                first
            } else if first < 224 {
                if pos >= bytes.len() {
                    return Err(EngineError::Other("Truncated 2-byte OpenPGP length".to_string()));
                }
                let second = bytes[pos] as usize;
                pos += 1;
                ((first - 192) << 8) + second + 192
            } else if first == 255 {
                if pos + 4 > bytes.len() {
                    return Err(EngineError::Other("Truncated 5-byte OpenPGP length".to_string()));
                }
                let len = u32::from_be_bytes([
                    bytes[pos],
                    bytes[pos + 1],
                    bytes[pos + 2],
                    bytes[pos + 3],
                ]) as usize;
                pos += 4;
                len
            } else {
                return Err(EngineError::Other(
                    "Unsupported OpenPGP partial body length packet".to_string(),
                ));
            };
            (tag, len)
        } else {
            // Old packet format (RFC 4880 Section 4.2.1)
            let tag = (ptag & 0x3C) >> 2;
            let len_type = ptag & 0x03;
            let len = match len_type {
                0 => {
                    if pos >= bytes.len() {
                        return Err(EngineError::Other("Truncated old-format 1-byte length".to_string()));
                    }
                    let l = bytes[pos] as usize;
                    pos += 1;
                    l
                }
                1 => {
                    if pos + 2 > bytes.len() {
                        return Err(EngineError::Other("Truncated old-format 2-byte length".to_string()));
                    }
                    let l = u16::from_be_bytes([bytes[pos], bytes[pos + 1]]) as usize;
                    pos += 2;
                    l
                }
                2 => {
                    if pos + 4 > bytes.len() {
                        return Err(EngineError::Other("Truncated old-format 4-byte length".to_string()));
                    }
                    let l = u32::from_be_bytes([
                        bytes[pos],
                        bytes[pos + 1],
                        bytes[pos + 2],
                        bytes[pos + 3],
                    ]) as usize;
                    pos += 4;
                    l
                }
                _ => bytes.len() - pos,
            };
            (tag, len)
        };

        if pos + body_len > bytes.len() {
            return Err(EngineError::Other(
                "Truncated OpenPGP packet body".to_string(),
            ));
        }
        packets.push((tag, bytes[pos..pos + body_len].to_vec()));
        pos += body_len;
    }

    Ok(packets)
}

fn read_mpi(buf: &[u8], pos: &mut usize) -> Result<Vec<u8>> {
    if *pos + 2 > buf.len() {
        return Err(EngineError::Other("Truncated OpenPGP MPI bit-length".to_string()));
    }
    let bit_len = u16::from_be_bytes([buf[*pos], buf[*pos + 1]]) as usize;
    *pos += 2;
    let byte_len = bit_len.div_ceil(8);
    if byte_len == 0 || *pos + byte_len > buf.len() {
        return Err(EngineError::Other("Invalid OpenPGP MPI length".to_string()));
    }
    let out = buf[*pos..*pos + byte_len].to_vec();
    *pos += byte_len;
    Ok(out)
}

pub struct ParsedOpenPgpRsaKey {
    pub rsa: RsaPublicKey,
    pub fingerprint_hex: String,
    pub modulus_bytes: usize,
}

/// Parses an ASCII-armored OpenPGP V4 RSA primary public key and verifies its pinned SHA-1 V4 fingerprint.
pub fn parse_and_pin_openpgp_rsa_pubkey(
    pubkey_asc: &str,
    expected_fingerprint_hex: &str,
) -> Result<ParsedOpenPgpRsaKey> {
    let raw = decode_pgp_armor(pubkey_asc)?;
    let packets = parse_openpgp_packets(&raw)?;
    let (_, body) = packets
        .into_iter()
        .find(|(tag, _)| *tag == 6)
        .ok_or_else(|| EngineError::Other("OpenPGP Public-Key packet (tag 6) missing".to_string()))?;

    if body.len() < 6 || body[0] != 4 {
        return Err(EngineError::Other(
            "Unsupported OpenPGP public key version (expected V4)".to_string(),
        ));
    }

    let algo = body[5];
    if algo != 1 && algo != 3 {
        return Err(EngineError::Other(format!(
            "Unsupported OpenPGP public key algorithm {} (expected RSA)",
            algo
        )));
    }

    // RFC 4880 Section 12.2: V4 fingerprint = SHA-1(0x99 || len_hi || len_lo || pubkey_packet_body)
    let mut fp_hasher = Sha1::new();
    fp_hasher.update([0x99u8]);
    fp_hasher.update((body.len() as u16).to_be_bytes());
    fp_hasher.update(&body);
    let actual_fp = hex::encode_upper(fp_hasher.finalize());

    let expected_norm = expected_fingerprint_hex
        .trim()
        .replace(' ', "")
        .to_ascii_uppercase();
    if actual_fp != expected_norm {
        return Err(EngineError::Other(format!(
            "OpenPGP public key fingerprint mismatch: expected {}, got {}",
            expected_norm, actual_fp
        )));
    }

    let mut pos = 6;
    let n_bytes = read_mpi(&body, &mut pos)?;
    let e_bytes = read_mpi(&body, &mut pos)?;
    let modulus_bytes = n_bytes.len();
    let rsa = RsaPublicKey::new(
        BigUint::from_bytes_be(&n_bytes),
        BigUint::from_bytes_be(&e_bytes),
    )
    .map_err(|e| EngineError::Other(format!("Invalid RSA public key parameters: {}", e)))?;

    Ok(ParsedOpenPgpRsaKey {
        rsa,
        fingerprint_hex: actual_fp,
        modulus_bytes,
    })
}

fn canonicalize_text_crlf(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() + 32);
    let mut i = 0;
    while i < data.len() {
        if data[i] == b'\r' {
            if i + 1 < data.len() && data[i + 1] == b'\n' {
                out.extend_from_slice(b"\r\n");
                i += 2;
            } else {
                out.extend_from_slice(b"\r\n");
                i += 1;
            }
        } else if data[i] == b'\n' {
            out.extend_from_slice(b"\r\n");
            i += 1;
        } else {
            out.push(data[i]);
            i += 1;
        }
    }
    out
}

/// Verifies an RFC 4880 V4 OpenPGP detached RSA signature (binary `.sig` or ASCII-armored)
/// over `message_bytes` against the pinned public key.
pub fn verify_openpgp_detached_rsa_signature(
    pubkey_asc: &str,
    expected_fingerprint_hex: &str,
    message_bytes: &[u8],
    sig_bytes: &[u8],
) -> Result<()> {
    let key = parse_and_pin_openpgp_rsa_pubkey(pubkey_asc, expected_fingerprint_hex)?;

    let raw_sig = if let Ok(s) = std::str::from_utf8(sig_bytes) {
        if s.contains("-----BEGIN PGP SIGNATURE-----") {
            decode_pgp_armor(s)?
        } else {
            sig_bytes.to_vec()
        }
    } else {
        sig_bytes.to_vec()
    };

    let packets = parse_openpgp_packets(&raw_sig)?;
    let (_, body) = packets
        .into_iter()
        .find(|(tag, _)| *tag == 2)
        .ok_or_else(|| {
            EngineError::Other("OpenPGP Signature packet (tag 2) missing".to_string())
        })?;

    if body.len() < 10 || body[0] != 4 {
        return Err(EngineError::Other(
            "Unsupported OpenPGP signature version (expected V4)".to_string(),
        ));
    }

    let sig_type = body[1];
    if sig_type != 0x00 && sig_type != 0x01 {
        return Err(EngineError::Other(format!(
            "Unsupported OpenPGP detached signature type 0x{:02X}",
            sig_type
        )));
    }

    let pub_algo = body[2];
    if pub_algo != 1 && pub_algo != 3 {
        return Err(EngineError::Other(format!(
            "Unsupported OpenPGP signature algorithm {} (expected RSA)",
            pub_algo
        )));
    }

    let hash_algo = body[3];
    let hashed_len = u16::from_be_bytes([body[4], body[5]]) as usize;
    let hashed_end = 6 + hashed_len;
    if hashed_end + 2 > body.len() {
        return Err(EngineError::Other(
            "Truncated OpenPGP hashed subpackets".to_string(),
        ));
    }

    let unhashed_len = u16::from_be_bytes([body[hashed_end], body[hashed_end + 1]]) as usize;
    let left16_pos = hashed_end + 2 + unhashed_len;
    if left16_pos + 2 > body.len() {
        return Err(EngineError::Other(
            "Truncated OpenPGP unhashed subpackets".to_string(),
        ));
    }
    let left16 = [body[left16_pos], body[left16_pos + 1]];

    let mut mpi_pos = left16_pos + 2;
    let sig_mpi = read_mpi(&body, &mut mpi_pos)?;

    // Left-pad RSA signature bytes to exact modulus length
    if sig_mpi.len() > key.modulus_bytes {
        return Err(EngineError::Other(
            "OpenPGP RSA signature MPI exceeds modulus length".to_string(),
        ));
    }
    let mut padded_sig = vec![0u8; key.modulus_bytes];
    let offset = key.modulus_bytes - sig_mpi.len();
    padded_sig[offset..].copy_from_slice(&sig_mpi);

    let msg_owned;
    let data_to_hash: &[u8] = if sig_type == 0x01 {
        msg_owned = canonicalize_text_crlf(message_bytes);
        &msg_owned
    } else {
        message_bytes
    };

    let header_to_hash = &body[0..hashed_end];
    let trailer_len = (hashed_end as u32).to_be_bytes();
    let trailer = [
        0x04u8,
        0xFFu8,
        trailer_len[0],
        trailer_len[1],
        trailer_len[2],
        trailer_len[3],
    ];

    match hash_algo {
        8 => {
            let mut h = Sha256::new();
            h.update(data_to_hash);
            h.update(header_to_hash);
            h.update(trailer);
            let digest = h.finalize();
            if digest[0..2] != left16 {
                return Err(EngineError::Other(
                    "OpenPGP SHA-256 signature digest prefix mismatch".to_string(),
                ));
            }
            key.rsa
                .verify(Pkcs1v15Sign::new::<Sha256>(), &digest, &padded_sig)
                .map_err(|e| {
                    EngineError::Other(format!("OpenPGP RSA/SHA-256 verification failed: {}", e))
                })
        }
        9 => {
            let mut h = Sha384::new();
            h.update(data_to_hash);
            h.update(header_to_hash);
            h.update(trailer);
            let digest = h.finalize();
            if digest[0..2] != left16 {
                return Err(EngineError::Other(
                    "OpenPGP SHA-384 signature digest prefix mismatch".to_string(),
                ));
            }
            key.rsa
                .verify(Pkcs1v15Sign::new::<Sha384>(), &digest, &padded_sig)
                .map_err(|e| {
                    EngineError::Other(format!("OpenPGP RSA/SHA-384 verification failed: {}", e))
                })
        }
        10 => {
            let mut h = Sha512::new();
            h.update(data_to_hash);
            h.update(header_to_hash);
            h.update(trailer);
            let digest = h.finalize();
            if digest[0..2] != left16 {
                return Err(EngineError::Other(
                    "OpenPGP SHA-512 signature digest prefix mismatch".to_string(),
                ));
            }
            key.rsa
                .verify(Pkcs1v15Sign::new::<Sha512>(), &digest, &padded_sig)
                .map_err(|e| {
                    EngineError::Other(format!("OpenPGP RSA/SHA-512 verification failed: {}", e))
                })
        }
        other => Err(EngineError::Other(format!(
            "Unsupported OpenPGP signature hash algorithm {} (require SHA-256/384/512)",
            other
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pinned_ytdlp_openpgp_key_parses_and_matches_fingerprint() {
        let parsed =
            parse_and_pin_openpgp_rsa_pubkey(YTDLP_PGP_PUBKEY_ASC, YTDLP_PGP_FINGERPRINT_HEX)
                .expect("Embedded official yt-dlp OpenPGP key must parse and match pinned fingerprint");
        assert_eq!(parsed.fingerprint_hex, YTDLP_PGP_FINGERPRINT_HEX);
        assert_eq!(parsed.modulus_bytes, 512); // RSA-4096
    }

    #[test]
    fn test_pinned_ytdlp_key_rejects_wrong_fingerprint() {
        let err = parse_and_pin_openpgp_rsa_pubkey(
            YTDLP_PGP_PUBKEY_ASC,
            "0000000000000000000000000000000000000000",
        );
        assert!(err.is_err());
    }

    #[test]
    fn test_trusted_url_policy() {
        assert!(validate_trusted_url("https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest", false).is_ok());
        assert!(validate_trusted_url("https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/yt-dlp.exe", false).is_ok());
        assert!(validate_trusted_url("https://objects.githubusercontent.com/some/asset", false).is_ok());
        assert!(validate_trusted_url("http://github.com/yt-dlp/yt-dlp/releases/download/x/yt-dlp.exe", false).is_err());
        assert!(validate_trusted_url("https://evil.example.com/yt-dlp.exe", false).is_err());
        assert!(validate_trusted_url("http://127.0.0.1:8080/tools.json", false).is_err());
        assert!(validate_trusted_url("http://127.0.0.1:8080/tools.json", true).is_ok());
        assert!(validate_trusted_url("http://192.168.1.5:8080/tools.json", true).is_err());
    }

    #[test]
    fn test_windows_x64_pe_validation() {
        // Minimal valid x86_64 PE header
        let mut pe = vec![0u8; 512];
        pe[0..2].copy_from_slice(b"MZ");
        pe[0x3C..0x40].copy_from_slice(&0x80u32.to_le_bytes());
        pe[0x80..0x84].copy_from_slice(b"PE\0\0");
        pe[0x84..0x86].copy_from_slice(&0x8664u16.to_le_bytes()); // AMD64
        pe[0x98..0x9A].copy_from_slice(&0x020Bu16.to_le_bytes()); // PE32+
        assert!(validate_windows_x64_pe_bytes(&pe).is_ok());

        // ARM64 PE must be rejected
        let mut arm = pe.clone();
        arm[0x84..0x86].copy_from_slice(&0xAA64u16.to_le_bytes());
        assert!(validate_windows_x64_pe_bytes(&arm).is_err());

        // x86 32-bit PE must be rejected
        let mut x86 = pe.clone();
        x86[0x84..0x86].copy_from_slice(&0x014Cu16.to_le_bytes());
        assert!(validate_windows_x64_pe_bytes(&x86).is_err());

        // Script / non-PE must be rejected
        assert!(validate_windows_x64_pe_bytes(b"#!/bin/sh\necho pwned\n").is_err());
    }
}
