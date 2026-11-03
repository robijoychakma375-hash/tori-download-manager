use std::sync::Arc;
use tdm_core::DownloadManager;

pub struct AppState {
    pub manager: Arc<DownloadManager>,
}
