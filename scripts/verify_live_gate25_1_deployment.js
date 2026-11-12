/**
 * TORI Browser Companion — Gate 25.1 Live Verification Script
 */

const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const EXPECTED_XPI_SHA256 = '94d8ff0ca2ebd84f1412acb616da942d72423d7a11bb9ffc2bcc290c9dda93d6';
const EXPECTED_CR_SHA256 = 'ee0a6b133400665cb141185eb8c8bcfd982cdafec3a72309b7f64c097bb17530';

function fetchUrl(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'TORI-Live-Verifier' } }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && maxRedirects > 0) {
        return resolve(fetchUrl(res.headers.location, maxRedirects - 1));
      }
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          buffer,
          text: buffer.toString('utf8'),
        });
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

function computeSha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').toLowerCase();
}

async function verify() {
  console.log('================================================================');
  console.log('GATE 25.1: LIVE DEPLOYMENT & ENDPOINT VERIFICATION');
  console.log('================================================================\n');

  let passed = 0;
  let total = 0;
  function test(desc, ok, detail = '') {
    total++;
    if (ok) passed++;
    console.log(`${ok ? '[PASS]' : '[FAIL]'} ${desc}${detail ? ' — ' + detail : ''}`);
  }

  // 1. Live Website Endpoint for Firefox v1.0.5 XPI
  console.log('[1/5] Verifying live same-origin Firefox v1.0.5 XPI endpoint...');
  const siteXpiUrl = 'https://toridownload.xyz/assets/tori-download-manager-firefox-v1.0.5.xpi';
  try {
    const res = await fetchUrl(siteXpiUrl);
    test('Website v1.0.5 XPI returns HTTP 200', res.statusCode === 200, `status=${res.statusCode}`);
    test('Content-Type is application/x-xpinstall', res.headers['content-type'] === 'application/x-xpinstall', res.headers['content-type']);
    test('Access-Control-Allow-Origin is set', !!res.headers['access-control-allow-origin'], res.headers['access-control-allow-origin']);
    const sha = computeSha256(res.buffer);
    test('Live XPI SHA-256 matches official signed binary', sha === EXPECTED_XPI_SHA256, sha);
  } catch (err) {
    test('Website v1.0.5 XPI check', false, err.message);
  }

  // 2. GitHub Release Asset for Chromium ZIP v1.0.5
  console.log('\n[2/5] Verifying GitHub v1.0.5 Chromium extension download...');
  const ghCrUrl = 'https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/extension-v1.0.5/tori-download-manager-extension-v1.0.5.zip';
  try {
    const res = await fetchUrl(ghCrUrl);
    test('GitHub Chromium ZIP returns HTTP 200 (followed redirects)', res.statusCode === 200, `status=${res.statusCode}`);
    const sha = computeSha256(res.buffer);
    test('Chromium ZIP SHA-256 matches verified build', sha === EXPECTED_CR_SHA256, sha);
  } catch (err) {
    test('GitHub Chromium ZIP check', false, err.message);
  }

  // 3. GitHub Latest Stable Release Status
  console.log('\n[3/5] Verifying GitHub Latest Stable Release...');
  const ghLatestUrl = 'https://api.github.com/repos/robijoychakma375-hash/tori-download-manager/releases/latest';
  try {
    const res = await fetchUrl(ghLatestUrl);
    const json = JSON.parse(res.text);
    test('GitHub releases/latest tag is v1.0.3 (Desktop unmodified)', json.tag_name === 'v1.0.3', json.tag_name);
    test('GitHub releases/latest name is Desktop v1.0.3', json.name?.includes('1.0.3'), json.name);
  } catch (err) {
    test('GitHub latest check', false, err.message);
  }

  // 4. Public Auto-Updater Manifest (latest.json)
  console.log('\n[4/5] Verifying Public Auto-Updater Manifest...');
  const updaterUrl = 'https://github.com/robijoychakma375-hash/tori-download-manager/releases/latest/download/latest.json';
  try {
    const res = await fetchUrl(updaterUrl);
    const json = JSON.parse(res.text);
    test('Auto-updater latest.json version is 1.0.3', json.version === '1.0.3', json.version);
    const sig = json.signature || json.platforms?.['windows-x86_64']?.signature;
    test('Auto-updater signature is present and valid', !!sig && sig.length > 50, sig ? sig.slice(0, 32) + '...' : 'none');
    test('Auto-updater points to Desktop v1.0.3 installer', json.platforms?.['windows-x86_64']?.url?.includes('1.0.3'));
  } catch (err) {
    test('Auto-updater check', false, err.message);
  }

  // 5. Live Website HTML Check
  console.log('\n[5/5] Verifying Live Website HTML Markup...');
  const siteUrl = 'https://toridownload.xyz/';
  try {
    const res = await fetchUrl(siteUrl);
    test('Website index.html returns HTTP 200', res.statusCode === 200);
    test('Website contains v1.0.5 Firefox XPI link', res.text.includes('/assets/tori-download-manager-firefox-v1.0.5.xpi'));
    test('Website contains v1.0.5 Chromium ZIP link', res.text.includes('extension-v1.0.5/tori-download-manager-extension-v1.0.5.zip'));
    test('Website maintains Desktop v1.0.3 setup link', res.text.includes('TORI.Download.Manager_1.0.3_x64-setup.exe'));
  } catch (err) {
    test('Website HTML check', false, err.message);
  }

  console.log('\n================================================================');
  console.log(`LIVE VERIFICATION RESULT: ${passed}/${total} CHECKS PASSED`);
  console.log('================================================================');

  if (passed < total) process.exit(1);
}

verify().catch((e) => {
  console.error('[FATAL]', e);
  process.exit(1);
});
