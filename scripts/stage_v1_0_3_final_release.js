const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const STAGING_DIR = path.join(ROOT, 'release', 'v1.0.3-final');

if (!fs.existsSync(STAGING_DIR)) {
  fs.mkdirSync(STAGING_DIR, { recursive: true });
}

// 1. Files to stage
const filesToStage = [
  {
    src: path.join(ROOT, 'target', 'release', 'bundle', 'nsis', 'TORI Download Manager_1.0.3_x64-setup.exe'),
    dest: 'TORI Download Manager_1.0.3_x64-setup.exe',
  },
  {
    src: path.join(ROOT, 'target', 'release', 'bundle', 'nsis', 'TORI Download Manager_1.0.3_x64-setup.exe.sig'),
    dest: 'TORI Download Manager_1.0.3_x64-setup.exe.sig',
  },
  {
    src: path.join(ROOT, 'target', 'release', 'tori-download-manager-extension-v1.0.3.zip'),
    dest: 'tori-download-manager-extension-v1.0.3.zip',
  },
  {
    src: path.join(ROOT, 'target', 'release', 'tori-download-manager-firefox-v1.0.3.zip'),
    dest: 'tori-download-manager-firefox-v1.0.3.zip',
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

console.log('--- Staging Artifacts to release/v1.0.3-final ---');

const checksums = [];
const stagedFilesMeta = [];

for (const item of filesToStage) {
  if (!fs.existsSync(item.src)) {
    throw new Error(`Source file missing: ${item.src}`);
  }
  const destPath = path.join(STAGING_DIR, item.dest);
  fs.copyFileSync(item.src, destPath);
  const buf = fs.readFileSync(destPath);
  const hash = crypto.createHash('sha256').update(buf).digest('hex').toLowerCase();
  const stat = fs.statSync(destPath);
  checksums.push(`${hash}  ${item.dest}`);
  stagedFilesMeta.push({
    file: item.dest,
    size: stat.size,
    sha256: hash,
  });
  console.log(`Copied: ${item.dest} (${stat.size.toLocaleString()} bytes) -> ${hash}`);
}

// 2. Generate latest.json
const sigContent = fs.readFileSync(path.join(STAGING_DIR, 'TORI Download Manager_1.0.3_x64-setup.exe.sig'), 'utf8').trim();

const updaterManifest = {
  version: "1.0.3",
  notes: "TORI Download Manager v1.0.3 Production Release.\n\n- Fix: Eliminated startup white flash across dark and light theme initializations\n- Fix: Hardened Close-to-Tray and single-instance mutex with 0 duplicate processes\n- Fix: Draggable video overlay with 5px threshold, boundary clamping, and coordinate persistence\n- Fix: Dynamic HTML5/HLS/DASH media detection eliminating false 'Unavailable' state\n- Unified Version Parity across Desktop Engine and Companion Extensions (v1.0.3)\n- Full Third-Party Notices & GPLv3 Compliance",
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": {
      signature: sigContent,
      url: "https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.3/TORI.Download.Manager_1.0.3_x64-setup.exe"
    },
    "windows-x86_64-nsis": {
      signature: sigContent,
      url: "https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.3/TORI.Download.Manager_1.0.3_x64-setup.exe"
    }
  }
};

const latestJsonPath = path.join(STAGING_DIR, 'latest.json');
fs.writeFileSync(latestJsonPath, JSON.stringify(updaterManifest, null, 2) + '\n', 'utf8');
const latestBuf = fs.readFileSync(latestJsonPath);
const latestHash = crypto.createHash('sha256').update(latestBuf).digest('hex').toLowerCase();
checksums.push(`${latestHash}  latest.json`);
stagedFilesMeta.push({
  file: 'latest.json',
  size: latestBuf.length,
  sha256: latestHash
});
console.log(`Generated: latest.json (${latestBuf.length} bytes) -> ${latestHash}`);

// Write SHA256SUMS.txt
fs.writeFileSync(path.join(STAGING_DIR, 'SHA256SUMS.txt'), checksums.join('\n') + '\n', 'utf8');
console.log('Generated SHA256SUMS.txt');

// 3. Build RELEASE_MANIFEST.json
const installerFile = stagedFilesMeta.find(f => f.file.endsWith('.exe'));
const sigFile = stagedFilesMeta.find(f => f.file.endsWith('.sig'));
const crExt = stagedFilesMeta.find(f => f.file.includes('extension-v1.0.3.zip'));
const ffZip = stagedFilesMeta.find(f => f.file.includes('firefox-v1.0.3.zip'));

