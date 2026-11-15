use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// A thread-safe, async-aware Token Bucket Bandwidth Limiter.
/// When rate_bps is 0, limiting is disabled and operations return immediately with zero cost.
pub struct BandwidthLimiter {
    rate_bps: AtomicU64,
    state: Mutex<LimiterState>,
}

struct LimiterState {
    tokens: f64,
    last_update: Instant,
}

impl BandwidthLimiter {
    pub fn new(rate_bps: u64) -> Self {
        Self {
            rate_bps: AtomicU64::new(rate_bps),
            state: Mutex::new(LimiterState {
                tokens: rate_bps as f64,
                last_update: Instant::now(),
            }),
        }
    }

    pub fn set_rate_limit(&self, rate_bps: u64) {
        self.rate_bps.store(rate_bps, Ordering::SeqCst);
        let mut guard = self.state.lock().unwrap();
        guard.tokens = guard.tokens.min((rate_bps as f64) * 2.0);
        guard.last_update = Instant::now();
    }

    pub fn rate_limit(&self) -> u64 {
        self.rate_bps.load(Ordering::Relaxed)
    }

    pub async fn acquire(&self, mut bytes: u64) {
        if bytes == 0 {
            return;
        }

        loop {
            let rate = self.rate_bps.load(Ordering::Relaxed);
            if rate == 0 {
                return;
            }

            let wait = {
                let mut guard = self.state.lock().unwrap();
                let now = Instant::now();
                let elapsed = now.duration_since(guard.last_update).as_secs_f64();
                guard.last_update = now;

                let max_bucket = (rate as f64) * 2.0; // Allow burst up to 2.0s
                guard.tokens = (guard.tokens + elapsed * (rate as f64)).min(max_bucket);

                // Never demand more tokens at once than a bounded fraction of the bucket capacity,
                // otherwise large chunk reads at low rate limits would spin forever and deadlock.
                let slice_cap = (max_bucket * 0.25).floor().max(1.0) as u64;
                let slice = bytes.min(slice_cap);
                if guard.tokens >= slice as f64 {
                    guard.tokens -= slice as f64;
                    bytes -= slice;
                    if bytes == 0 {
                        return;
                    }
                    Duration::ZERO
                } else {
                    let deficit = (slice as f64) - guard.tokens;
                    Duration::from_secs_f64(deficit / (rate as f64))
                }
            };

            if !wait.is_zero() {
                // Sleep without holding lock
                tokio::time::sleep(wait.min(Duration::from_secs(1))).await;
            }
        }
    }
}

impl Default for BandwidthLimiter {
    fn default() -> Self {
        Self::new(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_bandwidth_limiter_unlimited() {
        let limiter = BandwidthLimiter::new(0);
        let start = Instant::now();
        limiter.acquire(1_000_000).await;
        assert!(start.elapsed() < Duration::from_millis(50));
    }

    #[tokio::test]
    async fn test_bandwidth_limiter_throttles() {
        // Limit to 100 KB/s
        let limiter = BandwidthLimiter::new(100_000);
        // Drain initial burst
        limiter.acquire(200_000).await;

        let start = Instant::now();
        limiter.acquire(50_000).await; // 50 KB at 100 KB/s should take ~500ms
        let elapsed = start.elapsed();
        assert!(
            elapsed >= Duration::from_millis(300),
            "Should throttle: {:?}",
            elapsed
        );
    }

    #[tokio::test]
    async fn test_bandwidth_limiter_large_chunk_exceeding_bucket_never_deadlocks() {
        // 50 KB/s -> max_bucket = 100_000 bytes; acquiring 180_000 bytes (> max_bucket) must finish
        let limiter = BandwidthLimiter::new(50_000);
        // Drain initial burst to 0
        limiter.acquire(50_000).await;

        let start = Instant::now();
        tokio::time::timeout(Duration::from_secs(6), limiter.acquire(150_000))
            .await
            .expect("Large acquire > max_bucket must not deadlock");
        let elapsed = start.elapsed();
        assert!(
            elapsed >= Duration::from_millis(2400),
            "150 KB at 50 KB/s should throttle ~3s, got {:?}",
            elapsed
        );
    }
}
