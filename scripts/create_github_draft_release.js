const fs = require('fs');
const path = require('path');
const https = require('https');
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
    // uploadUrlTemplate format: https://uploads.github.com/repos/:owner/:repo/releases/:id/assets{?name,label}
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
  for (const item of stagedFiles) {
    const fullPath = path.join(STAGING_DIR, item.file);
    if (fs.existsSync(fullPath)) {
      const size = fs.statSync(fullPath).size;
      console.log(`  ✓ ${item.file.padEnd(45)} (${size.toLocaleString()} bytes)`);
    } else {
      console.error(`  ✗ MISSING: ${item.file}`);
    }
  }

  // Check if --execute flag is passed
  const shouldExecute = process.argv.includes('--execute');
  if (!shouldExecute) {
    console.log('\n[STANDBY] Dry-run complete. Draft release is prepared.');
    console.log('To execute draft creation upon user approval, run:');
    console.log('  git push origin dev/v1.0.1');
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

  // Upload Assets
  console.log('\n[UPLOADING ASSETS]');
  for (const item of stagedFiles) {
    const fullPath = path.join(STAGING_DIR, item.file);
    if (!fs.existsSync(fullPath)) continue;
    process.stdout.write(`  Uploading ${item.file}... `);
    const upRes = await uploadAsset(releaseData.upload_url, fullPath, item.file, item.type, token);
    if (upRes.status === 201) {
      console.log(`DONE (${upRes.data.browser_download_url})`);
    } else {
      console.log(`FAILED (${upRes.status}):`, upRes.data);
    }
  }

  console.log('\n=== DRAFT RELEASE CREATION COMPLETED SUCCESSFULLY ===');
  console.log(`Review draft at: ${releaseData.html_url}`);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
