#!/usr/bin/env node
/**
 * TORI Download Manager — Gate 31.3 Extension v1.0.10 GitHub Release Publisher
 *
 * Publishes TORI Browser Companion v1.0.10 as an extension-only release.
 * Preserves Desktop v1.0.5 as the repository-wide Latest Stable release.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { spawn, spawnSync, execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RC_DIR = path.join(ROOT, 'release', 'v1.0.10-extension-rc');
const REPO = 'robijoychakma375-hash/tori-download-manager';
const TARGET_TAG = 'extension-v1.0.10';
const RELEASE_NAME = 'TORI Browser Companion v1.0.10';

function getGitHubToken() {
  return new Promise((resolve, reject) => {
    if (process.env.GITHUB_TOKEN) return resolve(process.env.GITHUB_TOKEN.trim());
    if (process.env.GH_TOKEN) return resolve(process.env.GH_TOKEN.trim());

    const proc = spawn('git', ['credential', 'fill']);
    proc.stdin.write('protocol=https\nhost=github.com\n\n');
    let out = '';
    proc.stdout.on('data', d => out += d);
    proc.on('close', () => {
      const line = out.split('\n').find(l => l.startsWith('password='));
      if (line) {
        resolve(line.substring('password='.length).trim());
      } else {
        reject(new Error('No GitHub credential found in Git Credential Manager'));
      }
    });
    proc.on('error', reject);
  });
}

function requestJson(method, urlPath, token, body) {
  return new Promise((resolve, reject) => {
    const postData = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const reqHeaders = {
      'User-Agent': 'TORI-Release-Manager',
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${token}`
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

function uploadAssetViaCurl(uploadUrlTemplate, filePath, fileName, contentType, token) {
  const cleanUrl = uploadUrlTemplate.replace(/\{.*?\}$/, '') + `?name=${encodeURIComponent(fileName)}`;
  const args = [
    '-s',
    '-w', '\n%{http_code}',
    '-X', 'POST',
    '-H', `Authorization: Bearer ${token}`,
    '-H', 'Accept: application/vnd.github+json',
    '-H', `Content-Type: ${contentType || 'application/octet-stream'}`,
    '--data-binary', `@${filePath}`,
    cleanUrl
  ];
  const res = spawnSync('curl.exe', args, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  if (res.error) throw res.error;
  const lines = res.stdout.trim().split('\n');
  const code = parseInt(lines[lines.length - 1], 10);
  const body = lines.slice(0, lines.length - 1).join('\n');
  let data = body;
  try { data = JSON.parse(body); } catch (_) {}
  return { status: code, data };
}

async function main() {
  console.log(`=== TORI Browser Companion v1.0.10 — Public GitHub Release ===\n`);

  const token = await getGitHubToken();
  console.log('[AUTH] Verified GitHub token via Git Credential Manager');

  const commitHash = execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf8' }).trim();
  console.log(`[GIT] Target Source Commit: ${commitHash}`);

  // Read release notes & install guidance
  const notesPath = path.join(RC_DIR, 'RELEASE_NOTES.md');
  const installPath = path.join(RC_DIR, 'INSTALLATION_AND_UPGRADE.md');
  let bodyContent = fs.existsSync(notesPath) ? fs.readFileSync(notesPath, 'utf8') : '';
  if (fs.existsSync(installPath)) {
    bodyContent += '\n\n---\n\n' + fs.readFileSync(installPath, 'utf8');
  }

  // Check if release exists
  const listRes = await requestJson('GET', `/repos/${REPO}/releases?per_page=20`, token);
  let existingRelease = null;
  if (Array.isArray(listRes.data)) {
    existingRelease = listRes.data.find(r => r.tag_name === TARGET_TAG);
  }

  let releaseId;
  let uploadUrl;

  if (existingRelease) {
    console.log(`[FOUND] Existing release found: ID ${existingRelease.id} (Draft: ${existingRelease.draft})`);
    releaseId = existingRelease.id;
    uploadUrl = existingRelease.upload_url;
  } else {
    console.log(`[CREATE] Creating draft release for tag ${TARGET_TAG}...`);
    const createRes = await requestJson('POST', `/repos/${REPO}/releases`, token, {
      tag_name: TARGET_TAG,
      target_commitish: commitHash,
      name: RELEASE_NAME,
      body: bodyContent,
      draft: true,
      prerelease: false,
      make_latest: "false"
    });

    if (createRes.status !== 201) {
      console.error('[FAIL] Could not create draft release:', createRes.data);
      process.exit(1);
    }
    releaseId = createRes.data.id;
    uploadUrl = createRes.data.upload_url;
    console.log(`[OK] Draft release created with ID: ${releaseId}`);
  }

  // Query existing assets
  const assetsRes = await requestJson('GET', `/repos/${REPO}/releases/${releaseId}/assets`, token);
  const currentAssets = Array.isArray(assetsRes.data) ? assetsRes.data : [];
  console.log(`[ASSETS] Currently attached assets: ${currentAssets.length}`);

  const assetsToUpload = [
    {
      name: 'tori-companion-v1.0.10-firefox-signed.xpi',
      path: path.join(RC_DIR, 'tori-companion-v1.0.10-firefox-signed.xpi'),
      contentType: 'application/x-xpinstall'
    },
    {
      name: 'tori-companion-v1.0.10-chromium.zip',
      path: path.join(RC_DIR, 'tori-companion-v1.0.10-chromium.zip'),
      contentType: 'application/zip'
    },
    {
      name: 'SHA256SUMS.txt',
      path: path.join(RC_DIR, 'SHA256SUMS.txt'),
      contentType: 'text/plain'
    },
    {
      name: 'RELEASE_NOTES.md',
      path: path.join(RC_DIR, 'RELEASE_NOTES.md'),
      contentType: 'text/markdown'
    },
    {
      name: 'INSTALLATION_AND_UPGRADE.md',
      path: path.join(RC_DIR, 'INSTALLATION_AND_UPGRADE.md'),
      contentType: 'text/markdown'
    }
  ];

  for (const asset of assetsToUpload) {
    if (!fs.existsSync(asset.path)) {
      console.error(`[MISSING] Asset file not found: ${asset.path}`);
      process.exit(1);
    }

    const existing = currentAssets.find(a => a.name === asset.name);
    if (existing) {
      console.log(`[DELETE] Removing stale asset: ${asset.name} (ID: ${existing.id})...`);
      await requestJson('DELETE', `/repos/${REPO}/releases/assets/${existing.id}`, token);
    }

    console.log(`[UPLOAD] Uploading ${asset.name} (${fs.statSync(asset.path).size} bytes)...`);
    const upRes = uploadAssetViaCurl(uploadUrl, asset.path, asset.name, asset.contentType, token);
    if (upRes.status !== 201) {
      console.error(`[FAIL] Failed to upload ${asset.name} (HTTP ${upRes.status}):`, upRes.data);
      process.exit(1);
    }
    console.log(`  -> Uploaded successfully (ID: ${upRes.data.id})`);
  }

  // Publish release with explicit make_latest: "false"
  console.log(`\n[PUBLISH] Publishing release ${releaseId} with make_latest: "false"...`);
  const pubRes = await requestJson('PATCH', `/repos/${REPO}/releases/${releaseId}`, token, {
    draft: false,
    prerelease: false,
    make_latest: "false"
  });

  if (pubRes.status !== 200) {
    console.error('[FAIL] Could not publish release:', pubRes.data);
    process.exit(1);
  }
  console.log(`[OK] Release published successfully! URL: ${pubRes.data.html_url}`);

  // CRITICAL SAFETY CHECK: Verify /releases/latest is STILL v1.0.5
  console.log('\n[AUDIT] Verifying repository Latest Stable release endpoint...');
  const latestRes = await requestJson('GET', `/repos/${REPO}/releases/latest`, token);
  console.log(`[AUDIT] Latest Release ID: ${latestRes.data.id}, Tag: ${latestRes.data.tag_name}, Name: ${latestRes.data.name}`);
  if (latestRes.data.tag_name !== 'v1.0.5') {
    console.error(`[FATAL REGRESSION] /releases/latest shifted to ${latestRes.data.tag_name}! Restoring v1.0.5 as latest...`);
    // Restore v1.0.5 as latest
    await requestJson('PATCH', `/repos/${REPO}/releases/449053824`, token, { make_latest: "true" });
    process.exit(1);
  }
  console.log('[OK] Desktop v1.0.5 remains the repository Latest Stable release!');
}

main().catch(err => {
  console.error('[ERROR]', err);
  process.exit(1);
});
