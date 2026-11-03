# TORI Download Manager (TDM) — Unified Engine Architecture v2.0

Status: **Engineering specification; NOT an implemented or tested application.**
Target: Windows 10/11 x64, low idle overhead, robust downloads, modern Tauri 2 + React UI, MV3 Chrome/Edge extension.
Design goals: real downloads from the first executable, safe resume and crash recovery, transparent protocol support, no mock progress or fabricated capabilities.

## 1. System architecture

```text
Chrome/Edge MV3 Extension          Desktop UI                 Optional Local API (off by default)
             |                        |                              |
     Native Messaging Host     Tauri IPC commands           Authenticated IPC
             \                        |                             /
              +------------------ Task Intake ----------------------+
                                      |
                         URL, metadata, policy validation
                                      |
                        Persistent Job Store (SQLite)
                                      |
                     Priority / Fairness Queue Scheduler
                                      |
                         Protocol Detection + Router
                  +-------------------+--------------------+
                  |                   |                    |
       HTTP File Adapter    HLS/DASH Segment Adapters   Live / Torrent Adapters
                  |                   |                    |
        Shared HTTP Transport     Shared HTTP Transport   FFmpeg / librqbit
         & connection pools        & connection pools        (on demand)
                  \                   /
                 Range / Segment Planning
                           |
            Adaptive Permit Manager + Pending-Work Queue
                           |
                Bounded Network Async Tasks
                           |
             Validated Writes at Explicit File Offsets
                           |
                     .tdm-part files
                           |
               Integrity / Completeness Verification
                           |
             Optional Mux / Stream-Copy Processing
                           |
                  Atomic Final-File Publication
                           |
                       Completed

SQLite: authoritative task states and checkpoints, not media byte storage.
Event bus: emits state/progress/diagnostics to UI, extension, logs. Events are NOT the source of truth.
Resource governor: global/per-host connections, network limits, memory limits, disk write backlog, CPU/process budget.
```

## 2. Engineering decisions

| Component | Choice | Rationale |
| --- | --- | --- |
| Desktop | Tauri 2 + React/TypeScript + Vite | Compact installed app, modern UI, native commands |
| Core | Rust + Tokio | Memory-safety, efficient async network tasks |
| HTTP | Reused reqwest clients with HTTP/1.1 and HTTP/2 | Pooling, TLS, redirects, proxy support |
| HTTP/3 | Opt-in adapter only after compatibility and interoperability tests | HTTP/3 support may require unstable/feature-gated APIs; MUST NOT claim it works without test |
| Metadata | SQLite WAL with schema migrations | Durable task state, checks and history |
| File bytes | Direct file-offset writer into .tdm-part | No file blobs in SQLite; bounded buffers |
| Browser | Manifest V3 + webRequest observation + Native Messaging | Request candidates delivered to host with permission checks |
| HLS/DASH | Native manifest parser + ordered segment scheduler | Custom orchestration; no fake stream parsing |
| Mux/remux | Safe native fast path only for verified cases; FFmpeg on demand otherwise | fMP4/audio-video sync/discontinuities cannot be treated as naive byte concatenation |
| Live streams | FFmpeg protocol adapters with actual build capability checks | RTSP/RTMP/MMS/RTP/UDP/SRT/RIST have protocol-specific needs |
| Torrent | `librqbit` library adapter, validated against current crate version | Reuse proven peer/protocol and piece-verification implementation |
| Process model | Start with one resident engine/Tauri process (tray keeps it running); tiny Native Messaging helper | Avoid multiple heavy resident processes; benchmark before optional split |
| UI events | Bounded/coalesced progress events | Avoid progress event floods and busy polling |

## 3. Download job model

JobType: `HttpFile`, `HlsVod`, `HlsLive`, `DashVod`, `DashLive`, `LiveCapture`, `Torrent`.

State machine: `Created -> Probing -> Queued -> Downloading -> Verifying -> [Processing] -> Completed`; explicit branches to `Pausing -> Paused`, `RetryWait`, `Failed`, and `Cancelled`. Transitions are validated and persisted.