const headCommit = execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf8' }).trim();

const manifest = {
  manifestVersion: "1.0.0",
  releaseName: "TORI Download Manager v1.0.3 — Production Release Candidate",
  productName: "TORI Download Manager",
  desktopVersion: "1.0.3",
  targetPlatform: "Windows 10 / 11 (x64)",
  packagingFormat: "NSIS x64 Self-Extracting Executable",
  sourceCommit: headCommit,
  sourceBranch: "release/v1.0.3",
  buildTimestamp: new Date().toISOString(),
  toolchain: {
    rustc: "1.98.0",
    cargo: "1.98.0",
    tauriCli: "2.11.4",
    node: "24.18.0",
    npm: "12.0.2",
    msvc: "Visual Studio Build Tools 2022 (MSVC 14.44)",
    windowsSdk: "10.0.26100.0"
  },
  cryptography: {
    authenticodeSigningStatus: "UNSIGNED",
    authenticodeNotice: "Developer preview / Release packaging. Commercial EV Authenticode certificate signing is deferred until public distribution.",
    updaterSigningStatus: "ED25519 SIGNED",
    updaterAlgorithm: "Minisign Ed25519",
    updaterPublicKey: "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IENEQzIzRDhDQzhEQTUzOTcKUldTWFU5cklqRDNDelRBOVAzOSs1L0RXN0FFLy9YWGFJc2NnUStaNktxSkNOQ1ZCeG01MjFTZzQK"
  },
  installerArtifact: {
    filename: installerFile.file,
    sizeBytes: installerFile.size,
    sha256: installerFile.sha256,
    signatureFile: sigFile.file,
    signatureSha256: sigFile.sha256
  },
  browserExtensions: {
    chromiumEdge: {
      filename: crExt.file,
      extensionVersion: "1.0.3",
      manifestVersion: 3,
      sizeBytes: crExt.size,
      sha256: crExt.sha256,
      distributionStatus: "STAGED_ZIP"
    },
    firefox: {
      signedXpiFilename: null,
      signedXpiStatus: "PENDING (Awaiting Mozilla AMO automated or manual signature submission for v1.0.3)",
      unsignedSourceZipFilename: ffZip.file,
      unsignedSourceZipSizeBytes: ffZip.size,
      unsignedSourceZipSha256: ffZip.sha256,
      extensionVersion: "1.0.3",
      manifestVersion: 3,
      geckoId: "tori-download-manager@toridm.org",
      mozillaSignatureStatus: "PENDING_AMO_SUBMISSION",
      distributionStatus: "SOURCE_ZIP_READY"
    }
  },
  bundledComponents: [
    { name: "tori-download-manager.exe", type: "Tauri v2 Desktop Shell & Core Engine", arch: "x64", version: "1.0.3" },
    { name: "tdm-native-host.exe", type: "Multi-Browser Native Messaging Host (Chrome, Edge, Firefox)", arch: "x64", version: "1.0.3" },
    { name: "tdm-cli.exe", type: "Headless CLI Client & Test Harness", arch: "x64", version: "1.0.3" },
    { name: "ffmpeg.exe", type: "Media Processing & Demuxing Tool", version: "7.1-full_build", license: "GPLv3" },
    { name: "ffprobe.exe", type: "Stream Inspector & Format Validator", version: "7.1-full_build", license: "GPLv3" },
    { name: "yt-dlp.exe", type: "Adaptive Media Stream Extractor", version: "2024.10.07", license: "Unlicense" }
  ],
  releaseLimitations: [
    "Commercial EV Authenticode signing is deferred until public distribution.",
    "Firefox official .xpi signing is pending Mozilla AMO API submission; unsigned package is retained for review.",
    "DRM-encrypted media streams are intentionally unsupported in compliance with legal boundaries."
  ]
};

fs.writeFileSync(
  path.join(STAGING_DIR, 'RELEASE_MANIFEST.json'),
  JSON.stringify(manifest, null, 2) + '\n',
  'utf8'
);
console.log('Generated RELEASE_MANIFEST.json');

