use crate::types::ChunkRecord;

pub fn plan_chunks(
    download_id: &str,
    total_bytes: Option<u64>,
    supports_ranges: bool,
) -> Vec<ChunkRecord> {
    plan_chunks_with_concurrency(download_id, total_bytes, supports_ranges, 8)
}

pub fn plan_chunks_with_concurrency(
    download_id: &str,
    total_bytes: Option<u64>,
    supports_ranges: bool,
    max_concurrency: usize,
) -> Vec<ChunkRecord> {
    let max_c = max_concurrency.clamp(1, 32);
    let Some(total) = total_bytes else {
        // Unknown length: single streaming chunk
        return vec![ChunkRecord {
            id: None,
            download_id: download_id.to_string(),
            chunk_index: 0,
            start_byte: 0,
            end_byte: 0, // dynamic/stream
            written_bytes: 0,
            is_complete: false,
        }];
    };

    if total == 0 {
        return vec![ChunkRecord {
            id: None,
            download_id: download_id.to_string(),
            chunk_index: 0,
            start_byte: 0,
            end_byte: 0,
            written_bytes: 0,
            is_complete: true,
        }];
    }

    if !supports_ranges {
        // Range not supported: single chunk covering the whole file
        return vec![ChunkRecord {
            id: None,
            download_id: download_id.to_string(),
            chunk_index: 0,
            start_byte: 0,
            end_byte: total - 1,
            written_bytes: 0,
            is_complete: false,
        }];
    }

    // Adaptive chunk counts bounded by max_concurrency:
    // Small (< 2MB): 1 connection
    // Medium (2MB - 16MB): up to 2 connections
    // Moderate (16MB - 64MB): up to 4 connections
    // Large (>= 64MB): up to max_c connections
    let chunk_count = if total < 2 * 1024 * 1024 {
        1
    } else if total < 16 * 1024 * 1024 {
        2.min(max_c)
    } else if total < 64 * 1024 * 1024 {
        4.min(max_c)
    } else {
        max_c
    };

    let chunk_size = total / (chunk_count as u64);
    let mut chunks = Vec::with_capacity(chunk_count);

    for i in 0..chunk_count {
        let start_byte = (i as u64) * chunk_size;
        let end_byte = if i == chunk_count - 1 {
            total - 1 // Last chunk absorbs remainder
        } else {
            start_byte + chunk_size - 1
        };

        chunks.push(ChunkRecord {
            id: None,
            download_id: download_id.to_string(),
            chunk_index: i,
            start_byte,
            end_byte,
            written_bytes: 0,
            is_complete: false,
        });
    }

    chunks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_chunk_planning_coverage() {
        let total = 100_000_000u64;
        let chunks = plan_chunks("test-1", Some(total), true);
        assert_eq!(chunks.len(), 8);

        // Check continuity and no overlap
        assert_eq!(chunks[0].start_byte, 0);
        for i in 0..chunks.len() - 1 {
            assert_eq!(chunks[i].end_byte + 1, chunks[i + 1].start_byte);
        }
        assert_eq!(chunks.last().unwrap().end_byte, total - 1);
    }

    #[test]
    fn test_plan_chunks_custom_concurrency() {
        let total = 100_000_000u64;
        let chunks16 = plan_chunks_with_concurrency("test-16", Some(total), true, 16);
        assert_eq!(chunks16.len(), 16);

        let chunks4 = plan_chunks_with_concurrency("test-4", Some(total), true, 4);
        assert_eq!(chunks4.len(), 4);
    }
}