Job metadata: ID, source URL/redacted source details, final target and temporary path, job type, priority, chosen protocol/variant, expected length (optional), ETag (strong/weak indication), Last-Modified, resolved URL, content encoding, checkpoint generation, retry and error details, timestamps, status. Keep secrets out of logs and plaintext DB where feasible; use scoped short-lived credentials/Windows credential facilities where necessary.

## 4. HTTP probe, resume and validation

1. Validate the URL and filename/path; use HTTPS defaults and secure redirect policy.
2. Attempt HEAD for content length, validators, range hints; HEAD is NOT required and may lie/fail.
3. If necessary, use GET `Range: bytes=0-0` (with `Accept-Encoding: identity`) and inspect actual 206 + `Content-Range`. Do not rely on `Accept-Ranges` alone.
4. Only partition a known-length resource with verified byte-range support and stable identity. A plain 200 or unknown length uses a single streaming task.
5. For every 206 response, validate requested range, content-range, total size, content encoding, and expected asset identity. Handle 200/206/416, redirects, timeouts, 403/429/5xx, changed ETag and retry budgets explicitly.
6. On resume, validate representation identity and resource size. Use standards-compliant If-Range with a *strong* entity tag or suitable date; do not use weak ETags as strong validators. On mismatch invalidate stale ranges and restart safely.
7. Write only verified range offsets into `.tdm-part`, keep outstanding buffers bounded; allocate write ownership to prevent overlap. Never download compressed transferred bytes into uncompressed offsets.
8. Persist ranges only after the corresponding file data has been safely acknowledged/flushed per checkpoint policy. A SQLite commit by itself does NOT mean the target file bytes are durable.
9. On startup, reconcile SQLite state with temporary-file existence, length and metadata, and revalidate suspicious/incomplete ranges. Crash tests must prove no false completion.
10. Completion requires complete coverage of expected ranges or clean end-of-stream for unknown length, successful output validation, optional known checksum comparison, then final rename (with Windows destination/replace policy). A local SHA-256 without a trusted expected digest DOES NOT prove the source is correct.

## 5. Adaptive concurrency and download-level work redistribution

Terminology: `connections`, `async tasks` and OS `threads` are distinct. Tokio's runtime already implements **task-scheduler work stealing**. TDM needs **range work redistribution**, which is a separate design.

Initial working heuristic (not a proven optimum): unknown/small files use one connection; medium files start with 2-4; large files start with 4-8; optional ceiling 16 only after benchmarking and user configuration. Never force 16-32 connections based solely on size.

Inputs: observed useful bytes/sec per task and per host, RTT/timeout/error rate, server throttling/429, 206 compliance, CPU, active jobs, memory/disk pressure, and throughput gain per connection. Prefer bounded AIMD-style tuning: cautiously increase when justified, decrease on throttling/errors or diminishing returns. Implement hysteresis and a minimum observation window to prevent oscillation.

Partition into small, non-overlapping **pending ranges**, assign leases with explicit ownership; fast workers take more pending ranges. Optional straggler splitting ONLY after safely cancelling/acknowledging a running lease and guaranteeing no overlapping active writes. Do not have workers concurrently overwrite the same offsets. Prevent starvation across user jobs with global and per-host limits.

## 6. Direct writing and checkpoint consistency

Use a dedicated bounded write pipeline with explicit offsets (e.g. platform-specific positional writes or a serialized writer). Do not share a seek pointer across independent concurrent workers. Batch progress writes and SQLite commits. For recovery, use a generation/lease record and a checkpoint protocol where durable byte data precedes publishing completed-range metadata. Add configurable checkpoint frequency with honest power-loss durability semantics. Handle disk full, permission changes, antivirus locks and rename conflicts.

SQLite uses WAL and migration-managed schema. Avoid holding transactions open during network I/O. Protect against unbounded WAL growth with appropriate checkpoint policy and short-lived readers.

## 7. Protocol adapters and scope

**Direct files:** mp4, webm, mkv, mov, avi, flv, ts, m2ts, mp3, aac, m4a, flac, ogg, opus, wmv, asf, wav, subtitles srt/vtt: direct HTTP download is container-agnostic; do NOT imply decoding support is required. `.m3u` may be a playlist, not necessarily an HLS master playlist.

