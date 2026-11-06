use std::env;
use std::path::PathBuf;
use std::time::Duration;
use tdm_core::{Database, DownloadEvent, DownloadManager, EventBus};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();

    let args: Vec<String> = env::args().collect();
    if args.len() < 2 || args[1] == "--help" || args[1] == "-h" {
        println!("TORI Download Manager CLI v{}", env!("CARGO_PKG_VERSION"));
        println!("Usage: tdm-cli <url> [output_dir]");
        return Ok(());
    }

    let url = &args[1];
    let dest_dir = if args.len() >= 3 {
        PathBuf::from(&args[2])
    } else {
        env::current_dir()?
    };

    let db_path = dest_dir.join("tdm_metadata.sqlite");
    let db = Database::open(&db_path)?;
    let event_bus = EventBus::default();

    let mut event_rx = event_bus.subscribe();
    let manager = DownloadManager::new(db, event_bus)?;

    println!("Creating download for: {}", url);
    let job = manager.create_download(url, &dest_dir).await?;
    println!("Job created: ID = {}", job.id);
    println!("Target path: {}", job.target_path);
    println!("Resumable (Range): {}", job.is_resumable);
    println!("Total size: {:?}", job.total_bytes);
    println!("Chunks: {}", job.chunk_count);

    manager.start_download(&job.id)?;

    let target_id = job.id.clone();
    let monitor = tokio::spawn(async move {
        while let Ok(event) = event_rx.recv().await {
            match event {
                DownloadEvent::Progress(p) => {
                    if p.id == target_id {
                        let total_str = p
                            .total_bytes
                            .map(|t| format!("{:.2} MB", t as f64 / 1_048_576.0))
                            .unwrap_or_else(|| "unknown".to_string());
                        let dl_str = format!("{:.2} MB", p.downloaded_bytes as f64 / 1_048_576.0);
                        let speed_str = format!("{:.2} KB/s", p.speed_bps as f64 / 1024.0);
                        let eta_str = p
                            .eta_seconds
                            .map(|e| format!("{}s", e))
                            .unwrap_or_else(|| "--".to_string());
                        print!(
                            "\r[{}] Progress: {} / {} | Speed: {} | ETA: {}",
                            p.state.as_str(),
                            dl_str,
                            total_str,
                            speed_str,
                            eta_str
                        );
                    }
                }
                DownloadEvent::StateChanged { id, state, error } => {
                    if id == target_id {
                        println!("\nState changed: {:?} (error: {:?})", state, error);
                        if state.is_terminal() {
                            break;
                        }
                    }
                }
                DownloadEvent::ShowWindow => {}
                DownloadEvent::OpenProgressWindow { .. } => {}
            }
        }
    });

    monitor.await?;
    tokio::time::sleep(Duration::from_millis(500)).await;
    println!("\nDone!");

    Ok(())
}
