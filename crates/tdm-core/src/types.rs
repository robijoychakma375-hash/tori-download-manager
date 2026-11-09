use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JobState {
    Created,
    Probing,
    Queued,
    Downloading,
    Pausing,
    Paused,
    Verifying,
    Completed,
    Failed,
    Cancelled,
    Scheduled,
}

impl JobState {
    pub fn as_str(&self) -> &'static str {
        match self {
            JobState::Created => "created",
            JobState::Probing => "probing",
            JobState::Queued => "queued",
            JobState::Downloading => "downloading",
            JobState::Pausing => "pausing",
            JobState::Paused => "paused",
            JobState::Verifying => "verifying",
            JobState::Completed => "completed",
            JobState::Failed => "failed",
            JobState::Cancelled => "cancelled",
            JobState::Scheduled => "scheduled",
        }
    }

    pub fn parse_state(s: &str) -> Option<Self> {
        s.parse().ok()
    }

    pub fn is_active(&self) -> bool {
        matches!(
            self,
            JobState::Probing | JobState::Queued | JobState::Downloading | JobState::Verifying
        )
    }

    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            JobState::Completed | JobState::Failed | JobState::Cancelled
        )
    }
}

impl std::str::FromStr for JobState {
    type Err = ();

    fn from_str(s: &str) -> std::result::Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "created" => Ok(JobState::Created),
            "probing" => Ok(JobState::Probing),
            "queued" => Ok(JobState::Queued),
            "downloading" => Ok(JobState::Downloading),
            "pausing" => Ok(JobState::Pausing),
            "paused" => Ok(JobState::Paused),
            "verifying" => Ok(JobState::Verifying),
            "completed" => Ok(JobState::Completed),
            "failed" => Ok(JobState::Failed),
            "cancelled" => Ok(JobState::Cancelled),
            "scheduled" => Ok(JobState::Scheduled),
            _ => Err(()),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JobType {
    HttpFile,
    HlsVod,
    DashVod,
    Torrent,
    LiveStream,
    ManagedMedia,
}

impl JobType {
    pub fn as_str(&self) -> &'static str {
        match self {
            JobType::HttpFile => "http_file",
            JobType::HlsVod => "hls_vod",
            JobType::DashVod => "dash_vod",
            JobType::Torrent => "torrent",
            JobType::LiveStream => "live_stream",
            JobType::ManagedMedia => "managed_media",
        }
    }

    pub fn parse_type(s: &str) -> Option<Self> {
        s.parse().ok()
    }
}

impl std::str::FromStr for JobType {
    type Err = ();

    fn from_str(s: &str) -> std::result::Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "http_file" => Ok(JobType::HttpFile),
            "hls_vod" => Ok(JobType::HlsVod),
            "dash_vod" => Ok(JobType::DashVod),
            "torrent" => Ok(JobType::Torrent),
            "live_stream" | "live" => Ok(JobType::LiveStream),
            "managed_media" | "media" => Ok(JobType::ManagedMedia),
            _ => Err(()),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Priority {
    Low = 1,
    #[default]
    Normal = 2,
    High = 3,
}

impl Priority {
    pub fn as_str(&self) -> &'static str {
        match self {
            Priority::Low => "low",
            Priority::Normal => "normal",
            Priority::High => "high",
        }
    }
}

impl std::str::FromStr for Priority {
    type Err = ();

    fn from_str(s: &str) -> std::result::Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "high" => Ok(Priority::High),
            "low" => Ok(Priority::Low),
            _ => Ok(Priority::Normal),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadJob {
    pub id: String,
    pub url: String,
    pub resolved_url: Option<String>,
    pub filename: String,
    pub target_path: String,
    pub temp_path: String,
    pub total_bytes: Option<u64>,
    pub downloaded_bytes: u64,
    pub state: JobState,
    pub job_type: JobType,
    pub priority: Priority,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub is_resumable: bool,
    pub chunk_count: usize,
    pub error_message: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    #[serde(default)]
    pub thumbnail_url: Option<String>,
    #[serde(default)]
    pub referer: Option<String>,
    #[serde(default)]
    pub user_agent: Option<String>,
    #[serde(default)]
    pub scheduled_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChunkRecord {
    pub id: Option<i64>,
    pub download_id: String,
    pub chunk_index: usize,
    pub start_byte: u64,
    pub end_byte: u64,
    pub written_bytes: u64,
    pub is_complete: bool,
}

impl ChunkRecord {
    pub fn remaining_bytes(&self) -> u64 {
        let total = self.end_byte.saturating_sub(self.start_byte) + 1;
        total.saturating_sub(self.written_bytes)
    }

    pub fn current_offset(&self) -> u64 {
        self.start_byte + self.written_bytes
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadProgress {
    pub id: String,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub speed_bps: u64,
    pub eta_seconds: Option<u64>,
    pub state: JobState,
    pub error_message: Option<String>,
}
