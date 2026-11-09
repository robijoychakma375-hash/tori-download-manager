const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const STAGING_DIR = path.join(ROOT, 'release', 'v1.0.1-firefox-final-candidate');

if (!fs.existsSync(STAGING_DIR)) {
  fs.mkdirSync(STAGING_DIR, { recursive: true });
}

const filesToCopy = [
  {
    src: path.join(ROOT, 'target', 'release', 'bundle', 'nsis', 'TORI Download Manager_1.0.1_x64-setup.exe'),
    dest: 'TORI Download Manager_1.0.1_x64-setup.exe',
  },
  {
    src: path.join(ROOT, 'target', 'release', 'bundle', 'nsis', 'TORI Download Manager_1.0.1_x64-setup.exe.sig'),
    dest: 'TORI Download Manager_1.0.1_x64-setup.exe.sig',
  },
  {
    src: path.join(ROOT, 'release', 'v1.0.1-firefox-candidate', 'tori-download-manager-firefox-v1.0.1.zip'),
    dest: 'tori-download-manager-firefox-v1.0.1.zip',
  },
  {
    src: path.join(ROOT, 'target', 'release', 'tori-download-manager-extension-v1.0.1.zip'),
    dest: 'tori-download-manager-extension-v1.0.1.zip',
  },
  {
    src: path.join(ROOT, 'LICENSE'),
    dest: 'LICENSE',
  },
  {
    src: path.join(ROOT, 'resources', 'LICENSE-THIRD-PARTY.txt'),
    dest: 'LICENSE-THIRD-PARTY.txt',
  },
];

console.log('--- Staging Artifacts to release/v1.0.1-firefox-final-candidate ---');

const checksums = [];
const stagedFilesMeta = [];

