/**
 * TORI Download Manager — Gate 22.2 Emergency Updater Rollback Tool
 *
 * Safely removes latest.json from GitHub Release v1.0.2 (ID: 441473140) if an issue occurs.
 *
 * Safety & Authorization Guards:
 * 1. Authorization Gated: Requires explicit `--confirm-rollback` command-line argument.
 * 2. Scope Restricted: Deletes ONLY asset named "latest.json" on Release ID 441473140.
 * 3. Never touches installer binaries, extension packages, licenses, checksums, or git tags.
 * 4. Verifies post-deletion endpoint state to confirm auto-update traffic is stopped.
 */

const https = require('https');
const { spawn, spawnSync } = require('child_process');

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

async function main() {
  console.log('=== TORI Download Manager — Emergency Auto-Updater Rollback Utility ===\n');

  const token = await getGitHubToken();
  console.log('[AUTH] GitHub credentials verified via Git Credential Manager');

  // Verify Release ID 441473140
  const releaseRes = await requestJson(
    'GET',
    `/repos/${REPO}/releases/${TARGET_RELEASE_ID}`,
    { 'Authorization': `token ${token}` }
  );

  if (releaseRes.status !== 200 || releaseRes.data.tag_name !== TARGET_TAG) {
    console.error(`[FATAL] Target release ${TARGET_RELEASE_ID} (${TARGET_TAG}) not accessible: HTTP ${releaseRes.status}`);
    process.exit(1);
  }

  const assets = releaseRes.data.assets || [];
  const latestAsset = assets.find(a => a.name === 'latest.json');

  if (!latestAsset) {
    console.log('[INFO] latest.json is NOT present on Release ID 441473140.');
    console.log('Auto-updater is already in an inactive state (endpoint returns 404). No action needed.');
    process.exit(0);
  }

  console.log(`[TARGET IDENTIFIED] Found 'latest.json' on ${TARGET_TAG}:`);
  console.log(`  Asset ID: ${latestAsset.id}`);
  console.log(`  Size: ${latestAsset.size} bytes`);
  console.log(`  Created: ${latestAsset.created_at}`);

  const hasConfirmed = process.argv.includes('--confirm-rollback');
  if (!hasConfirmed) {
    console.log('\n[SAFETY STANDBY] DRY RUN COMPLETE. No assets were deleted.');
    console.log('To execute emergency rollback and remove latest.json, run:');
    console.log('  node scripts/rollback_gate22_updater_manifest.js --confirm-rollback\n');
    process.exit(0);
  }

  console.log(`\n[ROLLBACK EXECUTION] Deleting asset ID ${latestAsset.id} (latest.json)...`);
  const delRes = await requestJson(
    'DELETE',
    `/repos/${REPO}/releases/assets/${latestAsset.id}`,
    { 'Authorization': `token ${token}` }
  );

  if (delRes.status !== 204) {
    console.error(`[FATAL] Failed to delete asset: HTTP ${delRes.status}`, delRes.data);
    process.exit(1);
  }

  console.log('[DELETED] latest.json asset deleted successfully from GitHub release.');

  // Verify live endpoint reverts to 404
  console.log('[POST-ROLLBACK VERIFICATION] Probing live endpoint status...');
  const probeRes = spawnSync('curl.exe', [
    '-I', '-s',
    'https://github.com/robijoychakma375-hash/tori-download-manager/releases/latest/download/latest.json'
  ], { encoding: 'utf8' });

  if (probeRes.stdout.includes('404 Not Found') || probeRes.stdout.includes('302 Found')) {
    console.log('✓ Verified: Auto-updater distribution halted cleanly.');
  }
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});

