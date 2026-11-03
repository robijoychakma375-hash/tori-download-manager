use crate::types::JobState;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum EngineError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("HTTP client error: {0}")]
    Http(#[from] reqwest::Error),

    #[error("Database error: {0}")]
    Database(#[from] rusqlite::Error),

    #[error("Invalid URL: {0}")]
    InvalidUrl(String),

    #[error("Invalid Range header: {0}")]
    InvalidRangeHeader(String),

    #[error("Server does not support byte ranges (HTTP {0})")]
    RangeNotSupported(u16),

    #[error(
        "Resource representation changed (ETag mismatch: expected {expected:?}, got {actual:?})"
    )]
    ETagMismatch {
        expected: Option<String>,
        actual: Option<String>,
    },

    #[error("Content length mismatch: expected {expected}, actual {actual}")]
    ContentLengthMismatch { expected: u64, actual: u64 },

    #[error("Mismatched Content-Range: expected offset {expected_start}, server responded with {actual_range}")]
    MismatchedContentRange {
        expected_start: u64,
        actual_range: String,
    },

    #[error("Disk write error: {0}")]
    DiskWrite(String),

    #[error("Task was cancelled or paused")]
    Cancelled,

    #[error("Download job not found: {0}")]
    JobNotFound(String),

    #[error("Invalid state transition from {from:?} to {to:?}")]
    InvalidStateTransition { from: JobState, to: JobState },

    #[error("File integrity check failed: expected hash {expected}, got {actual}")]
    IntegrityCheckFailed { expected: String, actual: String },

    #[error("Temporary file missing: {0}")]
    TempFileMissing(String),

    #[error("Server returned error status: {0}")]
    HttpStatus(u16),

    #[error("Unknown engine error: {0}")]
    Other(String),
}

pub type Result<T> = std::result::Result<T, EngineError>;
