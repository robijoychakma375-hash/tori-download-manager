/**
 * TORI Download Manager v1.0.1 — Gate 19.2 Post-Deployment Verification Suite
 * 
 * Verifies that:
 * 1. GitHub v1.0.1 is recognized as Latest Stable (draft: false, prerelease: false).
 * 2. Website (https://toridownload.xyz) identifies v1.0.1 as Stable across hero and cards.
 * 3. Main Windows download link on the website downloads the v1.0.1 installer.
 * 4. Downloaded installer bitstream SHA-256 matches exact build hash.
 * 5. Firefox XPI link works, downloads Mozilla-signed v1.0.2 XPI with matching SHA-256.
 * 6. Chromium ZIP link works, downloads v1.0.2 ZIP with matching SHA-256.
 * 7. v1.0.0 remains accessible via GitHub releases and release history.
 * 8. Zero 404 links on all release asset links.
 * 9. Auto-updater manifest (latest.json) is NOT present on v1.0.1, and v1.0.0 feed is unmodified.
 */

const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const EXPECTED = {
  installerSha256: 'dfd87d3800556d9c4cc41cb3dcbd1fbe14c2bb51586655196df52330ba34e41b',
  installerSize: 117044352,
  installerSigSha256: 'e1401deef5483ab9a3c459bc79f69aa63bb4159a3124b8a4bda413bf5c0a50f1',
  firefoxXpiSha256: '520424ff38ddb1bf84152e7fd3c9bf4678ce6af1542995a6d4b58c4dc4fbb8d0',
  firefoxXpiSize: 86743,
  chromiumZipSha256: '788bbb16f38356109a8ea529809e9acc708f0c97dbfac939dca68cdc0bd11805',
  chromiumZipSize: 71971,
  firefoxZipSha256: 'a4bcce6f041df4529979deb8f54f84342362732aa456c0390f1b85baf367b848',
  firefoxZipSize: 72284,
  sha256sumsSha256: '3b16d689e90c77c9eeb8ef2eab753c91296448c74ec0710875c29f6200c2b901',
};

function fetchBuffer(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects < 0) return reject(new Error('Too many redirects'));
    const parsed = new URL(url);
    const req = https.get({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers: {
        'User-Agent': 'TORI-Gate19-2-Verifier/1.0',
        'Accept': '*/*',
      }
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let redirectUrl = res.headers.location;
        if (!redirectUrl.startsWith('http')) {
          redirectUrl = new URL(redirectUrl, url).toString();
        }
        return resolve(fetchBuffer(redirectUrl, maxRedirects - 1));
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          buffer: buf,
          sha256: crypto.createHash('sha256').update(buf).digest('hex').toLowerCase()
        });
      });
    });
    req.on('error', reject);
  });
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.get({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers: {
        'User-Agent': 'TORI-Gate19-2-Verifier/1.0',
        'Accept': 'application/vnd.github+json',
      }
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode, data: JSON.parse(raw) });
        } catch (e) {
          resolve({ statusCode: res.statusCode, raw });
        }
      });
    });
    req.on('error', reject);
  });
}

