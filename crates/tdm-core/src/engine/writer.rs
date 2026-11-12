use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tokio_util::sync::CancellationToken;

use crate::error::{EngineError, Result};
use crate::types::ChunkRecord;

struct ActivePartEntry {
    instance_id: u64,
    job_id: Option<String>,
    cancel_token: Option<CancellationToken>,
}

static NEXT_WRITER_INSTANCE_ID: AtomicU64 = AtomicU64::new(1);
static ACTIVE_PART_FILES: OnceLock<Mutex<HashMap<String, ActivePartEntry>>> = OnceLock::new();

fn active_part_files() -> &'static Mutex<HashMap<String, ActivePartEntry>> {
    ACTIVE_PART_FILES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn normalize_part_path_key(path: &Path) -> String {
    let abs = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    };
    #[cfg(windows)]
    {
        abs.to_string_lossy().replace('/', "\\").to_lowercase()
    }
    #[cfg(not(windows))]
    {
        abs.to_string_lossy().to_string()
    }
}

#[cfg(windows)]
mod win_fs {
    use std::fs::File;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::AsRawHandle;
    use std::path::Path;

    const FSCTL_SET_SPARSE: u32 = 0x0009_00C4;
    const FILE_SUPPORTS_SPARSE_FILES: u32 = 0x0000_0040;
    const FAT32_MAX_FILE_SIZE: u64 = 4_294_967_295; // 4 GiB - 1 byte

    #[link(name = "kernel32")]
    extern "system" {
        fn DeviceIoControl(
            h_device: *mut std::ffi::c_void,
            dw_io_control_code: u32,
            lp_in_buffer: *const std::ffi::c_void,
            n_in_buffer_size: u32,
            lp_out_buffer: *mut std::ffi::c_void,
            n_out_buffer_size: u32,
            lp_bytes_returned: *mut u32,
            lp_overlapped: *mut std::ffi::c_void,
        ) -> i32;

        fn GetDiskFreeSpaceExW(
            lp_directory_name: *const u16,
            lp_free_bytes_available_to_caller: *mut u64,
            lp_total_number_of_bytes: *mut u64,
            lp_total_number_of_free_bytes: *mut u64,
        ) -> i32;

        fn GetVolumeInformationByHandleW(
            h_file: *mut std::ffi::c_void,
            lp_volume_name_buffer: *mut u16,
            n_volume_name_size: u32,
            lp_volume_serial_number: *mut u32,
            lp_maximum_component_length: *mut u32,
            lp_file_system_flags: *mut u32,
            lp_file_system_name_buffer: *mut u16,
            n_file_system_name_size: u32,
        ) -> i32;
    }

    #[derive(Debug, Clone)]
    pub struct VolumeCapabilities {
        pub fs_name: String,
        pub supports_sparse: bool,
    }

    pub fn query_volume_capabilities(file: &File) -> Option<VolumeCapabilities> {
        let mut fs_flags: u32 = 0;
        let mut fs_name_buf = [0u16; 64];
        let ok = unsafe {
            GetVolumeInformationByHandleW(
                file.as_raw_handle() as *mut std::ffi::c_void,
                std::ptr::null_mut(),
                0,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut fs_flags,
                fs_name_buf.as_mut_ptr(),
                fs_name_buf.len() as u32,
            )
        };
        if ok == 0 {
            return None;
        }
        let len = fs_name_buf
            .iter()
            .position(|&c| c == 0)
            .unwrap_or(fs_name_buf.len());
        let fs_name = String::from_utf16_lossy(&fs_name_buf[..len]);
        Some(VolumeCapabilities {
            fs_name,
            supports_sparse: (fs_flags & FILE_SUPPORTS_SPARSE_FILES) != 0,
        })
    }

    pub fn query_free_disk_space(dir: &Path) -> Option<u64> {
        let wide: Vec<u16> = dir
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let mut free_avail: u64 = 0;
        let mut total_bytes: u64 = 0;
        let mut total_free: u64 = 0;
        let ok = unsafe {
            GetDiskFreeSpaceExW(
                wide.as_ptr(),
                &mut free_avail,
                &mut total_bytes,
                &mut total_free,
            )
        };
        if ok != 0 {
            Some(free_avail)
        } else {
            None
        }
    }