**HLS:** parse master/media playlists, selected variant and audio rendition, segment sequence/byterange, init map (`EXT-X-MAP`), discontinuity, subtitles, live playlist refresh and end-list. HLS AES-128 where legitimately accessible may be supported; DRM systems are not bypassed. Default to automatic variant selection and immediate download—do not force a quality picker or slow format scan in the normal workflow.

**DASH:** parse MPD Periods, AdaptationSets, Representations, SegmentTemplate/Timeline/List/Base, segment initialization, separate audio/video tracks, live availability when applicable; verify produced duration/streams. Never claim universal MPD capability from a simplistic parser.

**Native merge:** allow only independently validated safe cases (e.g. compatible TS sequential handling); fMP4 initialization, sample timing, track offsets and multiperiod synchronization require correct ISO-BMFF muxing. Prefer an on-demand FFmpeg stream-copy remux for complex media. Thumbnail extraction/metadata editing are opt-in, off the hot download path.

**Live streaming:** FFmpeg adapters for RTSP, RTMP, MMS, UDP, RTP, SRT, RIST as actually available in the installed/bundled build, plus format/container compatibility and recording duration/stop settings. Live recording is not ordinary resume. Distinguish `.srt` subtitles from SRT transport protocol.

**Torrent:** integrate a validated library (candidate: librqbit) with metadata resolution, piece verification, limits, pause/resume, file selection and user-approved seeding policy; map events to the shared job system.

## 8. Browser extension and local IPC security

Chrome/Edge Manifest V3 extension monitors only permitted requests, classifies URL/content-type/manifest candidates, deduplicates by actual media identity, and forwards explicitly user-authorized or configured auto-capture tasks. Native Messaging goes extension service worker -> native host helper -> local authenticated IPC -> job manager. Validate sender and origin, narrow host permissions and reject untrusted commands. Credentials/cookies/Authorization headers must not be dumped into logs or passed to other origins; use scoped handling and obtain permission. Some MSE blob/EME/DRM streams cannot be resolved or downloaded. UI must show unsupported conditions truthfully.

For engine background behavior, closing the window to system tray leaves the app process running; an explicit Quit stops downloads after graceful checkpoint. A standalone daemon is optional, subject to benchmark, not automatic architectural dogma.

## 9. Networking advanced features (delayed until proven useful)

- HTTP proxy/SOCKS5 can be part of a subsequent verified version; per-profile proxy/cert handling and credential safety are mandatory.
- HTTP/3 is isolated behind a feature flag and falls back to verified HTTP/2 or HTTP/1.1; currently reqwest HTTP/3 interfaces are feature-/unstable-gated in official docs.
- DoH, DNS benchmarking, mirror racing and automatic failover are not prerequisites for the first production build.
- Only race mirrors verified to serve identical bytes/asset identity. Never blindly combine ranges from unrelated CDN URLs.

## 10. Verification, performance and honesty

No mock backend, fake progress, or hardcoded completion. Each feature is either `verified`, `partial`, `unsupported` or `blocked`, backed by a recorded test. Keep `IMPLEMENTATION_STATUS.md` in the actual project.

Required integration tests: HTTP 200/206/416, ignored range, changed ETag and Last-Modified, redirects, 403/429/5xx, compression, content-length mismatch, disconnect, killed process/power-loss approximation, pause/resume, low disk, concurrent overlapping ranges, no corrupted output; then HLS TS and fMP4, DASH separate audio/video, live adapters and public legal torrent fixtures as modules are built.

Measure (do not invent) idle working set, private bytes, peak RAM during 1/4/8 simultaneous tasks, CPU, throughput and completion correctness, with identical URLs/disk/server conditions and a baseline. Use observed performance, not theoretical concurrency counts, to tune defaults.

Reference specs and docs: RFC 9110 (range semantics), RFC 8216 (HLS), Chrome Manifest V3 webRequest and Native Messaging docs, SQLite WAL docs, Tokio runtime docs, reqwest docs, FFmpeg formats/protocols docs and rqbit/librqbit repository.
