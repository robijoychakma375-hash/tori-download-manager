const https = require('https');
const { execSync } = require('child_process');

function getGitHubToken() {
  const out = execSync('git credential fill', { input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8' });
  const passLine = out.split('\n').find(l => l.startsWith('password='));
  return passLine ? passLine.substring('password='.length).trim() : null;
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

async function main() {
  console.log('=== PUBLISHING TORI DOWNLOAD MANAGER v1.0.2 AS LATEST STABLE ===\n');

  const token = getGitHubToken();
  if (!token) {
    console.error('Fatal: Could not retrieve GitHub token.');
    process.exit(1);
  }

  const RELEASE_ID = 441473140;
  const TARGET_COMMIT = 'c6ed19423ef4a777a4870fab09ba11f4269eb2d8';

  // 1. Fetch current draft
  console.log(`[1] Verifying existing draft release ID: ${RELEASE_ID}...`);
  const checkRes = await requestJson('GET', `/repos/robijoychakma375-hash/tori-download-manager/releases/${RELEASE_ID}`, {
    'Authorization': `token ${token}`
  });

  if (checkRes.status !== 200) {
    console.error(`Failed to fetch release ${RELEASE_ID}: HTTP ${checkRes.status}`);
    process.exit(1);
  }

  console.log(`  Current tag: ${checkRes.data.tag_name}`);
  console.log(`  Current draft state: ${checkRes.data.draft}`);
  console.log(`  Asset count: ${(checkRes.data.assets || []).length}`);

  if ((checkRes.data.assets || []).length !== 10) {
    console.error(`Fatal: Expected 10 assets, found ${(checkRes.data.assets || []).length}`);
    process.exit(1);
  }

  // 2. Perform PATCH to publish as Latest Stable
  console.log('\n[2] Executing PATCH to publish release as Latest Stable...');
  const patchPayload = {
    tag_name: 'v1.0.2',
    target_commitish: TARGET_COMMIT,
    draft: false,
    prerelease: false,
    make_latest: 'true'
  };

  const patchRes = await requestJson(
    'PATCH',
    `/repos/robijoychakma375-hash/tori-download-manager/releases/${RELEASE_ID}`,
    { 'Authorization': `token ${token}` },
    patchPayload
  );

  if (patchRes.status !== 200) {
    console.error(`Failed to publish release: HTTP ${patchRes.status}`, patchRes.data);
    process.exit(1);
  }

  const pubData = patchRes.data;
  console.log('\n[3] PUBLICATION SUCCESSFUL!');
  console.log(`  Release ID: ${pubData.id}`);
  console.log(`  Tag Name: ${pubData.tag_name}`);
  console.log(`  HTML URL: ${pubData.html_url}`);
  console.log(`  Draft: ${pubData.draft}`);
  console.log(`  Prerelease: ${pubData.prerelease}`);
  console.log(`  Target Commit: ${pubData.target_commitish}`);
  console.log(`  Assets Count: ${(pubData.assets || []).length}`);

  // 3. Verify Latest Release endpoint
  console.log('\n[4] Verifying /releases/latest endpoint...');
  const latestRes = await requestJson('GET', '/repos/robijoychakma375-hash/tori-download-manager/releases/latest', {
    'Authorization': `token ${token}`
  });

  if (latestRes.status === 200 && latestRes.data.tag_name === 'v1.0.2') {
    console.log(`  ✓ Confirmed /releases/latest points to tag 'v1.0.2' (Release ID: ${latestRes.data.id})`);
  } else {
    console.warn(`  ⚠ /releases/latest returned: tag=${latestRes.data ? latestRes.data.tag_name : 'null'} (status=${latestRes.status})`);
  }

  // 4. Verify v1.0.1 historical accessibility
  console.log('\n[5] Verifying v1.0.1 historical release accessibility...');
  const v101Res = await requestJson('GET', '/repos/robijoychakma375-hash/tori-download-manager/releases/tags/v1.0.1', {
    'Authorization': `token ${token}`
  });

  if (v101Res.status === 200) {
    console.log(`  ✓ Confirmed v1.0.1 release is publicly accessible at ${v101Res.data.html_url}`);
    console.log(`  ✓ v1.0.1 assets intact: ${(v101Res.data.assets || []).length}/10`);
  } else {
    console.error(`  ✗ v1.0.1 check failed: HTTP ${v101Res.status}`);
  }

  console.log('\n=== STEP 2 PUBLICATION COMPLETE ===\n');
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});

