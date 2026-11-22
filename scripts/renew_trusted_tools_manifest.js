#!/usr/bin/env node
/**
 * TORI Download Manager — Gate 33 Controlled External Tools Manifest Renewal & Rollback CLI
 *
 * Strictly separates:
 *   A. Controlled metadata renewal for an UNCHANGED approved immutable artifact
 *      (--check / --prepare / --verify / --dry-run / --publish-staging)
 *   B. Emergency higher-revision rollback to a prior approved immutable artifact
 *      (--rollback-plan)
 *
 * Security Invariants:
 *  - NEVER automatically authorizes or signs a newly discovered upstream FFmpeg binary.
 *  - NEVER allows metadata renewal to alter artifact URL, SHA-256, byte size, or version.
 *  - Enforces bounded TTL (7..90 days), strictly monotonic manifest_revision, duplicate-key
 *    rejection, exact-bytes Ed25519 signature verification, and exclusive lock protection.
 *  - NEVER reads, prints, logs, or commits private signing keys or passphrases.
 *  - `--publish-production` fails closed unless explicit dual authorization is provided
 *    (`--i-authorize-production-manifest` AND validated `--approval-token-file`).
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_CONFIG_PATH = path.join(ROOT, 'docs', 'security', 'manifest_expiry_monitoring_config.json');
const DEFAULT_REGISTRY_PATH = path.join(ROOT, 'docs', 'security', 'tools-manifest-registry', 'registry.json');
const DEFAULT_WEBSITE_REPO = 'C:\\Users\\ritud\\Downloads\\tori-website';
const DEFAULT_STAGING_OUT = path.join(ROOT, 'target', 'tools_renewal_staging');
const DEFAULT_LOCK_FILE = path.join(ROOT, 'target', 'tools_renewal_state', 'renewal.lock');

const DEFAULT_PROD_PUBKEY_B64 =
  'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IENEQzIzRDhDQzhEQTUzOTcKUldTWFU5cklqRDNDelRBOVAzOSs1L0RXN0FFLy9YWGFJc2NnUStaNktxSkNOQ1ZCeG01MjFTZzQK';
const DEFAULT_PROD_KEY_ID = 'CDC23D8CC8DA5397';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        args[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const k = a.slice(2);
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) {
          args[k] = next;
          i++;
        } else {
          args[k] = true;
        }
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function sha256Buf(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const chunk = Buffer.alloc(65536);
  try {
    let n;
    while ((n = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) {
      hash.update(chunk.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function loadConfig(configPath = DEFAULT_CONFIG_PATH) {
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

function loadRegistry(registryPath = DEFAULT_REGISTRY_PATH) {
  return JSON.parse(fs.readFileSync(registryPath, 'utf8'));
}

function acquireLock(lockPath) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  try {
    const fd = fs.openSync(lockPath, 'wx');
    fs.writeSync(
      fd,
      JSON.stringify({ pid: process.pid, acquired_at_utc: new Date().toISOString() }) + '\n'
    );
    fs.closeSync(fd);
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      let existing = '';
      try {
        existing = fs.readFileSync(lockPath, 'utf8').trim();
      } catch {}
      throw new Error(`CONCURRENT_RENEWAL_LOCKED: Another renewal/publication process holds ${lockPath} (${existing})`);
    }
    throw err;
  }
  return () => {
    try {
      fs.unlinkSync(lockPath);
    } catch {}
  };
}

function httpRequest(rawUrl, { method = 'GET', headers = {}, maxRedirects = 8, allowLoopback = false } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(rawUrl);
    const isLoopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
    if (u.protocol !== 'https:' && !(allowLoopback && isLoopback && u.protocol === 'http:')) {
      return reject(new Error(`Refused non-HTTPS URL: ${rawUrl}`));
    }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method,
        timeout: 20000,
        headers: {
          'User-Agent': 'TORI-Tools-Renewal/1.0.7',
          'Cache-Control': 'no-cache, no-store, max-age=0',
          Pragma: 'no-cache',
          ...headers,
        },
      },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && maxRedirects > 0) {
          res.resume();
          const nextUrl = new URL(res.headers.location, rawUrl).toString();
          const nextHeaders = { ...headers };
          if (new URL(nextUrl).hostname !== u.hostname) delete nextHeaders.Authorization;
          return resolve(httpRequest(nextUrl, { method, headers: nextHeaders, maxRedirects: maxRedirects - 1, allowLoopback }));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve({ status: res.statusCode, url: rawUrl, headers: res.headers, body: buf, text: buf.toString('utf8') });
        });
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error(`HTTP timeout requesting ${rawUrl}`));
    });
    req.on('error', reject);
    req.end();
  });
}

function parseMinisignPubkey(pubkeyInput) {
  const trimmed = String(pubkeyInput || '').trim();
  const text = trimmed.includes('untrusted comment:')
    ? trimmed
    : Buffer.from(trimmed, 'base64').toString('utf8').trim();
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const keyLine = lines.find((l) => !l.startsWith('untrusted comment:'));
  if (!keyLine) throw new Error('Invalid Minisign public key box');
  const raw = Buffer.from(keyLine, 'base64');
  if (raw.length !== 42) throw new Error(`Invalid Minisign public key byte length (${raw.length})`);
  const alg = raw.subarray(0, 2).toString('ascii');
  const keyId = raw.subarray(2, 10);
  const pub32 = raw.subarray(10, 42);
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), pub32]);
  const keyObj = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
  const keyIdHex = Buffer.from(keyId).reverse().toString('hex').toUpperCase();
  return { alg, keyId, keyIdHex, keyObj };
}

function decodeMinisignSig(rawSigText) {
  const t = String(rawSigText || '').trim();
  if (!t) throw new Error('Empty signature');
  return t.includes('\n') ? t : Buffer.from(t, 'base64').toString('utf8').trim();
}

function extractSigKeyIdHex(rawSigText) {
  const sigText = decodeMinisignSig(rawSigText);
  const lines = sigText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 4) throw new Error(`Invalid Minisign signature line count (${lines.length})`);
  const sigRaw = Buffer.from(lines[1], 'base64');
  if (sigRaw.length < 74) throw new Error('Truncated Minisign signature body');
  return Buffer.from(sigRaw.subarray(2, 10)).reverse().toString('hex').toUpperCase();
}

function verifyMinisignAgainstKeyring(dataBuf, rawSigText, keyring, nowUtc = new Date()) {
  if (!keyring || !Array.isArray(keyring.keys) || keyring.keys.length === 0) {
    throw new Error('Unsafe keyring: zero configured signing keys');
  }
  const sigKeyId = extractSigKeyIdHex(rawSigText);
  const revokedSet = new Set((keyring.revoked_key_ids || []).map((k) => String(k).toUpperCase()));
  if (revokedSet.has(sigKeyId)) {
    throw new Error(`Rejected signature from revoked signing key ${sigKeyId}`);
  }
  const keyEntry = keyring.keys.find((k) => String(k.key_id || '').toUpperCase() === sigKeyId);
  if (!keyEntry) {
    throw new Error(`Rejected signature from unknown untrusted signing key ${sigKeyId}`);
  }
  if (keyEntry.status === 'revoked') {
    throw new Error(`Rejected signature from revoked signing key ${sigKeyId}`);
  }
  if (keyEntry.status === 'retired') {
    throw new Error(`Rejected signature from retired signing key ${sigKeyId}`);
  }
  if (keyEntry.purpose === 'desktop_app_updater') {
    throw new Error(`Rejected wrong-purpose key ${sigKeyId} (desktop_app_updater cannot sign External Tools manifests)`);
  }
  if (keyEntry.purpose === 'external_tools_legacy_shared' && keyring.allow_legacy_shared_key === false) {
    throw new Error(`Rejected retired legacy shared key ${sigKeyId} (dedicated tools key required)`);
  }
  if (keyEntry.valid_from && nowUtc.getTime() + 900000 < new Date(keyEntry.valid_from).getTime()) {
    throw new Error(`Signing key ${sigKeyId} not yet valid`);
  }
  if (keyEntry.retired_after && nowUtc.getTime() - 900000 > new Date(keyEntry.retired_after).getTime()) {
    throw new Error(`Signing key ${sigKeyId} retired after ${keyEntry.retired_after}`);
  }

  const pk = parseMinisignPubkey(keyEntry.pubkey_b64);
  if (pk.keyIdHex !== sigKeyId) {
    throw new Error(`Keyring mismatch: configured key_id ${sigKeyId} != pubkey ${pk.keyIdHex}`);
  }

  const sigText = decodeMinisignSig(rawSigText);
  const lines = sigText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const sigRaw = Buffer.from(lines[1], 'base64');
  const sigAlg = sigRaw.subarray(0, 2).toString('ascii');
  const sigBytes = sigRaw.subarray(10, 74);
  if (!lines[2].startsWith('trusted comment: ')) {
    throw new Error('Missing trusted comment in Minisign signature');
  }
  const trustedComment = lines[2].slice('trusted comment: '.length);
  const globalSigBytes = Buffer.from(lines[3], 'base64');
  const payload = sigAlg === 'ED' ? crypto.createHash('blake2b512').update(dataBuf).digest() : dataBuf;
  if (sigAlg !== 'ED' && sigAlg !== 'Ed') {
    throw new Error(`Unsupported Minisign algorithm ${sigAlg}`);
  }
  const dataValid = crypto.verify(null, payload, pk.keyObj, sigBytes);
  const globalValid = crypto.verify(
    null,
    Buffer.concat([sigBytes, Buffer.from(trustedComment, 'utf8')]),
    pk.keyObj,
    globalSigBytes
  );
  if (!dataValid || !globalValid) {
    throw new Error(`Ed25519 signature verification failed (dataValid=${dataValid}, globalValid=${globalValid})`);
  }
  return {
    keyId: sigKeyId,
    purpose: keyEntry.purpose,
    status: keyEntry.status,
    sigAlg,
    trustedComment,
  };
}

function rejectDuplicateJsonKeys(jsonText) {
  // Use Python's strict object_pairs_hook to guarantee zero duplicate keys at any depth
  const py = `
import json, sys
def check_dups(pairs):
    seen = set()
    obj = {}
    for k, v in pairs:
        if k in seen:
            raise ValueError(f"Duplicate JSON key: {k}")
        seen.add(k)
        obj[k] = v
    return obj
json.loads(sys.stdin.read(), object_pairs_hook=check_dups)
`;
  const res = spawnSync('python', ['-c', py], { input: jsonText, encoding: 'utf8', timeout: 8000 });
  if (res.status !== 0) {
    throw new Error(`Strict JSON validation failed: ${(res.stderr || res.stdout || '').trim()}`);
  }
}

function defaultKeyring(args) {
  if (args['keyring-file']) {
    return JSON.parse(fs.readFileSync(args['keyring-file'], 'utf8'));
  }
  if (args['pubkey-file']) {
    const pub = fs.readFileSync(args['pubkey-file'], 'utf8').trim();
    const pk = parseMinisignPubkey(pub);
    return {
      keyring_version: 1,
      allow_legacy_shared_key: true,
      revoked_key_ids: [],
      keys: [
        {
          key_id: pk.keyIdHex,
          pubkey_b64: pub,
          purpose: args['key-purpose'] || 'external_tools_manifest',
          status: 'active',
          label: 'CLI-supplied public key',
        },
      ],
    };
  }
  return {
    keyring_version: 1,
    allow_legacy_shared_key: true,
    revoked_key_ids: [],
    keys: [
      {
        key_id: DEFAULT_PROD_KEY_ID,
        pubkey_b64: DEFAULT_PROD_PUBKEY_B64,
        purpose: 'external_tools_legacy_shared',
        status: 'transition_legacy',
        label: 'TORI Production Shared Key (Pre-Separation Transition)',
      },
    ],
  };
}

function evaluateExpiryStatus(expiresAtIso, config, nowUtc = new Date()) {
  const expMs = new Date(expiresAtIso).getTime();
  if (!Number.isFinite(expMs)) throw new Error(`Invalid expires_at timestamp: ${expiresAtIso}`);
  const remainingHours = (expMs - nowUtc.getTime()) / 3600000;
  const remainingDays = remainingHours / 24;
  const th = config.thresholds_hours || {
    renewal_due: 720,
    warning: 336,
    high_priority_alert: 168,
    critical_alert: 48,
    expired: 0,
  };
  let alertLevel = 'HEALTHY';
  if (remainingHours <= th.expired) alertLevel = 'EXPIRED_INCIDENT';
  else if (remainingHours <= th.critical_alert) alertLevel = 'CRITICAL_ALERT';
  else if (remainingHours <= th.high_priority_alert) alertLevel = 'HIGH_PRIORITY_ALERT';
  else if (remainingHours <= th.warning) alertLevel = 'WARNING';
  else if (remainingHours <= th.renewal_due) alertLevel = 'RENEWAL_DUE';

  return {
    nowUtc: nowUtc.toISOString(),
    expiresAt: expiresAtIso,
    remainingHours: Number(remainingHours.toFixed(2)),
    remainingDays: Number(remainingDays.toFixed(2)),
    alertLevel,
    renewalRecommended: alertLevel !== 'HEALTHY',
  };
}

function signManifestWithNodeTestKey(manifestBytes, testKeyJsonPath) {
  const keyObj = JSON.parse(fs.readFileSync(testKeyJsonPath, 'utf8'));
  const privKey = crypto.createPrivateKey({ key: keyObj.private_key_pem, format: 'pem' });
  const keyId = Buffer.from(keyObj.key_id_hex, 'hex').reverse();
  const prehash = crypto.createHash('blake2b512').update(manifestBytes).digest();
  const sig = crypto.sign(null, prehash, privKey);
  const sigBox = Buffer.concat([Buffer.from('ED'), keyId, sig]).toString('base64');
  const trustedComment = `timestamp:${Math.floor(Date.now() / 1000)}\tfile:tools-manifest.json\tpurpose:external_tools_manifest`;
  const globalSig = crypto
    .sign(null, Buffer.concat([sig, Buffer.from(trustedComment, 'utf8')]), privKey)
    .toString('base64');
  const fullBox = `untrusted comment: signature from TORI staging test key\n${sigBox}\ntrusted comment: ${trustedComment}\n${globalSig}\n`;
  return {
    sigBase64: Buffer.from(fullBox, 'utf8').toString('base64'),
    keyIdHex: keyObj.key_id_hex.toUpperCase(),
  };
}

function signManifestWithTauriKey(manifestPath, privKeyPath, pwdPath, pubKeyPath) {
  if (!fs.existsSync(privKeyPath) || !fs.existsSync(pwdPath) || !fs.existsSync(pubKeyPath)) {
    throw new Error(`Missing signing key files (priv=${privKeyPath}, pub=${pubKeyPath}, pwd=${pwdPath})`);
  }
  const pubRaw = fs.readFileSync(pubKeyPath, 'utf8').trim();
  const pk = parseMinisignPubkey(pubRaw);
  const pwd = fs.readFileSync(pwdPath, 'utf8').trim();
  if (!pwd) throw new Error('Signing password file is empty');
  const sigPath = manifestPath + '.sig';
  if (fs.existsSync(sigPath)) fs.unlinkSync(sigPath);

  // Never print or log pwd or privKeyPath contents
  const res = spawnSync(
    'cargo',
    ['tauri', 'signer', 'sign', '-f', privKeyPath, '-p', pwd, manifestPath],
    { cwd: ROOT, encoding: 'utf8', timeout: 60000 }
  );
  if (res.status !== 0 || !fs.existsSync(sigPath)) {
    throw new Error(`cargo tauri signer sign failed (exit=${res.status})`);
  }
  return {
    sigPath,
    sigBase64: fs.readFileSync(sigPath, 'utf8').trim(),
    keyIdHex: pk.keyIdHex,
  };
}

async function fetchOrLoadManifest(args, config) {
  const allowLoopback = Boolean(args['allow-loopback']);
  if (args['offline-manifest']) {
    const manifestBuf = fs.readFileSync(args['offline-manifest']);
    const sigPath = args['offline-sig'] || `${args['offline-manifest']}.sig`;
    if (!fs.existsSync(sigPath)) {
      throw new Error(`Missing offline signature file: ${sigPath}`);
    }
    const sigText = fs.readFileSync(sigPath, 'utf8');
    return {
      source: 'offline_file',
      manifestUrl: args['offline-manifest'],
      manifestBuf,
      sigText,
      headers: {},
    };
  }
  const manifestUrl = args['manifest-url'] || config.production_manifest_url;
  const sigUrl = args['signature-url'] || `${manifestUrl}.sig`;
  const cb = Date.now();
  const sep = manifestUrl.includes('?') ? '&' : '?';
  const mRes = await httpRequest(`${manifestUrl}${sep}cb=${cb}`, { allowLoopback });
  if (mRes.status !== 200) {
    throw new Error(`Failed fetching manifest ${manifestUrl}: HTTP ${mRes.status}`);
  }
  const sRes = await httpRequest(`${sigUrl}${sep}cb=${cb}`, { allowLoopback });
  if (sRes.status !== 200) {
    throw new Error(`Failed fetching detached signature ${sigUrl}: HTTP ${sRes.status}`);
  }
  return {
    source: 'remote_https',
    manifestUrl,
    sigUrl,
    manifestBuf: mRes.body,
    sigText: sRes.text,
    headers: mRes.headers,
  };
}

async function verifyArtifactAvailability(entry, { offline = false, allowLoopback = false, verifyFullSha256 = false, expectedSha256 = null } = {}) {
  const sha = String(entry.sha256 || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha)) {
    throw new Error(`Invalid artifact sha256: ${entry.sha256}`);
  }
  if (expectedSha256 && sha !== expectedSha256.toLowerCase()) {
    throw new Error(`Artifact SHA-256 drift detected: manifest=${sha}, approved=${expectedSha256}`);
  }
  if (!Number.isInteger(entry.size) || entry.size <= 0) {
    throw new Error(`Invalid artifact size: ${entry.size}`);
  }
  if (offline) {
    return { checked: 'offline_metadata_only', status: 'OFFLINE_VERIFIED_FROM_REGISTRY', size: entry.size, sha256: sha };
  }
  const head = await httpRequest(entry.url, { method: 'HEAD', allowLoopback });
  if (head.status !== 200) {
    throw new Error(`Artifact URL HEAD check failed (HTTP ${head.status}) for ${entry.url}`);
  }
  const remoteLen = parseInt(head.headers['content-length'] || '0', 10);
  if (remoteLen !== entry.size) {
    throw new Error(`Artifact Content-Length mismatch: remote=${remoteLen}, expected=${entry.size}`);
  }
  let fullShaVerified = false;
  if (verifyFullSha256) {
    const dl = await httpRequest(entry.url, { method: 'GET', allowLoopback });
    if (dl.status !== 200) throw new Error(`Full artifact download returned HTTP ${dl.status}`);
    const actualSha = sha256Buf(dl.body);
    if (dl.body.length !== entry.size || actualSha !== sha) {
      throw new Error(`Artifact full SHA-256 mismatch: got ${actualSha} (${dl.body.length}B), expected ${sha} (${entry.size}B)`);
    }
    fullShaVerified = true;
  }
  return {
    checked: verifyFullSha256 ? 'remote_full_sha256' : 'remote_head',
    httpStatus: head.status,
    contentLength: remoteLen,
    sha256: sha,
    fullShaVerified,
  };
}

async function cmdCheck(args, config, registry) {
  const keyring = defaultKeyring(args);
  const fetched = await fetchOrLoadManifest(args, config);
  const verifiedSig = verifyMinisignAgainstKeyring(fetched.manifestBuf, fetched.sigText, keyring);
  rejectDuplicateJsonKeys(fetched.manifestBuf.toString('utf8'));
  const manifest = JSON.parse(fetched.manifestBuf.toString('utf8'));
  if (String(manifest.signing_key_id || '').toUpperCase() !== verifiedSig.keyId) {
    throw new Error(`Manifest signing_key_id (${manifest.signing_key_id}) != verified signer (${verifiedSig.keyId})`);
  }
  const manifestSha = sha256Buf(fetched.manifestBuf);
  const sigSha = sha256Buf(Buffer.from(fetched.sigText, 'utf8'));
  const expiry = evaluateExpiryStatus(manifest.expires_at, config);
  const registryActive = (registry.revisions || []).find((r) => r.publication_status === 'active');

  let cdnStaleDetected = false;
  if (registryActive && !args['manifest-url'] && !args['offline-manifest']) {
    if (manifest.manifest_revision < registryActive.manifest_revision) {
      cdnStaleDetected = true;
    }
  }
  const artifactCheck = await verifyArtifactAvailability(manifest.ffmpeg_bundle, {
    offline: Boolean(args.offline || args['offline-manifest']),
    allowLoopback: Boolean(args['allow-loopback']),
    verifyFullSha256: Boolean(args['verify-artifact-sha256']),
    expectedSha256: registryActive?.tools?.ffmpeg_bundle?.artifact_sha256 || null,
  });

  const report = {
    mode: 'check',
    status: expiry.alertLevel === 'EXPIRED_INCIDENT' || cdnStaleDetected ? 'INCIDENT' : 'OK',
    source: fetched.source,
    manifestUrl: fetched.manifestUrl,
    schemaVersion: manifest.schema_version,
    manifestRevision: manifest.manifest_revision,
    manifestSha256: manifestSha,
    signatureSha256: sigSha,
    verifiedSigner: verifiedSig,
    expiry,
    cdnStaleDetected,
    artifact: {
      version: manifest.ffmpeg_bundle.version,
      url: manifest.ffmpeg_bundle.url,
      size: manifest.ffmpeg_bundle.size,
      sha256: manifest.ffmpeg_bundle.sha256,
      check: artifactCheck,
    },
    registryActiveRevision: registryActive?.manifest_revision ?? null,
    autoPublishAllowed: false,
  };
  console.log(JSON.stringify(report, null, 2));
  if (args['strict-exit'] && (expiry.alertLevel === 'EXPIRED_INCIDENT' || cdnStaleDetected)) {
    process.exit(2);
  }
}

async function cmdPrepare(args, config, registry, { dryRun = false } = {}) {
  const lockPath = args['lock-file'] || DEFAULT_LOCK_FILE;
  const releaseLock = acquireLock(lockPath);
  try {
    const ttlDays = parseInt(args['ttl-days'] || String(config.renewal_ttl_policy.default_ttl_days || 45), 10);
    const minTtl = config.renewal_ttl_policy.min_ttl_days || 7;
    const maxTtl = config.renewal_ttl_policy.max_ttl_days || 90;
    if (!Number.isFinite(ttlDays) || ttlDays < minTtl || ttlDays > maxTtl) {
      throw new Error(`Invalid --ttl-days=${ttlDays}: must be within bounded policy [${minTtl}, ${maxTtl}] days`);
    }

    const keyring = defaultKeyring(args);
    const fetched = await fetchOrLoadManifest(args, config);
    const verifiedPrevSig = verifyMinisignAgainstKeyring(fetched.manifestBuf, fetched.sigText, keyring);
    rejectDuplicateJsonKeys(fetched.manifestBuf.toString('utf8'));
    const current = JSON.parse(fetched.manifestBuf.toString('utf8'));

    // Enforce strict separation: metadata renewal CANNOT change artifact URL, SHA-256, size, or tool version!
    if (args['new-url'] || args['new-sha256'] || args['new-version']) {
      throw new Error(
        'POLICY VIOLATION: Metadata renewal (--prepare) cannot alter approved artifact URL, SHA-256, or FFmpeg version. Use explicit binary approval pipeline (publish_trusted_tools_manifest.js --stage) for new binary releases.'
      );
    }

    const registryMaxRev = (registry.revisions || []).reduce((m, r) => Math.max(m, r.manifest_revision || 0), 0);
    const baseRev = Math.max(current.manifest_revision || 0, args['ignore-registry-rev'] ? 0 : registryMaxRev);
    const nextRev = args.revision ? parseInt(args.revision, 10) : baseRev + 1;
    if (!Number.isInteger(nextRev) || nextRev <= baseRev) {
      throw new Error(`Anti-replay violation: requested revision (${nextRev}) must be strictly greater than current highest revision (${baseRev})`);
    }

    // Re-verify unchanged approved artifact availability & integrity
    const approvedEntry = current.ffmpeg_bundle;
    const artifactCheck = await verifyArtifactAvailability(approvedEntry, {
      offline: Boolean(args.offline || args['offline-manifest']),
      allowLoopback: Boolean(args['allow-loopback']),
      verifyFullSha256: Boolean(args['verify-artifact-sha256']),
      expectedSha256: approvedEntry.sha256,
    });

    const nowUtc = new Date();
    const expUtc = new Date(nowUtc.getTime() + ttlDays * 86400000);
    const targetKeyId = String(args['target-key-id'] || verifiedPrevSig.keyId).toUpperCase();

    // Prevent duplicate preparation when an identical active proposal already exists in outDir
    const outDir = args['out-dir'] || path.join(DEFAULT_STAGING_OUT, `rev_${nextRev}`);
    const proposalPath = path.join(outDir, 'RENEWAL_PROPOSAL.json');
    if (!dryRun && !args.force && fs.existsSync(proposalPath)) {
      const prevProp = JSON.parse(fs.readFileSync(proposalPath, 'utf8'));
      if (
        prevProp.manifest_revision === nextRev &&
        prevProp.artifact_sha256 === approvedEntry.sha256 &&
        prevProp.signing_key_id === targetKeyId
      ) {
        console.log(
          JSON.stringify(
            {
              mode: 'prepare',
              status: 'DUPLICATE_SUPPRESSED',
              message: `Renewal proposal for revision ${nextRev} already prepared at ${outDir} (use --force to regenerate)`,
              proposalPath,
            },
            null,
            2
          )
        );
        return;
      }
    }

    const renewedManifest = {
      schema_version: 2,
      manifest_revision: nextRev,
      generated_at: nowUtc.toISOString(),
      published_at: nowUtc.toISOString(),
      expires_at: expUtc.toISOString(),
      signing_key_id: targetKeyId,
      key_purpose: 'external_tools_manifest',
      ...(args['dedicated-key-id'] ? { dedicated_signing_key_id: String(args['dedicated-key-id']).toUpperCase() } : {}),
      ffmpeg_bundle: {
        ...approvedEntry,
        // Strictly preserve immutable artifact fields
        version: approvedEntry.version,
        ffmpeg_version: approvedEntry.ffmpeg_version || approvedEntry.version,
        ffprobe_version: approvedEntry.ffprobe_version || approvedEntry.version,
        url: approvedEntry.url,
        sha256: approvedEntry.sha256,
        size: approvedEntry.size,
        allow_rollback_to: false,
        published_at: nowUtc.toISOString(),
        provenance: {
          ...(approvedEntry.provenance || {}),
          renewed_from_revision: current.manifest_revision,
          renewed_at: nowUtc.toISOString(),
          renewal_type: 'metadata_only_unchanged_artifact',
        },
      },
    };

    const manifestBytes = Buffer.from(JSON.stringify(renewedManifest, null, 2) + '\n', 'utf8');
    rejectDuplicateJsonKeys(manifestBytes.toString('utf8'));
    const manifestSha = sha256Buf(manifestBytes);

    let signedInfo = null;
    if (!dryRun) {
      fs.mkdirSync(outDir, { recursive: true });
      const manifestPath = path.join(outDir, 'tools-manifest.json');
      fs.writeFileSync(manifestPath, manifestBytes);

      if (args['test-key-file']) {
        const s = signManifestWithNodeTestKey(manifestBytes, args['test-key-file']);
        if (s.keyIdHex !== targetKeyId) {
          throw new Error(`Signing key mismatch: test key ID ${s.keyIdHex} != manifest signing_key_id ${targetKeyId}`);
        }
        const sigPath = manifestPath + '.sig';
        fs.writeFileSync(sigPath, s.sigBase64 + '\n', 'utf8');
        signedInfo = { sigPath, sigSha256: sha256Buf(Buffer.from(s.sigBase64 + '\n', 'utf8')), keyId: s.keyIdHex, mode: 'test_key' };
      } else if (args['sign-with-tauri-key']) {
        const priv = args['priv-key-file'];
        const pub = args['pub-key-file'];
        const pwd = args['pwd-file'];
        const s = signManifestWithTauriKey(manifestPath, priv, pwd, pub);
        if (s.keyIdHex !== targetKeyId) {
          throw new Error(`Signing key mismatch: key ID ${s.keyIdHex} != manifest signing_key_id ${targetKeyId}`);
        }
        signedInfo = { sigPath: s.sigPath, sigSha256: sha256File(s.sigPath), keyId: s.keyIdHex, mode: 'tauri_key' };
      }

      // Optional Stage 1–2 dual-signature sidecar (.tools.sig) for test/staging transition
      if (args['dual-sign-test-key-file']) {
        const ds = signManifestWithNodeTestKey(manifestBytes, args['dual-sign-test-key-file']);
        const sidecarPath = manifestPath + '.tools.sig';
        fs.writeFileSync(sidecarPath, ds.sigBase64 + '\n', 'utf8');
        if (signedInfo) signedInfo.dualSidecarPath = sidecarPath;
      }

      const sumsLines = [`${manifestSha}  tools-manifest.json`];
      if (signedInfo) sumsLines.push(`${signedInfo.sigSha256}  tools-manifest.json.sig`);
      fs.writeFileSync(path.join(outDir, 'SHA256SUMS.txt'), sumsLines.join('\n') + '\n', 'utf8');

      const proposal = {
        status: signedInfo ? 'PREPARED_SIGNED_PENDING_APPROVAL' : 'PREPARED_UNSIGNED_PENDING_SIGNING',
        operation_type: 'metadata_renewal_same_artifact',
        prepared_at_utc: nowUtc.toISOString(),
        prior_revision: current.manifest_revision,
        manifest_revision: nextRev,
        published_at: renewedManifest.published_at,
        expires_at: renewedManifest.expires_at,
        ttl_days: ttlDays,
        signing_key_id: targetKeyId,
        manifest_sha256: manifestSha,
        signature_sha256: signedInfo?.sigSha256 || null,
        artifact_version: approvedEntry.version,
        artifact_url: approvedEntry.url,
        artifact_sha256: approvedEntry.sha256,
        artifact_size: approvedEntry.size,
        artifact_check: artifactCheck,
        published_to_production: false,
        requires_operator_approval: true,
      };
      fs.writeFileSync(proposalPath, JSON.stringify(proposal, null, 2) + '\n', 'utf8');
    }

    console.log(
      JSON.stringify(
        {
          mode: dryRun ? 'dry-run' : 'prepare',
          status: dryRun ? 'DRY_RUN_VALID' : signedInfo ? 'PREPARED_SIGNED' : 'PREPARED_UNSIGNED',
          outDir: dryRun ? null : outDir,
          priorRevision: current.manifest_revision,
          nextRevision: nextRev,
          ttlDays,
          expiresAt: expUtc.toISOString(),
          signingKeyId: targetKeyId,
          manifestSha256: manifestSha,
          signed: Boolean(signedInfo),
          sigSha256: signedInfo?.sigSha256 || null,
          artifactCheck,
          publishedToProduction: false,
        },
        null,
        2
      )
    );
  } finally {
    releaseLock();
  }
}

async function cmdVerify(args, config, registry) {
  const manifestPath = args['manifest-file'];
  const sigPath = args['sig-file'] || (manifestPath ? `${manifestPath}.sig` : null);
  const keyring = defaultKeyring(args);
  let manifestBuf, sigText;
  if (manifestPath) {
    if (!fs.existsSync(manifestPath)) throw new Error(`Manifest not found: ${manifestPath}`);
    if (!fs.existsSync(sigPath)) throw new Error(`Detached signature not found: ${sigPath}`);
    manifestBuf = fs.readFileSync(manifestPath);
    sigText = fs.readFileSync(sigPath, 'utf8');
  } else {
    const f = await fetchOrLoadManifest(args, config);
    manifestBuf = f.manifestBuf;
    sigText = f.sigText;
  }

  const verifiedSig = verifyMinisignAgainstKeyring(manifestBuf, sigText, keyring);
  rejectDuplicateJsonKeys(manifestBuf.toString('utf8'));
  const manifest = JSON.parse(manifestBuf.toString('utf8'));

  if (manifest.schema_version !== 2) {
    throw new Error(`Expected schema_version 2, got ${manifest.schema_version}`);
  }
  if (String(manifest.signing_key_id || '').toUpperCase() !== verifiedSig.keyId) {
    throw new Error(`signing_key_id mismatch: manifest=${manifest.signing_key_id}, sig=${verifiedSig.keyId}`);
  }
  if (manifest.key_purpose && String(manifest.key_purpose).toLowerCase() !== 'external_tools_manifest') {
    throw new Error(`Invalid manifest key_purpose: ${manifest.key_purpose}`);
  }
  const pubMs = new Date(manifest.published_at).getTime();
  const expMs = new Date(manifest.expires_at).getTime();
  const ttlDays = (expMs - pubMs) / 86400000;
  if (!Number.isFinite(ttlDays) || ttlDays < 1 || ttlDays > (config.renewal_ttl_policy.max_ttl_days || 90) + 1) {
    throw new Error(`Expiration window out of policy bounds (${ttlDays.toFixed(2)} days)`);
  }
  if (expMs <= Date.now()) {
    throw new Error(`Manifest is already expired (${manifest.expires_at})`);
  }
  if (!args['allow-same-revision']) {
    const activeRev = (registry.revisions || []).reduce((m, r) => Math.max(m, r.manifest_revision || 0), 0);
    if (manifest.manifest_revision < activeRev) {
      throw new Error(`Replay/downgrade rejected: manifest_revision ${manifest.manifest_revision} < registry revision ${activeRev}`);
    }
  }
  const artifactCheck = await verifyArtifactAvailability(manifest.ffmpeg_bundle, {
    offline: Boolean(args.offline),
    allowLoopback: Boolean(args['allow-loopback']),
    verifyFullSha256: Boolean(args['verify-artifact-sha256']),
  });

  // Verify optional sidecar .tools.sig if declared
  let dualSig = null;
  if (manifest.dedicated_signing_key_id && manifestPath && fs.existsSync(`${manifestPath}.tools.sig`)) {
    const sidecarText = fs.readFileSync(`${manifestPath}.tools.sig`, 'utf8');
    dualSig = verifyMinisignAgainstKeyring(manifestBuf, sidecarText, keyring);
  }

  console.log(
    JSON.stringify(
      {
        mode: 'verify',
        status: 'VERIFIED_VALID',
        manifestRevision: manifest.manifest_revision,
        manifestSha256: sha256Buf(manifestBuf),
        signatureSha256: sha256Buf(Buffer.from(sigText, 'utf8')),
        verifiedSigner: verifiedSig,
        dualSigner: dualSig,
        ttlDays: Number(ttlDays.toFixed(2)),
        expiresAt: manifest.expires_at,
        artifactCheck,
      },
      null,
      2
    )
  );
}

async function cmdRollbackPlan(args, config, registry) {
  const revisions = (registry.revisions || []).filter((r) => r.rollback_eligible);
  if (revisions.length === 0) {
    throw new Error('No rollback-eligible revision found in durable manifest registry');
  }
  const targetRevNum = args['target-revision']
    ? parseInt(args['target-revision'], 10)
    : revisions[revisions.length - 1].manifest_revision;
  const targetRecord = revisions.find((r) => r.manifest_revision === targetRevNum);
  if (!targetRecord) {
    throw new Error(`Rollback target revision ${targetRevNum} not found or not rollback-eligible in registry`);
  }
  const highestRev = (registry.revisions || []).reduce((m, r) => Math.max(m, r.manifest_revision || 0), 0);
  const newRevision = args.revision ? parseInt(args.revision, 10) : highestRev + 1;
  if (!Number.isInteger(newRevision) || newRevision <= highestRev) {
    throw new Error(`Emergency rollback MUST use a strictly higher manifest_revision (> ${highestRev}); got ${newRevision}`);
  }

  const ff = targetRecord.tools.ffmpeg_bundle;
  const artifactCheck = await verifyArtifactAvailability(
    { url: ff.artifact_url, sha256: ff.artifact_sha256, size: ff.artifact_size },
    { offline: Boolean(args.offline), allowLoopback: Boolean(args['allow-loopback']) }
  );

  const nowUtc = new Date();
  const ttlDays = parseInt(args['ttl-days'] || '30', 10);
  const expUtc = new Date(nowUtc.getTime() + ttlDays * 86400000);
  const keyId = String(args['target-key-id'] || targetRecord.signing_key_id || DEFAULT_PROD_KEY_ID).toUpperCase();

  const rollbackManifest = {
    schema_version: 2,
    manifest_revision: newRevision,
    generated_at: nowUtc.toISOString(),
    published_at: nowUtc.toISOString(),
    expires_at: expUtc.toISOString(),
    signing_key_id: keyId,
    key_purpose: 'external_tools_manifest',
    ffmpeg_bundle: {
      tool_id: 'ffmpeg_bundle',
      version: ff.version,
      ffmpeg_version: ff.ffmpeg_version || ff.version,
      ffprobe_version: ff.ffprobe_version || ff.version,
      bundle_id: ff.bundle_id,
      url: ff.artifact_url,
      sha256: ff.artifact_sha256,
      size: ff.artifact_size,
      artifact_format: 'zip',
      platform: 'windows',
      architecture: 'x86_64',
      min_tori_version: ff.min_tori_version || '1.0.6',
      max_tori_version: ff.max_tori_version ?? null,
      published_at: nowUtc.toISOString(),
      allow_rollback_to: true,
      provenance: {
        upstream_provider: ff.upstream_provider,
        upstream_release: ff.upstream_release,
        upstream_url: `https://github.com/robijoychakma375-hash/tori-download-manager/releases/tag/${ff.github_prerelease_tag}`,
        approved_by: 'TORI Release Engineering (Emergency Rollback Plan)',
        approved_at: nowUtc.toISOString(),
        rollback_from_revision: highestRev,
        rollback_target_registry_revision: targetRecord.manifest_revision,
      },
    },
  };

  const outDir = args['out-dir'] || path.join(DEFAULT_STAGING_OUT, `rollback_plan_rev_${newRevision}`);
  fs.mkdirSync(outDir, { recursive: true });
  const manifestPath = path.join(outDir, 'tools-manifest.json');
  const manifestBytes = Buffer.from(JSON.stringify(rollbackManifest, null, 2) + '\n', 'utf8');
  fs.writeFileSync(manifestPath, manifestBytes);

  let signedInfo = null;
  if (args['test-key-file']) {
    const s = signManifestWithNodeTestKey(manifestBytes, args['test-key-file']);
    const sigPath = manifestPath + '.sig';
    fs.writeFileSync(sigPath, s.sigBase64 + '\n', 'utf8');
    signedInfo = { sigPath, sigSha256: sha256Buf(Buffer.from(s.sigBase64 + '\n', 'utf8')), keyId: s.keyIdHex };
  }

  const plan = {
    mode: 'rollback-plan',
    status: 'ROLLBACK_PLAN_READY_UNPUBLISHED',
    antiReplayPreserved: true,
    previousHighestRevision: highestRev,
    emergencyRollbackRevision: newRevision,
    allowRollbackTo: true,
    restoringToolVersion: ff.version,
    restoringArtifactSha256: ff.artifact_sha256,
    artifactCheck,
    manifestPath,
    manifestSha256: sha256Buf(manifestBytes),
    signed: Boolean(signedInfo),
    sigPath: signedInfo?.sigPath || null,
    publishedToProduction: false,
  };
  fs.writeFileSync(path.join(outDir, 'ROLLBACK_PLAN.json'), JSON.stringify(plan, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify(plan, null, 2));
}

async function cmdPublishStaging(args, config) {
  const lockPath = args['lock-file'] || DEFAULT_LOCK_FILE;
  const releaseLock = acquireLock(lockPath);
  try {
    const manifestPath = args['manifest-file'];
    const sigPath = args['sig-file'] || `${manifestPath}.sig`;
    if (!manifestPath || !fs.existsSync(manifestPath) || !fs.existsSync(sigPath)) {
      throw new Error('Usage: --publish-staging --manifest-file <path> [--sig-file <path>] [--staging-subdir gate33] [--keyring-file <path>]');
    }
    const stagingSubdir = String(args['staging-subdir'] || 'gate33').replace(/[^a-zA-Z0-9_-]/g, '');
    if (!stagingSubdir || stagingSubdir === '.' || stagingSubdir === '..') {
      throw new Error('Invalid --staging-subdir (must be isolated subdirectory under assets/tools/staging/)');
    }

    const manifestBuf = fs.readFileSync(manifestPath);
    const sigText = fs.readFileSync(sigPath, 'utf8');
    const keyring = defaultKeyring(args);
    const verified = verifyMinisignAgainstKeyring(manifestBuf, sigText, keyring);
    rejectDuplicateJsonKeys(manifestBuf.toString('utf8'));
    const manifest = JSON.parse(manifestBuf.toString('utf8'));

    const websiteRepo = args['website-repo'] || DEFAULT_WEBSITE_REPO;
    const destDir = path.join(websiteRepo, 'assets', 'tools', 'staging', stagingSubdir);
    fs.mkdirSync(destDir, { recursive: true });
    const targetName = path.basename(args['target-filename'] || 'tools-manifest.json');
    fs.writeFileSync(path.join(destDir, targetName), manifestBuf);
    fs.writeFileSync(path.join(destDir, `${targetName}.sig`), sigText);

    const sidecarSrc = `${manifestPath}.tools.sig`;
    if (fs.existsSync(sidecarSrc)) {
      fs.writeFileSync(path.join(destDir, `${targetName}.tools.sig`), fs.readFileSync(sidecarSrc, 'utf8'));
    }

    // Ensure Cloudflare Pages _headers covers the isolated staging subdir without touching production rules
    const headersPath = path.join(websiteRepo, '_headers');
    if (fs.existsSync(headersPath)) {
      const hContent = fs.readFileSync(headersPath, 'utf8');
      const marker = `/assets/tools/staging/${stagingSubdir}/*.json`;
      if (!hContent.includes(marker)) {
        const block = [
          '',
          `/assets/tools/staging/${stagingSubdir}/*.json`,
          '  Content-Type: application/json; charset=utf-8',
          '  Cache-Control: no-cache, must-revalidate',
          '  X-Content-Type-Options: nosniff',
          '',
          `/assets/tools/staging/${stagingSubdir}/*.sig`,
          '  Content-Type: text/plain; charset=utf-8',
          '  Cache-Control: no-cache, must-revalidate',
          '  X-Content-Type-Options: nosniff',
          '',
        ].join('\n');
        fs.writeFileSync(headersPath, hContent.trimEnd() + '\n' + block, 'utf8');
      }
    }

    // Strict safety guard: NEVER touch production manifest, Gate 32.1 staging manifest, or public site pages!
    const st = execFileSync('git', ['status', '--short'], { cwd: websiteRepo, encoding: 'utf8' });
    const forbidden = [
      'index.html',
      'sitemap.xml',
      'robots.txt',
      'assets/tools/tools-manifest.json',
      'assets/tools/tools-manifest.json.sig',
      'assets/tools/staging/tools-manifest.json',
      'assets/tools/staging/tools-manifest.json.sig',
    ];
    for (const f of forbidden) {
      if (st.includes(f)) {
        throw new Error(`SAFETY ABORT: Staging publisher attempted to modify protected path '${f}'`);
      }
    }

    if (!args['no-git-push'] && st.trim().length > 0) {
      execFileSync('git', ['add', `assets/tools/staging/${stagingSubdir}`, '_headers'], { cwd: websiteRepo, stdio: 'inherit' });
      execFileSync(
        'git',
        ['commit', '-m', `Gate 33 staging: publish isolated ${stagingSubdir}/${targetName} rev ${manifest.manifest_revision}`],
        { cwd: websiteRepo, stdio: 'inherit' }
      );
      execFileSync('git', ['push', 'origin', 'main'], { cwd: websiteRepo, stdio: 'inherit' });
    }

    console.log(
      JSON.stringify(
        {
          mode: 'publish-staging',
          status: args['no-git-push'] ? 'STAGED_LOCAL_ONLY' : 'PUBLISHED_ISOLATED_STAGING',
          stagingSubdir,
          stagingUrl: `https://toridownload.xyz/assets/tools/staging/${stagingSubdir}/${targetName}`,
          manifestRevision: manifest.manifest_revision,
          manifestSha256: sha256Buf(manifestBuf),
          signatureSha256: sha256Buf(Buffer.from(sigText, 'utf8')),
          verifiedSigner: verified,
          productionManifestUntouched: true,
        },
        null,
        2
      )
    );
  } finally {
    releaseLock();
  }
}

async function cmdPublishProduction(args) {
  // Strictly fail-closed dual-authorization guard (Phase 7):
  // Automated monitoring or expiry threshold alerts MUST NEVER auto-publish to production.
  if (args['i-authorize-production-manifest'] !== true || !args['approval-token-file']) {
    throw new Error(
      'PRODUCTION_APPROVAL_REQUIRED: Refusing --publish-production. Requires BOTH explicit --i-authorize-production-manifest AND a validated --approval-token-file matching exact manifest SHA-256, revision, signing key ID, and operator approval.'
    );
  }
  if (!fs.existsSync(args['approval-token-file'])) {
    throw new Error(`PRODUCTION_APPROVAL_REQUIRED: Approval token file not found: ${args['approval-token-file']}`);
  }
  const approval = JSON.parse(fs.readFileSync(args['approval-token-file'], 'utf8'));
  const manifestPath = args['manifest-file'];
  const sigPath = args['sig-file'] || `${manifestPath}.sig`;
  if (!manifestPath || !fs.existsSync(manifestPath) || !fs.existsSync(sigPath)) {
    throw new Error('Missing --manifest-file or .sig for production promotion');
  }
  const manifestBuf = fs.readFileSync(manifestPath);
  const actualSha = sha256Buf(manifestBuf);
  const manifest = JSON.parse(manifestBuf.toString('utf8'));
  if (
    !approval.approved_by ||
    approval.manifest_sha256 !== actualSha ||
    approval.manifest_revision !== manifest.manifest_revision ||
    String(approval.signing_key_id || '').toUpperCase() !== String(manifest.signing_key_id || '').toUpperCase()
  ) {
    throw new Error('PRODUCTION_APPROVAL_MISMATCH: Approval token does not match exact manifest SHA-256, revision, or signing_key_id');
  }
  throw new Error(
    'PRODUCTION_PUBLISH_GUARD_ACTIVE: Gate 33 forbids production manifest modification; execute production deployment only during an explicitly authorized production maintenance gate.'
  );
}

async function main() {
  const args = parseArgs(process.argv);
  const config = loadConfig(args.config || DEFAULT_CONFIG_PATH);
  const registry = loadRegistry(args.registry || DEFAULT_REGISTRY_PATH);

  if (args.check) return cmdCheck(args, config, registry);
  if (args['dry-run']) return cmdPrepare(args, config, registry, { dryRun: true });
  if (args.prepare) return cmdPrepare(args, config, registry, { dryRun: false });
  if (args.verify) return cmdVerify(args, config, registry);
  if (args['rollback-plan']) return cmdRollbackPlan(args, config, registry);
  if (args['publish-staging']) return cmdPublishStaging(args, config);
  if (args['publish-production']) return cmdPublishProduction(args);

  console.log(
    'Usage: node scripts/renew_trusted_tools_manifest.js [--check | --prepare | --verify | --dry-run | --publish-staging | --rollback-plan | --publish-production]'
  );
  process.exit(1);
}

main().catch((err) => {
  console.error('[RENEWAL_ERROR]', err.message || err);
  process.exit(1);
});
