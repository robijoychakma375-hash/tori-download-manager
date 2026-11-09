use serde::{Deserialize, Serialize};
use std::io::{self, Read, Write};

pub const MAX_MESSAGE_SIZE: usize = 1024 * 1024; // 1 MB limit per Chrome spec

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct NativeMessage {
    pub action: String,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub filename: Option<String>,
    #[serde(default)]
    pub destination: Option<String>,
    #[serde(default)]
    pub priority: Option<String>,
    #[serde(default)]
    pub job_id: Option<String>,
    #[serde(default)]
    pub referer: Option<String>,
    #[serde(default)]
    pub user_agent: Option<String>,
    #[serde(default)]
    pub scheduled_at: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct NativeResponse {
    pub status: String,
    pub action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub job_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub jobs: Option<Vec<serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supported: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unsupported: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
}

/// Reads a length-prefixed JSON message from the given reader (typically stdin)
pub fn read_message<R: Read>(reader: &mut R) -> io::Result<Option<NativeMessage>> {
    let mut len_bytes = [0u8; 4];
    match reader.read_exact(&mut len_bytes) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }

    let length = u32::from_le_bytes(len_bytes) as usize;
    if length == 0 {
        return Ok(None);
    }
    if length > MAX_MESSAGE_SIZE {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("Message length {} exceeds max 1 MB", length),
        ));
    }

    let mut buf = vec![0u8; length];
    reader.read_exact(&mut buf)?;

    let msg: NativeMessage = serde_json::from_slice(&buf).map_err(|e| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("Failed to parse JSON message: {}", e),
        )
    })?;

    Ok(Some(msg))
}

/// Writes a length-prefixed JSON message to the given writer (typically stdout)
pub fn write_message<W: Write>(writer: &mut W, response: &NativeResponse) -> io::Result<()> {
    let json_bytes = serde_json::to_vec(response).map_err(|e| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("Failed to serialize response: {}", e),
        )
    })?;

    let length = json_bytes.len() as u32;
    writer.write_all(&length.to_le_bytes())?;
    writer.write_all(&json_bytes)?;
    writer.flush()?;
    Ok(())
}

/// Async helper to read a length-prefixed NativeResponse from an async stream (e.g. process stdout)
pub async fn read_response_async<R: tokio::io::AsyncReadExt + Unpin>(
    reader: &mut R,
) -> io::Result<Option<NativeResponse>> {
    let mut len_bytes = [0u8; 4];
    match reader.read_exact(&mut len_bytes).await {
        Ok(_) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }

    let length = u32::from_le_bytes(len_bytes) as usize;
    if length == 0 || length > MAX_MESSAGE_SIZE {
        return Ok(None);
    }

    let mut buf = vec![0u8; length];
    reader.read_exact(&mut buf).await?;

    let resp: NativeResponse = serde_json::from_slice(&buf).map_err(|e| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("Failed to parse response JSON: {}", e),
        )
    })?;

    Ok(Some(resp))
}

/// Async helper to write a length-prefixed NativeMessage to an async sink (e.g. process stdin)
pub async fn write_message_async<W: tokio::io::AsyncWriteExt + Unpin>(
    writer: &mut W,
    msg: &NativeMessage,
) -> io::Result<()> {
    let json_bytes = serde_json::to_vec(msg).map_err(|e| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("Failed to serialize message: {}", e),
        )
    })?;

    let length = json_bytes.len() as u32;
    writer.write_all(&length.to_le_bytes()).await?;
    writer.write_all(&json_bytes).await?;
    writer.flush().await?;
    Ok(())
}

/// Async helper to read a length-prefixed NativeMessage from an async stream (e.g. IPC connection)
pub async fn read_message_async<R: tokio::io::AsyncReadExt + Unpin>(
    reader: &mut R,
) -> io::Result<Option<NativeMessage>> {
    let mut len_bytes = [0u8; 4];
    match reader.read_exact(&mut len_bytes).await {
        Ok(_) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }

    let length = u32::from_le_bytes(len_bytes) as usize;
    if length == 0 || length > MAX_MESSAGE_SIZE {
        return Ok(None);
    }

    let mut buf = vec![0u8; length];
    reader.read_exact(&mut buf).await?;

    let msg: NativeMessage = serde_json::from_slice(&buf).map_err(|e| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("Failed to parse message JSON: {}", e),
        )
    })?;

    Ok(Some(msg))
}

/// Async helper to write a length-prefixed NativeResponse to an async sink (e.g. IPC connection)
pub async fn write_response_async<W: tokio::io::AsyncWriteExt + Unpin>(
    writer: &mut W,
    response: &NativeResponse,
) -> io::Result<()> {
    let json_bytes = serde_json::to_vec(response).map_err(|e| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("Failed to serialize response: {}", e),
        )
    })?;

    let length = json_bytes.len() as u32;
    writer.write_all(&length.to_le_bytes()).await?;
    writer.write_all(&json_bytes).await?;
    writer.flush().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn test_framing_roundtrip() {
        let resp = NativeResponse {
            status: "ok".to_string(),
            action: "pong".to_string(),
            version: Some("2.0.0".to_string()),
            ..Default::default()
        };

        let mut buf = Vec::new();
        write_message(&mut buf, &resp).unwrap();

        assert!(buf.len() > 4);
        let len = u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
        assert_eq!(len, buf.len() - 4);

        let mut cursor = Cursor::new(buf);
        let parsed = read_message(&mut cursor)
            .unwrap()
            .expect("Expected message");
        assert_eq!(parsed.action, "pong");
    }
}
