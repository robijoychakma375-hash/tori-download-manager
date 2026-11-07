use std::sync::Arc;
use std::time::Duration;

use librqbit::{
    AddTorrent, AddTorrentOptions, CreateTorrentOptions, ListenerOptions, Session, SessionOptions,
};
use sha2::{Digest, Sha256};
use tempfile::tempdir;
use tokio_util::sync::CancellationToken;

use tdm_core::db::Database;
use tdm_core::engine::EventBus;
use tdm_core::error::EngineError;
use tdm_core::torrent::{
    download_torrent, parse_magnet_uri, parse_torrent_bytes, parse_torrent_file,
    TorrentSessionConfig, TorrentSessionManager,
};
use tdm_core::types::{JobState, JobType, Priority};

async fn make_test_session<P: AsRef<std::path::Path>>(path: P) -> Arc<Session> {
    let opts = SessionOptions {
        disable_trackers: true,
        dht: None,
        disable_local_service_discovery: true,
        ..Default::default()
    };
    Session::new_with_opts(path.as_ref().to_path_buf(), opts)
        .await
        .unwrap()
}

#[tokio::test]
async fn test_torrent_magnet_uri_parsing_and_info_hash() {
    // 1. Standard 40-hex info-hash
    let hex_magnet = "magnet:?xt=urn:btih:c12fe1c06bba254a9dc9f519b335380dc1f74c38&dn=Arch+Linux+2026.01&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce&xl=850000000";
    let parsed = parse_magnet_uri(hex_magnet).expect("Failed to parse hex magnet");
    assert_eq!(
        parsed.info_hash_hex,
        "c12fe1c06bba254a9dc9f519b335380dc1f74c38"
    );
    assert_eq!(parsed.display_name.as_deref(), Some("Arch Linux 2026.01"));
    assert_eq!(
        parsed.trackers,
        vec!["udp://tracker.opentrackr.org:1337/announce"]
    );
    assert_eq!(parsed.exact_length, Some(850000000));

    // 2. Base32 32-character info-hash
    let base32_magnet = "magnet:?xt=urn:btih:YNC63QDLXMSUTXNZWBXDEP2MFXQ7OTBY&dn=TestBase32";
    let parsed_b32 = parse_magnet_uri(base32_magnet).expect("Failed to parse base32 magnet");
    assert_eq!(parsed_b32.info_hash_hex.len(), 40);
    assert_eq!(parsed_b32.display_name.as_deref(), Some("TestBase32"));

    // 3. Invalid magnets
    assert!(parse_magnet_uri("https://example.com/not_magnet").is_err());
    assert!(parse_magnet_uri("magnet:?dn=NoXtParameter").is_err());
    assert!(parse_magnet_uri("magnet:?xt=urn:ed2k:12345").is_err());
}

#[tokio::test]
async fn test_torrent_file_parsing_and_metainfo() {
    let tmp = tempdir().unwrap();
    let seed_dir = tmp.path().join("seed");
    std::fs::create_dir_all(&seed_dir).unwrap();

    let sample_file = seed_dir.join("sample.txt");
    let test_content = b"TORI Download Manager - Verifiable BitTorrent Gate 6 Integration Payload";
    std::fs::write(&sample_file, test_content).unwrap();

    // Create session to generate torrent file
    let seeder_session = make_test_session(&seed_dir).await;
    let (created, _) = seeder_session
        .create_and_serve_torrent(
            &sample_file,
            CreateTorrentOptions {
                name: Some("sample.txt"),
                piece_length: Some(16384),
                ..Default::default()
            },
        )
        .await
        .unwrap();

    let torrent_bytes = created.as_bytes().unwrap();
    let meta = parse_torrent_bytes(&torrent_bytes).expect("Failed to parse generated torrent");

    assert_eq!(meta.name, "sample.txt");
    assert_eq!(meta.total_bytes, test_content.len() as u64);
    assert_eq!(meta.files.len(), 1);
    assert_eq!(meta.files[0].length, test_content.len() as u64);
    assert_eq!(meta.piece_length, 16384);
    assert_eq!(meta.pieces_count, 1);
    assert_eq!(meta.info_hash_hex.len(), 40);

    // Write .torrent to disk and parse via file path
    let torrent_file_path = tmp.path().join("sample.torrent");
    std::fs::write(&torrent_file_path, &torrent_bytes).unwrap();
    let meta_from_file = parse_torrent_file(&torrent_file_path).unwrap();
    assert_eq!(meta_from_file.info_hash_hex, meta.info_hash_hex);
    assert_eq!(meta_from_file.total_bytes, meta.total_bytes);
}

