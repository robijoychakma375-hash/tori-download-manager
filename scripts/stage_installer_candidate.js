const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const STAGING_DIR = path.join(ROOT, 'release', 'v1.0.1-installer-candidate');

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
    src: path.join(ROOT, 'release', 'v1.0.1-rc', 'tori-download-manager-extension-v1.0.1.zip'),
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

console.log('--- Staging Artifacts to release/v1.0.1-installer-candidate ---');

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

const manifest = {
  manifestVersion: "1.0.0",
  releaseCandidate: "v1.0.1-installer-candidate",
  productName: "TORI Download Manager",
  version: "1.0.1",
  targetPlatform: "Windows 10 / 11 (x64)",
  packagingFormat: "NSIS x64 Self-Extracting Executable",
  sourceCommit: "7ad667f784d12c8b8bf03ddb5501ae11a7c46f17",
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
  bundledComponents: [
    { name: "tori-download-manager.exe", type: "Tauri v2 Desktop Shell & Core Engine", arch: "x64" },
    { name: "tdm-native-host.exe", type: "Native Messaging Bridge Host", arch: "x64" },
    { name: "tdm-cli.exe", type: "Command Line Interface", arch: "x64" },
    { name: "ffmpeg.exe", type: "Media Multiplexer (GPL/LGPL)", arch: "x64" },
    { name: "ffprobe.exe", type: "Media Stream Analyzer", arch: "x64" },
    { name: "yt-dlp.exe", type: "Web Stream Resolver", arch: "x64" }
  ],
  stagedFiles: stagedFilesMeta
};

fs.writeFileSync(path.join(STAGING_DIR, 'INSTALLER_BUILD_MANIFEST.json'), JSON.stringify(manifest, null, 2), 'utf8');
console.log('Generated INSTALLER_BUILD_MANIFEST.json');

// Write INSTALLATION_AND_UPGRADE_NOTES.md
const upgradeNotes = `# TORI Download Manager v1.0.1 â€” Installation & Upgrade Notes

**Build Version:** 1.0.1
**Build Target:** Windows 10/11 x64
**Package:** NSIS Standalone Installer (\`TORI Download Manager_1.0.1_x64-setup.exe\`)
**Updater Signature:** Ed25519 Minisign (\`TORI Download Manager_1.0.1_x64-setup.exe.sig\`)

---

## 1. Overview & Verification Status

This installer candidate is the reproducible Windows NSIS package built from the validated \`dev/v1.0.1\` branch (Gate 18.2). It incorporates all enhancements, optimizations, and bug fixes delivered across Gates 14.1 through 18.1:

- **Download Scheduler:** Persistent native one-time scheduler with SQLite storage, state recovery across application restarts, automatic wake and execution, and desktop notification badges.
- **Memory & Process Management:** WebView2 memory trimming upon minimize, detached lifecycle for background downloads, and bounded internal write queues.
- **Protocol Stability:** Resilient streaming concurrency governor for high-bandwidth HLS/DASH and direct HTTP downloads with RFC-compliant byte-range handling.
- **User Acceptance:** 10/10 manual scenarios passed with zero defect observations on the isolated Release Candidate.

> [!NOTE]
> **Authenticode Status:** This Release Candidate installer is **UNSIGNED** with a commercial Authenticode certificate (normal for internal development candidates). Windows SmartScreen may display an unknown publisher alert if executed outside an isolated development environment.
> **Auto-Updater Status:** The in-app updater artifact is **ED25519 SIGNED** using the official TORI Minisign private key and validates against the public key embedded in \`tauri.conf.json\`.

---

## 2. Bundled Binaries & Sidecars

The installer deploys the following 64-bit binaries to the installation directory (\`C:\\Program Files\\Tori Download Manager\` by default):

| Binary / Asset | Purpose | Architecture |
|---|---|---|
| \`tori-download-manager.exe\` | Primary Desktop Application & Rust Tokio Download Engine | x64 (AMD64) |
| \`bin/tdm-native-host.exe\` | Native Messaging Host for Edge/Chrome Browser Extension | x64 (AMD64) |
| \`bin/tdm-cli.exe\` | Command Line Interface for Automation & Testing | x64 (AMD64) |
| \`bin/ffmpeg.exe\` | Native Muxer for HLS / DASH Video + Audio Streams | x64 (AMD64) |
| \`bin/ffprobe.exe\` | Media Format & Codec Inspector | x64 (AMD64) |
| \`bin/yt-dlp.exe\` | Web Video & Stream Manifest Resolver | x64 (AMD64) |
| \`LICENSE-THIRD-PARTY.txt\` | Open Source Attribution & Component Licenses | Text |

---

## 3. Fresh Installation Procedure (Scheduled for Gate 18.3+ Clean Machine QA)

1. Ensure prerequisites are satisfied:
   - Windows 10 (Build 19041+) or Windows 11 (64-bit).
   - Microsoft Edge WebView2 Runtime (pre-installed on modern Windows 10/11).
2. Execute \`TORI Download Manager_1.0.1_x64-setup.exe\`.
3. Follow the wizard prompts:
   - Select installation destination (default: \`C:\\Program Files\\Tori Download Manager\`).
   - The installer automatically registers the Native Messaging manifest with Edge and Chrome registry keys under \`HKCU\\Software\`.
4. Launch TORI Download Manager from the Start Menu or Desktop shortcut.

---

## 4. Upgrade from v1.0.0

When upgrading an existing TORI v1.0.0 installation:
- **Database Continuity:** The application database located in \`%APPDATA%\\tori-download-manager\\tdm_storage.sqlite\` is preserved intact. Active download history, category definitions, and settings are retained without migration loss.
- **In-Progress Downloads:** Completed download files in user download directories are untouched.
- **Registry & Browser Extension:** The Native Messaging host registry entry is updated to point to the newly installed \`tdm-native-host.exe\` version.

---

## 5. Clean Uninstallation

- Run the uninstaller from Windows **Installed Apps / Settings** or via \`Uninstall TORI Download Manager.exe\` in the program folder.
- The uninstaller cleanly removes all application files and sidecars.
- The uninstaller invokes \`tdm-native-host.exe --unregister\`, cleanly deleting the Native Messaging registry keys from \`HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\` and \`Google\\Chrome\\NativeMessagingHosts\`.
- User downloaded files and personal download directories are **never deleted**.

---

## 6. Checksums (SHA-256)

\`\`\`
${checksums.join('\n')}
\`\`\`
`;

fs.writeFileSync(path.join(STAGING_DIR, 'INSTALLATION_AND_UPGRADE_NOTES.md'), upgradeNotes, 'utf8');
console.log('Generated INSTALLATION_AND_UPGRADE_NOTES.md');

console.log('--- Staging Complete! ---');