    pub fn try_mark_sparse(file: &File) -> bool {
        let mut bytes_returned: u32 = 0;
        let ok = unsafe {
            DeviceIoControl(
                file.as_raw_handle() as *mut std::ffi::c_void,
                FSCTL_SET_SPARSE,
                std::ptr::null(),
                0,
                std::ptr::null_mut(),
                0,
                &mut bytes_returned,
                std::ptr::null_mut(),
            )
        };
        ok != 0
    }

    pub fn is_fat32_over_limit(fs_name: &str, total_bytes: u64) -> bool {
        let upper = fs_name.trim().to_ascii_uppercase();
        (upper == "FAT32" || upper == "FAT" || upper == "FAT16")
            && total_bytes > FAT32_MAX_FILE_SIZE
    }
}

struct PartFileInner {
    file: File,
    path_key: String,
    instance_id: u64,
    is_sparse: bool,
}

impl Drop for PartFileInner {
    fn drop(&mut self) {
        if let Ok(mut guard) = active_part_files().lock() {
            if guard
                .get(&self.path_key)
                .map(|e| e.instance_id == self.instance_id)
                .unwrap_or(false)
            {
                guard.remove(&self.path_key);
            }
        }
    }
}

#[derive(Clone)]
pub struct PartFileWriter {
    inner: Arc<PartFileInner>,
}

impl PartFileWriter {
    pub fn open_or_create<P: AsRef<Path>>(path: P, total_bytes: Option<u64>) -> Result<Self> {
        Self::open_or_create_for_job(path, total_bytes, None, None)
    }

    pub fn open_or_create_for_job<P: AsRef<Path>>(
        path: P,
        total_bytes: Option<u64>,
        job_id: Option<String>,
        cancel_token: Option<CancellationToken>,
    ) -> Result<Self> {
        let path_ref = path.as_ref();
        if let Some(parent) = path_ref.parent() {
            if !parent.as_os_str().is_empty() && !parent.exists() {
                fs::create_dir_all(parent).map_err(EngineError::Io)?;
            }
        }

        let path_key = normalize_part_path_key(path_ref);
        let instance_id = NEXT_WRITER_INSTANCE_ID.fetch_add(1, Ordering::Relaxed);
        {
            let mut active = active_part_files()
                .lock()
                .map_err(|_| EngineError::Other("Active part-file registry poisoned".into()))?;
            if let Some(existing) = active.get(&path_key) {
                let same_job = job_id.is_some() && existing.job_id == job_id;
                if same_job {
                    if let Some(ref prev_cancel) = existing.cancel_token {
                        prev_cancel.cancel();
                    }
                } else {
                    return Err(EngineError::DiskWrite(format!(
                        "Part file is already locked by another active download task: {}",
                        path_ref.display()
                    )));
                }
            }
            active.insert(
                path_key.clone(),
                ActivePartEntry {
                    instance_id,
                    job_id,
                    cancel_token,
                },
            );
        }

        let init_res = Self::init_file(path_ref, total_bytes);
        match init_res {
            Ok((file, is_sparse)) => Ok(Self {
                inner: Arc::new(PartFileInner {
                    file,
                    path_key,
                    instance_id,
                    is_sparse,
                }),
            }),
            Err(e) => {
                if let Ok(mut active) = active_part_files().lock() {
                    if active
                        .get(&path_key)
                        .map(|entry| entry.instance_id == instance_id)
                        .unwrap_or(false)
                    {
                        active.remove(&path_key);
                    }
                }
                Err(e)
            }
        }
    }

    pub async fn open_or_create_async<P: AsRef<Path>>(
        path: P,
        total_bytes: Option<u64>,
    ) -> Result<Self> {
        Self::open_or_create_for_job_async(path, total_bytes, None, None).await
    }

    pub async fn open_or_create_for_job_async<P: AsRef<Path>>(
        path: P,
        total_bytes: Option<u64>,
        job_id: Option<String>,
        cancel_token: Option<CancellationToken>,
    ) -> Result<Self> {
        let path_buf = path.as_ref().to_path_buf();
        tokio::task::spawn_blocking(move || {
            Self::open_or_create_for_job(path_buf, total_bytes, job_id, cancel_token)
        })
        .await
        .map_err(|e| EngineError::Other(format!("File open worker task failed: {}", e)))?
    }

