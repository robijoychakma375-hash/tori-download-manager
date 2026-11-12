#!/usr/bin/env node
/**
 * TORI Download Manager — Gate 26.5
 * Publishes Desktop v1.0.4 as Latest Stable GitHub Release
 *
 * Repository: robijoychakma375-hash/tori-download-manager
 * Tag: v1.0.4
 * Commit: 591cfe471c80ad6156af7a0a742a56a0e16d985e
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { spawn, spawnSync, execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const STAGING_DIR = path.join(ROOT, 'release', 'v1.0.4-final');
const REPO = 'robijoychakma375-hash/tori-download-manager';

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

function requestJson(method, urlPath, headers, body) {
  return new Promise((resolve, reject) => {
    const postData = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const reqHeaders = {
      'User-Agent': 'TORI-Release-Publisher',
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
  console.log('========================================================================');
  console.log('TORI GATE 26.5: PUBLISH DESKTOP v1.0.4 STABLE RELEASE');
  console.log('========================================================================\n');

  const token = await getGitHubToken();
  console.log('[AUTH] Verified GitHub token via Git Credential Manager');

  const headCommit = execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf8' }).trim();
  console.log(`[GIT] Local HEAD Commit: ${headCommit}`);

  // Read release notes
  const releaseNotesPath = path.join(STAGING_DIR, 'RELEASE_NOTES.md');
  const releaseNotes = fs.readFileSync(releaseNotesPath, 'utf8');

  // Check if release already exists
  console.log(`[GITHUB] Checking existing releases for ${REPO}...`);
  const listRes = await requestJson('GET', `/repos/${REPO}/releases`, {
    Authorization: `Bearer ${token}`
  });

  let existingRelease = null;
  if (Array.isArray(listRes.data)) {
    existingRelease = listRes.data.find(r => r.tag_name === 'v1.0.4' || r.name === 'TORI Download Manager v1.0.4');
  }

  let releaseId;
  let uploadUrl;

  if (existingRelease) {
    console.log(`[EXISTS] Found existing release: ID ${existingRelease.id} (tag: ${existingRelease.tag_name}, draft: ${existingRelease.draft})`);
    releaseId = existingRelease.id;
    uploadUrl = existingRelease.upload_url;
  } else {
    console.log('[CREATE] Creating new draft release v1.0.4...');
    const createRes = await requestJson('POST', `/repos/${REPO}/releases`, {
      Authorization: `Bearer ${token}`
    }, {
      tag_name: 'v1.0.4',
      target_commitish: headCommit,
      name: 'TORI Download Manager v1.0.4',
      body: releaseNotes,
      draft: true,
      prerelease: false,
    });

    if (createRes.status !== 201) {
      console.error('[FAIL] Could not create draft release:', createRes.data);
      process.exit(1);
    }
    releaseId = createRes.data.id;
    uploadUrl = createRes.data.upload_url;
    console.log(`[OK] Draft release created with ID: ${releaseId}`);
  }

  // Fetch current assets
  const assetsRes = await requestJson('GET', `/repos/${REPO}/releases/${releaseId}/assets`, {
    Authorization: `Bearer ${token}`
  });
  const currentAssets = Array.isArray(assetsRes.data) ? assetsRes.data : [];
  console.log(`[ASSETS] Currently attached assets: ${currentAssets.length}`);

  const stagedFiles = fs.readdirSync(STAGING_DIR).filter(f => !f.endsWith('.tmp'));
  console.log(`[STAGING] Staged files to publish: ${stagedFiles.length}`);

  for (const fileName of stagedFiles) {
    const filePath = path.join(STAGING_DIR, fileName);
    if (!fs.statSync(filePath).isFile()) continue;

    const stat = fs.statSync(filePath);
    const existing = currentAssets.find(a => a.name === fileName);

    if (existing && existing.size === stat.size) {
      console.log(`  [SKIP] Asset already attached and size matches: ${fileName} (${stat.size} bytes, ID: ${existing.id})`);
      continue;
    } else if (existing) {
      console.log(`  [DELETE] Removing stale asset with mismatched size: ${fileName} (remote: ${existing.size}, local: ${stat.size})...`);
      await requestJson('DELETE', `/repos/${REPO}/releases/assets/${existing.id}`, {
        Authorization: `Bearer ${token}`
      });
    }

    console.log(`  [UPLOAD] Uploading ${fileName} (${stat.size.toLocaleString()} bytes)...`);
    let contentType = 'application/octet-stream';
    if (fileName.endsWith('.exe')) contentType = 'application/vnd.microsoft.portable-executable';
    else if (fileName.endsWith('.sig') || fileName.endsWith('.txt') || fileName.endsWith('.md')) contentType = 'text/plain';
    else if (fileName.endsWith('.json')) contentType = 'application/json';

    const upRes = uploadAssetViaCurl(uploadUrl, filePath, fileName, contentType, token);
    if (upRes.status !== 201) {
      console.error(`  [FAIL] Error uploading ${fileName}: HTTP ${upRes.status}`, upRes.data);
      process.exit(1);
    }
    console.log(`  [PASS] Uploaded ${fileName} -> Asset ID: ${upRes.data.id}`);
  }

  // Verify all staged files are attached
  console.log('\n[VERIFY] Verifying release assets count and sizes...');
  const finalAssetsRes = await requestJson('GET', `/repos/${REPO}/releases/${releaseId}/assets`, {
    Authorization: `Bearer ${token}`
  });
  const attached = finalAssetsRes.data || [];
  console.log(`[VERIFY] Total assets attached: ${attached.length} of ${stagedFiles.length}`);

  for (const fileName of stagedFiles) {
    const filePath = path.join(STAGING_DIR, fileName);
    const stat = fs.statSync(filePath);
    const match = attached.find(a => a.name === fileName);
    if (!match || match.size !== stat.size) {
      console.error(`[FATAL] Missing or mismatched asset: ${fileName}`, { expected: stat.size, actual: match?.size });
      process.exit(1);
    }
  }

  // Publish as Latest Stable
  console.log('\n[PUBLISH] Promoting release to Latest Stable (draft: false, prerelease: false, make_latest: true)...');
  const pubRes = await requestJson('PATCH', `/repos/${REPO}/releases/${releaseId}`, {
    Authorization: `Bearer ${token}`
  }, {
    tag_name: 'v1.0.4',
    name: 'TORI Download Manager v1.0.4',
    body: releaseNotes,
    draft: false,
    prerelease: false,
    make_latest: 'true'
  });

  if (pubRes.status !== 200) {
    console.error('[FAIL] Could not publish release:', pubRes.data);
    process.exit(1);
  }

  console.log('\n========================================================================');
  console.log('DESKTOP v1.0.4 STABLE RELEASE PUBLISHED SUCCESSFULLY!');
  console.log(`Release ID: ${pubRes.data.id}`);
  console.log(`Tag: ${pubRes.data.tag_name}`);
  console.log(`Release URL: ${pubRes.data.html_url}`);
  console.log(`Created At: ${pubRes.data.created_at}`);
  console.log(`Published At: ${pubRes.data.published_at}`);
  console.log('========================================================================\n');
}

main().catch(err => {
  console.error('[FATAL ERROR]', err);
  process.exit(1);
});