for (const item of filesToCopy) {
  if (!fs.existsSync(item.src)) {
    throw new Error(`Source file not found: ${item.src}`);
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

// Build Manifest
const installerFile = stagedFilesMeta.find(f => f.file.endsWith('.exe'));
const sigFile = stagedFilesMeta.find(f => f.file.endsWith('.sig'));
const ffExt = stagedFilesMeta.find(f => f.file.includes('firefox'));
const crExt = stagedFilesMeta.find(f => f.file.includes('extension-v1.0.1.zip'));

const manifest = {
  manifestVersion: "1.0.0",
  releaseCandidate: "v1.0.1-firefox-final-candidate",
  productName: "TORI Download Manager",
  version: "1.0.1",
  targetPlatform: "Windows 10 / 11 (x64)",
  packagingFormat: "NSIS x64 Self-Extracting Executable",
  sourceCommit: "414732b5752ab401e1f87ba21bdab058683ce83e",
  sourceBranch: "dev/v1.0.1",
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
    authenticodeNotice: "Developer preview / Release Candidate packaging. Commercial EV Authenticode certificate signing is deferred until public distribution.",
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
    firefox: {
      filename: ffExt.file,
      sizeBytes: ffExt.size,
      sha256: ffExt.sha256,
      geckoId: "tori-download-manager@toridm.org",
      minVersion: "142.0",
      linterStatus: "PASS (0 errors, 0 warnings)"
    },
    chromiumEdge: {
      filename: crExt.file,
      sizeBytes: crExt.size,
      sha256: crExt.sha256,
      extensionId: "jfnfgmcbgapcpieaonbaolgebjaejcdm",
      manifestVersion: 3
    }
  },
  bundledComponents: [
    { name: "tori-download-manager.exe", type: "Tauri v2 Desktop Shell & Core Engine", arch: "x64" },
    { name: "tdm-native-host.exe", type: "Multi-Browser Native Messaging Host (Chrome, Edge, Firefox)", arch: "x64" },
    { name: "tdm-cli.exe", type: "Headless CLI Client & Test Harness", arch: "x64" },
    { name: "ffmpeg.exe", type: "Media Processing & Demuxing Tool", version: "7.1-full_build" },
    { name: "ffprobe.exe", type: "Stream Inspector & Format Validator", version: "7.1-full_build" },
    { name: "yt-dlp.exe", type: "Adaptive Media Stream Extractor", version: "2024.10.07" }
  ],
  verifiedGateCapabilities: [
    "Gate 17.0–17.7 Engine Stability, Stream Recovery, Storage Trimming",
    "Gate 18.0 Release Candidate Freeze & Artifact Integrity",
    "Gate 18.1 Isolated Manual User Acceptance (10/10 PASS)",
    "Gate 18.2 NSIS Packaging & Automated Verification",
    "Gate 18.3 Separate PC Installation QA Scripts & Procedures",
    "Gate 18.3F Firefox Extension Development & Cross-Browser Parity",
    "Gate 18.3F.1 Real Firefox GUI, Media Detection & Bitstream Download Acceptance",
    "Gate 18.3F.2 Firefox Native Messaging Host Registration Hooks & Ed25519-Signed Installer"
  ]
};

fs.writeFileSync(
  path.join(STAGING_DIR, 'FINAL_CANDIDATE_MANIFEST.json'),
  JSON.stringify(manifest, null, 2),
  'utf8'
);
console.log('Generated FINAL_CANDIDATE_MANIFEST.json');

// Copy / Generate INSTALLATION_AND_UPGRADE_NOTES.md
const upgradeNotesContent = `# TORI Download Manager v1.0.1 — Final Release Candidate Packaging Notes
## Package: release/v1.0.1-firefox-final-candidate

### Package Contents
1. \`TORI Download Manager_1.0.1_x64-setup.exe\` — Fresh Windows x64 NSIS installer (~117 MB).
2. \`TORI Download Manager_1.0.1_x64-setup.exe.sig\` — Cryptographic Ed25519 signature generated with the official updater private key.
3. \`tori-download-manager-firefox-v1.0.1.zip\` — Mozilla Firefox Manifest V3 Extension candidate, pre-validated with \`web-ext lint\` (0 errors).
4. \`tori-download-manager-extension-v1.0.1.zip\` — Microsoft Edge and Google Chrome Manifest V3 Extension candidate.
5. \`LICENSE\` — MIT License.
6. \`LICENSE-THIRD-PARTY.txt\` — Complete open-source attribution for bundled dependencies.
7. \`SHA256SUMS.txt\` — Cryptographic hashes for all package files.
8. \`FINAL_CANDIDATE_MANIFEST.json\` — Formal machine-readable release metadata.

### Cross-Browser Architecture Summary
- **Desktop Core Engine:** Rust / Tokio multithreaded engine (v1.0.1).
- **Internal API Version:** Protocol v2.0.0.
- **Local HTTP/SSE Server:** \`http://127.0.0.1:6800\` (or configured port) with strictly enforced origin validation (\`moz-extension://<uuid>\` and \`chrome-extension://<id>\`) and SHA256-based token authentication.
- **Native Messaging Host:** \`com.tori.download_manager\` (\`tdm-native-host.exe\`).
  - Supports standard 32-bit length-prefixed JSON framing.
  - Registers Firefox Native Messaging manifest at \`%APPDATA%\\tori-download-manager\\com.tori.download_manager.firefox.json\`.
  - Connects to Mozilla Firefox via Gecko ID \`tori-download-manager@toridm.org\`.
  - Registered automatically by NSIS installer at \`HKCU\\Software\\Mozilla\\NativeMessagingHosts\\com.tori.download_manager\`.
  - Cleared cleanly by NSIS uninstaller upon application removal.

### Installation & Upgrade Guidance
- **Clean Installation:** Run the installer on target Windows machine. Choose installation folder (default: \`%LOCALAPPDATA%\\Programs\\TORI Download Manager\`). The installer automatically registers Native Messaging hosts for Chrome, Edge, and Firefox.
- **Upgrade from v1.0.0:** Run the installer directly over v1.0.0. Existing user settings, download history, and SQLite database in \`%APPDATA%\\tori-download-manager\\tdm_storage.sqlite\` are fully preserved.
- **Uninstallation:** Standard Windows Apps & Features uninstaller removes all binaries and browser registry keys while preserving downloaded files.
`;

fs.writeFileSync(
  path.join(STAGING_DIR, 'INSTALLATION_AND_UPGRADE_NOTES.md'),
  upgradeNotesContent,
  'utf8'
);
console.log('Generated INSTALLATION_AND_UPGRADE_NOTES.md');
console.log('--- Staging Complete ---');

