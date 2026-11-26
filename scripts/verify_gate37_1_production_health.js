#!/usr/bin/env node
/**
 * TORI Download Manager — Gate 37.1 Read-Only Production Health & Supply-Chain Monitor
 *
 * STRICTLY READ-ONLY: NEVER modifies GitHub releases, tags, website, Cloudflare,
 * External Tools manifests, signing keys, or local operator data.
 *
 * Verifies:
 *   1. Desktop v1.0.9: GitHub Latest Stable, tag v1.0.9, 16-asset inventory, installer SHA-256
 *      (streaming hash), detached .sig SHA-256, latest.json UTF-8 no-BOM + Ed25519 signature +
 *      tamper rejection, and zero unexpected metadata drift.
 *   2. Browser Companion v1.0.11: GitHub extension-v1.0.11 (ID 458864802), Mozilla-signed Firefox
 *      XPI SHA-256, Chromium ZIP SHA-256, plus historical Desktop v1.0.8 (ID 455125259) &
 *      rollback Companion v1.0.10 availability.
 *   3. Official Website (https://toridownload.xyz): HTTP->HTTPS redirect, HTTPS 200, Desktop v1.0.9
 *      version/link/hash, Companion v1.0.11 links/hashes, website-hosted signed XPI SHA-256,
 *      JSON-LD structured data, and sitemap.xml.
 *   4. External Tools Manifest Rev 2: manifest_revision == 2, SHA-256, detached .sig SHA-256,
 *      Ed25519 signature verification (CDC23D8CC8DA5397), expiry tracking & threshold classification,
 *      and unexpected signer drift detection.
 *
 * Failure Classification:
 *   - NETWORK_OUTAGE / NETWORK_TIMEOUT (transient reachability errors; retried with backoff)
 *   - ARTIFACT_CORRUPTION / SIGNATURE_INVALID (critical integrity/cryptographic mismatch)
 *   - METADATA_DRIFT / WEBSITE_DRIFT / ASSET_MISSING / MALFORMED_METADATA
 *   - EXPIRY_ALERT / EXPIRED_INCIDENT
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');

const DEFAULT_EXPECTED = {
  repo: 'robijoychakma375-hash/tori-download-manager',
  desktop: {
    tag: 'v1.0.9',
    version: '1.0.9',
    releaseId: 458899884,
    minAssets: 16,
    installerName: 'TORI.Download.Manager_1.0.9_x64-setup.exe',
    installerBytes: 118170722,
    installerSha256: '460f5da00d09267a5f33274645250d92162bbfa3605f0348cc656a39a8a19ead',
    sigName: 'TORI.Download.Manager_1.0.9_x64-setup.exe.sig',
    sigBytes: 436,
    sigSha256: '9fd6f9e8a46e93dd1e1f6212b9d174aba3cc23761c55704f2a407965cb385aa0',
    latestJsonSha256: '04a7fdfa7ec0299e13a43a75687b1ae912517a32fa34eff0eb789d4e65c8d85d',
    updaterKeyId: 'CDC23D8CC8DA5397',
    updaterPubkeyB64:
      'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IENEQzIzRDhDQzhEQTUzOTcKUldTWFU5cklqRDNDelRBOVAzOSs1L0RXN0FFLy9YWGFJc2NnUStaNktxSkNOQ1ZCeG01MjFTZzQK',
    historicalV108Id: 455125259,
  },
  companion: {
    tag: 'extension-v1.0.11',
    version: '1.0.11',
    releaseId: 458864802,
    firefoxAsset: 'tori-companion-v1.0.11-firefox-signed.xpi',
    firefoxSha256: '4cd6d6fbf067cb98538fd807eaba360d40b409df07cbfb515b8d9b702b37c0fd',
    chromiumAsset: 'tori-companion-v1.0.11-chromium.zip',
    chromiumSha256: '1e77592bb05e548d832df373331aee4f90788a004cdaef7ca80c97df84b88559',
    historicalV1010Tag: 'extension-v1.0.10',
  },
  toolsManifest: {
    revision: 2,
    schemaVersion: 2,
    signingKeyId: 'CDC23D8CC8DA5397',
    manifestSha256: 'caa2d4ed2a7e424badcd8662e67b986a3fdfbf2847dded0625ea2b2547663f3a',
    sigSha256: '11efa53f290d3d46fb16915fd3d1e69451de8c654eae8d75844b840ab99bb1c2',
    expiresAt: '2027-01-21T19:46:42.049Z',
    pubkeyB64:
      'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IENEQzIzRDhDQzhEQTUzOTcKUldTWFU5cklqRDNDelRBOVAzOSs1L0RXN0FFLy9YWGFJc2NnUStaNktxSkNOQ1ZCeG01MjFTZzQK',
  },
  endpoints: {
    ghApiBase: 'https://api.github.com',
    ghWebBase: 'https://github.com',
    websiteBase: 'https://toridownload.xyz',
    websiteHttp: 'http://toridownload.xyz/',
  },
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function sha256Buf(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function verifyMinisignEd25519(payloadInput, sigTextRaw, pubkeyB64, expectedKeyId) {
  const pubLines = Buffer.from(pubkeyB64.trim(), 'base64').toString('utf8').trim().split(/\r?\n/);
  const pkRaw = Buffer.from(pubLines[1].trim(), 'base64');
  const keyId = pkRaw.subarray(2, 10);
  const keyIdHex = Buffer.from(keyId).reverse().toString('hex').toUpperCase();
  if (expectedKeyId && keyIdHex !== expectedKeyId.toUpperCase()) {
    return { valid: false, error: `PUBKEY_ID_MISMATCH:${keyIdHex}!=${expectedKeyId}` };
  }
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), pkRaw.subarray(10, 42)]);
  const pubKey = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });

  const trimmed = sigTextRaw.trim();
  const sigText = trimmed.includes('\n') ? trimmed : Buffer.from(trimmed, 'base64').toString('utf8').trim();
  const lines = sigText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 4) return { valid: false, error: 'MALFORMED_MINISIGN_SIG' };
  const sigRaw = Buffer.from(lines[1], 'base64');
  const alg = sigRaw.subarray(0, 2).toString('ascii');
  if (!sigRaw.subarray(2, 10).equals(keyId)) return { valid: false, error: 'SIGNATURE_KEY_ID_MISMATCH' };
  const sigBytes = sigRaw.subarray(10, 74);
  const tc = lines[2].slice('trusted comment: '.length);
  const gsig = Buffer.from(lines[3], 'base64');

  let msg;
  if (alg === 'ED') {
    if (payloadInput && payloadInput.blake2b512) {
      msg = payloadInput.blake2b512;
    } else {
      msg = crypto.createHash('blake2b512').update(payloadInput).digest();
    }
  } else {
    if (Buffer.isBuffer(payloadInput)) msg = payloadInput;
    else return { valid: false, error: 'LEGACY_NON_PREHASHED_REQUIRES_BUFFER' };
  }
  const ok1 = crypto.verify(null, msg, pubKey, sigBytes);
  const ok2 = crypto.verify(null, Buffer.concat([sigBytes, Buffer.from(tc, 'utf8')]), pubKey, gsig);
  return { valid: Boolean(ok1 && ok2), keyIdHex, trustedComment: tc, error: ok1 && ok2 ? null : 'ED25519_VERIFY_FAILED' };
}

function classifyNetworkError(err) {
  const msg = String(err?.message || err || '');
  if (/timeout|ETIMEDOUT|ABORT/i.test(msg)) return 'NETWORK_TIMEOUT';
  return 'NETWORK_OUTAGE';
}

function requestOnce(rawUrl, { method = 'GET', headers = {}, timeoutMs = 20000, maxRedirects = 8, streamHashOnly = false, followRedirects = true } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(rawUrl);
    } catch (e) {
      return reject(new Error(`INVALID_URL: ${rawUrl}`));
    }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method,
        timeout: timeoutMs,
        headers: {
          'User-Agent': 'TORI-Gate37_1-HealthMonitor/1.0.9',
          'Cache-Control': 'no-cache, no-store',
          Pragma: 'no-cache',
          ...headers,
        },
      },
      (res) => {
        if (followRedirects && [301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          if (maxRedirects <= 0) return reject(new Error(`REDIRECT_LOOP: ${rawUrl}`));
          const next = new URL(res.headers.location, rawUrl).toString();
          const nextHeaders = { ...headers };
          if (new URL(next).hostname !== u.hostname) delete nextHeaders.Authorization;
          return resolve(requestOnce(next, { method, headers: nextHeaders, timeoutMs, maxRedirects: maxRedirects - 1, streamHashOnly, followRedirects }));
        }
        if (streamHashOnly) {
          const sha = crypto.createHash('sha256');
          const b2b = crypto.createHash('blake2b512');
          let bytes = 0;
          res.on('data', (chunk) => {
            bytes += chunk.length;
            sha.update(chunk);
            b2b.update(chunk);
          });
          res.on('end', () => {
            resolve({
              status: res.statusCode,
              finalUrl: rawUrl,
              headers: res.headers,
              bytes,
              sha256: sha.digest('hex'),
              blake2b512: b2b.digest(),
            });
          });
          res.on('error', reject);
        } else {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const body = Buffer.concat(chunks);
            resolve({
              status: res.statusCode,
              finalUrl: rawUrl,
              headers: res.headers,
              bytes: body.length,
              body,
              sha256: sha256Buf(body),
            });
          });
          res.on('error', reject);
        }
      }
    );
    req.on('timeout', () => req.destroy(new Error(`TIMEOUT after ${timeoutMs}ms requesting ${rawUrl}`)));
    req.on('error', reject);
    req.end();
  });
}

async function fetchWithRetry(url, opts = {}) {
  const retries = opts.retries ?? 2;
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await requestOnce(url, opts);
      if (res.status >= 500 && attempt < retries) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(500 * (attempt + 1));
    }
  }
  throw lastErr;
}

async function runHealthCheck(options = {}) {
  const cfg = {
    ...DEFAULT_EXPECTED,
    ...options.expected,
    desktop: { ...DEFAULT_EXPECTED.desktop, ...(options.expected?.desktop || {}) },
    companion: { ...DEFAULT_EXPECTED.companion, ...(options.expected?.companion || {}) },
    toolsManifest: { ...DEFAULT_EXPECTED.toolsManifest, ...(options.expected?.toolsManifest || {}) },
    endpoints: { ...DEFAULT_EXPECTED.endpoints, ...(options.expected?.endpoints || {}) },
  };
  const timeoutMs = options.timeoutMs ?? 30000;
  const retries = options.retries ?? 2;
  const streamTimeoutMs = options.streamTimeoutMs ?? 300000;
  const nowUtc = options.nowUtc ? new Date(options.nowUtc) : new Date();
  const ghHeaders = { Accept: 'application/vnd.github+json' };
  if (options.githubToken) ghHeaders.Authorization = `Bearer ${options.githubToken}`;

  const checks = [];
  function addCheck(id, domain, status, category, detail, recommendedAction = null) {
    checks.push({
      id,
      domain,
      status, // PASS | WARN | FAIL
      category, // OK | NETWORK_OUTAGE | NETWORK_TIMEOUT | ARTIFACT_CORRUPTION | SIGNATURE_INVALID | METADATA_DRIFT | WEBSITE_DRIFT | ASSET_MISSING | MALFORMED_METADATA | EXPIRY_ALERT | EXPIRED_INCIDENT
      timestamp_utc: new Date().toISOString(),
      detail,
      recommended_action: recommendedAction,
    });
  }

  // --- 1. DESKTOP v1.0.9 CHECKS ---
  let liveLatestJson = null;
  let liveSigText = null;
  try {
    const rRel = await fetchWithRetry(`${cfg.endpoints.ghApiBase}/repos/${cfg.repo}/releases/latest`, { headers: ghHeaders, timeoutMs, retries });
    if (rRel.status !== 200) {
      addCheck('DESK-01', 'desktop', 'FAIL', rRel.status >= 500 ? 'NETWORK_OUTAGE' : 'METADATA_DRIFT', { httpStatus: rRel.status }, 'Inspect GitHub Releases API availability and Latest Stable designation.');
    } else {
      const rel = JSON.parse(rRel.body.toString('utf8'));
      const assetNames = (rel.assets || []).map((a) => a.name);
      const hasInst = assetNames.includes(cfg.desktop.installerName);
      const hasSig = assetNames.includes(cfg.desktop.sigName);
      const hasLatest = assetNames.includes('latest.json');
      const ok = rel.tag_name === cfg.desktop.tag && rel.id === cfg.desktop.releaseId && !rel.draft && !rel.prerelease && assetNames.length >= cfg.desktop.minAssets && hasInst && hasSig && hasLatest;
      const cat = !hasInst || !hasSig || !hasLatest ? 'ASSET_MISSING' : ok ? 'OK' : 'METADATA_DRIFT';
      addCheck(
        'DESK-01',
        'desktop',
        ok ? 'PASS' : 'FAIL',
        cat,
        { httpStatus: rRel.status, tag: rel.tag_name, releaseId: rel.id, assetCount: assetNames.length, hasInstaller: hasInst, hasSig, hasLatestJson: hasLatest },
        ok ? null : 'Verify GitHub Latest Stable points to Desktop v1.0.9 (ID 458899884) with all 16 required assets.'
      );
    }
  } catch (err) {
    addCheck('DESK-01', 'desktop', 'FAIL', classifyNetworkError(err), { error: err.message }, 'Retry after verifying network/GitHub API reachability.');
  }

  // Verify v1.0.9 Git tag exists
  try {
    const rTag = await fetchWithRetry(`${cfg.endpoints.ghApiBase}/repos/${cfg.repo}/git/ref/tags/${cfg.desktop.tag}`, { headers: ghHeaders, timeoutMs, retries });
    const ok = rTag.status === 200;
    addCheck('DESK-02', 'desktop', ok ? 'PASS' : 'FAIL', ok ? 'OK' : 'METADATA_DRIFT', { httpStatus: rTag.status, tag: cfg.desktop.tag }, ok ? null : 'Restore or audit immutable Git tag v1.0.9.');
  } catch (err) {
    addCheck('DESK-02', 'desktop', 'FAIL', classifyNetworkError(err), { error: err.message }, 'Retry GitHub tag ref check.');
  }

  // Verify live latest.json & detached .sig
  let installerDownloadUrl = `${cfg.endpoints.ghWebBase}/${cfg.repo}/releases/download/${cfg.desktop.tag}/${cfg.desktop.installerName}`;
  try {
    const rLj = await fetchWithRetry(`${cfg.endpoints.ghWebBase}/${cfg.repo}/releases/latest/download/latest.json`, { timeoutMs, retries });
    const rSig = await fetchWithRetry(`${cfg.endpoints.ghWebBase}/${cfg.repo}/releases/download/${cfg.desktop.tag}/${cfg.desktop.sigName}`, { timeoutMs, retries });
    if (rLj.status !== 200 || rSig.status !== 200) {
      addCheck('DESK-03', 'desktop', 'FAIL', 'ASSET_MISSING', { latestJsonStatus: rLj.status, sigStatus: rSig.status }, 'Confirm latest.json and .sig assets are attached to Desktop v1.0.9.');
    } else {
      const hasBom = rLj.body[0] === 0xef && rLj.body[1] === 0xbb && rLj.body[2] === 0xbf;
      let parsed = null;
      try {
        parsed = JSON.parse(rLj.body.toString('utf8'));
      } catch (e) {
        addCheck('DESK-03', 'desktop', 'FAIL', 'MALFORMED_METADATA', { error: e.message, sha256: rLj.sha256 }, 'Repair malformed latest.json immediately and verify UTF-8 no-BOM JSON.');
      }
      if (parsed) {
        liveLatestJson = parsed;
        liveSigText = rSig.body.toString('utf8').trim();
        const platSig = parsed?.platforms?.['windows-x86_64']?.signature?.trim();
        const platUrl = parsed?.platforms?.['windows-x86_64']?.url || '';
        const sigMatch = platSig === liveSigText;
        const sigHashMatch = rSig.sha256 === cfg.desktop.sigSha256;
        const ljHashMatch = !cfg.desktop.latestJsonSha256 || rLj.sha256 === cfg.desktop.latestJsonSha256;
        const verOk = parsed.version === cfg.desktop.version;
        const urlOk = platUrl.endsWith(`/${cfg.desktop.installerName}`);
        if (options.useLatestJsonUrl && platUrl) installerDownloadUrl = platUrl;
        const ok = !hasBom && verOk && sigMatch && sigHashMatch && ljHashMatch && urlOk;
        const cat = !sigHashMatch || !sigMatch ? 'ARTIFACT_CORRUPTION' : !verOk || !ljHashMatch || !urlOk || hasBom ? 'METADATA_DRIFT' : 'OK';
        addCheck(
          'DESK-03',
          'desktop',
          ok ? 'PASS' : 'FAIL',
          cat,
          {
            latestJsonStatus: rLj.status,
            latestJsonBytes: rLj.bytes,
            latestJsonSha256: rLj.sha256,
            utf8Bom: hasBom,
            version: parsed.version,
            sigSha256: rSig.sha256,
            sigParity: sigMatch,
            urlOk,
          },
          ok ? null : 'Audit latest.json and detached .sig against frozen Desktop v1.0.9 SHA256SUMS.'
        );
      }
    }
  } catch (err) {
    addCheck('DESK-03', 'desktop', 'FAIL', classifyNetworkError(err), { error: err.message }, 'Verify GitHub release download reachability.');
  }

  // Streaming installer SHA-256 & Ed25519 signature verification
  try {
    const rInst = await fetchWithRetry(installerDownloadUrl, { timeoutMs: streamTimeoutMs, retries, streamHashOnly: true });
    if (rInst.status !== 200) {
      addCheck('DESK-04', 'desktop', 'FAIL', rInst.status === 404 ? 'ASSET_MISSING' : 'NETWORK_OUTAGE', { httpStatus: rInst.status, url: installerDownloadUrl }, 'Verify v1.0.9 installer asset exists on GitHub release 458899884.');
    } else {
      const hashOk = rInst.sha256 === cfg.desktop.installerSha256 && rInst.bytes === cfg.desktop.installerBytes;
      let sigRes = { valid: false, error: 'NO_SIG_AVAILABLE' };
      if (liveSigText) {
        sigRes = verifyMinisignEd25519({ blake2b512: rInst.blake2b512 }, liveSigText, cfg.desktop.updaterPubkeyB64, cfg.desktop.updaterKeyId);
      }
      const ok = hashOk && sigRes.valid;
      const cat = !hashOk ? 'ARTIFACT_CORRUPTION' : !sigRes.valid ? 'SIGNATURE_INVALID' : 'OK';
      addCheck(
        'DESK-04',
        'desktop',
        ok ? 'PASS' : 'FAIL',
        cat,
        {
          httpStatus: rInst.status,
          bytes: rInst.bytes,
          sha256: rInst.sha256,
          hashMatch: hashOk,
          ed25519Valid: sigRes.valid,
          keyId: sigRes.keyIdHex || cfg.desktop.updaterKeyId,
          sigError: sigRes.error,
        },
        ok ? null : 'CRITICAL: Stop distribution immediately and follow Gate 37.1 Production Rollback Runbook.'
      );
    }
  } catch (err) {
    addCheck('DESK-04', 'desktop', 'FAIL', classifyNetworkError(err), { error: err.message }, 'Retry installer download verification on stable network.');
  }

  // --- 2. BROWSER COMPANION v1.0.11 & HISTORICAL PRESERVATION CHECKS ---
  try {
    const rComp = await fetchWithRetry(`${cfg.endpoints.ghApiBase}/repos/${cfg.repo}/releases/tags/${cfg.companion.tag}`, { headers: ghHeaders, timeoutMs, retries });
    const rXpi = await fetchWithRetry(`${cfg.endpoints.ghWebBase}/${cfg.repo}/releases/download/${cfg.companion.tag}/${cfg.companion.firefoxAsset}`, { timeoutMs, retries });
    const rChr = await fetchWithRetry(`${cfg.endpoints.ghWebBase}/${cfg.repo}/releases/download/${cfg.companion.tag}/${cfg.companion.chromiumAsset}`, { timeoutMs, retries });
    const r108 = await fetchWithRetry(`${cfg.endpoints.ghApiBase}/repos/${cfg.repo}/releases/tags/v1.0.8`, { headers: ghHeaders, timeoutMs, retries });
    const r1010 = await fetchWithRetry(`${cfg.endpoints.ghApiBase}/repos/${cfg.repo}/releases/tags/${cfg.companion.historicalV1010Tag}`, { headers: ghHeaders, timeoutMs, retries });

    const compObj = rComp.status === 200 ? JSON.parse(rComp.body.toString('utf8')) : null;
    const v108Obj = r108.status === 200 ? JSON.parse(r108.body.toString('utf8')) : null;
    const xpiOk = rXpi.status === 200 && rXpi.sha256 === cfg.companion.firefoxSha256;
    const chrOk = rChr.status === 200 && rChr.sha256 === cfg.companion.chromiumSha256;
    const histOk = v108Obj?.id === cfg.desktop.historicalV108Id && r1010.status === 200;
    const ok = compObj?.id === cfg.companion.releaseId && xpiOk && chrOk && histOk;
    const cat = rXpi.status === 404 || rChr.status === 404 ? 'ASSET_MISSING' : !xpiOk || !chrOk ? 'ARTIFACT_CORRUPTION' : ok ? 'OK' : 'METADATA_DRIFT';
    addCheck(
      'COMP-01',
      'companion',
      ok ? 'PASS' : 'FAIL',
      cat,
      {
        companionReleaseId: compObj?.id,
        firefoxStatus: rXpi.status,
        firefoxSha256: rXpi.sha256,
        firefoxMatch: xpiOk,
        chromiumStatus: rChr.status,
        chromiumSha256: rChr.sha256,
        chromiumMatch: chrOk,
        historicalV108Intact: v108Obj?.id === cfg.desktop.historicalV108Id,
        historicalV1010Intact: r1010.status === 200,
      },
      ok ? null : 'Audit Browser Companion v1.0.11 (ID 458864802) and historical release preservation.'
    );
  } catch (err) {
    addCheck('COMP-01', 'companion', 'FAIL', classifyNetworkError(err), { error: err.message }, 'Retry Companion v1.0.11 release audit.');
  }

  // --- 3. OFFICIAL WEBSITE CHECKS ---
  try {
    let httpsRedirectOk = true;
    let redirectLocation = null;
    if (cfg.endpoints.websiteHttp) {
      const rRedir = await fetchWithRetry(cfg.endpoints.websiteHttp, { timeoutMs, retries, followRedirects: false });
      redirectLocation = rRedir.headers?.location || '';
      httpsRedirectOk = [301, 302, 307, 308].includes(rRedir.status) && redirectLocation.startsWith('https://');
    }
    const rWeb = await fetchWithRetry(`${cfg.endpoints.websiteBase}/`, { timeoutMs, retries });
    const rWebXpi = await fetchWithRetry(`${cfg.endpoints.websiteBase}/assets/tori-download-manager-firefox-v1.0.11.xpi`, { timeoutMs, retries });
    const rSite = await fetchWithRetry(`${cfg.endpoints.websiteBase}/sitemap.xml`, { timeoutMs, retries });

    const html = rWeb.body.toString('utf8');
    const hasVer = html.includes(`"softwareVersion": "${cfg.desktop.version}"`);
    const hasDeskUrl = html.includes(`releases/download/${cfg.desktop.tag}/${cfg.desktop.installerName}`);
    const hasDeskSha = html.includes(cfg.desktop.installerSha256);
    const hasCompUrls = html.includes(cfg.companion.firefoxAsset) && html.includes(cfg.companion.chromiumAsset);
    const webXpiOk = rWebXpi.status === 200 && rWebXpi.sha256 === cfg.companion.firefoxSha256;
    const siteOk = rSite.status === 200;

    const ok = rWeb.status === 200 && httpsRedirectOk && hasVer && hasDeskUrl && hasDeskSha && hasCompUrls && webXpiOk && siteOk;
    const cat = !webXpiOk && rWebXpi.status === 200 ? 'ARTIFACT_CORRUPTION' : ok ? 'OK' : 'WEBSITE_DRIFT';
    addCheck(
      'WEB-01',
      'website',
      ok ? 'PASS' : 'FAIL',
      cat,
      {
        httpStatus: rWeb.status,
        bytes: rWeb.bytes,
        httpsRedirectOk,
        redirectLocation,
        hasDesktopVersion: hasVer,
        hasDesktopUrl: hasDeskUrl,
        hasDesktopSha256: hasDeskSha,
        hasCompanionUrls: hasCompUrls,
        websiteFirefoxXpiSha256: rWebXpi.sha256,
        websiteFirefoxXpiMatch: webXpiOk,
        sitemapStatus: rSite.status,
      },
      ok ? null : 'Audit toridownload.xyz Cloudflare deployment against verified Desktop v1.0.9 + Companion v1.0.11 baseline.'
    );
  } catch (err) {
    addCheck('WEB-01', 'website', 'FAIL', classifyNetworkError(err), { error: err.message }, 'Verify Cloudflare edge / toridownload.xyz DNS & HTTPS reachability.');
  }

  // --- 4. EXTERNAL TOOLS MANIFEST REV 2 CHECKS ---
  try {
    const rMan = await fetchWithRetry(`${cfg.endpoints.websiteBase}/assets/tools/tools-manifest.json`, { timeoutMs, retries });
    const rManSig = await fetchWithRetry(`${cfg.endpoints.websiteBase}/assets/tools/tools-manifest.json.sig`, { timeoutMs, retries });
    if (rMan.status !== 200 || rManSig.status !== 200) {
      addCheck('TOOLS-01', 'external_tools', 'FAIL', 'ASSET_MISSING', { manifestStatus: rMan.status, sigStatus: rManSig.status }, 'Restore External Tools manifest rev 2 and detached .sig immediately.');
    } else {
      const man = JSON.parse(rMan.body.toString('utf8'));
      const sigVer = verifyMinisignEd25519(rMan.body, rManSig.body.toString('utf8'), cfg.toolsManifest.pubkeyB64, cfg.toolsManifest.signingKeyId);
      const revOk = man.manifest_revision === cfg.toolsManifest.revision && man.schema_version === cfg.toolsManifest.schemaVersion;
      const signerOk = man.signing_key_id === cfg.toolsManifest.signingKeyId;
      const shaOk = rMan.sha256 === cfg.toolsManifest.manifestSha256 && rManSig.sha256 === cfg.toolsManifest.sigSha256;
      const expMs = Date.parse(man.expires_at);
      const daysRemaining = Number.isFinite(expMs) ? (expMs - nowUtc.getTime()) / (1000 * 60 * 60 * 24) : -999;

      let expStatus = 'PASS';
      let expCat = 'OK';
      let expAction = null;
      if (!Number.isFinite(expMs) || daysRemaining <= 0) {
        expStatus = 'FAIL';
        expCat = 'EXPIRED_INCIDENT';
        expAction = 'URGENT: External Tools manifest has EXPIRED; execute Gate 37.1 Manifest Renewal Runbook immediately.';
      } else if (daysRemaining <= 7) {
        expStatus = 'WARN';
        expCat = 'EXPIRY_ALERT';
        expAction = 'HIGH PRIORITY: Renew External Tools manifest immediately (<7 days remaining).';
      } else if (daysRemaining <= 30) {
        expStatus = 'WARN';
        expCat = 'EXPIRY_ALERT';
        expAction = 'Renewal window open (<=30 days remaining); schedule controlled Stage 1 manifest renewal.';
      }

      const integrityOk = sigVer.valid && revOk && signerOk && shaOk;
      const finalStatus = !integrityOk ? 'FAIL' : expStatus;
      const finalCat = !sigVer.valid ? 'SIGNATURE_INVALID' : !signerOk || !revOk ? 'METADATA_DRIFT' : !shaOk ? 'ARTIFACT_CORRUPTION' : expCat;
      addCheck(
        'TOOLS-01',
        'external_tools',
        finalStatus,
        finalCat,
        {
          manifestStatus: rMan.status,
          sigStatus: rManSig.status,
          revision: man.manifest_revision,
          schemaVersion: man.schema_version,
          signingKeyId: man.signing_key_id,
          manifestSha256: rMan.sha256,
          sigSha256: rManSig.sha256,
          ed25519Valid: sigVer.valid,
          expiresAt: man.expires_at,
          daysRemaining: Math.round(daysRemaining * 100) / 100,
        },
        !integrityOk ? 'Investigate unauthorized or corrupted External Tools manifest/signature immediately.' : expAction
      );
    }
  } catch (err) {
    addCheck('TOOLS-01', 'external_tools', 'FAIL', classifyNetworkError(err), { error: err.message }, 'Verify External Tools CDN endpoint reachability.');
  }

  const failCount = checks.filter((c) => c.status === 'FAIL').length;
  const warnCount = checks.filter((c) => c.status === 'WARN').length;
  const passCount = checks.filter((c) => c.status === 'PASS').length;
  const overall = failCount > 0 ? 'FAIL' : warnCount > 0 ? 'WARN' : 'PASS';

  return {
    monitor_version: 'gate37_1',
    read_only: true,
    remote_mutations: 0,
    checked_at_utc: nowUtc.toISOString(),
    overall_status: overall,
    counts: { total: checks.length, pass: passCount, warn: warnCount, fail: failCount },
    checks,
  };
}

if (require.main === module) {
  (async () => {
    const argv = process.argv.slice(2);
    const getArg = (flag, fallback = null) => {
      const i = argv.indexOf(flag);
      return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
    };
    const jsonOut = getArg('--json-out', path.join(ROOT, 'target', 'gate37_1_evidence', 'production_health_report.json'));
    const timeoutMs = parseInt(getArg('--timeout-ms', '30000'), 10);
    const retries = parseInt(getArg('--retries', '2'), 10);

    // Optionally reuse git credential token strictly for higher GitHub API rate limits (read-only GET only)
    let githubToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null;
    if (!githubToken && !argv.includes('--unauthenticated')) {
      try {
        const { spawnSync } = require('child_process');
        const p = spawnSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8', timeout: 5000 });
        const m = (p.stdout || '').match(/^password=(.+)$/m);
        if (m) githubToken = m[1].trim();
      } catch {}
    }

    const report = await runHealthCheck({ timeoutMs, retries, githubToken });
    fs.mkdirSync(path.dirname(jsonOut), { recursive: true });
    fs.writeFileSync(jsonOut, JSON.stringify(report, null, 2) + '\n', 'utf8');

    console.log(`=== TORI Production Health Monitor (Gate 37.1 — Read-Only) ===`);
    for (const c of report.checks) {
      console.log(`[${c.status}] [${c.id}] (${c.domain}/${c.category}) -> ${JSON.stringify(c.detail)}`);
      if (c.recommended_action) console.log(`       Action: ${c.recommended_action}`);
    }
    console.log(`\nOVERALL=${report.overall_status} PASS=${report.counts.pass} WARN=${report.counts.warn} FAIL=${report.counts.fail} REPORT=${jsonOut}`);
    process.exit(report.overall_status === 'FAIL' ? 1 : 0);
  })().catch((err) => {
    console.error('[FATAL]', err.message || err);
    process.exit(1);
  });
}

module.exports = { runHealthCheck, verifyMinisignEd25519, DEFAULT_EXPECTED };