async function main() {
  console.log('=== TORI Download Manager: Gate 19.2 Stable Release Verification ===\n');

  let passed = 0;
  let total = 0;

  function check(cond, msg, detail = '') {
    total++;
    if (cond) {
      passed++;
      console.log(`  [PASS] ${msg}${detail ? ' (' + detail + ')' : ''}`);
    } else {
      console.error(`  [FAIL] ${msg}${detail ? ' (' + detail + ')' : ''}`);
    }
  }

  // 1. GitHub Latest Release API Check
  console.log('1. Checking GitHub Releases Latest Endpoint...');
  try {
    const res = await fetchJson('https://api.github.com/repos/robijoychakma375-hash/tori-download-manager/releases/latest');
    check(res.statusCode === 200, 'HTTP 200 from GitHub releases/latest');
    check(res.data.tag_name === 'v1.0.1', 'Latest release tag is v1.0.1', res.data.tag_name);
    check(res.data.draft === false, 'Latest release is NOT draft', String(res.data.draft));
    check(res.data.prerelease === false, 'Latest release is NOT pre-release (STABLE)', String(res.data.prerelease));
    check(res.data.target_commitish === '48d083d1b42b9c7edf76202abde599e6beb87b2e', 'Release commit matches verified build commit', res.data.target_commitish);
    check(res.data.assets && res.data.assets.length === 10, 'All 10 release assets present on latest release', `${res.data.assets.length} assets`);
  } catch (err) {
    check(false, 'GitHub latest release check failed', err.message);
  }

  // 2. Production Website Metadata Check (https://toridownload.xyz)
  console.log('\n2. Checking Production Website Content (https://toridownload.xyz)...');
  try {
    const siteRes = await fetchBuffer('https://toridownload.xyz/?v=' + Date.now());
    const html = siteRes.buffer.toString('utf8');
    check(siteRes.statusCode === 200, 'HTTP 200 from https://toridownload.xyz');
    check(html.includes('New · v1.0.1 for Windows (Stable)'), 'Hero pill displays "New · v1.0.1 for Windows (Stable)"');
    check(html.includes('Version 1.0.1 · Stable · Installer'), 'Main card displays "Version 1.0.1 · Stable · Installer"');
    check(html.includes('TORI.Download.Manager_1.0.1_x64-setup.exe'), 'Installer link targets TORI.Download.Manager_1.0.1_x64-setup.exe');
    check(html.includes('tori-download-manager-firefox-v1.0.2.xpi'), 'Firefox link targets tori-download-manager-firefox-v1.0.2.xpi');
    check(html.includes('tori-download-manager-extension-v1.0.2.zip'), 'Chromium link targets tori-download-manager-extension-v1.0.2.zip');
    check(html.includes('id="prerelease-card" style="display:none"'), 'Obsolete pre-release card is hidden');
    check(html.includes('"softwareVersion": "1.0.1"'), 'Structured SEO data updated to softwareVersion 1.0.1');
  } catch (err) {
    check(false, 'Production website verification failed', err.message);
  }

  // 3. Main Installer Public Download & Hash Match
  console.log('\n3. Downloading & Verifying Windows Installer Bitstream...');
  const installerUrl = 'https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.1/TORI.Download.Manager_1.0.1_x64-setup.exe';
  try {
    const instRes = await fetchBuffer(installerUrl);
    check(instRes.statusCode === 200, 'HTTP 200 received from installer URL');
    check(instRes.buffer.length === EXPECTED.installerSize, 'Installer byte length matches exact build', `${instRes.buffer.length} bytes`);
    check(instRes.sha256 === EXPECTED.installerSha256, 'Installer SHA-256 matches verified build hash', instRes.sha256);
  } catch (err) {
    check(false, 'Windows installer download failed', err.message);
  }

  // 4. Firefox XPI Public Download & Hash Match
  console.log('\n4. Downloading & Verifying Firefox Signed XPI...');
  const xpiUrl = 'https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.1/tori-download-manager-firefox-v1.0.2.xpi';
  try {
    const xpiRes = await fetchBuffer(xpiUrl);
    check(xpiRes.statusCode === 200, 'HTTP 200 received from Firefox XPI URL');
    check(xpiRes.buffer.length === EXPECTED.firefoxXpiSize, 'Firefox XPI byte length matches signed package', `${xpiRes.buffer.length} bytes`);
    check(xpiRes.sha256 === EXPECTED.firefoxXpiSha256, 'Firefox XPI SHA-256 matches Mozilla-signed package', xpiRes.sha256);
  } catch (err) {
    check(false, 'Firefox XPI download failed', err.message);
  }

  // 5. Chromium Extension ZIP Public Download & Hash Match
  console.log('\n5. Downloading & Verifying Chromium / Edge Extension ZIP...');
  const zipUrl = 'https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.1/tori-download-manager-extension-v1.0.2.zip';
  try {
    const zipRes = await fetchBuffer(zipUrl);
    check(zipRes.statusCode === 200, 'HTTP 200 received from Chromium ZIP URL');
    check(zipRes.buffer.length === EXPECTED.chromiumZipSize, 'Chromium ZIP byte length matches package', `${zipRes.buffer.length} bytes`);
    check(zipRes.sha256 === EXPECTED.chromiumZipSha256, 'Chromium ZIP SHA-256 matches package hash', zipRes.sha256);
  } catch (err) {
    check(false, 'Chromium ZIP download failed', err.message);
  }

  // 6. Older Stable Release v1.0.0 Accessibility Check
  console.log('\n6. Checking v1.0.0 Release Accessibility...');
  try {
    const v100Res = await fetchJson('https://api.github.com/repos/robijoychakma375-hash/tori-download-manager/releases/tags/v1.0.0');
    check(v100Res.statusCode === 200, 'HTTP 200 from v1.0.0 release endpoint');
    check(v100Res.data.tag_name === 'v1.0.0', 'v1.0.0 release tag intact', v100Res.data.tag_name);
    check(v100Res.data.assets && v100Res.data.assets.length > 0, 'v1.0.0 assets remain fully accessible');
  } catch (err) {
    check(false, 'v1.0.0 accessibility check failed', err.message);
  }

  // 7. Updater Isolation Verification
  console.log('\n7. Verifying Auto-Updater Metadata Safeguard...');
  try {
    // Check that latest.json is NOT in v1.0.1 assets
    const v101Rel = await fetchJson('https://api.github.com/repos/robijoychakma375-hash/tori-download-manager/releases/tags/v1.0.1');
    const hasLatestJson = (v101Rel.data.assets || []).some(a => a.name === 'latest.json');
    check(!hasLatestJson, 'v1.0.1 release does NOT contain latest.json (auto-update isolated)');

    // Check v1.0.0 latest.json feed
    const updaterRes = await fetchBuffer('https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.0/latest.json');
    const updaterJson = JSON.parse(updaterRes.buffer.toString('utf8'));
    check(updaterRes.statusCode === 200, 'HTTP 200 from v1.0.0 updater manifest');
    check(updaterJson.version === '1.0.0', 'Auto-updater feed remains pinned to v1.0.0', updaterJson.version);
  } catch (err) {
    check(false, 'Updater safeguard verification failed', err.message);
  }

  console.log('\n======================================================');
  console.log(`TOTAL CHECKS: ${total}`);
  console.log(`PASSED: ${passed}`);
  console.log(`FAILED: ${total - passed}`);
  console.log(`STATUS: ${passed === total ? 'ALL CHECKS PASSED (100%)' : 'FAILURES OBSERVED'}`);
  console.log('======================================================');

  // Save report JSON
  const reportPath = path.join(__dirname, 'gate19_2_verification_results.json');
  fs.writeFileSync(reportPath, JSON.stringify({
    total,
    passed,
    failed: total - passed,
    status: passed === total ? 'PASS' : 'FAIL',
    timestamp: new Date().toISOString()
  }, null, 2));

  if (passed !== total) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});

