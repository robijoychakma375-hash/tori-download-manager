use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tdm_core::DownloadManager;

pub struct AppState {
    pub manager: Arc<DownloadManager>,
    pub is_minimized_launch: Arc<AtomicBool>,
}
