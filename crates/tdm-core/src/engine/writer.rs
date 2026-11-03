use std::fs::{File, OpenOptions};
use std::path::Path;
use std::sync::Arc;

use crate::error::{EngineError, Result};

#[derive(Clone)]
pub struct PartFileWriter {
    file: Arc<File>,
}

impl PartFileWriter {
    pub fn open_or_create<P: AsRef<Path>>(path: P, total_bytes: Option<u64>) -> Result<Self> {
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)
            .map_err(EngineError::Io)?;

        if let Some(total) = total_bytes {
            let current_len = file.metadata()?.len();
            if current_len < total {
                // Pre-allocate or set length
                if let Err(e) = file.set_len(total) {
                    tracing::warn!("Could not preallocate file length {}: {}", total, e);
                }
            }
        }

        Ok(Self {
            file: Arc::new(file),
        })
    }

    pub fn write_at(&self, offset: u64, buf: &[u8]) -> Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }

        #[cfg(windows)]
        {
            use std::os::windows::fs::FileExt;
            let mut written = 0;
            while written < buf.len() {
                let n = self
                    .file
                    .seek_write(&buf[written..], offset + written as u64)
                    .map_err(|e| EngineError::DiskWrite(e.to_string()))?;
                if n == 0 {
                    return Err(EngineError::DiskWrite("Write returned 0 bytes".to_string()));
                }
                written += n;
            }
            Ok(written)
        }

        #[cfg(not(windows))]
        {
            use std::os::unix::fs::FileExt;
            self.file
                .write_all_at(buf, offset)
                .map_err(|e| EngineError::DiskWrite(e.to_string()))?;
            Ok(buf.len())
        }
    }

    pub fn sync(&self) -> Result<()> {
        self.file.sync_data().map_err(EngineError::Io)
    }

    pub fn truncate_to(&self, length: u64) -> Result<()> {
        self.file.set_len(length).map_err(EngineError::Io)
    }
}
