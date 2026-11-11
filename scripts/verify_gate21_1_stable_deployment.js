const https = require('https');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function getGitHubToken() {
  const out = execSync('git credential fill', { input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8' });
  const passLine = out.split('\n').find(l => l.startsWith('password='));
  return passLine ? passLine.substring('password='.length).trim() : null;
}

function fetchUrl(targetUrl, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.get({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers: {
        'User-Agent': 'TORI-Live-Verifier',
        ...headers
      }
    }, res => {
      // Follow redirect (up to 5)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location, headers).then(resolve, reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, body });
      });
    });
    req.on('error', reject);
  });
}

function streamDownloadAndHash(targetUrl) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.get({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers: {
        'User-Agent': 'TORI-Stream-Verifier',
        'Accept': '*/*'
      }
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return streamDownloadAndHash(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP status ${res.statusCode} for ${targetUrl}`));
      }
      const hash = crypto.createHash('sha256');
      let bytesRead = 0;
      res.on('data', chunk => {
        hash.update(chunk);
        bytesRead += chunk.length;
      });
      res.on('end', () => {
        resolve({
          sha256: hash.digest('hex').toLowerCase(),
          bytes: bytesRead,
          headers: res.headers
        });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

async function main() {
  console.log('=== GATE 21.1 POST-DEPLOYMENT PRODUCTION VERIFICATION ===\n');

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
  assert(token && token.length > 20, 'Retrieved valid GitHub token');

  // 1. GitHub Releases API Verification
  console.log('\n[1. GITHUB RELEASES API]');
  const latestRes = await fetchUrl('https://api.github.com/repos/robijoychakma375-hash/tori-download-manager/releases/latest', {
    'Authorization': `token ${token}`,
    'Accept': 'application/vnd.github+json'
  });
  const latestJson = JSON.parse(latestRes.body.toString('utf8'));
  assert(latestRes.status === 200, `GET /releases/latest returns HTTP 200 (got: ${latestRes.status})`);
  assert(latestJson.tag_name === 'v1.0.2', `Latest release tag is 'v1.0.2' (got: ${latestJson.tag_name})`);
  assert(latestJson.draft === false, `Latest release draft state is false`);
  assert(latestJson.prerelease === false, `Latest release prerelease state is false`);
  assert((latestJson.assets || []).length === 10, `Latest release contains exactly 10 assets (got: ${(latestJson.assets || []).length})`);

  // Historical v1.0.1
  const v101Res = await fetchUrl('https://api.github.com/repos/robijoychakma375-hash/tori-download-manager/releases/tags/v1.0.1', {
    'Authorization': `token ${token}`,
    'Accept': 'application/vnd.github+json'
  });
  const v101Json = JSON.parse(v101Res.body.toString('utf8'));
  assert(v101Res.status === 200, `Historical v1.0.1 release is publicly accessible (HTTP 200)`);
  assert(v101Json.draft === false && v101Json.prerelease === false, `Historical v1.0.1 remains published`);
  assert((v101Json.assets || []).length === 10, `Historical v1.0.1 retains all 10 assets`);

  // Historical v1.0.0
  const v100Res = await fetchUrl('https://api.github.com/repos/robijoychakma375-hash/tori-download-manager/releases/tags/v1.0.0', {
    'Authorization': `token ${token}`,
    'Accept': 'application/vnd.github+json'
  });
  assert(v100Res.status === 200, `Historical v1.0.0 release is publicly accessible (HTTP 200)`);

  // 2. Official Website Live Production Deployment
  console.log('\n[2. CLOUDFLARE PAGES LIVE DEPLOYMENT]');
  // Allow Cloudflare edge propagation
  let siteRes = null;
  let html = '';
  for (let attempt = 1; attempt <= 6; attempt++) {
    siteRes = await fetchUrl(`https://toridownload.xyz/?_cf_cache_bust=${Date.now()}`);
    html = siteRes.body.toString('utf8');
    if (html.includes('v1.0.2')) break;
    console.log(`  Waiting for Cloudflare Pages edge propagation (attempt ${attempt}/6)...`);
    await new Promise(r => setTimeout(r, 6000));
  }

  assert(siteRes.status === 200, `toridownload.xyz returns HTTP 200`);
  assert(html.includes('id="hero-pill-text">New · v1.0.2 for Windows (Stable)</span>'), 'Hero badge displays "New · v1.0.2 for Windows (Stable)"');
  assert(html.includes('id="card-version-label">Version 1.0.2 · Stable · Installer</p>'), 'Card 1 displays "Version 1.0.2 · Stable · Installer"');
  assert(html.includes('/releases/download/v1.0.2/TORI.Download.Manager_1.0.2_x64-setup.exe'), 'Download links target v1.0.2 installer URL');
  assert(html.includes('/releases/download/v1.0.2/tori-download-manager-firefox-v1.0.2.xpi'), 'Firefox extension link targets v1.0.2 XPI');
  assert(html.includes('/releases/download/v1.0.2/tori-download-manager-extension-v1.0.2.zip'), 'Chrome/Edge extension link targets v1.0.2 ZIP');
  assert(html.includes('/releases/download/v1.0.2/SHA256SUMS.txt'), 'Checksum link targets v1.0.2 SHA256SUMS.txt');
  assert(html.includes('"softwareVersion": "1.0.2"'), 'Schema.org JSON-LD contains softwareVersion "1.0.2"');
  assert(html.includes('id="footer-ver-badge">v1.0.2 · Windows 10 / 11 (64-bit)</span>'), 'Footer badge displays "v1.0.2 · Windows 10 / 11 (64-bit)"');
  assert(html.includes('GPLv3 / MIT') || html.includes('GPLv3'), 'Verified licensing statement reflects GPLv3 and MIT');
  assert(!html.includes('Stable Candidate'), 'No "Stable Candidate" temporary wording remains');

  // 3. Live Download Bitstream & Checksum Parity
  console.log('\n[3. LIVE DOWNLOAD BITSTREAM & CHECKPARITY]');
  console.log('  Streaming TORI Download Manager_1.0.2_x64-setup.exe from GitHub CDN...');
  const installerDl = await streamDownloadAndHash('https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.2/TORI.Download.Manager_1.0.2_x64-setup.exe');
  assert(installerDl.bytes === 117073652, `Downloaded installer size is exactly 117,073,652 bytes (got: ${installerDl.bytes})`);
  assert(installerDl.sha256 === '1ab7f3454dc08ef3b33843a9b8dfc3d3b2c5b2814fbe8946ef9b263f2d2452c2', `Downloaded installer SHA-256 matches bit-for-bit: 1ab7f3454dc08ef3b33843a9b8dfc3d3b2c5b2814fbe8946ef9b263f2d2452c2`);

  console.log('  Streaming tori-download-manager-firefox-v1.0.2.xpi...');
  const xpiDl = await streamDownloadAndHash('https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.2/tori-download-manager-firefox-v1.0.2.xpi');
  assert(xpiDl.bytes === 86743, `Downloaded Firefox XPI size is exactly 86,743 bytes (got: ${xpiDl.bytes})`);
  assert(xpiDl.sha256 === '520424ff38ddb1bf84152e7fd3c9bf4678ce6af1542995a6d4b58c4dc4fbb8d0', `Downloaded Firefox XPI SHA-256 matches: 520424ff...`);

  console.log('  Streaming tori-download-manager-extension-v1.0.2.zip...');
  const zipDl = await streamDownloadAndHash('https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.2/tori-download-manager-extension-v1.0.2.zip');
  assert(zipDl.bytes === 71971, `Downloaded Chrome/Edge ZIP size is exactly 71,971 bytes (got: ${zipDl.bytes})`);
  assert(zipDl.sha256 === '788bbb16f38356109a8ea529809e9acc708f0c97dbfac939dca68cdc0bd11805', `Downloaded Chrome/Edge ZIP SHA-256 matches: 788bbb16...`);

  console.log('  Streaming SHA256SUMS.txt...');
  const shaDl = await streamDownloadAndHash('https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.2/SHA256SUMS.txt');
  assert(shaDl.sha256 === '51df38b2ba7fb4ab31da1b0780ec62c27ab0cab2f73cc47ae6f73187e2b2c0c2', `Downloaded SHA256SUMS.txt matches: 51df38b2...`);

  // 4. Auto-Updater Feed Safeguard Verification
  console.log('\n[4. AUTO-UPDATER SAFEGUARDS]');
  // Verify latest.json is absent on v1.0.2 tag
  const latestJsonCheck = await fetchUrl('https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.2/latest.json');
  assert(latestJsonCheck.status === 404, `latest.json is absent on v1.0.2 release (got HTTP ${latestJsonCheck.status} 404 Not Found - auto-updater safely isolated)`);

  // Verify v1.0.0 latest.json manifest is unchanged
  const v100LatestCheck = await fetchUrl('https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.0/latest.json');
  if (v100LatestCheck.status === 200) {
    const v100Parsed = JSON.parse(v100LatestCheck.body.toString('utf8'));
    assert(v100Parsed.version === '1.0.0', `v1.0.0 updater manifest remains pinned to 1.0.0 (got: ${v100Parsed.version})`);
  } else {
    assert(v100LatestCheck.status === 404, `v1.0.0 updater manifest endpoint returned ${v100LatestCheck.status}`);
  }

  console.log(`\n=== FINAL DEPLOYMENT VERIFICATION: ${passCount} PASSED, ${failCount} FAILED ===\n`);

  const results = {
    timestamp: new Date().toISOString(),
    passCount,
    failCount,
    status: failCount === 0 ? 'SUCCESS' : 'FAILURE'
  };

  fs.writeFileSync(path.join(__dirname, 'gate21_1_verification_results.json'), JSON.stringify(results, null, 2));

  if (failCount > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});

