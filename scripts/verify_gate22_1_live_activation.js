/**
 * TORI Download Manager — Gate 22.1 Live Activation Verification Suite
 *
 * Verifies live production behavior of the auto-updater endpoint:
 * 1. Confirms latest.json is published as an asset on GitHub Release v1.0.2 (ID: 441473140).
 * 2. Confirms live redirect chain: /releases/latest/download/latest.json -> 302 -> /v1.0.2/latest.json -> 200 OK.
 * 3. Confirms live manifest payload content, version "1.0.2", and platform targets.
 * 4. Confirms live installer download URL resolves to the 117,073,652-byte production executable.
 * 5. Simulates real-world client check for v1.0.0, v1.0.1, and v1.0.2 against live GitHub endpoint.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const LOCAL_MANIFEST_PATH = path.join(PROJECT_ROOT, 'release', 'v1.0.2-final', 'latest.json');

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

function semverCompare(vA, vB) {
  const cleanA = vA.replace(/^v/, '');
  const cleanB = vB.replace(/^v/, '');
  const partsA = cleanA.split('.').map(Number);
  const partsB = cleanB.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const a = partsA[i] || 0;
    const b = partsB[i] || 0;
    if (a > b) return 1;
    if (a < b) return -1;
  }
  return 0;
}

async function main() {
  console.log('================================================================');
  console.log('TORI Download Manager — Gate 22.1 Live Activation Verification');
  console.log('================================================================\n');

  // 1. Live Assets on GitHub Release 441473140
  console.log('--- 1. Release Assets Audit (Release ID 441473140) ---');
  const assetsCurl = spawnSync('curl.exe', [
    '-s',
    'https://api.github.com/repos/robijoychakma375-hash/tori-download-manager/releases/441473140/assets',
    '-H', 'User-Agent: TORI-Live-Verifier',
  ], { encoding: 'utf8' });

  let assetsList = [];
  try {
    assetsList = JSON.parse(assetsCurl.stdout);
  } catch (e) {
    assert(false, `Failed to parse GitHub assets list: ${e.message}`);
  }

  assert(Array.isArray(assetsList) && assetsList.length === 11, `Release has exactly 11 published distribution assets (got: ${assetsList.length})`);

  const latestAsset = assetsList.find(a => a.name === 'latest.json');
  assert(latestAsset !== undefined, 'Asset "latest.json" is present on GitHub Release v1.0.2');
  assert(latestAsset && latestAsset.size > 0, `Asset "latest.json" has non-zero size (${latestAsset ? latestAsset.size : 0} bytes)`);

  // 2. Live HTTP Endpoint & Redirect Verification
  console.log('\n--- 2. Live Endpoint & Redirect Chain Verification ---');
  const liveUrl = 'https://github.com/robijoychakma375-hash/tori-download-manager/releases/latest/download/latest.json';

  const hop1Curl = spawnSync('curl.exe', ['-i', '-s', '--max-redirs', '0', liveUrl], { encoding: 'utf8' });
  assert(hop1Curl.stdout.includes('302 Found'), 'Hop 1: /releases/latest/download/latest.json returns HTTP 302 Found');

  const locMatch = hop1Curl.stdout.match(/Location:\s*(.*)/i);
  const redirectTarget = locMatch ? locMatch[1].trim() : '';
  assert(
    redirectTarget.includes('/releases/download/v1.0.2/latest.json'),
    `Hop 1: Correctly redirects to v1.0.2 tag (got: ${redirectTarget})`
  );

  const fullCurl = spawnSync('curl.exe', ['-s', '-L', liveUrl], { encoding: 'utf8' });
  let liveManifest = null;
  try {
    liveManifest = JSON.parse(fullCurl.stdout);
    assert(true, 'Full redirect chain resolves to valid JSON payload');
  } catch (e) {
    assert(false, `Failed to parse live manifest JSON: ${e.message}`);
  }

  // 3. Live Manifest Payload Audit
  console.log('\n--- 3. Live Manifest Content & Concordance Audit ---');
  assert(liveManifest && liveManifest.version === '1.0.2', `Live manifest version is "1.0.2" (got: ${liveManifest ? liveManifest.version : 'null'})`);
  assert(
    liveManifest && liveManifest.platforms && liveManifest.platforms['windows-x86_64'],
    'Live manifest provides "windows-x86_64" platform entry'
  );
  assert(
    liveManifest && liveManifest.platforms && liveManifest.platforms['windows-x86_64-nsis'],
    'Live manifest provides "windows-x86_64-nsis" platform entry'
  );

  const localRaw = fs.readFileSync(LOCAL_MANIFEST_PATH, 'utf8');
  const localManifest = JSON.parse(localRaw);
  assert(
    liveManifest.platforms['windows-x86_64'].signature === localManifest.platforms['windows-x86_64'].signature,
    'Live signature matches local Minisign signature bit-for-bit'
  );

  // 4. Live Installer Target Verification
  console.log('\n--- 4. Live Installer Asset Verification ---');
  const installerUrl = liveManifest.platforms['windows-x86_64'].url;
  console.log('  Probing live installer URL:', installerUrl);

  const installerCurl = spawnSync('curl.exe', ['-I', '-s', '-L', installerUrl], { encoding: 'utf8' });
  const hasContentLength = installerCurl.stdout.includes('content-length: 117073652') || installerCurl.stdout.includes('Content-Length: 117073652');
  assert(
    hasContentLength,
    'Live installer URL resolves to the verified 117,073,652-byte production binary'
  );

  // 5. Emulated Client Update Check
  console.log('\n--- 5. Real-World Client Check Simulation ---');
  function simulateLiveClient(clientVer) {
    const remoteVer = liveManifest.version;
    const isNewer = semverCompare(remoteVer, clientVer) > 0;
    return {
      clientVersion: clientVer,
      remoteVersion: remoteVer,
      updateAvailable: isNewer,
      status: isNewer ? 'available' : 'up_to_date',
    };
  }

  const v100Check = simulateLiveClient('1.0.0');
  assert(
    v100Check.updateAvailable === true && v100Check.status === 'available',
    'Installed v1.0.0 client hitting live endpoint detects update 1.0.2 available'
  );

  const v101Check = simulateLiveClient('1.0.1');
  assert(
    v101Check.updateAvailable === true && v101Check.status === 'available',
    'Installed v1.0.1 client hitting live endpoint detects update 1.0.2 available'
  );

  const v102Check = simulateLiveClient('1.0.2');
  assert(
    v102Check.updateAvailable === false && v102Check.status === 'up_to_date',
    'Installed v1.0.2 client hitting live endpoint reports "up_to_date" (no loop)'
  );

  // Summary
  console.log('\n================================================================');
  console.log(`GATE 22.1 LIVE VERIFICATION: ${passedTests}/${totalTests} PASSED (${failedTests} FAILED)`);
  console.log('================================================================');

  if (failedTests > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});

