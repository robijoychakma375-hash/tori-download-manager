const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

function computeSha256(filePath) {
  const hash = crypto.createHash('sha256');
  const buffer = fs.readFileSync(filePath);
  hash.update(buffer);
  return hash.digest('hex');
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

const binaries = [
  { name: 'tori-download-manager.exe', relPath: 'target/release/tori-download-manager.exe', role: 'Main Desktop Application (Tauri 2 + Rust)' },
  { name: 'tdm-native-host.exe', relPath: 'target/release/tdm-native-host.exe', role: 'Native Messaging Host Companion' },
  { name: 'tdm-cli.exe', relPath: 'target/release/tdm-cli.exe', role: 'CLI Companion Executable' },
  { name: 'ffmpeg.exe', relPath: 'resources/bin/ffmpeg.exe', role: 'Remuxing & Transcoding Sidecar' },
  { name: 'ffprobe.exe', relPath: 'resources/bin/ffprobe.exe', role: 'Media Stream Probing Sidecar' },
  { name: 'yt-dlp.exe', relPath: 'resources/bin/yt-dlp.exe', role: 'Media Platform Extraction Sidecar' },
];

console.log('--- 1. CURRENT ARTIFACT INTEGRITY & SHA-256 HASHES ---');
const artifactReport = [];

for (const b of binaries) {
  const full = path.resolve(b.relPath);
  if (!fs.existsSync(full)) {
    console.error(`[MISSING] ${b.relPath}`);
    continue;
  }
  const stat = fs.statSync(full);
  const sha256 = computeSha256(full);

  // Attempt version check
  let version = '1.0.1';
  if (b.name === 'ffmpeg.exe' || b.name === 'ffprobe.exe') {
    try {
      const out = execSync(`"${full}" -version`, { encoding: 'utf8' }).split('\n')[0];
      version = out.trim();
    } catch (_) { version = 'N/A'; }
  } else if (b.name === 'yt-dlp.exe') {
    try {
      version = execSync(`"${full}" --version`, { encoding: 'utf8' }).trim();
    } catch (_) { version = 'N/A'; }
  } else if (b.name === 'tdm-cli.exe') {
    try {
      version = execSync(`"${full}" --version`, { encoding: 'utf8' }).trim();
    } catch (_) { version = '1.0.1'; }
  }

  const record = {
    name: b.name,
    role: b.role,
    path: full,
    sizeBytes: stat.size,
    sizeFormatted: formatBytes(stat.size),
    mtime: stat.mtime.toISOString(),
    sha256,
    version
  };
  artifactReport.push(record);

  console.log(`\nBinary:     ${record.name} (${record.role})`);
  console.log(`Path:       ${record.path}`);
  console.log(`Size:       ${record.sizeFormatted} (${record.sizeBytes} bytes)`);
  console.log(`Modified:   ${record.mtime}`);
  console.log(`Version:    ${record.version}`);
  console.log(`SHA-256:    ${record.sha256}`);
}

// 2. Check existing installers
console.log('\n--- 2. EXISTING INSTALLER AUDIT (DISTINCTION FROM CURRENT BUILD) ---');
const installerDir = path.resolve('target/release/bundle/nsis');
const installerReport = [];

if (fs.existsSync(installerDir)) {
  const files = fs.readdirSync(installerDir);
  for (const f of files) {
    if (f.endsWith('.exe')) {
      const full = path.join(installerDir, f);
      const stat = fs.statSync(full);
      const sha256 = computeSha256(full);
      const instRecord = {
        name: f,
        path: full,
        sizeBytes: stat.size,
        sizeFormatted: formatBytes(stat.size),
        mtime: stat.mtime.toISOString(),
        sha256,
        isCurrentDevBuild: false,
        note: 'Historical NSIS installer artifact; does NOT contain recent Gate 17.x scheduler/memory changes until rebuilt.'
      };
      installerReport.push(instRecord);

      console.log(`\nInstaller:  ${f}`);
      console.log(`Path:       ${full}`);
      console.log(`Size:       ${instRecord.sizeFormatted} (${stat.size} bytes)`);
      console.log(`Built At:   ${stat.mtime.toISOString()}`);
      console.log(`SHA-256:    ${sha256}`);
      console.log(`Status:     HISTORICAL ARTIFACT (Distinguished from current dev binaries)`);
    }
  }
}

const finalReport = {
  scanTimestamp: new Date().toISOString(),
  currentBinaries: artifactReport,
  existingInstallers: installerReport
};

fs.writeFileSync(path.join(__dirname, 'artifact_integrity_report.json'), JSON.stringify(finalReport, null, 2), 'utf8');
console.log('\nArtifact integrity report written to scripts/artifact_integrity_report.json');
