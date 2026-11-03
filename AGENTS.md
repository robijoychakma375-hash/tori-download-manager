# TORI Download Manager — Instructions for Google Antigravity Agent

You are implementing a REAL production-oriented Windows download manager, not a demo. Read `ARCHITECTURE.md` and `IMPLEMENTATION_PLAN.md` before changing any source files.

## Non-negotiables

1. Never claim a module works without an executable build + relevant passing tests. No fake downloads, mocked backend, placeholder 'implemented' status, simulated progress or nonfunctional buttons.
2. Prefer compileable, integrated, incrementally tested code to broad unverified scaffolding. Each phase must leave a runnable application; add one verified capability at a time.
3. Core downloader is Rust/Tokio with a real reusable HTTP client; Tauri UI is a thin frontend, not the download engine.
4. Respect byte-range semantics and exact `Content-Range`, resource validators, file offsets, crash/restart correctness. Safety and data integrity take priority over claimed download speed.
5. Concurrent network requests are async tasks, not necessarily OS threads. Bound global/per-host concurrency, memory buffering, disk write queues and event frequency.
6. SQLite stores metadata and safe checkpoints; `.tdm-part` stores downloaded bytes. Never persist 'complete' before durable data is committed per recovery strategy.
7. Do not attempt to implement all protocols in one pass; use protocol adapters with honest feature status and hard acceptance tests. Do not advertise absent capabilities.
8. HLS/DASH must handle actual manifests and produce playable output. Use FFmpeg on demand when correct native muxing is not implemented; no naive fMP4 concatenation.
9. Chrome/Edge MV3 browser capture must be permission-scoped and use valid Native Messaging. Do not bypass DRM, forge signed URLs, or leak auth headers.
10. Pin compatible crate versions determined from the environment; prefer maintained dependencies; review software licensing and bundled FFmpeg redistributability.
11. Ask approval before destructive operations, overwriting existing user projects, or creating privileged/persistent services. Do not expose machine secrets in reports.
12. Keep tests and status truthful. When blocked, provide the failing command/error and what remains; don't rename 'failed' to 'completed'.

## Mandatory iterative workflow

- Examine the current repo and tools installed (`rustc`, `cargo`, Node/npm, WebView2 and Windows C++ build tools).
- Before coding, produce a concise `PLAN.md` with a specific measurable next milestone.
- Implement the milestone, build, test, fix errors, run tests again.
- Update `IMPLEMENTATION_STATUS.md` with: feature, verified/partial/blocked, test command, observed result, known limitation.
- Report exactly which files were changed, tests executed, output executable location, any errors and next step.
- For development session 1 specifically, deliver a real HTTP download engine and a working Tauri UI connected to it. The CLI/integration harness is for automated testing, not a substitute for the desktop app.

## Initial commands to validate (adapt for environment)

- `cargo fmt --all -- --check`
- `cargo clippy --workspace --all-targets -- -D warnings`
- `cargo test --workspace`
- Frontend typecheck/build via the package manager actually installed
- Tauri desktop development run and Windows release build
- Local HTTP integration tests (include 206, ignored range, restart and ETag change)

Never claim an installer, executable or RAM benchmark exists until the actual build or measurement was performed.
