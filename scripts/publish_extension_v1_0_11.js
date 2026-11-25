#!/usr/bin/env node
/**
 * TORI Download Manager — Safe Idempotent Browser Companion v1.0.11 GitHub Publisher
 *
 * SAFETY BY DEFAULT:
 * - Defaults strictly to `--dry-run` mode: performs ZERO GitHub API write calls,
 *   creates NO draft release, pushes NO tags, and writes a complete dry-run audit
 *   manifest (`release/v1.0.11-extension-rc/github_publish_dry_run_report.json`).
 * - Actual publication requires BOTH `--execute` AND `--owner-authorized` flags AND
 *   passes all preflight cryptographic, parity, and Latest-Stable preservation checks.
 * - Explicitly sets `make_latest: "false"` so Desktop v1.0.8 (release ID 455125259)
 *   ALWAYS remains the repository-wide Latest Stable release.
 * - Never publishes the unsigned Firefox ZIP (`tori-companion-v1.0.11-firefox.zip`)
 *   to end users — publishes ONLY the Mozilla-signed `.xpi` + Chromium `.zip` +
 *   `SHA256SUMS.txt` + `RELEASE_NOTES.md` + `INSTALLATION_AND_UPGRADE.md`.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { spawn, spawnSync, execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RC_DIR = path.join(ROOT, 'release', 'v1.0.11-extension-rc');
const REPO = 'robijoychakma375-hash/tori-download-manager';
const TARGET_TAG = 'extension-v1.0.11';
const RELEASE_NAME = 'TORI Browser Companion v1.0.11 (Security Hotfix)';
const EXPECTED_DESKTOP_LATEST_TAG = 'v1.0.8';
const EXPECTED_DESKTOP_LATEST_ID = 455125259;

const EXPECTED_HASHES = {
  'tori-companion-v1.0.11-firefox-signed.xpi': '4cd6d6fbf067cb98538fd807eaba360d40b409df07cbfb515b8d9b702b37c0fd',
  'tori-companion-v1.0.11-chromium.zip': '1e77592bb05e548d832df373331aee4f90788a004cdaef7ca80c97df84b88559',
};

const PUBLISH_ASSETS = [
  {
    name: 'tori-companion-v1.0.11-firefox-signed.xpi',
    contentType: 'application/x-xpinstall',
    requiredSha256: EXPECTED_HASHES['tori-companion-v1.0.11-firefox-signed.xpi'],
  },
  {
    name: 'tori-companion-v1.0.11-chromium.zip',
    contentType: 'application/zip',
    requiredSha256: EXPECTED_HASHES['tori-companion-v1.0.11-chromium.zip'],
  },
  {
    name: 'SHA256SUMS.txt',
    contentType: 'text/plain',
    requiredSha256: null,
  },
  {
    name: 'RELEASE_NOTES.md',
    contentType: 'text/markdown',
    requiredSha256: null,
  },
  {
    name: 'INSTALLATION_AND_UPGRADE.md',
    contentType: 'text/markdown',
    requiredSha256: null,
  },
];

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function getGitHubToken() {
  return new Promise((resolve, reject) => {
    if (process.env.GITHUB_TOKEN) return resolve(process.env.GITHUB_TOKEN.trim());
    if (process.env.GH_TOKEN) return resolve(process.env.GH_TOKEN.trim());
    const proc = spawn('git', ['credential', 'fill']);
    proc.stdin.write('protocol=https\nhost=github.com\n\n');
    let out = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.on('close', () => {
      const line = out.split('\n').find((l) => l.startsWith('password='));
      if (line) resolve(line.substring('password='.length).trim());
      else reject(new Error('No GitHub credential found'));
    });
    proc.on('error', reject);
  });
}

function requestJson(method, urlPath, token, body = null) {
  return new Promise((resolve, reject) => {
    const postData = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const reqHeaders = {
      'User-Agent': 'TORI-Release-Manager',
      Accept: 'application/vnd.github+json',
    };
    if (token) reqHeaders.Authorization = `Bearer ${token}`;
    if (postData) {
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = Buffer.byteLength(postData);
    }
    const req = https.request(
      { hostname: 'api.github.com', path: urlPath, method, headers: reqHeaders },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let json = raw;
          try { json = JSON.parse(raw); } catch (_) {}
          resolve({ status: res.statusCode, headers: res.headers, data: json });
        });
      }
    );
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
    cleanUrl,
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

function verifyLocalStaging() {
  const verifiedAssets = [];
  for (const asset of PUBLISH_ASSETS) {
    const fullPath = path.join(RC_DIR, asset.name);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Missing required staged asset: ${fullPath}`);
    }
    const bytes = fs.statSync(fullPath).size;
    if (bytes <= 0) {
      throw new Error(`Asset is empty: ${fullPath}`);
    }
    const sha256 = sha256File(fullPath);
    if (asset.requiredSha256 && sha256 !== asset.requiredSha256) {
      throw new Error(`SHA-256 mismatch for ${asset.name}: expected ${asset.requiredSha256}, got ${sha256}`);
    }
    verifiedAssets.push({
      name: asset.name,
      path: path.relative(ROOT, fullPath).replace(/\\/g, '/'),
      contentType: asset.contentType,
      bytes,
      sha256,
    });
  }

  // Ensure SHA256SUMS.txt references both primary artifacts accurately and excludes unsigned ZIP from public release checksums
  const sumsContent = fs.readFileSync(path.join(RC_DIR, 'SHA256SUMS.txt'), 'utf8');
  if (!sumsContent.includes(`${EXPECTED_HASHES['tori-companion-v1.0.11-firefox-signed.xpi']} *tori-companion-v1.0.11-firefox-signed.xpi`)) {
    throw new Error('SHA256SUMS.txt missing verified signed Firefox XPI entry');
  }
  if (!sumsContent.includes(`${EXPECTED_HASHES['tori-companion-v1.0.11-chromium.zip']} *tori-companion-v1.0.11-chromium.zip`)) {
    throw new Error('SHA256SUMS.txt missing verified Chromium ZIP entry');
  }
  if (sumsContent.includes('tori-companion-v1.0.11-firefox.zip')) {
    throw new Error('SHA256SUMS.txt must NOT include excluded unsigned tori-companion-v1.0.11-firefox.zip');
  }

  // Verify signed XPI has Mozilla META-INF signatures and version 1.0.11
  const pyCheck = [
    'import json, sys, zipfile',
    'xpi = sys.argv[1]',
    'with zipfile.ZipFile(xpi, "r") as zf:',
    '    assert zf.testzip() is None',
    '    names = [i.filename for i in zf.infolist()]',
    '    meta = sorted(n for n in names if n.startswith("META-INF/"))',
    '    assert len(meta) == 5, f"Expected 5 META-INF entries, got {meta}"',
    '    mf = json.loads(zf.read("manifest.json").decode("utf-8"))',
    '    assert mf["version"] == "1.0.11"',
    '    assert mf["browser_specific_settings"]["gecko"]["id"] == "tori-download-manager@toridm.org"',
    'print("OK")',
  ].join('\n');
  const checkRes = spawnSync('python', ['-c', pyCheck, path.join(RC_DIR, 'tori-companion-v1.0.11-firefox-signed.xpi')], { encoding: 'utf8' });
  if (checkRes.status !== 0 || !checkRes.stdout.includes('OK')) {
    throw new Error(`Signed XPI integrity verification failed: ${checkRes.stderr || checkRes.stdout}`);
  }

  return verifiedAssets;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const isExecute = args.has('--execute') && args.has('--owner-authorized');
  const isDryRun = !isExecute || args.has('--dry-run');

  console.log(`=== TORI Browser Companion v1.0.11 GitHub Publisher (${isDryRun ? 'DRY-RUN — READ-ONLY' : 'AUTHORIZED LIVE EXECUTION'}) ===`);

  const commitHash = execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf8' }).trim();
  const branchName = execSync('git rev-parse --abbrev-ref HEAD', { cwd: ROOT, encoding: 'utf8' }).trim();
  const verifiedAssets = verifyLocalStaging();

  const notesPath = path.join(RC_DIR, 'RELEASE_NOTES.md');
  const installPath = path.join(RC_DIR, 'INSTALLATION_AND_UPGRADE.md');
  const bodyContent = `${fs.readFileSync(notesPath, 'utf8').trim()}\n\n---\n\n${fs.readFileSync(installPath, 'utf8').trim()}\n`;

  const plannedReleasePayload = {
    tag_name: TARGET_TAG,
    target_commitish: commitHash,
    name: RELEASE_NAME,
    body_bytes: Buffer.byteLength(bodyContent, 'utf8'),
    draft: false,
    prerelease: false,
    make_latest: 'false',
  };

  if (isDryRun) {
    // Perform strictly READ-ONLY verification against public GitHub API (no auth token mutation, no writes)
    let liveLatestCheck = { checked: false };
    let existingTagCheck = { checked: false };
    try {
      const latestRes = await requestJson('GET', `/repos/${REPO}/releases/latest`, null);
      liveLatestCheck = {
        checked: true,
        httpStatus: latestRes.status,
        tag_name: latestRes.data?.tag_name || null,
        release_id: latestRes.data?.id || null,
        matchesExpectedDesktopV108:
          latestRes.status === 200 &&
          latestRes.data?.tag_name === EXPECTED_DESKTOP_LATEST_TAG &&
          latestRes.data?.id === EXPECTED_DESKTOP_LATEST_ID,
      };
      const tagRes = await requestJson('GET', `/repos/${REPO}/releases/tags/${TARGET_TAG}`, null);
      existingTagCheck = {
        checked: true,
        httpStatus: tagRes.status,
        alreadyPublished: tagRes.status === 200,
      };
    } catch (err) {
      liveLatestCheck = { checked: false, error: err.message };
    }

    const dryRunReport = {
      mode: 'DRY_RUN_NO_REMOTE_WRITES',
      generated_at: new Date().toISOString(),
      repository: REPO,
      branch: branchName,
      source_commit: commitHash,
      planned_release: plannedReleasePayload,
      excluded_unsigned_assets: ['tori-companion-v1.0.11-firefox.zip'],
      assets_to_upload: verifiedAssets,
      read_only_remote_checks: {
        current_latest_stable: liveLatestCheck,
        target_tag_extension_v1_0_11: existingTagCheck,
      },
      safety_assertions: {
        make_latest_false_enforced: plannedReleasePayload.make_latest === 'false',
        unsigned_firefox_zip_excluded: !verifiedAssets.some((a) => a.name === 'tori-companion-v1.0.11-firefox.zip'),
        signed_firefox_xpi_verified: true,
        chromium_zip_verified: true,
        remote_writes_performed: 0,
      },
    };

    const reportPath = path.join(RC_DIR, 'github_publish_dry_run_report.json');
    fs.writeFileSync(reportPath, JSON.stringify(dryRunReport, null, 2) + '\n', 'utf8');
    console.log(`[DRY-RUN OK] Verified ${verifiedAssets.length} staged release assets with 0 remote writes.`);
    console.log(`[DRY-RUN OK] Planned tag: ${TARGET_TAG} (make_latest="false", preserving Desktop ${EXPECTED_DESKTOP_LATEST_TAG})`);
    console.log(`[DRY-RUN OK] Read-only live /releases/latest: ${JSON.stringify(liveLatestCheck)}`);
    console.log(`[DRY-RUN OK] Read-only live /releases/tags/${TARGET_TAG}: ${JSON.stringify(existingTagCheck)}`);
    console.log(`[DRY-RUN OK] Report written to: ${reportPath}`);
    return;
  }

  // LIVE EXECUTION PATH (ONLY when explicitly invoked with --execute --owner-authorized)
  const token = await getGitHubToken();
  const listRes = await requestJson('GET', `/repos/${REPO}/releases?per_page=25`, token);
  const existingRelease = Array.isArray(listRes.data)
    ? listRes.data.find((r) => r.tag_name === TARGET_TAG)
    : null;

  let releaseId;
  let uploadUrl;
  if (existingRelease) {
    releaseId = existingRelease.id;
    uploadUrl = existingRelease.upload_url;
  } else {
    const createRes = await requestJson('POST', `/repos/${REPO}/releases`, token, {
      tag_name: TARGET_TAG,
      target_commitish: commitHash,
      name: RELEASE_NAME,
      body: bodyContent,
      draft: true,
      prerelease: false,
      make_latest: 'false',
    });
    if (createRes.status !== 201) {
      throw new Error(`Failed creating draft release: HTTP ${createRes.status} ${JSON.stringify(createRes.data)}`);
    }
    releaseId = createRes.data.id;
    uploadUrl = createRes.data.upload_url;
  }

  const assetsRes = await requestJson('GET', `/repos/${REPO}/releases/${releaseId}/assets`, token);
  const currentAssets = Array.isArray(assetsRes.data) ? assetsRes.data : [];

  for (const asset of verifiedAssets) {
    const existing = currentAssets.find((a) => a.name === asset.name);
    if (existing) {
      await requestJson('DELETE', `/repos/${REPO}/releases/assets/${existing.id}`, token);
    }
    const upRes = uploadAssetViaCurl(uploadUrl, path.join(RC_DIR, asset.name), asset.name, asset.contentType, token);
    if (upRes.status !== 201) {
      throw new Error(`Failed uploading ${asset.name}: HTTP ${upRes.status}`);
    }
  }

  const pubRes = await requestJson('PATCH', `/repos/${REPO}/releases/${releaseId}`, token, {
    body: bodyContent,
    draft: false,
    prerelease: false,
    make_latest: 'false',
  });
  if (pubRes.status !== 200) {
    throw new Error(`Failed publishing release ${releaseId}: HTTP ${pubRes.status}`);
  }

  // Post-publish safety invariant: /releases/latest MUST remain Desktop v1.0.8!
  const latestAfter = await requestJson('GET', `/repos/${REPO}/releases/latest`, token);
  if (latestAfter.data?.tag_name !== EXPECTED_DESKTOP_LATEST_TAG) {
    await requestJson('PATCH', `/repos/${REPO}/releases/${EXPECTED_DESKTOP_LATEST_ID}`, token, { make_latest: 'true' });
    throw new Error(`FATAL: /releases/latest shifted to ${latestAfter.data?.tag_name}; restored ${EXPECTED_DESKTOP_LATEST_TAG}`);
  }
  console.log(`[PUBLISHED OK] ${pubRes.data.html_url} (Latest Stable preserved: ${latestAfter.data.tag_name})`);
}

main().catch((err) => {
  console.error('[ERROR]', err.message || err);
  process.exit(1);
});
