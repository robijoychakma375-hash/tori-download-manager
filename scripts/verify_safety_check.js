/**
 * TORI Download Manager v1.0.1 — Task 6 Safety Check Verification
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve('F:\\TORI\\final tori download manager');
const STAGING = path.join(ROOT, 'release', 'v1.0.1-rc');

console.log('--- TASK 6: SAFETY AND CREDENTIAL AUDIT ---');

const findings = [];

// 1. Check staged directory for illegal file types
function scanDir(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scanDir(full);
    } else {
      const ext = path.extname(entry.name).toLowerCase();
      if (['.db', '.sqlite', '.log', '.tmp', '.part', '.tdm-part', '.env', '.key', '.pem', '.crt'].includes(ext)) {
        findings.push(`Forbidden file in staging: ${path.relative(ROOT, full)}`);
      }
    }
  }
}
scanDir(STAGING);

// 2. Check for required licenses in staging
const lic = path.join(STAGING, 'LICENSE');
const thirdLic = path.join(STAGING, 'LICENSE-THIRD-PARTY.txt');

if (!fs.existsSync(lic)) {
  findings.push('Missing LICENSE in staging');
} else {
  const licContent = fs.readFileSync(lic, 'utf8');
  if (!licContent.includes('MIT') && !licContent.includes('Apache')) {
    findings.push('LICENSE does not appear to contain standard open source terms');
  }
}

if (!fs.existsSync(thirdLic)) {
  findings.push('Missing LICENSE-THIRD-PARTY.txt in staging');
} else {
  const thirdContent = fs.readFileSync(thirdLic, 'utf8');
  if (!thirdContent.includes('FFmpeg') || !thirdContent.includes('yt-dlp')) {
    findings.push('LICENSE-THIRD-PARTY.txt does not mention FFmpeg or yt-dlp');
  }
}

// 3. Scan extension directory for accidentally baked-in tokens
const extDir = path.join(ROOT, 'extension');
function scanExtension(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scanExtension(full);
    } else if (entry.name.endsWith('.js') || entry.name.endsWith('.json')) {
      const content = fs.readFileSync(full, 'utf8');
      if (content.match(/Bearer\s+[a-zA-Z0-9_\-\.]{20,}/i)) {
        findings.push(`Potential hardcoded bearer token in: ${path.relative(ROOT, full)}`);
      }
      if (content.match(/api[_-]?key\s*[:=]\s*["'][a-zA-Z0-9_\-]{20,}["']/i)) {
        findings.push(`Potential hardcoded API key in: ${path.relative(ROOT, full)}`);
      }
    }
  }
}
scanExtension(extDir);

console.log(`Safety audit findings count: ${findings.length}`);
if (findings.length > 0) {
  for (const f of findings) console.error(`[FAIL] ${f}`);
  process.exit(1);
} else {
  console.log('[PASS] Staging directory contains no database files, test artifacts, private keys, or logs.');
  console.log('[PASS] Staging directory contains valid LICENSE and LICENSE-THIRD-PARTY.txt mentioning FFmpeg and yt-dlp.');
  console.log('[PASS] Extension source contains no baked-in tokens or keys.');
  fs.writeFileSync(path.join(ROOT, 'scripts', 'safety_audit_results.json'), JSON.stringify({
    timestamp: new Date().toISOString(),
    status: 'PASS',
    stagedFilesCount: fs.readdirSync(STAGING).length,
    findings: []
  }, null, 2));
}

