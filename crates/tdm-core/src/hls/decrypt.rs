use aes::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
use aes::Aes128;
use cbc::Decryptor;

use crate::error::{EngineError, Result};

type Aes128CbcDec = Decryptor<Aes128>;

/// Decrypts an AES-128-CBC encrypted HLS segment with PKCS#7 unpadding.
pub fn decrypt_hls_segment(ciphertext: &[u8], key: &[u8; 16], iv: &[u8; 16]) -> Result<Vec<u8>> {
    if ciphertext.is_empty() {
        return Ok(Vec::new());
    }

    if !ciphertext.len().is_multiple_of(16) {
        return Err(EngineError::Other(format!(
            "Invalid ciphertext: length {} is not a multiple of 16 bytes",
            ciphertext.len()
        )));
    }

    let mut buffer = ciphertext.to_vec();
    let decryptor = Aes128CbcDec::new(key.into(), iv.into());

    let decrypted = decryptor
        .decrypt_padded_mut::<Pkcs7>(&mut buffer)
        .map_err(|e| EngineError::Other(format!("HLS AES-128 decryption error: {:?}", e)))?;

    Ok(decrypted.to_vec())
}

/// Derives the 128-bit IV from the media sequence number per RFC 8216 Section 5.2.
/// "If the EXT-X-KEY tag has the IV attribute, the value is the IV. If the EXT-X-KEY tag does not
/// have the IV attribute, the sequence number of the Media Segment MUST be used as the IV when
/// encrypting or decrypting that Media Segment, put into a 16-octet buffer in big-endian order
/// with the highest bits padded with zeros."
pub fn derive_iv_from_sequence(sequence_number: u64) -> [u8; 16] {
    let mut iv = [0u8; 16];
    iv[8..16].copy_from_slice(&sequence_number.to_be_bytes());
    iv
}

#[cfg(test)]
mod tests {
    use super::*;
    use aes::cipher::BlockEncryptMut;
    use cbc::Encryptor;

    type Aes128CbcEnc = Encryptor<Aes128>;

    #[test]
    fn test_aes128_roundtrip_decryption() {
        let key: [u8; 16] = [
            0x2b, 0x7e, 0x15, 0x16, 0x28, 0xae, 0xd2, 0xa6, 0xab, 0xf7, 0x15, 0x88, 0x09, 0xcf,
            0x4f, 0x3c,
        ];
        let iv: [u8; 16] = [
            0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d,
            0x0e, 0x0f,
        ];

        let plaintext = b"Hello, TORI HLS VOD AES-128 decrypted segment!";

        // Encrypt with PKCS#7
        let mut enc_buf = vec![0u8; plaintext.len() + 32];
        enc_buf[..plaintext.len()].copy_from_slice(plaintext);
        let encryptor = Aes128CbcEnc::new(&key.into(), &iv.into());
        let ciphertext = encryptor
            .encrypt_padded_mut::<Pkcs7>(&mut enc_buf, plaintext.len())
            .unwrap();

        // Decrypt
        let decrypted = decrypt_hls_segment(ciphertext, &key, &iv).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn test_derive_iv_from_sequence() {
        let iv = derive_iv_from_sequence(42);
        assert_eq!(iv[0..8], [0u8; 8]);
        assert_eq!(&iv[8..16], &42u64.to_be_bytes());
    }
}