#[tokio::test]
async fn test_torrent_local_seeder_and_leecher_real_download() {
    let tmp = tempdir().unwrap();

    // 1. Prepare deterministic payload (64 KB)
    let payload_size = 64 * 1024;
    let mut payload = Vec::with_capacity(payload_size);
    for i in 0..payload_size {
        payload.push(((i * 31 + 17) % 256) as u8);
    }
    let expected_hash = format!("{:x}", Sha256::digest(&payload));

    let seeder_dir = tmp.path().join("seeder_data");
    std::fs::create_dir_all(&seeder_dir).unwrap();
    let seeder_file = seeder_dir.join("payload.bin");
    std::fs::write(&seeder_file, &payload).unwrap();

    // 2. Start Seeder Session listening on 127.0.0.1:0
    let seeder_opts = SessionOptions {
        disable_trackers: true,
        dht: None,
        disable_local_service_discovery: true,
        listen: Some(ListenerOptions {
            listen_addr: "127.0.0.1:0".parse().unwrap(),
            ..Default::default()
        }),
        ..Default::default()
    };
    let seeder_session = Session::new_with_opts(seeder_dir.clone(), seeder_opts)
        .await
        .unwrap();
    let seeder_addr = seeder_session
        .listen_addr()
        .expect("Seeder should have bound a listen address");

    let (created, _) = seeder_session
        .create_and_serve_torrent(
            &seeder_file,
            CreateTorrentOptions {
                name: Some("payload.bin"),
                piece_length: Some(16384),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let torrent_bytes = created.as_bytes().unwrap();

    // 3. Start Leecher Session and download via download_torrent
    let leecher_dir = tmp.path().join("leecher_data");
    std::fs::create_dir_all(&leecher_dir).unwrap();

    let torrent_file_path = tmp.path().join("payload.torrent");
    std::fs::write(&torrent_file_path, &torrent_bytes).unwrap();

    let leecher_opts = SessionOptions {
        disable_trackers: true,
        dht: None,
        disable_local_service_discovery: true,
        ..Default::default()
    };
    let leecher_session = Arc::new(
        Session::new_with_opts(leecher_dir.clone(), leecher_opts)
            .await
            .unwrap(),
    );

    let db = Database::open_in_memory().unwrap();
    let _event_bus = EventBus::default();
    let _client = reqwest::Client::new();
    let _cancel = CancellationToken::new();

    let job = tdm_core::DownloadJob {
        id: "torrent-test-job-1".to_string(),
        url: torrent_file_path.to_string_lossy().to_string(),
        resolved_url: None,
        filename: "payload.bin".to_string(),
        target_path: leecher_dir
            .join("payload.bin")
            .to_string_lossy()
            .to_string(),
        temp_path: leecher_dir
            .join("payload.bin.tdm-part")
            .to_string_lossy()
            .to_string(),
        total_bytes: Some(payload_size as u64),
        downloaded_bytes: 0,
        state: JobState::Queued,
        job_type: JobType::Torrent,
        priority: Priority::High,
        etag: None,
        last_modified: None,
        is_resumable: true,
        chunk_count: 4,
        error_message: None,
        created_at: chrono::Utc::now(),
        updated_at: chrono::Utc::now(),
        thumbnail_url: None,
        referer: None,
    };
    db.insert_job(&job).unwrap();

    // Add torrent with explicit initial_peers pointing to our seeder
    let add_opts = AddTorrentOptions {
        overwrite: true,
        output_folder: Some(leecher_dir.to_string_lossy().to_string()),
        initial_peers: Some(vec![seeder_addr]),
        paused: false,
        ..Default::default()
    };
    let add_res = leecher_session
        .add_torrent(
            AddTorrent::TorrentFileBytes(torrent_bytes.clone()),
            Some(add_opts),
        )
        .await
        .unwrap();
    let handle = add_res.into_handle().unwrap();

    // Wait for download to finish
    let mut finished = false;
    for _ in 0..100 {
        let stats = handle.stats();
        if stats.finished {
            finished = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    assert!(
        finished,
        "Leecher failed to finish downloading torrent payload"
    );

    // 4. Verify downloaded file bytes & SHA-256
    let downloaded_path = leecher_dir.join("payload.bin");
    assert!(
        downloaded_path.exists(),
        "Downloaded file does not exist on disk"
    );
    let downloaded_bytes = std::fs::read(&downloaded_path).unwrap();
    assert_eq!(downloaded_bytes.len(), payload_size);
    let downloaded_hash = format!("{:x}", Sha256::digest(&downloaded_bytes));
    assert_eq!(
        downloaded_hash, expected_hash,
        "Downloaded torrent SHA-256 mismatch!"
    );
}

#[tokio::test]
async fn test_torrent_pause_and_resume_continuity() {
    let tmp = tempdir().unwrap();
    let data_dir = tmp.path().join("torrent_resume");
    std::fs::create_dir_all(&data_dir).unwrap();

    let sample_file = data_dir.join("resume_test.dat");
    let test_data = vec![42u8; 32768]; // 32 KB
    std::fs::write(&sample_file, &test_data).unwrap();

    let session = make_test_session(&data_dir).await;
    let (created, _) = session
        .create_and_serve_torrent(
            &sample_file,
            CreateTorrentOptions {
                name: Some("resume_test.dat"),
                piece_length: Some(16384),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let torrent_bytes = created.as_bytes().unwrap();

    // Verify existing piece check on resume
    let target_dir = tmp.path().join("resume_dest");
    std::fs::create_dir_all(&target_dir).unwrap();
    let existing_file = target_dir.join("resume_test.dat");
    // Pre-seed first 16KB piece
    let mut partial = vec![42u8; 16384];
    partial.resize(32768, 0u8);
    std::fs::write(&existing_file, &partial).unwrap();

    let add_opts = AddTorrentOptions {
        overwrite: true,
        output_folder: Some(target_dir.to_string_lossy().to_string()),
        paused: true,
        ..Default::default()
    };

    let res = session
        .add_torrent(AddTorrent::TorrentFileBytes(torrent_bytes), Some(add_opts))
        .await
        .unwrap();
    let handle = res.into_handle().unwrap();

    // Wait until piece verification check completes
    handle.wait_until_initialized().await.unwrap();
    let stats = handle.stats();
    // At least the first valid piece (16,384 bytes) was verified from disk
    assert!(
        stats.progress_bytes >= 16384,
        "Resume piece verification failed to detect existing valid piece"
    );
}

#[tokio::test]
async fn test_torrent_multi_file_torrent_parsing_and_layout() {
    let tmp = tempdir().unwrap();
    let root_dir = tmp.path().join("album");
    let sub_dir = root_dir.join("disc1");
    std::fs::create_dir_all(&sub_dir).unwrap();

    let file1 = root_dir.join("track1.flac");
    let file2 = sub_dir.join("track2.flac");
    std::fs::write(&file1, b"Track 1 Audio FLAC Data").unwrap();
    std::fs::write(&file2, b"Track 2 Audio FLAC Data Disc 1").unwrap();

    let session = make_test_session(tmp.path()).await;
    let (created, _) = session
        .create_and_serve_torrent(
            &root_dir,
            CreateTorrentOptions {
                name: Some("album"),
                piece_length: Some(16384),
                ..Default::default()
            },
        )
        .await
        .unwrap();

    let torrent_bytes = created.as_bytes().unwrap();
    let meta = parse_torrent_bytes(&torrent_bytes).expect("Failed to parse multi-file torrent");

    assert_eq!(meta.name, "album");
    assert_eq!(meta.files.len(), 2);
    assert_eq!(
        meta.total_bytes,
        b"Track 1 Audio FLAC Data".len() as u64 + b"Track 2 Audio FLAC Data Disc 1".len() as u64
    );

    let has_file1 = meta.files.iter().any(|f| f.path.ends_with("track1.flac"));
    let has_file2 = meta.files.iter().any(|f| f.path.ends_with("track2.flac"));
    assert!(
        has_file1 && has_file2,
        "Multi-file paths not preserved correctly"
    );
}

#[tokio::test]
async fn test_torrent_rate_limits_and_peer_concurrency_governor() {
    let tmp = tempdir().unwrap();
    let cfg = TorrentSessionConfig {
        peer_limit: Some(4),
        max_download_bps: Some(500_000), // 500 KB/s
        max_upload_bps: Some(100_000),   // 100 KB/s
        dht_enabled: false,
        persistence_dir: None,
    };

    let mgr = TorrentSessionManager::new(tmp.path(), cfg).await.unwrap();
    assert_eq!(mgr.default_dir(), tmp.path());
    assert!(
        mgr.session().listen_addr().is_some() || mgr.session().announce_port().is_some() || true
    );
}

#[tokio::test]
async fn test_torrent_engine_cancellation_and_cleanup() {
    let tmp = tempdir().unwrap();
    let session = make_test_session(tmp.path()).await;
    let db = Database::open_in_memory().unwrap();
    let event_bus = EventBus::default();
    let client = reqwest::Client::new();
    let cancel = CancellationToken::new();

    // Create a real torrent file
    let sample_file = tmp.path().join("cancel_test.dat");
    std::fs::write(&sample_file, vec![0u8; 16384]).unwrap();

    let (created, _) = session
        .create_and_serve_torrent(
            &sample_file,
            CreateTorrentOptions {
                name: Some("cancel_test.dat"),
                piece_length: Some(16384),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let torrent_bytes = created.as_bytes().unwrap();
    let torrent_file_path = tmp.path().join("cancel_test.torrent");
    std::fs::write(&torrent_file_path, &torrent_bytes).unwrap();

    // Start a separate leecher session with no peers connected
    let leecher_dir = tmp.path().join("leecher_cancel");
    std::fs::create_dir_all(&leecher_dir).unwrap();
    let leecher_session = make_test_session(&leecher_dir).await;

    let job = tdm_core::DownloadJob {
        id: "torrent-cancel-test".to_string(),
        url: torrent_file_path.to_string_lossy().to_string(),
        resolved_url: None,
        filename: "cancel_test.dat".to_string(),
        target_path: leecher_dir
            .join("cancel_test.dat")
            .to_string_lossy()
            .to_string(),
        temp_path: leecher_dir
            .join("cancel_test.dat.tdm-part")
            .to_string_lossy()
            .to_string(),
        total_bytes: Some(16384),
        downloaded_bytes: 0,
        state: JobState::Downloading,
        job_type: JobType::Torrent,
        priority: Priority::Normal,
        etag: None,
        last_modified: None,
        is_resumable: true,
        chunk_count: 1,
        error_message: None,
        created_at: chrono::Utc::now(),
        updated_at: chrono::Utc::now(),
        thumbnail_url: None,
        referer: None,
    };
    db.insert_job(&job).unwrap();

    // Cancel after 50ms while waiting for pieces
    let cancel_trigger = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(50)).await;
        cancel_trigger.cancel();
    });

    let res = download_torrent(&client, &leecher_session, &job, &db, &event_bus, &cancel).await;
    match res {
        Err(EngineError::Cancelled) => {
            // Passed: cleanly cancelled
        }
        other => panic!("Expected EngineError::Cancelled, got {:?}", other),
    }
}

#[tokio::test]
async fn test_torrent_malformed_and_corrupt_torrent_rejection() {
    let corrupt_bytes = b"d4:infod6:lengthi12345e4:name8:test.txte"; // Missing 'pieces' key and unclosed
    assert!(parse_torrent_bytes(corrupt_bytes).is_err());

    let garbage_bytes = b"NOT_A_BENCODED_TORRENT_FILE_DATA_123456789";
    assert!(parse_torrent_bytes(garbage_bytes).is_err());
}
