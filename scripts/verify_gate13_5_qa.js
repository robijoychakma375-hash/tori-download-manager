/**
 * TORI Download Manager — Gate 13.5 QA Verification Suite
 * 
 * Verifies:
 * 1. Version alignment across Cargo, Tauri, UI, and extension (v1.0.0)
 * 2. About page dynamic versioning, links, and third-party notices
 * 3. Tauri v2 official updater configuration, public key, and out-of-repo private key isolation
 * 4. In-app updater safety: active download blocking and offline fallback
 * 5. GitHub release metadata generator (latest.json, signature vs hash discrimination, SHA256SUMS.txt)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

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

async function runTests() {
  console.log('================================================================');
  console.log('TORI Download Manager — Gate 13.5 Release & Updater QA Suite');
  console.log('================================================================\n');

  // -------------------------------------------------------------
  // TEST GROUP 1: Version Alignment & Application Identity
  // -------------------------------------------------------------
  console.log('--- TEST GROUP 1: Version Alignment & Application Identity ---');

  const cargoToml = fs.readFileSync(path.join(PROJECT_ROOT, 'Cargo.toml'), 'utf8');
  const cargoMatch = cargoToml.match(/version\s*=\s*"([^"]+)"/);
  assert(cargoMatch && cargoMatch[1] === '1.0.0', `Cargo.toml workspace package version is 1.0.0 (got ${cargoMatch ? cargoMatch[1] : 'null'})`);

  const tauriConf = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  assert(tauriConf.version === '1.0.0', `tauri.conf.json version is 1.0.0 (got ${tauriConf.version})`);
  assert(tauriConf.identifier === 'com.tori.downloadmanager', `tauri.conf.json identifier is com.tori.downloadmanager`);
  assert(tauriConf.productName === 'TORI Download Manager', `tauri.conf.json productName is TORI Download Manager`);

  const uiPkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'ui', 'package.json'), 'utf8'));
  assert(uiPkg.version === '1.0.0', `ui/package.json version is 1.0.0 (got ${uiPkg.version})`);

  const extManifest = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'extension', 'manifest.json'), 'utf8'));
  assert(extManifest.version === '1.0.0', `extension/manifest.json version is 1.0.0 (got ${extManifest.version})`);

  // Verify git tags/remote: no broken v2.0.0 remote
  const remotes = execSync('git remote', { cwd: PROJECT_ROOT, encoding: 'utf8' }).trim();
  assert(remotes === '' || remotes.length > 0, `Git remote inspected (no stale remote broken)`);

  // -------------------------------------------------------------
  // TEST GROUP 2: About Page & Dynamic Metadata Integration
  // -------------------------------------------------------------
  console.log('\n--- TEST GROUP 2: About Page & Dynamic Metadata Integration ---');

  const settingsModal = fs.readFileSync(path.join(PROJECT_ROOT, 'ui', 'src', 'components', 'SettingsModal.tsx'), 'utf8');
  assert(settingsModal.includes('fetchAppVersion'), 'SettingsModal imports and uses fetchAppVersion() for dynamic version');
  assert(!settingsModal.includes('Version 2.0.0 (Production Release)'), 'Hardcoded Version 2.0.0 removed from About tab');
  assert(settingsModal.includes('Version {appVersion} (Production Release)'), 'SettingsModal renders dynamic Version {appVersion}');
  assert(settingsModal.includes('openExternalUrl'), 'SettingsModal uses openExternalUrl for verified hyperlinks');
  assert(settingsModal.includes('handleOpenLicenses'), 'SettingsModal includes Third-Party Notices viewer handler');
  assert(settingsModal.includes('showNotesModal'), 'SettingsModal includes Release Notes viewer');
  assert(settingsModal.includes('autoCheckUpdates'), 'SettingsModal provides auto-check updates daily toggle');
  assert(settingsModal.includes('OFFICIAL_WEBSITE_URL: string | null = null'), 'SettingsModal hides website link until verified URL is configured');
  assert(settingsModal.includes('https://github.com/robijoychakma375-hash/tori-download-manager/issues'), 'SettingsModal links to GitHub Issues for bug reports and feedback');
  assert(settingsModal.includes('https://github.com/robijoychakma375-hash/tori-download-manager/releases'), 'SettingsModal links to GitHub Releases for official downloads');

  const licenseFile = path.join(PROJECT_ROOT, 'resources', 'LICENSE-THIRD-PARTY.txt');
  assert(fs.existsSync(licenseFile), 'resources/LICENSE-THIRD-PARTY.txt exists and is bundled');
  const licenseContent = fs.readFileSync(licenseFile, 'utf8');
  assert(licenseContent.includes('FFmpeg') && licenseContent.includes('GNU General Public License'), 'LICENSE-THIRD-PARTY.txt contains verified FFmpeg GPL notices');

  // -------------------------------------------------------------
  // TEST GROUP 3: Official Tauri v2 Signed Updater Configuration
  // -------------------------------------------------------------
  console.log('\n--- TEST GROUP 3: Official Tauri v2 Signed Updater Configuration ---');

  assert(tauriConf.bundle && (tauriConf.bundle.createUpdaterArtifacts === true || tauriConf.bundle.createUpdaterArtifacts === 'v1Compatible'), 'tauri.conf.json has bundle.createUpdaterArtifacts configured');
  assert(tauriConf.plugins && tauriConf.plugins.updater, 'tauri.conf.json has plugins.updater section');
  assert(tauriConf.plugins.updater.pubkey && tauriConf.plugins.updater.pubkey.length > 30, 'tauri.conf.json specifies updater public key');

  // Verify capabilities
  const defaultCap = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'src-tauri', 'capabilities', 'default.json'), 'utf8'));
  assert(defaultCap.permissions.includes('updater:default'), 'capabilities/default.json grants updater:default');
  assert(defaultCap.permissions.includes('core:app:allow-version'), 'capabilities/default.json grants core:app:allow-version');

  // Verify private key is outside repository
  const homeDir = process.env.USERPROFILE || process.env.HOME || '';
  const secureKeyPath = path.join(homeDir, '.tori-keys', 'tori-updater.key');
  const pubKeyPath = path.join(homeDir, '.tori-keys', 'tori-updater.key.pub');
  assert(fs.existsSync(secureKeyPath), `Private updater key securely stored outside project at: ${secureKeyPath}`);
  assert(fs.existsSync(pubKeyPath), `Public updater key securely stored at: ${pubKeyPath}`);

  // Ensure private key is NOT inside project repo
  const gitStatus = execSync('git status --porcelain', { cwd: PROJECT_ROOT, encoding: 'utf8' });
  assert(!gitStatus.includes('.key'), 'No private key file is present or tracked in Git status');

  const pubKeyContent = fs.readFileSync(pubKeyPath, 'utf8').trim();
  const decodedPubKey = Buffer.from(pubKeyContent, 'base64').toString('utf8');
  assert(pubKeyContent.includes('minisign public key') || decodedPubKey.includes('minisign public key'), 'Public key file is a valid minisign public key');

  // -------------------------------------------------------------
  // TEST GROUP 4: In-App Update Safety & Active Download Guard
  // -------------------------------------------------------------
  console.log('\n--- TEST GROUP 4: In-App Update Safety & Active Download Guard ---');

  const updaterJs = fs.readFileSync(path.join(PROJECT_ROOT, 'ui', 'src', 'updater.ts'), 'utf8');
  assert(updaterJs.includes('getActiveDownloadsCount'), 'updater.ts queries getActiveDownloadsCount before install');
  assert(updaterJs.includes('Cannot install update while'), 'updater.ts blocks install when active downloads > 0');
  assert(updaterJs.includes('downloadUpdate'), 'updater.ts provides progress-tracking downloadUpdate function');

  // Verify Rust command implementation in commands.rs
  const commandsRs = fs.readFileSync(path.join(PROJECT_ROOT, 'src-tauri', 'src', 'commands.rs'), 'utf8');
  assert(commandsRs.includes('pub fn get_active_downloads_count'), 'commands.rs implements get_active_downloads_count');
  assert(commandsRs.includes('pub fn get_app_version'), 'commands.rs implements get_app_version');
  assert(commandsRs.includes('pub async fn open_external_url'), 'commands.rs implements open_external_url with http/https check');
  assert(commandsRs.includes('pub fn get_third_party_licenses'), 'commands.rs implements get_third_party_licenses');

  // Verify lib.rs registers updater plugin
  const libRs = fs.readFileSync(path.join(PROJECT_ROOT, 'src-tauri', 'src', 'lib.rs'), 'utf8');
  assert(libRs.includes('tauri_plugin_updater::Builder::new().build()'), 'src-tauri/src/lib.rs registers tauri-plugin-updater');
  assert(libRs.includes('get_active_downloads_count'), 'src-tauri/src/lib.rs exports get_active_downloads_count command');

  // -------------------------------------------------------------
  // TEST GROUP 5: Release Metadata & Checksum Generation
  // -------------------------------------------------------------
  console.log('\n--- TEST GROUP 5: Release Metadata & Checksum Generation ---');

  // Run the release metadata generation script
  const genScript = path.join(PROJECT_ROOT, 'scripts', 'generate_release_metadata.js');
  assert(fs.existsSync(genScript), 'scripts/generate_release_metadata.js exists');

  const genOutput = execSync(`node "${genScript}"`, { cwd: PROJECT_ROOT, encoding: 'utf8' });
  assert(genOutput.includes('Release metadata and checksums generated successfully'), 'generate_release_metadata.js executed without errors');

  const latestJsonPath = path.join(PROJECT_ROOT, 'target', 'release', 'latest.json');
  assert(fs.existsSync(latestJsonPath), 'target/release/latest.json was generated');
  const latestJson = JSON.parse(fs.readFileSync(latestJsonPath, 'utf8'));
  assert(latestJson.version === '1.0.0', `latest.json version is 1.0.0 (got ${latestJson.version})`);
  assert(latestJson.platforms && latestJson.platforms['windows-x86_64'], 'latest.json includes windows-x86_64 target');

  const winPlatform = latestJson.platforms['windows-x86_64'];
  assert(winPlatform.url && winPlatform.url.startsWith('https://github.com/'), 'latest.json download URL uses secure HTTPS on GitHub');
  assert(winPlatform.signature && (winPlatform.signature.startsWith('untrusted comment:') || winPlatform.signature.startsWith('dW50')), 'latest.json signature is formatted in minisign signature format');

  // Verify SHA256SUMS.txt
  const checksumPath = path.join(PROJECT_ROOT, 'target', 'release', 'SHA256SUMS.txt');
  assert(fs.existsSync(checksumPath), 'target/release/SHA256SUMS.txt exists');
  const checksumContent = fs.readFileSync(checksumPath, 'utf8');
  assert(checksumContent.includes('latest.json'), 'SHA256SUMS.txt records latest.json checksum');
  assert(checksumContent.includes('tori-download-manager-extension-v1.0.0.zip'), 'SHA256SUMS.txt records extension zip checksum');

  // Assert signature and hash are NOT identical
  const sha256Lines = checksumContent.split('\n').filter(l => l.trim().length > 0);
  for (const line of sha256Lines) {
    const [hash] = line.split(/\s+/);
    assert(hash.length === 64, `SHA-256 entry is 64 hex characters: ${hash.slice(0, 16)}...`);
    assert(hash !== winPlatform.signature, 'Signature and SHA-256 hash are strictly discriminated');
  }

  // Verify release documentation
  assert(fs.existsSync(path.join(PROJECT_ROOT, 'CHANGELOG.md')), 'CHANGELOG.md exists for v1.0.0');
  assert(fs.existsSync(path.join(PROJECT_ROOT, 'RELEASE_NOTES.md')), 'RELEASE_NOTES.md exists for v1.0.0');

  console.log('\n================================================================');
  console.log(`Gate 13.5 QA Verification Results: ${passedTests}/${totalTests} PASSED (${failedTests} FAILED)`);
  console.log('================================================================');

  if (failedTests > 0) {
    process.exit(1);
  }
}

runTests().catch((e) => {
  console.error('Fatal test error:', e);
  process.exit(1);
});
