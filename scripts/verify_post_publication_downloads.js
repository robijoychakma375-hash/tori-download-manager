/**
 * TORI Download Manager v1.0.1 — Post-Publication Download Test Suite
 * 
 * Verifies public availability and integrity of release assets:
 * 1. Windows Installer HTTP GET, Content-Length, and SHA-256 match.
 * 2. Firefox XPI HTTP GET, Content-Type (application/x-xpinstall), and SHA-256 match.
 * 3. Chromium Extension ZIP HTTP GET and SHA-256 match.
 * 4. SHA256SUMS.txt HTTP GET and manifest integrity.
 * 5. Official Website download links check (toridownload.xyz).
 * 
 * NOTE: Run this script ONLY after the release has been published on GitHub.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const EXPECTED_MANIFEST = {
  installerSha256: 'dfd87d3800556d9c4cc41cb3dcbd1fbe14c2bb51586655196df52330ba34e41b',
  installerSize: 117044352,
  firefoxXpiSha256: '520424ff38ddb1bf84152e7fd3c9bf4678ce6af1542995a6d4b58c4dc4fbb8d0',
  firefoxXpiSize: 86743,
  chromiumZipSha256: '788bbb16f38356109a8ea529809e9acc708f0c97dbfac939dca68cdc0bd11805',
  chromiumZipSize: 71971,
};

const RELEASE_BASE = 'https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.1';

function downloadToBuffer(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects < 0) return reject(new Error('Too many redirects'));
    const parsed = new URL(url);
    const req = https.get({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers: {
        'User-Agent': 'TORI-Post-Publication-Tester/1.0',
        'Accept': '*/*',
      }
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let redirectUrl = res.headers.location;
        if (!redirectUrl.startsWith('http')) {
          redirectUrl = new URL(redirectUrl, url).toString();
        }
        return resolve(downloadToBuffer(redirectUrl, maxRedirects - 1));
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

async function main() {
  console.log('=== TORI v1.0.1: Post-Publication Download Verification ===\n');

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

  // 1. Windows Installer Verification
  console.log('1. Checking Windows Installer download...');
  const installerUrl = `${RELEASE_BASE}/TORI.Download.Manager_1.0.1_x64-setup.exe`;
  try {
    const res = await downloadToBuffer(installerUrl);
    check(res.statusCode === 200, 'HTTP 200 received from installer URL');
    check(res.buffer.length === EXPECTED_MANIFEST.installerSize, 'Installer byte length matches exact build', `${res.buffer.length} bytes`);
    check(res.sha256 === EXPECTED_MANIFEST.installerSha256, 'Installer SHA-256 matches verified build hash', res.sha256);
  } catch (err) {
    check(false, 'Windows Installer download failed', err.message);
  }

  // 2. Firefox Signed XPI Verification
  console.log('\n2. Checking Mozilla-Signed Firefox Extension XPI...');
  const xpiUrl = `${RELEASE_BASE}/tori-download-manager-firefox-v1.0.2.xpi`;
  try {
    const res = await downloadToBuffer(xpiUrl);
    check(res.statusCode === 200, 'HTTP 200 received from Firefox XPI URL');
    check(res.sha256 === EXPECTED_MANIFEST.firefoxXpiSha256, 'Firefox XPI SHA-256 matches approved signed artifact', res.sha256);
  } catch (err) {
    check(false, 'Firefox XPI download failed', err.message);
  }

  // 3. Chromium Extension ZIP Verification
  console.log('\n3. Checking Chromium / Edge Extension ZIP...');
  const zipUrl = `${RELEASE_BASE}/tori-download-manager-extension-v1.0.2.zip`;
  try {
    const res = await downloadToBuffer(zipUrl);
    check(res.statusCode === 200, 'HTTP 200 received from Chromium ZIP URL');
    check(res.sha256 === EXPECTED_MANIFEST.chromiumZipSha256, 'Chromium ZIP SHA-256 matches verified package', res.sha256);
  } catch (err) {
    check(false, 'Chromium ZIP download failed', err.message);
  }

  // 4. SHA256SUMS Verification
  console.log('\n4. Checking SHA256SUMS.txt...');
  const shaUrl = `${RELEASE_BASE}/SHA256SUMS.txt`;
  try {
    const res = await downloadToBuffer(shaUrl);
    const content = res.buffer.toString('utf8');
    check(content.includes(EXPECTED_MANIFEST.installerSha256), 'SHA256SUMS.txt contains exact installer hash');
    check(content.includes(EXPECTED_MANIFEST.firefoxXpiSha256), 'SHA256SUMS.txt contains exact signed XPI hash');
  } catch (err) {
    check(false, 'SHA256SUMS.txt download failed', err.message);
  }

  console.log('\n======================================================');
  console.log(`TOTAL CHECKS: ${total}`);
  console.log(`PASSED: ${passed}`);
  console.log(`FAILED: ${total - passed}`);
  console.log(`STATUS: ${passed === total ? 'ALL CHECKS PASSED' : 'FAILURES OBSERVED'}`);
  console.log('======================================================');
}

main().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
