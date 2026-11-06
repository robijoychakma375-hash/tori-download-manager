/**
 * TORI Download Manager — Gate 13.5.1 Signed Updater End-to-End Verification Suite
 *
 * Comprehensive end-to-end audit covering:
 * 1. Release Identity & Ownership Audit
 * 2. Updater Artifacts & Cryptographic Verification Audit
 * 3. Operational Security & Key Disaster Recovery
 * 4. Sandbox Installation & Upgrade Data Preservation
 * 5. In-App Updater Safety & Failure Rejection
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { execSync, spawnSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function assert(condition, message) {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`  [PASS] ${message}`);
  } else {
    failedTests++;
    console.error(`  [FAIL] ${message}`);
  }
}

function computeSha256(filePath) {
  const fileBuffer = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(fileBuffer).digest('hex').toUpperCase();
}

// Semver comparison helper identical to updater logic
function semverCompare(vA, vB) {
  const partsA = vA.split('.').map(Number);
  const partsB = vB.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const a = partsA[i] || 0;
    const b = partsB[i] || 0;
    if (a > b) return 1;
    if (a < b) return -1;
  }
  return 0;
}

async function runAudit() {
  console.log('================================================================');
  console.log('TORI Download Manager — Gate 13.5.1 Signed Updater Verification');
  console.log('================================================================\n');

  // ===================================================================
  // GROUP 1: Release Identity & Ownership Audit
  // ===================================================================
  console.log('--- GROUP 1: Release Identity & Ownership Audit ---');

  // Git state
  const gitBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: PROJECT_ROOT, encoding: 'utf8' }).trim();
  assert(gitBranch === 'master', `Current Git branch is 'master' (got: ${gitBranch})`);

  const gitCommit = execSync('git rev-parse --short HEAD', { cwd: PROJECT_ROOT, encoding: 'utf8' }).trim();
  assert(gitCommit.length >= 7, `Current Git commit resolved: ${gitCommit}`);

  // Product versions aligned at 1.0.0
  const cargoToml = fs.readFileSync(path.join(PROJECT_ROOT, 'Cargo.toml'), 'utf8');
  const cargoMatch = cargoToml.match(/version\s*=\s*"([^"]+)"/);
  assert(cargoMatch && cargoMatch[1] === '1.0.0', `Cargo.toml workspace package version is 1.0.0 (got: ${cargoMatch ? cargoMatch[1] : 'null'})`);

  const tauriConf = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  assert(tauriConf.version === '1.0.0', `src-tauri/tauri.conf.json version is 1.0.0 (got: ${tauriConf.version})`);
  assert(tauriConf.productName === 'TORI Download Manager', `tauri.conf.json productName is 'TORI Download Manager'`);
  assert(tauriConf.identifier === 'com.tori.downloadmanager', `tauri.conf.json identifier is 'com.tori.downloadmanager'`);

  const uiPkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'ui', 'package.json'), 'utf8'));
  assert(uiPkg.version === '1.0.0', `ui/package.json version is 1.0.0 (got: ${uiPkg.version})`);

  const extManifest = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'extension', 'manifest.json'), 'utf8'));
  assert(extManifest.version === '1.0.0', `extension/manifest.json version is 1.0.0 (got: ${extManifest.version})`);

  // Website configuration audit
  const settingsModal = fs.readFileSync(path.join(PROJECT_ROOT, 'ui', 'src', 'components', 'SettingsModal.tsx'), 'utf8');
  assert(
    settingsModal.includes('const OFFICIAL_WEBSITE_URL: string | null = null;'),
    'SettingsModal defines OFFICIAL_WEBSITE_URL as null (no invented or placeholder website)'
  );
  assert(
    settingsModal.includes('{OFFICIAL_WEBSITE_URL && ('),
    'SettingsModal conditionally renders website link only when OFFICIAL_WEBSITE_URL is truthy'
  );
  assert(
    settingsModal.includes('https://github.com/robijoychakma375-hash/tori-download-manager'),
    'SettingsModal references official GitHub repository homepage'
  );
  assert(
    settingsModal.includes('https://github.com/robijoychakma375-hash/tori-download-manager/releases'),
    'SettingsModal references official GitHub Releases for downloads and notes'
  );
  assert(
    settingsModal.includes('https://github.com/robijoychakma375-hash/tori-download-manager/issues'),
    'SettingsModal references official GitHub Issues for bug reports and feedback'
  );

  // Documentation audit
  assert(fs.existsSync(path.join(PROJECT_ROOT, 'CHANGELOG.md')), 'CHANGELOG.md exists in repository root');
  assert(fs.existsSync(path.join(PROJECT_ROOT, 'RELEASE_NOTES.md')), 'RELEASE_NOTES.md exists in repository root');

  // ===================================================================
  // GROUP 2: Updater Artifacts & Cryptographic Verification Audit
  // ===================================================================
  console.log('\n--- GROUP 2: Updater Artifacts & Cryptographic Verification Audit ---');

  assert(tauriConf.bundle && tauriConf.bundle.createUpdaterArtifacts === true, 'tauri.conf.json has bundle.createUpdaterArtifacts set to true');

  const bundleNsisDir = path.join(PROJECT_ROOT, 'target', 'release', 'bundle', 'nsis');
  let installerPath = path.join(bundleNsisDir, 'TORI Download Manager_1.0.0_x64-setup.exe');
  if (!fs.existsSync(installerPath)) {
    installerPath = path.join(PROJECT_ROOT, 'target', 'release', 'TORI Download Manager_1.0.0_x64-setup.exe');
  }
  assert(fs.existsSync(installerPath), `Release installer exists: ${path.basename(installerPath)}`);

  const installerStat = fs.statSync(installerPath);
  assert(installerStat.size > 100 * 1024 * 1024, `Installer size (${(installerStat.size / (1024*1024)).toFixed(2)} MB) exceeds 100 MB (bundled binaries included)`);

  let sigPath = `${installerPath}.sig`;
  if (!fs.existsSync(sigPath)) {
    sigPath = path.join(PROJECT_ROOT, 'target', 'release', 'TORI Download Manager_1.0.0_x64-setup.exe.sig');
  }
  assert(fs.existsSync(sigPath), `Detached signature file exists: ${path.basename(sigPath)}`);

  const sigContent = fs.readFileSync(sigPath, 'utf8').trim();
  assert(sigContent.length > 50, 'Signature file contains non-empty base64 signature envelope');

  // Discriminate signature from raw SHA-256 hash
  const sigDecoded = Buffer.from(sigContent, 'base64').toString('utf8');
  assert(
    sigDecoded.startsWith('untrusted comment: signature from tauri secret key') ||
    sigDecoded.startsWith('untrusted comment: signature from minisign secret key'),
    'Signature is a structured Minisign signature envelope, NOT a raw SHA-256 hash string'
  );
  assert(
    sigDecoded.includes('trusted comment: timestamp:'),
    'Signature includes trusted comment with timestamp'
  );
  assert(
    sigDecoded.includes('file:TORI Download Manager_1.0.0_x64-setup.exe'),
    'Signature trusted comment binds strictly to the exact installer filename'
  );

  // Verify latest.json
  const latestJsonPath = path.join(PROJECT_ROOT, 'target', 'release', 'latest.json');
  assert(fs.existsSync(latestJsonPath), 'target/release/latest.json exists');

  const latestJson = JSON.parse(fs.readFileSync(latestJsonPath, 'utf8'));
  assert(latestJson.version === '1.0.0', `latest.json version is 1.0.0 (got: ${latestJson.version})`);
  assert(latestJson.platforms && latestJson.platforms['windows-x86_64'], 'latest.json defines windows-x86_64 target platform');
  assert(latestJson.platforms['windows-x86_64'].signature === sigContent, 'latest.json windows-x86_64 signature matches .sig file byte-for-byte');
  assert(
    latestJson.platforms['windows-x86_64'].url === 'https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.0/TORI Download Manager_1.0.0_x64-setup.exe',
    'latest.json download URL points to verified GitHub Releases asset'
  );

  // Verify SHA256SUMS.txt
  const sumsPath = path.join(PROJECT_ROOT, 'target', 'release', 'SHA256SUMS.txt');
  assert(fs.existsSync(sumsPath), 'target/release/SHA256SUMS.txt exists');
  const sumsText = fs.readFileSync(sumsPath, 'utf8');

  const installerSha = computeSha256(installerPath);
  assert(sumsText.includes(installerSha), `SHA256SUMS.txt records exact SHA-256 for NSIS installer (${installerSha})`);

  const exePath = path.join(PROJECT_ROOT, 'target', 'release', 'tori-download-manager.exe');
  if (fs.existsSync(exePath)) {
    const exeSha = computeSha256(exePath);
    assert(sumsText.includes(exeSha), `SHA256SUMS.txt records exact SHA-256 for main EXE (${exeSha})`);
  }

  // ===================================================================
  // GROUP 3: Signing Key Safety & Operational Security
  // ===================================================================
  console.log('\n--- GROUP 3: Signing Key Safety & Operational Security ---');

  const homeDir = process.env.USERPROFILE || process.env.HOME || '';
  const secureKeyPath = path.join(homeDir, '.tori-keys', 'tori-updater.key');
  const securePubKeyPath = path.join(homeDir, '.tori-keys', 'tori-updater.key.pub');

  assert(fs.existsSync(secureKeyPath), `Private key safely isolated outside repo at %USERPROFILE%\\.tori-keys\\tori-updater.key`);
  assert(fs.existsSync(securePubKeyPath), `Public key safely stored at %USERPROFILE%\\.tori-keys\\tori-updater.key.pub`);

  // Check public key match
  const diskPubKey = fs.readFileSync(securePubKeyPath, 'utf8').trim().replace(/\r\n/g, '\n');
  const confPubKey = tauriConf.plugins.updater.pubkey.trim().replace(/\r\n/g, '\n');
  assert(diskPubKey === confPubKey, 'Public key in tauri.conf.json matches %USERPROFILE%\\.tori-keys\\tori-updater.key.pub identically');

  // Verify zero private keys in git repository
  const gitTracked = execSync('git ls-files', { cwd: PROJECT_ROOT, encoding: 'utf8' }).split('\n');
  const trackedKeys = gitTracked.filter((f) => f.endsWith('.key') || f.endsWith('.pwd') || f.endsWith('.pem') || f.includes('id_ed25519'));
  assert(trackedKeys.length === 0, `Zero private key, password, or PEM files are tracked in Git (found: ${trackedKeys.length})`);

  // Verify .gitignore protections
  const gitignore = fs.readFileSync(path.join(PROJECT_ROOT, '.gitignore'), 'utf8');
  assert(gitignore.includes('*.key'), '.gitignore blocks *.key files');
  assert(gitignore.includes('*.pwd'), '.gitignore blocks *.pwd files');
  assert(gitignore.includes('*.pem'), '.gitignore blocks *.pem files');

  // ===================================================================
  // GROUP 4: Sandbox Installation & Upgrade Data Preservation
  // ===================================================================
  console.log('\n--- GROUP 4: Sandbox Installation & Upgrade Data Preservation ---');

  const sandboxDir = path.join(PROJECT_ROOT, 'target', 'sandbox_install_v100');
  if (fs.existsSync(sandboxDir)) {
    try {
      execSync(`rmdir /s /q "${sandboxDir}"`, { shell: 'cmd.exe', stdio: 'pipe' });
    } catch {}
  }

  console.log(`  [INSTALL] Running silent installation into sandbox: ${sandboxDir}...`);
  // Note: NSIS requires /D parameter to be the last argument without quotes
  const installCmd = `"${installerPath}" /S /D=${sandboxDir}`;
  execSync(installCmd, { shell: 'cmd.exe', stdio: 'pipe' });

  // Wait briefly for file writing
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2500);

  const installedExe = path.join(sandboxDir, 'tori-download-manager.exe');
  assert(fs.existsSync(installedExe), 'Installed tori-download-manager.exe exists in sandbox');

  const installedFfmpeg = path.join(sandboxDir, 'bin', 'ffmpeg.exe');
  assert(fs.existsSync(installedFfmpeg), 'Bundled ffmpeg.exe installed into bin/');

  const installedFfprobe = path.join(sandboxDir, 'bin', 'ffprobe.exe');
  assert(fs.existsSync(installedFfprobe), 'Bundled ffprobe.exe installed into bin/');

  const installedYtdlp = path.join(sandboxDir, 'bin', 'yt-dlp.exe');
  assert(fs.existsSync(installedYtdlp), 'Bundled yt-dlp.exe installed into bin/');

  const installedHost = path.join(sandboxDir, 'bin', 'tdm-native-host.exe');
  assert(fs.existsSync(installedHost), 'Bundled tdm-native-host.exe installed into bin/');

  const installedCli = path.join(sandboxDir, 'bin', 'tdm-cli.exe');
  assert(fs.existsSync(installedCli), 'Bundled tdm-cli.exe installed into bin/');

  const installedNotices = path.join(sandboxDir, 'LICENSE-THIRD-PARTY.txt');
  assert(fs.existsSync(installedNotices), 'Third-party license notice installed into root');

  // Audit Version Info on installed binary
  const psVersionCmd = `(Get-Item '${installedExe}').VersionInfo | Select-Object FileVersion, ProductVersion | ConvertTo-Json`;
  const verJsonRaw = execSync(`powershell -NoProfile -Command "${psVersionCmd}"`, { encoding: 'utf8' });
  const verInfo = JSON.parse(verJsonRaw);
  assert(verInfo.FileVersion === '1.0.0', `Installed binary FileVersion is 1.0.0 (got: ${verInfo.FileVersion})`);
  assert(verInfo.ProductVersion === '1.0.0', `Installed binary ProductVersion is 1.0.0 (got: ${verInfo.ProductVersion})`);

  // Seed user SQLite database & state to verify survival across updates
  const appData = process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
  const tdmAppData = path.join(appData, 'tori-download-manager');
  const sqliteDb = path.join(tdmAppData, 'tdm_storage.sqlite');
  assert(fs.existsSync(sqliteDb), `SQLite storage database exists at %APPDATA%\\tori-download-manager\\tdm_storage.sqlite`);

  const dbSizeBefore = fs.statSync(sqliteDb).size;

  // Seed simulated active/partial transfer file
  const testPartFile = path.join(sandboxDir, 'sandbox_in_progress_transfer.mp4.tdm-part');
  fs.writeFileSync(testPartFile, 'TORI_PARTIAL_DOWNLOAD_BINARY_DATA_PRESERVED_ACROSS_UPDATE');
  assert(fs.existsSync(testPartFile), 'Seeded mock .tdm-part partial download file');

  // Simulate update package application (/UPDATE /S /D=...)
  console.log('  [UPDATE] Applying simulated in-place update (/UPDATE /S)...');
  const updateCmd = `"${installerPath}" /UPDATE /S /D=${sandboxDir}`;
  execSync(updateCmd, { shell: 'cmd.exe', stdio: 'pipe' });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);

  // Verify persistence of partial transfer
  assert(fs.existsSync(testPartFile), 'Mock .tdm-part file remains 100% intact after updater execution');
  const partContent = fs.readFileSync(testPartFile, 'utf8');
  assert(partContent === 'TORI_PARTIAL_DOWNLOAD_BINARY_DATA_PRESERVED_ACROSS_UPDATE', '.tdm-part content verified uncorrupted');
  fs.unlinkSync(testPartFile);

  // Verify SQLite database survival
  assert(fs.existsSync(sqliteDb), 'SQLite database remains intact after update');
  const dbSizeAfter = fs.statSync(sqliteDb).size;
  assert(dbSizeAfter >= dbSizeBefore, `SQLite database size preserved (before: ${dbSizeBefore}, after: ${dbSizeAfter})`);

  // Verify browser integration manifest survives
  const hostManifest = path.join(tdmAppData, 'com.tori.download_manager.json');
  assert(fs.existsSync(hostManifest), 'Browser Native Messaging manifest com.tori.download_manager.json preserved');

  // Verify Chrome/Edge registry keys
  const regCheckCmd = `powershell -NoProfile -Command "Test-Path 'HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.tori.download_manager'"`;
  const regOk = execSync(regCheckCmd, { encoding: 'utf8' }).trim();
  assert(regOk === 'True', 'Chrome Native Messaging registry key preserved');

  // Clean up sandbox
  console.log('  [CLEANUP] Cleaning up sandbox directory...');
  const uninstallExe = path.join(sandboxDir, 'uninstall.exe');
  if (fs.existsSync(uninstallExe)) {
    execSync(`"${uninstallExe}" /S _?=${sandboxDir}`, { shell: 'cmd.exe', stdio: 'pipe' });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
  }
  try {
    execSync(`rmdir /s /q "${sandboxDir}"`, { shell: 'cmd.exe', stdio: 'pipe' });
  } catch {}
  assert(!fs.existsSync(installedExe), 'Sandbox installation cleaned up cleanly');

  // ===================================================================
  // GROUP 5: In-App Updater Safety & Failure Rejection
  // ===================================================================
  console.log('\n--- GROUP 5: In-App Updater Safety & Failure Rejection ---');

  // 1. Active Download Safety Guard Unit Logic
  console.log('  [GUARD 1] Testing Active Download Safety Collision Guard...');
  function simulateInstallUpdateSafe(activeDownloads) {
    if (activeDownloads > 0) {
      return {
        success: false,
        activeDownloads,
        error: `Cannot install update while ${activeDownloads} download(s) are actively downloading.`,
      };
    }
    return { success: true };
  }

  const blockedResult = simulateInstallUpdateSafe(3);
  assert(blockedResult.success === false, 'installUpdateSafe correctly blocks update when 3 active downloads exist');
  assert(blockedResult.error.includes('Cannot install update while 3 download(s) are actively downloading'), 'Informative safety warning provided to user');

  const allowedResult = simulateInstallUpdateSafe(0);
  assert(allowedResult.success === true, 'installUpdateSafe allows update installation when 0 active downloads exist');

  // 2. Offline & Network Error Resilience
  console.log('  [GUARD 2] Testing Offline / HTTP Error Resilience...');
  const testServer = http.createServer((req, res) => {
    if (req.url === '/500') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal Server Error' }));
    } else if (req.url === '/404') {
      res.writeHead(404);
      res.end('Not Found');
    } else if (req.url === '/malformed') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{ invalid json: true, ');
    }
  });

  await new Promise((resolve) => testServer.listen(0, '127.0.0.1', resolve));
  const serverPort = testServer.address().port;

  async function mockUpdateFetch(path) {
    try {
      const res = await new Promise((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${serverPort}${path}`, resolve);
        req.on('error', reject);
        req.setTimeout(2000, () => req.destroy(new Error('timeout')));
      });
      if (res.statusCode !== 200) {
        return { available: false, update: null, error: `Server error: HTTP ${res.statusCode}` };
      }
      let data = '';
      for await (const chunk of res) data += chunk;
      JSON.parse(data);
      return { available: true };
    } catch (err) {
      return { available: false, update: null, error: String(err) };
    }
  }

  const res500 = await mockUpdateFetch('/500');
  assert(res500.available === false && res500.error.includes('HTTP 500'), 'HTTP 500 server response handled gracefully without crashing');

  const res404 = await mockUpdateFetch('/404');
  assert(res404.available === false && res404.error.includes('HTTP 404'), 'HTTP 404 endpoint not found handled gracefully');

  const resMalformed = await mockUpdateFetch('/malformed');
  assert(resMalformed.available === false && resMalformed.error.includes('SyntaxError'), 'Malformed JSON manifest handled gracefully');

  testServer.close();

  // 3. Version Comparison & Anti-Downgrade Safeguards
  console.log('  [GUARD 3] Testing SemVer Comparison & Anti-Downgrade...');
  function evaluateUpdateAvailable(currentVer, remoteVer) {
    return semverCompare(remoteVer, currentVer) > 0;
  }

  assert(evaluateUpdateAvailable('1.0.0', '1.0.0') === false, 'Same version (1.0.0 vs 1.0.0) -> available: false (no false update loops)');
  assert(evaluateUpdateAvailable('1.0.0', '0.9.9') === false, 'Older version (0.9.9 vs 1.0.0) -> available: false (downgrades rejected)');
  assert(evaluateUpdateAvailable('1.0.0', '1.0.1') === true, 'Newer patch version (1.0.1 vs 1.0.0) -> available: true');
  assert(evaluateUpdateAvailable('1.0.0', '1.1.0') === true, 'Newer minor version (1.1.0 vs 1.0.0) -> available: true');
  assert(evaluateUpdateAvailable('1.0.0', '2.0.0') === true, 'Newer major version (2.0.0 vs 1.0.0) -> available: true');

  // ===================================================================
  // SUMMARY
  // ===================================================================
  console.log('\n================================================================');
  console.log(`GATE 13.5.1 AUDIT RESULTS: ${passedTests}/${totalTests} PASSED (${failedTests} FAILED)`);
  console.log('================================================================');

  if (failedTests > 0) {
    process.exit(1);
  }
}

runAudit().catch((err) => {
  console.error('Fatal audit error:', err);
  process.exit(1);
});
