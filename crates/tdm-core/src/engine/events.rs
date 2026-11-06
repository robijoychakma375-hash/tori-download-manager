use crate::types::{DownloadProgress, JobState};
use tokio::sync::broadcast;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", content = "payload")]
pub enum DownloadEvent {
    Progress(DownloadProgress),
    StateChanged {
        id: String,
        state: JobState,
        error: Option<String>,
    },
    ShowWindow,
    HideWindow,
    OpenProgressWindow {
        id: String,
    },
}

#[derive(Clone)]
pub struct EventBus {
    sender: broadcast::Sender<DownloadEvent>,
}

impl EventBus {
    pub fn new(capacity: usize) -> Self {
        let (sender, _) = broadcast::channel(capacity);
        Self { sender }
    }

    pub fn emit(&self, event: DownloadEvent) {
        let _ = self.sender.send(event);
    }

    pub fn subscribe(&self) -> broadcast::Receiver<DownloadEvent> {
        self.sender.subscribe()
    }
}

impl Default for EventBus {
    fn default() -> Self {
        Self::new(256)
    }
}