    fn init_file(path_ref: &Path, total_bytes: Option<u64>) -> Result<(File, bool)> {
        let existing_len = fs::metadata(path_ref).map(|m| m.len()).unwrap_or(0);

        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path_ref)
            .map_err(EngineError::Io)?;

        #[allow(unused_mut)]
        let mut is_sparse = false;

        #[cfg(windows)]
        {
            let vol_caps = win_fs::query_volume_capabilities(&file);
            if let Some(total) = total_bytes {
                if let Some(ref caps) = vol_caps {
                    if win_fs::is_fat32_over_limit(&caps.fs_name, total) {
                        return Err(EngineError::DiskWrite(format!(
                            "File size ({} bytes) exceeds the 4 GB maximum supported by {} filesystem",
                            total, caps.fs_name
                        )));
                    }
                }

                let allow_overcommit = std::env::var("TORI_ALLOW_SPARSE_OVERCOMMIT")
                    .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
                    .unwrap_or(false);

                if !allow_overcommit {
                    let check_dir = path_ref
                        .parent()
                        .filter(|p| !p.as_os_str().is_empty())
                        .unwrap_or_else(|| Path::new("."));
                    if let Some(free_avail) = win_fs::query_free_disk_space(check_dir) {
                        let required_more = total.saturating_sub(existing_len);
                        if free_avail < required_more {
                            return Err(EngineError::DiskWrite(format!(
                                "Insufficient disk space on target volume: required {} bytes, available {} bytes",
                                required_more, free_avail
                            )));
                        }
                    }
                }
            }

            let supports_sparse = vol_caps.as_ref().map(|c| c.supports_sparse).unwrap_or(true);
            if supports_sparse {
                is_sparse = win_fs::try_mark_sparse(&file);
            }
        }

        #[cfg(not(windows))]
        {
            is_sparse = true;
        }

        if let Some(total) = total_bytes {
            let current_len = file.metadata().map_err(EngineError::Io)?.len();
            if current_len < total {
                // Only set logical EOF up front if the file is sparse (NTFS/ReFS/Unix) or small (<= 64 MiB).
                // On non-sparse Windows filesystems (e.g. exFAT), setting EOF on multi-GB files and writing
                // at high offsets would force synchronous kernel zero-filling of the entire gap.
                if is_sparse || total <= 64 * 1024 * 1024 {
                    file.set_len(total).map_err(|e| {
                        EngineError::DiskWrite(format!(
                            "Failed to allocate file length ({} bytes): {}",
                            total, e
                        ))
                    })?;
                }
            }
        }

        Ok((file, is_sparse))
    }

    pub fn is_sparse(&self) -> bool {
        self.inner.is_sparse
    }

    pub fn write_at(&self, offset: u64, buf: &[u8]) -> Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }

        #[cfg(windows)]
        {
            use std::os::windows::fs::FileExt;
            let mut written = 0;
            while written < buf.len() {
                let n = self
                    .inner
                    .file
                    .seek_write(&buf[written..], offset + written as u64)
                    .map_err(|e| EngineError::DiskWrite(e.to_string()))?;
                if n == 0 {
                    return Err(EngineError::DiskWrite("Write returned 0 bytes".to_string()));
                }
                written += n;
            }
            Ok(written)
        }

        #[cfg(not(windows))]
        {
            use std::os::unix::fs::FileExt;
            self.inner
                .file
                .write_all_at(buf, offset)
                .map_err(|e| EngineError::DiskWrite(e.to_string()))?;
            Ok(buf.len())
        }
    }

    pub fn sync(&self) -> Result<()> {
        self.inner.file.sync_data().map_err(EngineError::Io)
    }

    pub async fn sync_async(&self) -> Result<()> {
        let cloned = self.clone();
        tokio::task::spawn_blocking(move || cloned.sync())
            .await
            .map_err(|e| EngineError::Other(format!("Disk sync task failed: {}", e)))?
    }

    pub fn truncate_to(&self, length: u64) -> Result<()> {
        self.inner.file.set_len(length).map_err(EngineError::Io)
    }
}

