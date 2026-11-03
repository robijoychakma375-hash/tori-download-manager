use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LiveProtocol {
    Rtsp,
    Rtmp,
    Rtmps,
    Srt,
    Rist,
    Rtp,
    Udp,
    Tcp,
    Mms,
    LiveHls,
    LiveDash,
}

impl LiveProtocol {
    pub fn as_str(&self) -> &'static str {
        match self {
            LiveProtocol::Rtsp => "rtsp",
            LiveProtocol::Rtmp => "rtmp",
            LiveProtocol::Rtmps => "rtmps",
            LiveProtocol::Srt => "srt",
            LiveProtocol::Rist => "rist",
            LiveProtocol::Rtp => "rtp",
            LiveProtocol::Udp => "udp",
            LiveProtocol::Tcp => "tcp",
            LiveProtocol::Mms => "mms",
            LiveProtocol::LiveHls => "live_hls",
            LiveProtocol::LiveDash => "live_dash",
        }
    }

    /// Returns protocol-specific input flags for FFmpeg before `-i <url>`.
    pub fn ffmpeg_input_flags(&self) -> Vec<&'static str> {
        match self {
            LiveProtocol::Rtsp => vec![
                "-rtsp_transport",
                "tcp",
                "-analyzeduration",
                "1000000",
                "-probesize",
                "100000",
                "-rw_timeout",
                "5000000",
            ],
            LiveProtocol::Rtmp | LiveProtocol::Rtmps => vec![
                "-rtmp_live",
                "live",
                "-analyzeduration",
                "1000000",
                "-probesize",
                "100000",
                "-rw_timeout",
                "5000000",
            ],
            LiveProtocol::Srt => vec![
                "-reorder_queue_size",
                "1000",
                "-analyzeduration",
                "1000000",
                "-probesize",
                "100000",
                "-rw_timeout",
                "5000000",
            ],
            LiveProtocol::Rist => vec!["-analyzeduration", "1000000", "-probesize", "100000"],
            LiveProtocol::Rtp | LiveProtocol::Udp => vec![
                "-fifo_size",
                "1000000",
                "-overrun_nonfatal",
                "1",
                "-analyzeduration",
                "1000000",
                "-probesize",
                "65536",
            ],
            LiveProtocol::Tcp => vec![
                "-analyzeduration",
                "1000000",
                "-probesize",
                "65536",
                "-rw_timeout",
                "5000000",
            ],
            LiveProtocol::Mms => vec!["-analyzeduration", "1000000", "-probesize", "65536"],
            LiveProtocol::LiveHls => vec![
                "-reconnect",
                "1",
                "-reconnect_streamed",
                "1",
                "-reconnect_delay_max",
                "5",
                "-analyzeduration",
                "1000000",
                "-probesize",
                "65536",
            ],
            LiveProtocol::LiveDash => vec![
                "-reconnect",
                "1",
                "-reconnect_streamed",
                "1",
                "-reconnect_delay_max",
                "5",
                "-analyzeduration",
                "1000000",
                "-probesize",
                "65536",
            ],
        }
    }
}

/// Detects whether a URL represents a live streaming source, and returns its protocol.
pub fn detect_live_protocol(url: &str) -> Option<LiveProtocol> {
    let trimmed = url.trim().to_lowercase();

    if trimmed.starts_with("rtsp://") {
        Some(LiveProtocol::Rtsp)
    } else if trimmed.starts_with("rtmps://") {
        Some(LiveProtocol::Rtmps)
    } else if trimmed.starts_with("rtmp://") {
        Some(LiveProtocol::Rtmp)
    } else if trimmed.starts_with("srt://") {
        Some(LiveProtocol::Srt)
    } else if trimmed.starts_with("rist://") {
        Some(LiveProtocol::Rist)
    } else if trimmed.starts_with("rtp://") {
        Some(LiveProtocol::Rtp)
    } else if trimmed.starts_with("udp://") {
        Some(LiveProtocol::Udp)
    } else if trimmed.starts_with("tcp://") {
        Some(LiveProtocol::Tcp)
    } else if trimmed.starts_with("mms://")
        || trimmed.starts_with("mmsh://")
        || trimmed.starts_with("mmst://")
    {
        Some(LiveProtocol::Mms)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_live_protocols() {
        assert_eq!(
            detect_live_protocol("rtsp://127.0.0.1:8554/live"),
            Some(LiveProtocol::Rtsp)
        );
        assert_eq!(
            detect_live_protocol("rtmp://live.example.com/app/stream"),
            Some(LiveProtocol::Rtmp)
        );
        assert_eq!(
            detect_live_protocol("rtmps://live.example.com/app/stream"),
            Some(LiveProtocol::Rtmps)
        );
        assert_eq!(
            detect_live_protocol("srt://192.168.1.50:9000?mode=caller"),
            Some(LiveProtocol::Srt)
        );
        assert_eq!(
            detect_live_protocol("rist://@127.0.0.1:1234"),
            Some(LiveProtocol::Rist)
        );
        assert_eq!(
            detect_live_protocol("rtp://239.0.0.1:5004"),
            Some(LiveProtocol::Rtp)
        );
        assert_eq!(
            detect_live_protocol("udp://@:1234"),
            Some(LiveProtocol::Udp)
        );
        assert_eq!(
            detect_live_protocol("mms://media.example.com/live"),
            Some(LiveProtocol::Mms)
        );
        assert_eq!(detect_live_protocol("https://example.com/video.mp4"), None);
    }
}
