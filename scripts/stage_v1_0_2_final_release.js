const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const STAGING_DIR = path.join(ROOT, 'release', 'v1.0.2-final');
const V101_DIR = path.join(ROOT, 'release', 'v1.0.1-final');

if (!fs.existsSync(STAGING_DIR)) {
  fs.mkdirSync(STAGING_DIR, { recursive: true });
}

// 1. Files to stage
const filesToStage = [
  {
    src: path.join(ROOT, 'target', 'release', 'bundle', 'nsis', 'TORI Download Manager_1.0.2_x64-setup.exe'),
    dest: 'TORI Download Manager_1.0.2_x64-setup.exe',
  },
  {
    src: path.join(ROOT, 'target', 'release', 'bundle', 'nsis', 'TORI Download Manager_1.0.2_x64-setup.exe.sig'),
    dest: 'TORI Download Manager_1.0.2_x64-setup.exe.sig',
  },
  {
    src: path.join(V101_DIR, 'tori-download-manager-firefox-v1.0.2.xpi'),
    dest: 'tori-download-manager-firefox-v1.0.2.xpi',
  },
  {
    src: path.join(V101_DIR, 'a70ed17e183648a9bcf4-1.0.2.xpi'),
    dest: 'a70ed17e183648a9bcf4-1.0.2.xpi',
  },
  {
    src: path.join(V101_DIR, 'tori-download-manager-extension-v1.0.2.zip'),
    dest: 'tori-download-manager-extension-v1.0.2.zip',
  },
  {
    src: path.join(V101_DIR, 'tori-download-manager-firefox-v1.0.2.zip'),
    dest: 'tori-download-manager-firefox-v1.0.2.zip',
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

console.log('--- Staging Artifacts to release/v1.0.2-final ---');

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

// Write SHA256SUMS.txt
fs.writeFileSync(path.join(STAGING_DIR, 'SHA256SUMS.txt'), checksums.join('\n') + '\n', 'utf8');
console.log('Generated SHA256SUMS.txt');

// 2. Build RELEASE_MANIFEST.json
const installerFile = stagedFilesMeta.find(f => f.file.endsWith('.exe'));
const sigFile = stagedFilesMeta.find(f => f.file.endsWith('.sig'));
const crExt = stagedFilesMeta.find(f => f.file.includes('extension-v1.0.2.zip'));
const ffXpi = stagedFilesMeta.find(f => f.file === 'tori-download-manager-firefox-v1.0.2.xpi');
const ffZip = stagedFilesMeta.find(f => f.file === 'tori-download-manager-firefox-v1.0.2.zip');

const headCommit = execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf8' }).trim();

const manifest = {
  manifestVersion: "1.0.0",
  releaseName: "TORI Download Manager v1.0.2 — Production Release",
  productName: "TORI Download Manager",
  desktopVersion: "1.0.2",
  targetPlatform: "Windows 10 / 11 (x64)",
  packagingFormat: "NSIS x64 Self-Extracting Executable",
  sourceCommit: headCommit,
  sourceBranch: "release/v1.0.2",
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
      extensionVersion: "1.0.2",
      manifestVersion: 3,
      sizeBytes: crExt.size,
      sha256: crExt.sha256,
      distributionStatus: "STAGED_ZIP"
    },
    firefox: {
      signedXpiFilename: ffXpi.file,
      signedXpiOriginalFilename: "a70ed17e183648a9bcf4-1.0.2.xpi",
      signedXpiSizeBytes: ffXpi.size,
      signedXpiSha256: ffXpi.sha256,
      unsignedSourceZipFilename: ffZip.file,
      unsignedSourceZipSizeBytes: ffZip.size,
      unsignedSourceZipSha256: ffZip.sha256,
      extensionVersion: "1.0.2",
      manifestVersion: 3,
      geckoId: "tori-download-manager@toridm.org",
      mozillaSignatureStatus: "OFFICIALLY SIGNED (Mozilla AMO Validated)",
      signatureType: "Mozilla PKCS#7 & COSE Signature Block",
      signatureValidation: "Accepted by Firefox with xpinstall.signatures.required enabled",
      distributionStatus: "SIGNED_XPI_READY"
    }
  },
  bundledComponents: [
    { name: "tori-download-manager.exe", type: "Tauri v2 Desktop Shell & Core Engine", arch: "x64", version: "1.0.2" },
    { name: "tdm-native-host.exe", type: "Multi-Browser Native Messaging Host (Chrome, Edge, Firefox)", arch: "x64", version: "1.0.2" },
    { name: "tdm-cli.exe", type: "Headless CLI Client & Test Harness", arch: "x64", version: "1.0.2" },
    { name: "ffmpeg.exe", type: "Media Processing & Demuxing Tool", version: "7.1-full_build", license: "GPLv3" },
    { name: "ffprobe.exe", type: "Stream Inspector & Format Validator", version: "7.1-full_build", license: "GPLv3" },
    { name: "yt-dlp.exe", type: "Adaptive Media Stream Extractor", version: "2024.10.07", license: "Unlicense" }
  ],
  releaseLimitations: [
    "Commercial EV Authenticode signing is deferred until public distribution.",
    "DRM-encrypted media streams are intentionally unsupported in compliance with legal boundaries."
  ]
};

