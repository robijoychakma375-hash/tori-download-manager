#!/usr/bin/env node
/**
 * TORI Download Manager — Gate 37.2 Shared Clean-OS QA Reporting, Environment Classification,
 * Safe Path Enforcement, Secret Redaction & Cryptographic Helper Library
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VALID_ENVIRONMENTS = new Set([
  'WINDOWS_SERVER_CI_RUNNER',
  'WINDOWS_10_CLIENT_VM',
  'WINDOWS_11_CLIENT_VM',
  'LOCAL_WINDOWS_HOST_SMOKE',
  'MOCK_OR_STATIC_VALIDATION',
]);

const VALID_STATUSES = new Set([
  'PASS',
  'FAIL',
  'SKIP',
  'TIMEOUT',
  'NOT_TESTED',
  'BLOCKED',
]);

const FORBIDDEN_ROOTS = [
  'c:\\',
  'c:\\windows',
  'c:\\program files',
  'c:\\program files (x86)',
  'c:\\users',
  'f:\\',
];

function classifyWindowsOs({ caption = '', buildNumber = 0, productType = 1, isVm = false, isCi = false } = {}) {
  const isServer = productType !== 1 || /server/i.test(caption);
  const build = Number(buildNumber) || 0;
  if (isServer) return 'WINDOWS_SERVER_CI_RUNNER';
  if (isCi) return 'WINDOWS_SERVER_CI_RUNNER';
  if (isVm) return build >= 22000 ? 'WINDOWS_11_CLIENT_VM' : 'WINDOWS_10_CLIENT_VM';
  return 'LOCAL_WINDOWS_HOST_SMOKE';
}

function assertEnvironmentMatch(actualClass, requiredClass) {
  if (!VALID_ENVIRONMENTS.has(actualClass)) {
    throw new Error(`INVALID_ENVIRONMENT_CLASS: Unknown actual class '${actualClass}'`);
  }
  if (requiredClass) {
    if (!VALID_ENVIRONMENTS.has(requiredClass)) {
      throw new Error(`INVALID_ENVIRONMENT_CLASS: Unknown required class '${requiredClass}'`);
    }
    if (actualClass !== requiredClass) {
      throw new Error(`ENVIRONMENT_CLASS_MISMATCH: Actual '${actualClass}' does not satisfy required '${requiredClass}'`);
    }
  }
  return true;
}

function assertSafeTestRoot(rawPath) {
  if (!rawPath || typeof rawPath !== 'string') {
    throw new Error('INVALID_TEST_ROOT: Path must be a non-empty string');
  }
  if (rawPath.includes('..')) {
    throw new Error(`INVALID_TEST_ROOT: Parent directory traversal '..' is prohibited (${rawPath})`);
  }
  const resolved = path.resolve(rawPath);
  const norm = resolved.toLowerCase().replace(/[\\\/]+$/, '');
  for (const bad of FORBIDDEN_ROOTS) {
    const badNorm = bad.replace(/[\\\/]+$/, '');
    if (norm === badNorm) {
      throw new Error(`INVALID_TEST_ROOT: Refusing protected root directory '${resolved}'`);
    }
  }
  for (const envKey of ['USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'ProgramFiles']) {
    const v = (process.env[envKey] || '').toLowerCase().replace(/[\\\/]+$/, '');
    if (v && norm === v) {
      throw new Error(`INVALID_TEST_ROOT: Refusing direct user/system profile root (${envKey}='${resolved}')`);
    }
  }
  const hasQaMarker = /(tori.*qa|clean_windows_qa|gate3\d|runner_temp|temp\\tori|tmp\\tori)/i.test(resolved);
  if (!hasQaMarker) {
    throw new Error(`INVALID_TEST_ROOT: Path must reside inside a clearly designated disposable TORI QA directory (${resolved})`);
  }
  return resolved;
}

function redactSecrets(input) {
  let s = typeof input === 'string' ? input : JSON.stringify(input);
  s = s.replace(/ghp_[A-Za-z0-9]{20,}/g, '[REDACTED_GH_TOKEN]');
  s = s.replace(/github_pat_[A-Za-z0-9_]{20,}/g, '[REDACTED_GH_PAT]');
  s = s.replace(/Bearer\s+[A-Za-z0-9\-_\.]{16,}/gi, 'Bearer [REDACTED_TOKEN]');
  s = s.replace(/(tori_(?:qa|tok|secret|pairing)[A-Za-z0-9_\-]{8,})/gi, '[REDACTED_PAIRING_TOKEN]');
  s = s.replace(/("token"\s*:\s*)"[^"]+"/gi, '$1"[REDACTED]"');
  s = s.replace(/("key"\s*:\s*)"[^"]{16,}"/gi, '$1"[REDACTED]"');
  return s;
}

function buildQaResults({
  gate = 'Gate 37.2',
  runId = `run_${Date.now()}`,
  timestampUtc = new Date().toISOString(),
  sourceCommit = '',
  installerVersion = '',
  installerSha256 = '',
  environmentType = 'MOCK_OR_STATIC_VALIDATION',
  osInfo = {},
  runnerOrVmId = 'unknown',
  checkpointInfo = null,
  isolationEvidence = {},
  cases = [],
}) {
  if (!VALID_ENVIRONMENTS.has(environmentType)) {
    throw new Error(`Invalid environmentType: ${environmentType}`);
  }
  const normalizedCases = cases.map((c) => {
    if (!VALID_STATUSES.has(c.status)) {
      throw new Error(`Invalid test status '${c.status}' on case '${c.id}'`);
    }
    return {
      suite: c.suite || 'default',
      id: c.id,
      name: c.name || c.id,
      status: c.status,
      duration_ms: Number.isFinite(c.duration_ms) ? c.duration_ms : 0,
      exit_code: Number.isFinite(c.exit_code) ? c.exit_code : (c.status === 'PASS' ? 0 : 1),
      error_summary: c.error_summary ? redactSecrets(String(c.error_summary)) : null,
      detail: c.detail ? redactSecrets(String(c.detail)) : '',
      evidence_path: c.evidence_path || null,
    };
  });

  const totals = { PASS: 0, FAIL: 0, SKIP: 0, TIMEOUT: 0, NOT_TESTED: 0, BLOCKED: 0 };
  const bySuite = {};
  for (const c of normalizedCases) {
    totals[c.status]++;
    if (!bySuite[c.suite]) bySuite[c.suite] = { PASS: 0, FAIL: 0, SKIP: 0, TIMEOUT: 0, NOT_TESTED: 0, BLOCKED: 0 };
    bySuite[c.suite][c.status]++;
  }

  return {
    schema_version: 2,
    gate,
    run_id: runId,
    timestamp_utc: timestampUtc,
    source_commit: sourceCommit,
    installer_version: installerVersion,
    installer_sha256: installerSha256,
    environment_type: environmentType,
    is_clean_client_vm: environmentType === 'WINDOWS_10_CLIENT_VM' || environmentType === 'WINDOWS_11_CLIENT_VM',
    os: {
      name: osInfo.name || '',
      edition: osInfo.edition || '',
      build: String(osInfo.build || ''),
      architecture: osInfo.architecture || 'x64',
    },
    runner_or_vm_id: runnerOrVmId,
    checkpoint_info: checkpointInfo,
    isolation_evidence: isolationEvidence,
    totals,
    totals_by_suite: bySuite,
    overall_status: totals.FAIL > 0 || totals.TIMEOUT > 0 ? 'FAIL' : totals.BLOCKED > 0 ? 'BLOCKED' : totals.PASS > 0 ? 'PASS' : 'NOT_TESTED',
    cases: normalizedCases,
  };
}

function validateQaResultsSchema(doc) {
  const required = [
    'schema_version', 'gate', 'run_id', 'timestamp_utc', 'installer_version',
    'environment_type', 'os', 'runner_or_vm_id', 'totals', 'cases', 'overall_status',
  ];
  for (const k of required) {
    if (!(k in doc)) throw new Error(`INCOMPLETE_QA_RESULT: Missing required field '${k}'`);
  }
  if (!VALID_ENVIRONMENTS.has(doc.environment_type)) {
    throw new Error(`INCOMPLETE_QA_RESULT: Invalid environment_type '${doc.environment_type}'`);
  }
  if (!Array.isArray(doc.cases) || doc.cases.length === 0) {
    throw new Error('INCOMPLETE_QA_RESULT: cases array must be non-empty');
  }
  let recountedPass = 0;
  for (const c of doc.cases) {
    if (!c.id || !VALID_STATUSES.has(c.status)) {
      throw new Error(`INCOMPLETE_QA_RESULT: Invalid case entry ${JSON.stringify(c)}`);
    }
    if (c.status === 'PASS') recountedPass++;
  }
  if (doc.totals.PASS !== recountedPass) {
    throw new Error(`INCOMPLETE_QA_RESULT: totals.PASS (${doc.totals.PASS}) does not match actual PASS count (${recountedPass})`);
  }
  return true;
}

function renderQaSummaryMarkdown(doc) {
  const lines = [
    `# TORI Clean Windows QA Summary — ${doc.environment_type}`,
    '',
    `- **Gate / Run ID:** \`${doc.gate}\` / \`${doc.run_id}\``,
    `- **Timestamp (UTC):** \`${doc.timestamp_utc}\``,
    `- **Environment Classification:** \`${doc.environment_type}\` (Clean Client VM: \`${doc.is_clean_client_vm}\`)`,
    `- **OS:** ${doc.os.name} (Build \`${doc.os.build}\`, \`${doc.os.architecture}\`)`,
    `- **Runner / VM ID:** \`${doc.runner_or_vm_id}\``,
    `- **Target Installer:** v${doc.installer_version} (\`${doc.installer_sha256}\`)`,
    `- **Counts:** PASS=\`${doc.totals.PASS}\` | FAIL=\`${doc.totals.FAIL}\` | TIMEOUT=\`${doc.totals.TIMEOUT}\` | SKIP=\`${doc.totals.SKIP}\` | NOT_TESTED=\`${doc.totals.NOT_TESTED}\` | BLOCKED=\`${doc.totals.BLOCKED}\``,
    `- **Overall Status:** **\`${doc.overall_status}\`**`,
    '',
    '| Suite | Case ID | Status | Duration (ms) | Detail |',
    '| :--- | :--- | :---: | ---: | :--- |',
  ];
  for (const c of doc.cases) {
    lines.push(`| ${c.suite} | \`${c.id}\` | **${c.status}** | ${c.duration_ms} | ${(c.detail || c.error_summary || '').replace(/\|/g, '/')} |`);
  }
  return lines.join('\n') + '\n';
}

function sha256File(p) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(p, 'r');
  const buf = Buffer.allocUnsafe(1024 * 1024);
  try {
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

module.exports = {
  VALID_ENVIRONMENTS,
  VALID_STATUSES,
  classifyWindowsOs,
  assertEnvironmentMatch,
  assertSafeTestRoot,
  redactSecrets,
  buildQaResults,
  validateQaResultsSchema,
  renderQaSummaryMarkdown,
  sha256File,
};
