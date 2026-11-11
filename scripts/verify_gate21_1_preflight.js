const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const STAGING_DIR = path.join(ROOT, 'release', 'v1.0.2-final');

function getGitHubToken() {
  const out = execSync('git credential fill', { input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8' });
  const passLine = out.split('\n').find(l => l.startsWith('password='));
  return passLine ? passLine.substring('password='.length).trim() : null;
}

function computeFileSha256(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex').toLowerCase();
}

function requestJson(method, urlPath, token) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.github.com',
      path: urlPath,
      method,
      headers: {
        'User-Agent': 'TORI-Preflight-Checker',
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github+json'
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        let json = d;
        try { json = JSON.parse(d); } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, data: json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  console.log('=== GATE 21.1 CRITICAL PREFLIGHT VERIFICATION ===\n');
  let passCount = 0;
  let failCount = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`  ✓ ${message}`);
      passCount++;
    } else {
      console.error(`  ✗ FAIL: ${message}`);
      failCount++;
    }
  }

  const token = getGitHubToken();
  assert(token && token.length > 20, 'Retrieved valid GitHub personal access token via GCM');

  // 1. Git branch and commit hashes
  const currentBranch = execSync('git branch --show-current', { cwd: ROOT, encoding: 'utf8' }).trim();
  const headCommit = execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf8' }).trim();
  assert(currentBranch === 'release/v1.0.2', `Current Git branch is 'release/v1.0.2' (got: ${currentBranch})`);
  assert(headCommit === 'c6ed19423ef4a777a4870fab09ba11f4269eb2d8', `Current HEAD commit is c6ed194 (got: ${headCommit.substring(0, 7)})`);

  // 2. Commit provenance: b2397fb vs c6ed194
  const buildCommit = 'b2397fb8cbaba152bf857560bf1db91468dedcfd';
  const diffTree = execSync(`git diff ${buildCommit}..${headCommit} -- Cargo.toml src-tauri/ tdm/ crates/ ui/src/ extension/`, { cwd: ROOT, encoding: 'utf8' }).trim();
  assert(diffTree === '', 'Source code and configuration are 100% identical between build commit b2397fb and HEAD c6ed194');

  // 3. Staged release files check
  const EXPECTED_HASHES = {
    'TORI Download Manager_1.0.2_x64-setup.exe': '1ab7f3454dc08ef3b33843a9b8dfc3d3b2c5b2814fbe8946ef9b263f2d2452c2',
    'TORI Download Manager_1.0.2_x64-setup.exe.sig': '936d40e044901e16e1e2caff0040fe24342f054949ecccd3198696070e4fad5c',
    'tori-download-manager-firefox-v1.0.2.xpi': '520424ff38ddb1bf84152e7fd3c9bf4678ce6af1542995a6d4b58c4dc4fbb8d0',
    'tori-download-manager-extension-v1.0.2.zip': '788bbb16f38356109a8ea529809e9acc708f0c97dbfac939dca68cdc0bd11805',
    'tori-download-manager-firefox-v1.0.2.zip': 'a4bcce6f041df4529979deb8f54f84342362732aa456c0390f1b85baf367b848',
    'SHA256SUMS.txt': '51df38b2ba7fb4ab31da1b0780ec62c27ab0cab2f73cc47ae6f73187e2b2c0c2',
    'RELEASE_NOTES.md': '162134ff455c9efe3af90c7089886b6ae4c7a1905eb151340423eb97f94c1445',
    'LICENSE-GPLv3.txt': '8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903',
    'LICENSE-THIRD-PARTY.txt': '4f05486cb940a151e9b010ff3d033b7fb06370c665d174eb5d54d48433eb6035',
    'RELEASE_MANIFEST.json': 'ddf60dc0eef6259e17cec30d6eb52d9785b3dd5e6b3d76a61acf5fb4a135da3d'
  };

  console.log('\n[LOCAL CHECKSUMS]');
  for (const [filename, expectedSha] of Object.entries(EXPECTED_HASHES)) {
    const fullPath = path.join(STAGING_DIR, filename);
    assert(fs.existsSync(fullPath), `Local staged file exists: ${filename}`);
    const actualSha = computeFileSha256(fullPath);
    assert(actualSha === expectedSha, `SHA-256 matches for ${filename} (${actualSha.substring(0, 16)}...)`);
  }

  // 4. Ed25519 Minisign Signature verification
  const cryptoVerify = execSync('cargo test -p tdm-core --test updater_cryptography_tests', { cwd: ROOT, encoding: 'utf8' });
  assert(cryptoVerify.includes('5 passed'), 'Updater Ed25519 cryptography test suite passed (5/5 PASS)');

  // 5. GitHub Draft Release ID 441473140 inspection
  console.log('\n[GITHUB DRAFT RELEASE 441473140]');
  const draftRes = await requestJson('GET', '/repos/robijoychakma375-hash/tori-download-manager/releases/441473140', token);
  assert(draftRes.status === 200, `GitHub release 441473140 exists (HTTP ${draftRes.status})`);
  const rel = draftRes.data;
  assert(rel.tag_name === 'v1.0.2', `Release tag is 'v1.0.2' (got: ${rel.tag_name})`);
  assert(rel.draft === true, `Release is currently in DRAFT state (draft: ${rel.draft})`);
  assert(rel.prerelease === false, `Release is NOT prerelease (prerelease: ${rel.prerelease})`);

  // Assets on draft release
  const assets = rel.assets || [];
  assert(assets.length === 10, `Release has exactly 10 uploaded assets (got: ${assets.length})`);

  for (const asset of assets) {
    assert(asset.state === 'uploaded', `Asset ${asset.name} is in 'uploaded' state`);
    assert(asset.size > 0, `Asset ${asset.name} size is > 0 (${asset.size} bytes)`);
  }

  // Check specific key assets
  const installerAsset = assets.find(a => a.name.endsWith('.exe') && !a.name.endsWith('.sig'));
  assert(installerAsset && installerAsset.size === 117073652, `Installer asset present with exact byte size 117,073,652 (got: ${installerAsset ? installerAsset.size : 'null'})`);

  const xpiAsset = assets.find(a => a.name.endsWith('.xpi'));
  assert(xpiAsset && xpiAsset.size === 86743, `Firefox XPI asset present with exact byte size 86,743 (got: ${xpiAsset ? xpiAsset.size : 'null'})`);

  // 6. Immutability of v1.0.1 tag and historical release
  console.log('\n[HISTORICAL RELEASE IMMUTABILITY]');
  const v101TagCommit = execSync('git rev-parse v1.0.1', { cwd: ROOT, encoding: 'utf8' }).trim();
  assert(v101TagCommit === '48d083d1b42b9c7edf76202abde599e6beb87b2e', `v1.0.1 tag is strictly anchored to commit 48d083d (got: ${v101TagCommit.substring(0, 7)})`);

  const v101Res = await requestJson('GET', '/repos/robijoychakma375-hash/tori-download-manager/releases/tags/v1.0.1', token);
  assert(v101Res.status === 200, `GitHub v1.0.1 release endpoint is public and healthy (HTTP ${v101Res.status})`);
  assert(v101Res.data.draft === false && v101Res.data.prerelease === false, 'v1.0.1 is published and non-draft');
  assert((v101Res.data.assets || []).length === 10, `v1.0.1 has all 10 historical assets intact (got: ${(v101Res.data.assets || []).length})`);

  console.log(`\n=== PREFLIGHT SUMMARY: ${passCount} PASSED, ${failCount} FAILED ===\n`);
  if (failCount > 0) {
    console.error('CRITICAL PREFLIGHT FAILED! Halting execution.');
    process.exit(1);
  } else {
    console.log('CRITICAL PREFLIGHT 100% PASSED. Ready for Step 2 publication.');
  }
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});

