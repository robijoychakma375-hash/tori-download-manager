# TORI Download Manager â€” Release Notes

## TORI Download Manager v1.0.1

**Release Name:** TORI Download Manager v1.0.1 (Latest Stable)
**Build Date:** 2026-11-10
**Target Platform:** Windows 10 / Windows 11 (x64)
**Desktop Version:** 1.0.1
**Browser Extension Version:** 1.0.2
**Source Baseline:** `dev/v1.0.1` (commit `48d083d`)

---

### Highlights & What's New in v1.0.1

#### 1. Close-to-Tray & System Tray Controls
- **TitleBar Close (X) Behavior:** Clicking the main window's Close button now hides the application to the Windows System Tray instead of terminating the process.
- **Background Continuity:** In-flight downloads, queue transitions, scheduler alarms, and browser integration (Local API on 6800/7070 and Native Messaging IPC) remain operational in the background.
- **System Tray Operations:** Tray menu includes **Show TORI**, **Hide TORI**, live active download counter, **Pause All**, **Resume All**, and **Exit TORI**.
- **Exit Protection:** If active downloads are running, clicking Exit triggers a native warning dialog before downloads are paused and the process cleanly shuts down.
- **Window State Separation:** Minimize (`-`) minimizes to the Windows Taskbar; Close (`X`) hides to the System Tray.

#### 2. Official Mozilla-Signed Firefox Extension (v1.0.2)
- **Officially Signed by Mozilla AMO:** Packaged as `tori-download-manager-firefox-v1.0.2.xpi` (SHA256: `520424ff38ddb1bf84152e7fd3c9bf4678ce6af1542995a6d4b58c4dc4fbb8d0`).
- Permanent installation supported in production Mozilla Firefox release channels with signature enforcement enabled.
- Developer unminified package preserved as `tori-download-manager-firefox-v1.0.2.zip` for source code inspection.

#### 3. Cross-Browser Media Detection & Generic Download Interception
- **Generic Download Capture:** Automatically intercepts ISO, ZIP, RAR, 7Z, EXE, PDF, MKV, MP4, no-extension URLs, and 302 redirects in both Firefox and Edge/Chrome.
- **Download Shelf History Preservation:** Preserves browser download shelf entries with informative status; eliminates destructive `chrome.downloads.erase()`.
- **Dangerous File Warning Respect:** Respects browser native security flags without hijacking dangerous or suspicious files.
- **Safe Offline Fallback:** If TORI Desktop is closed or unreachable, downloads proceed uninterrupted in the browser.

#### 4. Dailymotion Video Player Overlay Improvements
- **Zero Playback Hijacking:** Comprehensive event isolation (`pointerdown`, `pointerup`, `mousedown`, `mouseup`, `click`, `dblclick`) prevents the video player from pausing or seeking when clicking the TORI download trigger.
- **Transport Bar Clearance:** Positioned with a fixed `56px` bottom margin and constrained to `max-content` dimensions so player controls remain fully interactive.
- **User Acceptance Verified:** Passed 5/5 manual user QA acceptance checks on live Dailymotion streams.

#### 5. BitTorrent / Magnet Probing & Resilience
- **Probing State Emission:** Unseeded or resolving magnet links immediately emit `JobState::Probing` with status *"Connecting to peers and retrieving metadata..."* instead of stalling at 0%.
- **60-Second Metadata Timeout:** Enforces a clean 60-second resolution timeout for unseeded or network-restricted swarms, failing gracefully rather than hanging indefinitely.
- **Verified Protocol Engine:** 100% byte-for-byte piece transfer verification in local seeder/leecher unit test suites.

#### 6. Bundled Production Tooling & Licensing
- Bundles `ffmpeg.exe` (7.1-full_build), `ffprobe.exe` (7.1-full_build), `yt-dlp.exe` (2024.10.07), and multi-browser `tdm-native-host.exe`.
- Complete GNU GPLv3 license text provided in `LICENSE-GPLv3.txt`.
- Third-party notices and corresponding source checkout instructions in `LICENSE-THIRD-PARTY.txt`.

---

## TORI Download Manager v1.0.0 (Historical)

**Release Date:** 2026-11-06
**Target Platform:** Windows 10 & Windows 11 (x64)
**Binary Architecture:** x86_64-pc-windows-msvc

### Highlights in v1.0.0

1. **Multi-Segment Engine:** Up to 32 concurrent ranged connections per file with exact byte-offset tracking and crash-proof SQLite WAL checkpoints.
2. **Media Streaming Support:** Direct download and remuxing for Apple HLS (`.m3u8`) and MPEG-DASH (`.mpd`) video streams.
3. **Browser Companion:** Manifest V3 Chrome & Microsoft Edge extension with one-click media capture.
4. **Background Persistence & System Tray:** Close-to-tray mode, independent floating Download Toast, physical Working Set memory optimization.
5. **Self-Contained Installer & Secure Updates:** Offline installer with bundled runtime dependencies, Ed25519-signed auto-updater.