/// Verifies that all chunks for a download are marked complete, have written their exact byte ranges
/// with zero gaps or overlaps (preventing unwritten sparse regions from ever being accepted as downloaded data),
/// and match the expected total byte length and physical file length on disk.
pub fn verify_chunks_complete_and_contiguous(
    chunks: &[ChunkRecord],
    expected_total: Option<u64>,
    part_path: &Path,
) -> Result<u64> {
    let meta = fs::metadata(part_path).map_err(|e| {
        EngineError::TempFileMissing(format!(
            "Part file missing or unreadable at {}: {}",
            part_path.display(),
            e
        ))
    })?;

    if chunks.is_empty() {
        if expected_total == Some(0) {
            return Ok(0);
        }
        return Err(EngineError::DiskWrite(
            "Download has no recorded chunk metadata".to_string(),
        ));
    }

    for c in chunks {
        if !c.is_complete {
            return Err(EngineError::ContentLengthMismatch {
                expected: expected_total.unwrap_or(c.end_byte.saturating_add(1)),
                actual: chunks.iter().map(|ch| ch.written_bytes).sum(),
            });
        }
    }

    let total_downloaded: u64 = chunks.iter().map(|c| c.written_bytes).sum();

    if let Some(expected) = expected_total {
        if total_downloaded != expected {
            return Err(EngineError::ContentLengthMismatch {
                expected,
                actual: total_downloaded,
            });
        }

        if expected > 0 {
            let mut sorted = chunks.to_vec();
            sorted.sort_by_key(|c| c.start_byte);

            if sorted[0].start_byte != 0 {
                return Err(EngineError::DiskWrite(format!(
                    "Incomplete sparse file: first chunk starts at byte {} instead of 0",
                    sorted[0].start_byte
                )));
            }

            let mut expected_next_start: u64 = 0;
            for c in &sorted {
                if c.start_byte != expected_next_start {
                    return Err(EngineError::DiskWrite(format!(
                        "Unwritten sparse gap or overlap detected before chunk {}: expected start {}, found {}",
                        c.chunk_index, expected_next_start, c.start_byte
                    )));
                }
                let expected_chunk_len = c
                    .end_byte
                    .checked_sub(c.start_byte)
                    .and_then(|d| d.checked_add(1))
                    .ok_or_else(|| {
                        EngineError::DiskWrite(format!(
                            "Invalid chunk bounds for chunk {}: {}..={}",
                            c.chunk_index, c.start_byte, c.end_byte
                        ))
                    })?;
                if c.written_bytes != expected_chunk_len {
                    return Err(EngineError::DiskWrite(format!(
                        "Chunk {} incomplete: written_bytes={} but range {}..={} requires {} bytes",
                        c.chunk_index, c.written_bytes, c.start_byte, c.end_byte, expected_chunk_len
                    )));
                }
                expected_next_start = c.end_byte.saturating_add(1);
            }

            if expected_next_start != expected {
                return Err(EngineError::ContentLengthMismatch {
                    expected,
                    actual: expected_next_start,
                });
            }
        }

        if meta.len() != expected {
            return Err(EngineError::ContentLengthMismatch {
                expected,
                actual: meta.len(),
            });
        }
    }

    Ok(total_downloaded)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Seek, SeekFrom};
    use std::time::Instant;
    use tempfile::tempdir;

    #[test]
    fn test_sparse_high_offset_write_does_not_stall() {
        let dir = tempdir().unwrap();
        let part_path = dir.path().join("large_5gb.tdm-part");
        let five_gb: u64 = 5 * 1024 * 1024 * 1024; // 5 GiB (> 4 GiB 32-bit boundary)

        let start = Instant::now();
        let writer = PartFileWriter::open_or_create(&part_path, Some(five_gb)).unwrap();
        assert!(writer.is_sparse());

        // Write at chunk 15 offset (~4.7 GiB) and chunk 0 offset (0)
        let high_offset = five_gb - 4096;
        let payload = b"TORI_SPARSE_HIGH_OFFSET_VERIFICATION_BLOCK";
        writer.write_at(high_offset, payload).unwrap();
        writer.write_at(0, b"HEAD_BLOCK").unwrap();
        writer.sync().unwrap();

        let elapsed = start.elapsed();
        // On NTFS with FSCTL_SET_SPARSE, writing at 5 GiB takes < 200ms instead of zero-filling 5 GiB
        assert!(
            elapsed.as_secs() < 2,
            "High-offset sparse write took too long: {:?}",
            elapsed
        );

        let mut f = File::open(&part_path).unwrap();
        assert_eq!(f.metadata().unwrap().len(), five_gb);
        let mut head = [0u8; 10];
        f.read_exact(&mut head).unwrap();
        assert_eq!(&head, b"HEAD_BLOCK");

        f.seek(SeekFrom::Start(high_offset)).unwrap();
        let mut tail = vec![0u8; payload.len()];
        f.read_exact(&mut tail).unwrap();
        assert_eq!(&tail[..], payload);
    }

    #[test]
    fn test_concurrent_part_file_collision_prevented() {
        let dir = tempdir().unwrap();
        let part_path = dir.path().join("collision.rar.tdm-part");

        let writer1 = PartFileWriter::open_or_create(&part_path, Some(1024)).unwrap();
        // Cloning writer1 for workers of the same task succeeds
        let _worker_clone = writer1.clone();

        // A second task attempting to open the same .tdm-part file while writer1 is active must fail
        let second_attempt = PartFileWriter::open_or_create(&part_path, Some(1024));
        assert!(second_attempt.is_err());
        let err_msg = second_attempt.err().unwrap().to_string();
        assert!(err_msg.contains("already locked by another active download task"));

        // Dropping writer1 and its clone releases the lock so resume/retry can reopen it
        drop(_worker_clone);
        drop(writer1);

        let reopen = PartFileWriter::open_or_create(&part_path, Some(1024));
        assert!(reopen.is_ok());
    }

    #[test]
    fn test_verify_chunks_rejects_unwritten_sparse_gaps() {
        let dir = tempdir().unwrap();
        let part_path = dir.path().join("sparse_gap.tdm-part");
        let total = 1000u64;
        let writer = PartFileWriter::open_or_create(&part_path, Some(total)).unwrap();
        writer.write_at(0, &[1u8; 500]).unwrap();
        drop(writer);

        // Case 1: Chunk 1 is incomplete (unwritten sparse region 500..=999)
        let incomplete_chunks = vec![
            ChunkRecord {
                id: None,
                download_id: "d1".into(),
                chunk_index: 0,
                start_byte: 0,
                end_byte: 499,
                written_bytes: 500,
                is_complete: true,
            },
            ChunkRecord {
                id: None,
                download_id: "d1".into(),
                chunk_index: 1,
                start_byte: 500,
                end_byte: 999,
                written_bytes: 100,
                is_complete: false,
            },
        ];
        assert!(
            verify_chunks_complete_and_contiguous(&incomplete_chunks, Some(total), &part_path)
                .is_err()
        );

        // Case 2: Chunk marked complete but has a gap between chunk 0 (0..=399) and chunk 1 (500..=999)
        let gap_chunks = vec![
            ChunkRecord {
                id: None,
                download_id: "d1".into(),
                chunk_index: 0,
                start_byte: 0,
                end_byte: 399,
                written_bytes: 400,
                is_complete: true,
            },
            ChunkRecord {
                id: None,
                download_id: "d1".into(),
                chunk_index: 1,
                start_byte: 500,
                end_byte: 999,
                written_bytes: 500,
                is_complete: true,
            },
        ];
        assert!(
            verify_chunks_complete_and_contiguous(&gap_chunks, Some(total), &part_path).is_err()
        );

        // Case 3: Full contiguous coverage passes
        let valid_chunks = vec![
            ChunkRecord {
                id: None,
                download_id: "d1".into(),
                chunk_index: 0,
                start_byte: 0,
                end_byte: 499,
                written_bytes: 500,
                is_complete: true,
            },
            ChunkRecord {
                id: None,
                download_id: "d1".into(),
                chunk_index: 1,
                start_byte: 500,
                end_byte: 999,
                written_bytes: 500,
                is_complete: true,
            },
        ];
        assert_eq!(
            verify_chunks_complete_and_contiguous(&valid_chunks, Some(total), &part_path).unwrap(),
            total
        );
    }
}