// 4. Generate RELEASE_NOTES.md
const releaseNotes = `# TORI Download Manager v1.0.3 — Release Notes

**Release Name:** TORI Download Manager v1.0.3 (Production Release Candidate)
**Build Date:** ${new Date().toISOString().split('T')[0]}
**Target Platform:** Windows 10 / Windows 11 (x64)
**Desktop Version:** 1.0.3
**Browser Extension Version:** 1.0.3
**Source Baseline:** \`release/v1.0.3\` (commit \`${headCommit.substring(0, 7)}\`)

---

## Highlights & What's New in v1.0.3

### 1. Startup White Flash Elimination
- Window initialization configured with hidden initial visibility and dark theme hint in Tauri window parameters.
- Synchronous inline styling and DOM dataset theme injection in HTML \`<head>\` executes before the first paint, eliminating the white flash on launch across dark and light themes.
- Tauri \`frontend_ready\` handshake ensures the application window is rendered only after the frontend has completed mounting.

### 2. Close-to-Tray & Single-Instance Mutex Hardening
- Integrated \`tauri-plugin-single-instance\` to ensure seamless OS-level mutex protection.
- Relaunching the application while minimized or hidden in the notification tray restores and focuses the existing window without port conflicts or duplicate background processes.
- Tray context menu actions and minimize-to-tray lifecycle preserved.

### 3. Draggable Browser Video Overlay
- Media download pill overlay now supports smooth pointer dragging across the video player with a 5px movement threshold.
- Position clamping prevents the overlay from being dragged off-screen.
- Normalized relative coordinates are persisted in browser storage and remembered across player redraws.
- Clean distinction between pointer dragging and standard clicking for format menu expansion.

### 4. Dynamic Media Resolution & Recovery
- Resolved media candidate transmission where set-based DOM elements were previously omitted across background message boundaries.
- Added dynamic video lifecycle observers (\`play\`, \`playing\`, \`loadedmetadata\`, \`loadeddata\`) with bounded backoff retries.
- Eliminates false "Unavailable" format state for delayed-load HTML5, HLS, and DASH video players.

### 5. Unified Version Parity & Companion Packages
- Desktop application, companion extension manifests, and workspace crates synchronized to **1.0.3**.
- Chromium/Edge MV3 companion extension package staged as \`tori-download-manager-extension-v1.0.3.zip\`.
- Firefox MV3 extension package staged as \`tori-download-manager-firefox-v1.0.3.zip\`.

---

## Checksums

See \`SHA256SUMS.txt\` for cryptographic hashes of all staged release artifacts.
`;

fs.writeFileSync(path.join(STAGING_DIR, 'RELEASE_NOTES.md'), releaseNotes, 'utf8');
console.log('Generated RELEASE_NOTES.md');

// 5. Generate INSTALLATION_AND_UPGRADE_NOTES.md
const upgradeNotes = `# TORI Download Manager v1.0.3 — Installation & Upgrade Instructions

## Package Location: \`release/v1.0.3-final/\`

### Package Files
1. \`TORI Download Manager_1.0.3_x64-setup.exe\` — Self-contained Windows x64 NSIS installer (~117 MB).
2. \`TORI Download Manager_1.0.3_x64-setup.exe.sig\` — Ed25519 Minisign updater signature.
3. \`tori-download-manager-extension-v1.0.3.zip\` — Chromium / Microsoft Edge Manifest V3 extension package.
4. \`tori-download-manager-firefox-v1.0.3.zip\` — Firefox Manifest V3 source/package.
5. \`latest.json\` — Staged in-app updater manifest for v1.0.3.
6. \`LICENSE\` — MIT License.
7. \`LICENSE-THIRD-PARTY.txt\` — Open source license notices for bundled tools.
8. \`LICENSE-GPLv3.txt\` — Complete GNU GPLv3 license text.
9. \`SHA256SUMS.txt\` — Cryptographic checksums.
10. \`RELEASE_MANIFEST.json\` — Machine-readable release metadata.

---

## Fresh Installation
1. Run \`TORI Download Manager_1.0.3_x64-setup.exe\`.
2. SmartScreen notice: Click **More info** -> **Run anyway**.
3. Complete setup wizard. Default path: \`%LOCALAPPDATA%\\Programs\\TORI Download Manager\`.

## In-Place Upgrade from v1.0.0, v1.0.1, or v1.0.2
1. Close existing TORI Download Manager instances completely via System Tray -> Exit.
2. Run \`TORI Download Manager_1.0.3_x64-setup.exe\` without uninstalling the previous version.
3. User settings, SQLite database (\`tdm_storage.sqlite\`), and completed download history are safely preserved.
`;

fs.writeFileSync(path.join(STAGING_DIR, 'INSTALLATION_AND_UPGRADE_NOTES.md'), upgradeNotes, 'utf8');
console.log('Generated INSTALLATION_AND_UPGRADE_NOTES.md');

console.log(`\n=== v1.0.3 Staging Complete: ${checksums.length} files staged ===`);
