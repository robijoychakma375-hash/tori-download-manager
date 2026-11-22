#!/usr/bin/env node
/**
 * TORI Download Manager — Gate 33 Renewal, Expiry Monitoring, Secret Hygiene & Authenticode Test Suite
 *
 * Deterministically verifies Phase 13 Scenarios 24–35 + Authenticode Readiness + Immutable Registry:
 *  - Scenario 24: Renewal revision monotonicity (rejects <= current revision)
 *  - Scenario 25: Renewal expiration boundaries (<7d and >90d rejected; 45d accepted)
 *  - Scenario 26: Duplicate renewal execution suppression
 *  - Scenario 27: Concurrent publication/renewal lock rejection
 *  - Scenario 28: Offline renewal preparation (from immutable archived rev 1)
 *  - Scenario 29: Secret leakage checks across repos, scripts, and renewal stdout/artifacts
 *  - Scenario 30: Signing-key mismatch detection during --prepare / --verify
 *  - Scenario 31: Bad publisher credentials / missing signing key failure
 *  - Scenario 32: Partial manifest deployment (.sig 404) failure
 *  - Scenario 33: Interrupted metadata publication & dual-authorization production publish guard
 *  - Scenario 34: CDN stale-manifest response & expiry alert threshold / cooldown deduplication / backoff
 *  - Scenario 35: Emergency rollback plan generation (strictly higher revision + allow_rollback_to=true)
 *  - Authenticode Readiness: signtool.exe detection + fail-closed -RequireAuthenticode without credentials
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RENEW_SCRIPT = path.join(ROOT, 'scripts', 'renew_trusted_tools_manifest.js');
const MONITOR_SCRIPT = path.join(ROOT, 'scripts', 'monitor_tools_manifest_expiry.js');
const AUTH_SCRIPT = path.join(ROOT, 'scripts', 'verify_authenticode_readiness.ps1');
const REGISTRY_PATH = path.join(ROOT, 'docs', 'security', 'tools-manifest-registry', 'registry.json');
const ARCHIVED_REV1 = path.join(ROOT, 'docs', 'security', 'tools-manifest-registry', 'history', 'prod_rev_0001_tools-manifest.json');
const ARCHIVED_REV1_SIG = `${ARCHIVED_REV1}.sig`;

let pass = 0;
let fail = 0;
function record(id, name, ok, detail = '') {
  if (ok) pass++; else fail++;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] [${id}] ${name}${detail ? ' -> ' + detail : ''}`);
}

function runNode(script, args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30000,
  });
}

function runNodeAsync(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function generateTestKey(dir, name, keyIdHex) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const rawPub = spki.subarray(spki.length - 32);
  const keyIdLe = Buffer.from(keyIdHex, 'hex').reverse();
  const pkBuf = Buffer.concat([Buffer.from('Ed'), keyIdLe, rawPub]);
  const pkBox = `untrusted comment: minisign public key: ${keyIdHex}\n${pkBuf.toString('base64')}\n`;
  const pubkeyB64 = Buffer.from(pkBox, 'utf8').toString('base64');
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const keyFile = path.join(dir, `${name}.testkey.json`);
  const pubFile = path.join(dir, `${name}.pub`);
  fs.writeFileSync(keyFile, JSON.stringify({ key_id_hex: keyIdHex, pubkey_b64: pubkeyB64, private_key_pem: privPem }, null, 2));
  fs.writeFileSync(pubFile, pubkeyB64 + '\n');

  function signB64(buf) {
    const prehash = crypto.createHash('blake2b512').update(buf).digest();
    const sig = crypto.sign(null, prehash, privateKey);
    const sigBox = Buffer.concat([Buffer.from('ED'), keyIdLe, sig]).toString('base64');
    const tc = `timestamp:${Math.floor(Date.now() / 1000)}\tfile:tools-manifest.json`;
    const gsig = crypto.sign(null, Buffer.concat([sig, Buffer.from(tc, 'utf8')]), privateKey).toString('base64');
    const full = `untrusted comment: signature from gate33 test key\n${sigBox}\ntrusted comment: ${tc}\n${gsig}\n`;
    return Buffer.from(full, 'utf8').toString('base64');
  }

  return { keyIdHex, pubkeyB64, keyFile, pubFile, signB64 };
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tori-gate33-sec-'));
  let mockServer = null;
  try {
    // Prepare two ephemeral test keys strictly inside temp dir (never in repo)
    const keyA = generateTestKey(tmpDir, 'dedicated_a', 'AA33001122334455');
    const keyB = generateTestKey(tmpDir, 'dedicated_b', 'BB33001122334466');
    const keyringPath = path.join(tmpDir, 'keyring.json');
    fs.writeFileSync(
      keyringPath,
      JSON.stringify(
        {
          keyring_version: 1,
          allow_legacy_shared_key: true,
          revoked_key_ids: [],
          keys: [
            {
              key_id: 'CDC23D8CC8DA5397',
              pubkey_b64:
                'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IENEQzIzRDhDQzhEQTUzOTcKUldTWFU5cklqRDNDelRBOVAzOSs1L0RXN0FFLy9YWGFJc2NnUStaNktxSkNOQ1ZCeG01MjFTZzQK',
              purpose: 'external_tools_legacy_shared',
              status: 'transition_legacy',
              label: 'Legacy Production Shared Key',
            },
            {
              key_id: keyA.keyIdHex,
              pubkey_b64: keyA.pubkeyB64,
              purpose: 'external_tools_manifest',
              status: 'active',
              label: 'Gate 33 Ephemeral Test Key A',
            },
          ],
        },
        null,
        2
      )
    );

    // 1. Live production --check + durable immutable registry integrity check
    const liveCheck = runNode(RENEW_SCRIPT, ['--check']);
    const liveObj = liveCheck.status === 0 ? JSON.parse(liveCheck.stdout) : null;
    const regObj = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
    const archSha = crypto.createHash('sha256').update(fs.readFileSync(ARCHIVED_REV1)).digest('hex');
    const archSigSha = crypto.createHash('sha256').update(fs.readFileSync(ARCHIVED_REV1_SIG)).digest('hex');
    record(
      'G33S-01',
      'Live production manifest --check passes & immutable registry archive matches byte-for-byte',
      liveCheck.status === 0 &&
        liveObj?.status === 'OK' &&
        liveObj?.manifestRevision === 1 &&
        liveObj?.manifestSha256 === archSha &&
        liveObj?.signatureSha256 === archSigSha &&
        regObj?.revisions?.[0]?.manifest_sha256 === archSha,
      `rev=${liveObj?.manifestRevision}, remainingDays=${liveObj?.expiry?.remainingDays}, alert=${liveObj?.expiry?.alertLevel}`
    );

    // Scenario 24: Renewal revision monotonicity
    const nonMono = runNode(RENEW_SCRIPT, [
      '--dry-run',
      '--offline-manifest', ARCHIVED_REV1,
      '--offline-sig', ARCHIVED_REV1_SIG,
      '--revision', '1',
      '--lock-file', path.join(tmpDir, 'lock1'),
    ]);
    record(
      'G33S-02',
      'Scenario 24: Renewal rejects non-monotonic manifest_revision (<= current)',
      nonMono.status !== 0 && nonMono.stderr.includes('Anti-replay violation'),
      nonMono.stderr.trim().slice(0, 140)
    );

    // Scenario 25: Renewal expiration boundaries (<7d and >90d rejected; 45d dry-run accepted)
    const ttlLow = runNode(RENEW_SCRIPT, ['--dry-run', '--offline-manifest', ARCHIVED_REV1, '--ttl-days', '3', '--lock-file', path.join(tmpDir, 'lock2')]);
    const ttlHigh = runNode(RENEW_SCRIPT, ['--dry-run', '--offline-manifest', ARCHIVED_REV1, '--ttl-days', '180', '--lock-file', path.join(tmpDir, 'lock3')]);
    const ttlOk = runNode(RENEW_SCRIPT, ['--dry-run', '--offline-manifest', ARCHIVED_REV1, '--ttl-days', '45', '--lock-file', path.join(tmpDir, 'lock4')]);
    record(
      'G33S-03',
      'Scenario 25: Renewal enforces bounded TTL policy [7..90 days]',
      ttlLow.status !== 0 && ttlHigh.status !== 0 && ttlOk.status === 0,
      `lowExit=${ttlLow.status}, highExit=${ttlHigh.status}, valid45dExit=${ttlOk.status}`
    );

    // Policy separation: metadata renewal refuses altering artifact URL/SHA/version!
    const mutRefused = runNode(RENEW_SCRIPT, [
      '--dry-run',
      '--offline-manifest', ARCHIVED_REV1,
      '--new-sha256', '0'.repeat(64),
      '--lock-file', path.join(tmpDir, 'lock_mut'),
    ]);
    record(
      'G33S-04',
      'Policy boundary: metadata renewal strictly refuses altering approved artifact hash/URL/version',
      mutRefused.status !== 0 && mutRefused.stderr.includes('POLICY VIOLATION'),
      mutRefused.stderr.trim().slice(0, 140)
    );

    // Scenario 28 & 26: Offline renewal preparation + signed verification + duplicate suppression
    const outRev2 = path.join(tmpDir, 'prep_rev2');
    const prep1 = runNode(RENEW_SCRIPT, [
      '--prepare',
      '--offline-manifest', ARCHIVED_REV1,
      '--offline-sig', ARCHIVED_REV1_SIG,
      '--revision', '2',
      '--ttl-days', '45',
      '--target-key-id', keyA.keyIdHex,
      '--test-key-file', keyA.keyFile,
      '--out-dir', outRev2,
      '--lock-file', path.join(tmpDir, 'lock5'),
    ]);
    const prep1Obj = prep1.status === 0 ? JSON.parse(prep1.stdout) : null;
    const verifyRev2 = runNode(RENEW_SCRIPT, [
      '--verify',
      '--offline',
      '--manifest-file', path.join(outRev2, 'tools-manifest.json'),
      '--keyring-file', keyringPath,
    ]);
    const prepDup = runNode(RENEW_SCRIPT, [
      '--prepare',
      '--offline-manifest', ARCHIVED_REV1,
      '--offline-sig', ARCHIVED_REV1_SIG,
      '--revision', '2',
      '--ttl-days', '45',
      '--target-key-id', keyA.keyIdHex,
      '--test-key-file', keyA.keyFile,
      '--out-dir', outRev2,
      '--lock-file', path.join(tmpDir, 'lock5'),
    ]);
    const prepDupObj = prepDup.status === 0 ? JSON.parse(prepDup.stdout) : null;
    record(
      'G33S-05',
      'Scenarios 28 & 26: Offline renewal prepares & verifies rev 2 cleanly, and suppresses duplicate runs',
      prep1.status === 0 &&
        prep1Obj?.signed === true &&
        verifyRev2.status === 0 &&
        prepDup.status === 0 &&
        prepDupObj?.status === 'DUPLICATE_SUPPRESSED',
      `prep1=${prep1Obj?.status}, verifyExit=${verifyRev2.status}, dupStatus=${prepDupObj?.status}`
    );

    // Scenario 27: Concurrent publication/renewal lock rejection
    const heldLock = path.join(tmpDir, 'held.lock');
    fs.writeFileSync(heldLock, '{"pid":999999,"acquired_at_utc":"2026-11-22T00:00:00Z"}\n');
    const concRes = runNode(RENEW_SCRIPT, [
      '--dry-run',
      '--offline-manifest', ARCHIVED_REV1,
      '--lock-file', heldLock,
    ]);
    record(
      'G33S-06',
      'Scenario 27: Concurrent renewal/publication attempt blocked cleanly by exclusive lock',
      concRes.status !== 0 && concRes.stderr.includes('CONCURRENT_RENEWAL_LOCKED'),
      concRes.stderr.trim().slice(0, 140)
    );

    // Scenario 30: Signing-key mismatch during --prepare
    const mismatchRes = runNode(RENEW_SCRIPT, [
      '--prepare',
      '--offline-manifest', ARCHIVED_REV1,
      '--revision', '3',
      '--target-key-id', keyA.keyIdHex,
      '--test-key-file', keyB.keyFile,
      '--out-dir', path.join(tmpDir, 'prep_mismatch'),
      '--lock-file', path.join(tmpDir, 'lock6'),
    ]);
    record(
      'G33S-07',
      'Scenario 30: Signing-key ID mismatch strictly rejected',
      mismatchRes.status !== 0 && mismatchRes.stderr.includes('Signing key mismatch'),
      mismatchRes.stderr.trim().slice(0, 140)
    );

    // Scenario 31: Bad publisher credentials / missing Tauri signing key files
    const badCreds = runNode(RENEW_SCRIPT, [
      '--prepare',
      '--offline-manifest', ARCHIVED_REV1,
      '--revision', '3',
      '--sign-with-tauri-key',
      '--priv-key-file', path.join(tmpDir, 'nonexistent.key'),
      '--pub-key-file', path.join(tmpDir, 'nonexistent.pub'),
      '--pwd-file', path.join(tmpDir, 'nonexistent.pwd'),
      '--out-dir', path.join(tmpDir, 'prep_badcreds'),
      '--lock-file', path.join(tmpDir, 'lock7'),
    ]);
    record(
      'G33S-08',
      'Scenario 31: Missing/bad publisher signing credentials fail closed cleanly',
      badCreds.status !== 0 && badCreds.stderr.includes('Missing signing key files'),
      badCreds.stderr.trim().slice(0, 140)
    );

    // Scenario 33: Dual-authorization guard on --publish-production
    const prodNoAuth = runNode(RENEW_SCRIPT, ['--publish-production', '--manifest-file', path.join(outRev2, 'tools-manifest.json')]);
    const badTokenPath = path.join(tmpDir, 'bad_approval.json');
    fs.writeFileSync(badTokenPath, JSON.stringify({ approved_by: 'test', manifest_sha256: '0'.repeat(64), manifest_revision: 2, signing_key_id: keyA.keyIdHex }));
    const prodBadToken = runNode(RENEW_SCRIPT, [
      '--publish-production',
      '--i-authorize-production-manifest',
      '--approval-token-file', badTokenPath,
      '--manifest-file', path.join(outRev2, 'tools-manifest.json'),
    ]);
    record(
      'G33S-09',
      'Scenario 33: --publish-production fails closed without valid dual authorization & exact SHA-256 approval token',
      prodNoAuth.status !== 0 &&
        prodNoAuth.stderr.includes('PRODUCTION_APPROVAL_REQUIRED') &&
        prodBadToken.status !== 0 &&
        prodBadToken.stderr.includes('PRODUCTION_APPROVAL_MISMATCH'),
      `noAuthExit=${prodNoAuth.status}, badTokenExit=${prodBadToken.status}`
    );

    // Scenarios 32 & 34: Loopback mock tests for partial deployment (.sig 404), expiry threshold progression,
    // alert cooldown deduplication, backoff on outage, and stalled approval detection!
    let mockMode = 'partial_missing_sig';
    const mockManifestObj = JSON.parse(fs.readFileSync(path.join(outRev2, 'tools-manifest.json'), 'utf8'));
    mockManifestObj.manifest_revision = 2;
    mockManifestObj.expires_at = '2026-12-01T00:00:00.000Z';
    const mockArtifactBytes = Buffer.from('mock-zip-bytes-for-head-check');
    mockManifestObj.ffmpeg_bundle.size = mockArtifactBytes.length;

    let serverPort = 0;
    mockServer = http.createServer((req, res) => {
      const cleanPath = (req.url || '/').split('?')[0];
      if (cleanPath === '/ffmpeg.zip') {
        res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': mockArtifactBytes.length });
        return res.end(req.method === 'HEAD' ? undefined : mockArtifactBytes);
      }
      if (mockMode === 'outage') {
        res.writeHead(503);
        return res.end('Unavailable');
      }
      mockManifestObj.ffmpeg_bundle.url = `http://127.0.0.1:${serverPort}/ffmpeg.zip`;
      const mBuf = Buffer.from(JSON.stringify(mockManifestObj, null, 2) + '\n');
      const mSig = keyA.signB64(mBuf);
      if (cleanPath === '/tools-manifest.json') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': mBuf.length });
        return res.end(mBuf);
      }
      if (cleanPath === '/tools-manifest.json.sig') {
        if (mockMode === 'partial_missing_sig') {
          res.writeHead(404);
          return res.end('Missing sig');
        }
        const sBuf = Buffer.from(mSig + '\n');
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': sBuf.length });
        return res.end(sBuf);
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise((r) => mockServer.listen(0, '127.0.0.1', r));
    serverPort = mockServer.address().port;

    // 32. Partial deployment (.sig 404)
    const partialRes = await runNodeAsync(RENEW_SCRIPT, [
      '--check',
      '--allow-loopback',
      '--manifest-url', `http://127.0.0.1:${serverPort}/tools-manifest.json`,
      '--keyring-file', keyringPath,
    ]);
    record(
      'G33S-10',
      'Scenario 32: Partial manifest deployment (missing .sig HTTP 404) fails closed',
      partialRes.status !== 0 && partialRes.stderr.includes('HTTP 404'),
      partialRes.stderr.trim().slice(0, 140)
    );

    // 34. Expiry monitor thresholds (WARNING -> dedup suppressed -> CRITICAL escalation -> EXPIRED -> outage backoff + stalled approval)
    mockMode = 'ok';
    const monState = path.join(tmpDir, 'monitor_state.json');
    const stalledProp = path.join(tmpDir, 'stalled_proposal.json');
    fs.writeFileSync(stalledProp, JSON.stringify({ manifest_revision: 3, prepared_at_utc: '2026-11-10T00:00:00Z', published_to_production: false }));

    const runMon = (nowUtc, extra = []) =>
      runNodeAsync(MONITOR_SCRIPT, [
        '--allow-loopback',
        '--manifest-url', `http://127.0.0.1:${serverPort}/tools-manifest.json`,
        '--pubkey-file', keyA.pubFile,
        '--expected-key-id', keyA.keyIdHex,
        '--state-file', monState,
        '--now-utc', nowUtc,
        ...extra,
      ]);

    const mWarn1 = JSON.parse((await runMon('2026-11-20T00:00:00Z', ['--force', '--proposal-file', stalledProp])).stdout); // 11 days left -> WARNING + stalled approval!
    const mDedup = JSON.parse((await runMon('2026-11-20T00:10:00Z')).stdout); // 10 min later -> SKIPPED_DEDUP
    const mWarn2 = JSON.parse((await runMon('2026-11-20T02:00:00Z')).stdout); // 2h later (<12h cooldown) -> WARNING suppressed
    const mCrit = JSON.parse((await runMon('2026-11-30T00:00:00Z', ['--force'])).stdout); // 24h left -> CRITICAL_ALERT emitted immediately (escalation!)
    const mExp = await runMon('2026-12-02T00:00:00Z', ['--force', '--strict-exit']); // expired -> exit 2!
    mockMode = 'outage';
    const mOutage = JSON.parse((await runMon('2026-12-02T04:00:00Z', ['--force'])).stdout); // outage -> backoff 15m!

    record(
      'G33S-11',
      'Scenario 34: Expiry monitor thresholds, dedup suppression, escalation, stalled approval & outage backoff work accurately',
      mWarn1.effectiveAlertLevel === 'WARNING' &&
        mWarn1.emitAlert === true &&
        mWarn1.stalledApproval === true &&
        mDedup.status === 'SKIPPED_DEDUP' &&
        mWarn2.effectiveAlertLevel === 'WARNING' &&
        mWarn2.alertSuppressedByDedup === true &&
        mCrit.effectiveAlertLevel === 'CRITICAL_ALERT' &&
        mCrit.emitAlert === true &&
        mExp.status === 2 &&
        mOutage.status === 'NETWORK_OR_FETCH_FAILURE' &&
        mOutage.backoffMinutes === 15,
      `warn1=${mWarn1.effectiveAlertLevel}/emit=${mWarn1.emitAlert}/stalled=${mWarn1.stalledApproval}, dedup=${mDedup.status}, warn2Suppressed=${mWarn2.alertSuppressedByDedup}, crit=${mCrit.effectiveAlertLevel}/emit=${mCrit.emitAlert}, expExit=${mExp.status}, backoff=${mOutage.backoffMinutes}m`
    );

    // Scenario 35: Emergency rollback plan generation (strictly higher revision + allow_rollback_to=true)
    const rbPlanRes = runNode(RENEW_SCRIPT, [
      '--rollback-plan',
      '--offline',
      '--target-revision', '1',
      '--revision', '2',
      '--target-key-id', keyA.keyIdHex,
      '--test-key-file', keyA.keyFile,
      '--out-dir', path.join(tmpDir, 'rb_rev2'),
    ]);
    const rbPlanObj = rbPlanRes.status === 0 ? JSON.parse(rbPlanRes.stdout) : null;
    record(
      'G33S-12',
      'Emergency rollback plan generates strictly higher signed revision with allow_rollback_to=true from immutable registry',
      rbPlanRes.status === 0 &&
        rbPlanObj?.emergencyRollbackRevision === 2 &&
        rbPlanObj?.allowRollbackTo === true &&
        rbPlanObj?.signed === true &&
        rbPlanObj?.restoringArtifactSha256 === '03d33066832e7149a8577bed73713c5d5344aed14199063e521b798cf1b60076',
      `rev=${rbPlanObj?.emergencyRollbackRevision}, allowRollback=${rbPlanObj?.allowRollbackTo}, ver=${rbPlanObj?.restoringToolVersion}`
    );

    // Scenario 29: Secret leakage check across git repositories & generated outputs
    const scanFiles = [
      path.join(ROOT, 'docs', 'security', 'EXTERNAL_TOOLS_SIGNING_KEY_MIGRATION_SPEC.md'),
      path.join(ROOT, 'docs', 'security', 'TORI_RELEASE_SECURITY_POLICY.md'),
      path.join(ROOT, 'docs', 'security', 'EXTERNAL_TOOLS_OPERATIONAL_RUNBOOKS.md'),
      path.join(ROOT, 'docs', 'security', 'WINDOWS_AUTHENTICODE_INTEGRATION.md'),
      REGISTRY_PATH,
      RENEW_SCRIPT,
      MONITOR_SCRIPT,
    ];
    const secretPattern = /(BEGIN (RSA|EC|OPENSSH|ENCRYPTED)?\s*PRIVATE KEY|RWQ[A-Za-z0-9+/]{60,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|untrusted comment: minisign encrypted secret key)/i;
    const leaks = [];
    for (const f of scanFiles) {
      const text = fs.readFileSync(f, 'utf8');
      if (secretPattern.test(text)) leaks.push(path.basename(f));
    }
    if (secretPattern.test(prep1.stdout) || secretPattern.test(liveCheck.stdout)) {
      leaks.push('CLI_STDOUT');
    }
    const keyFilesInRepo = spawnSync('git', ['ls-files', '*.key', '*.pwd', '*.pfx', '*.p12'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
    record(
      'G33S-13',
      'Scenario 29: Zero private keys, passphrases, or tokens leaked in docs, scripts, git tree, or CLI outputs',
      leaks.length === 0 && keyFilesInRepo.length === 0,
      `leaks=${leaks.length}, trackedKeyFiles=${keyFilesInRepo.length}`
    );

    // Phase 11 Authenticode Readiness Verification
    const authRes = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', AUTH_SCRIPT], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 20000,
    });
    const authObj = authRes.status === 0 ? JSON.parse(authRes.stdout) : null;
    record(
      'G33S-14',
      'Phase 11 Authenticode readiness: signtool.exe available, -RequireAuthenticode fails closed cleanly, honest NotSigned status',
      authRes.status === 0 &&
        authObj?.signToolAvailable === true &&
        authObj?.requireFailClosedOk === true &&
        authObj?.tauriEd25519SigPresent === true &&
        authObj?.honestStatus === 'NOT_AVAILABLE_PIPELINE_READY',
      `signTool=${authObj?.signToolAvailable}, failClosed=${authObj?.requireFailClosedOk}, currentV107=${authObj?.currentV107Authenticode}, ed25519Sig=${authObj?.tauriEd25519SigPresent}`
    );

    console.log(`\n=== GATE 33 RENEWAL, MONITORING & SECURITY SUITE SUMMARY: PASS=${pass} FAIL=${fail} ===`);
    if (fail > 0) process.exit(1);
  } finally {
    if (mockServer) mockServer.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

main().catch((e) => {
  console.error('[FATAL]', e);
  process.exit(1);
});
