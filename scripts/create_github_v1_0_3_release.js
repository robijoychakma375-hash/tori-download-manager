const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { spawn, spawnSync, execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const STAGING_DIR = path.join(ROOT, 'release', 'v1.0.3-final');

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
  const isPublish = process.argv.includes('--publish');
  console.log(`=== TORI Download Manager v1.0.3 — GitHub Release Manager [${isPublish ? 'PUBLISH MODE' : 'DRAFT MODE'}] ===\n`);

  const token = await getGitHubToken();
  console.log('[AUTH] Verified GitHub token via Git Credential Manager');

  const headCommit = execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf8' }).trim();
  console.log(`[GIT] Target Source Commit: ${headCommit} (${headCommit.substring(0, 7)})`);

  const releaseNotesPath = path.join(STAGING_DIR, 'RELEASE_NOTES.md');
  const releaseNotes = fs.existsSync(releaseNotesPath) ? fs.readFileSync(releaseNotesPath, 'utf8') : 'TORI Download Manager v1.0.3 Production Release';

  // Check if draft or release already exists
  const listRes = await requestJson('GET', '/repos/robijoychakma375-hash/tori-download-manager/releases', {
    Authorization: `Bearer ${token}`
  });

  let existingRelease = null;
  if (Array.isArray(listRes.data)) {
    existingRelease = listRes.data.find(r => r.tag_name === 'v1.0.3' || r.name?.includes('v1.0.3'));
  }

  let releaseId;
  let uploadUrl;

  if (existingRelease) {
    console.log(`[FOUND] Existing release found: ID ${existingRelease.id} (Draft: ${existingRelease.draft})`);
    releaseId = existingRelease.id;
    uploadUrl = existingRelease.upload_url;
  } else {
    console.log('[CREATE] Creating new draft release v1.0.3...');
    const createRes = await requestJson('POST', '/repos/robijoychakma375-hash/tori-download-manager/releases', {
      Authorization: `Bearer ${token}`
    }, {
      tag_name: 'v1.0.3',
      target_commitish: headCommit,
      name: 'TORI Download Manager v1.0.3',
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

  // Get current assets
  const assetsRes = await requestJson('GET', `/repos/robijoychakma375-hash/tori-download-manager/releases/${releaseId}/assets`, {
    Authorization: `Bearer ${token}`
  });
  const currentAssets = Array.isArray(assetsRes.data) ? assetsRes.data : [];
  console.log(`[ASSETS] Current uploaded assets: ${currentAssets.length}`);

  // Determine files to upload from STAGING_DIR
  const stagedFiles = fs.readdirSync(STAGING_DIR).filter(f => !f.endsWith('.tmp'));
  for (const fileName of stagedFiles) {
    const filePath = path.join(STAGING_DIR, fileName);
    if (!fs.statSync(filePath).isFile()) continue;

    const existing = currentAssets.find(a => a.name === fileName);
    if (existing) {
      console.log(`  [SKIP] Asset already uploaded: ${fileName} (ID: ${existing.id})`);
      continue;
    }

    console.log(`  [UPLOAD] Uploading ${fileName} (${fs.statSync(filePath).size.toLocaleString()} bytes)...`);
    let contentType = 'application/octet-stream';
    if (fileName.endsWith('.exe')) contentType = 'application/vnd.microsoft.portable-executable';
    else if (fileName.endsWith('.sig') || fileName.endsWith('.txt') || fileName.endsWith('.md')) contentType = 'text/plain';
    else if (fileName.endsWith('.json')) contentType = 'application/json';
    else if (fileName.endsWith('.zip')) contentType = 'application/zip';
    else if (fileName.endsWith('.xpi')) contentType = 'application/x-xpinstall';

    const upRes = uploadAssetViaCurl(uploadUrl, filePath, fileName, contentType, token);
    if (upRes.status !== 201) {
      console.error(`  [FAIL] Error uploading ${fileName}: HTTP ${upRes.status}`);
      process.exit(1);
    }
    console.log(`  [PASS] Uploaded ${fileName} -> Asset ID: ${upRes.data.id}`);
  }

  // If publish requested, promote to latest
  if (isPublish) {
    console.log('\n[PUBLISH] Promoting draft release to Latest Stable...');
    const pubRes = await requestJson('PATCH', `/repos/robijoychakma375-hash/tori-download-manager/releases/${releaseId}`, {
      Authorization: `Bearer ${token}`
    }, {
      draft: false,
      make_latest: 'true'
    });

    if (pubRes.status !== 200) {
      console.error('[FAIL] Could not publish release:', pubRes.data);
      process.exit(1);
    }
    console.log(`[SUCCESS] TORI Download Manager v1.0.3 is now published as Latest Stable!`);
    console.log(`URL: ${pubRes.data.html_url}`);
  } else {
    console.log('\n[DRAFT COMPLETE] Release staged as Draft ID:', releaseId);
    console.log('To publish live after Firefox AMO signing is complete, run:');
    console.log('  node scripts/create_github_v1_0_3_release.js --publish');
  }
}

main().catch(err => {
  console.error('[FATAL ERROR]', err);
  process.exit(1);
});
