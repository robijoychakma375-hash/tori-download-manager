use tdm_core::{Database, DownloadManager, EventBus};
use tempfile::tempdir;

#[tokio::test]
async fn test_classify_category_matrix() {
    assert_eq!(
        DownloadManager::classify_category("installer.exe"),
        "Programs"
    );
    assert_eq!(
        DownloadManager::classify_category("package.msi"),
        "Programs"
    );
    assert_eq!(DownloadManager::classify_category("bundle.dmg"), "Programs");
    assert_eq!(
        DownloadManager::classify_category("archive.zip"),
        "Compressed"
    );
    assert_eq!(DownloadManager::classify_category("disc.iso"), "Compressed");
    assert_eq!(
        DownloadManager::classify_category("compressed.tar.gz"),
        "Compressed"
    );
    assert_eq!(DownloadManager::classify_category("movie.mp4"), "Video");
    assert_eq!(DownloadManager::classify_category("clip.mkv"), "Video");
    assert_eq!(DownloadManager::classify_category("stream.webm"), "Video");
    assert_eq!(DownloadManager::classify_category("song.mp3"), "Music");
    assert_eq!(DownloadManager::classify_category("album.flac"), "Music");
    assert_eq!(
        DownloadManager::classify_category("manual.pdf"),
        "Documents"
    );
    assert_eq!(
        DownloadManager::classify_category("notes.docx"),
        "Documents"
    );
    assert_eq!(DownloadManager::classify_category("unknown.dat"), "Other");
    assert_eq!(DownloadManager::classify_category("no_extension"), "Other");
    // URL with query parameters
    assert_eq!(
        DownloadManager::classify_category("https://example.com/dl/file.exe?token=123"),
        "Programs"
    );
    assert_eq!(
        DownloadManager::classify_category("https://example.com/watch/video.mp4#t=10"),
        "Video"
    );
}

#[tokio::test]
async fn test_resolve_destination_folder_behavior() {
    let tmp = tempdir().unwrap();
    let db_path = tmp.path().join("test_gate12_7.sqlite");
    let db = Database::open(&db_path).unwrap();
    let event_bus = EventBus::default();
    let manager = DownloadManager::new(db, event_bus).unwrap();

    let base_dir = tmp.path().join("MyDownloads");
    manager.set_default_download_dir(Some(base_dir.to_str().unwrap().to_string()));

    // 1. Category routing enabled (default is true)
    manager.set_use_category_by_default(true);
    let resolved_video = manager.resolve_destination_folder("video.mp4", None);
    assert_eq!(resolved_video, base_dir.join("Video"));
    assert!(resolved_video.exists());

    let resolved_prog = manager.resolve_destination_folder("setup.exe", None);
    assert_eq!(resolved_prog, base_dir.join("Programs"));
    assert!(resolved_prog.exists());

    let resolved_other = manager.resolve_destination_folder("data.bin", None);
    assert_eq!(resolved_other, base_dir.join("Other"));
    assert!(resolved_other.exists());

    // 2. Prevent duplicate category folder if base already ends with category
    let video_base = tmp.path().join("MyDownloads").join("Video");
    manager.set_default_download_dir(Some(video_base.to_str().unwrap().to_string()));
    let resolved_no_dup = manager.resolve_destination_folder("clip.mp4", None);
    assert_eq!(resolved_no_dup, video_base);

    // 3. Category routing disabled (sort = false)
    manager.set_default_download_dir(Some(base_dir.to_str().unwrap().to_string()));
    manager.set_use_category_by_default(false);
    let resolved_flat = manager.resolve_destination_folder("video.mp4", None);
    assert_eq!(resolved_flat, base_dir);

    // 4. Explicit destination override
    let custom_dir = tmp.path().join("CustomProject");
    let resolved_explicit =
        manager.resolve_destination_folder("video.mp4", Some(custom_dir.to_str().unwrap()));
    assert_eq!(resolved_explicit, custom_dir);
    assert!(resolved_explicit.exists());
}
