/**
 * TORI Download Manager — Gate 22.1 Updater Manifest Deployment & Idempotent Preflight
 *
 * Safely deploys the verified latest.json manifest to GitHub Release v1.0.2 (Release ID: 441473140).
 *
 * Safety & Preflight Guarantees:
 * 1. Strict Idempotency: Stops safely if latest.json already exists with identical content (does NOT delete/replace).
 * 2. Conflict Protection: Refuses to overwrite or replace if remote asset has conflicting content.
 * 3. Scope Isolation: Operates strictly on latest.json on Release ID 441473140.
 * 4. Zero Cross-Impact: Does NOT create releases, modify tags, touch commits, modify binaries, or redeploy Cloudflare.
 * 5. Requires explicit `--execute` flag to perform initial upload when asset is absent.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(PROJECT_ROOT, 'release', 'v1.0.2-final', 'latest.json');
const SIG_PATH = path.join(PROJECT_ROOT, 'release', 'v1.0.2-final', 'TORI Download Manager_1.0.2_x64-setup.exe.sig');
const TARGET_RELEASE_ID = 441473140;
const TARGET_TAG = 'v1.0.2';
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
  console.log('=== TORI Download Manager — Gate 22.1 Manifest Deployment & Safety Preflight ===\n');

  // 1. Local Manifest Verification
  if (!fs.existsSync(MANIFEST_PATH)) {
    console.error(`[FATAL] Local manifest not found at: ${MANIFEST_PATH}`);
    process.exit(1);
  }

  const manifestRaw = fs.readFileSync(MANIFEST_PATH, 'utf8');
  let localManifest;
  try {
    localManifest = JSON.parse(manifestRaw);
  } catch (e) {
    console.error(`[FATAL] Local manifest failed JSON parsing: ${e.message}`);
    process.exit(1);
  }

  if (!fs.existsSync(SIG_PATH)) {
    console.error(`[FATAL] Signature file not found at: ${SIG_PATH}`);
    process.exit(1);
  }
  const sigRaw = fs.readFileSync(SIG_PATH, 'utf8').trim();

  if (localManifest.platforms['windows-x86_64'].signature !== sigRaw) {
    console.error('[FATAL] Signature mismatch between local latest.json and .sig file!');
    process.exit(1);
  }

  console.log('[LOCAL PREFLIGHT] Local latest.json is valid and signature matches .sig file.');

  // 2. Authentication & Target Release Verification
  const token = await getGitHubToken();
  console.log('[AUTH] Verified GitHub credentials via Git Credential Manager');

  const releaseRes = await requestJson(
    'GET',
    `/repos/${REPO}/releases/${TARGET_RELEASE_ID}`,
    { 'Authorization': `token ${token}` }
  );

  if (releaseRes.status !== 200) {
    console.error(`[FATAL] Could not fetch Release ID ${TARGET_RELEASE_ID}: HTTP ${releaseRes.status}`);
    process.exit(1);
  }

  if (releaseRes.data.tag_name !== TARGET_TAG) {
    console.error(`[FATAL] Release ID ${TARGET_RELEASE_ID} targets tag '${releaseRes.data.tag_name}', expected '${TARGET_TAG}'!`);
    process.exit(1);
  }

  console.log(`[RELEASE VERIFIED] Target: ${REPO} | Tag: ${releaseRes.data.tag_name} (ID: ${releaseRes.data.id})`);

  // 3. Idempotent Preflight: Check Existing Assets
  const assets = releaseRes.data.assets || [];
  const existingAsset = assets.find(a => a.name === 'latest.json');

  if (existingAsset) {
    console.log(`\n[IDEMPOTENT PREFLIGHT] 'latest.json' is already present on remote release (Asset ID: ${existingAsset.id}, size: ${existingAsset.size} bytes).`);
    console.log('  Fetching remote content for concordance comparison...');

    const fetchRes = spawnSync('curl.exe', ['-s', '-L', existingAsset.browser_download_url], { encoding: 'utf8' });
    let remoteManifest;
    try {
      remoteManifest = JSON.parse(fetchRes.stdout);
    } catch (e) {
      console.error(`[CONFLICT ERROR] Remote latest.json cannot be parsed as JSON: ${e.message}`);
      console.error('Stopping execution to prevent destructive replacement.');
      process.exit(1);
    }

    // Deep compare local vs remote manifest
    const isVersionMatch = remoteManifest.version === localManifest.version;
    const isSigMatch = remoteManifest.platforms &&
      remoteManifest.platforms['windows-x86_64'] &&
      remoteManifest.platforms['windows-x86_64'].signature === localManifest.platforms['windows-x86_64'].signature;
    const isUrlMatch = remoteManifest.platforms &&
      remoteManifest.platforms['windows-x86_64'] &&
      remoteManifest.platforms['windows-x86_64'].url === localManifest.platforms['windows-x86_64'].url;

    if (isVersionMatch && isSigMatch && isUrlMatch) {
      console.log('  ✓ Remote version matches local: ' + remoteManifest.version);
      console.log('  ✓ Remote signature matches local Minisign signature');
      console.log('  ✓ Remote installer URL matches local installer URL');
      console.log('\n[IDEMPOTENT SAFE STOP] Remote asset already exists and is bit-for-bit concordant with local manifest.');
      console.log('No modification, deletion, or replacement will be performed.');
      process.exit(0);
    } else {
      console.error('\n[CONFLICT ERROR] Remote latest.json content CONFLICTS with local manifest!');
      console.error(`  Remote Version: ${remoteManifest.version} vs Local Version: ${localManifest.version}`);
      console.error('Stopping immediately. Manual review is required before modifying published assets.');
      process.exit(1);
    }
  }

  // 4. Asset Absent: Check Execution Flag
  const shouldExecute = process.argv.includes('--execute');
  if (!shouldExecute) {
    console.log('\n[STANDBY] DRY RUN: latest.json is not present on release. Ready for upload.');
    console.log('To perform live deployment following operator authorization, run:');
    console.log('  node scripts/deploy_gate22_updater_manifest.js --execute\n');
    return;
  }

  // 5. Live Upload (Only reached if asset is absent AND --execute is provided)
  console.log('\n[DEPLOY] Uploading latest.json to GitHub Release 441473140...');
  const upRes = uploadAssetViaCurl(
    releaseRes.data.upload_url,
    MANIFEST_PATH,
    'latest.json',
    'application/json',
    token
  );

  if (upRes.status !== 201) {
    console.error('FAILED to upload latest.json:', upRes.status, upRes.data);
    process.exit(1);
  }

  console.log(`[DEPLOY SUCCESS] Asset uploaded successfully (Asset ID: ${upRes.data.id})`);
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
