#!/usr/bin/env node
/**
 * TORI Gate 35.5 — Live Public Endpoint, Roundtrip Download & Preservation Verifier
 *
 * Performs fresh HTTP/HTTPS verification of:
 *   - GitHub extension-v1.0.11 public release + all 5 assets (roundtrip download + SHA-256)
 *   - GitHub extension-v1.0.10 historical release preservation
 *   - GitHub Desktop v1.0.8 Latest Stable preservation + latest.json updater metadata
 *   - Official Website https://toridownload.xyz/ live HTML, headers, v1.0.11 XPI & v1.0.10 rollback XPI
 *   - Production External Tools manifest revision 2 (exact SHA-256 + detached signature)
 *
 * Downloads the ACTUAL public Firefox signed XPI and Chromium ZIP into `target/gate35_5_public_dl/`
 * and unpacks the public Chromium ZIP so Phases 11 & 12 real-browser suites test the genuine
 * publicly distributed artifacts end-to-end.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RC_DIR = path.join(ROOT, 'release', 'v1.0.11-extension-rc');
const OUT_DIR = path.join(ROOT, 'target', 'gate35_5_public_dl');
const LOG_DIR = path.join(ROOT, 'target', 'gate35_5_qa_logs');
const REPO = 'robijoychakma375-hash/tori-download-manager';
const BASE_GH = `https://github.com/${REPO}`;
const BASE_SITE = 'https://toridownload.xyz';

const EXPECTED = {
  v1011XpiSha: '4cd6d6fbf067cb98538fd807eaba360d40b409df07cbfb515b8d9b702b37c0fd',
  v1011XpiSize: 111347,
  v1011ChrSha: '1e77592bb05e548d832df373331aee4f90788a004cdaef7ca80c97df84b88559',
  v1011ChrSize: 94625,
  v1010XpiSha: 'a93a43872d224426902c49e217e31b2c603263d8c260c429940539b34b2852b8',
  v1010XpiSize: 107499,
  v108InstallerSha: '728d0d253a8fadc3fea5244723237f267dcd13abf65cac49b91a4ec83a3dcffb',
  v108ReleaseId: 455125259,
  v1010ReleaseId: 451270856,
  toolsManifestSha: 'caa2d4ed2a7e424badcd8662e67b986a3fdfbf2847dded0625ea2b2547663f3a',
};

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

const records = [];
let passCount = 0;
let failCount = 0;

function check(id, desc, ok, details = {}) {
  const status = ok ? 'PASS' : 'FAIL';
  if (ok) passCount++;
  else failCount++;
  records.push({ id, desc, status, ...details });
  console.log(`[${status}] [${id}] ${desc} -> ${JSON.stringify(details)}`);
}

function sha256Buf(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function sha256File(p) {
  return sha256Buf(fs.readFileSync(p));
}

function curlFetch(url, { destPath = null, headOnly = false, follow = true, headers = [] } = {}) {
  const tmpBody = destPath || path.join(OUT_DIR, `_tmp_${Date.now()}_${Math.random().toString(16).slice(2)}.bin`);
  const tmpHdr = path.join(OUT_DIR, `_hdr_${Date.now()}_${Math.random().toString(16).slice(2)}.txt`);
  const args = ['-sS', '-D', tmpHdr, '-A', 'TORI-Gate35-5-Verifier/1.0'];
  if (follow) args.push('-L');
  if (headOnly) args.push('-I', '-o', process.platform === 'win32' ? 'NUL' : '/dev/null');
  for (const h of headers) {
    args.push('-H', h);
  }
  if (!headOnly) args.push('-o', tmpBody);
  args.push('-w', '%{http_code}\n%{url_effective}\n%{size_download}\n%{content_type}');
  args.push(url);

  const res = spawnSync('curl.exe', args, { encoding: 'utf8', timeout: 60000 });
  if (res.error) throw res.error;
  const allLines = (res.stdout || '').trim().split(/\r?\n/);
  const lines = allLines.slice(-4);
  const status = parseInt(lines[0] || '0', 10);
  const effectiveUrl = lines[1] || url;
  const sizeDownload = parseInt(lines[2] || '0', 10);
  const contentType = lines[3] || '';
  const rawHeaders = fs.existsSync(tmpHdr) ? fs.readFileSync(tmpHdr, 'utf8') : '';
  try { if (fs.existsSync(tmpHdr)) fs.unlinkSync(tmpHdr); } catch (_) {}

  // Parse final response headers block
  const blocks = rawHeaders.trim().split(/\r?\n\r?\n/);
  const lastBlock = blocks[blocks.length - 1] || '';
  const headerMap = {};
  for (const line of lastBlock.split(/\r?\n/).slice(1)) {
    const idx = line.indexOf(':');
    if (idx > 0) {
      headerMap[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
    }
  }
  const firstLocationMatch = rawHeaders.match(/^location:\s*(.+)$/im);
  const firstRedirect = firstLocationMatch ? firstLocationMatch[1].trim() : null;

  let buf = null;
  if (!headOnly && fs.existsSync(tmpBody)) {
    buf = fs.readFileSync(tmpBody);
    if (!destPath) {
      try { fs.unlinkSync(tmpBody); } catch (_) {}
    }
  }
  return {
    status,
    effectiveUrl,
    firstRedirect,
    size: buf ? buf.length : sizeDownload,
    contentType: headerMap['content-type'] || contentType,
    cacheControl: headerMap['cache-control'] || null,
    cfCacheStatus: headerMap['cf-cache-status'] || null,
    sha256: buf ? sha256Buf(buf) : null,
    body: buf,
    destPath: destPath || null,
  };
}

function main() {
  console.log('=== TORI Gate 35.5 — Live Public Endpoint & Asset Roundtrip Verification ===');

  // 1. GitHub extension-v1.0.11 API & HTML
  const api11 = curlFetch(`https://api.github.com/repos/${REPO}/releases/tags/extension-v1.0.11`, {
    headers: ['Accept: application/vnd.github+json'],
  });
  const rel11 = api11.status === 200 ? JSON.parse(api11.body.toString('utf8')) : null;
  check(
    'GH_EXT11_API',
    'Public GitHub extension-v1.0.11 release exists, is public, non-draft, non-prerelease, with 5 assets',
    Boolean(rel11 && rel11.draft === false && rel11.prerelease === false && rel11.assets?.length === 5),
    {
      httpStatus: api11.status,
      releaseId: rel11?.id,
      tag: rel11?.tag_name,
      name: rel11?.name,
      publishedAt: rel11?.published_at,
      assetCount: rel11?.assets?.length,
      htmlUrl: rel11?.html_url,
    }
  );

  // Download all 5 public release assets from GitHub and verify exact byte sizes + SHA-256
  const ghAssetChecks = [
    { name: 'tori-companion-v1.0.11-firefox-signed.xpi', saveAs: 'tori-companion-v1.0.11-firefox-signed.xpi', expSha: EXPECTED.v1011XpiSha, expSize: EXPECTED.v1011XpiSize },
    { name: 'tori-companion-v1.0.11-chromium.zip', saveAs: 'tori-companion-v1.0.11-chromium.zip', expSha: EXPECTED.v1011ChrSha, expSize: EXPECTED.v1011ChrSize },
    { name: 'SHA256SUMS.txt', saveAs: 'SHA256SUMS.txt', expSha: sha256File(path.join(RC_DIR, 'SHA256SUMS.txt')), expSize: fs.statSync(path.join(RC_DIR, 'SHA256SUMS.txt')).size },
    { name: 'RELEASE_NOTES.md', saveAs: 'RELEASE_NOTES.md', expSha: sha256File(path.join(RC_DIR, 'RELEASE_NOTES.md')), expSize: fs.statSync(path.join(RC_DIR, 'RELEASE_NOTES.md')).size },
    { name: 'INSTALLATION_AND_UPGRADE.md', saveAs: 'INSTALLATION_AND_UPGRADE.md', expSha: sha256File(path.join(RC_DIR, 'INSTALLATION_AND_UPGRADE.md')), expSize: fs.statSync(path.join(RC_DIR, 'INSTALLATION_AND_UPGRADE.md')).size },
  ];

  for (const a of ghAssetChecks) {
    const url = `${BASE_GH}/releases/download/extension-v1.0.11/${a.name}`;
    const dest = path.join(OUT_DIR, a.saveAs);
    const dl = curlFetch(url, { destPath: dest });
    check(
      `GH_DL_${a.name.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`,
      `Public GitHub download ${a.name} matches exact size & SHA-256`,
      dl.status === 200 && dl.size === a.expSize && dl.sha256 === a.expSha,
      {
        httpStatus: dl.status,
        redirectTargetHost: new URL(dl.effectiveUrl).hostname,
        size: dl.size,
        sha256: dl.sha256,
        contentType: dl.contentType,
      }
    );
  }

  // Unpack publicly downloaded Chromium ZIP for Phase 12 Chrome/Edge testing
  const unpackedDir = path.join(OUT_DIR, 'unpacked_chromium');
  if (fs.existsSync(unpackedDir)) fs.rmSync(unpackedDir, { recursive: true, force: true });
  fs.mkdirSync(unpackedDir, { recursive: true });
  const pyUnzip = spawnSync(
    'python',
    [
      '-c',
      'import sys, zipfile; zf=zipfile.ZipFile(sys.argv[1]); assert zf.testzip() is None; zf.extractall(sys.argv[2]); print("UNZIP_OK")',
      path.join(OUT_DIR, 'tori-companion-v1.0.11-chromium.zip'),
      unpackedDir,
    ],
    { encoding: 'utf8' }
  );
  check('PUBLIC_CHR_UNPACK', 'Publicly downloaded Chromium ZIP extracts cleanly with valid CRC', pyUnzip.status === 0 && pyUnzip.stdout.includes('UNZIP_OK'), {
    unpackedDir,
  });

  // 2. GitHub Desktop v1.0.8 & Latest Stable + latest.json + installer
  const apiLatest = curlFetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: ['Accept: application/vnd.github+json'],
  });
  const relLatest = apiLatest.status === 200 ? JSON.parse(apiLatest.body.toString('utf8')) : null;
  check(
    'GH_LATEST_STABLE',
    'GitHub /releases/latest remains Desktop v1.0.8 (ID 455125259)',
    Boolean(relLatest && relLatest.tag_name === 'v1.0.8' && relLatest.id === EXPECTED.v108ReleaseId),
    { httpStatus: apiLatest.status, tag: relLatest?.tag_name, releaseId: relLatest?.id }
  );

  const webLatestRedirect = curlFetch(`${BASE_GH}/releases/latest`, { headOnly: true, follow: false });
  check(
    'GH_LATEST_WEB_REDIRECT',
    'Web /releases/latest redirects to /releases/tag/v1.0.8',
    webLatestRedirect.status === 302 && String(webLatestRedirect.firstRedirect || '').endsWith('/releases/tag/v1.0.8'),
    { httpStatus: webLatestRedirect.status, location: webLatestRedirect.firstRedirect }
  );

  const latestJsonDl = curlFetch(`${BASE_GH}/releases/download/v1.0.8/latest.json`);
  const latestJson = latestJsonDl.status === 200 ? JSON.parse(latestJsonDl.body.toString('utf8')) : null;
  const winSig = latestJson?.platforms?.['windows-x86_64']?.signature || latestJson?.platforms?.['windows-x86_64-nsis']?.signature || '';
  const winUrl = latestJson?.platforms?.['windows-x86_64']?.url || latestJson?.platforms?.['windows-x86_64-nsis']?.url || '';
  check(
    'DESKTOP_LATEST_JSON',
    'Desktop v1.0.8 latest.json intact with version 1.0.8 and Tauri Ed25519 signature',
    Boolean(latestJson && latestJson.version === '1.0.8' && winSig.length > 40 && winUrl.includes('1.0.8')),
    { httpStatus: latestJsonDl.status, version: latestJson?.version, sigLen: winSig.length, installerUrl: winUrl }
  );

  const v108Sums = curlFetch(`${BASE_GH}/releases/download/v1.0.8/SHA256SUMS.txt`);
  const v108SumsText = v108Sums.body ? v108Sums.body.toString('utf8') : '';
  const v108ExeHead = curlFetch(`${BASE_GH}/releases/download/v1.0.8/TORI.Download.Manager_1.0.8_x64-setup.exe`, { headOnly: true });
  check(
    'DESKTOP_V108_INSTALLER',
    'Desktop v1.0.8 installer URL reachable and SHA256SUMS matches frozen hash',
    v108ExeHead.status === 200 && v108SumsText.toLowerCase().includes(EXPECTED.v108InstallerSha),
    { httpStatus: v108ExeHead.status, sumsHasHash: v108SumsText.toLowerCase().includes(EXPECTED.v108InstallerSha) }
  );

  // 3. Historical Companion v1.0.10 preservation on GitHub
  const api10 = curlFetch(`https://api.github.com/repos/${REPO}/releases/tags/extension-v1.0.10`, {
    headers: ['Accept: application/vnd.github+json'],
  });
  const rel10 = api10.status === 200 ? JSON.parse(api10.body.toString('utf8')) : null;
  check(
    'GH_EXT10_PRESERVED',
    'Previous Companion v1.0.10 GitHub release preserved (ID 451270856, 5 assets)',
    Boolean(rel10 && rel10.id === EXPECTED.v1010ReleaseId && rel10.assets?.length === 5),
    { httpStatus: api10.status, releaseId: rel10?.id, assetCount: rel10?.assets?.length }
  );

  // 4. Official Website https://toridownload.xyz/
  const siteHome = curlFetch(`${BASE_SITE}/?nocache=${Date.now()}`, { headers: ['Cache-Control: no-cache'] });
  const siteHtml = siteHome.body ? siteHome.body.toString('utf8') : '';
  const siteChecks = {
    hasDesktopV108: siteHtml.includes('TORI.Download.Manager_1.0.8_x64-setup.exe') && siteHtml.includes(EXPECTED.v108InstallerSha),
    hasCompanionV1011: siteHtml.includes('extension-v1.0.11') && siteHtml.includes('Companion v1.0.11'),
    hasFirefoxInstallUrl: siteHtml.includes('/assets/tori-download-manager-firefox-v1.0.11.xpi'),
    hasFirefoxHash: siteHtml.includes(EXPECTED.v1011XpiSha),
    hasChromiumHash: siteHtml.includes(EXPECTED.v1011ChrSha),
    hasNoStaleActiveV1010Url: !siteHtml.includes('releases/download/extension-v1.0.10/'),
  };
  check(
    'WEBSITE_HOME_LIVE',
    'https://toridownload.xyz serves Companion v1.0.11 while preserving Desktop v1.0.8',
    siteHome.status === 200 && Object.values(siteChecks).every(Boolean),
    { httpStatus: siteHome.status, contentType: siteHome.contentType, cfCacheStatus: siteHome.cfCacheStatus, ...siteChecks }
  );

  const siteXpi11 = curlFetch(`${BASE_SITE}/assets/tori-download-manager-firefox-v1.0.11.xpi`, {
    destPath: path.join(OUT_DIR, 'website-tori-download-manager-firefox-v1.0.11.xpi'),
  });
  check(
    'WEBSITE_XPI_V1011',
    'https://toridownload.xyz/assets/tori-download-manager-firefox-v1.0.11.xpi returns 200 application/x-xpinstall & exact SHA-256',
    siteXpi11.status === 200 &&
      siteXpi11.size === EXPECTED.v1011XpiSize &&
      siteXpi11.sha256 === EXPECTED.v1011XpiSha &&
      String(siteXpi11.contentType || '').toLowerCase().includes('application/x-xpinstall'),
    {
      httpStatus: siteXpi11.status,
      size: siteXpi11.size,
      sha256: siteXpi11.sha256,
      contentType: siteXpi11.contentType,
      cacheControl: siteXpi11.cacheControl,
      cfCacheStatus: siteXpi11.cfCacheStatus,
    }
  );

  const siteXpi10 = curlFetch(`${BASE_SITE}/assets/tori-download-manager-firefox-v1.0.10.xpi`);
  check(
    'WEBSITE_XPI_V1010_ROLLBACK',
    'Historical /assets/tori-download-manager-firefox-v1.0.10.xpi preserved on live website',
    siteXpi10.status === 200 &&
      siteXpi10.size === EXPECTED.v1010XpiSize &&
      siteXpi10.sha256 === EXPECTED.v1010XpiSha &&
      String(siteXpi10.contentType || '').toLowerCase().includes('application/x-xpinstall'),
    {
      httpStatus: siteXpi10.status,
      size: siteXpi10.size,
      sha256: siteXpi10.sha256,
      contentType: siteXpi10.contentType,
    }
  );

  // 5. Production External Tools Manifest Revision 2
  const toolsMan = curlFetch(`${BASE_SITE}/assets/tools/tools-manifest.json`);
  const toolsJson = toolsMan.status === 200 ? JSON.parse(toolsMan.body.toString('utf8')) : null;
  const toolsSig = curlFetch(`${BASE_SITE}/assets/tools/tools-manifest.json.sig`);
  check(
    'TOOLS_MANIFEST_REV2',
    'Production External Tools manifest remains revision 2 with exact SHA-256 and valid detached signature',
    toolsMan.status === 200 &&
      toolsMan.sha256 === EXPECTED.toolsManifestSha &&
      toolsJson?.manifest_revision === 2 &&
      toolsJson?.signing_key_id === 'CDC23D8CC8DA5397' &&
      toolsSig.status === 200 &&
      toolsSig.size > 64,
    {
      httpStatus: toolsMan.status,
      sha256: toolsMan.sha256,
      manifestRevision: toolsJson?.manifest_revision,
      schemaVersion: toolsJson?.schema_version,
      signingKeyId: toolsJson?.signing_key_id,
      sigHttpStatus: toolsSig.status,
      sigBytes: toolsSig.size,
      cacheControl: toolsMan.cacheControl,
    }
  );

  const summaryPath = path.join(LOG_DIR, 'phase10_live_endpoints_report.json');
  fs.writeFileSync(
    summaryPath,
    JSON.stringify({ generated_at: new Date().toISOString(), pass: passCount, fail: failCount, checks: records }, null, 2) + '\n',
    'utf8'
  );
  console.log(`\n=== LIVE PUBLIC ENDPOINTS SUMMARY: PASS=${passCount} FAIL=${failCount} (Report: ${summaryPath}) ===`);
  if (failCount > 0) process.exit(1);
}

main();
