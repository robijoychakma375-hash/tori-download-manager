use std::num::NonZeroU32;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use librqbit::limits::LimitsConfig;
use librqbit::{DhtSessionConfig, Session, SessionOptions};

use crate::error::{EngineError, Result};

#[derive(Debug, Clone)]
pub struct TorrentSessionConfig {
    pub peer_limit: Option<usize>,
    pub max_download_bps: Option<u32>,
    pub max_upload_bps: Option<u32>,
    pub dht_enabled: bool,
    pub persistence_dir: Option<PathBuf>,
}

impl Default for TorrentSessionConfig {
    fn default() -> Self {
        Self {
            peer_limit: Some(50),
            max_download_bps: None,
            max_upload_bps: None,
            dht_enabled: true,
            persistence_dir: None,
        }
    }
}

pub struct TorrentSessionManager {
    session: Arc<Session>,
    default_dir: PathBuf,
}

impl TorrentSessionManager {
    pub async fn new<P: AsRef<Path>>(default_dir: P, config: TorrentSessionConfig) -> Result<Self> {
        let dir = default_dir.as_ref().to_path_buf();
        if !dir.exists() {
            std::fs::create_dir_all(&dir)?;
        }

        let ratelimits = LimitsConfig {
            download_bps: config.max_download_bps.and_then(NonZeroU32::new),
            upload_bps: config.max_upload_bps.and_then(NonZeroU32::new),
        };

        let dht = if config.dht_enabled {
            Some(DhtSessionConfig {
                port: Some(0),
                bootstrap_addrs: Some(vec![
                    "router.bittorrent.com:6881".to_string(),
                    "dht.transmissionbt.com:6881".to_string(),
                    "router.utorrent.com:6881".to_string(),
                    "dht.aelitis.com:6881".to_string(),
                ]),
                ..Default::default()
            })
        } else {
            None
        };

        let opts = SessionOptions {
            peer_limit: config.peer_limit,
            ratelimits,
            dht,
            disable_trackers: false,
            fastresume: false,
            persistence: None,
            ..Default::default()
        };

        let session = Session::new_with_opts(dir.clone(), opts)
            .await
            .map_err(|e| {
                EngineError::Other(format!("Failed to initialize librqbit session: {}", e))
            })?;

        Ok(Self {
            session,
            default_dir: dir,
        })
    }

    pub fn session(&self) -> &Arc<Session> {
        &self.session
    }

    pub fn default_dir(&self) -> &Path {
        &self.default_dir
    }
}
