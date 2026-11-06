# TORI Download Manager v1.0.0 Release Notes

**Release Date:** 2026-11-06  
**Target Platform:** Windows 10 & Windows 11 (x64)  
**Binary Architecture:** x86_64-pc-windows-msvc  

---

### Welcome to TORI Download Manager v1.0.0

TORI Download Manager is a high-speed, modern Windows desktop download manager and browser companion built in Rust, Tokio, and Tauri v2.

### Highlights

1. **Lightning-Fast Multi-Segment Engine**
   - Up to 32 concurrent ranged connections per file with exact byte-offset tracking.
   - Dynamic chunk boundary adjustment and zero-byte leakage resume.
   - Crash-proof SQLite WAL checkpoints: downloads resume safely after sudden power loss or application restarts.

2. **Broad Media Streaming Support**
   - Direct download and remuxing for Apple HLS (`.m3u8`) and MPEG-DASH (`.mpd`) video streams.
   - Integrated FFmpeg stream-copy pipeline for audio/video container merging.
   - BitTorrent and magnet link downloading powered by `librqbit`.

3. **Seamless Browser Companion**
   - Manifest V3 Chrome & Microsoft Edge extension with one-click media capture.
   - Automatic local desktop engine discovery with DNS rebinding defenses.
   - Strict media discrimination: filters out ads, tracking iframes, and subtitle files.

4. **Background Persistence & System Tray**
   - Close-to-tray mode keeps downloads active when the main window is hidden.
   - Independent floating Download Toast window with live speed, ETA, and progress ring.
   - Physical Working Set memory optimization reducing resident RAM to under 27 MB when hidden.

5. **Self-Contained Installer & Secure Updates**
   - Offline installer includes all runtime dependencies (FFmpeg, FFprobe, yt-dlp, native host).
   - Cryptographically signed auto-updater with Ed25519 signature verification.
   - Download Safety Guard: updates will never interrupt or restart while active downloads are in progress.

---

### Verification Hashes & Release Integrity

All release assets are signed and verified with SHA-256 cryptographic hashes recorded in `SHA256SUMS.txt`.

