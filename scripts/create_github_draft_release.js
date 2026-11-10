const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const STAGING_DIR = path.join(ROOT, 'release', 'v1.0.1-final');

function getGitHubToken() {
  return new Promise((resolve, reject) => {
    if (process.env.GITHUB_TOKEN) return resolve(process.env.GITHUB_TOKEN.trim());
    if (process.env.GH_TOKEN) return resolve(process.env.GH_TOKEN.trim());

    const proc = spawn('git', ['credential', 'fill']);
    proc.stdin.write('protocol=https\nhost=github.com\n\n');
    let out = '';
    proc.stdout.on('data', d => out += d);
    proc.on('close', code => {
      const lines = out.split('\n');
      const passLine = lines.find(l => l.startsWith('password='));
      if (passLine) {
        resolve(passLine.substring('password='.length).trim());
      } else {
        reject(new Error('No GitHub credential found in Git Credential Manager'));
      }
    });
    proc.on('error', reject);
  });
}

function computeFileSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', d => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex').toLowerCase()));
    stream.on('error', reject);
  });
}

function requestJson(method, urlPath, headers, body) {
  return new Promise((resolve, reject) => {
    const postData = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const reqHeaders = {
      'User-Agent': 'TORI-Release-Manager',
      'Accept': 'application/vnd.github+json',
      ...headers
    };
    if (postData) {
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = Buffer.byteLength(postData);
    }
    const req = https.request({
      hostname: 'api.github.com',
      path: urlPath,
      method,
      headers: reqHeaders,
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        let json = raw;
        try { json = JSON.parse(raw); } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, data: json });
      });
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

function uploadAsset(uploadUrlTemplate, filePath, fileName, contentType, token) {
  return new Promise((resolve, reject) => {
    const cleanUrl = uploadUrlTemplate.replace(/\{.*?\}$/, '') + `?name=${encodeURIComponent(fileName)}`;
    const parsed = new URL(cleanUrl);
    const fileBuf = fs.readFileSync(filePath);

    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'User-Agent': 'TORI-Release-Manager',
        'Authorization': `token ${token}`,
        'Content-Type': contentType,
        'Content-Length': fileBuf.length,
      }
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        let json = raw;
        try { json = JSON.parse(raw); } catch (_) {}
        resolve({ status: res.statusCode, data: json });
      });
    });
    req.on('error', reject);
    req.write(fileBuf);
    req.end();
  });
}

function downloadAndVerifyAsset(assetId, token, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    function fetchUrl(targetUrl, headers, redirectsLeft) {
      if (redirectsLeft < 0) return reject(new Error('Too many redirects'));
      const parsed = new URL(targetUrl);
      const req = https.get({
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        headers: headers
      }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // When redirected to storage (AWS S3), remove Authorization header to avoid signature rejection
          return fetchUrl(res.headers.location, { 'User-Agent': 'TORI-Release-Manager' }, redirectsLeft - 1);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`Download asset HTTP ${res.statusCode} from ${targetUrl}`));
        }
        const hash = crypto.createHash('sha256');
        let totalBytes = 0;
        res.on('data', chunk => {
          hash.update(chunk);
          totalBytes += chunk.length;
        });
        res.on('end', () => {
          resolve({
            size: totalBytes,
            sha256: hash.digest('hex').toLowerCase()
          });
        });
      });
      req.on('error', reject);
    }

    fetchUrl(
      `https://api.github.com/repos/robijoychakma375-hash/tori-download-manager/releases/assets/${assetId}`,
      {
        'User-Agent': 'TORI-Release-Manager',
        'Authorization': `token ${token}`,
        'Accept': 'application/octet-stream'
      },
      maxRedirects
    );
  });
}

