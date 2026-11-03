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

    pub async fn acquire(&self, bytes: u64) {
        let rate = self.rate_bps.load(Ordering::Relaxed);
        if rate == 0 || bytes == 0 {
            return;
        }

        loop {
            let wait = {
                let mut guard = self.state.lock().unwrap();
                let now = Instant::now();
                let elapsed = now.duration_since(guard.last_update).as_secs_f64();
                guard.last_update = now;

                let max_bucket = (rate as f64) * 2.0; // Allow burst up to 2.0s
                guard.tokens = (guard.tokens + elapsed * (rate as f64)).min(max_bucket);

                if guard.tokens >= bytes as f64 {
                    guard.tokens -= bytes as f64;
                    return;
                } else {
                    let deficit = (bytes as f64) - guard.tokens;
                    Duration::from_secs_f64(deficit / (rate as f64))
                }
            };

            // Sleep without holding lock
            tokio::time::sleep(wait.min(Duration::from_secs(1))).await;
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
}
