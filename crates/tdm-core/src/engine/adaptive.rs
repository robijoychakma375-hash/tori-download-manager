use crate::types::ChunkRecord;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

#[derive(Debug, Clone)]
pub struct AdaptiveConfig {
    pub min_split_size: u64,
    pub max_concurrency: usize,
    pub sample_window_ms: u64,
}

impl Default for AdaptiveConfig {
    fn default() -> Self {
        Self {
            min_split_size: 2 * 1024 * 1024, // 2 MB minimum remaining to split
            max_concurrency: 8,
            sample_window_ms: 500,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SplitPlan {
    pub original_index: usize,
    pub new_index: usize,
    pub new_end_for_original: u64,
    pub split_start: u64,
    pub original_end: u64,
}

pub struct AdaptiveScheduler {
    pub min_split_size: AtomicU64,
    pub max_concurrency: AtomicUsize,
    pub sample_window_ms: u64,
}

impl AdaptiveScheduler {
    pub fn new(config: AdaptiveConfig) -> Self {
        Self {
            min_split_size: AtomicU64::new(config.min_split_size),
            max_concurrency: AtomicUsize::new(config.max_concurrency),
            sample_window_ms: config.sample_window_ms,
        }
    }

    pub fn set_min_split_size(&self, size: u64) {
        self.min_split_size.store(size, Ordering::SeqCst);
    }

    pub fn min_split_size(&self) -> u64 {
        self.min_split_size.load(Ordering::Relaxed)
    }

    pub fn set_max_concurrency(&self, con: usize) {
        self.max_concurrency.store(con, Ordering::SeqCst);
    }

    pub fn max_concurrency(&self) -> usize {
        self.max_concurrency.load(Ordering::Relaxed)
    }

    /// Evaluates existing chunks and determines if a straggling chunk can be safely split.
    /// Returns a strictly disjoint, non-overlapping SplitPlan if an eligible chunk exists.
    pub fn evaluate_straggler_split(&self, chunks: &[ChunkRecord]) -> Option<SplitPlan> {
        let mut best_candidate: Option<(&ChunkRecord, u64)> = None;
        let mut max_chunk_index = 0;
        let min_size = self.min_split_size.load(Ordering::Relaxed);

        for chunk in chunks {
            if chunk.chunk_index > max_chunk_index {
                max_chunk_index = chunk.chunk_index;
            }

            if chunk.is_complete {
                continue;
            }

            let total_chunk_len = chunk.end_byte.saturating_sub(chunk.start_byte) + 1;
            let remaining = total_chunk_len.saturating_sub(chunk.written_bytes);

            if remaining >= min_size {
                match best_candidate {
                    Some((_, current_max_rem)) => {
                        if remaining > current_max_rem {
                            best_candidate = Some((chunk, remaining));
                        }
                    }
                    None => {
                        best_candidate = Some((chunk, remaining));
                    }
                }
            }
        }

        let (candidate, remaining) = best_candidate?;

        // Split the unwritten tail into two halves
        let half = remaining / 2;
        let current_offset = candidate.start_byte + candidate.written_bytes;
        let split_start = current_offset + half;
        let new_end_for_original = split_start - 1;

        if split_start > candidate.end_byte || new_end_for_original < current_offset {
            return None;
        }

        Some(SplitPlan {
            original_index: candidate.chunk_index,
            new_index: max_chunk_index + 1,
            new_end_for_original,
            split_start,
            original_end: candidate.end_byte,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_evaluate_straggler_split_disjoint() {
        let scheduler = AdaptiveScheduler::new(AdaptiveConfig {
            min_split_size: 2 * 1024 * 1024,
            max_concurrency: 8,
            sample_window_ms: 500,
        });

        let chunks = vec![
            ChunkRecord {
                id: Some(1),
                download_id: "dl-1".to_string(),
                chunk_index: 0,
                start_byte: 0,
                end_byte: 10_000_000,
                written_bytes: 4_000_000, // 6 MB remaining
                is_complete: false,
            },
            ChunkRecord {
                id: Some(2),
                download_id: "dl-1".to_string(),
                chunk_index: 1,
                start_byte: 10_000_001,
                end_byte: 20_000_000,
                written_bytes: 9_500_000, // 500 KB remaining (below min split)
                is_complete: false,
            },
        ];

        let plan = scheduler
            .evaluate_straggler_split(&chunks)
            .expect("Expected split plan");
        assert_eq!(plan.original_index, 0);
        assert_eq!(plan.new_index, 2);

        // Verification of strictly disjoint boundaries:
        assert_eq!(plan.new_end_for_original + 1, plan.split_start);
        assert_eq!(plan.original_end, 10_000_000);
        assert!(plan.new_end_for_original >= 4_000_000); // Does not overwrite already written bytes
    }

    #[test]
    fn test_evaluate_straggler_split_below_threshold() {
        let scheduler = AdaptiveScheduler::new(AdaptiveConfig {
            min_split_size: 2 * 1024 * 1024,
            max_concurrency: 8,
            sample_window_ms: 500,
        });

        let chunks = vec![ChunkRecord {
            id: Some(1),
            download_id: "dl-1".to_string(),
            chunk_index: 0,
            start_byte: 0,
            end_byte: 1_000_000,
            written_bytes: 500_000, // 500 KB remaining
            is_complete: false,
        }];

        assert!(scheduler.evaluate_straggler_split(&chunks).is_none());
    }
}
