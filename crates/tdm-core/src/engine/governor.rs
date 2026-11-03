use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone)]
pub struct GovernorConfig {
    pub max_global_connections: usize,
    pub max_connections_per_host: usize,
}

impl Default for GovernorConfig {
    fn default() -> Self {
        Self {
            max_global_connections: 16,
            max_connections_per_host: 6,
        }
    }
}

pub struct ConcurrencyGovernor {
    max_global_connections: AtomicUsize,
    max_connections_per_host: AtomicUsize,
    active_global: AtomicUsize,
    active_per_host: Mutex<HashMap<String, usize>>,
}

impl ConcurrencyGovernor {
    pub fn new(config: GovernorConfig) -> Arc<Self> {
        Arc::new(Self {
            max_global_connections: AtomicUsize::new(config.max_global_connections),
            max_connections_per_host: AtomicUsize::new(config.max_connections_per_host),
            active_global: AtomicUsize::new(0),
            active_per_host: Mutex::new(HashMap::new()),
        })
    }

    pub fn set_limits(&self, max_global: usize, max_per_host: usize) {
        self.max_global_connections
            .store(max_global, Ordering::SeqCst);
        self.max_connections_per_host
            .store(max_per_host, Ordering::SeqCst);
    }

    pub fn max_global_connections(&self) -> usize {
        self.max_global_connections.load(Ordering::Relaxed)
    }

    pub fn max_connections_per_host(&self) -> usize {
        self.max_connections_per_host.load(Ordering::Relaxed)
    }

    pub fn acquire_permit(self: &Arc<Self>, host: &str) -> Option<ConnectionPermit> {
        let max_global = self.max_global_connections.load(Ordering::Relaxed);
        let global = self.active_global.load(Ordering::Relaxed);
        if global >= max_global {
            return None;
        }

        let mut hosts = self.active_per_host.lock().unwrap();
        let current_host_conns = hosts.get(host).copied().unwrap_or(0);
        let max_per_host = self.max_connections_per_host.load(Ordering::Relaxed);
        if current_host_conns >= max_per_host {
            return None;
        }

        self.active_global.fetch_add(1, Ordering::SeqCst);
        hosts.insert(host.to_string(), current_host_conns + 1);

        Some(ConnectionPermit {
            host: host.to_string(),
            governor: self.clone(),
        })
    }

    pub fn active_global(&self) -> usize {
        self.active_global.load(Ordering::Relaxed)
    }

    pub fn active_for_host(&self, host: &str) -> usize {
        let hosts = self.active_per_host.lock().unwrap();
        hosts.get(host).copied().unwrap_or(0)
    }

    fn release(&self, host: &str) {
        self.active_global.fetch_sub(1, Ordering::SeqCst);
        let mut hosts = self.active_per_host.lock().unwrap();
        if let Some(count) = hosts.get_mut(host) {
            if *count <= 1 {
                hosts.remove(host);
            } else {
                *count -= 1;
            }
        }
    }
}

pub struct ConnectionPermit {
    host: String,
    governor: Arc<ConcurrencyGovernor>,
}

impl Drop for ConnectionPermit {
    fn drop(&mut self) {
        self.governor.release(&self.host);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_concurrency_governor_limits() {
        let config = GovernorConfig {
            max_global_connections: 4,
            max_connections_per_host: 2,
        };
        let governor = ConcurrencyGovernor::new(config);

        let p1 = governor.acquire_permit("cdn1.example.com");
        assert!(p1.is_some());
        let p2 = governor.acquire_permit("cdn1.example.com");
        assert!(p2.is_some());

        // Host limit reached for cdn1
        let p3 = governor.acquire_permit("cdn1.example.com");
        assert!(p3.is_none());

        // Different host can still get permits
        let p4 = governor.acquire_permit("cdn2.example.com");
        assert!(p4.is_some());
        let p5 = governor.acquire_permit("cdn2.example.com");
        assert!(p5.is_some());

        // Global limit reached (4)
        let p6 = governor.acquire_permit("cdn3.example.com");
        assert!(p6.is_none());

        // Dropping one frees slot
        drop(p1);
        assert_eq!(governor.active_for_host("cdn1.example.com"), 1);
        let p7 = governor.acquire_permit("cdn1.example.com");
        assert!(p7.is_some());
    }
}
