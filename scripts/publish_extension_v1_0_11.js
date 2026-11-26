#!/usr/bin/env node
/**
 * TORI Download Manager — Safe Idempotent Browser Companion v1.0.11 GitHub Publisher (Gate 35.5)
 *
 * SAFETY BY DEFAULT:
 * - Defaults strictly to `--dry-run` mode: performs ZERO GitHub API write calls,
 *   creates NO draft release, pushes NO tags, and writes a complete dry-run audit
 *   manifest (`release/v1.0.11-extension-rc/github_publish_dry_run_report.json`).
 * - Supports staged two-phase publication under explicit owner authorization:
 *   1. `--stage-draft --owner-authorized`:
 *      Creates/updates `extension-v1.0.11` with `draft: true`, `make_latest: "false"`,
 *      uploads ONLY the 5 approved assets, downloads EVERY uploaded draft asset back
 *      via authenticated GitHub API (`Accept: application/octet-stream`), recomputes
 *      SHA-256 and byte sizes, confirms `draft === true`, and writes
 *      `release/v1.0.11-extension-rc/github_draft_verification_report.json`.
 *   2. `--publish-draft --owner-authorized`:
 *      Re-verifies all 5 uploaded assets on the staged draft, publishes (`draft: false`,
 *      `prerelease: false`, `make_latest: "false"`), reads back live GitHub release state,
 *      verifies `/releases/latest` remains Desktop `v1.0.8` (ID 455125259) (auto-restoring
 *      metadata if it ever shifted), and writes
 *      `release/v1.0.11-extension-rc/github_publish_execution_report.json`.
 * - Never publishes the unsigned Firefox ZIP (`tori-companion-v1.0.11-firefox.zip`).
 * - Never prints or persists GitHub credentials.
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
const RELEASE_NAME = 'TORI Browser Companion v1.0.11 — Security Hotfix';
const EXPECTED_DESKTOP_LATEST_TAG = 'v1.0.8';
const EXPECTED_DESKTOP_LATEST_ID = 455125259;
const AUDITED_EXTENSION_SOURCE_COMMIT = 'ae27e96637c6b3227f07e2ec071b23bd1a22c956';
const DEFAULT_TAG_TARGET = 'c75b5697d7416093b8218f6290c192ea151d4d57';

const EXPECTED_HASHES = {
  'tori-companion-v1.0.11-firefox-signed.xpi': '4cd6d6fbf067cb98538fd807eaba360d40b409df07cbfb515b8d9b702b37c0fd',
  'tori-companion-v1.0.11-chromium.zip': '1e77592bb05e548d832df373331aee4f90788a004cdaef7ca80c97df84b88559',
};

const EXPECTED_SIZES = {
  'tori-companion-v1.0.11-firefox-signed.xpi': 111347,
  'tori-companion-v1.0.11-chromium.zip': 94625,
};

const PUBLISH_ASSETS = [
  {
    name: 'tori-companion-v1.0.11-firefox-signed.xpi',
    contentType: 'application/x-xpinstall',
    requiredSha256: EXPECTED_HASHES['tori-companion-v1.0.11-firefox-signed.xpi'],
    requiredBytes: EXPECTED_SIZES['tori-companion-v1.0.11-firefox-signed.xpi'],
  },
  {
    name: 'tori-companion-v1.0.11-chromium.zip',
    contentType: 'application/zip',
    requiredSha256: EXPECTED_HASHES['tori-companion-v1.0.11-chromium.zip'],
    requiredBytes: EXPECTED_SIZES['tori-companion-v1.0.11-chromium.zip'],
  },
  {
    name: 'SHA256SUMS.txt',
    contentType: 'text/plain',
    requiredSha256: null,
    requiredBytes: null,
  },
  {
    name: 'RELEASE_NOTES.md',
    contentType: 'text/markdown',
    requiredSha256: null,
    requiredBytes: null,
  },
  {
    name: 'INSTALLATION_AND_UPGRADE.md',
    contentType: 'text/markdown',
    requiredSha256: null,
    requiredBytes: null,
  },
];

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function sha256File(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

function getGitHubToken() {
  return new Promise((resolve, reject) => {
    if (process.env.GITHUB_TOKEN) return resolve(process.env.GITHUB_TOKEN.trim());
    if (process.env.GH_TOKEN) return resolve(process.env.GH_TOKEN.trim());
    const proc = spawn('git', ['credential', 'fill']);
    proc.stdin.write('protocol=https\nhost=github.com\n\n');
    proc.stdin.end();
    let out = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.on('close', () => {
      const line = out.split(/\r?\n/).find((l) => l.startsWith('password='));
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

function downloadAssetViaCurl(apiAssetUrl, token) {
  // Follow GitHub's 302 redirect to S3 without leaking Bearer header to third-party host (-L only sends Auth to initial host by default in curl)
  const tmpFile = path.join(ROOT, 'target', `gh_asset_verify_${Date.now()}_${Math.random().toString(16).slice(2)}.tmp`);
  fs.mkdirSync(path.dirname(tmpFile), { recursive: true });
  try {
    const args = [
      '-sS',
      '-L',
      '-w', '%{http_code}',
      '-H', `Authorization: Bearer ${token}`,
      '-H', 'Accept: application/octet-stream',
      '-H', 'User-Agent: TORI-Release-Manager',
      '-o', tmpFile,
      apiAssetUrl,
    ];
    const res = spawnSync('curl.exe', args, { encoding: 'utf8', timeout: 60000 });
    if (res.error) throw res.error;
    const code = parseInt((res.stdout || '').trim(), 10);
    if (code !== 200 || !fs.existsSync(tmpFile)) {
      throw new Error(`Asset roundtrip download failed: HTTP ${code} (${res.stderr || 'no stderr'})`);
    }
    const buf = fs.readFileSync(tmpFile);
    return { status: code, bytes: buf.length, sha256: sha256Buffer(buf) };
  } finally {
    try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch (_) {}
  }
}

function uploadAssetViaCurl(uploadUrlTemplate, filePath, fileName, contentType, token) {
  const cleanUrl = uploadUrlTemplate.replace(/\{.*?\}$/, '') + `?name=${encodeURIComponent(fileName)}`;
  const args = [
    '-sS',
    '-w', '\n%{http_code}',
    '-X', 'POST',
    '-H', `Authorization: Bearer ${token}`,
    '-H', 'Accept: application/vnd.github+json',
    '-H', `Content-Type: ${contentType || 'application/octet-stream'}`,
    '--data-binary', `@${filePath}`,
    cleanUrl,
  ];
  const res = spawnSync('curl.exe', args, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, timeout: 120000 });
  if (res.error) throw res.error;
  const lines = res.stdout.trim().split(/\r?\n/);
  const code = parseInt(lines[lines.length - 1], 10);
  const body = lines.slice(0, lines.length - 1).join('\n');
  let data = body;
  try { data = JSON.parse(body); } catch (_) {}
  return { status: code, data };
}

function verifySourceProvenance(targetCommit) {
  const resolved = execSync(`git rev-parse "${targetCommit}^{commit}"`, { cwd: ROOT, encoding: 'utf8' }).trim();
  // Confirm audited extension source commit is an ancestor of targetCommit
  const anc = spawnSync('git', ['merge-base', '--is-ancestor', AUDITED_EXTENSION_SOURCE_COMMIT, resolved], { cwd: ROOT });
  if (anc.status !== 0) {
    throw new Error(`Target commit ${resolved} does not descend from audited extension commit ${AUDITED_EXTENSION_SOURCE_COMMIT}`);
  }
  // Confirm ZERO changes to extension/ since audited extension source commit
  const extDiff = execSync(`git diff ${AUDITED_EXTENSION_SOURCE_COMMIT}..${resolved} -- extension`, { cwd: ROOT, encoding: 'utf8' }).trim();
  if (extDiff.length > 0) {
    throw new Error(`Target commit ${resolved} has unaudited extension/ changes relative to ${AUDITED_EXTENSION_SOURCE_COMMIT}`);
  }
  return resolved;
}

function verifyLocalStaging() {
  if (PUBLISH_ASSETS.length !== 5) {
    throw new Error(`Expected exactly 5 approved release assets, found ${PUBLISH_ASSETS.length}`);
  }
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
    if (asset.requiredBytes !== null && bytes !== asset.requiredBytes) {
      throw new Error(`Byte-size mismatch for ${asset.name}: expected ${asset.requiredBytes}, got ${bytes}`);
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

  // Ensure SHA256SUMS.txt references both primary artifacts accurately and excludes unsigned ZIP
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

  // Verify signed XPI & Chromium ZIP manifests, Gecko ID, min version, and 5 META-INF/ Mozilla signature files
  const pyCheck = [
    'import json, sys, zipfile',
    'xpi, cz = sys.argv[1], sys.argv[2]',
    'with zipfile.ZipFile(xpi, "r") as zf:',
    '    assert zf.testzip() is None',
    '    names = [i.filename for i in zf.infolist()]',
    '    meta = sorted(n for n in names if n.startswith("META-INF/"))',
    '    assert meta == ["META-INF/cose.manifest", "META-INF/cose.sig", "META-INF/manifest.mf", "META-INF/mozilla.rsa", "META-INF/mozilla.sf"], f"Unexpected META-INF: {meta}"',
    '    mf = json.loads(zf.read("manifest.json").decode("utf-8"))',
    '    assert mf["version"] == "1.0.11"',
    '    assert mf["manifest_version"] == 3',
    '    assert mf["browser_specific_settings"]["gecko"]["id"] == "tori-download-manager@toridm.org"',
    '    assert mf["browser_specific_settings"]["gecko"]["strict_min_version"] == "142.0"',
    'with zipfile.ZipFile(cz, "r") as zf:',
    '    assert zf.testzip() is None',
    '    mf = json.loads(zf.read("manifest.json").decode("utf-8"))',
    '    assert mf["version"] == "1.0.11"',
    '    assert mf["manifest_version"] == 3',
    'print("OK")',
  ].join('\n');
  const checkRes = spawnSync(
    'python',
    [
      '-c',
      pyCheck,
      path.join(RC_DIR, 'tori-companion-v1.0.11-firefox-signed.xpi'),
      path.join(RC_DIR, 'tori-companion-v1.0.11-chromium.zip'),
    ],
    { encoding: 'utf8' }
  );
  if (checkRes.status !== 0 || !checkRes.stdout.includes('OK')) {
    throw new Error(`Package integrity verification failed: ${checkRes.stderr || checkRes.stdout}`);
  }

  return verifiedAssets;
}

async function verifyUploadedDraftAssets(releaseId, verifiedAssets, token) {
  const assetsRes = await requestJson('GET', `/repos/${REPO}/releases/${releaseId}/assets?per_page=50`, token);
  if (assetsRes.status !== 200 || !Array.isArray(assetsRes.data)) {
    throw new Error(`Failed listing release assets: HTTP ${assetsRes.status}`);
  }
  const uploaded = assetsRes.data;
  if (uploaded.length !== verifiedAssets.length) {
    throw new Error(`Asset inventory mismatch: expected ${verifiedAssets.length}, found ${uploaded.length} (${uploaded.map((a) => a.name).join(', ')})`);
  }
  if (uploaded.some((a) => a.name === 'tori-companion-v1.0.11-firefox.zip')) {
    throw new Error('CRITICAL: Unsigned Firefox ZIP detected on release!');
  }

  const verifiedRoundtrip = [];
  for (const expected of verifiedAssets) {
    const match = uploaded.find((a) => a.name === expected.name);
    if (!match) {
      throw new Error(`Missing uploaded asset on GitHub release: ${expected.name}`);
    }
    if (match.size !== expected.bytes) {
      throw new Error(`Uploaded byte size mismatch for ${expected.name}: expected ${expected.bytes}, got ${match.size}`);
    }
    const dl = downloadAssetViaCurl(match.url, token);
    if (dl.bytes !== expected.bytes || dl.sha256 !== expected.sha256) {
      throw new Error(
        `Uploaded roundtrip integrity mismatch for ${expected.name}: expected (${expected.bytes} B, ${expected.sha256}), got (${dl.bytes} B, ${dl.sha256})`
      );
    }
    verifiedRoundtrip.push({
      id: match.id,
      name: match.name,
      contentType: match.content_type,
      size: match.size,
      sha256: dl.sha256,
      browser_download_url: match.browser_download_url,
      roundtripVerified: true,
    });
  }
  return verifiedRoundtrip;
}

async function main() {
  const argv = process.argv.slice(2);
  const args = new Set(argv);
  const targetIdx = argv.indexOf('--target-commit');
  const requestedTarget = targetIdx >= 0 && argv[targetIdx + 1] ? argv[targetIdx + 1] : DEFAULT_TAG_TARGET;

  const ownerAuthorized = args.has('--owner-authorized');
  const stageDraftMode = ownerAuthorized && args.has('--stage-draft');
  const publishDraftMode = ownerAuthorized && args.has('--publish-draft');
  const fullExecuteMode = ownerAuthorized && args.has('--execute');
  const isDryRun = args.has('--dry-run') || (!stageDraftMode && !publishDraftMode && !fullExecuteMode);

  const modeLabel = isDryRun
    ? 'DRY-RUN — READ-ONLY'
    : stageDraftMode
    ? 'AUTHORIZED DRAFT STAGING & ROUNDTRIP VERIFICATION'
    : publishDraftMode
    ? 'AUTHORIZED PUBLISH VERIFIED DRAFT'
    : 'AUTHORIZED FULL STAGE + VERIFY + PUBLISH';

  console.log(`=== TORI Browser Companion v1.0.11 GitHub Publisher (${modeLabel}) ===`);

  const targetCommit = verifySourceProvenance(requestedTarget);
  const branchName = execSync('git rev-parse --abbrev-ref HEAD', { cwd: ROOT, encoding: 'utf8' }).trim();
  const verifiedAssets = verifyLocalStaging();

  const notesPath = path.join(RC_DIR, 'RELEASE_NOTES.md');
  const installPath = path.join(RC_DIR, 'INSTALLATION_AND_UPGRADE.md');
  const bodyContent = `${fs.readFileSync(notesPath, 'utf8').trim()}\n\n---\n\n${fs.readFileSync(installPath, 'utf8').trim()}\n`;

  const plannedReleasePayload = {
    tag_name: TARGET_TAG,
    target_commitish: targetCommit,
    name: RELEASE_NAME,
    body_bytes: Buffer.byteLength(bodyContent, 'utf8'),
    draft: false,
    prerelease: false,
    make_latest: 'false',
  };

  if (isDryRun) {
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
      audited_extension_source_commit: AUDITED_EXTENSION_SOURCE_COMMIT,
      target_tag_commit: targetCommit,
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
        extension_source_provenance_verified: true,
        remote_writes_performed: 0,
      },
    };

    const reportPath = path.join(RC_DIR, 'github_publish_dry_run_report.json');
    fs.writeFileSync(reportPath, JSON.stringify(dryRunReport, null, 2) + '\n', 'utf8');
    console.log(`[DRY-RUN OK] Verified ${verifiedAssets.length} staged release assets with 0 remote writes.`);
    console.log(`[DRY-RUN OK] Planned tag: ${TARGET_TAG} -> ${targetCommit} (make_latest="false", preserving Desktop ${EXPECTED_DESKTOP_LATEST_TAG})`);
    console.log(`[DRY-RUN OK] Read-only live /releases/latest: ${JSON.stringify(liveLatestCheck)}`);
    console.log(`[DRY-RUN OK] Read-only live /releases/tags/${TARGET_TAG}: ${JSON.stringify(existingTagCheck)}`);
    console.log(`[DRY-RUN OK] Report written to: ${reportPath}`);
    return;
  }

  // AUTHORIZED LIVE EXECUTION PATH
  const token = await getGitHubToken();

  // Verify remote tag already exists and points to targetCommit before creating release
  const remoteTagRef = await requestJson('GET', `/repos/${REPO}/git/ref/tags/${TARGET_TAG}`, token);
  if (remoteTagRef.status !== 200) {
    throw new Error(`Remote tag ${TARGET_TAG} does not exist yet (HTTP ${remoteTagRef.status}). Push annotated tag first!`);
  }
  let remoteTagCommit = remoteTagRef.data?.object?.sha;
  if (remoteTagRef.data?.object?.type === 'tag') {
    const tagObj = await requestJson('GET', `/repos/${REPO}/git/tags/${remoteTagCommit}`, token);
    remoteTagCommit = tagObj.data?.object?.sha;
  }
  if (remoteTagCommit !== targetCommit) {
    throw new Error(`Remote tag ${TARGET_TAG} resolves to ${remoteTagCommit}, expected ${targetCommit}`);
  }
  console.log(`[PROVENANCE OK] Remote tag ${TARGET_TAG} verified -> ${remoteTagCommit}`);

  const listRes = await requestJson('GET', `/repos/${REPO}/releases?per_page=30`, token);
  if (listRes.status !== 200 || !Array.isArray(listRes.data)) {
    throw new Error(`Failed listing repository releases: HTTP ${listRes.status}`);
  }
  const existingRelease = listRes.data.find((r) => r.tag_name === TARGET_TAG) || null;

  let releaseId;
  let uploadUrl;

  if (stageDraftMode || fullExecuteMode) {
    if (existingRelease) {
      if (!existingRelease.draft) {
        throw new Error(`Release ${TARGET_TAG} (ID ${existingRelease.id}) is already published! Refusing to overwrite published release.`);
      }
      releaseId = existingRelease.id;
      uploadUrl = existingRelease.upload_url;
      console.log(`[DRAFT REUSE] Reusing existing draft release ID=${releaseId}`);
      const updRes = await requestJson('PATCH', `/repos/${REPO}/releases/${releaseId}`, token, {
        name: RELEASE_NAME,
        body: bodyContent,
        draft: true,
        prerelease: false,
        make_latest: 'false',
      });
      if (updRes.status !== 200) {
        throw new Error(`Failed updating draft release ${releaseId}: HTTP ${updRes.status}`);
      }
    } else {
      const createRes = await requestJson('POST', `/repos/${REPO}/releases`, token, {
        tag_name: TARGET_TAG,
        target_commitish: targetCommit,
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
      console.log(`[DRAFT CREATED] ID=${releaseId} tag=${TARGET_TAG} draft=${createRes.data.draft}`);
    }

    const assetsRes = await requestJson('GET', `/repos/${REPO}/releases/${releaseId}/assets?per_page=50`, token);
    const currentAssets = Array.isArray(assetsRes.data) ? assetsRes.data : [];

    // Remove any unexpected assets from draft (never touches other releases!)
    const allowedNames = new Set(verifiedAssets.map((a) => a.name));
    for (const oldAsset of currentAssets) {
      if (!allowedNames.has(oldAsset.name)) {
        await requestJson('DELETE', `/repos/${REPO}/releases/assets/${oldAsset.id}`, token);
      }
    }

    for (const asset of verifiedAssets) {
      const existing = currentAssets.find((a) => a.name === asset.name);
      if (existing) {
        await requestJson('DELETE', `/repos/${REPO}/releases/assets/${existing.id}`, token);
      }
      const upRes = uploadAssetViaCurl(uploadUrl, path.join(RC_DIR, asset.name), asset.name, asset.contentType, token);
      if (upRes.status !== 201) {
        throw new Error(`Failed uploading ${asset.name}: HTTP ${upRes.status}`);
      }
      console.log(`[UPLOADED] ${asset.name} -> asset_id=${upRes.data.id} (${upRes.data.size} bytes)`);
    }

    // Confirm release is still draft=true and verify every uploaded asset roundtrip SHA-256!
    const draftState = await requestJson('GET', `/repos/${REPO}/releases/${releaseId}`, token);
    if (draftState.status !== 200 || draftState.data?.draft !== true) {
      throw new Error(`Expected release ${releaseId} to remain draft=true during validation!`);
    }
    const verifiedRoundtrip = await verifyUploadedDraftAssets(releaseId, verifiedAssets, token);

    const draftReport = {
      mode: 'DRAFT_STAGED_AND_ROUNDTRIP_VERIFIED',
      generated_at: new Date().toISOString(),
      repository: REPO,
      tag_name: TARGET_TAG,
      target_commit: targetCommit,
      release_id: releaseId,
      name: draftState.data.name,
      draft: draftState.data.draft,
      prerelease: draftState.data.prerelease,
      html_url: draftState.data.html_url,
      verified_assets: verifiedRoundtrip,
    };
    const draftReportPath = path.join(RC_DIR, 'github_draft_verification_report.json');
    fs.writeFileSync(draftReportPath, JSON.stringify(draftReport, null, 2) + '\n', 'utf8');
    console.log(`[DRAFT VERIFIED OK] All ${verifiedRoundtrip.length} uploaded draft assets matched exact size & SHA-256! Report: ${draftReportPath}`);

    if (stageDraftMode && !publishDraftMode && !fullExecuteMode) {
      return;
    }
  }

  if (publishDraftMode || fullExecuteMode) {
    if (!releaseId) {
      if (!existingRelease) {
        throw new Error(`No staged draft release found for ${TARGET_TAG}. Run --stage-draft --owner-authorized first!`);
      }
      if (!existingRelease.draft) {
        throw new Error(`Release ${TARGET_TAG} (ID ${existingRelease.id}) is already published!`);
      }
      releaseId = existingRelease.id;
    }

    // Re-verify all 5 uploaded assets right before setting draft=false
    const verifiedRoundtrip = await verifyUploadedDraftAssets(releaseId, verifiedAssets, token);
    console.log(`[PRE-PUBLISH CHECK OK] Verified all ${verifiedRoundtrip.length} draft assets roundtrip SHA-256.`);

    const pubRes = await requestJson('PATCH', `/repos/${REPO}/releases/${releaseId}`, token, {
      name: RELEASE_NAME,
      body: bodyContent,
      draft: false,
      prerelease: false,
      make_latest: 'false',
    });
    if (pubRes.status !== 200 || pubRes.data?.draft !== false) {
      throw new Error(`Failed publishing release ${releaseId}: HTTP ${pubRes.status}`);
    }

    // Post-publish safety invariant: /releases/latest MUST remain Desktop v1.0.8!
    let latestAfter = await requestJson('GET', `/repos/${REPO}/releases/latest`, token);
    let latestRestored = false;
    if (latestAfter.data?.tag_name !== EXPECTED_DESKTOP_LATEST_TAG || latestAfter.data?.id !== EXPECTED_DESKTOP_LATEST_ID) {
      console.warn(`[WARN] /releases/latest shifted to ${latestAfter.data?.tag_name} (${latestAfter.data?.id}); restoring ${EXPECTED_DESKTOP_LATEST_TAG}...`);
      const restoreRes = await requestJson('PATCH', `/repos/${REPO}/releases/${EXPECTED_DESKTOP_LATEST_ID}`, token, { make_latest: 'true' });
      if (restoreRes.status !== 200) {
        throw new Error(`FATAL: Failed to restore ${EXPECTED_DESKTOP_LATEST_TAG} as latest: HTTP ${restoreRes.status}`);
      }
      latestAfter = await requestJson('GET', `/repos/${REPO}/releases/latest`, token);
      latestRestored = true;
      if (latestAfter.data?.tag_name !== EXPECTED_DESKTOP_LATEST_TAG) {
        throw new Error(`FATAL: /releases/latest still not ${EXPECTED_DESKTOP_LATEST_TAG} after restore!`);
      }
    }

    // Read back live public release via unauthenticated GET to confirm public accessibility
    const livePublic = await requestJson('GET', `/repos/${REPO}/releases/tags/${TARGET_TAG}`, null);
    if (livePublic.status !== 200 || livePublic.data?.draft !== false) {
      throw new Error(`Public unauthenticated read-back failed: HTTP ${livePublic.status}`);
    }

    const execReport = {
      mode: 'PUBLISHED_PUBLIC_VERIFIED',
      generated_at: new Date().toISOString(),
      repository: REPO,
      tag_name: TARGET_TAG,
      target_commit: targetCommit,
      audited_extension_source_commit: AUDITED_EXTENSION_SOURCE_COMMIT,
      release_id: livePublic.data.id,
      name: livePublic.data.name,
      html_url: livePublic.data.html_url,
      published_at: livePublic.data.published_at,
      draft: livePublic.data.draft,
      prerelease: livePublic.data.prerelease,
      make_latest_enforced: 'false',
      latest_stable_restored: latestRestored,
      live_latest_stable: {
        tag_name: latestAfter.data.tag_name,
        release_id: latestAfter.data.id,
        matchesExpectedDesktopV108: latestAfter.data.tag_name === EXPECTED_DESKTOP_LATEST_TAG && latestAfter.data.id === EXPECTED_DESKTOP_LATEST_ID,
      },
      published_assets: verifiedRoundtrip,
    };

    const execReportPath = path.join(RC_DIR, 'github_publish_execution_report.json');
    fs.writeFileSync(execReportPath, JSON.stringify(execReport, null, 2) + '\n', 'utf8');
    console.log(`[PUBLISHED OK] ID=${livePublic.data.id} URL=${livePublic.data.html_url} published_at=${livePublic.data.published_at}`);
    console.log(`[LATEST PRESERVED OK] /releases/latest -> ${latestAfter.data.tag_name} (ID ${latestAfter.data.id})`);
    console.log(`[REPORT] ${execReportPath}`);
  }
}

main().catch((err) => {
  console.error('[ERROR]', err.message || err);
  process.exit(1);
});
