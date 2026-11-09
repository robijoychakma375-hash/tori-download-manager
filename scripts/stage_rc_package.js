/**
 * TORI Download Manager v1.0.1 — Stage Local Release Candidate Package
 */
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

const ROOT = path.resolve('F:\\TORI\\final tori download manager');
const STAGING_DIR = path.join(ROOT, 'release', 'v1.0.1-rc');
const STAGING_BIN = path.join(STAGING_DIR, 'bin');

if (fs.existsSync(STAGING_DIR)) {
  try { fs.rmSync(STAGING_DIR, { recursive: true, force: true }); } catch (_) {}
}
fs.mkdirSync(STAGING_BIN, { recursive: true });

console.log('--- 1. STAGING RELEASE CANDIDATE BINARIES & SIDECARS ---');
const binaries = [
  { src: 'target/release/tori-download-manager.exe', dest: 'bin/tori-download-manager.exe' },
  { src: 'target/release/tdm-native-host.exe', dest: 'bin/tdm-native-host.exe' },
  { src: 'target/release/tdm-cli.exe', dest: 'bin/tdm-cli.exe' },
  { src: 'resources/bin/ffmpeg.exe', dest: 'bin/ffmpeg.exe' },
  { src: 'resources/bin/ffprobe.exe', dest: 'bin/ffprobe.exe' },
  { src: 'resources/bin/yt-dlp.exe', dest: 'bin/yt-dlp.exe' },
];

const stagedChecksums = [];

for (const b of binaries) {
  const srcPath = path.join(ROOT, b.src);
  const destPath = path.join(STAGING_DIR, b.dest);
  if (!fs.existsSync(srcPath)) throw new Error(`Missing source binary: ${srcPath}`);
  fs.copyFileSync(srcPath, destPath);
  const sha = computeSha256(destPath);
  const size = fs.statSync(destPath).size;
  stagedChecksums.push({ file: b.dest, sha256: sha, size });
  console.log(`[STAGED] ${b.dest.padEnd(30)} | ${(size / 1024 / 1024).toFixed(2).padStart(7)} MB | SHA256: ${sha}`);
}

// 2. Package Browser Extension (Zip and Unpacked Directory)
console.log('\n--- 2. PACKAGING BROWSER EXTENSION (MV3) ---');
const extDir = path.join(ROOT, 'extension');
const extZipName = 'tori-download-manager-extension-v1.0.1.zip';
const extZipPath = path.join(STAGING_DIR, extZipName);
const stagedExtDir = path.join(STAGING_DIR, 'extension');

// Package extension via python oneliner with args
const pyScript = "import zipfile, os, sys; zf = zipfile.ZipFile(sys.argv[2], 'w', zipfile.ZIP_DEFLATED); [zf.write(os.path.join(r, f), os.path.relpath(os.path.join(r, f), sys.argv[1])) for r, d, files in os.walk(sys.argv[1]) for f in files]; zf.close()";
execSync(`python -c "${pyScript}" "${extDir}" "${extZipPath}"`);

const extSha = computeSha256(extZipPath);
const extSize = fs.statSync(extZipPath).size;
stagedChecksums.push({ file: extZipName, sha256: extSha, size: extSize });
console.log(`[STAGED] ${extZipName.padEnd(30)} | ${(extSize / 1024).toFixed(2).padStart(7)} KB | SHA256: ${extSha}`);

// Also copy unpacked extension folder into release staging for direct Edge load-unpacked testing
fs.cpSync(extDir, stagedExtDir, { recursive: true });
console.log(`[STAGED] extension/ (unpacked folder) staged for direct browser loading.`);

// 3. Sidecars Checksums
console.log('\n--- 3. RECORDING BUNDLED SIDECARS ---');
const sidecarRecords = [
  { name: 'ffmpeg.exe', relativePath: 'bin/ffmpeg.exe', sha256: stagedChecksums.find(c => c.file === 'bin/ffmpeg.exe').sha256, sizeBytes: stagedChecksums.find(c => c.file === 'bin/ffmpeg.exe').size },
  { name: 'ffprobe.exe', relativePath: 'bin/ffprobe.exe', sha256: stagedChecksums.find(c => c.file === 'bin/ffprobe.exe').sha256, sizeBytes: stagedChecksums.find(c => c.file === 'bin/ffprobe.exe').size },
  { name: 'yt-dlp.exe', relativePath: 'bin/yt-dlp.exe', sha256: stagedChecksums.find(c => c.file === 'bin/yt-dlp.exe').sha256, sizeBytes: stagedChecksums.find(c => c.file === 'bin/yt-dlp.exe').size },
];

