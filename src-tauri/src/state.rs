use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tdm_core::tools::ExternalToolsManager;
use tdm_core::DownloadManager;
use tdm_native_host::server::ServerTokenHandle;
use tokio::sync::RwLock;

pub struct AppState {
    pub manager: Arc<DownloadManager>,
    pub tools_manager: Arc<ExternalToolsManager>,
    pub is_minimized_launch: Arc<AtomicBool>,
    pub server_token_handle: Arc<RwLock<Option<ServerTokenHandle>>>,
}
