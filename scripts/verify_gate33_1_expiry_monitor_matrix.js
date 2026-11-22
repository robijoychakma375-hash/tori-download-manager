#!/usr/bin/env node
/**
 * TORI Download Manager — Gate 33.1 Phase 7 Expiry Monitor 18-Scenario Failure Simulation Matrix
 *
 * Deterministically verifies ALL 18 Phase 7 monitoring & alert scenarios in isolation
 * (zero fake production alerts, zero production mutations):
 *  1. Healthy manifest (>30d remaining)
 *  2. 30-day threshold (RENEWAL_DUE)
 *  3. 14-day threshold (WARNING)
 *  4. 7-day threshold (HIGH_PRIORITY_ALERT)
 *  5. 48-hour threshold (CRITICAL_ALERT + strict exit 2)
 *  6. Expired manifest (EXPIRED_INCIDENT + strict exit 2)
 *  7. Invalid signature (SECURITY_INCIDENT)
 *  8. Stale CDN response (live rev < registry rev -> CDN_STALE_MANIFEST)
 *  9. Unreachable endpoint (HTTP 503 -> bounded backoff)
 * 10. Unexpected HTTP redirect to untrusted domain (SECURITY_REDIRECT_BLOCKED)
 * 11. Artifact URL unavailable (HEAD 404 -> ARTIFACT_AVAILABILITY_DRIFT)
 * 12. Duplicate scheduled executions (SKIPPED_DEDUP)
 * 13. Missing approval token (MISSING_APPROVAL_TOKEN)
 * 14. Stalled renewal preparation (>=72h -> STALLED_APPROVAL)
 * 15. Incorrect system time / backward clock skew (CLOCK_SKEW_DETECTED)
 * 16. Future-dated manifest (FUTURE_DATED_MANIFEST)
 * 17. Higher revision already published (UNRECORDED_HIGHER_REVISION)
 * 18. Expired approval token (EXPIRED_APPROVAL_TOKEN)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const MONITOR_SCRIPT = path.join(ROOT, 'scripts', 'monitor_tools_manifest_expiry.js');

let pass = 0;
let fail = 0;
function rec(id, name, ok, detail = '') {
  if (ok) pass++; else fail++;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] [${id}] ${name}${detail ? ' -> ' + detail : ''}`);
}

function runMonitor(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MONITOR_SCRIPT, ...args], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', reject);
    child.on('close', (code) => {
      let json = null;
      try { json = JSON.parse(stdout); } catch {}
      resolve({ code, stdout, stderr, json });
    });
  });
}

function makeKey(dir) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const rawPub = spki.subarray(spki.length - 32);
  const keyIdHex = '3310000000001122';
  const keyIdLe = Buffer.from(keyIdHex, 'hex').reverse();
  const pkBuf = Buffer.concat([Buffer.from('Ed'), keyIdLe, rawPub]);
  const pkBox = `untrusted comment: minisign public key: ${keyIdHex}\n${pkBuf.toString('base64')}\n`;
  const pubB64 = Buffer.from(pkBox, 'utf8').toString('base64');
  const pubFile = path.join(dir, 'test.pub');
  fs.writeFileSync(pubFile, pubB64 + '\n');
  function sign(buf) {
    const prehash = crypto.createHash('blake2b512').update(buf).digest();
    const sig = crypto.sign(null, prehash, privateKey);
    const sigBox = Buffer.concat([Buffer.from('ED'), keyIdLe, sig]).toString('base64');
    const tc = `timestamp:${Math.floor(Date.now() / 1000)}\tfile:tools-manifest.json`;
    const gsig = crypto.sign(null, Buffer.concat([sig, Buffer.from(tc, 'utf8')]), privateKey).toString('base64');
    return Buffer.from(`untrusted comment: test\n${sigBox}\ntrusted comment: ${tc}\n${gsig}\n`, 'utf8').toString('base64') + '\n';
  }
  return { keyIdHex, pubFile, sign };
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tori-g331-mon18-'));
  const key = makeKey(tmpDir);
  const artBytes = Buffer.from('deterministic-mock-ffmpeg-bundle-bytes');
  const artSha = crypto.createHash('sha256').update(artBytes).digest('hex');

  const regFile = path.join(tmpDir, 'registry.json');
  fs.writeFileSync(
    regFile,
    JSON.stringify({
      schema_version: 1,
      revisions: [
        {
          manifest_revision: 2,
          publication_status: 'active',
          tools: { ffmpeg_bundle: { artifact_sha256: artSha } },
        },
      ],
    })
  );

  let mode = 'normal';
  let currentRev = 2;
  let pubIso = '2026-11-20T00:00:00.000Z';
  let expIso = '2027-01-05T00:00:00.000Z';
  let port = 0;

  const server = http.createServer((req, res) => {
    const p = (req.url || '/').split('?')[0];
    if (p === '/ffmpeg.zip') {
      if (mode === 'artifact_missing') {
        res.writeHead(404);
        return res.end('Gone');
      }
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': artBytes.length });
      return res.end(req.method === 'HEAD' ? undefined : artBytes);
    }
    if (mode === 'unreachable') {
      res.writeHead(503);
      return res.end('Down');
    }
    if (mode === 'evil_redirect') {
      res.writeHead(302, { Location: 'https://evil-untrusted-cdn.invalid/tools-manifest.json' });
      return res.end();
    }
    const manifestObj = {
      schema_version: 2,
      manifest_revision: currentRev,
      generated_at: pubIso,
      published_at: pubIso,
      expires_at: expIso,
      signing_key_id: key.keyIdHex,
      ffmpeg_bundle: {
        version: 'N-129150-g7ddf7bc8a4-20261120',
        url: `http://127.0.0.1:${port}/ffmpeg.zip`,
        sha256: artSha,
        size: artBytes.length,
      },
    };
    const mBuf = Buffer.from(JSON.stringify(manifestObj, null, 2) + '\n');
    let mSig = key.sign(mBuf);
    if (mode === 'invalid_sig') {
      const b = Buffer.from(mSig.trim(), 'base64');
      b[b.length - 8] ^= 0xff;
      mSig = b.toString('base64') + '\n';
    }
    if (p === '/tools-manifest.json') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': mBuf.length });
      return res.end(mBuf);
    }
    if (p === '/tools-manifest.json.sig') {
      const sb = Buffer.from(mSig);
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': sb.length });
      return res.end(sb);
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;

  const baseArgs = (stateName, nowUtc, extra = []) => [
    '--allow-loopback',
    '--manifest-url', `http://127.0.0.1:${port}/tools-manifest.json`,
    '--pubkey-file', key.pubFile,
    '--expected-key-id', key.keyIdHex,
    '--registry', regFile,
    '--state-file', path.join(tmpDir, stateName),
    '--now-utc', nowUtc,
    ...extra,
  ];

  try {
    // 1. Healthy (>30d before 2027-01-05)
    const s1 = await runMonitor(baseArgs('s1.json', '2026-11-22T00:00:00Z', ['--force']));
    rec('MON-01', 'Healthy manifest (>30d remaining)', s1.code === 0 && s1.json?.effectiveAlertLevel === 'HEALTHY', `days=${s1.json?.expiry?.remainingDays}`);

    // 2. 30-day threshold (RENEWAL_DUE)
    const s2 = await runMonitor(baseArgs('s2.json', '2026-12-08T00:00:00Z', ['--force']));
    rec('MON-02', '30-day threshold -> RENEWAL_DUE', s2.code === 0 && s2.json?.effectiveAlertLevel === 'RENEWAL_DUE' && s2.json?.emitAlert === true, `days=${s2.json?.expiry?.remainingDays}`);

    // 3. 14-day threshold (WARNING)
    const s3 = await runMonitor(baseArgs('s3.json', '2026-12-23T00:00:00Z', ['--force']));
    rec('MON-03', '14-day threshold -> WARNING', s3.code === 0 && s3.json?.effectiveAlertLevel === 'WARNING' && s3.json?.emitAlert === true, `days=${s3.json?.expiry?.remainingDays}`);

    // 4. 7-day threshold (HIGH_PRIORITY_ALERT)
    const s4 = await runMonitor(baseArgs('s4.json', '2026-12-30T00:00:00Z', ['--force']));
    rec('MON-04', '7-day threshold -> HIGH_PRIORITY_ALERT', s4.code === 0 && s4.json?.effectiveAlertLevel === 'HIGH_PRIORITY_ALERT' && s4.json?.emitAlert === true, `days=${s4.json?.expiry?.remainingDays}`);

    // 5. 48-hour threshold (CRITICAL_ALERT + strict exit 2)
    const s5 = await runMonitor(baseArgs('s5.json', '2027-01-03T12:00:00Z', ['--force', '--strict-exit']));
    rec('MON-05', '48-hour threshold -> CRITICAL_ALERT (strict exit 2)', s5.code === 2 && s5.json?.effectiveAlertLevel === 'CRITICAL_ALERT', `hours=${s5.json?.expiry?.remainingHours}`);

    // 6. Expired manifest (EXPIRED_INCIDENT + strict exit 2)
    const s6 = await runMonitor(baseArgs('s6.json', '2027-01-06T00:00:00Z', ['--force', '--strict-exit']));
    rec('MON-06', 'Expired manifest -> EXPIRED_INCIDENT (strict exit 2)', s6.code === 2 && s6.json?.effectiveAlertLevel === 'EXPIRED_INCIDENT', `hours=${s6.json?.expiry?.remainingHours}`);

    // 7. Invalid signature
    mode = 'invalid_sig';
    const s7 = await runMonitor(baseArgs('s7.json', '2026-11-22T00:00:00Z', ['--force', '--strict-exit']));
    rec('MON-07', 'Invalid signature -> SECURITY_INCIDENT', s7.code === 2 && s7.json?.signatureValid === false && s7.json?.effectiveAlertLevel === 'SECURITY_INCIDENT');
    mode = 'normal';

    // 8. Stale CDN response (live rev 1 < registry rev 2)
    currentRev = 1;
    const s8 = await runMonitor(baseArgs('s8.json', '2026-11-22T00:00:00Z', ['--force', '--strict-exit']));
    rec('MON-08', 'Stale CDN response -> CDN_STALE_MANIFEST', s8.code === 2 && (s8.json?.anomalies || []).some((a) => a.includes('CDN_STALE_MANIFEST')));
    currentRev = 2;

    // 9. Unreachable endpoint -> backoff
    mode = 'unreachable';
    const s9 = await runMonitor(baseArgs('s9.json', '2026-11-22T00:00:00Z', ['--force', '--strict-exit']));
    rec('MON-09', 'Unreachable endpoint -> NETWORK_OR_FETCH_FAILURE + 15m backoff', s9.code === 3 && s9.json?.status === 'NETWORK_OR_FETCH_FAILURE' && s9.json?.backoffMinutes === 15);
    mode = 'normal';

    // 10. Unexpected HTTP redirect to untrusted domain
    mode = 'evil_redirect';
    const s10 = await runMonitor(baseArgs('s10.json', '2026-11-22T00:00:00Z', ['--force', '--strict-exit']));
    rec('MON-10', 'Unexpected HTTP redirect to untrusted host -> SECURITY_REDIRECT_BLOCKED', s10.code === 2 && s10.json?.status === 'SECURITY_REDIRECT_BLOCKED');
    mode = 'normal';

    // 11. Artifact URL unavailable (HEAD 404)
    mode = 'artifact_missing';
    const s11 = await runMonitor(baseArgs('s11.json', '2026-11-22T00:00:00Z', ['--force', '--strict-exit']));
    rec('MON-11', 'Artifact URL unavailable (HEAD 404) -> ARTIFACT_AVAILABILITY_DRIFT', s11.code === 2 && (s11.json?.anomalies || []).some((a) => a.includes('ARTIFACT_AVAILABILITY_DRIFT')));
    mode = 'normal';

    // 12. Duplicate scheduled executions within cooldown -> SKIPPED_DEDUP
    await runMonitor(baseArgs('s12.json', '2026-11-22T00:00:00Z', ['--force']));
    const s12 = await runMonitor(baseArgs('s12.json', '2026-11-22T00:15:00Z'));
    rec('MON-12', 'Duplicate scheduled execution suppressed -> SKIPPED_DEDUP', s12.code === 0 && s12.json?.status === 'SKIPPED_DEDUP');

    // 13 & 14. Missing approval token & Stalled renewal preparation (>=72h)
    const propPath = path.join(tmpDir, 'prop.json');
    fs.writeFileSync(propPath, JSON.stringify({ manifest_revision: 3, prepared_at_utc: '2026-11-15T00:00:00Z', published_to_production: false }));
    const s13 = await runMonitor(baseArgs('s13.json', '2026-11-22T00:00:00Z', ['--force', '--proposal-file', propPath, '--require-approval-token']));
    rec('MON-13', 'Missing approval token detected', (s13.json?.anomalies || []).some((a) => a.includes('MISSING_APPROVAL_TOKEN')));
    rec('MON-14', 'Stalled renewal preparation (>=72h) detected', s13.json?.stalledApproval === true && (s13.json?.anomalies || []).some((a) => a.includes('STALLED_APPROVAL')));

    // 15. Incorrect system time (backward clock skew relative to last good UTC run)
    await runMonitor(baseArgs('s15.json', '2026-11-22T12:00:00Z', ['--force']));
    const s15 = await runMonitor(baseArgs('s15.json', '2026-11-22T10:00:00Z', ['--force', '--strict-exit']));
    rec('MON-15', 'Incorrect system time / backward clock skew detected -> CLOCK_SKEW_DETECTED', s15.code === 2 && s15.json?.clockSkewDetected === true);

    // 16. Future-dated manifest (published_at > now + 15m)
    pubIso = '2026-11-25T00:00:00.000Z';
    const s16 = await runMonitor(baseArgs('s16.json', '2026-11-22T00:00:00Z', ['--force', '--strict-exit']));
    rec('MON-16', 'Future-dated manifest detected -> FUTURE_DATED_MANIFEST', s16.code === 2 && (s16.json?.anomalies || []).some((a) => a.includes('FUTURE_DATED_MANIFEST')));
    pubIso = '2026-11-20T00:00:00.000Z';

    // 17. Higher revision already published (live rev 3 > registry rev 2)
    currentRev = 3;
    const s17 = await runMonitor(baseArgs('s17.json', '2026-11-22T00:00:00Z', ['--force']));
    rec('MON-17', 'Higher revision already published detected -> UNRECORDED_HIGHER_REVISION', (s17.json?.anomalies || []).some((a) => a.includes('UNRECORDED_HIGHER_REVISION')));
    currentRev = 2;

    // 18. Expired approval token detected
    const expTokPath = path.join(tmpDir, 'expired_approval.json');
    fs.writeFileSync(expTokPath, JSON.stringify({ approved_by: 'operator', expires_at: '2026-11-20T00:00:00Z' }));
    const s18 = await runMonitor(baseArgs('s18.json', '2026-11-22T00:00:00Z', ['--force', '--approval-token-file', expTokPath]));
    rec('MON-18', 'Expired approval token detected -> EXPIRED_APPROVAL_TOKEN', (s18.json?.anomalies || []).some((a) => a.includes('EXPIRED_APPROVAL_TOKEN')));

    console.log(`\n=== GATE 33.1 EXPIRY MONITOR 18-SCENARIO MATRIX SUMMARY: PASS=${pass} FAIL=${fail} ===`);
    if (fail > 0) process.exit(1);
  } finally {
    server.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

main().catch((e) => { console.error('[FATAL]', e); process.exit(1); });