// 4. Copy Licenses
fs.copyFileSync(path.join(ROOT, 'LICENSE'), path.join(STAGING_DIR, 'LICENSE'));
fs.copyFileSync(path.join(ROOT, 'resources', 'LICENSE-THIRD-PARTY.txt'), path.join(STAGING_DIR, 'LICENSE-THIRD-PARTY.txt'));

// 5. Generate SHA256SUMS.txt
const sumsContent = stagedChecksums.map(c => `${c.sha256}  ${c.file}`).join('\n') + '\n';
fs.writeFileSync(path.join(STAGING_DIR, 'SHA256SUMS.txt'), sumsContent, 'utf8');
console.log('\n[STAGED] SHA256SUMS.txt created.');

// 6. Generate RC_MANIFEST.json
const headCommit = execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf8' }).trim();
const branch = execSync('git branch --show-current', { cwd: ROOT, encoding: 'utf8' }).trim();

const rcManifest = {
  manifestVersion: '1.0.0',
  releaseCandidate: 'v1.0.1-rc1',
  targetVersion: '1.0.1',
  targetPlatform: 'Windows 10/11 x64',
  msvcToolchain: '14.44.35207',
  windowsSdkVersion: '10.0.26100.0',
  gitBranch: branch,
  gitCommit: headCommit,
  stagedTimestamp: new Date().toISOString(),
  buildConfiguration: {
    profile: 'release',
    lto: 'thin',
    codegenUnits: 1,
    optLevel: 3,
    debugInfo: false,
    strip: 'symbols',
    panic: 'unwind',
  },
  stagedArtifacts: stagedChecksums,
  bundledSidecars: sidecarRecords,
  runtimeDependencies: [
    'Microsoft Edge WebView2 Runtime (Evergreen)',
    'Windows 10 Build 19041+ or Windows 11',
    'Chromium-based Browser (Chrome 110+ or Edge 110+) for MV3 Extension'
  ],
  supportedProtocols: [
    { protocol: 'HTTP / HTTPS (Direct)', status: 'FULL_SUPPORT', features: ['Range', 'Multi-Chunk (1-32)', 'Pause/Resume', 'Validator Detection', '503 Exponential Retry'] },
    { protocol: 'HLS VOD (RFC 8216)', status: 'FULL_SUPPORT', features: ['Master/Media Playlists', 'Concurrent Segment Fetch (C=4)', 'AES-128 Encryption (Explicit/Implicit IV)', 'FFmpeg Remux'] },
    { protocol: 'DASH VOD (ISO/IEC 23009-1)', status: 'FULL_SUPPORT', features: ['MPD Parsing', 'SegmentTemplate / SegmentList', 'Concurrent Fetch', 'Separate A/V Remux'] },
    { protocol: 'Scheduled Downloads', status: 'FULL_SUPPORT', features: ['One-time Wall-Clock Future Schedule', 'Tokio Zero-Polling Sleep', 'SQLite WAL Persistence', 'Overdue Startup Catch-Up'] },
    { protocol: 'BitTorrent / Magnet', status: 'EXPERIMENTAL_PARSER', features: ['Magnet URI Parsing', 'Engine integration deferred to subsequent major release'] }
  ],
  knownLimitations: [
    'DRM-protected streams (Widevine, PlayReady, FairPlay) are strictly non-supported and rejected with status 422.',
    'Scraper/Anti-bot login walls (Facebook private videos, Instagram auth-walled reels) require direct media URL or logged-in browser session.',
    'Windows Sandbox and clean-machine installer QA are deferred and must be validated before public release.'
  ],
  outstandingReleaseBlockers: [
    'Clean-machine Windows Sandbox installer acceptance testing (explicitly deferred to subsequent staging gate).',
    'Manual user acceptance sign-off on real Windows desktop.'
  ]
};

fs.writeFileSync(path.join(STAGING_DIR, 'RC_MANIFEST.json'), JSON.stringify(rcManifest, null, 2), 'utf8');
console.log('[STAGED] RC_MANIFEST.json created.');
console.log(`\n>>> LOCAL RELEASE CANDIDATE STAGED SUCCESSFULLY TO: ${STAGING_DIR} <<<\n`);
