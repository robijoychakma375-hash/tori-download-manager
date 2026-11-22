#!/usr/bin/env node
/**
 * TORI Download Manager — Gate 33 / 33.1 External Tools Manifest Expiry Monitor & Alert Scheduler
 *
 * UTC-based operational monitoring for TORI's Ed25519-signed External Tools Manifest:
 *  - Evaluates configurable thresholds (30d renewal due, 14d warning, 7d high, 48h critical, expired)
 *  - Persists scheduler state (last check, last alert level/timestamp, backoff, observed hashes)
 *  - Suppresses duplicate runs within min_check_interval_minutes unless --force
 *  - Deduplicates repeated alerts at the same severity within alert_dedup_cooldown_hours
 *    while escalating immediately when severity worsens
 *  - Applies bounded exponential backoff on network/fetch outages (15m -> 1h -> 4h -> 12h)
 *  - Detects: signature failures, unexpected untrusted redirects, CDN stale manifests,
 *    higher-revision drift vs registry, unexpected artifact drift, future-dated manifests,
 *    system clock skew, missing/expired approval tokens, and stalled approvals
 *  - Emits GitHub Actions step summary when GITHUB_STEP_SUMMARY is set
 *  - Strictly read-only monitoring: NEVER holds private keys or auto-publishes to production!
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_CONFIG_PATH = path.join(ROOT, 'docs', 'security', 'manifest_expiry_monitoring_config.json');
const DEFAULT_REGISTRY_PATH = path.join(ROOT, 'docs', 'security', 'tools-manifest-registry', 'registry.json');
const DEFAULT_PROD_PUBKEY_B64 =
  'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IENEQzIzRDhDQzhEQTUzOTcKUldTWFU5cklqRDNDelRBOVAzOSs1L0RXN0FFLy9YWGFJc2NnUStaNktxSkNOQ1ZCeG01MjFTZzQK';
const DEFAULT_PROD_KEY_ID = 'CDC23D8CC8DA5397';

const ALLOWED_HTTPS_HOSTS = new Set([
  'toridownload.xyz',
  'github.com',
  'api.github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'github-releases.githubusercontent.com',
]);

const SEVERITY_ORDER = {
  HEALTHY: 0,
  RENEWAL_DUE: 1,
  WARNING: 2,
  HIGH_PRIORITY_ALERT: 3,
  CRITICAL_ALERT: 4,
  EXPIRED_INCIDENT: 5,
  SECURITY_INCIDENT: 6,
};

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[k] = next;
        i++;
      } else {
        args[k] = true;
      }
    }
  }
  return args;
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function validateAllowedUrl(rawUrl, allowLoopback) {
  const u = new URL(rawUrl);
  const host = u.hostname.toLowerCase();
  const isLoopback = host === '127.0.0.1' || host === 'localhost';
  if (allowLoopback && isLoopback && (u.protocol === 'http:' || u.protocol === 'https:')) {
    return u;
  }
  if (u.protocol !== 'https:') {
    throw new Error(`UNEXPECTED_REDIRECT_OR_SCHEME: Refused non-HTTPS URL ${rawUrl}`);
  }
  if (!ALLOWED_HTTPS_HOSTS.has(host)) {
    throw new Error(`UNEXPECTED_REDIRECT_HOST: Untrusted host '${host}' in ${rawUrl}`);
  }
  return u;
}

function httpGet(rawUrl, { method = 'GET', allowLoopback = false, maxRedirects = 6 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = validateAllowedUrl(rawUrl, allowLoopback);
    } catch (e) {
      return reject(e);
    }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method,
        timeout: 15000,
        headers: {
          'User-Agent': 'TORI-Expiry-Monitor/1.0.8',
          'Cache-Control': 'no-cache, no-store, max-age=0',
          Pragma: 'no-cache',
        },
      },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          if (maxRedirects <= 0) {
            return reject(new Error(`UNEXPECTED_REDIRECT_LOOP: Too many redirects for ${rawUrl}`));
          }
          const next = new URL(res.headers.location, rawUrl).toString();
          return resolve(httpGet(next, { method, allowLoopback, maxRedirects: maxRedirects - 1 }));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve({ status: res.statusCode, headers: res.headers, body: buf, text: buf.toString('utf8') });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error(`Timeout fetching ${rawUrl}`)));
    req.on('error', reject);
    req.end();
  });
}

function verifySignature(manifestBuf, sigRawText, pubkeyB64, expectedKeyId) {
  const decodedPub = Buffer.from(pubkeyB64, 'base64').toString('utf8').trim().split(/\r?\n/);
  const pkRaw = Buffer.from(decodedPub[1].trim(), 'base64');
  const keyId = pkRaw.subarray(2, 10);
  const keyIdHex = Buffer.from(keyId).reverse().toString('hex').toUpperCase();
  if (expectedKeyId && keyIdHex !== expectedKeyId.toUpperCase()) {
    throw new Error(`Key ID mismatch (${keyIdHex} != ${expectedKeyId})`);
  }
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), pkRaw.subarray(10, 42)]);
  const pubKey = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });

  const trimmed = sigRawText.trim();
  const sigText = trimmed.includes('\n') ? trimmed : Buffer.from(trimmed, 'base64').toString('utf8').trim();
  const lines = sigText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 4) throw new Error('Malformed Minisign signature');
  const sigRaw = Buffer.from(lines[1], 'base64');
  const alg = sigRaw.subarray(0, 2).toString('ascii');
  if (!sigRaw.subarray(2, 10).equals(keyId)) throw new Error('Signature key ID mismatch');
  const sigBytes = sigRaw.subarray(10, 74);
  const trustedComment = lines[2].slice('trusted comment: '.length);
  const globalSig = Buffer.from(lines[3], 'base64');
  const payload = alg === 'ED' ? crypto.createHash('blake2b512').update(manifestBuf).digest() : manifestBuf;
  const ok1 = crypto.verify(null, payload, pubKey, sigBytes);
  const ok2 = crypto.verify(null, Buffer.concat([sigBytes, Buffer.from(trustedComment, 'utf8')]), pubKey, globalSig);
  if (!ok1 || !ok2) throw new Error('Ed25519 signature verification failed');
  return keyIdHex;
}

function loadState(stateFile) {
  if (!fs.existsSync(stateFile)) {
    return {
      schema_version: 1,
      last_check_utc: null,
      last_success_utc: null,
      last_alert_level: 'HEALTHY',
      last_alert_emitted_utc: null,
      consecutive_failures: 0,
      next_retry_after_utc: null,
      observed_revision: null,
      observed_manifest_sha256: null,
      observed_artifact_sha256: null,
      stalled_approval_since_utc: null,
    };
  }
  return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
}

function saveState(stateFile, state) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

function classifyExpiry(expiresAt, config, nowMs) {
  const remHours = (new Date(expiresAt).getTime() - nowMs) / 3600000;
  const th = config.thresholds_hours;
  let level = 'HEALTHY';
  if (remHours <= th.expired) level = 'EXPIRED_INCIDENT';
  else if (remHours <= th.critical_alert) level = 'CRITICAL_ALERT';
  else if (remHours <= th.high_priority_alert) level = 'HIGH_PRIORITY_ALERT';
  else if (remHours <= th.warning) level = 'WARNING';
  else if (remHours <= th.renewal_due) level = 'RENEWAL_DUE';
  return { level, remainingHours: Number(remHours.toFixed(2)), remainingDays: Number((remHours / 24).toFixed(2)) };
}

function writeGithubStepSummary(report) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  try {
    const lines = [
      '### TORI External Tools Manifest Expiry Monitor (UTC)',
      `- **Status:** \`${report.status}\` | **Alert Level:** \`${report.effectiveAlertLevel || 'N/A'}\``,
      `- **Checked (UTC):** \`${report.nowUtc}\``,
      `- **Manifest Revision:** \`${report.manifestRevision ?? 'N/A'}\` | **Signature Valid:** \`${report.signatureValid ?? false}\``,
      report.expiry
        ? `- **Remaining Validity:** \`${report.expiry.remainingDays} days\` (\`${report.expiry.remainingHours} hours\`)`
        : '',
      report.anomalies && report.anomalies.length > 0
        ? `- **Anomalies:** ${report.anomalies.map((a) => `\`${a}\``).join(', ')}`
        : '- **Anomalies:** None',
      '',
    ].filter(Boolean);
    fs.appendFileSync(summaryPath, lines.join('\n') + '\n', 'utf8');
  } catch {}
}

async function main() {
  const args = parseArgs(process.argv);
  const config = JSON.parse(fs.readFileSync(args.config || DEFAULT_CONFIG_PATH, 'utf8'));
  const registry = JSON.parse(fs.readFileSync(args.registry || DEFAULT_REGISTRY_PATH, 'utf8'));
  const stateFile = path.resolve(ROOT, args['state-file'] || config.state_file);
  const now = args['now-utc'] ? new Date(args['now-utc']) : new Date();
  const nowMs = now.getTime();
  const state = loadState(stateFile);

  // Detect severe backward system-clock skew relative to last known good UTC check (>5 minutes)
  let clockSkewDetected = false;
  if (state.last_success_utc) {
    const lastOkMs = new Date(state.last_success_utc).getTime();
    if (Number.isFinite(lastOkMs) && nowMs + 5 * 60000 < lastOkMs) {
      clockSkewDetected = true;
    }
  }

  // Deduplicate runs within min_check_interval_minutes unless --force
  if (!args.force && !clockSkewDetected && state.last_check_utc) {
    const minIntervalMs = (config.scheduler.min_check_interval_minutes || 60) * 60000;
    const elapsedMs = nowMs - new Date(state.last_check_utc).getTime();
    if (elapsedMs >= 0 && elapsedMs < minIntervalMs) {
      const out = {
        status: 'SKIPPED_DEDUP',
        nowUtc: now.toISOString(),
        lastCheckUtc: state.last_check_utc,
        nextEligibleInMinutes: Number(((minIntervalMs - elapsedMs) / 60000).toFixed(1)),
      };
      console.log(JSON.stringify(out, null, 2));
      return;
    }
  }

  // Respect active retry backoff unless --force
  if (!args.force && !clockSkewDetected && state.next_retry_after_utc && nowMs < new Date(state.next_retry_after_utc).getTime()) {
    console.log(
      JSON.stringify(
        {
          status: 'BACKOFF_ACTIVE',
          nowUtc: now.toISOString(),
          nextRetryAfterUtc: state.next_retry_after_utc,
          consecutiveFailures: state.consecutive_failures,
        },
        null,
        2
      )
    );
    return;
  }

  const manifestUrl = args['manifest-url'] || config.production_manifest_url;
  const sigUrl = args['signature-url'] || `${manifestUrl}.sig`;
  const allowLoopback = Boolean(args['allow-loopback']);
  const pubkeyB64 = args['pubkey-file'] ? fs.readFileSync(args['pubkey-file'], 'utf8').trim() : DEFAULT_PROD_PUBKEY_B64;
  const expectedKeyId = args['expected-key-id'] || (args['pubkey-file'] ? null : DEFAULT_PROD_KEY_ID);

  state.last_check_utc = now.toISOString();

  try {
    const sep = manifestUrl.includes('?') ? '&' : '?';
    const mRes = await httpGet(`${manifestUrl}${sep}cb=${nowMs}`, { allowLoopback });
    const sRes = await httpGet(`${sigUrl}${sep}cb=${nowMs}`, { allowLoopback });
    if (mRes.status !== 200 || sRes.status !== 200) {
      throw new Error(`Endpoint failure (manifest HTTP ${mRes.status}, sig HTTP ${sRes.status})`);
    }

    const anomalies = [];
    if (clockSkewDetected) {
      anomalies.push(`CLOCK_SKEW_DETECTED: current UTC (${now.toISOString()}) precedes last successful check (${state.last_success_utc})`);
    }

    let sigOk = true;
    try {
      verifySignature(mRes.body, sRes.text, pubkeyB64, expectedKeyId);
    } catch (e) {
      sigOk = false;
      anomalies.push(`SIGNATURE_FAILURE: ${e.message}`);
    }

    const manifest = JSON.parse(mRes.text);
    const activeReg = (registry.revisions || []).find((r) => r.publication_status === 'active');

    // Future-dated manifest detection (> 15 min clock skew)
    const pubMs = new Date(manifest.published_at || manifest.generated_at).getTime();
    if (Number.isFinite(pubMs) && pubMs > nowMs + 15 * 60000) {
      anomalies.push(`FUTURE_DATED_MANIFEST: published_at ${manifest.published_at} exceeds current UTC + 15m`);
    }

    // Registry drift checks (stale CDN vs higher unrecorded revision vs unexpected artifact change)
    if (activeReg && !args['skip-registry-compare']) {
      if (manifest.manifest_revision < activeReg.manifest_revision) {
        anomalies.push(`CDN_STALE_MANIFEST: live rev ${manifest.manifest_revision} < registry rev ${activeReg.manifest_revision}`);
      } else if (manifest.manifest_revision > activeReg.manifest_revision) {
        anomalies.push(`UNRECORDED_HIGHER_REVISION: live rev ${manifest.manifest_revision} > registry rev ${activeReg.manifest_revision}`);
      }
      if (
        !args['manifest-url'] &&
        manifest.ffmpeg_bundle.sha256 !== activeReg.tools.ffmpeg_bundle.artifact_sha256
      ) {
        anomalies.push('UNEXPECTED_ARTIFACT_HASH_CHANGE');
      }
    }

    if (config.security_policy.verify_remote_artifact_head && !args['skip-artifact-head']) {
      const head = await httpGet(manifest.ffmpeg_bundle.url, { method: 'HEAD', allowLoopback });
      const len = parseInt(head.headers['content-length'] || '0', 10);
      if (head.status !== 200 || len !== manifest.ffmpeg_bundle.size) {
        anomalies.push(`ARTIFACT_AVAILABILITY_DRIFT: HTTP ${head.status}, length=${len}, expected=${manifest.ffmpeg_bundle.size}`);
      }
    }

    // Stalled proposal & approval token checks
    let stalledApproval = false;
    if (args['proposal-file'] && fs.existsSync(args['proposal-file'])) {
      const prop = JSON.parse(fs.readFileSync(args['proposal-file'], 'utf8'));
      const ageHours = (nowMs - new Date(prop.prepared_at_utc).getTime()) / 3600000;
      if (!prop.published_to_production && ageHours >= (config.scheduler.stalled_approval_warn_hours || 72)) {
        stalledApproval = true;
        anomalies.push(`STALLED_APPROVAL: proposal rev ${prop.manifest_revision} awaiting approval for ${ageHours.toFixed(1)}h`);
        if (!state.stalled_approval_since_utc) state.stalled_approval_since_utc = prop.prepared_at_utc;
      }
      if (args['require-approval-token'] && !args['approval-token-file']) {
        anomalies.push('MISSING_APPROVAL_TOKEN: proposal has no operator approval token');
      }
    } else {
      state.stalled_approval_since_utc = null;
    }

    if (args['approval-token-file']) {
      if (!fs.existsSync(args['approval-token-file'])) {
        anomalies.push(`MISSING_APPROVAL_TOKEN: file not found (${args['approval-token-file']})`);
      } else {
        const tok = JSON.parse(fs.readFileSync(args['approval-token-file'], 'utf8'));
        if (!tok.approved_by) {
          anomalies.push('MISSING_APPROVAL_TOKEN: missing approved_by field');
        }
        if (tok.expires_at && new Date(tok.expires_at).getTime() <= nowMs) {
          anomalies.push(`EXPIRED_APPROVAL_TOKEN: approval token expired at ${tok.expires_at}`);
        }
      }
    }

    const expiry = classifyExpiry(manifest.expires_at, config, nowMs);
    const hasSecurityAnomaly =
      !sigOk ||
      anomalies.some((a) =>
        /^(CDN_STALE|UNEXPECTED_ARTIFACT|FUTURE_DATED|CLOCK_SKEW|ARTIFACT_AVAILABILITY)/.test(a)
      );
    const effectiveLevel = hasSecurityAnomaly ? 'SECURITY_INCIDENT' : expiry.level;

    // Alert deduplication: emit immediately on escalation or after cooldown; suppress noisy repeats
    const cooldownMs = (config.scheduler.alert_dedup_cooldown_hours || 12) * 3600000;
    const escalated = (SEVERITY_ORDER[effectiveLevel] || 0) > (SEVERITY_ORDER[state.last_alert_level] || 0);
    const cooldownElapsed =
      !state.last_alert_emitted_utc || nowMs - new Date(state.last_alert_emitted_utc).getTime() >= cooldownMs;
    const emitAlert = effectiveLevel !== 'HEALTHY' && (escalated || cooldownElapsed);

    if (!clockSkewDetected) {
      state.last_success_utc = now.toISOString();
    }
    state.consecutive_failures = 0;
    state.next_retry_after_utc = null;
    state.observed_revision = manifest.manifest_revision;
    state.observed_manifest_sha256 = sha256(mRes.body);
    state.observed_artifact_sha256 = manifest.ffmpeg_bundle.sha256;
    state.last_alert_level = effectiveLevel;
    if (emitAlert) state.last_alert_emitted_utc = now.toISOString();
    saveState(stateFile, state);

    const output = {
      status: anomalies.length > 0 || effectiveLevel === 'EXPIRED_INCIDENT' ? 'ALERT' : 'OK',
      nowUtc: now.toISOString(),
      manifestUrl,
      manifestRevision: manifest.manifest_revision,
      manifestSha256: state.observed_manifest_sha256,
      signatureValid: sigOk,
      expiry,
      effectiveAlertLevel: effectiveLevel,
      emitAlert,
      alertSuppressedByDedup: effectiveLevel !== 'HEALTHY' && !emitAlert,
      stalledApproval,
      clockSkewDetected,
      anomalies,
      stateFile,
    };
    writeGithubStepSummary(output);
    if (args['report-file']) {
      fs.mkdirSync(path.dirname(args['report-file']), { recursive: true });
      fs.writeFileSync(args['report-file'], JSON.stringify(output, null, 2) + '\n', 'utf8');
    }
    console.log(JSON.stringify(output, null, 2));
    if (
      args['strict-exit'] &&
      (effectiveLevel === 'EXPIRED_INCIDENT' ||
        effectiveLevel === 'SECURITY_INCIDENT' ||
        effectiveLevel === 'CRITICAL_ALERT')
    ) {
      process.exit(2);
    }
  } catch (err) {
    const isSecurityRedirect = String(err.message || '').includes('UNEXPECTED_REDIRECT');
    state.consecutive_failures = (state.consecutive_failures || 0) + 1;
    const backoffs = config.scheduler.backoff_minutes || [15, 60, 240, 720];
    const mins = backoffs[Math.min(state.consecutive_failures - 1, backoffs.length - 1)];
    state.next_retry_after_utc = new Date(nowMs + mins * 60000).toISOString();
    saveState(stateFile, state);
    const out = {
      status: isSecurityRedirect ? 'SECURITY_REDIRECT_BLOCKED' : 'NETWORK_OR_FETCH_FAILURE',
      effectiveAlertLevel: isSecurityRedirect ? 'SECURITY_INCIDENT' : 'WARNING',
      nowUtc: now.toISOString(),
      error: err.message,
      consecutiveFailures: state.consecutive_failures,
      nextRetryAfterUtc: state.next_retry_after_utc,
      backoffMinutes: mins,
      anomalies: isSecurityRedirect ? [err.message] : [],
    };
    writeGithubStepSummary(out);
    if (args['report-file']) {
      fs.mkdirSync(path.dirname(args['report-file']), { recursive: true });
      fs.writeFileSync(args['report-file'], JSON.stringify(out, null, 2) + '\n', 'utf8');
    }
    console.log(JSON.stringify(out, null, 2));
    if (args['strict-exit']) process.exit(isSecurityRedirect ? 2 : 3);
  }
}

main();