async function main() {
  console.log('=== TORI Download Manager v1.0.1 — GitHub Pre-Release Preparation ===\n');

  const token = await getGitHubToken();
  console.log('[AUTH] Verified GitHub token via Git Credential Manager');

  const headCommit = execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf8' }).trim();
  console.log(`[GIT] Target Source Commit: ${headCommit} (${headCommit.substring(0, 7)})`);

  const releaseNotesPath = path.join(STAGING_DIR, 'RELEASE_NOTES.md');
  const releaseNotes = fs.existsSync(releaseNotesPath) ? fs.readFileSync(releaseNotesPath, 'utf8') : 'TORI Download Manager v1.0.1 Pre-release';

  console.log('\n[PLAN] Pre-Release Payload:');
  console.log(`  Repository: robijoychakma375-hash/tori-download-manager`);
  console.log(`  Tag: v1.0.1`);
  console.log(`  Title: TORI Download Manager v1.0.1`);
  console.log(`  Type: PRE-RELEASE (draft: true, prerelease: true)`);
  console.log(`  Target Commit: ${headCommit}`);

  const stagedFiles = [
    { file: 'TORI Download Manager_1.0.1_x64-setup.exe', type: 'application/vnd.microsoft.portable-executable' },
    { file: 'TORI Download Manager_1.0.1_x64-setup.exe.sig', type: 'text/plain' },
    { file: 'tori-download-manager-firefox-v1.0.2.xpi', type: 'application/x-xpinstall' },
    { file: 'tori-download-manager-extension-v1.0.2.zip', type: 'application/zip' },
    { file: 'tori-download-manager-firefox-v1.0.2.zip', type: 'application/zip' },
    { file: 'SHA256SUMS.txt', type: 'text/plain' },
    { file: 'RELEASE_NOTES.md', type: 'text/markdown' },
    { file: 'LICENSE-GPLv3.txt', type: 'text/plain' },
    { file: 'LICENSE-THIRD-PARTY.txt', type: 'text/plain' },
    { file: 'RELEASE_MANIFEST.json', type: 'application/json' },
  ];

  console.log('\n[ASSETS] Staged Assets for Draft Release:');
  const fileDetails = [];
  for (const item of stagedFiles) {
    const fullPath = path.join(STAGING_DIR, item.file);
    if (fs.existsSync(fullPath)) {
      const size = fs.statSync(fullPath).size;
      const sha256 = await computeFileSha256(fullPath);
      fileDetails.push({ ...item, fullPath, size, sha256 });
      console.log(`  ✓ ${item.file.padEnd(45)} (${size.toLocaleString().padStart(11)} bytes) | SHA-256: ${sha256}`);
    } else {
      console.error(`  ✗ MISSING: ${item.file}`);
      process.exit(1);
    }
  }

  // Check if --execute flag is passed
  const shouldExecute = process.argv.includes('--execute');
  if (!shouldExecute) {
    console.log('\n[STANDBY] Dry-run complete. Draft release is prepared.');
    console.log('To execute draft creation upon user approval, run:');
    console.log('  node scripts/create_github_draft_release.js --execute\n');
    return;
  }

  // Push commit to remote so target_commitish is recognized
  console.log('\n[GIT] Pushing dev/v1.0.1 to origin...');
  execSync('git push origin dev/v1.0.1', { cwd: ROOT, stdio: 'inherit' });

  // Create Draft Release
  console.log('\n[API] Creating draft release on GitHub...');
  const createRes = await requestJson(
    'POST',
    '/repos/robijoychakma375-hash/tori-download-manager/releases',
    { 'Authorization': `token ${token}` },
    {
      tag_name: 'v1.0.1',
      target_commitish: headCommit,
      name: 'TORI Download Manager v1.0.1',
      body: releaseNotes,
      draft: true,
      prerelease: true,
    }
  );

  if (createRes.status !== 201) {
    console.error('Failed to create release:', createRes.status, createRes.data);
    process.exit(1);
  }

  const releaseData = createRes.data;
  console.log(`[RELEASE CREATED] Draft Release ID: ${releaseData.id}`);
  console.log(`  HTML URL: ${releaseData.html_url}`);
  console.log(`  Upload URL: ${releaseData.upload_url}`);

  // Upload Assets and Verify SHA-256
  console.log('\n[UPLOADING & VERIFYING ASSETS]');
  const verificationResults = [];

  for (const item of fileDetails) {
    process.stdout.write(`  Uploading ${item.file}... `);
    const upRes = await uploadAsset(releaseData.upload_url, item.fullPath, item.file, item.type, token);
    if (upRes.status !== 201) {
      console.log(`FAILED (${upRes.status}):`, upRes.data);
      process.exit(1);
    }
    const assetId = upRes.data.id;
    const uploadedName = upRes.data.name;
    const downloadUrl = upRes.data.browser_download_url;
    process.stdout.write(`UPLOADED (ID: ${assetId}, Name: ${uploadedName}). Verifying SHA-256... `);

    // Download back from draft asset endpoint and verify hash
    const verified = await downloadAndVerifyAsset(assetId, token);
    const sizeMatch = verified.size === item.size;
    const hashMatch = verified.sha256 === item.sha256;

    if (sizeMatch && hashMatch) {
      console.log(`VERIFIED MATCH ✓`);
      verificationResults.push({
        file: item.file,
        uploadedName,
        assetId,
        size: verified.size,
        sha256: verified.sha256,
        status: 'VERIFIED',
        downloadUrl
      });
    } else {
      console.log(`FAILED HASH/SIZE MISMATCH!`);
      console.error(`    Expected: ${item.size} bytes, SHA256 ${item.sha256}`);
      console.error(`    Actual:   ${verified.size} bytes, SHA256 ${verified.sha256}`);
      process.exit(1);
    }
  }

  // Save verification results
  const resultJsonPath = path.join(ROOT, 'scripts', 'github_draft_verification_results.json');
  fs.writeFileSync(resultJsonPath, JSON.stringify({
    releaseId: releaseData.id,
    draftHtmlUrl: releaseData.html_url,
    tag: 'v1.0.1',
    targetCommit: headCommit,
    draft: true,
    prerelease: true,
    verifiedAssets: verificationResults,
    timestamp: new Date().toISOString()
  }, null, 2));

  console.log('\n=== DRAFT RELEASE CREATION & ASSET VERIFICATION COMPLETED ===');
  console.log(`Draft Release ID:  ${releaseData.id}`);
  console.log(`Draft Review URL:  ${releaseData.html_url}`);
  console.log(`Target Commit:     ${headCommit}`);
  console.log(`Verified Assets:   ${verificationResults.length}/10 uploaded and SHA-256 verified.`);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