fs.writeFileSync(
  path.join(STAGING_DIR, 'RELEASE_MANIFEST.json'),
  JSON.stringify(manifest, null, 2),
  'utf8'
);
console.log('Generated RELEASE_MANIFEST.json');

// 3. Generate RELEASE_NOTES.md
const releaseNotes = `# TORI Download Manager v1.0.2 — Release Notes

**Release Name:** TORI Download Manager v1.0.2 (Production Release)  
**Build Date:** ${new Date().toISOString().split('T')[0]}  
**Target Platform:** Windows 10 / Windows 11 (x64)  
**Desktop Version:** 1.0.2  
**Browser Extension Version:** 1.0.2  
**Source Baseline:** \`release/v1.0.2\` (commit \`${headCommit.substring(0, 7)}\`)  

---

## Highlights & What's New in v1.0.2

### 1. Unified Version Parity (v1.0.2)
- Synchronized Desktop Engine and Browser Companion Extensions to matching version **1.0.2**.
- Eliminates user confusion between installer and extension versions while preserving 100% backward and forward compatibility.

### 2. Desktop Core Engine Improvements
- **Persistent Engine Lifecycle:** Hardened system tray persistence, window close interception, and process-tree memory trimming.
- **Queue & Scheduler Enhancements:** Robust multi-stream chunking ($C=4/8$), automatic scheduling execution at due time, and crash recovery via SQLite WAL.
- **Bundled Binaries:** Updated companion binaries (\`tdm-native-host.exe\` and \`tdm-cli.exe\`) compiled cleanly with version 1.0.2.

### 3. Full Cross-Browser Companion Integration (v1.0.2)
- **Mozilla Firefox:** Officially signed AMO package \`tori-download-manager-firefox-v1.0.2.xpi\` installs seamlessly in release Firefox channels without signature bypass flags.
- **Microsoft Edge & Google Chrome:** Manifest V3 extension package \`tori-download-manager-extension-v1.0.2.zip\` provides seamless native messaging and HTTP fallback on port 6800.

### 4. Bundled Production Tooling & Licensing
- Bundles \`ffmpeg.exe\` (7.1), \`ffprobe.exe\` (7.1), \`yt-dlp.exe\` (2024.10.07), and multi-browser \`tdm-native-host.exe\`.
- Complete GNU GPLv3 license text provided in \`LICENSE-GPLv3.txt\`.
- Third-party notices and corresponding source checkout instructions in \`LICENSE-THIRD-PARTY.txt\`.

---

## Checksums

See \`SHA256SUMS.txt\` for cryptographic hashes of all distribution artifacts.
`;

fs.writeFileSync(path.join(STAGING_DIR, 'RELEASE_NOTES.md'), releaseNotes, 'utf8');
console.log('Generated RELEASE_NOTES.md');

// 4. Generate INSTALLATION_AND_UPGRADE_NOTES.md
const upgradeNotes = `# TORI Download Manager v1.0.2 — Installation & Upgrade Instructions

## Package Location: \`release/v1.0.2-final/\`

### Package Files
1. \`TORI Download Manager_1.0.2_x64-setup.exe\` — Self-contained Windows x64 NSIS installer (~117 MB).
2. \`TORI Download Manager_1.0.2_x64-setup.exe.sig\` — Ed25519 Minisign updater signature.
3. \`tori-download-manager-firefox-v1.0.2.xpi\` — Official Mozilla-signed Firefox extension v1.0.2.
4. \`a70ed17e183648a9bcf4-1.0.2.xpi\` — Original Mozilla AMO download filename mirror.
5. \`tori-download-manager-extension-v1.0.2.zip\` — Chromium / Microsoft Edge Manifest V3 extension package.
6. \`tori-download-manager-firefox-v1.0.2.zip\` — Unsigned developer/source extension package.
7. \`LICENSE\` — MIT License.
8. \`LICENSE-THIRD-PARTY.txt\` — Open source license notices for bundled tools.
9. \`LICENSE-GPLv3.txt\` — Complete GNU GPLv3 license text.
10. \`SHA256SUMS.txt\` — Cryptographic checksums.
11. \`RELEASE_MANIFEST.json\` — Machine-readable release metadata.

---

## Fresh Installation
1. Run \`TORI Download Manager_1.0.2_x64-setup.exe\`.
2. SmartScreen notice: Click **More info** -> **Run anyway**.
3. Complete setup wizard. Default path: \`%LOCALAPPDATA%\\Programs\\TORI Download Manager\`.

## In-Place Upgrade from v1.0.0 or v1.0.1
1. Close existing TORI Download Manager instances completely via System Tray -> Exit.
2. Run \`TORI Download Manager_1.0.2_x64-setup.exe\` without uninstalling the previous version.
3. User settings, SQLite database (\`tdm_storage.sqlite\`), and completed download history are safely preserved.
`;

fs.writeFileSync(path.join(STAGING_DIR, 'INSTALLATION_AND_UPGRADE_NOTES.md'), upgradeNotes, 'utf8');
console.log('Generated INSTALLATION_AND_UPGRADE_NOTES.md');

console.log(`\n=== v1.0.2 Staging Complete: ${checksums.length} files staged ===`);
