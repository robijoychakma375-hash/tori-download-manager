const https = require('https');
const { spawn } = require('child_process');

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
      'User-Agent': 'TORI-Release-Promoter',
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

async function main() {
  const releaseId = 440552231;
  const token = await getGitHubToken();
  console.log(`[AUTH] Promoting Release ID ${releaseId} to LATEST STABLE...`);

  const res = await requestJson(
    'PATCH',
    `/repos/robijoychakma375-hash/tori-download-manager/releases/${releaseId}`,
    { 'Authorization': `token ${token}` },
    {
      draft: false,
      prerelease: false,
      make_latest: 'true'
    }
  );

  if (res.status === 200) {
    console.log('[PROMOTED] Successfully promoted TORI v1.0.1 to LATEST STABLE RELEASE!');
    console.log(`  HTML URL:     ${res.data.html_url}`);
    console.log(`  Tag:          ${res.data.tag_name}`);
    console.log(`  Target Commit:${res.data.target_commitish}`);
    console.log(`  Draft:        ${res.data.draft}`);
    console.log(`  Pre-release:  ${res.data.prerelease}`);
  } else {
    console.error(`[ERROR] Promotion failed with status ${res.status}:`, res.data);
    process.exit(1);
  }
}

if (process.argv.includes('--execute')) {
  main().catch(err => {
    console.error('Fatal error during release promotion:', err);
    process.exit(1);
  });
} else {
  console.log('Promotion script prepared. Run with --execute only after user approval.');
}

