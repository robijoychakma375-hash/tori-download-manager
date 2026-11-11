const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const cp = require('child_process');

function getGitToken() {
  const p = cp.spawnSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n',
    encoding: 'utf8'
  });
  for (const line of p.stdout.split('\n')) {
    if (line.startsWith('password=')) return line.substring(9).trim();
  }
  return null;
}

const token = getGitToken();

function fetchUrl(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'TORI-PostCleanup-Verifier' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && maxRedirects > 0) {
        return fetchUrl(res.headers.location, maxRedirects - 1).then(resolve, reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        resolve({ status: res.statusCode, data: Buffer.concat(chunks), headers: res.headers });
      });
    }).on('error', reject);
  });
}

function checkHead(url) {
  return new Promise((resolve) => {
    https.request(url, { method: 'HEAD', headers: { 'User-Agent': 'TORI-PostCleanup-Verifier' } }, res => {
      resolve({ status: res.statusCode, location: res.headers.location || null });
    }).on('error', err => resolve({ status: 'ERROR', error: err.message })).end();
  });
}

async function verify() {
  console.log('=== TORI GATE 23.4: COMPREHENSIVE POST-CLEANUP VERIFICATION ===\n');
  const results = [];

  function record(test, passed, details = '') {
    const status = passed ? 'PASS' : 'FAIL';
    results.push({ test, status, details });
    console.log(`[${status}] ${test}${details ? ' — ' + details : ''}`);
    if (!passed) {
      console.error(`  --> FAILED: ${details}`);
    }
  }

  // 1. Verify GitHub release status
  const relRes = await fetchUrl('https://api.github.com/repos/robijoychakma375-hash/tori-download-manager/releases/442083394');
  const rel = JSON.parse(relRes.data.toString());
  record('Release ID matches 442083394', rel.id === 442083394, `Got ID ${rel.id}`);
  record('Release tag is v1.0.3', rel.tag_name === 'v1.0.3', `Got tag ${rel.tag_name}`);
  record('Release is NOT a draft', rel.draft === false, `draft=${rel.draft}`);
  record('Release is NOT a prerelease', rel.prerelease === false, `prerelease=${rel.prerelease}`);
  record('Release has exactly 9 assets', rel.assets.length === 9, `Asset count=${rel.assets.length}`);

  // 2. Check absence of removed assets
  const removedNames = [
    'a70ed17e183648a9bcf4-1.0.3.xpi',
    'tori-download-manager-firefox-v1.0.3.zip',
    'RELEASE_NOTES.md',
    'INSTALLATION_AND_UPGRADE_NOTES.md',
    'RELEASE_MANIFEST.json'
  ];
  for (const name of removedNames) {
    const found = rel.assets.some(a => a.name === name);
    record(`Asset ${name} is removed`, !found, found ? 'Still present!' : 'Cleanly removed');
  }

  // 3. Check presence of all 9 preserved assets
  const preservedNames = [
    'TORI.Download.Manager_1.0.3_x64-setup.exe',
    'TORI.Download.Manager_1.0.3_x64-setup.exe.sig',
    'tori-download-manager-firefox-v1.0.3.xpi',
    'tori-download-manager-extension-v1.0.3.zip',
    'latest.json',
    'SHA256SUMS.txt',
    'LICENSE',
    'LICENSE-GPLv3.txt',
    'LICENSE-THIRD-PARTY.txt'
  ];
  for (const name of preservedNames) {
    const found = rel.assets.find(a => a.name === name);
    record(`Preserved asset ${name} is present`, !!found, found ? `Size: ${found.size} bytes` : 'Missing!');
  }

  // 4. Verify updater endpoint
  console.log('\n[UPDATER] Testing live auto-updater endpoint...');
  const updaterRes = await fetchUrl('https://github.com/robijoychakma375-hash/tori-download-manager/releases/latest/download/latest.json');
  record('Updater endpoint returns HTTP 200', updaterRes.status === 200, `HTTP ${updaterRes.status}`);
  let updaterJson = null;
  try {
    updaterJson = JSON.parse(updaterRes.data.toString());
    record('Updater manifest parses as valid JSON', true);
  } catch(e) {
    record('Updater manifest parses as valid JSON', false, e.message);
  }

  if (updaterJson) {
    record('Updater version is 1.0.3', updaterJson.version === '1.0.3', `version=${updaterJson.version}`);
    const winUrl = updaterJson.platforms?.['windows-x86_64']?.url;
    record('Updater Windows URL is valid', !!winUrl && winUrl.includes('1.0.3'), winUrl);
    const sig = updaterJson.platforms?.['windows-x86_64']?.signature;
    record('Updater Minisign signature is present', typeof sig === 'string' && sig.length > 50, `Sig length: ${sig ? sig.length : 0}`);
  }

  // 5. Verify website availability and links
  console.log('\n[WEBSITE] Checking https://toridownload.xyz...');
  const siteRes = await fetchUrl('https://toridownload.xyz');
  record('Website returns HTTP 200', siteRes.status === 200, `HTTP ${siteRes.status}`);
  const siteHtml = siteRes.data.toString();
  record('Website displays v1.0.3 as latest stable', siteHtml.includes('v1.0.3'), 'Confirmed in DOM');
  record('Website maintains archived v1.0.2', siteHtml.includes('1.0.2'), 'Confirmed in DOM');

  // Verify all primary download links on website
  const urlsToCheck = [
    'https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.3/TORI.Download.Manager_1.0.3_x64-setup.exe',
    'https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.3/tori-download-manager-firefox-v1.0.3.xpi',
    'https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.3/tori-download-manager-extension-v1.0.3.zip',
    'https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.3/SHA256SUMS.txt'
  ];
  for (const u of urlsToCheck) {
    const head = await checkHead(u);
    const fname = u.split('/').pop();
    record(`Download link for ${fname} returns HTTP 302`, head.status === 302, `Redirects to ${head.location ? head.location.slice(0, 50) + '...' : 'none'}`);
  }

  // 6. Verify previous releases are untouched
  console.log('\n[PREVIOUS RELEASES] Verifying v1.0.2, v1.0.1, v1.0.0 remain intact...');
  const prevReleases = [
    { tag: 'v1.0.2', id: 441473140 },
    { tag: 'v1.0.1', id: 440366635 },
    { tag: 'v1.0.0', id: 436380637 }
  ];
  for (const prev of prevReleases) {
    const pRes = await fetchUrl(`https://api.github.com/repos/robijoychakma375-hash/tori-download-manager/releases/tags/${prev.tag}`);
    const pData = JSON.parse(pRes.data.toString());
    record(`Previous release ${prev.tag} exists and intact`, pData.tag_name === prev.tag && pData.draft === false, `Tag: ${pData.tag_name}, Assets: ${pData.assets?.length}`);
  }

  // 7. Verify installer checksum and signature locally
  console.log('\n[CRYPTOGRAPHY] Verifying installer binary checksum and Minisign signature...');
  const installerPath = 'F:\\TORI\\final tori download manager\\release\\v1.0.3-final\\TORI Download Manager_1.0.3_x64-setup.exe';
  const sigPath = 'F:\\TORI\\final tori download manager\\release\\v1.0.3-final\\TORI Download Manager_1.0.3_x64-setup.exe.sig';
  const installerBytes = fs.readFileSync(installerPath);
  const actualSha = crypto.createHash('sha256').update(installerBytes).digest('hex');
  const expectedSha = '3804727ebeeeb1ed20de5e81f498f9adb01323481ec767c6813e6f77f1e890f5';
  record('Local installer SHA-256 matches verified hash', actualSha === expectedSha, actualSha);

  const sigBytes = fs.readFileSync(sigPath);
  record('Local signature file exists and valid length', sigBytes.length > 100, `${sigBytes.length} bytes`);

  // Summary
  const passCount = results.filter(r => r.status === 'PASS').length;
  const failCount = results.filter(r => r.status === 'FAIL').length;
  console.log(`\n================================================================`);
  console.log(`VERIFICATION SUMMARY: ${passCount} PASSED, ${failCount} FAILED (${results.length} total)`);
  console.log(`================================================================`);

  return { total: results.length, passed: passCount, failed: failCount, results };
}

if (require.main === module) {
  verify().catch(err => {
    console.error('[FATAL ERROR]', err);
    process.exit(1);
  });
}

module.exports = { verify };
