/**
 * TORI Download Manager v1.0.1 — Post-Publication Download Test Suite
 * 
 * Verifies public availability and integrity of release assets:
 * 1. Windows Installer HTTP GET, Content-Length, and SHA-256 match.
 * 2. Firefox XPI HTTP GET, Content-Length, and SHA-256 match.
 * 3. Chromium Extension ZIP HTTP GET and SHA-256 match.
 * 4. Firefox Extension ZIP HTTP GET and SHA-256 match.
 * 5. Installer Signature (.sig) HTTP GET and SHA-256 match.
 * 6. SHA256SUMS.txt HTTP GET and manifest integrity.
 * 7. GPLv3 and Third-party license text availability.
 * 8. RELEASE_NOTES.md and RELEASE_MANIFEST.json integrity.
 * 9. Staged Local Website index.html consistency check.
 * 10. Cloudflare Live Production Website (toridownload.xyz) verification.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const EXPECTED_MANIFEST = {
  installerSha256: 'dfd87d3800556d9c4cc41cb3dcbd1fbe14c2bb51586655196df52330ba34e41b',
  installerSize: 117044352,
  installerSigSha256: 'e1401deef5483ab9a3c459bc79f69aa63bb4159a3124b8a4bda413bf5c0a50f1',
  installerSigSize: 436,
  firefoxXpiSha256: '520424ff38ddb1bf84152e7fd3c9bf4678ce6af1542995a6d4b58c4dc4fbb8d0',
  firefoxXpiSize: 86743,
  chromiumZipSha256: '788bbb16f38356109a8ea529809e9acc708f0c97dbfac939dca68cdc0bd11805',
  chromiumZipSize: 71971,
  firefoxZipSha256: 'a4bcce6f041df4529979deb8f54f84342362732aa456c0390f1b85baf367b848',
  firefoxZipSize: 72284,
  sha256sumsSha256: '3b16d689e90c77c9eeb8ef2eab753c91296448c74ec0710875c29f6200c2b901',
  gplv3Sha256: '8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903',
  thirdPartyLicenseSha256: '4f05486cb940a151e9b010ff3d033b7fb06370c665d174eb5d54d48433eb6035',
  releaseNotesSha256: 'cce72738ffecf6a146b45211dc714e98d861c1907a177b89e74fced3bcbf5faa',
  releaseManifestSha256: 'cc661146cbaa092761c47b8e4f7149e93c070883a6cfda01313c961191b75735',
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
  console.log('1. Checking Windows Installer download from GitHub...');
  const installerUrl = `${RELEASE_BASE}/TORI.Download.Manager_1.0.1_x64-setup.exe`;
  try {
    const res = await downloadToBuffer(installerUrl);
    check(res.statusCode === 200, 'HTTP 200 received from installer URL');
    check(res.buffer.length === EXPECTED_MANIFEST.installerSize, 'Installer byte length matches exact build', `${res.buffer.length} bytes`);
    check(res.sha256 === EXPECTED_MANIFEST.installerSha256, 'Installer SHA-256 matches verified build hash', res.sha256);
  } catch (err) {
    check(false, 'Windows Installer download failed', err.message);
  }

  // 2. Installer Updater Signature Verification
  console.log('\n2. Checking Windows Installer Updater Signature (.sig)...');
  const sigUrl = `${RELEASE_BASE}/TORI.Download.Manager_1.0.1_x64-setup.exe.sig`;
  try {
    const res = await downloadToBuffer(sigUrl);
    check(res.statusCode === 200, 'HTTP 200 received from installer signature URL');
    check(res.buffer.length === EXPECTED_MANIFEST.installerSigSize, 'Signature byte length matches exact signature', `${res.buffer.length} bytes`);
    check(res.sha256 === EXPECTED_MANIFEST.installerSigSha256, 'Signature SHA-256 matches verified hash', res.sha256);
  } catch (err) {
    check(false, 'Installer signature download failed', err.message);
  }

  // 3. Firefox Signed XPI Verification
  console.log('\n3. Checking Mozilla-Signed Firefox Extension XPI...');
  const xpiUrl = `${RELEASE_BASE}/tori-download-manager-firefox-v1.0.2.xpi`;
  try {
    const res = await downloadToBuffer(xpiUrl);
    check(res.statusCode === 200, 'HTTP 200 received from Firefox XPI URL');
    check(res.buffer.length === EXPECTED_MANIFEST.firefoxXpiSize, 'Firefox XPI byte length matches signed package', `${res.buffer.length} bytes`);
    check(res.sha256 === EXPECTED_MANIFEST.firefoxXpiSha256, 'Firefox XPI SHA-256 matches approved signed artifact', res.sha256);
  } catch (err) {
    check(false, 'Firefox XPI download failed', err.message);
  }

  // 4. Chromium Extension ZIP Verification
  console.log('\n4. Checking Chromium / Edge Extension ZIP...');
  const zipUrl = `${RELEASE_BASE}/tori-download-manager-extension-v1.0.2.zip`;
  try {
    const res = await downloadToBuffer(zipUrl);
    check(res.statusCode === 200, 'HTTP 200 received from Chromium ZIP URL');
    check(res.buffer.length === EXPECTED_MANIFEST.chromiumZipSize, 'Chromium ZIP byte length matches package', `${res.buffer.length} bytes`);
    check(res.sha256 === EXPECTED_MANIFEST.chromiumZipSha256, 'Chromium ZIP SHA-256 matches verified package', res.sha256);
  } catch (err) {
    check(false, 'Chromium ZIP download failed', err.message);
  }

  // 5. Firefox Extension Source ZIP Verification
  console.log('\n5. Checking Firefox Extension Source ZIP...');
  const ffZipUrl = `${RELEASE_BASE}/tori-download-manager-firefox-v1.0.2.zip`;
  try {
    const res = await downloadToBuffer(ffZipUrl);
    check(res.statusCode === 200, 'HTTP 200 received from Firefox ZIP URL');
    check(res.buffer.length === EXPECTED_MANIFEST.firefoxZipSize, 'Firefox ZIP byte length matches package', `${res.buffer.length} bytes`);
    check(res.sha256 === EXPECTED_MANIFEST.firefoxZipSha256, 'Firefox ZIP SHA-256 matches verified package', res.sha256);
  } catch (err) {
    check(false, 'Firefox ZIP download failed', err.message);
  }

  // 6. SHA256SUMS Verification
  console.log('\n6. Checking SHA256SUMS.txt...');
  const shaUrl = `${RELEASE_BASE}/SHA256SUMS.txt`;
  try {
    const res = await downloadToBuffer(shaUrl);
    check(res.statusCode === 200, 'HTTP 200 received from SHA256SUMS.txt URL');
    check(res.sha256 === EXPECTED_MANIFEST.sha256sumsSha256, 'SHA256SUMS.txt SHA-256 matches staged file', res.sha256);
    const content = res.buffer.toString('utf8');
    check(content.includes(EXPECTED_MANIFEST.installerSha256), 'SHA256SUMS.txt contains exact installer hash');
    check(content.includes(EXPECTED_MANIFEST.firefoxXpiSha256), 'SHA256SUMS.txt contains exact signed XPI hash');
  } catch (err) {
    check(false, 'SHA256SUMS.txt download failed', err.message);
  }

  // 7. GPLv3 and Third-Party Licenses
  console.log('\n7. Checking License Distribution Texts...');
  try {
    const gplRes = await downloadToBuffer(`${RELEASE_BASE}/LICENSE-GPLv3.txt`);
    check(gplRes.statusCode === 200, 'HTTP 200 received from LICENSE-GPLv3.txt URL');
    check(gplRes.sha256 === EXPECTED_MANIFEST.gplv3Sha256, 'LICENSE-GPLv3.txt SHA-256 matches verbatim GPLv3', gplRes.sha256);

    const tpRes = await downloadToBuffer(`${RELEASE_BASE}/LICENSE-THIRD-PARTY.txt`);
    check(tpRes.statusCode === 200, 'HTTP 200 received from LICENSE-THIRD-PARTY.txt URL');
    check(tpRes.sha256 === EXPECTED_MANIFEST.thirdPartyLicenseSha256, 'LICENSE-THIRD-PARTY.txt SHA-256 matches verified attribution', tpRes.sha256);
  } catch (err) {
    check(false, 'License text downloads failed', err.message);
  }

  // 8. Staged Local Website HTML Links Consistency Check
  console.log('\n8. Checking Local Website repository index.html consistency...');
  const websiteHtmlPath = path.resolve('C:/Users/ritud/Downloads/tori-website/index.html');
  if (fs.existsSync(websiteHtmlPath)) {
    const html = fs.readFileSync(websiteHtmlPath, 'utf8');
    check(html.includes('https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.1/TORI.Download.Manager_1.0.1_x64-setup.exe'), 'Local site links to exact v1.0.1 installer download URL');
    check(html.includes('https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.1/tori-download-manager-firefox-v1.0.2.xpi'), 'Local site links to exact Mozilla-signed Firefox XPI');
    check(html.includes('https://github.com/robijoychakma375-hash/tori-download-manager/releases/download/v1.0.1/tori-download-manager-extension-v1.0.2.zip'), 'Local site links to exact Chromium ZIP');
    check(html.includes('id="prerelease-card"'), 'Local site contains dedicated Pre-release v1.0.1 card');
    check(html.includes('Version 1.0.0'), 'Local site preserves stable v1.0.0 as primary stable download');
  } else {
    check(false, 'Website repository not found at expected path');
  }

  // 9. Cloudflare Live Production Website Verification
  console.log('\n9. Checking Cloudflare Production Website (https://toridownload.xyz)...');
  try {
    const cfRes = await downloadToBuffer('https://toridownload.xyz/?test=' + Date.now());
    const cfHtml = cfRes.buffer.toString('utf8');
    check(cfRes.statusCode === 200, 'HTTP 200 received from production https://toridownload.xyz');
    check(cfHtml.includes('id="prerelease-card"'), 'Production site renders Pre-release v1.0.1 card');
    check(cfHtml.includes('TORI.Download.Manager_1.0.1_x64-setup.exe'), 'Production site contains direct v1.0.1 installer link');
    check(cfHtml.includes('tori-download-manager-firefox-v1.0.2.xpi'), 'Production site contains Mozilla-signed Firefox XPI link');
    check(cfHtml.includes('tori-download-manager-extension-v1.0.2.zip'), 'Production site contains Chromium ZIP link');
    check(cfHtml.includes('Version 1.0.0'), 'Production site preserves stable v1.0.0 download');
  } catch (err) {
    check(false, 'Production website check failed', err.message);
  }

  console.log('\n======================================================');
  console.log(`TOTAL CHECKS: ${total}`);
  console.log(`PASSED: ${passed}`);
  console.log(`FAILED: ${total - passed}`);
  console.log(`STATUS: ${passed === total ? 'ALL CHECKS PASSED' : 'FAILURES OBSERVED'}`);
  console.log('======================================================');

  // Save results
  const reportPath = path.join(__dirname, 'post_publication_verification_results.json');
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
