#!/usr/bin/env node
/**
 * Stages TORI Download Manager Desktop v1.0.4 Final Release Assets into `release/v1.0.4-final/`
 * Per Gate 26.4 Step 7:
 * - Windows NSIS installer (TORI.Download.Manager_1.0.4_x64-setup.exe)
 * - Valid updater signature (TORI.Download.Manager_1.0.4_x64-setup.exe.sig)
 * - latest.json
 * - SHA256SUMS.txt
 * - Release notes (RELEASE_NOTES.md)
 * - Required licenses (LICENSE, LICENSE-THIRD-PARTY.txt, LICENSE-GPLv3.txt)
 * - Installation and upgrade instructions (INSTALLATION_AND_UPGRADE_NOTES.md)
 *
 * Strictly excludes duplicate packages and internal test files.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const STAGING_DIR = path.join(ROOT, 'release', 'v1.0.4-final');

if (fs.existsSync(STAGING_DIR)) {
  fs.rmSync(STAGING_DIR, { recursive: true, force: true });
}
fs.mkdirSync(STAGING_DIR, { recursive: true });

const nsisExeSrc = path.join(
  ROOT,
  'target',
  'release',
  'bundle',
  'nsis',
  'TORI Download Manager_1.0.4_x64-setup.exe'
);
const nsisSigSrc = path.join(
  ROOT,
  'target',
  'release',
  'bundle',
  'nsis',
  'TORI Download Manager_1.0.4_x64-setup.exe.sig'
);

const filesToStage = [
  {
    src: nsisExeSrc,
    dest: 'TORI.Download.Manager_1.0.4_x64-setup.exe',
  },
  {
    src: nsisSigSrc,
    dest: 'TORI.Download.Manager_1.0.4_x64-setup.exe.sig',
  },
  {
    src: path.join(ROOT, 'LICENSE'),
    dest: 'LICENSE',
  },
  {
    src: path.join(ROOT, 'resources', 'LICENSE-THIRD-PARTY.txt'),
    dest: 'LICENSE-THIRD-PARTY.txt',
  },
  {
    src: path.join(ROOT, 'resources', 'LICENSE-GPLv3.txt'),
    dest: 'LICENSE-GPLv3.txt',
  },
];

console.log('--- Staging Final v1.0.4 Artifacts to release/v1.0.4-final ---');

const checksums = [];
const stagedFilesMeta = [];

function recordStagedFile(destName) {
  const destPath = path.join(STAGING_DIR, destName);
  const buf = fs.readFileSync(destPath);
  const hash = crypto.createHash('sha256').update(buf).digest('hex').toLowerCase();
  const stat = fs.statSync(destPath);
  checksums.push(`${hash}  ${destName}`);
  stagedFilesMeta.push({
    file: destName,
    size: stat.size,
    sha256: hash,
  });
  console.log(`Staged: ${destName} (${stat.size.toLocaleString()} bytes) -> ${hash}`);
}

for (const item of filesToStage) {
  if (!fs.existsSync(item.src)) {
    throw new Error(`Source file missing: ${item.src}`);
  }
  const destPath = path.join(STAGING_DIR, item.dest);
  fs.copyFileSync(item.src, destPath);
  recordStagedFile(item.dest);
}

// Generate latest.json
const sigContent = fs
  .readFileSync(path.join(STAGING_DIR, 'TORI.Download.Manager_1.0.4_x64-setup.exe.sig'), 'utf8')
  .trim();

const updaterManifest = {
  version: '1.0.4',
  notes:
    'TORI Download Manager v1.0.4 Production Stability & Large-File Engine Update.\n\n' +
    '- Fix: Instant NTFS sparse file allocation (FSCTL_SET_SPARSE) for 1 GB to 50+ GB downloads with zero pre-allocation stall\n' +
    '- Fix: 256 KiB buffered worker writes, bounded straggler tail-splitting, and Presigned CDN (S3/R2/CloudFront) concurrency cap\n' +
    '- Fix: 4-second HEAD probe timeout with automatic GET Range: bytes=0-0 fallback and first-byte transition to Downloading\n' +
    '- Fix: Server-side in-flight and recent-URL browser handoff deduplication eliminating duplicate (1) downloads across Firefox & Chromium\n' +
    '- Fix: Windows Job Object breakaway (CREATE_BREAKAWAY_FROM_JOB | DETACHED_PROCESS) preventing unexpected exit after Native Host spawn\n' +
    '- Fix: Synchronized Close-to-Tray lifecycle with background download continuation, Tray restoration, and explicit Exit support',
  pub_date: new Date().toISOString(),
  platforms: {
    'windows-x86_64': {
      signature: sigContent,
      url: 'https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.4/TORI.Download.Manager_1.0.4_x64-setup.exe',
    },
    'windows-x86_64-nsis': {
      signature: sigContent,
      url: 'https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.4/TORI.Download.Manager_1.0.4_x64-setup.exe',
    },
  },
};

fs.writeFileSync(
  path.join(STAGING_DIR, 'latest.json'),
  JSON.stringify(updaterManifest, null, 2) + '\n',
  'utf8'
);
recordStagedFile('latest.json');

const headCommit = execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf8' }).trim();

const releaseNotes = `# TORI Download Manager v1.0.4 — Release Notes

**Release Name:** TORI Download Manager v1.0.4 (Desktop Stability & Large-File Update)
**Build Date:** ${new Date().toISOString().split('T')[0]}
**Target Platform:** Windows 10 / Windows 11 (x64)
**Desktop Version:** 1.0.4
**Compatible Browser Companion:** v1.0.5 (Published) / v1.0.6-rc
**Source Baseline:** \`release/v1.0.4\` (commit \`${headCommit.substring(0, 7)}\`)

---

## Highlights & Production Fixes in v1.0.4

### 1. Large-File Multi-Gigabyte Engine Stability (100 MB to 50+ GB)
- **Instant Sparse Allocation:** Files \`>= 64 MiB\` enable Windows NTFS \`FSCTL_SET_SPARSE\` (\`0x000900C4\`) before \`set_len()\`, eliminating multi-gigabyte zero-fill disk stalls on 1 GB, 4.5 GB, 10 GB, and 50+ GB downloads.
- **256 KiB Buffered Worker Writes & Throttled Checkpoints:** Coalesces network stream packets into 256 KiB write buffers with 4 MiB / 1s SQLite WAL checkpoints and 16 MiB / 2s async disk syncs.
- **Straggler Tail-Split Boundary Clamping:** Synchronizes live atomic worker progress before straggler evaluation and strictly clamps buffered writes to split chunk bounds.
- **Presigned CDN Anti-Throttling:** Automatically caps initial concurrency at 4 workers and disables aggressive mid-stream splitting for signed S3/R2/CloudFront/B2 URLs, with automatic HTTP 429/503 exponential backoff.
- **Hung HEAD Probe Fallback:** Enforces a 4-second timeout on \`HEAD\` probes with automatic fallback to \`GET Range: bytes=0-0\`, transitioning from \`Starting\` to \`Downloading\` only when the first payload byte is written.

### 2. Browser Handoff Deduplication (Firefox & Chromium)
- **In-Flight & Recent-URL Coalescing:** Deduplicates concurrent HTTP and Native Messaging fallback handoffs on the server side so slow upstream probes never spawn duplicate \`filename (1).ext\` tasks.
- **Session Header Preservation:** Preserves \`Referer\` and \`User-Agent\` across both probe and Range worker requests.

### 3. Windows Job Object Process Survival
- **Breakaway Process Creation:** \`tdm-native-host.exe\` spawns \`tori-download-manager.exe --minimized\` with \`CREATE_BREAKAWAY_FROM_JOB | CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS\`, preventing Firefox/Chromium from terminating the desktop app when the short-lived Native Messaging host exits.

### 4. Close-to-Tray & Lifecycle Synchronization
- **Synchronized Close-to-Tray State:** Keeps the Rust \`close_to_tray_enabled\` atomic state synchronized with UI settings at startup and runtime.
- **Background Engine Continuation:** Clicking \`X\` with Close-to-Tray enabled hides the main window to the system tray while active downloads continue uninterrupted in the background.

---

## Checksums

See \`SHA256SUMS.txt\` for SHA-256 hashes of all release assets.
`;

fs.writeFileSync(path.join(STAGING_DIR, 'RELEASE_NOTES.md'), releaseNotes, 'utf8');
recordStagedFile('RELEASE_NOTES.md');

const upgradeNotes = `# TORI Download Manager v1.0.4 — Installation & Upgrade Instructions

## Release Assets (\`release/v1.0.4-final/\`)

1. \`TORI.Download.Manager_1.0.4_x64-setup.exe\` — Self-contained Windows x64 NSIS installer.
2. \`TORI.Download.Manager_1.0.4_x64-setup.exe.sig\` — Ed25519 Minisign updater signature (Key ID: \`CDC23D8CC8DA5397\`).
3. \`latest.json\` — Tauri v2 in-app auto-updater manifest.
4. \`SHA256SUMS.txt\` — SHA-256 checksum manifest.
5. \`RELEASE_NOTES.md\` — Production changelog for Desktop v1.0.4.
6. \`LICENSE\` — MIT License.
7. \`LICENSE-THIRD-PARTY.txt\` — Third-party notices for bundled tools (FFmpeg, yt-dlp).
8. \`LICENSE-GPLv3.txt\` — GNU General Public License v3 text.

---

## Fresh Installation (Windows 10 / 11 x64)
1. Download and run \`TORI.Download.Manager_1.0.4_x64-setup.exe\`.
2. If Windows SmartScreen appears, click **More info** -> **Run anyway**.
3. Follow the installer prompts. Companion binaries (\`tdm-native-host.exe\`, \`tdm-cli.exe\`, \`ffmpeg.exe\`, \`ffprobe.exe\`, \`yt-dlp.exe\`) and browser Native Messaging host manifests are configured automatically.

## In-Place Upgrade from v1.0.0, v1.0.1, v1.0.2, or v1.0.3
1. Either use **Settings -> About -> Check for Updates** inside TORI Download Manager, or run \`TORI.Download.Manager_1.0.4_x64-setup.exe\` directly over your existing installation.
2. Existing user settings, completed download history (\`tdm_storage.sqlite\`), and resumable partial downloads (\`.tdm-part\`) are preserved automatically.
`;

fs.writeFileSync(
  path.join(STAGING_DIR, 'INSTALLATION_AND_UPGRADE_NOTES.md'),
  upgradeNotes,
  'utf8'
);
recordStagedFile('INSTALLATION_AND_UPGRADE_NOTES.md');

fs.writeFileSync(path.join(STAGING_DIR, 'SHA256SUMS.txt'), checksums.join('\n') + '\n', 'utf8');
console.log('Generated SHA256SUMS.txt');
console.log(`\n=== v1.0.4 Final Staging Complete: ${checksums.length} files staged ===`);

